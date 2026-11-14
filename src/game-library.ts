import { parseSelection, safeSdPath, type GameSelection, type SaveLocation } from './settings';
import { parseKeyMap, type KeyMap } from './keymap';

/** Persisted per-game FPS-experimental toggle set. Stored on the library entry so each
 *  game keeps its own settings (see docs/doc/fps-optimizations.md). All default false —
 *  the user opts each one in per game. */
export interface ExperimentalSettings {
        skipFadeBlur?: boolean;
        skipFadeFill?: boolean;
        windowLayerSkip?: boolean;
        windowBitmapReuse?: boolean;
        textureGcIdle?: boolean;
        dirtyRenderSkip?: boolean;
        presentCache?: boolean;
        canvasNodeSkip?: boolean;
        smoothingOff?: boolean;
        skipPresent?: boolean;
        eventUpdateSkip?: boolean;
        spriteRenderSkip?: boolean;
}

/** Names of the experimental toggle fields, in the order they appear on the pause menu's
 *  Experimental page. Used by the frame loop to flip the named S field and persist. */
export const EXPERIMENTAL_FIELDS = [
        'skipFadeBlur', 'skipFadeFill', 'windowLayerSkip', 'windowBitmapReuse',
        'textureGcIdle', 'dirtyRenderSkip', 'presentCache', 'canvasNodeSkip',
        'smoothingOff', 'skipPresent', 'eventUpdateSkip', 'spriteRenderSkip',
] as const;

/** Persisted description of one added game: id, name, root, saves, cover, keymap, language. */
export interface LibraryEntry {
        id: string;
        name: string;
        root: string;
        sharedSaves: boolean;
        mod?: string | null;
        modEnabled?: boolean;
        saves?: SaveLocation;
        cover?: string | null;
        /** Per-game joycon key bindings. When absent the global default is used. */
        keymap?: KeyMap;
        /** ISO timestamp of the last launch. Used for sorting and "recent". */
        lastPlayed?: number;
        /** Per-game language preference: a .cld code (e.g. 'ru') or '' for English. */
        language?: string;
        /** Per-game FPS-counter overlay toggle (pause menu → "FPS: on/off"). Default off. */
        fps?: boolean;
        /** Per-game FPS-experimental toggles. When absent all are off (defaults). */
        experimental?: ExperimentalSettings;
}

export interface LibraryFile {
        version: 1;
        games: LibraryEntry[];
        /** Id of the game to highlight / auto-launch on the next startup. */
        lastPlayed?: string;
}

const LIBRARY_PATH = 'sdmc:/switch/burialnx/library.json';

/** Reject corrupt or unsafe library files rather than guessing or overwriting. */
export function parseLibrary(text: string): LibraryFile {
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object') throw new Error('Invalid library');
        if (data.version !== 1 || !Array.isArray(data.games)) throw new Error('Unsupported library version');
        const seen = new Set<string>();
        const games: LibraryEntry[] = [];
        for (const raw of data.games) {
                if (!raw || typeof raw !== 'object') throw new Error('Invalid library entry');
                if (typeof raw.id !== 'string' || !raw.id || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.id)) throw new Error('Invalid game id');
                if (seen.has(raw.id)) throw new Error(`Duplicate game id: ${raw.id}`);
                seen.add(raw.id);
                if (typeof raw.name !== 'string' || !raw.name || raw.name.length > 128) throw new Error('Invalid game name');
                if (!safeSdPath(raw.root)) throw new Error('Invalid game root');
                if (typeof raw.sharedSaves !== 'boolean') throw new Error('Invalid sharedSaves flag');
                if (raw.mod !== undefined && raw.mod !== null && !safeSdPath(raw.mod)) throw new Error('Invalid mod path');
                if (raw.cover !== undefined && raw.cover !== null && !safeSdPath(raw.cover)) throw new Error('Invalid cover path');
                let keymap: KeyMap | undefined;
                if (raw.keymap !== undefined) {
                        if (raw.keymap === null) throw new Error('Invalid per-game keymap');
                        keymap = parseKeyMap(JSON.stringify(raw.keymap));
                }
                const entry: LibraryEntry = {
                        id: raw.id, name: raw.name, root: raw.root.replace(/\/+$/, ''), sharedSaves: raw.sharedSaves,
                };
                if (raw.mod !== undefined) entry.mod = raw.mod === null ? null : raw.mod.replace(/\/+$/, '');
                if (raw.modEnabled !== undefined) entry.modEnabled = raw.modEnabled === true;
                if (raw.saves !== undefined) {
                        if (raw.saves?.kind === 'switch') entry.saves = { kind: 'switch' };
                        else if (raw.saves?.kind === 'sd' && safeSdPath(raw.saves.folder)) entry.saves = { kind: 'sd', folder: raw.saves.folder.replace(/\/+$/, '') };
                        else if (raw.saves?.kind === 'game' && safeSdPath(raw.saves.folder)) entry.saves = { kind: 'game', folder: raw.saves.folder.replace(/\/+$/, '') };
                        else throw new Error('Invalid save location');
                }
                if (raw.cover !== undefined) entry.cover = raw.cover === null ? null : raw.cover.replace(/\/+$/, '');
                if (keymap !== undefined) entry.keymap = keymap;
                if (typeof raw.lastPlayed === 'number' && Number.isFinite(raw.lastPlayed) && raw.lastPlayed > 0) entry.lastPlayed = raw.lastPlayed;
                if (typeof raw.language === 'string') entry.language = raw.language;
                if (typeof raw.fps === 'boolean') entry.fps = raw.fps;
                if (raw.experimental !== undefined && raw.experimental !== null && typeof raw.experimental === 'object') {
                        const exp: ExperimentalSettings = {};
                        for (const key of EXPERIMENTAL_FIELDS) {
                                const v = (raw.experimental as any)[key];
                                if (typeof v === 'boolean') (exp as any)[key] = v;
                        }
                        entry.experimental = exp;
                }
                games.push(entry);
        }
        const file: LibraryFile = { version: 1, games };
        if (typeof data.lastPlayed === 'string' && seen.has(data.lastPlayed)) file.lastPlayed = data.lastPlayed;
        return file;
}

/** Stable URL-safe id derived from the SD path; same root → same id for dedup. */
export function libraryIdFromRoot(root: string): string {
        const clean = root.replace(/\/+$/, '').toLowerCase();
        let hash = 0;
        for (let i = 0; i < clean.length; i++) {
                hash = ((hash << 5) - hash + clean.charCodeAt(i)) | 0;
        }
        return `g${(hash >>> 0).toString(36)}`;
}

/** Convert a legacy single-game {@link GameSelection} to a library entry. */
export function entryFromSelection(selection: GameSelection, name?: string, cover?: string | null): LibraryEntry {
        const id = libraryIdFromRoot(selection.root);
        const baseName = name || selection.root.split('/').pop() || 'Game';
        const entry: LibraryEntry = { id, name: baseName, root: selection.root, sharedSaves: selection.sharedSaves };
        if (selection.mod !== undefined) entry.mod = selection.mod;
        if (selection.saves) entry.saves = selection.saves;
        if (cover !== undefined) entry.cover = cover;
        return entry;
}

export function toSelection(entry: LibraryEntry): GameSelection {
        const selection: GameSelection = { root: entry.root, sharedSaves: entry.sharedSaves };
        if (entry.mod !== undefined) selection.mod = entry.mod;
        if (entry.saves) selection.saves = entry.saves;
        return selection;
}

export interface LibraryAccess {
        readFileSync(path: string): ArrayBuffer | null;
        writeFileSync(path: string, value: string | ArrayBuffer): void;
        statSync(path: string): { mode: number } | null;
        mkdirSync(path: string): void;
}

/** Load the library or return an empty one; migrates a legacy settings.json on first load. */
export function loadLibrary(fs: LibraryAccess): LibraryFile {
        try {
                const raw = fs.readFileSync(LIBRARY_PATH);
                if (raw) return parseLibrary(new TextDecoder().decode(raw));
        } catch (error) { /* corrupt or unreadable: fall through and start empty */ }
        try {
                const legacy = fs.readFileSync('sdmc:/switch/burialnx/settings.json');
                if (legacy) {
                        const text = new TextDecoder().decode(legacy);
                        const selection = parseSelection(text);
                        const entry = entryFromSelection(selection);
                        const file: LibraryFile = { version: 1, games: [entry], lastPlayed: entry.id };
                        saveLibrary(fs, file);
                        return file;
                }
        } catch { /* no migration possible; start empty */ }
        return { version: 1, games: [] };
}

/** Write the library atomically; returns false on failure so callers can surface it. */
export function saveLibrary(fs: LibraryAccess, file: LibraryFile): boolean {
        try {
                try { fs.mkdirSync('sdmc:/switch/burialnx'); } catch { /* may already exist */ }
                fs.writeFileSync(LIBRARY_PATH, JSON.stringify(file, null, 2));
                return true;
        } catch (error) { console.error(`Could not save library: ${String(error)}`); return false; }
}

export function upsertGame(fs: LibraryAccess, file: LibraryFile, entry: LibraryEntry): LibraryFile {
        const index = file.games.findIndex((g) => g.id === entry.id);
        let games: LibraryEntry[];
        if (index >= 0) games = file.games.map((g) => (g.id === entry.id ? { ...g, ...entry } : g));
        else games = [...file.games, entry];
        const updated: LibraryFile = { version: 1, games, lastPlayed: entry.id };
        saveLibrary(fs, updated);
        return updated;
}

/** Swap a game up (dir=-1) or down (dir=+1) in library order; no-op at boundaries. */
export function moveGame(fs: LibraryAccess, file: LibraryFile, id: string, dir: -1 | 1): LibraryFile {
        const index = file.games.findIndex((g) => g.id === id);
        if (index < 0) return file;
        const target = index + dir;
        if (target < 0 || target >= file.games.length) return file;
        const games = [...file.games];
        [games[index], games[target]] = [games[target], games[index]];
        const updated: LibraryFile = { version: 1, games, ...(file.lastPlayed ? { lastPlayed: file.lastPlayed } : {}) };
        saveLibrary(fs, updated);
        return updated;
}

export function removeGame(fs: LibraryAccess, file: LibraryFile, id: string): LibraryFile {
        const games = file.games.filter((g) => g.id !== id);
        const lastPlayed = file.lastPlayed === id ? undefined : file.lastPlayed;
        const updated: LibraryFile = { version: 1, games, ...(lastPlayed ? { lastPlayed } : {}) };
        saveLibrary(fs, updated);
        return updated;
}

export function markPlayed(fs: LibraryAccess, file: LibraryFile, id: string): LibraryFile {
        const now = Date.now();
        const games = file.games.map((g) => (g.id === id ? { ...g, lastPlayed: now } : g));
        const updated: LibraryFile = { version: 1, games, lastPlayed: id };
        saveLibrary(fs, updated);
        return updated;
}

export function findGame(file: LibraryFile, id: string): LibraryEntry | undefined {
        return file.games.find((g) => g.id === id);
}

export { LIBRARY_PATH };
