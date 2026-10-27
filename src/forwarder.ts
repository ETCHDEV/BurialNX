import type { LibraryEntry, LibraryAccess } from './game-library';

// Per-game forwarder NRO generation. A forwarder is a self-contained nx.js
// NRO that, when launched from the Switch homebrew menu (hbmenu), chain-
// loads the main burialnx.nro with `--game <id>` on its argv so the user
// lands directly in that game — skipping the library grid. This mirrors
// the forwarder pattern used by sphaira (which calls libnx
// `envSetNextLoad`); the nx.js equivalent is
// `new Switch.Application(nroPath).launch('--game', id)`, which nx.js's
// source/ns.cc implements as a call to `envSetNextLoad` followed by an
// exit of the current process.
//
// BUILD FLOW:
//   - At build time, `tools/build.mjs` packages a `forwarder-template.nro`
//     (a FAT self-contained nx.js NRO whose `romfs:/main.js` contains a
//     64-byte GAME_ID placeholder — see forwarder-template/romfs/main.ts)
//     and embeds it into burialnx.nro's own romfs at
//     `romfs:/forwarder-template.nro`.
//   - At runtime, `buildForwarder()` reads that template, patches the
//     GAME_ID placeholder in the romfs (byte-level search + replace so
//     the forwarder is fully self-contained — no sidecar JSON), patches
//     the NACP (title = game name, author = "BurialNX", id = a stable
//     hash of the game id), optionally patches the icon (the game's cover
//     re-encoded to a 256×256 JPEG), re-encodes the NRO, and writes it
//     to `sdmc:/switch/burialnx/<game-id>.nro` — the SAME folder as
//     burialnx.nro itself, so hbmenu finds it in its "burialnx" folder.
//
// This module is pure (no top-level Switch access) so it can be unit-
// tested with a mock filesystem; only `buildForwarder` and
// `encodeCoverToIconJpeg` touch the Switch runtime, through globals.

// === NRO format constants (https://switchbrew.org/wiki/NRO) ============
const NRO_MAGIC = 'NRO0';
const ASET_MAGIC = 'ASET';
const ASSET_HEADER_SIZE = 0x38;

// === NACP field layout (https://switchbrew.org/wiki/NACP) ==============
const NACP_SIZE = 0x4000;
const NACP_LANGUAGE_ENTRY_SIZE = 0x300; // name[0x200] + author[0x100]
const NACP_TITLE_SIZE = 0x200;
const NACP_AUTHOR_SIZE = 0x100;
const NACP_LANGUAGE_COUNT = 12;
const NACP_PRESENCE_GROUP_ID_OFFSET = 0x3038;
const NACP_SAVE_DATA_OWNER_ID_OFFSET = 0x3078;
const NACP_ADD_ON_CONTENT_BASE_ID_OFFSET = 0x3070;
const NACP_LOCAL_COMM_ID_OFFSET = 0x30b0;
const NACP_LOCAL_COMM_ID_COUNT = 8;
// Save-data fields (s64 each). Zeroing these prevents the Switch from
// creating save data for the forwarder title, which in turn prevents the
// "cannot delete: save data exists" error when the user removes the
// forwarder from the HOME menu.
const NACP_STARTUP_USER_ACCOUNT_OFFSET = 0x3025; // u8: 0=no profile dialog
const NACP_USER_ACCOUNT_SAVE_DATA_SIZE_OFFSET = 0x3080; // s64
const NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET = 0x3088; // s64
const NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET = 0x3090; // s64

// === Forwarder paths ===================================================
// Each forwarder lives in its OWN subfolder under sdmc:/switch/, named
// after the sanitized game name. This matches the hbmenu convention
// (sdmc:/switch/<app-name>/<app-name>.nro) and makes the forwarder
// appear as a top-level entry in hbmenu with the game name as the folder
// name. The forwarder's NACP title is also the game name.
export const FORWARDERS_BASE_DIR = 'sdmc:/switch';

/** The embedded template NRO path inside burialnx.nro's own romfs. */
export const FORWARDER_TEMPLATE_ROMFS_PATH = 'romfs:/forwarder-template.nro';

/** Where the main burialnx.nro is expected to live on the SD card. The
 *  forwarder's main.js chain-loads this path. */
export const BURIALNX_NRO_PATH = 'sdmc:/switch/burialnx/burialnx.nro';
export const BURIALNX_DEBUG_NRO_PATH = 'sdmc:/switch/burialnx/burialnx-debug.nro';

/** Sanitize a game name for use as a folder/filename. Keeps only
 *  alphanumeric, dash, underscore, and space characters. Truncates to
 *  40 chars. If the result is empty, falls back to the game id. */
export function sanitizeGameName(name: string, fallback: string): string {
        const cleaned = name.replace(/[^a-zA-Z0-9 \-_]/g, '').trim().slice(0, 40);
        return cleaned || fallback;
}

/** Compute the forwarder .nro directory for a given game. Each game
 *  gets its own subfolder: sdmc:/switch/<sanitized-name>/ */
export function forwarderDirFor(gameName: string, gameId: string): string {
        return `${FORWARDERS_BASE_DIR}/${sanitizeGameName(gameName, gameId)}`;
}

/** Compute the forwarder .nro path on the SD card for a given game. */
export function forwarderPathFor(gameName: string, gameId: string): string {
        const dir = forwarderDirFor(gameName, gameId);
        const name = sanitizeGameName(gameName, gameId);
        return `${dir}/${name}.nro`;
}

// === Game-id placeholder (patched at runtime into the romfs) ==========
// The forwarder template's main.js contains the line:
//   const GAME_ID = "0000000000000000000000000000000000000000000000000000000000000000";
// (exactly 64 '0' characters). At build time, buildForwarder() searches
// the romfs bytes for this 64-byte sequence and overwrites it with the
// game's id (UTF-8, right-padded with spaces to 64 bytes). The main.js
// then does `GAME_ID.trim()` to get the clean id.
//
// 64 zeros is distinctive enough within the romfs data section (which
// contains the ~3 KiB bundled main.js, the ~240 byte nxjs.ini, and the
// ~100 KiB runtime font + source map). We search ONLY within the romfs
// bytes, never the code segment, so the 54 MiB compiled runtime can't
// produce a false match.
const GAME_ID_PLACEHOLDER = '0'.repeat(64);
const GAME_ID_PLACEHOLDER_BYTES = new TextEncoder().encode(GAME_ID_PLACEHOLDER);

/** Patch the game-id placeholder in a copy of the template's romfs bytes.
 *  Searches for the 64-'0' placeholder and overwrites it with the game
 *  id (UTF-8, space-padded to 64 bytes). Returns a new Uint8Array — the
 *  input is not modified. Throws if the placeholder is not found or
 *  found more than once (ambiguous). */
export function patchGameIdInRomfs(romfs: Uint8Array, gameId: string): Uint8Array {
        if (gameId.length === 0) throw new Error('game id is empty');
        if (gameId.length > 64) throw new Error(`game id too long (${gameId.length} > 64)`);
        const encoded = new TextEncoder().encode(gameId);
        if (encoded.length > 64) throw new Error(`game id UTF-8 encoding too long (${encoded.length} > 64)`);
        // Build the replacement: game id + space padding to 64 bytes.
        const replacement = new Uint8Array(64);
        replacement.set(encoded);
        // The rest is already 0 from Uint8Array initialization; but we need
        // SPACES (0x20), not zeros (0x00), because the JS string literal
        // must remain valid: "g1abc23                " (id + spaces).
        for (let i = encoded.length; i < 64; i++) replacement[i] = 0x20;
        // Search for the placeholder in the romfs.
        const found = findAll(romfs, GAME_ID_PLACEHOLDER_BYTES);
        if (found.length === 0) throw new Error('GAME_ID placeholder not found in template romfs — the template was not built correctly');
        if (found.length > 1) throw new Error(`GAME_ID placeholder found ${found.length} times in template romfs — ambiguous, refusing to patch`);
        const offset = found[0];
        // Copy the romfs and overwrite the placeholder.
        const out = new Uint8Array(romfs); // creates a copy
        out.set(replacement, offset);
        return out;
}

/** Patch a string placeholder in a romfs blob. Searches for the
 *  placeholder (as UTF-8 bytes) and overwrites it with the replacement
 *  (which must be the same byte length). Returns a new Uint8Array — the
 *  input is not modified. Throws if the placeholder is not found or
 *  found more than once (ambiguous).
 *
 *  This is the generic version of patchGameIdInRomfs — used for the
 *  MOD_FORCED placeholder ("MODFORCED_0" → "MODFORCED_1"). */
export function patchStringInRomfs(romfs: Uint8Array, placeholder: string, replacement: string): Uint8Array {
        const placeholderBytes = new TextEncoder().encode(placeholder);
        const replacementBytes = new TextEncoder().encode(replacement);
        if (placeholderBytes.length !== replacementBytes.length) {
                throw new Error(`patchStringInRomfs: placeholder (${placeholderBytes.length} bytes) and replacement (${replacementBytes.length} bytes) must be the same byte length`);
        }
        const found = findAll(romfs, placeholderBytes);
        if (found.length === 0) throw new Error(`patchStringInRomfs: placeholder "${placeholder}" not found in romfs`);
        if (found.length > 1) throw new Error(`patchStringInRomfs: placeholder "${placeholder}" found ${found.length} times in romfs — ambiguous, refusing to patch`);
        const out = new Uint8Array(romfs); // creates a copy
        out.set(replacementBytes, found[0]);
        return out;
}

/** Find all occurrences of `needle` in `haystack`. Returns the byte
 *  offsets where the needle starts. */
function findAll(haystack: Uint8Array, needle: Uint8Array): number[] {
        const out: number[] = [];
        if (needle.length === 0 || haystack.length < needle.length) return out;
        const first = needle[0];
        for (let i = 0; i <= haystack.length - needle.length; i++) {
                if (haystack[i] !== first) continue;
                let match = true;
                for (let j = 1; j < needle.length; j++) {
                        if (haystack[i + j] !== needle[j]) { match = false; break; }
                }
                if (match) out.push(i);
        }
        return out;
}

/** A stable, per-game unique application ID for the forwarder NRO. nx.js
 *  NROs use the application ID for save-data separation and hbmenu dedup.
 *  We hash the game id into the homebrew title-ID range
 *  (0x0100000000010000 | hash16) so the same game always gets the same
 *  forwarder ID, different games get different IDs, and the ID stays in
 *  the homebrew range. FNV-1a (32-bit, folded to 16). */
export function forwarderIdFor(gameId: string): bigint {
        let hash = 0x811c9dc5;
        for (let i = 0; i < gameId.length; i++) {
                hash ^= gameId.charCodeAt(i) & 0xff;
                hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        const folded = ((hash >>> 16) ^ (hash & 0xffff)) >>> 0;
        return 0x0100000000010000n | BigInt(folded & 0xffff);
}

// === Pure NRO / NACP manipulation (no Switch access) ==================

interface NroStructure {
        nroSize: number;
        iconOffset: number;
        iconSize: number;
        nacpOffset: number;
        nacpSize: number;
        romfsOffset: number;
        romfsSize: number;
}

/** Decode an NRO's structure: locate the asset section and the icon,
 *  nacp and romfs segments within it. Throws on bad magic or sizes. */
export function decodeNroStructure(buf: ArrayBuffer): NroStructure {
        if (buf.byteLength < 0x20 + ASSET_HEADER_SIZE) throw new Error('NRO too small');
        const bytes = new Uint8Array(buf);
        const nroMagicStr = new TextDecoder().decode(bytes.subarray(0x10, 0x14));
        if (nroMagicStr !== NRO_MAGIC) throw new Error(`Bad NRO magic: "${nroMagicStr}"`);
        const view = new DataView(buf);
        const nroSize = view.getUint32(0x18, true);
        if (nroSize === 0 || nroSize > buf.byteLength) throw new Error(`Bad NRO size: ${nroSize}`);
        const assetBase = nroSize;
        if (assetBase + ASSET_HEADER_SIZE > buf.byteLength) throw new Error('Asset header does not fit');
        const assetMagicStr = new TextDecoder().decode(bytes.subarray(assetBase, assetBase + 4));
        if (assetMagicStr !== ASET_MAGIC) throw new Error(`Bad ASET magic at 0x${assetBase.toString(16)}: "${assetMagicStr}"`);
        const iconRel = view.getUint32(assetBase + 0x08, true);
        const iconSize = view.getUint32(assetBase + 0x10, true);
        const nacpRel = view.getUint32(assetBase + 0x18, true);
        const nacpSize = view.getUint32(assetBase + 0x20, true);
        const romfsRel = view.getUint32(assetBase + 0x28, true);
        const romfsSize = view.getUint32(assetBase + 0x30, true);
        const abs = (rel: number, size: number) => {
                const start = assetBase + rel;
                if (rel === 0 || size === 0) return { offset: start, size: 0 };
                if (start + size > buf.byteLength) throw new Error(`NRO section out of bounds: rel=0x${rel.toString(16)} size=0x${size.toString(16)}`);
                return { offset: start, size };
        };
        const icon = abs(iconRel, iconSize);
        const nacp = abs(nacpRel, nacpSize);
        const romfs = abs(romfsRel, romfsSize);
        return {
                nroSize,
                iconOffset: icon.offset, iconSize: icon.size,
                nacpOffset: nacp.offset, nacpSize: nacp.size,
                romfsOffset: romfs.offset, romfsSize: romfs.size,
        };
}

/** Build a fresh NRO from a code segment, an icon, a NACP and a romfs.
 *  The asset header is rebuilt so the icon, NACP and romfs sizes can
 *  change (which they do: the per-game cover JPEG is variable-length,
 *  and the romfs grows when we patch the placeholder). */
export function encodeNro(code: Uint8Array, icon: Uint8Array, nacp: Uint8Array, romfs: Uint8Array): Uint8Array {
        const total = code.byteLength + ASSET_HEADER_SIZE + icon.byteLength + nacp.byteLength + romfs.byteLength;
        const out = new Uint8Array(total);
        out.set(code, 0);
        const assetBase = code.byteLength;
        const header = new DataView(out.buffer, assetBase, ASSET_HEADER_SIZE);
        header.setUint8(0, 0x41); header.setUint8(1, 0x53); header.setUint8(2, 0x45); header.setUint8(3, 0x54); // "ASET"
        header.setUint32(4, 0, true); // version
        let rel = ASSET_HEADER_SIZE;
        header.setUint32(0x08, rel, true); header.setUint32(0x10, icon.byteLength, true); rel += icon.byteLength;
        header.setUint32(0x18, rel, true); header.setUint32(0x20, nacp.byteLength, true); rel += nacp.byteLength;
        header.setUint32(0x28, rel, true); header.setUint32(0x30, romfs.byteLength, true);
        let cursor = assetBase + ASSET_HEADER_SIZE;
        out.set(icon, cursor); cursor += icon.byteLength;
        out.set(nacp, cursor); cursor += nacp.byteLength;
        out.set(romfs, cursor); cursor += romfs.byteLength;
        return out;
}

/** Write the application title into a NACP buffer (all 12 language
 *  entries, UTF-8, truncated to 0x1ff bytes, null-padded). */
export function writeNacpTitle(nacp: Uint8Array, title: string): void {
        const bytes = new TextEncoder().encode(title);
        const truncated = bytes.slice(0, NACP_TITLE_SIZE - 1);
        for (let i = 0; i < NACP_LANGUAGE_COUNT; i++) {
                const base = i * NACP_LANGUAGE_ENTRY_SIZE;
                nacp.fill(0, base, base + NACP_TITLE_SIZE);
                nacp.set(truncated, base);
        }
}
/** Write the author field into a NACP buffer (all 12 entries). */
export function writeNacpAuthor(nacp: Uint8Array, author: string): void {
        const bytes = new TextEncoder().encode(author);
        const truncated = bytes.slice(0, NACP_AUTHOR_SIZE - 1);
        for (let i = 0; i < NACP_LANGUAGE_COUNT; i++) {
                const base = i * NACP_LANGUAGE_ENTRY_SIZE + NACP_TITLE_SIZE;
                nacp.fill(0, base, base + NACP_AUTHOR_SIZE);
                nacp.set(truncated, base);
        }
}
/** Write the application ID into all the NACP fields that hold one
 *  (PresenceGroupId, SaveDataOwnerId, AddOnContentBaseId, and the 8
 *  LocalCommunicationId slots). */
export function writeNacpId(nacp: Uint8Array, id: bigint): void {
        if (nacp.byteLength < NACP_LOCAL_COMM_ID_OFFSET + NACP_LOCAL_COMM_ID_COUNT * 8) {
                throw new Error('NACP buffer too small for ID fields');
        }
        const view = new DataView(nacp.buffer, nacp.byteOffset, nacp.byteLength);
        view.setBigUint64(NACP_PRESENCE_GROUP_ID_OFFSET, id, true);
        view.setBigUint64(NACP_SAVE_DATA_OWNER_ID_OFFSET, id, true);
        view.setBigUint64(NACP_ADD_ON_CONTENT_BASE_ID_OFFSET, id + 0x1000n, true);
        for (let x = 0; x < NACP_LOCAL_COMM_ID_COUNT; x++) {
                view.setBigUint64(NACP_LOCAL_COMM_ID_OFFSET + x * 0x8, id, true);
        }
}

/** Zero out the save-data fields in a forwarder NACP. The forwarder is
 *  just a chain-loader — it doesn't need save data of its own. Setting
 *  these to 0 prevents the Switch from creating save data for the
 *  forwarder title, which in turn prevents the "cannot delete: save data
 *  exists" error when the user removes the forwarder. Also disables the
 *  profile-selection dialog (startupUserAccount=0) since the forwarder
 *  doesn't touch user data. */
export function writeNacpForwarderDefaults(nacp: Uint8Array): void {
        const view = new DataView(nacp.buffer, nacp.byteOffset, nacp.byteLength);
        // Don't show the "select a user" dialog for the forwarder.
        view.setUint8(NACP_STARTUP_USER_ACCOUNT_OFFSET, 0);
        // Zero out all save-data sizes (s64 each).
        view.setBigUint64(NACP_USER_ACCOUNT_SAVE_DATA_SIZE_OFFSET, 0n, true);
        view.setBigUint64(NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET, 0n, true);
        view.setBigUint64(NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET, 0n, true);
}

// === Icon re-encoding ==================================================
// The forwarder icon must be a 256×256 JPEG (hbmenu convention). The game
// cover is a PNG on the SD card. nx.js's Image + OffscreenCanvas +
// canvas.convertToBlob() does the decode/resize/encode natively. If any
// step fails, the caller falls back to the template's existing icon.
//
// DEBUGGING: every step is logged with the `icon:` prefix so the debug
// build's log file (sdmc:/switch/burialnx/LOGS/native-host_N.log) shows
// exactly where the icon pipeline failed. The log lines include:
//   - the cover path and byte size
//   - the first 8 bytes of the cover (magic number: PNG = 89 50 4E 47,
//     JPEG = FF D8 FF E0)
//   - whether OffscreenCanvas, URL.createObjectURL, Image are available
//   - the Image load attempt (sdmc path first, blob URL fallback)
//   - the decoded image dimensions
//   - the drawImage call and its parameters
//   - the convertToBlob call and the resulting JPEG size
//   - the full error (with name + message + stack) on any exception

/** Detect the image format from the first few bytes of the cover. */
function detectImageFormat(bytes: Uint8Array): string {
        if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'PNG';
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
        if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'WEBP';
        return 'unknown';
}

/** Format the first N bytes as a hex string for logging. */
function hexPrefix(bytes: Uint8Array, n: number): string {
        const out: string[] = [];
        for (let i = 0; i < Math.min(n, bytes.length); i++) out.push(bytes[i].toString(16).padStart(2, '0'));
        return out.join(' ');
}

/** Re-encode an arbitrary cover image as a 256×256 JPEG. The cover can
 *  be specified either as an SD path (preferred — nx.js's Image fetches
 *  sdmc: paths natively, no blob URL needed) or as raw bytes (a blob URL
 *  is created as a fallback).
 *
 *  The image is fit (aspect-preserving) onto a black 256×256 canvas,
 *  matching `tools/icon.mjs`. Returns the JPEG bytes or null. */
export async function encodeCoverToIconJpeg(cover: { path?: string; bytes?: ArrayBuffer | null }, log: (s: string) => void): Promise<Uint8Array | null> {
        const logErr = (where: string, e: unknown) => {
                const detail = e instanceof Error ? `${e.name}: ${e.message}${e.stack ? '\n' + e.stack : ''}` : String(e);
                log(`icon: ${where} FAILED: ${detail}`);
        };
        try {
                // --- Step 1: resolve the cover to a loadable source. ---
                let coverPath: string | undefined = cover.path;
                let coverBytes: ArrayBuffer | null = cover.bytes ?? null;
                if (!coverPath && !coverBytes) { log('icon: no cover path and no cover bytes — nothing to encode'); return null; }

                // If we have a path, try reading the first bytes to detect
                // the format and log the magic number.
                if (coverPath && !coverBytes) {
                        log(`icon: cover path = ${coverPath}`);
                        try {
                                const SwitchAny = (globalThis as any).Switch;
                                if (typeof SwitchAny?.readFileSync === 'function') {
                                        const peek = SwitchAny.readFileSync(coverPath) as ArrayBuffer | null;
                                        if (peek && peek.byteLength > 0) {
                                                const u8 = new Uint8Array(peek);
                                                log(`icon: cover file ${peek.byteLength} bytes, format=${detectImageFormat(u8)}, first8=[${hexPrefix(u8, 8)}]`);
                                        } else { log(`icon: cover file readFileSync returned ${peek === null ? 'null' : 'empty'} — Image.src will try fetch`); }
                                }
                        } catch (e) { log(`icon: cover peek failed: ${e instanceof Error ? e.message : String(e)}`); }
                } else if (coverBytes) {
                        const u8 = new Uint8Array(coverBytes);
                        log(`icon: cover bytes ${coverBytes.byteLength}, format=${detectImageFormat(u8)}, first8=[${hexPrefix(u8, 8)}]`);
                }

                // --- Step 2: check that OffscreenCanvas is available. ---
                log(`icon: OffscreenCanvas available = ${typeof OffscreenCanvas !== 'undefined'}`);
                if (typeof OffscreenCanvas === 'undefined') { log('icon: OffscreenCanvas is not defined — cannot encode'); return null; }
                const canvas = new OffscreenCanvas(256, 256);
                const ctx = canvas.getContext('2d');
                log(`icon: 2d context available = ${!!ctx}`);
                if (!ctx) return null;
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, 256, 256);

                // --- Step 3: load the Image. Try the SD path first (most
                //     reliable — nx.js's Image.src fetches sdmc: natively).
                //     Fall back to a blob URL if the path approach fails. ---
                let img: Image | null = null;
                if (coverPath) {
                        log(`icon: loading Image from sdmc path: ${coverPath}`);
                        img = await loadImageFromUrl(coverPath, log);
                }
                if (!img && coverBytes) {
                        log('icon: sdmc path failed (or no path), trying blob URL fallback');
                        const blobOk = typeof Blob !== 'undefined';
                        const urlOk = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
                        log(`icon: Blob available = ${blobOk}, URL.createObjectURL available = ${urlOk}`);
                        if (blobOk && urlOk) {
                                try {
                                        const blob = new Blob([coverBytes]);
                                        const url = URL.createObjectURL(blob);
                                        log(`icon: blob URL created: ${url.slice(0, 60)}…`);
                                        try {
                                                img = await loadImageFromUrl(url, log);
                                        } finally {
                                                try { URL.revokeObjectURL(url); } catch { /* best-effort */ }
                                        }
                                } catch (e) { logErr('blob URL create', e); }
                        } else {
                                log('icon: Blob/URL.createObjectURL unavailable — cannot create a blob URL fallback');
                        }
                }
                if (!img) { log('icon: Image could not be loaded from any source — keeping template icon'); return null; }
                log(`icon: Image loaded, dimensions = ${img.width}×${img.height}`);

                // --- Step 4: draw the image onto the 256×256 canvas
                //     (aspect-fit, centered, black background). ---
                const scale = Math.min(256 / img.width, 256 / img.height);
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const left = Math.floor((256 - w) / 2);
                const top = Math.floor((256 - h) / 2);
                log(`icon: drawImage(img, ${left}, ${top}, ${w}, ${h}) (scale=${scale.toFixed(4)})`);
                try { ctx.drawImage(img, left, top, w, h); }
                catch (e) { logErr('drawImage', e); return null; }

                // --- Step 5: encode the canvas to JPEG via convertToBlob. ---
                log(`icon: convertToBlob({type:'image/jpeg', quality:0.9}) — available = ${typeof canvas.convertToBlob === 'function'}`);
                if (typeof canvas.convertToBlob !== 'function') {
                        log('icon: canvas.convertToBlob is not a function — cannot encode JPEG');
                        return null;
                }
                let out: Blob;
                try { out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 }); }
                catch (e) { logErr('convertToBlob', e); return null; }
                log(`icon: convertToBlob returned Blob size=${out.size}, type="${out.type}"`);
                if (!out || out.size === 0) { log('icon: convertToBlob returned empty blob'); return null; }
                const buf = await out.arrayBuffer();
                const u8 = new Uint8Array(buf);
                // Verify the JPEG magic (FF D8 FF).
                if (u8.length < 3 || u8[0] !== 0xff || u8[1] !== 0xd8 || u8[2] !== 0xff) {
                        log(`icon: JPEG magic mismatch! first3=[${hexPrefix(u8, 3)}] — not a valid JPEG`);
                        return null;
                }
                log(`icon: SUCCESS — ${buf.byteLength} byte JPEG (first4=[${hexPrefix(u8, 4)}])`);
                return u8;
        } catch (e) {
                logErr('encodeCoverToIconJpeg (outer)', e);
                return null;
        }
}

/** Load an Image from a URL. Logs every state transition. Resolves with
 *  the loaded Image or null on failure. */
function loadImageFromUrl(url: string, log: (s: string) => void): Promise<Image | null> {
        return new Promise((resolve) => {
                try {
                        log(`icon: new Image(); img.src = ${url.slice(0, 70)}`);
                        const img = new Image();
                        let settled = false;
                        img.onload = () => {
                                if (!settled) { settled = true; log('icon: Image onload fired'); resolve(img); }
                        };
                        img.onerror = (e?: any) => {
                                if (!settled) {
                                        settled = true;
                                        const detail = e?.error instanceof Error ? `${e.error.name}: ${e.error.message}` : e?.message ? String(e.message) : '(no detail)';
                                        log(`icon: Image onerror for ${url.slice(0, 50)}: ${detail}`);
                                        resolve(null);
                                }
                        };
                        img.src = url;
                        // Safety timeout: 8s (cover decode can be slow for
                        // large PNGs on SD).
                        setTimeout(() => {
                                if (!settled) { settled = true; log(`icon: Image load TIMED OUT (8s) for ${url.slice(0, 50)}`); resolve(null); }
                        }, 8000);
                } catch (e) {
                        log(`icon: loadImageFromUrl threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
                        resolve(null);
                }
        });
}

// === High-level builder / lister / deleter ============================
//
// SELF-EXTRACTION APPROACH: burialnx.nro does NOT embed a separate
// forwarder-template.nro (that would double its size to ~108 MiB).
// Instead, when the user builds a forwarder, burialnx.nro reads its OWN
// .nro file from the SD card (via Switch.argv[0]), makes a copy, and
// patches three things in the copy:
//   1. The romfs `main.js` file data is overwritten with the forwarder's
//      chain-load script (which has the game-id placeholder baked in at
//      build time via __FORWARDER_MAIN_JS__).
//   2. The NACP title/author/id fields are patched (title = game name).
//   3. The icon is optionally replaced with the game's cover JPEG.
// The result is a self-contained FAT NRO that, when launched from hbmenu,
// runs the forwarder's main.js (NOT burialnx's main.js) and chain-loads
// burialnx.nro with --game <id>.
//
// This keeps burialnx.nro at ~54 MiB (no embedded template) while each
// forwarder is a self-contained ~54 MiB NRO at
// sdmc:/switch/burialnx/<game-id>.nro — exactly where the user wants it,
// no shared-runtime installation needed, no sdmc:/nx.js/ directory.

// The forwarder's main.js source, injected at build time by
// tools/build.mjs via esbuild's `define` option. Contains a 64-'0'
// placeholder for the game id that patchGameIdInString() replaces.
declare const __FORWARDER_MAIN_JS__: string;

/** Find a file by name in a romfs blob. Returns the absolute offset and
 *  size of the file's DATA within the NRO buffer (i.e. romfsStart +
 *  0x200 + fileDataOffset), or null if not found. This is a minimal
 *  romfs file-table parser — it only scans the file entry table for
 *  the matching name, without decoding the full romfs tree. */
export function findRomfsFile(romfs: Uint8Array, name: string): { offset: number; size: number } | null {
        if (romfs.byteLength < 0x50) return null;
        const view = new DataView(romfs.buffer, romfs.byteOffset, romfs.byteLength);
        // RomFS header (0x50 bytes).
        const fileEntryOffset = Number(view.getBigUint64(0x38, true));
        const fileEntryLength = Number(view.getBigUint64(0x40, true));
        const dataSectionOffset = Number(view.getBigUint64(0x48, true)); // 0x200
        if (fileEntryOffset + fileEntryLength > romfs.byteLength) return null;
        const nameBytes = new TextEncoder().encode(name);
        // Scan the file entry table. Each entry:
        //   0x00: parentDirOffset (u32)
        //   0x04: siblingOffset (u32)
        //   0x08: dataOffset (u64) — relative to dataSectionOffset
        //   0x10: dataSize (u64)
        //   0x18: hashSiblingOffset (u32)
        //   0x1c: nameSize (u32)
        //   0x20: name (nameSize bytes, padded to 4-byte alignment)
        //   entry size: 0x20 + align4(nameSize)
        for (let addr = fileEntryOffset; addr < fileEntryOffset + fileEntryLength; ) {
                if (addr + 0x20 > romfs.byteLength) break;
                const entryDataOffset = Number(view.getBigUint64(addr + 0x08, true));
                const entryDataSize = Number(view.getBigUint64(addr + 0x10, true));
                const nameSize = view.getUint32(addr + 0x1c, true);
                if (nameSize === nameBytes.length) {
                        const nameStart = addr + 0x20;
                        let match = true;
                        for (let i = 0; i < nameSize; i++) {
                                if (romfs[nameStart + i] !== nameBytes[i]) { match = false; break; }
                        }
                        if (match) {
                                const absOffset = (romfs.byteOffset) + dataSectionOffset + entryDataOffset;
                                return { offset: absOffset, size: entryDataSize };
                        }
                }
                // Advance to the next entry: 0x20 + align4(nameSize).
                const entrySize = 0x20 + ((nameSize + 3) & ~3);
                addr += entrySize;
        }
        return null;
}

/** Patch the game-id placeholder in the forwarder main.js STRING (not
 *  the romfs bytes). Returns a new string with the 64-'0' placeholder
 *  replaced by the game id (space-padded to 64 chars). Throws if the
 *  placeholder is not found or is ambiguous.
 *  Also patches the MOD_ENABLED placeholder: '0' → '1' if modEnabled. */
export function patchGameIdInString(source: string, gameId: string, modEnabled: boolean): string {
        if (gameId.length === 0) throw new Error('game id is empty');
        if (gameId.length > 64) throw new Error(`game id too long (${gameId.length} > 64)`);
        // Patch the GAME_ID placeholder (64 zeros).
        const placeholder = '0'.repeat(64);
        const replacement = gameId + ' '.repeat(64 - gameId.length);
        const first = source.indexOf(placeholder);
        if (first < 0) throw new Error('GAME_ID placeholder not found in forwarder main.js');
        const second = source.indexOf(placeholder, first + 64);
        if (second >= 0) throw new Error('GAME_ID placeholder found more than once in forwarder main.js — ambiguous');
        let result = source.slice(0, first) + replacement + source.slice(first + 64);
        // Patch the MOD_ENABLED placeholder (const MOD_ENABLED = "0" → "1").
        const modPlaceholder = 'MOD_ENABLED = "0"';
        const modReplacement = modEnabled ? 'MOD_ENABLED = "1"' : 'MOD_ENABLED = "0"';
        const modIdx = result.indexOf(modPlaceholder);
        if (modIdx >= 0) result = result.slice(0, modIdx) + modReplacement + result.slice(modIdx + modPlaceholder.length);
        return result;
}

export interface ForwarderBuildOptions {
        game: LibraryEntry;
        /** Cover image source. Pass `{ path }` to load from an SD path
         *  (preferred — nx.js's Image fetches sdmc: natively), or
         *  `{ bytes }` to create a blob URL fallback. Pass null to keep
         *  the template's existing icon. */
        cover: { path?: string; bytes?: ArrayBuffer | null } | null;
        /** The base NRO bytes (read from burialnx.nro's own file via
         *  Switch.argv[0]). The forwarder is built by patching a copy
         *  of this NRO — no separate template is embedded. */
        baseNro: ArrayBuffer;
        /** SD path to write the forwarder .nro to. */
        outputPath: string;
        log: (s: string) => void;
}

export interface ForwarderBuildResult {
        ok: boolean;
        path?: string;
        /** The final byte length of the written NRO. */
        bytes?: number;
        error?: string;
}

/** Build a per-game forwarder NRO from burialnx.nro's own file and write
 *  it to the SD card.
 *
 *  BAKED-IN APPROACH (no chain-loading):
 *  The forwarder IS a copy of burialnx.nro with TWO placeholders patched
 *  in the romfs's main.js:
 *    1. __FORWARDER_GAME_ID__ (64 '0' chars) → the game id (padded to 64)
 *    2. __FORWARDER_MOD_FORCED__ ("MODFORCED_0") → "MODFORCED_1" if mod is on
 *  At runtime, burialnx's main.ts checks these constants. If the game id
 *  is NOT all zeros, this IS a forwarder → set forwarderTargetId and
 *  auto-launch the game. NO chain-loading, NO envSetNextLoad → clean
 *  Switch.exit() → hbmenu.
 *
 *  This replaces the old chain-load approach (forwarder-template's
 *  main.js called app.launch(burialnx.nro, '--game', id) which set
 *  envSetNextLoad — persistent on some hbloaders, causing re-chain
 *  loops). */
export async function buildForwarder(opts: ForwarderBuildOptions): Promise<ForwarderBuildResult> {
        const { game, cover, baseNro, outputPath, log } = opts;
        const SwitchAny = (globalThis as any).Switch;
        if (!SwitchAny?.writeFileSync) return { ok: false, error: 'Switch.writeFileSync unavailable' };
        try {
                log(`forwarder: building for "${game.name}" (id=${game.id}) [BAKED-IN approach]`);
                // 1. Decode the base NRO's structure (the code segment IS
                //    the nx.js runtime — we reuse it unchanged).
                const structure = decodeNroStructure(baseNro);
                log(`forwarder: base nroSize=0x${structure.nroSize.toString(16)} icon=0x${structure.iconSize.toString(16)} nacp=0x${structure.nacpSize.toString(16)} romfs=0x${structure.romfsSize.toString(16)}`);
                // 2. Get the romfs bytes (we'll patch placeholders IN PLACE —
                //    no main.js overwrite, no padding, no romfs rebuild).
                const romfsBytes = new Uint8Array(baseNro, structure.romfsOffset, structure.romfsSize);
                // 3. Patch the GAME_ID placeholder (64 '0' chars → game id,
                //    space-padded to 64). patchGameIdInRomfs searches the
                //    entire romfs for the 64-'0' byte sequence and overwrites
                //    it. The sequence appears exactly once (in burialnx's
                //    main.js, baked by the build-time define).
                let patchedRomfs = patchGameIdInRomfs(romfsBytes, game.id);
                log(`forwarder: patched GAME_ID placeholder (id="${game.id}")`);
                // 4. Patch the MOD_FORCED placeholder ("MODFORCED_0" →
                //    "MODFORCED_1" if the mod is enabled at build time).
                //    This forces the mod on at auto-launch, even if the
                //    user later disables it in the library.
                //
                //    CRITICAL: the placeholder strings are constructed via
                //    String.fromCharCode (NOT as literals) so esbuild does
                //    NOT inline them into main.js. If they were literals,
                //    there would be TWO matches in the romfs (one from
                //    main.ts's __FORWARDER_MOD_FORCED__ define, one from
                //    this call) and patchStringInRomfs would throw
                //    "ambiguous".
                const modEnabled = game.mod !== undefined && game.mod !== null && game.modEnabled !== false;
                if (modEnabled) {
                        const modPh = String.fromCharCode(77,79,68,70,79,82,67,69,68,95,48); // "MODFORCED_0"
                        const modRep = String.fromCharCode(77,79,68,70,79,82,67,69,68,95,49); // "MODFORCED_1"
                        patchedRomfs = patchStringInRomfs(patchedRomfs, modPh, modRep);
                        log(`forwarder: patched MOD_FORCED placeholder (mod ON)`);
                } else {
                        log(`forwarder: mod OFF — MOD_FORCED placeholder unchanged`);
                }
                // 5. Copy the entire base NRO and apply the patched romfs.
                //    This is the 54 MiB that makes each forwarder
                //    self-contained.
                const out = new Uint8Array(baseNro.byteLength);
                out.set(new Uint8Array(baseNro));
                // Overwrite the romfs section with the patched romfs.
                // The romfs size doesn't change (patch-in-place, same byte
                // lengths), so the NRO layout stays valid.
                out.set(patchedRomfs, structure.romfsOffset);
                log(`forwarder: applied patched romfs (in-place, no main.js overwrite)`);
                // 6. Patch the NACP: title = game name, author = "BurialNX",
                //    application id = stable hash.
                const nacpView = new Uint8Array(out.buffer, structure.nacpOffset, Math.min(structure.nacpSize, NACP_SIZE));
                writeNacpTitle(nacpView, game.name);
                writeNacpAuthor(nacpView, 'BurialNX');
                writeNacpId(nacpView, forwarderIdFor(game.id));
                // Zero out save-data fields so the Switch doesn't create
                // save data for the forwarder title.
                writeNacpForwarderDefaults(nacpView);
                log(`forwarder: patched NACP (title="${game.name}", author="BurialNX")`);
                // 7. Optionally patch the icon. If the cover can't be
                //    encoded, keep the base NRO's existing icon.
                if (cover && (cover.path || cover.bytes)) {
                        const encoded = await encodeCoverToIconJpeg(cover, log);
                        if (encoded && encoded.byteLength > 0) {
                                // The icon is variable-length (JPEG). We need to
                                // rebuild the asset section with the new icon
                                // size. The NACP and romfs sizes don't change.
                                const code = new Uint8Array(out.buffer, 0, structure.nroSize);
                                const finalRomfs = new Uint8Array(out.buffer, structure.romfsOffset, structure.romfsSize);
                                const nacp = new Uint8Array(out.buffer, structure.nacpOffset, Math.min(structure.nacpSize, NACP_SIZE));
                                const newNro = encodeNro(code, encoded, nacp, finalRomfs);
                                log(`forwarder: rebuilt NRO with new icon (${encoded.byteLength} bytes) — total ${newNro.byteLength} bytes`);
                                try {
                                        const dir = forwarderDirFor(game.name, game.id);
                                        SwitchAny.mkdirSync?.(dir);
                                } catch { /* may already exist */ }
                                SwitchAny.writeFileSync(outputPath, newNro.buffer);
                                log(`forwarder: written ${outputPath} (${newNro.byteLength} bytes) [BAKED-IN, no chain-load]`);
                                return { ok: true, path: outputPath, bytes: newNro.byteLength };
                        } else {
                                log('forwarder: icon encoding failed — keeping base NRO icon');
                        }
                }
                // 8. No icon change (or icon encoding failed) — write the
                //    patched copy directly. The asset section is unchanged
                //    (same icon, same NACP size, same romfs size).
                try {
                        const dir = forwarderDirFor(game.name, game.id);
                        SwitchAny.mkdirSync?.(dir);
                } catch { /* may already exist */ }
                SwitchAny.writeFileSync(outputPath, out.buffer);
                log(`forwarder: written ${outputPath} (${out.byteLength} bytes) [BAKED-IN, no chain-load]`);
                return { ok: true, path: outputPath, bytes: out.byteLength };
        } catch (e) {
                const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
                log(`forwarder: build failed: ${error}`);
                return { ok: false, error };
        }
}

/** Check whether a forwarder .nro exists on the SD card for the given
 *  game. */
export function forwarderExists(fs: LibraryAccess, gameName: string, gameId: string): boolean {
        try { return fs.statSync(forwarderPathFor(gameName, gameId)) != null; } catch { return false; }
}

/** Delete a forwarder .nro. Best-effort: a missing file is not an error.
 *  Returns true if the file was deleted. */
export function deleteForwarder(fs: LibraryAccess & { removeSync?: (path: string) => void; unlinkSync?: (path: string) => void }, gameName: string, gameId: string): boolean {
        const nroPath = forwarderPathFor(gameName, gameId);
        const remove = fs.removeSync || fs.unlinkSync;
        if (!remove) return false;
        try {
                if (fs.statSync(nroPath)) { remove.call(fs, nroPath); return true; }
        } catch { /* not present */ }
        return false;
}
