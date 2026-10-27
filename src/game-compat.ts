import type { Reader } from './library';
import type { KeyMap } from './keymap';
import { applyKeyMap } from './keymap';
import { interactionTextY } from './dialogue';
import { fixIndexedPng } from './indexed-png';

/**
 * Two desktop-only plugins cannot run on nx.js. Use MV audio instead of the
 * streaming Worker, and omit only the appended Node payload from the region
 * plugin. The region collision rules themselves must remain enabled.
 *
 * Additionally, the top-level `'use strict'` directive is stripped from every
 * script. BurialNX evaluates game scripts via indirect eval `(0, eval)(...)`,
 * which runs in the global scope. Under strict mode, indirect eval does NOT
 * leak `var`/`function` declarations to the global object — so a plugin that
 * declares `function Game_EnemyEvent() {}` under `'use strict'` would NOT
 * expose `Game_EnemyEvent` as a global, and subsequent plugins referencing it
 * would throw `ReferenceError: Game_EnemyEvent is not defined`. In a browser
 * `<script>` tag, top-level declarations become global even under strict mode
 * (a special case for script-tag evaluation). Stripping the directive makes
 * indirect eval run in sloppy mode, matching that behavior. Only the top-level
 * directive prologue is stripped; `'use strict'` inside function bodies (which
 * affects those functions' semantics) is preserved.
 */
export function prepareGameScript(path: string, source: string): string | null {
        if (path.endsWith('/AudioStreaming.js')) return null;
        if (path.endsWith('/YEP_RegionRestrictions.js') && source.includes("'zlib'") && source.includes('Buffer[')) {
                // Keep the code before the single-line desktop bootstrap. Depending on
                // the game build it closes a method or initializes the RR namespace.
                // Reject unfamiliar layouts rather than deleting real plugin code.
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
        // Strip the top-level 'use strict' directive so indirect eval runs in
        // sloppy mode and function/var declarations become global (like a
        // <script> tag). See the function-level comment above for the full
        // rationale. Only the directive prologue (before any real code) is
        // stripped; function-body 'use strict' directives are preserved.
        source = stripTopLevelUseStrict(source);
        return source;
}

/**
 * Remove the top-level `'use strict'` / `"use strict"` directive prologue
 * from a script source. The directive is only stripped when it appears as the
 * first actual statement (after optional comments and whitespace). Directives
 * inside function bodies are left intact because they affect those functions'
 * runtime semantics (e.g. `this` binding, assignment to undeclared variables).
 *
 * Uses a single-pass line scan (O(n)) rather than a regex to avoid
 * catastrophic backtracking on large files like rpg_core.js (240+ KiB).
 */
export function stripTopLevelUseStrict(source: string): string {
        const lines = source.split('\n');
        let inBlockComment = false;
        for (let i = 0; i < lines.length; i++) {
                let line = lines[i];
                if (inBlockComment) {
                        const end = line.indexOf('*/');
                        if (end >= 0) { inBlockComment = false; line = line.slice(end + 2); }
                        else continue; // still inside a multi-line block comment
                }
                // Strip any remaining inline block comments on this line (non-nested).
                let rest = line;
                for (;;) {
                        const start = rest.indexOf('/*');
                        if (start < 0) break;
                        const end = rest.indexOf('*/', start + 2);
                        if (end < 0) { inBlockComment = true; rest = rest.slice(0, start); break; }
                        rest = rest.slice(0, start) + rest.slice(end + 2);
                }
                // Strip line comments.
                const commentIdx = rest.indexOf('//');
                if (commentIdx >= 0) rest = rest.slice(0, commentIdx);
                const trimmed = rest.trim();
                if (!trimmed) continue; // whitespace or comment-only line
                // First real code line — check if it's a 'use strict' directive.
                const m = /^(['"])use strict\1;?$/.exec(trimmed);
                if (m) { lines.splice(i, 1); return lines.join('\n'); }
                // First real code is something else — no top-level 'use strict' to strip.
                return source;
        }
        return source;
}

type Language = Record<string, Record<string, string | string[]>>;

/**
 * A fully-decoded language pack. The base `Language` type holds the translation
 * tables used by translate(); this wrapper carries the extra metadata embedded
 * in a `.cld` pack (font + translated images) so the loader can register them.
 */
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
        // Extract the tables translate() actually reads; keep the rest as raw metadata.
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

/**
 * Load the default (English) language table. Kept for backward compatibility with
 * tests and callers that only need the translation tables. Prefer loadLanguagePack().
 */
export async function languageTable(assets: Reader): Promise<Language | null> {
        const data = await assets.read(DEFAULT_LANGUAGE_PATH);
        if (!data) return null;
        return parseLanguagePack(data, null).table;
}

/**
 * Load a language pack from a `.cld` file. Falls back to the default English data
 * embedded in data/ when the requested pack cannot be read. Always returns a pack
 * (never null) when the default exists; returns null only if neither the requested
 * pack nor the default could be read.
 */
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

/**
 * Scan the `languages/` folder (and one level above the www root as a fallback)
 * for `.cld` language packs. Returns entries sorted by code. The www-relative
 * path is preferred because RPG Maker MV games ship languages there; the parent
 * folder is checked because some builds place `languages/` next to the exe.
 */
export function scanLanguageFiles(fs: LanguageScanFs | null, gameRoot: string): LanguageEntry[] {
        if (!fs?.readDirSync) return [];
        const clean = gameRoot.replace(/\/+$/, '');
        // The game root is the www folder. languages/ may be inside it, or one level up.
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
                        // For in-www languages, path is a relative asset path the Reader accepts.
                        // For parent-folder languages, path is null (assetPath rejects `..`); callers read via absPath.
                        const path = parent ? null : `${relBase}/${name}`;
                        const absPath = `${dir}/${name}`;
                        entries.push({ path, absPath, code, name: code });
                }
        }
        // Sort by code for deterministic ordering. 'ru' (Russian) is the primary
        // target language for this game; keep it first if present.
        entries.sort((a, b) => (a.code === 'ru' ? -1 : b.code === 'ru' ? 1 : a.code.localeCompare(b.code)));
        return entries;
}

/**
 * Best-effort lookup of a human-readable name for a language pack by peeking at
 * its `langName` field. Used so the scan results can show 'Русский' instead of 'ru'.
 * Falls back to the code if the pack can't be read or parsed.
 */
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
        // Use atob when available (Switch runtime + tests); fall back to manual decode.
        const clean = base64.replace(/\s+/g, '');
        if (typeof atob === 'function') {
                const binary = atob(clean);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return bytes.buffer;
        }
        // Manual decode path (no atob).
        const lookup = new Int8Array(128).fill(-1);
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
        const out: number[] = [];
        let buffer = 0, bits = 0;
        for (let i = 0; i < clean.length; i++) {
                const c = clean.charCodeAt(i);
                if (c >= 128) continue;
                const v = lookup[c];
                if (v < 0) { if (c === 61 /* = */) break; continue; }
                buffer = (buffer << 6) | v;
                bits += 6;
                if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 0xff); }
        }
        return new Uint8Array(out).buffer;
}

/**
 * Register the font embedded in a language pack (if any) and override RPG Maker
 * MV's font selection so the game actually uses it. The .cld's fontFile is a
 * base64-encoded TTF/OTF/WOFF; we decode it, create a FontFace, and add it to the
 * runtime font set. We also override Window_Base.standardFontFace and
 * standardFontSize (and Yanfly's YEP_CoreEngine override of the same) so every
 * window and bitmap draws with this language's font instead of GameFont.
 *
 * Registers ALL 4 variants (normal, bold, italic, bold-italic) — same as
 * registerFonts — so the game can render bold/italic text in the language font.
 * Without all 4 variants, bold/italic text falls back to GameFont which has
 * no Cyrillic glyphs → empty/blank dialogue lines.
 */
export async function registerLanguageFont(runtime: any, pack: LanguagePack): Promise<void> {
        const face = pack.fontFace;
        const size = pack.fontSize;
        if (face && pack.fontFile) {
                try {
                        const bytes = decodeBase64(pack.fontFile);
                        if (runtime.FontFace && runtime.fonts?.add) {
                                // Register ALL 4 variants (normal, bold, italic, bold-italic)
                                // — same pattern as registerFonts. Without bold/italic variants,
                                // the game falls back to GameFont for bold/italic text, which
                                // has no Cyrillic glyphs → empty lines for Russian dialogue.
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
                // Yanfly's YEP_CoreEngine replaces standardFontFace to read Yanfly.Param.DefaultFont.
                // Override that parameter so the YEP path also picks up the language font.
                if (runtime.Yanfly?.Param) runtime.Yanfly.Param.DefaultFont = face;
                // YEP_MessageCore has its OWN font system for dialogue windows:
                // it overrides standardFontFace for Window_Message, Window_ChoiceList,
                // and Window_NameBox to return $gameSystem.getMessageFontName() which
                // reads from Yanfly.Param.MSGFontName (= "GameFont"). Without overriding
                // these, dialogue text uses GameFont (no Cyrillic glyphs) → empty lines.
                // Fix: override the YEP message font parameters AND the message window
                // prototypes' standardFontFace directly.
                if (runtime.Yanfly?.Param) {
                        runtime.Yanfly.Param.MSGFontName = face;
                        runtime.Yanfly.Param.MSGCNFontName = face;
                        runtime.Yanfly.Param.MSGKRFontName = face;
                }
                for (const proto of [runtime.Window_Message?.prototype, runtime.Window_ChoiceList?.prototype, runtime.Window_NameBox?.prototype]) {
                        if (proto) proto.standardFontFace = function() { return face; };
                }
                // Graphics.fontFace is the Bitmap default; set it so raw Bitmap draws match.
                if (runtime.Graphics) runtime.Graphics.fontFace = face;
                // Bitmap's constructor default is 'GameFont'; update the prototype property too.
                if (runtime.Bitmap?.prototype) runtime.Bitmap.prototype.fontFace = face;
        }
        if (size) {
                const base = runtime.Window_Base?.prototype;
                if (base && typeof base.standardFontSize === 'function') {
                        base.standardFontSize = function() { return size; };
                }
                if (runtime.Yanfly?.Param) {
                        runtime.Yanfly.Param.FontSize = size;
                        // Override message font size too (YEP_MessageCore uses MSGFontSize).
                        runtime.Yanfly.Param.MSGFontSize = size;
                }
                if (runtime.Bitmap?.prototype) runtime.Bitmap.prototype.fontSize = size;
        }
}

/**
 * Wrap a Reader so that paths listed in the language pack's `imgFiles` return the
 * base64-decoded replacement image instead of reading from disk. This applies
 * translated parallaxes, title art, and any other localized images. Paths not in
 * the pack fall through to the base reader unchanged.
 */
export function withLanguageImages(base: Reader, pack: LanguagePack): Reader {
        const entries = Object.entries(pack.imgFiles);
        if (!entries.length) return base;
        // Pre-decode images lazily (the Russian pack has 44 images; decoding all
        // upfront would spike memory). Cache the decoded buffer per path.
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
                        // imgFiles keys may omit extensions or use a hashed path that the
                        // request normalizes; try a few close matches.
                        if (path) {
                                const noExt = path.replace(/\.[^/.]+$/, '');
                                const viaNoExt = pack.imgFiles[noExt];
                                if (viaNoExt) { const decoded = decode(noExt); if (decoded) return decoded; }
                        }
                        return base.read(path);
                },
        };
}

// Hoisted constants for translate() — avoid per-call allocation of the names
// object and the regex. The fast path (no '(' in input) skips the regex
// entirely for ~95% of drawText calls, which is the common case for games
// without language packs or for text that doesn't use escape sequences.
const TRANSLATE_NAMES: Record<string, string> = { lines: 'linesLUT', label: 'labelLUT', syslabel: 'sysLabel', sysmenus: 'sysMenus' };
const TRANSLATE_RE = /\((lines|label|sysLabel|sysMenus)\)\[([^\]]+)\]/gi;

export function translate(input: string, table: Language): string {
        // Fast path: if there's no '(' character, the escape-sequence regex can't
        // match anything — return the input unchanged without allocating regex
        // state or a callback closure.
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

/**
 * Wrap the game's plain-English system text (terms, plugin title strings) in
 * translate() escape sequences so the loaded language pack can convert them.
 *
 * The game's $dataSystem.terms (commands, basic, params, messages) and plugin
 * constants (e.g. Galv.CRED.titleText = "Credits") hold raw English strings.
 * The .cld's sysMenus/sysLabel tables map those English keys to translations,
 * but translate() only fires on `(sysMenus)[key]` / `(sysLabel)[key]` escape
 * sequences. On PC the game's obfuscated language loader wraps these strings;
 * BurialNX replicates that by wrapping every term that has a matching table key.
 *
 * Only strings whose value EXACTLY matches a table key are wrapped, so terms
 * without a translation are left untouched (no ugly "(sysMenus)[...]" shown).
 *
 * This must run AFTER $dataSystem is loaded (DataManager.onLoad) and AFTER any
 * plugin that sets title-text constants (i.e. after all scripts are evaluated).
 */
export function wrapSystemTerms(runtime: any, language: Language | null): void {
        if (!language) return;
        const sysMenus = language.sysMenus as Record<string, string | string[]> | undefined;
        const sysLabel = language.sysLabel as Record<string, string | string[]> | undefined;
        // The .cld's sysMenus keys don't always match the game's standard RPG Maker
        // MV text. For example, the game's option label is "Always Dash" but the .cld
        // uses "Run Always". This map bridges the gap: when a game string has no
        // direct sysMenus/sysLabel key, check if a known alias exists.
        const OPTION_ALIASES: Record<string, string> = {
                'Always Dash': 'Run Always',
                'BGM Volume': 'Volume BGM',
                'SE Volume': 'Volume SFX',
        };
        const wrap = (value: unknown): unknown => {
                if (typeof value !== 'string' || !value) return value;
                if (value.startsWith('(')) return value; // already wrapped
                if (sysMenus && sysMenus[value] !== undefined) return `(sysMenus)[${value}]`;
                if (sysLabel && sysLabel[value] !== undefined) return `(sysLabel)[${value}]`;
                // Try alias mapping: "Always Dash" → check sysMenus["Run Always"]
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
        // 1. $dataSystem.terms (commands, basic, params, messages) — the main
        //    source of menu/window text in RPG Maker MV.
        const system = runtime.$dataSystem;
        if (system?.terms) {
                wrapArray(system.terms.commands);
                wrapArray(system.terms.basic);
                wrapArray(system.terms.params);
                wrapObject(system.terms.messages);
        }
        // 2. $dataSystem.gameTitle — the .cld's sysLabel['Game'] holds the translated
        //    game title (e.g. "Гроб для Энди и Лейли"). The English gameTitle is NOT the
        //    key "Game"; the game's own language loader maps gameTitle → sysLabel['Game'].
        //    Replicate that by wrapping the title in (sysLabel)[Game] unconditionally.
        if (typeof system?.gameTitle === 'string' && system.gameTitle && sysLabel && sysLabel['Game'] !== undefined && !system.gameTitle.startsWith('(')) {
                system.gameTitle = `(sysLabel)[Game]`;
        }
        // 3. The save/load prompts. The game's terms.messages.saveMessage is
        //    "Save to which file?" but the .cld's sysLabel['Save'] = "Какой файл
        //    перезаписать?" — the key 'Save' maps to the save prompt, not the raw
        //    message text. Map them explicitly (same for Load).
        if (system?.terms?.messages) {
                const msgs = system.terms.messages;
                if (typeof msgs.saveMessage === 'string' && msgs.saveMessage && !msgs.saveMessage.startsWith('(') && sysLabel && sysLabel['Save'] !== undefined) {
                        msgs.saveMessage = `(sysLabel)[Save]`;
                }
                if (typeof msgs.loadMessage === 'string' && msgs.loadMessage && !msgs.loadMessage.startsWith('(') && sysLabel && sysLabel['Load'] !== undefined) {
                        msgs.loadMessage = `(sysLabel)[Load]`;
                }
        }
        // 4. Plugin title-text constants. Galv.CRED.titleText = "Credits" → sysMenus['Credits'].
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
        // The bundled credits scene is currently unreliable on nx.js. Keep its
        // title entry visible but disabled and make event-script calls harmless.
        // Remove this guard only after the credits scene is tested on hardware.
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
        // Forward screen touch events to document for RPG Maker MV's TouchInput.
        // nx.js dispatches 'touchstart'/'touchmove'/'touchend' on the `screen`
        // global. RPG Maker MV's TouchInput listens on `document`. Without
        // forwarding, touch/tap interactions in the game don't work.
        // The listeners are installed ONCE per process: each new launch
        // replaces globalThis.document with a fresh one, so the handler
        // resolves the current document at event time instead of closing over
        // the document of the first launch (which would send the second
        // game's touches to a dead document, and stack a listener set per
        // launch on the shared screen object).
        const doc = runtime.document;
        if (doc && typeof screen?.addEventListener === 'function' && !(screen as any).__burialnxTouchForwarded) {
                (screen as any).__burialnxTouchForwarded = true;
                for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
                        screen.addEventListener(type, ((e: any) => {
                                const target = (globalThis as any).document;
                                if (!target) return;
                                // RPG Maker MV's TouchInput uses touch.pageX/pageY.
                                // nx.js touch events have clientX/clientY but not pageX/pageY.
                                // Add them as aliases so the game can read them.
                                if (e?.changedTouches) {
                                        for (const t of e.changedTouches) {
                                                if (t && t.pageX === undefined) { t.pageX = t.clientX; t.pageY = t.clientY; }
                                        }
                                }
                                try { target.dispatchEvent(e); } catch { /* best-effort */ }
                        }) as EventListener);
                }
        }
        // MV normally keeps a pool of Image objects. Native images can retain their
        // pixel buffers and bound listeners, so release those references on cleanup.
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
        // WindowLayer explicitly clears its temporary canvas each frame. Avoid
        // repeatedly allocating a same-sized native surface for that one canvas.
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
        // The game's skipped desktop helper provides autoSave(). Keep its recovery
        // snapshot separate from ordinary slots so it cannot overwrite the player.
        const manager = runtime.DataManager;
        // Wrap the game's system text (terms, gameTitle, plugin constants) in
        // translate() escape sequences so the loaded language pack can convert
        // the title-menu commands, item/skill names, save/load prompts, etc.
        // This runs once now (for plugin constants like Galv.CRED.titleText that
        // were set during script evaluation) and again when $dataSystem loads.
        // Wrapped in try/catch so a translation failure never crashes the game.
        try { wrapSystemTerms(runtime, language); } catch { /* best-effort */ }
        if (manager && typeof manager.onLoad === 'function' && !manager.__bnxTermsWrap) {
                const onLoad = manager.onLoad;
                manager.__bnxTermsWrap = true;
                manager.onLoad = function(data: any, name: string) {
                        const result = onLoad.apply(this, arguments);
                        // $dataSystem carries the terms (commands/basic/params/messages)
                        // and gameTitle. Wrap them now so the title-menu and every window
                        // that reads TextManager sees the escape sequences translate() hooks.
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
                        // This game's intro card uses this known starting position and its
                        // first transfer makes the player visible again.
                        if (runtime.$dataSystem?.startMapId === 15 && runtime.$dataSystem.startX === 8 && runtime.$dataSystem.startY === 7) runtime.$gamePlayer?.setTransparent?.(true);
                        return result;
                };
        }
        if (manager && typeof manager.autoSave !== 'function') manager.autoSave = function() {
                try {
                        const data = runtime.JsonEx.stringify(this.makeSaveContents());
                        // Do not overwrite recovery snapshots made by the previous loader.
                        runtime.localStorage.setItem(`BurialNX Autosave:${encodeURIComponent(root)}`, runtime.LZString.compressToBase64(data));
                        return true;
                } catch { return false; }
        };
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
                // RPG Maker MV's Window_Options.booleanStatusText returns 'ON'/'OFF'
                // (hardcoded uppercase). The .cld's sysMenus has 'On'/'Off' keys → wrap
                // them in escape sequences so translate() converts them (e.g. 'ON' →
                // '(sysMenus)[On]' → 'Вкл.'). The translate() hook on drawText then
                // converts them when the option status is drawn.
                const options = runtime.Window_Options?.prototype;
                if (options && typeof options.booleanStatusText === 'function') {
                        const langMenus = language.sysMenus as Record<string, string | string[]> | undefined;
                        options.booleanStatusText = function(value: boolean) {
                                const raw = value ? 'On' : 'Off';
                                return langMenus && langMenus[raw] !== undefined ? `(sysMenus)[${raw}]` : (value ? 'ON' : 'OFF');
                        };
                }
        }
        // RPG Maker MV's WebAudio._createNodes calls context.createPanner() for
        // every audio source. nx.js's AudioContext does NOT implement createPanner
        // (it throws "Method not implemented."). The context may be created DURING
        // SCRIPT LOADING (the WebAudio constructor calls WebAudio.initialize() →
        // _createContext() the first time `new WebAudio(url)` runs), which is
        // BEFORE installGameCompatibility runs. So patching _createContext alone
        // is too late. Instead, patch _createNodes (the instance method that
        // actually calls createPanner) to ensure createPanner is overridden on
        // the context right before it's used — regardless of when the context
        // was created.
        const audio = runtime.WebAudio;
        if (audio) {
                // Shared no-op closures (hoisted to avoid per-panner allocation).
                const NO_OP = () => {};
                const PANNING_MODEL_DESC = { get: () => 'equalpower', set: NO_OP, configurable: true };
                // Helper: create a working panner node replacement.
                const makePanner = (context: any) => {
                        if (context && typeof context.createStereoPanner === 'function') {
                                try {
                                        const node = context.createStereoPanner();
                                        // MV calls setPosition(x, y, z) with 3 args; StereoPanner only
                                        // takes pan (-1..1). Use x as pan, ignore y/z.
                                        node.setPosition = (x: number, _y?: number, _z?: number) => {
                                                try { node.pan.setValueAtTime(Math.max(-1, Math.min(1, x)), context.currentTime); } catch { /* best-effort */ }
                                        };
                                        node.setVelocity = NO_OP;
                                        node.setOrientation = NO_OP;
                                        // panningModel is a PannerNode property; StereoPanner doesn't
                                        // have it. Make it a no-op setter so MV's assignment doesn't throw.
                                        try { Object.defineProperty(node, 'panningModel', PANNING_MODEL_DESC); } catch { /* best-effort */ }
                                        return node;
                                } catch { /* createStereoPanner exists but throws — fall through */ }
                        }
                        // Fallback: a GainNode that accepts setPosition() but
                        // ignores it. Audio passes through without panning.
                        const gain = context && typeof context.createGain === 'function'
                                ? context.createGain()
                                : { gain: { value: 1, setValueAtTime: NO_OP }, connect() { return this; }, disconnect() {} };
                        gain.setPosition = NO_OP;
                        gain.setVelocity = NO_OP;
                        gain.setOrientation = NO_OP;
                        try { Object.defineProperty(gain, 'panningModel', PANNING_MODEL_DESC); } catch { /* best-effort */ }
                        return gain;
                };
                // Install createPanner override on a context (once). The closure
                // captures `context` so it can be shared across all audio sources
                // that use that context — no per-source allocation.
                const installPanner = (context: any) => {
                        if (context && !context.__bnxPannerInstalled) {
                                context.__bnxPannerInstalled = true;
                                context.createPanner = () => makePanner(context);
                        }
                };
                // Patch _createContext (for contexts created after this point).
                const create = audio._createContext;
                if (typeof create === 'function') {
                        audio._createContext = function() {
                                create.call(this);
                                if (this._context) installPanner(this._context);
                        };
                }
                // ALSO patch the existing context if it was already created.
                if (audio._context) installPanner(audio._context);
                // CRITICAL: Patch _createNodes (instance method) to ensure
                // createPanner is overridden on the context right before it's
                // called. This catches the case where the context was created
                // during script loading (before installGameCompatibility).
                // installPanner() is idempotent (checks __bnxPannerInstalled),
                // so calling it per-source is cheap — no closure allocation.
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
        // Anonymous center-screen interaction text has excess empty space in MV.
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
