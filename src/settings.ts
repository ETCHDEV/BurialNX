export type SaveLocation = { kind: 'switch' } | { kind: 'sd'; folder: string };
export type GameSelection = { root: string; sharedSaves: boolean; mod?: string | null; saves?: SaveLocation };

export function safeSdPath(value: unknown): value is string {
	if (typeof value !== 'string' || !value.startsWith('sdmc:/')) return false;
	const rest = value.slice(6).replace(/\/+$/, '');
	return !!rest && !/[\\:\u0000-\u001f\u007f\u2028\u2029]/.test(rest) &&
		!rest.split('/').some((part) => !part || part === '..' || part === '.');
}

/** Reject corrupt or unsafe settings rather than guessing or overwriting them. */
export function parseSelection(text: string): GameSelection {
	const data = JSON.parse(text);
	if (!data || !safeSdPath(data.root) || typeof data.sharedSaves !== 'boolean' ||
		(data.mod !== undefined && data.mod !== null && !safeSdPath(data.mod))) throw new Error('Invalid game selection');
	const selection: GameSelection = { root: data.root.replace(/\/+$/, ''), sharedSaves: data.sharedSaves };
	if (data.mod !== undefined) selection.mod = data.mod === null ? null : data.mod.replace(/\/+$/, '');
	if (data.saves !== undefined) {
		if (data.saves?.kind === 'switch') selection.saves = { kind: 'switch' };
		else if (data.saves?.kind === 'sd' && safeSdPath(data.saves.folder)) selection.saves = { kind: 'sd', folder: data.saves.folder.replace(/\/+$/, '') };
		else throw new Error('Invalid save location');
	}
	return selection;
}
import { gameRoot, type DirectoryAccess } from './folders';


/** Debug always asks again. Release only skips the picker for a valid game. */
export function startupSelection(fs: DirectoryAccess, saved: GameSelection | null, debug: boolean): GameSelection | null {
	if (debug || !saved || gameRoot(fs, saved.root) !== saved.root) return null;
	let mod: string | null = null;
	if (saved.mod) try {
		const info = fs.statSync(saved.mod);
		if (info && (info.mode & 0o170000) === 0o040000) mod = saved.mod;
	} catch { /* A removed mod must not prevent the game from starting. */ }
	return { root: saved.root, sharedSaves: saved.sharedSaves, mod, ...(saved.saves ? { saves: saved.saves } : {}) };
}
