import type { LibraryAccess } from './game-library';
import { extractExeIcon, extractIco } from './icon-extract';
import { normalizePngTo8bitRgba } from './png-normalize';

/**
 * Cover image management for library entries. Covers are stored as regular
 * PNG files under `sdmc:/switch/burialnx/covers/<id>.png`. The library UI
 * loads them once and caches decoded Image objects across frames.
 *
 * A cover is derived in this priority order:
 *   1. User-selected image file (.png/.jpg/.ico in any SD folder)
 *   2. Auto-extracted icon from a .exe file in the game's parent folder
 *   3. Auto-extracted icon from a .ico file in the game's parent folder
 *   4. Placeholder (no cover)
 *
 * For .ico and .exe inputs the bytes are decoded to PNG so nx.js's Image
 * decoder can render them without a separate ICO/BMP code path at runtime.
 */

const COVERS_DIR = 'sdmc:/switch/burialnx/covers';
const COVER_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'exe'];

export function coverPathFor(id: string): string { return `${COVERS_DIR}/${id}.png`; }

const isDir = (mode: number) => (mode & 0o170000) === 0o040000;
const isFile = (mode: number) => (mode & 0o170000) === 0o100000;

/** Scan a game's parent folder for .exe and .ico candidates. Returns the
 *  candidate paths in priority order (exe before ico). */
export function findCoverCandidates(fs: LibraryAccess & { readDirSync(path: string): string[] | null }, root: string): { exe: string[]; ico: string[] } {
        const clean = root.replace(/\/+$/, '');
        // RPG Maker MV's www/ contains the web assets; the .exe usually lives
        // next to it. Look one level up when the selected root is `www`.
        const parent = /\/www$/i.test(clean) ? clean.slice(0, -4) : clean;
        const exe: string[] = [];
        const ico: string[] = [];
        for (const dir of [...new Set([parent, clean])]) {
                let entries: string[] | null = null;
                try { entries = fs.readDirSync(`${dir}/`); } catch { /* unreadable */ }
                if (!entries) continue;
                for (const name of entries) {
                        if (!name) continue;
                        const lower = name.toLowerCase();
                        const ext = lower.split('.').pop() || '';
                        if (!COVER_EXTS.includes(ext)) continue;
                        try {
                                const info = fs.statSync(`${dir}/${name}`);
                                if (!info || !isFile(info.mode)) continue;
                        } catch { continue; }
                        if (ext === 'exe' && !exe.includes(`${dir}/${name}`)) exe.push(`${dir}/${name}`);
                        if (ext === 'ico' && !ico.includes(`${dir}/${name}`)) ico.push(`${dir}/${name}`);
                }
        }
        return { exe, ico };
}

/** Decode an arbitrary cover source to PNG bytes, or null if unsupported. */
export function decodeCoverSource(fs: LibraryAccess, path: string): ArrayBuffer | null {
        const ext = (path.split('.').pop() || '').toLowerCase();
        let bytes: ArrayBuffer | null = null;
        try { bytes = fs.readFileSync(path); } catch { return null; }
        if (!bytes) return null;
        if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') return bytes;
        if (ext === 'ico') return extractIco(bytes);
        if (ext === 'exe') return extractExeIcon(bytes);
        return null;
}

/** Same as decodeCoverSource but logs (via the provided callback) which path
 *  was taken and the resulting PNG size. This is the entry point used by the
 *  loader UI so the debug log shows whether the cover came from a PNG-embedded
 *  .exe icon, a BMP DIB, or failed. */
export function decodeCoverSourceLogged(fs: LibraryAccess, path: string, log: (s: string) => void): ArrayBuffer | null {
        const ext = (path.split('.').pop() || '').toLowerCase();
        log(`Cover decode: ${path} (ext=${ext})`);
        let bytes: ArrayBuffer | null = null;
        try { bytes = fs.readFileSync(path); } catch (error) { log(`Cover decode: readFileSync failed: ${error instanceof Error ? error.message : String(error)}`); return null; }
        if (!bytes) { log('Cover decode: readFileSync returned null'); return null; }
        log(`Cover decode: ${bytes.byteLength} bytes read`);
        if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') { log('Cover decode: passthrough'); return bytes; }
        if (ext === 'ico') { const png = extractIco(bytes); log(`Cover decode: extractIco -> ${png ? png.byteLength : 'null'} bytes`); return png; }
        if (ext === 'exe') { const png = extractExeIcon(bytes); log(`Cover decode: extractExeIcon -> ${png ? png.byteLength : 'null'} bytes`); return png; }
        log(`Cover decode: unsupported extension ${ext}`);
        return null;
}

/** Try to derive a cover from a game folder using .exe then .ico. The first
 *  successful extraction wins. Returns the cover path on success. */
export function deriveDefaultCover(fs: LibraryAccess & { readDirSync(path: string): string[] | null }, id: string, root: string): string | null {
        const candidates = findCoverCandidates(fs, root);
        for (const exe of candidates.exe) {
                try {
                        const bytes = fs.readFileSync(exe);
                        if (bytes) {
                                const png = extractExeIcon(bytes);
                                if (png && saveCoverBytes(fs, id, png)) return coverPathFor(id);
                        }
                } catch { /* try the next candidate */ }
        }
        for (const ico of candidates.ico) {
                try {
                        const bytes = fs.readFileSync(ico);
                        if (bytes) {
                                const png = extractIco(bytes);
                                if (png && saveCoverBytes(fs, id, png)) return coverPathFor(id);
                        }
                } catch { /* try the next candidate */ }
        }
        return null;
}

export function saveCoverBytes(fs: LibraryAccess, id: string, bytes: ArrayBuffer): boolean {
        try {
                try { fs.mkdirSync(COVERS_DIR); } catch { /* may already exist */ }
                // Normalize PNGs to 8-bit RGBA before saving. Windows .exe icons
                // are often 16-bit RGBA PNGs, which crash nx.js's native Image
                // decoder. normalizePngTo8bitRgba decodes (inflate + unfilter),
                // converts to 8-bit, and re-encodes — so the saved file is
                // always a standard 8-bit RGBA PNG that nx.js can display.
                let toWrite = bytes;
                const u8 = new Uint8Array(bytes);
                if (u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
                        const normalized = normalizePngTo8bitRgba(bytes);
                        if (normalized) toWrite = normalized;
                }
                fs.writeFileSync(coverPathFor(id), toWrite);
                return true;
        } catch (error) { console.error(`Could not save cover: ${String(error)}`); return false; }
}

/** Save a user-selected cover. Accepts .png/.jpg (copied verbatim) and .ico
 *  (decoded to PNG). Returns the stored cover path on success. */
export function saveUserCover(fs: LibraryAccess, id: string, sourcePath: string): string | null {
        const png = decodeCoverSource(fs, sourcePath);
        if (!png) return null;
        return saveCoverBytes(fs, id, png) ? coverPathFor(id) : null;
}

/** Like saveUserCover but logs each step via the provided callback so the
 *  loader's debug log shows where cover extraction succeeded or failed. */
export function saveUserCoverLogged(fs: LibraryAccess, id: string, sourcePath: string, log: (s: string) => void): string | null {
        const png = decodeCoverSourceLogged(fs, sourcePath, log);
        if (!png) { log('Cover save: decode returned null, no cover written'); return null; }
        const ok = saveCoverBytes(fs, id, png);
        if (ok) { log(`Cover save: written to ${coverPathFor(id)} (${png.byteLength} bytes)`); return coverPathFor(id); }
        log('Cover save: saveCoverBytes returned false');
        return null;
}

/** Read a cover file as bytes, or null if missing/unreadable. */
export function readCover(fs: LibraryAccess, path: string | null | undefined): ArrayBuffer | null {
        if (!path) return null;
        try { return fs.readFileSync(path); } catch { return null; }
}

export { COVERS_DIR };
