import { gameSaveFolders, safeSdPath, type SaveLocation } from './settings';

export interface SaveFiles {
	readFileSync(path: string): ArrayBuffer | null;
	writeFileSync(path: string, value: string | ArrayBuffer): void;
	removeSync(path: string): void;
	statSync(path: string): { mode: number } | null;
}

const name = (id: number) => {
	if (!Number.isInteger(id) || id < -1 || id > 999) throw new Error('Invalid save slot');
	return id === -1 ? 'config.rpgsave' : id === 0 ? 'global.rpgsave' : `file${id}.rpgsave`;
};
const text = (bytes: ArrayBuffer | null) => bytes === null ? null : new TextDecoder().decode(bytes);

/** Never put the writable save folder inside the game or mod directories. */
export function safeSaveFolder(folder: string, root: string, mod: string | null): boolean {
	if (!safeSdPath(folder) || !safeSdPath(root) || (mod !== null && !safeSdPath(mod))) return false;
	const normal = (p: string) => p.replace(/\/+$/, '').toLowerCase();
	const destination = normal(folder);
	const game = normal(root).endsWith('/www') ? normal(root).slice(0, -4) : normal(root);
	return ![game, ...(mod ? [normal(mod)] : [])].some((p) => destination === p || destination.startsWith(p + '/'));
}

/** Only an explicitly selected game save directory may overlap the game. */
export function safeGameSaveFolder(folder: string, root: string, mod: string | null): boolean {
	if (!safeSdPath(folder) || !safeSdPath(root) || (mod !== null && !safeSdPath(mod))) return false;
	const normal = (p: string) => p.replace(/\/+$/, '').toLowerCase();
	const destination = normal(folder);
	if (!gameSaveFolders(root).some((p) => normal(p) === destination)) return false;
	if (!mod) return true;
	const overlay = normal(mod);
	return destination !== overlay && !destination.startsWith(overlay + '/') && !overlay.startsWith(destination + '/');
}

/** Create the explicitly selected save directory only; do not touch saves. */
export function ensureGameSaveFolder(fs: Pick<SaveFiles, 'statSync'> & { mkdirSync(path: string): void }, folder: string, root: string, mod: string | null): void {
	if (!safeGameSaveFolder(folder, root, mod)) throw new Error('Invalid game save folder');
	const parent = folder.slice(0, folder.lastIndexOf('/'));
	const parentInfo = fs.statSync(parent);
	if (!parentInfo || (parentInfo.mode & 0o170000) !== 0o040000) throw new Error('Game save parent folder is unavailable');
	let info = fs.statSync(folder);
	if (!info) { fs.mkdirSync(folder); info = fs.statSync(folder); }
	if (!info || (info.mode & 0o170000) !== 0o040000) throw new Error('Game save path is not a directory');
}

/** MV uses the same LZString base64 format on disk and in localStorage. */
export function installSdSaves(runtime: any, fs: SaveFiles, folder: string): void {
	const manager = runtime.StorageManager, codec = runtime.LZString;
	if (!manager || !codec) throw new Error('Save storage is unavailable');
	const path = (id: number) => `${folder}/${name(id)}`;
	const read = (p: string) => text(fs.readFileSync(p));
	const exists = (p: string) => fs.statSync(p) !== null;
	const remove = (p: string) => {
		const entry = fs.statSync(p);
		// nx.js removes directories recursively. A crafted save-folder entry
		// must never turn a save cleanup into deletion of an entire directory.
		if (entry && (entry.mode & 0o170000) !== 0o100000) throw new Error(`Not a regular save file: ${p}`);
		if (entry) fs.removeSync(p);
	};
	// A journal is left intact after an interrupted write; don't guess which
	// copy is correct or overwrite it. The user can recover it manually.
	const write = (p: string, value: string) => {
		const journal = `${p}.burialnx-journal`;
		if (exists(journal)) throw new Error(`Recovery journal exists: ${journal}`);
		const old = read(p);
		if (old !== null) fs.writeFileSync(journal, old);
		fs.writeFileSync(p, value);
		if (old !== null) remove(journal);
	};
	for (let id = -1; id <= (runtime.DataManager?.maxSavefiles?.() || 20); id++) {
		const journal = `${path(id)}.burialnx-journal`;
		if (exists(journal)) throw new Error(`Interrupted save; recover ${journal} before starting`);
	}
	manager.save = (id: number, json: string) => write(path(id), codec.compressToBase64(json));
	manager.load = (id: number) => { const value = read(path(id)); return value === null ? null : codec.decompressFromBase64(value); };
	manager.exists = (id: number) => exists(path(id));
	manager.remove = (id: number) => remove(path(id));
	manager.backup = (id: number) => {
		const current = read(path(id)), backup = `${path(id)}.burialnx-backup`;
		if (exists(backup)) throw new Error(`Existing save backup requires recovery: ${backup}`);
		if (current !== null) {
			fs.writeFileSync(backup, current);
		}
	};
	manager.backupExists = (id: number) => exists(`${path(id)}.burialnx-backup`);
	manager.cleanBackup = (id: number) => remove(`${path(id)}.burialnx-backup`);
	manager.restoreBackup = (id: number) => {
		const backup = `${path(id)}.burialnx-backup`, value = read(backup);
		if (value !== null) { write(path(id), value); remove(backup); }
	};
	// MV's default rescue removes the slot even when backup creation failed.
	// Never delete an existing save in that case; leave journals/backups for
	// explicit recovery if any part of the write was interrupted.
	if (runtime.DataManager?.saveGameWithoutRescue) runtime.DataManager.saveGame = function(id: number) {
		let backedUp = false;
		try {
			manager.backup(id); backedUp = manager.backupExists(id);
			return this.saveGameWithoutRescue(id);
		} catch (error) {
			if (backedUp && !exists(`${path(id)}.burialnx-journal`)) {
				try { manager.restoreBackup(id); } catch { /* keep backup for recovery */ }
			}
			console.error(error);
			return false;
		}
	};
}

/** Locate possible Steam save indexes without changing the source folders. */
export function steamSaveSources(fs: Pick<SaveFiles, 'statSync'>, root: string): string[] {
	return gameSaveFolders(root).filter((dir) => fs.statSync(`${dir}/global.rpgsave`) !== null);
}

/** A save index alone is not a saved game; don't prompt when no slots exist. */
export function hasSteamSaveData(fs: Pick<SaveFiles, 'statSync'> & { readDirSync(path: string): string[] | null }, root: string): boolean {
	return steamSaveSources(fs, root).some((dir) => {
		const entries = fs.readDirSync(dir);
		// An unreadable directory is not proof that no saves exist.
		return !entries || entries.some((entry) => /^file[1-9]\d{0,2}\.rpgsave$/i.test(entry));
	});
}

/** Copy only into an entirely empty destination; source files are never written. */
export function importSteamSaves(runtime: any, fs: SaveFiles, root: string, location: SaveLocation): number {
	if (location.kind === 'game') throw new Error('Game-folder saves are already in use; no import is needed');
	if (location.kind === 'sd' && !safeSaveFolder(location.folder, root, null)) throw new Error('Save folder overlaps game folder');
	const candidates = steamSaveSources(fs, root);
	if (candidates.length !== 1) throw new Error(candidates.length ? 'Steam saves found in two folders; keep only one source' : 'No Steam global.rpgsave found in the game save folder');
	const max = runtime.DataManager.maxSavefiles();
	if (!Number.isInteger(max) || max < 1 || max > 999) throw new Error('Invalid save slot count');
	const readSource = (id: number) => text(fs.readFileSync(`${candidates[0]}/${name(id)}`));
	const validate = (value: string, kind: string) => {
		if (value.length > 8 * 1024 * 1024) throw new Error(`${kind} is too large`);
		const decoded = runtime.LZString.decompressFromBase64(value);
		if (typeof decoded !== 'string' || !decoded.length || decoded.length > 16 * 1024 * 1024) throw new Error(`Invalid ${kind}`);
		try { return JSON.parse(decoded); } catch { throw new Error(`Invalid ${kind}`); }
	};
	const global = readSource(0);
	if (global === null) throw new Error('Invalid Steam save index');
	const index = validate(global, 'Steam save index');
	if (!Array.isArray(index)) throw new Error('Invalid Steam save index');
	const source: [number, string][] = [];
	for (let id = 1; id <= max; id++) {
		const value = readSource(id);
		if (value !== null) {
			const data = validate(value, `Steam slot ${id}`);
			if (!data || typeof data !== 'object' || !data.system || !data.map || !data.player || !data.party || !index[id]) throw new Error(`Invalid Steam slot ${id} or missing index entry`);
			source.push([id, value]);
		} else if (index[id]) throw new Error(`Steam slot ${id} is listed but missing`);
	}
	if (!source.length) throw new Error('No Steam save slots found');
	const rawKey = (id: number) => runtime.StorageManager.webStorageKey(id);
	const target = (id: number) => location.kind === 'sd' ? `${location.folder}/${name(id)}` : rawKey(id);
	for (let id = 0; id <= max; id++) {
		if (location.kind === 'switch') {
			if (runtime.localStorage.getItem(target(id)) !== null || runtime.localStorage.getItem(target(id) + 'bak') !== null) throw new Error('Destination has existing saves or backups; import cancelled');
		} else {
			const p = target(id);
			if ([p, `${p}.burialnx-backup`, `${p}.burialnx-journal`, `${p}.bak`].some((x) => fs.statSync(x) !== null)) throw new Error('Destination has existing saves or backups; import cancelled');
		}
	}
	// Write metadata last, so an interrupted import cannot expose partial slots.
	for (const [id, value] of [...source, [0, global] as [number, string]]) {
		if (location.kind === 'switch') runtime.localStorage.setItem(target(id), value);
		else fs.writeFileSync(target(id), value);
	}
	return source.length;
}
