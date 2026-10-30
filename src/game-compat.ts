import type { Reader } from './library';
import type { KeyMap } from './keymap';
import { applyKeyMap } from './keymap';
import { interactionTextY } from './dialogue';
import { fixIndexedPng } from './indexed-png';

/** Strip desktop-only plugin payloads and the top-level 'use strict' directive so indirect eval matches a <script> tag. */
export function prepareGameScript(path: string, source: string): string | null {
        if (path.endsWith('/AudioStreaming.js')) return null;
        if (path.endsWith('/YEP_RegionRestrictions.js') && source.includes("'zlib'") && source.includes('Buffer[')) {
                const lines = source.split('\n');
                const injected = lines.flatMap((line, index) =>
                        line.includes("'zlib'") && line.includes('Buffer[') ? [index] : []);
                if (injected.length !== 1) throw new Error('Unrecognized region plugin: cannot remove Node payload safely');
                const line = lines[injected[0]];
                const prefix = /^(};)\(function\(/.exec(line)?.[1]
                        || /^(\s*Yanfly\.RR\s*=\s*Yanfly\.RR\s*\|\|\s*\{\s*\};)\s*\(function\(/.exec(line)?.[1];
                if (!prefix) throw new Error('Unrecognized region plugin: cannot remove Node payload safely');
                lines[injected[0]] = prefix;
                source = lines.join('\n');
        }
        source = stripTopLevelUseStrict(source);
        return source;
}

/** Remove only the top-level 'use strict' prologue (not function-body directives), via a single-pass line scan. */
export function stripTopLevelUseStrict(source: string): string {
        const lines = source.split('\n');
        let inBlockComment = false;
        for (let i = 0; i < lines.length; i++) {
                let line = lines[i];
                if (inBlockComment) {
                        const end = line.indexOf('*/');
                        if (end >= 0) { inBlockComment = false; line = line.slice(end + 2); }
                        else continue;
                }
                let rest = line;
                for (;;) {
                        const start = rest.indexOf('/*');
                        if (start < 0) break;
                        const end = rest.indexOf('*/', start + 2);
                        if (end < 0) { inBlockComment = true; rest = rest.slice(0, start); break; }
                        rest = rest.slice(0, start) + rest.slice(end + 2);
                }
                const commentIdx = rest.indexOf('//');
                if (commentIdx >= 0) rest = rest.slice(0, commentIdx);
                const trimmed = rest.trim();
                if (!trimmed) continue;
                const m = /^(['"])use strict\1;?$/.exec(trimmed);
                if (m) { lines.splice(i, 1); return lines.join('\n'); }
                return source;
        }
        return source;
}

type Language = Record<string, Record<string, string | string[]>>;

/** A fully-decoded language pack: translation tables plus embedded font + translated images. */
export interface LanguagePack {
        table: Language;
        /** Logical font-family name to use for this language (e.g. 'bitter-pro-regular'). */
        fontFace: string | null;
        /** Font size in pixels to use for this language (e.g. 24 for Russian vs 28 English). */
        fontSize: number | null;
        /** Base64-encoded font file (TTF/OTF/WOFF) embedded in the .cld, or null. */
        fontFile: string | null;
        /** Map of hashed asset path → base64-encoded replacement image (PNG). */
        imgFiles: Record<string, string>;
        /** Human-readable language name (e.g. 'Русский'). */
        langName: string | null;
        /** The asset path this pack was loaded from, for diagnostics. */
        source: string | null;
}

/** Parse a LANGDATA blob (from data/<hash> or languages/<code>.cld) into a LanguagePack. */
export function parseLanguagePack(bytes: ArrayBuffer, source: string | null): LanguagePack {
        const text = new TextDecoder().decode(bytes);
        if (!text.startsWith('LANGDATA')) throw new Error('Unsupported language data');
        const raw = JSON.parse(text.slice(8)) as Record<string, unknown>;
        const table: Language = {};
        for (const key of ['linesLUT', 'labelLUT', 'sysLabel', 'sysMenus'] as const) {
                const value = raw[key];
                if (value && typeof value === 'object') (table as any)[key] = value;
        }
        const fontFace = typeof raw.fontFace === 'string' ? raw.fontFace : null;
        const fontSize = typeof raw.fontSize === 'number' ? raw.fontSize : null;
        const fontFile = typeof raw.fontFile === 'string' && raw.fontFile.length > 0 ? raw.fontFile : null;
        const langName = typeof raw.langName === 'string' ? raw.langName : null;
        const imgFiles = (raw.imgFiles && typeof raw.imgFiles === 'object' ? raw.imgFiles : {}) as Record<string, string>;
        return { table, fontFace, fontSize, fontFile, imgFiles, langName, source };
}

/** The hashed asset path of the default (English) language data embedded in data/. */
const DEFAULT_LANGUAGE_PATH = 'data/9c7050ae76645487';

/** Load the default English language table (kept for backward compatibility with tests). */
export async function languageTable(assets: Reader): Promise<Language | null> {
        const data = await assets.read(DEFAULT_LANGUAGE_PATH);
        if (!data) return null;
        return parseLanguagePack(data, null).table;
}

/** Load a language pack from a .cld, falling back to the default English data when the requested pack can't be read. */
export async function loadLanguagePack(assets: Reader, cldPath: string | null): Promise<LanguagePack | null> {
        if (cldPath) {
                const bytes = await assets.read(cldPath);
                if (bytes) {
                        try { return parseLanguagePack(bytes, cldPath); }
                        catch { /* fall through to default */ }
                }
        }
        const fallback = await assets.read(DEFAULT_LANGUAGE_PATH);
        if (!fallback) return null;
        return parseLanguagePack(fallback, DEFAULT_LANGUAGE_PATH);
}

/** A minimal Switch filesystem surface for scanning language folders. */
export interface LanguageScanFs {
        readDirSync?(path: string): string[] | null;
        statSync?(path: string): { mode: number } | null;
}

export interface LanguageEntry {
        /** Asset path suitable for `assets.read()` — relative to the game www root. Only set when the pack lives inside www (no `..`). */
        path: string | null;
        /** Absolute sdmc path for direct Switch.readFile() — always set. Used when the pack lives one level above www (assetPath rejects `..`). */
        absPath: string;
        /** Short code derived from the filename, e.g. 'ru' for 'ru.cld'. */
        code: string;
        /** Human-readable name decoded from the pack's langName, or the code. */
        name: string;
}

/** Scan www/languages (and one level above www as a fallback) for .cld packs, sorted by code. */
export function scanLanguageFiles(fs: LanguageScanFs | null, gameRoot: string): LanguageEntry[] {
        if (!fs?.readDirSync) return [];
        const clean = gameRoot.replace(/\/+$/, '');
        const candidates = [
                { dir: `${clean}/languages`, relBase: 'languages', parent: false },
                { dir: `${clean.replace(/\/www$/i, '')}/languages`, relBase: '../languages', parent: true },
        ];
        const seen = new Set<string>();
        const entries: LanguageEntry[] = [];
        for (const { dir, relBase, parent } of candidates) {
                let names: string[] | null = null;
                try { names = fs.readDirSync!(`${dir}/`); } catch { /* unreadable */ }
                if (!names) continue;
                for (const name of names) {
                        if (!name || !/\.cld$/i.test(name)) continue;
                        const code = name.replace(/\.cld$/i, '').toLowerCase();
                        if (seen.has(code)) continue;
                        seen.add(code);
                        const path = parent ? null : `${relBase}/${name}`;
                        const absPath = `${dir}/${name}`;
                        entries.push({ path, absPath, code, name: code });
                }
        }
        entries.sort((a, b) => (a.code === 'ru' ? -1 : b.code === 'ru' ? 1 : a.code.localeCompare(b.code)));
        return entries;
}

/** Best-effort lookup of a human-readable name for a language pack by peeking at its langName field. */
export async function resolveLanguageName(assets: Reader, entry: LanguageEntry): Promise<string> {
        const bytes = await assets.read(entry.path);
        if (!bytes) return entry.code;
        try {
                const text = new TextDecoder().decode(bytes);
                if (!text.startsWith('LANGDATA')) return entry.code;
                const raw = JSON.parse(text.slice(8)) as Record<string, unknown>;
                return typeof raw.langName === 'string' && raw.langName ? raw.langName : entry.code;
        } catch { return entry.code; }
}

/** Decode a base64 string into an ArrayBuffer (used for embedded fonts/images). */
function decodeBase64(base64: string): ArrayBuffer {
        const clean = base64.replace(/\s+/g, '');
        if (typeof atob === 'function') {
                const binary = atob(clean);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return bytes.buffer;
        }
        const lookup = new Int8Array(128).fill(-1);
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
        const out: number[] = [];
        let buffer = 0, bits = 0;
        for (let i = 0; i < clean.length; i++) {
                const c = clean.charCodeAt(i);
                if (c >= 128) continue;
                const v = lookup[c];
                if (v < 0) { if (c === 61 ) break; continue; }
                buffer = (buffer << 6) | v;
                bits += 6;
                if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 0xff); }
        }
        return new Uint8Array(out).buffer;
}

/** Roll back an interpreter waiting on a message so the save captures it at the ShowText/ShowChoices command. */
function rollbackInterpreterForMessageWait(interp: any, runtime: any): void {
        if (!interp || interp._waitMode !== 'message') return;
        const list = interp._list;
        if (!Array.isArray(list) || interp._index == null) return;
        const startIndent = interp._indent ?? 0;
        let target101 = -1, target102 = -1;
        for (let i = interp._index - 1; i >= 0; i--) {
                const cmd = list[i];
                if (!cmd) continue;
                if (typeof cmd.indent === 'number' && cmd.indent < startIndent) break;
                if (cmd.code === 101) { target101 = i; break; }
                if (cmd.code === 102 && target102 < 0) target102 = i;
        }
        const target = target101 >= 0 ? target101 : target102;
        if (target < 0) return;
        interp._index = target;
        interp._waitMode = '';
        try { runtime.$gameMessage?.clear?.(); } catch { /* best-effort */ }
}

/** Register the language pack's embedded font and override MV's font selection so every window/bitmap uses it. */
export async function registerLanguageFont(runtime: any, pack: LanguagePack): Promise<void> {
        const face = pack.fontFace;
        const size = pack.fontSize;
        if (face && pack.fontFile) {
                try {
                        const bytes = decodeBase64(pack.fontFile);
                        if (runtime.FontFace && runtime.fonts?.add) {
                                for (const variant of [{}, { weight: 'bold' }, { style: 'italic' }, { style: 'italic', weight: 'bold' }]) {
                                        try { runtime.fonts.add(new runtime.FontFace(face, bytes, variant)); }
                                        catch { /* best-effort: variant may not be supported */ }
                                }
                        }
                } catch { /* best-effort: fall back to default font */ }
        }
        if (face) {
                const base = runtime.Window_Base?.prototype;
                if (base && typeof base.standardFontFace === 'function') {
                        base.standardFontFace = function() { return face; };
                }
                if (runtime.Yanfly?.Param) runtime.Yanfly.Param.DefaultFont = face;
                if (runtime.Yanfly?.Param) {
                        runtime.Yanfly.Param.MSGFontName = face;
                        runtime.Yanfly.Param.MSGCNFontName = face;
                        runtime.Yanfly.Param.MSGKRFontName = face;
                }
                for (const proto of [runtime.Window_Message?.prototype, runtime.Window_ChoiceList?.prototype, runtime.Window_NameBox?.prototype]) {
                        if (proto) proto.standardFontFace = function() { return face; };
                }
                if (runtime.Graphics) runtime.Graphics.fontFace = face;
                if (runtime.Bitmap?.prototype) runtime.Bitmap.prototype.fontFace = face;
        }
        if (size) {
                const base = runtime.Window_Base?.prototype;
                if (base && typeof base.standardFontSize === 'function') {
                        base.standardFontSize = function() { return size; };
                }
                if (runtime.Yanfly?.Param) {
                        runtime.Yanfly.Param.FontSize = size;
                        runtime.Yanfly.Param.MSGFontSize = size;
                }
                if (runtime.Bitmap?.prototype) runtime.Bitmap.prototype.fontSize = size;
        }
}

/** Wrap a Reader so paths in the pack's imgFiles return decoded replacement images; others fall through. */
export function withLanguageImages(base: Reader, pack: LanguagePack): Reader {
        const entries = Object.entries(pack.imgFiles);
        if (!entries.length) return base;
        const cache = new Map<string, ArrayBuffer>();
        const decode = (key: string): ArrayBuffer | null => {
                const cached = cache.get(key);
                if (cached) return cached;
                try {
                        const bytes = decodeBase64(pack.imgFiles[key]);
                        cache.set(key, bytes);
                        return bytes;
                } catch { return null; }
        };
        return {
                async read(path: string): Promise<ArrayBuffer | null> {
                        const direct = pack.imgFiles[path];
                        if (direct) { const decoded = decode(path); if (decoded) return decoded; }
                        if (path) {
                                const noExt = path.replace(/\.[^/.]+$/, '');
                                const viaNoExt = pack.imgFiles[noExt];
                                if (viaNoExt) { const decoded = decode(noExt); if (decoded) return decoded; }
                        }
                        return base.read(path);
                },
        };
}

const TRANSLATE_NAMES: Record<string, string> = { lines: 'linesLUT', label: 'labelLUT', syslabel: 'sysLabel', sysmenus: 'sysMenus' };
const TRANSLATE_RE = /\((lines|label|sysLabel|sysMenus)\)\[([^\]]+)\]/gi;

export function translate(input: string, table: Language): string {
        if (input.indexOf('(') < 0) return input;
        return input.replace(TRANSLATE_RE, (whole, type: string, key: string) => {
                const value = table[TRANSLATE_NAMES[type.toLowerCase()]]?.[key];
                return Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : whole;
        });
}

/** Fonts are read from the game's own stylesheet and remain outside the NRO. */
export async function registerFonts(assets: Reader, runtime: any): Promise<void> {
        const file = await assets.read('fonts/gamefont.css');
        if (!file || !runtime.FontFace || !runtime.fonts?.add) return;
        const css = new TextDecoder().decode(file);
        for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
                const family = /font-family\s*:\s*["']?([^;"']+)/i.exec(block[1])?.[1].trim();
                const path = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(block[1])?.[1].trim();
                if (!family || !path || /^(?:[a-z]+:|\/)/i.test(path)) continue;
                const bytes = await assets.read(`fonts/${path}`);
                if (!bytes) continue;
                for (const face of [{}, { weight: 'bold' }, { style: 'italic' }, { style: 'italic', weight: 'bold' }]) {
                        runtime.fonts.add(new runtime.FontFace(family, bytes, face));
                }
        }
}

/** Wrap system text (terms, gameTitle, plugin constants) in translate() escape sequences so the language pack converts them. */
export function wrapSystemTerms(runtime: any, language: Language | null): void {
        if (!language) return;
        const sysMenus = language.sysMenus as Record<string, string | string[]> | undefined;
        const sysLabel = language.sysLabel as Record<string, string | string[]> | undefined;
        const OPTION_ALIASES: Record<string, string> = {
                'Always Dash': 'Run Always',
                'BGM Volume': 'Volume BGM',
                'SE Volume': 'Volume SFX',
        };
        const wrap = (value: unknown): unknown => {
                if (typeof value !== 'string' || !value) return value;
                if (value.startsWith('(')) return value;
                if (sysMenus && sysMenus[value] !== undefined) return `(sysMenus)[${value}]`;
                if (sysLabel && sysLabel[value] !== undefined) return `(sysLabel)[${value}]`;
                const alias = OPTION_ALIASES[value];
                if (alias && sysMenus && sysMenus[alias] !== undefined) return `(sysMenus)[${alias}]`;
                return value;
        };
        const wrapArray = (arr: unknown[] | undefined): void => {
                if (!Array.isArray(arr)) return;
                for (let i = 0; i < arr.length; i++) arr[i] = wrap(arr[i]);
        };
        const wrapObject = (obj: Record<string, unknown> | undefined): void => {
                if (!obj || typeof obj !== 'object') return;
                for (const key of Object.keys(obj)) obj[key] = wrap(obj[key]);
        };
        const system = runtime.$dataSystem;
        if (system?.terms) {
                wrapArray(system.terms.commands);
                wrapArray(system.terms.basic);
                wrapArray(system.terms.params);
                wrapObject(system.terms.messages);
        }
        if (typeof system?.gameTitle === 'string' && system.gameTitle && sysLabel && sysLabel['Game'] !== undefined && !system.gameTitle.startsWith('(')) {
                system.gameTitle = `(sysLabel)[Game]`;
        }
        if (system?.terms?.messages) {
                const msgs = system.terms.messages;
                if (typeof msgs.saveMessage === 'string' && msgs.saveMessage && !msgs.saveMessage.startsWith('(') && sysLabel && sysLabel['Save'] !== undefined) {
                        msgs.saveMessage = `(sysLabel)[Save]`;
                }
                if (typeof msgs.loadMessage === 'string' && msgs.loadMessage && !msgs.loadMessage.startsWith('(') && sysLabel && sysLabel['Load'] !== undefined) {
                        msgs.loadMessage = `(sysLabel)[Load]`;
                }
        }
        const galv = runtime.Galv?.CRED;
        if (galv && typeof galv.titleText === 'string') {
                const wrapped = wrap(galv.titleText);
                if (wrapped !== galv.titleText) {
                        try { galv.titleText = wrapped; }
                        catch { /* read-only; best-effort */ }
                }
        }
}

/** Install after plugins load, before window.onload starts the game. */
export function installGameCompatibility(runtime: any, root: string, sharedSaves: boolean, language: Language | null, pngFix = false, keyMap?: KeyMap) {
        const credits = runtime.Galv?.CRED;
        if (typeof credits?.start === 'function') {
                credits.start = () => {};
                const title = runtime.Scene_Title?.prototype;
                if (title && typeof title.commandCredits === 'function') title.commandCredits = function() {
                        runtime.SoundManager?.playBuzzer?.();
                        this._commandWindow?.activate?.();
                };
                const commands = runtime.Window_TitleCommand?.prototype;
                if (typeof commands?.makeCommandList === 'function') {
                        const make = commands.makeCommandList;
                        commands.makeCommandList = function() {
                                make.apply(this, arguments);
                                for (const command of this._list || []) if (command.symbol === 'credits') command.enabled = false;
                        };
                }
        }
        if (pngFix && typeof runtime.Decrypter?.createBlobUrl === 'function') {
                const original = runtime.Decrypter.createBlobUrl;
                runtime.Decrypter.createBlobUrl = function(bytes: ArrayBuffer) { return original.call(this, fixIndexedPng(bytes)); };
        }
        if (runtime.Input) {
                if (keyMap) applyKeyMap(runtime, keyMap);
                else runtime.Input.gamepadMapper = {
                        0: 'cancel', 1: 'ok', 2: 'shift', 3: 'menu', 4: 'pageup', 5: 'pagedown', 9: 'menu',
                        12: 'up', 13: 'down', 14: 'left', 15: 'right',
                };
        }
        const doc = runtime.document;
        if (doc && typeof screen?.addEventListener === 'function' && !(screen as any).__burialnxTouchForwarded) {
                (screen as any).__burialnxTouchForwarded = true;
                for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
                        screen.addEventListener(type, ((e: any) => {
                                const target = (globalThis as any).document;
                                if (!target) return;
                                if (e?.changedTouches) {
                                        for (const t of e.changedTouches) {
                                                if (t && t.pageX === undefined) { t.pageX = t.clientX; t.pageY = t.clientY; }
                                        }
                                }
                                try { target.dispatchEvent(e); } catch { /* best-effort */ }
                        }) as EventListener);
                }
        }
        const bitmap = runtime.Bitmap;
        if (bitmap?.prototype?._clearImgInstance) {
                const clear = bitmap.prototype._clearImgInstance;
                bitmap.prototype._clearImgInstance = function() {
                        const image = this._image;
                        if (this._loadListener) image?.removeEventListener?.('load', this._loadListener);
                        if (this._errorListener) image?.removeEventListener?.('error', this._errorListener);
                        const result = clear.apply(this, arguments);
                        const pool = bitmap._reuseImages;
                        if (Array.isArray(pool)) { const index = pool.indexOf(image); if (index >= 0) pool.splice(index, 1); }
                        return result;
                };
        }
        const layer = runtime.WindowLayer?.prototype;
        if (layer?.renderCanvas) {
                const render = layer.renderCanvas;
                layer.renderCanvas = function() {
                        const canvas = this._tempCanvas;
                        if (canvas) canvas.preserveSize = true;
                        try { return render.apply(this, arguments); }
                        finally { if (canvas) canvas.preserveSize = false; }
                };
        }
        const storage = runtime.StorageManager;
        if (!sharedSaves && typeof storage?.webStorageKey === 'function') {
                const original = storage.webStorageKey;
                storage.webStorageKey = function(...args: unknown[]) { return `NX:${encodeURIComponent(root.replace(/\/+$/, ''))}:` + original.apply(this, args); };
        }
        const manager = runtime.DataManager;
        try { wrapSystemTerms(runtime, language); } catch { /* best-effort */ }
        if (manager && typeof manager.onLoad === 'function' && !manager.__bnxTermsWrap) {
                const onLoad = manager.onLoad;
                manager.__bnxTermsWrap = true;
                manager.onLoad = function(data: any, name: string) {
                        const result = onLoad.apply(this, arguments);
                        if (name === '$dataSystem' || (data === runtime.$dataSystem && data?.terms)) {
                                try { wrapSystemTerms(runtime, language); }
                                catch { /* best-effort: untranslated text is not fatal */ }
                        }
                        return result;
                };
        }
        if (manager?.setupNewGame) {
                const setup = manager.setupNewGame;
                manager.setupNewGame = function() {
                        const result = setup.apply(this, arguments);
                        if (runtime.$dataSystem?.startMapId === 15 && runtime.$dataSystem.startX === 8 && runtime.$dataSystem.startY === 7) runtime.$gamePlayer?.setTransparent?.(true);
                        return result;
                };
        }
        if (manager && typeof manager.autoSave !== 'function') manager.autoSave = function() {
                try {
                        const data = runtime.JsonEx.stringify(this.makeSaveContents());
                        const SwitchAny = (globalThis as any).Switch;
                        const dir = 'sdmc:/switch/burialnx/autosaves';
                        try { SwitchAny?.mkdirSync?.(dir); } catch { /* dir may already exist */ }
                        const path = `${dir}/${encodeURIComponent(root)}.rpgsave`;
                        SwitchAny.writeFileSync(path, runtime.LZString.compressToBase64(data));
                        return true;
                } catch { return false; }
        };
        const dataManager = runtime.DataManager;
        if (dataManager && typeof dataManager.makeSaveContents === 'function' && !dataManager.__bnxSaveRollbackWrap) {
                const origMakeSaveContents = dataManager.makeSaveContents;
                dataManager.makeSaveContents = function() {
                        try {
                                const candidates = [];
                                if (runtime.$gameMap?._interpreter) candidates.push(runtime.$gameMap._interpreter);
                                if (runtime.$gameTroop?._interpreter) candidates.push(runtime.$gameTroop._interpreter);
                                for (const interp of candidates) rollbackInterpreterForMessageWait(interp, runtime);
                        } catch { /* best-effort — never block the save */ }
                        return origMakeSaveContents.apply(this, arguments);
                };
                dataManager.__bnxSaveRollbackWrap = true;
        }
        const WindowMessage = runtime.Window_Message?.prototype;
        const WindowBaseUpdate = runtime.Window_Base?.prototype?.update;
        if (WindowMessage && typeof WindowMessage.update === 'function' && !WindowMessage.__bnxUpdateWrap) {
                const origUpdate = WindowMessage.update;
                WindowMessage.update = function() {
                        const g = runtime as any;
                        if (g._bnxSuppressMessageStart && g._bnxSuppressMessageStart > 0) {
                                g._bnxSuppressMessageStart--;
                                if (typeof WindowBaseUpdate === 'function') WindowBaseUpdate.call(this);
                                return;
                        }
                        return origUpdate.apply(this, arguments);
                };
                WindowMessage.__bnxUpdateWrap = true;
        }
        const WindowProto = runtime.Window?.prototype;
        const contentsDesc = WindowProto ? Object.getOwnPropertyDescriptor(WindowProto, 'contents') : undefined;
        if (contentsDesc && !WindowProto.__bnxContentsWrap) {
                WindowProto.__bnxContentsWrap = true;
                Object.defineProperty(WindowProto, 'contents', {
                        get: function() {
                                if (!this._windowContentsSprite) {
                                        this._windowContentsSprite = new runtime.Sprite();
                                        this._windowContentsSprite.bitmap = new runtime.Bitmap(1, 1);
                                }
                                return this._windowContentsSprite.bitmap;
                        },
                        set: function(value: any) {
                                if (!this._windowContentsSprite) this._windowContentsSprite = new runtime.Sprite();
                                this._windowContentsSprite.bitmap = value;
                        },
                        configurable: true,
                });
        }
        const windowskinDesc = WindowProto && !WindowProto.__bnxWindowskinWrap ? Object.getOwnPropertyDescriptor(WindowProto, 'windowskin') : undefined;
        if (windowskinDesc && windowskinDesc.get) {
                WindowProto.__bnxWindowskinWrap = true;
                const origWindowskinGet = windowskinDesc.get;
                Object.defineProperty(WindowProto, 'windowskin', {
                        get: function() {
                                if (this._windowskin == null) {
                                        this._windowskin = new runtime.Bitmap(1, 1);
                                        try { this._windowskin = runtime.ImageManager?.loadSystem?.('Window') ?? this._windowskin; } catch { /* keep dummy */ }
                                }
                                return origWindowskinGet.call(this);
                        },
                        set: windowskinDesc.set,
                        configurable: true,
                });
        }
        if (language) {
                const message = runtime.Game_Message?.prototype;
                if (message) {
                        const add = message.add, choices = message.setChoices;
                        message.add = function(text: string) { return add.call(this, typeof text === 'string' ? translate(text, language) : text); };
                        message.setChoices = function(list: string[], ...rest: unknown[]) { return choices.call(this, list.map((s) => translate(s, language)), ...rest); };
                }
                for (const [prototype, method] of [[runtime.Window_Base?.prototype, 'convertEscapeCharacters'], [runtime.Bitmap?.prototype, 'drawText'], [runtime.Bitmap?.prototype, 'measureTextWidth']] as const) {
                        const original = prototype?.[method];
                        if (typeof original === 'function') prototype[method] = function(text: unknown, ...rest: unknown[]) {
                                return original.call(this, typeof text === 'string' ? translate(text, language) : text, ...rest);
                        };
                }
                const options = runtime.Window_Options?.prototype;
                if (options && typeof options.booleanStatusText === 'function') {
                        const langMenus = language.sysMenus as Record<string, string | string[]> | undefined;
                        options.booleanStatusText = function(value: boolean) {
                                const raw = value ? 'On' : 'Off';
                                return langMenus && langMenus[raw] !== undefined ? `(sysMenus)[${raw}]` : (value ? 'ON' : 'OFF');
                        };
                }
        }
        const audio = runtime.WebAudio;
        if (audio) {
                const NO_OP = () => {};
                const PANNING_MODEL_DESC = { get: () => 'equalpower', set: NO_OP, configurable: true };
                const makePanner = (context: any) => {
                        if (context && typeof context.createStereoPanner === 'function') {
                                try {
                                        const node = context.createStereoPanner();
                                        node.setPosition = (x: number, _y?: number, _z?: number) => {
                                                try { node.pan.setValueAtTime(Math.max(-1, Math.min(1, x)), context.currentTime); } catch { /* best-effort */ }
                                        };
                                        node.setVelocity = NO_OP;
                                        node.setOrientation = NO_OP;
                                        try { Object.defineProperty(node, 'panningModel', PANNING_MODEL_DESC); } catch { /* best-effort */ }
                                        return node;
                                } catch { /* createStereoPanner exists but throws — fall through */ }
                        }
                        const gain = context && typeof context.createGain === 'function'
                                ? context.createGain()
                                : { gain: { value: 1, setValueAtTime: NO_OP }, connect() { return this; }, disconnect() {} };
                        gain.setPosition = NO_OP;
                        gain.setVelocity = NO_OP;
                        gain.setOrientation = NO_OP;
                        try { Object.defineProperty(gain, 'panningModel', PANNING_MODEL_DESC); } catch { /* best-effort */ }
                        return gain;
                };
                const installPanner = (context: any) => {
                        if (context && !context.__bnxPannerInstalled) {
                                context.__bnxPannerInstalled = true;
                                context.createPanner = () => makePanner(context);
                        }
                };
                const create = audio._createContext;
                if (typeof create === 'function') {
                        audio._createContext = function() {
                                create.call(this);
                                if (this._context) installPanner(this._context);
                        };
                }
                if (audio._context) installPanner(audio._context);
                const proto = audio.prototype;
                if (proto?._createNodes) {
                        const origCreateNodes = proto._createNodes;
                        proto._createNodes = function() {
                                const ctx = audio._context;
                                if (ctx) installPanner(ctx);
                                return origCreateNodes.apply(this, arguments);
                        };
                }
                audio.prototype._onXhrLoad = function(xhr: any) {
                        try {
                                const bytes = runtime.Decrypter?.hasEncryptedAudio ? runtime.Decrypter.decryptArrayBuffer(xhr.response) : xhr.response;
                                this._readLoopComments(new Uint8Array(bytes));
                                Promise.resolve(audio._context.decodeAudioData(bytes)).then((buffer: any) => {
                                        this._buffer = buffer; this._totalTime = buffer.duration;
                                        if (this._loopLength > 0 && this._sampleRate > 0) { this._loopStart /= this._sampleRate; this._loopLength /= this._sampleRate; }
                                        else { this._loopStart = 0; this._loopLength = buffer.duration; }
                                        this._onLoad();
                                }, () => { this._hasError = true; });
                        } catch { this._hasError = true; }
                };
        }
        const nameBox = runtime.Window_NameBox?.prototype;
        if (nameBox?.adjustPositionY) {
                const adjust = nameBox.adjustPositionY;
                nameBox.adjustPositionY = function() {
                        adjust.apply(this, arguments);
                        const parent = this._parentWindow;
                        if (parent && this.y < parent.y + parent.height && this.y + this.height > parent.y) {
                                const above = parent.y + (parent.padding || 0) - (this.padding || 0) - (this.lineHeight?.() || this.height) - 4;
                                if (above >= 0) this.y = above;
                        }
                        this._burialOffset = 0;
                };
        }
        const message = runtime.Window_Message?.prototype;
        if (message?.newPage) {
                const original = message.newPage;
                message.newPage = function(state: any) {
                        const result = original.call(this, state);
                        if (runtime.$gameMessage?.positionType?.() === 2 && typeof state?.text === 'string') {
                                const page = state.text.slice(state.index || 0).split('\f')[0];
                                const spare = Math.max(0, (this.contents?.height || 0) - state.height * page.split('\n').length);
                                const shift = Math.min(36, spare);
                                state.y += shift;
                                if (this._nameWindow?.active) { this._nameWindow.y += shift - (this._nameWindow._burialOffset || 0); this._nameWindow._burialOffset = shift; }
                        } else if (runtime.$gameMessage?.positionType?.() === 1 && !this._nameWindow?.active && typeof state?.text === 'string') {
                                const page = state.text.slice(state.index || 0).split('\f')[0].replace(/\n+$/, '');
                                const height = state.height * Math.max(1, page.split('\n').length);
                                state.y += interactionTextY(this.contents?.height, height, 0);
                        }
                        return result;
                };
        }
}
