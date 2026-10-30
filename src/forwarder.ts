/** Per-game forwarder NRO generation: build, list, rename, and delete self-contained forwarder NROs. */
import type { LibraryEntry, LibraryAccess } from './game-library';

const NRO_MAGIC = 'NRO0';
const ASET_MAGIC = 'ASET';
const ASSET_HEADER_SIZE = 0x38;

const NACP_SIZE = 0x4000;
const NACP_LANGUAGE_ENTRY_SIZE = 0x300;
const NACP_TITLE_SIZE = 0x200;
const NACP_AUTHOR_SIZE = 0x100;
const NACP_LANGUAGE_COUNT = 12;
const NACP_PRESENCE_GROUP_ID_OFFSET = 0x3038;
const NACP_SAVE_DATA_OWNER_ID_OFFSET = 0x3078;
const NACP_ADD_ON_CONTENT_BASE_ID_OFFSET = 0x3070;
const NACP_LOCAL_COMM_ID_OFFSET = 0x30b0;
const NACP_LOCAL_COMM_ID_COUNT = 8;
const NACP_STARTUP_USER_ACCOUNT_OFFSET = 0x3025;
const NACP_USER_ACCOUNT_SAVE_DATA_SIZE_OFFSET = 0x3080;
const NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET = 0x3088;
const NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET = 0x3090;

export const FORWARDERS_BASE_DIR = 'sdmc:/switch';

/** The embedded template NRO path inside burialnx.nro's own romfs. */
export const FORWARDER_TEMPLATE_ROMFS_PATH = 'romfs:/forwarder-template.nro';

/** Where the main burialnx.nro is expected to live on the SD card. */
export const BURIALNX_NRO_PATH = 'sdmc:/switch/burialnx/burialnx.nro';
export const BURIALNX_DEBUG_NRO_PATH = 'sdmc:/switch/burialnx/burialnx-debug.nro';

/** Sanitize a game name into a folder/filename (spaces → underscores, ≤ 40 chars, fallback if empty). */
export function sanitizeGameName(name: string, fallback: string): string {
        const cleaned = name.replace(/[^a-zA-Z0-9 \-_]/g, '').replace(/ /g, '_').trim().slice(0, 40);
        return cleaned || fallback;
}

/** Compute the forwarder .nro directory (sdmc:/switch/<sanitized-name>/). */
export function forwarderDirFor(gameName: string, gameId: string): string {
        return `${FORWARDERS_BASE_DIR}/${sanitizeGameName(gameName, gameId)}`;
}

/** Compute the forwarder .nro path on the SD card for a given game. */
export function forwarderPathFor(gameName: string, gameId: string): string {
        const dir = forwarderDirFor(gameName, gameId);
        const name = sanitizeGameName(gameName, gameId);
        return `${dir}/${name}.nro`;
}

const GAME_ID_PLACEHOLDER = '0'.repeat(64);
const GAME_ID_PLACEHOLDER_BYTES = new TextEncoder().encode(GAME_ID_PLACEHOLDER);

/** Patch the 64-'0' GAME_ID placeholder in a copy of the romfs bytes with the game id (space-padded to 64). */
export function patchGameIdInRomfs(romfs: Uint8Array, gameId: string): Uint8Array {
        if (gameId.length === 0) throw new Error('game id is empty');
        if (gameId.length > 64) throw new Error(`game id too long (${gameId.length} > 64)`);
        const encoded = new TextEncoder().encode(gameId);
        if (encoded.length > 64) throw new Error(`game id UTF-8 encoding too long (${encoded.length} > 64)`);
        const replacement = new Uint8Array(64);
        replacement.set(encoded);
        for (let i = encoded.length; i < 64; i++) replacement[i] = 0x20;
        const found = findAll(romfs, GAME_ID_PLACEHOLDER_BYTES);
        if (found.length === 0) throw new Error('GAME_ID placeholder not found in template romfs — the template was not built correctly');
        if (found.length > 1) throw new Error(`GAME_ID placeholder found ${found.length} times in template romfs — ambiguous, refusing to patch`);
        const offset = found[0];
        const out = new Uint8Array(romfs);
        out.set(replacement, offset);
        return out;
}

/** Patch a same-length UTF-8 string placeholder in a copy of the romfs bytes. */
export function patchStringInRomfs(romfs: Uint8Array, placeholder: string, replacement: string): Uint8Array {
        const placeholderBytes = new TextEncoder().encode(placeholder);
        const replacementBytes = new TextEncoder().encode(replacement);
        if (placeholderBytes.length !== replacementBytes.length) {
                throw new Error(`patchStringInRomfs: placeholder (${placeholderBytes.length} bytes) and replacement (${replacementBytes.length} bytes) must be the same byte length`);
        }
        const found = findAll(romfs, placeholderBytes);
        if (found.length === 0) throw new Error(`patchStringInRomfs: placeholder "${placeholder}" not found in romfs`);
        if (found.length > 1) throw new Error(`patchStringInRomfs: placeholder "${placeholder}" found ${found.length} times in romfs — ambiguous, refusing to patch`);
        const out = new Uint8Array(romfs);
        out.set(replacementBytes, found[0]);
        return out;
}

/** Find all byte offsets where `needle` appears in `haystack`. */
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

/** Stable per-game application ID: FNV-1a hash of game id into the homebrew title-ID range. */
export function forwarderIdFor(gameId: string): bigint {
        let hash = 0x811c9dc5;
        for (let i = 0; i < gameId.length; i++) {
                hash ^= gameId.charCodeAt(i) & 0xff;
                hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        const folded = ((hash >>> 16) ^ (hash & 0xffff)) >>> 0;
        return 0x0100000000010000n | BigInt(folded & 0xffff);
}

interface NroStructure {
        nroSize: number;
        iconOffset: number;
        iconSize: number;
        nacpOffset: number;
        nacpSize: number;
        romfsOffset: number;
        romfsSize: number;
}

/** Decode an NRO's structure: locate the asset section and the icon, NACP and romfs segments. */
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

/** Build a fresh NRO from a code segment, icon, NACP and romfs (asset header rebuilt for new sizes). */
export function encodeNro(code: Uint8Array, icon: Uint8Array, nacp: Uint8Array, romfs: Uint8Array): Uint8Array {
        const total = code.byteLength + ASSET_HEADER_SIZE + icon.byteLength + nacp.byteLength + romfs.byteLength;
        const out = new Uint8Array(total);
        out.set(code, 0);
        const assetBase = code.byteLength;
        const header = new DataView(out.buffer, assetBase, ASSET_HEADER_SIZE);
        header.setUint8(0, 0x41); header.setUint8(1, 0x53); header.setUint8(2, 0x45); header.setUint8(3, 0x54);
        header.setUint32(4, 0, true);
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

/** Write the application title into all 12 NACP language entries (UTF-8, null-padded). */
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
/** Write the application ID into PresenceGroupId, SaveDataOwnerId, AddOnContentBaseId, and all 8 LocalCommunicationId slots. */
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

/** Zero the save-data fields and startup-user-account flag in a forwarder NACP (no save data, no profile dialog). */
export function writeNacpForwarderDefaults(nacp: Uint8Array): void {
        const view = new DataView(nacp.buffer, nacp.byteOffset, nacp.byteLength);
        view.setUint8(NACP_STARTUP_USER_ACCOUNT_OFFSET, 0);
        view.setBigUint64(NACP_USER_ACCOUNT_SAVE_DATA_SIZE_OFFSET, 0n, true);
        view.setBigUint64(NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET, 0n, true);
        view.setBigUint64(NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET, 0n, true);
}

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

/** Re-encode a game cover image as a 256×256 JPEG (SD path or raw bytes; null on failure). */
export async function encodeCoverToIconJpeg(cover: { path?: string; bytes?: ArrayBuffer | null }, log: (s: string) => void): Promise<Uint8Array | null> {
        const logErr = (where: string, e: unknown) => {
                const detail = e instanceof Error ? `${e.name}: ${e.message}${e.stack ? '\n' + e.stack : ''}` : String(e);
                log(`icon: ${where} FAILED: ${detail}`);
        };
        try {
                let coverPath: string | undefined = cover.path;
                let coverBytes: ArrayBuffer | null = cover.bytes ?? null;
                if (!coverPath && !coverBytes) { log('icon: no cover path and no cover bytes — nothing to encode'); return null; }

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

                log(`icon: OffscreenCanvas available = ${typeof OffscreenCanvas !== 'undefined'}`);
                if (typeof OffscreenCanvas === 'undefined') { log('icon: OffscreenCanvas is not defined — cannot encode'); return null; }
                const canvas = new OffscreenCanvas(256, 256);
                const ctx = canvas.getContext('2d');
                log(`icon: 2d context available = ${!!ctx}`);
                if (!ctx) return null;
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, 256, 256);

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
                                                try { URL.revokeObjectURL(url); } catch { }
                                        }
                                } catch (e) { logErr('blob URL create', e); }
                        } else {
                                log('icon: Blob/URL.createObjectURL unavailable — cannot create a blob URL fallback');
                        }
                }
                if (!img) { log('icon: Image could not be loaded from any source — keeping template icon'); return null; }
                log(`icon: Image loaded, dimensions = ${img.width}×${img.height}`);

                const scale = Math.min(256 / img.width, 256 / img.height);
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const left = Math.floor((256 - w) / 2);
                const top = Math.floor((256 - h) / 2);
                log(`icon: drawImage(img, ${left}, ${top}, ${w}, ${h}) (scale=${scale.toFixed(4)})`);
                try { ctx.drawImage(img, left, top, w, h); }
                catch (e) { logErr('drawImage', e); return null; }

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

/** Load an Image from a URL, logging state transitions; null on failure or 8s timeout. */
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
                        setTimeout(() => {
                                if (!settled) { settled = true; log(`icon: Image load TIMED OUT (8s) for ${url.slice(0, 50)}`); resolve(null); }
                        }, 8000);
                } catch (e) {
                        log(`icon: loadImageFromUrl threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
                        resolve(null);
                }
        });
}

declare const __FORWARDER_MAIN_JS__: string;

/** Find a file by name in a romfs blob; returns absolute offset and size of the file's data, or null. */
export function findRomfsFile(romfs: Uint8Array, name: string): { offset: number; size: number } | null {
        if (romfs.byteLength < 0x50) return null;
        const view = new DataView(romfs.buffer, romfs.byteOffset, romfs.byteLength);
        const fileEntryOffset = Number(view.getBigUint64(0x38, true));
        const fileEntryLength = Number(view.getBigUint64(0x40, true));
        const dataSectionOffset = Number(view.getBigUint64(0x48, true));
        if (fileEntryOffset + fileEntryLength > romfs.byteLength) return null;
        const nameBytes = new TextEncoder().encode(name);
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
                const entrySize = 0x20 + ((nameSize + 3) & ~3);
                addr += entrySize;
        }
        return null;
}

/** Patch the GAME_ID (64 zeros) and MOD_ENABLED placeholders in the forwarder main.js string. */
export function patchGameIdInString(source: string, gameId: string, modEnabled: boolean): string {
        if (gameId.length === 0) throw new Error('game id is empty');
        if (gameId.length > 64) throw new Error(`game id too long (${gameId.length} > 64)`);
        const placeholder = '0'.repeat(64);
        const replacement = gameId + ' '.repeat(64 - gameId.length);
        const first = source.indexOf(placeholder);
        if (first < 0) throw new Error('GAME_ID placeholder not found in forwarder main.js');
        const second = source.indexOf(placeholder, first + 64);
        if (second >= 0) throw new Error('GAME_ID placeholder found more than once in forwarder main.js — ambiguous');
        let result = source.slice(0, first) + replacement + source.slice(first + 64);
        const modPlaceholder = 'MOD_ENABLED = "0"';
        const modReplacement = modEnabled ? 'MOD_ENABLED = "1"' : 'MOD_ENABLED = "0"';
        const modIdx = result.indexOf(modPlaceholder);
        if (modIdx >= 0) result = result.slice(0, modIdx) + modReplacement + result.slice(modIdx + modPlaceholder.length);
        return result;
}

export interface ForwarderBuildOptions {
        game: LibraryEntry;
        /** Cover image source (`{ path }` preferred, or `{ bytes }` for blob URL fallback; null keeps template icon). */
        cover: { path?: string; bytes?: ArrayBuffer | null } | null;
        /** Base NRO bytes (read from burialnx.nro via Switch.argv[0]) — the forwarder patches a copy. */
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

/** Build a per-game forwarder NRO by patching a copy of burialnx.nro; writes to SD card. */
export async function buildForwarder(opts: ForwarderBuildOptions): Promise<ForwarderBuildResult> {
        const { game, cover, baseNro, outputPath, log } = opts;
        const SwitchAny = (globalThis as any).Switch;
        if (!SwitchAny?.writeFileSync) return { ok: false, error: 'Switch.writeFileSync unavailable' };
        try {
                log(`forwarder: building for "${game.name}" (id=${game.id}) [BAKED-IN approach]`);
                const structure = decodeNroStructure(baseNro);
                log(`forwarder: base nroSize=0x${structure.nroSize.toString(16)} icon=0x${structure.iconSize.toString(16)} nacp=0x${structure.nacpSize.toString(16)} romfs=0x${structure.romfsSize.toString(16)}`);
                const romfsBytes = new Uint8Array(baseNro, structure.romfsOffset, structure.romfsSize);
                let patchedRomfs = patchGameIdInRomfs(romfsBytes, game.id);
                log(`forwarder: patched GAME_ID placeholder (id="${game.id}")`);
                const modEnabled = game.mod !== undefined && game.mod !== null && game.modEnabled !== false;
                if (modEnabled) {
                        const modPh = String.fromCharCode(77,79,68,70,79,82,67,69,68,95,48);
                        const modRep = String.fromCharCode(77,79,68,70,79,82,67,69,68,95,49);
                        patchedRomfs = patchStringInRomfs(patchedRomfs, modPh, modRep);
                        log(`forwarder: patched MOD_FORCED placeholder (mod ON)`);
                } else {
                        log(`forwarder: mod OFF — MOD_FORCED placeholder unchanged`);
                }
                const out = new Uint8Array(baseNro.byteLength);
                out.set(new Uint8Array(baseNro));
                out.set(patchedRomfs, structure.romfsOffset);
                log(`forwarder: applied patched romfs (in-place, no main.js overwrite)`);
                const nacpView = new Uint8Array(out.buffer, structure.nacpOffset, Math.min(structure.nacpSize, NACP_SIZE));
                writeNacpTitle(nacpView, game.name);
                writeNacpAuthor(nacpView, 'BurialNX');
                writeNacpId(nacpView, forwarderIdFor(game.id));
                writeNacpForwarderDefaults(nacpView);
                log(`forwarder: patched NACP (title="${game.name}", author="BurialNX")`);
                if (cover && (cover.path || cover.bytes)) {
                        const encoded = await encodeCoverToIconJpeg(cover, log);
                        if (encoded && encoded.byteLength > 0) {
                                const code = new Uint8Array(out.buffer, 0, structure.nroSize);
                                const finalRomfs = new Uint8Array(out.buffer, structure.romfsOffset, structure.romfsSize);
                                const nacp = new Uint8Array(out.buffer, structure.nacpOffset, Math.min(structure.nacpSize, NACP_SIZE));
                                const newNro = encodeNro(code, encoded, nacp, finalRomfs);
                                log(`forwarder: rebuilt NRO with new icon (${encoded.byteLength} bytes) — total ${newNro.byteLength} bytes`);
                                try {
                                        const dir = forwarderDirFor(game.name, game.id);
                                        SwitchAny.mkdirSync?.(dir);
                                } catch { }
                                SwitchAny.writeFileSync(outputPath, newNro.buffer);
                                log(`forwarder: written ${outputPath} (${newNro.byteLength} bytes) [BAKED-IN, no chain-load]`);
                                return { ok: true, path: outputPath, bytes: newNro.byteLength };
                        } else {
                                log('forwarder: icon encoding failed — keeping base NRO icon');
                        }
                }
                try {
                        const dir = forwarderDirFor(game.name, game.id);
                        SwitchAny.mkdirSync?.(dir);
                } catch { }
                SwitchAny.writeFileSync(outputPath, out.buffer);
                log(`forwarder: written ${outputPath} (${out.byteLength} bytes) [BAKED-IN, no chain-load]`);
                return { ok: true, path: outputPath, bytes: out.byteLength };
        } catch (e) {
                const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
                log(`forwarder: build failed: ${error}`);
                return { ok: false, error };
        }
}

/** Check whether a forwarder .nro exists on the SD card for the given game. */
export function forwarderExists(fs: LibraryAccess, gameName: string, gameId: string): boolean {
        try { return fs.statSync(forwarderPathFor(gameName, gameId)) != null; } catch { return false; }
}

/** Rename a forwarder's folder and .nro file when the game is renamed; returns true if renamed. */
export function renameForwarder(fs: LibraryAccess & { removeSync?: (path: string) => void; unlinkSync?: (path: string) => void; rmdirSync?: (path: string) => void; readFileSync?: (path: string) => ArrayBuffer | null }, oldName: string, newName: string, gameId: string): boolean {
        const oldPath = forwarderPathFor(oldName, gameId);
        const newDir = forwarderDirFor(newName, gameId);
        const newPath = forwarderPathFor(newName, gameId);
        const oldDir = forwarderDirFor(oldName, gameId);
        try { if (!fs.statSync(oldPath)) return false; } catch { return false; }
        let nroBytes: ArrayBuffer | null = null;
        try { nroBytes = fs.readFileSync?.(oldPath) ?? null; } catch { return false; }
        if (!nroBytes) return false;
        try { fs.mkdirSync(newDir); } catch { }
        try { fs.writeFileSync(newPath, nroBytes); } catch { return false; }
        const remove = fs.removeSync || fs.unlinkSync;
        if (remove) {
                try { remove.call(fs, oldPath); } catch { }
                try {
                        const entries = (fs as any).readDirSync?.(`${oldDir}/`) as string[] | null;
                        if (entries) {
                                for (const name of entries) {
                                        if (name && name !== '.' && name !== '..') {
                                                try { remove.call(fs, `${oldDir}/${name}`); } catch { }
                                        }
                                }
                        }
                } catch { }
                try { (fs as any).rmdirSync?.(oldDir); } catch { }
                try { (fs as any).removeSync?.(oldDir); } catch { }
                try { (fs as any).unlinkSync?.(oldDir); } catch { }
        }
        return true;
}

/** Delete a forwarder .nro and its containing folder (best-effort); returns true if the .nro was deleted. */
export function deleteForwarder(fs: LibraryAccess & { removeSync?: (path: string) => void; unlinkSync?: (path: string) => void; rmdirSync?: (path: string) => void }, gameName: string, gameId: string): boolean {
        const nroPath = forwarderPathFor(gameName, gameId);
        const dir = forwarderDirFor(gameName, gameId);
        const remove = fs.removeSync || fs.unlinkSync;
        if (!remove) return false;
        let deleted = false;
        try {
                if (fs.statSync(nroPath)) { remove.call(fs, nroPath); deleted = true; }
        } catch { }
        try {
                const entries = (fs as any).readDirSync?.(`${dir}/`) as string[] | null;
                if (entries) {
                        for (const name of entries) {
                                if (name && name !== '.' && name !== '..') {
                                        try { remove.call(fs, `${dir}/${name}`); } catch { }
                                }
                        }
                }
        } catch { }
        try { (fs as any).rmdirSync?.(dir); } catch { }
        try { (fs as any).removeSync?.(dir); } catch { }
        try { (fs as any).unlinkSync?.(dir); } catch { }
        return deleted;
}
