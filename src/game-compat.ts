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

export async function languageTable(assets: Reader): Promise<Language | null> {
        const data = await assets.read('data/9c7050ae76645487');
        if (!data) return null;
        const text = new TextDecoder().decode(data);
        if (!text.startsWith('LANGDATA')) throw new Error('Unsupported language data');
        return JSON.parse(text.slice(8));
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
