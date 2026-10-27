import { FolderBrowser } from './folders';
import { gameAssets } from './game-assets';
import type { Reader } from './library';
import { scriptPlan, startGame } from './runtime-plan';
import { createBrowserHost } from './browser-host';
import { installGameCompatibility, languageTable, prepareGameScript, registerFonts, loadLanguagePack, registerLanguageFont, withLanguageImages, scanLanguageFiles, resolveLanguageName, parseLanguagePack, wrapSystemTerms, type LanguagePack, type LanguageEntry, type LanguageScanFs } from './game-compat';
import { installNodeCompat, type SwitchFs } from './node-compat';
import { PauseMenu } from './menu';
import { gameSaveFolders, parseSelection, startupSelection, type GameSelection, type SaveLocation } from './settings';
import { needsPngFix } from './indexed-png';
import { ensureGameSaveFolder, hasSteamSaveData, importSteamSaves, installSdSaves, safeGameSaveFolder, safeSaveFolder } from './saves';
import { installMapPrefetch, MapPrefetcher } from './map-prefetch';
import { entryFromSelection, libraryIdFromRoot, loadLibrary, markPlayed, moveGame, removeGame, toSelection, upsertGame, type LibraryEntry, type LibraryFile, type LibraryAccess } from './game-library';
import { BUTTON_NAMES, DEFAULT_KEYMAP, applyKeyMap, loadKeyMap, PRESETS, saveKeyMap, setButton, setButtonWithLabel, VIRTUAL_KEYS, type KeyMap, type VirtualKey } from './keymap';
import { COVERS_DIR, coverPathFor, deriveDefaultCover, saveUserCover, saveUserCoverLogged } from './cover';
import { buildForwarder, deleteForwarder, forwarderExists, forwarderPathFor, forwarderDirFor, renameForwarder, sanitizeGameName, BURIALNX_NRO_PATH, BURIALNX_DEBUG_NRO_PATH } from './forwarder';

declare const __DEBUG__: boolean;
// Baked-in forwarder game id. For the main burialnx.nro, this is a 64-'0'
// placeholder string. When burialnx builds a forwarder, it patches this
// placeholder in the romfs with the target game's id (padded to 64 chars).
// At startup, if the value is NOT all zeros, this IS a forwarder NRO — no
// chain-loading was used (no envSetNextLoad), so quitting is a clean
// Switch.exit() → hbmenu.
declare const __FORWARDER_GAME_ID__: string;
// Baked-in mod-forced flag. "MODFORCED_0" (off) or "MODFORCED_1" (on).
// Patched by the forwarder builder when the game's mod is enabled.
declare const __FORWARDER_MOD_FORCED__: string;
const debugLines: string[] = [];
const runtime = globalThis as any;
const settingsPath = 'sdmc:/switch/burialnx/settings.json';
const logsPath = 'sdmc:/switch/burialnx/LOGS';
// Each app launch gets its own numbered log file: native-host_1.log,
// native-host_2.log, … so the user can attach the log from a specific
// session without it being overwritten by a later one. The number is
// derived by scanning the LOGS directory for the highest existing N.
// Falls back to the legacy single-file path if the directory can't be
// scanned (e.g. SD read error).
function pickLogPath(): string {
        try {
                (Switch as any).mkdirSync?.(logsPath);
                let maxN = 0;
                const entries = (Switch as any).readDirSync?.(`${logsPath}/`) as string[] | null;
                if (entries) {
                        for (const name of entries) {
                                const m = /^native-host_(\d+)\.log$/i.exec(name || '');
                                if (m) { const n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
                        }
                }
                return `${logsPath}/native-host_${maxN + 1}.log`;
        } catch { return `${logsPath}/native-host.log`; }
}
const hostLogPath = pickLogPath();
// Start diagnostics before accessing the screen or enumerating the SD card.
try { (Switch as any).mkdirSync?.('sdmc:/switch/burialnx'); } catch { /* report write failures later */ }
if (__DEBUG__) {
        try { (Switch as any).mkdirSync?.(logsPath); } catch { /* diagnostics are optional */ }
        log(`--- BurialNX debug session ${new Date().toISOString()} ---`);
        log(`Log file: ${hostLogPath}`);
        log('Initializing screen');
}
// Numbered checkpoint logs so a crash leaves a clear trail of which step
// succeeded last. The user can then share the log and we know exactly where
// to look. Format: `_N: <step>` with N incrementing across the whole init.
let ctx: CanvasRenderingContext2D | null = null;
try {
        ctx = screen.getContext('2d');
        log(`_2: screen.getContext returned ${ctx ? 'a context' : 'null'}`);
} catch (error) {
        log(`_2: screen.getContext threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
}

// === Splash + fatal-error helpers ======================================
// Drawn before any other init so the user sees immediate feedback that the
// loader is alive. If a later step throws during module evaluation, fatal()
// replaces the splash with the error so the user is never stuck on a black
// screen with no diagnostic.
function drawSplash(text: string) {
        if (!ctx) return;
        try {
                ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = '#161823'; ctx.fillRect(0, 0, screen.width, screen.height);
                ctx.fillStyle = '#f4f3ef'; ctx.font = '26px sans-serif';
                ctx.fillText('BurialNX', 28, 40);
                ctx.font = '20px sans-serif'; ctx.fillStyle = '#9aa0b4';
                ctx.fillText(text, 28, 80);
                ctx.restore();
        } catch (error) { log(`_splash: drawSplash failed: ${error instanceof Error ? error.message : String(error)}`); }
}
function fatal(error: unknown) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
        try { (Switch as any).appendFileSync?.(hostLogPath, `FATAL: ${detail}\n`); } catch { /* optional */ }
        if (!ctx) { try { (Switch as any).appendFileSync?.(hostLogPath, `FATAL(no-ctx): ${detail}\n`); } catch {} return; }
        try {
                ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = '#161823'; ctx.fillRect(0, 0, screen.width, screen.height);
                ctx.fillStyle = '#f4f3ef'; ctx.font = '24px sans-serif';
                ctx.fillText('BurialNX — fatal error', 28, 50);
                ctx.font = '18px sans-serif'; ctx.fillStyle = '#ff6b6b';
                const maxW = screen.width - 56;
                const words = detail.split(/(\s+)/);
                let line = '', y = 90;
                for (const word of words) {
                        const test = line + word;
                        if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, 28, y); y += 28; line = word.trimStart(); }
                        else line = test;
                }
                if (line) { ctx.fillText(line, 28, y); y += 28; }
                if (__DEBUG__) { y += 8; ctx.fillStyle = '#9aa0b4'; ctx.fillText(`Details: ${hostLogPath}`, 28, y); }
                ctx.restore();
        } catch { /* nothing more we can do */ }
}
drawSplash('Loading…');

// === Switch user selection (standard system flow) ======================
// nx.js shows the system profile selector lazily from the localStorage
// getter: without this, the "select a user" dialog pops up only when the
// first launched game touches its saves — in the middle of the session.
// Touching localStorage here selects the Switch user and mounts the
// application's save data once, at application startup, before the library
// appears — the same point where retail Switch games ask for the profile.
// Title-override launches already carry a preselected user, so normally no
// dialog appears at all; Album/applet launches get the standard selector.
try {
        const storage = (globalThis as any).localStorage;
        if (storage) { void storage.length; log('_3: save data mounted for the selected user at startup'); }
        else log('_3: no user save data available (localStorage disabled)');
} catch (error) { log(`_3: user selection/save mount failed: ${error instanceof Error ? error.message : String(error)}`); }
// Log how much memory the runtime actually granted (the nxjs.ini
// [memory] heap_limit request) so debug logs prove the heap budget.
if (__DEBUG__) try {
        const memory = (Switch as any).memoryUsage?.();
        if (memory) log(`_4: V8 heap limit=${Math.round(memory.heapSizeLimit / 1048576)} MiB, native heap=${Math.round(memory.nativeHeapTotal / 1048576)} MiB`);
} catch { /* memory diagnostics are optional */ }

const menu = new PauseMenu(__DEBUG__);

if (__DEBUG__) log('Reading SD card folders');
let browser = new FolderBrowser(Switch, 'game');
let selectedGame: string | undefined;
let selectedMod: string | null | undefined;
let sharedSaves = false;
// Languages discovered for the currently-selected game (scanned at launch).
// Empty when no .cld packs are present; the game then uses the default English
// data embedded in data/. The user's choice is persisted per-game in the
// LIBRARY FILE (sdmc:/switch/burialnx/library.json), NOT localStorage, so it
// works in forwarder NROs which have saveData=0 (localStorage unavailable).
let languageEntries: LanguageEntry[] = [];
// The code of the language pack currently loaded into the running game, or ''
// when only the default English data is in use. Drives the pause-menu label.
let activeLanguageCode = '';
let waitForRelease = false;
let phase: 'library' | 'picker' | 'game-options' | 'keymap' | 'cover-confirm' | 'notice' | 'save-choice' | 'game-save-choice' | 'import-confirm' | 'loading' | 'game' | 'error' | 'rename' | 'rename-kb' | 'rename-choice' | 'add-game-name' | 'forwarder-building' = 'library';
let pickerPurpose: 'game' | 'startup-mod' | 'menu-mod' | 'game-mod' | 'startup-saves' | 'menu-saves' | 'add-game' | 'cover-image' | 'rename-source' = 'game';
let noticeReturnPhase: 'library' | 'game-options' = 'library';
let saveLocation: SaveLocation | undefined;
let choiceFromMenu = false, importRequested = false;
let message = '';
let host: ReturnType<typeof createBrowserHost> | undefined;
let mapPrefetch: MapPrefetcher | undefined;
let frames = 0, sampleStart = 0, fps = 0;
let lastFrame = 0, lastMemoryCheck = 0;
let fit = true;
let saved: GameSelection | null = null;
let settingsValid = true;
const previousButtons: boolean[] = Array(16).fill(false);
let marqueeOffset = 0; // scrolling text offset for long game names
let gameStopped = false; // when true, SceneManager.updateMain override returns early (no game update)

// === Loading progress bar state =======================================
// Replaces the old top-left text panel ("BurialNX / Opening game…") with a
// centered progress bar that updates as launch() advances through its
// stages. The bar is also reused while building a forwarder NRO.
//  - loadingLabel: short human line under the bar ("Loading scripts 3/47…")
//  - loadingProgress: 0..1 (clamped). NaN/Infinity is treated as 0.
//  - loadingTitle: title shown above the bar (defaults to "BurialNX")
//  - loadingSubtext: optional small grey line under the label (e.g. the
//    path of the script currently being loaded).
let loadingLabel = '';
let loadingSubtext = '';
let loadingProgress = 0;
let loadingTitle = 'BurialNX';
/** Update the loading screen state. The frame loop picks these up and
 *  renders the bar on the next vsync. `progress` is clamped to [0,1]. */
function setLoadingProgress(progress: number, label?: string, subtext?: string) {
        if (Number.isFinite(progress)) loadingProgress = Math.max(0, Math.min(1, progress));
        if (label !== undefined) loadingLabel = label;
        if (subtext !== undefined) loadingSubtext = subtext;
}
/** Reset the loading screen to its initial state for a new operation. */
function resetLoading(title = 'BurialNX', initialLabel = 'Starting…') {
        loadingTitle = title; loadingLabel = initialLabel; loadingSubtext = ''; loadingProgress = 0;
}
/** Draw the centered loading screen. Renders over whatever the game/host
 *  had on screen so the user sees a clean transition into the launch. */
function renderLoading() {
        if (!ctx) return;
        try {
                ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = '#161823'; ctx.fillRect(0, 0, screen.width, screen.height);
                const cx = screen.width / 2;
                // Title
                ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
                ctx.fillStyle = '#f4f3ef'; ctx.font = '34px sans-serif';
                ctx.fillText(loadingTitle, cx, screen.height / 2 - 80);
                // Label (current stage)
                ctx.fillStyle = '#c9cdd6'; ctx.font = '22px sans-serif';
                ctx.fillText(loadingLabel, cx, screen.height / 2 + 60);
                // Subtext (e.g. script path)
                if (loadingSubtext) {
                        ctx.fillStyle = '#6e7681'; ctx.font = '18px sans-serif';
                        // Truncate the subtext to fit within ~80% of the screen width.
                        const maxW = screen.width * 0.8;
                        let text = loadingSubtext;
                        if (ctx.measureText(text).width > maxW) {
                                let lo = 0, hi = text.length;
                                while (lo < hi) {
                                        const mid = (lo + hi + 1) >> 1;
                                        if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
                                }
                                text = text.slice(0, lo) + '…';
                        }
                        ctx.fillText(text, cx, screen.height / 2 + 88);
                }
                // Progress bar: a rounded-rectangle track + filled portion + %.
                const barW = Math.min(820, screen.width - 160);
                const barH = 26;
                const barX = (screen.width - barW) / 2;
                const barY = screen.height / 2 - 24;
                const radius = Math.max(2, Math.min(barH / 2, 13));
                // Track (outline)
                ctx.lineWidth = 2; ctx.strokeStyle = '#3a3f4b'; ctx.fillStyle = '#1f2229';
                roundedRectPath(barX, barY, barW, barH, radius);
                ctx.fill(); ctx.stroke();
                // Fill
                const fillW = Math.max(0, Math.min(barW - 4, (barW - 4) * loadingProgress));
                if (fillW > 0) {
                        ctx.fillStyle = '#3fb950';
                        // Inset by 2px on each side so the track stays visible.
                        roundedRectPath(barX + 2, barY + 2, fillW, barH - 4, Math.max(2, radius - 2));
                        ctx.fill();
                }
                // Percentage text, centered inside the bar
                ctx.fillStyle = '#f4f3ef'; ctx.font = '18px sans-serif'; ctx.textBaseline = 'middle';
                const pct = `${Math.round(loadingProgress * 100)}%`;
                ctx.fillText(pct, cx, barY + barH / 2 + 1);
                ctx.textBaseline = 'alphabetic';
                // Debug lines, if any, in the top-left corner so devs still get
                // diagnostics without losing the new bar UI.
                if (__DEBUG__ && debugLines.length) {
                        ctx.textAlign = 'left'; ctx.fillStyle = '#6e7681'; ctx.font = '16px sans-serif';
                        let y = 24;
                        for (const line of debugLines.slice(-12)) { ctx.fillText(line, 20, y); y += 20; }
                }
                ctx.restore();
        } catch (error) { log(`_loading: renderLoading failed: ${error instanceof Error ? error.message : String(error)}`); }
}
/** Trace a rounded-rectangle path on the current 2D context. nx.js's canvas
 *  does not expose ctx.roundRect, so we approximate it with quadratic curves
 *  (matches the Geometry in the WHATWG roundRect proposal). */
function roundedRectPath(x: number, y: number, w: number, h: number, r: number) {
        if (!ctx) return;
        const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.lineTo(x + w - rr, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
        ctx.lineTo(x + w, y + h - rr);
        ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
        ctx.lineTo(x + rr, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
        ctx.lineTo(x, y + rr);
        ctx.quadraticCurveTo(x, y, x + rr, y);
        ctx.closePath();
}

// === Plus-button exit guard state ======================================
let exitArmed = false;
let exitArmedAt = 0;
let exitNoticeArmed = false;
let allowExit = false;
// The exit mode chosen when the + confirmation (or pause-menu Quit) was
// armed. 'shutdown' = leave BurialNX entirely (library grid Quit, or a
// forwarder-launched game's exit); 'return-to-library' = a library-
// launched game's exit (relaunch burialnx.nro without --game).
let pendingExitMode: QuitMode = 'shutdown';
const realExit = typeof (Switch as any).exit === 'function' ? (Switch as any).exit.bind(Switch) : null;
// Plus(+) hold timer — the quit dialog only appears when + is held
// for 500ms (like Minus for the pause menu). Prevents accidental exits.
let plusHoldStart = 0;

// === Game session snapshot ============================================
// The game runs in THIS JavaScript realm: its scripts are eval'd at global
// scope, so every RPG Maker MV global ($dataXXX, SceneManager, Graphics, the
// patched WebAudio, the host's document/fetch/Image, …) lands on globalThis —
// and, without this machinery, STAYS there after "Back to library". V8 can
// never free the map data, sprite graphs, the PIXI renderer or the native
// audio buffers while those references remain, and the next launch stacks a
// whole second game on top of the first until native allocations start
// failing (observed on hardware as "RangeError: Out of memory (failed to
// allocate … bytes)"). To return ALL memory we snapshot globalThis right
// before a launch and restore it during teardown: globals added by the game
// are deleted, globals the host replaced are set back to their original
// values, game-registered timers are cancelled and fonts the game added are
// dropped — then one full GC pass retires everything that is no longer
// reachable.
interface GameSessionSnapshot {
        names: Set<string>;
        values: Record<string, unknown>;
        fonts: Set<unknown>;
        timers: Set<number>;
        rafIds: Set<number>;
        nativeClearTimeout: ((id: number) => void) | undefined;
        nativeCancelAnimationFrame: ((id: number) => void) | undefined;
}
let gameSession: GameSessionSnapshot | undefined;

function beginGameSession() {
        const global = globalThis as any;
        const values: Record<string, unknown> = {};
        const names = Object.getOwnPropertyNames(globalThis);
        for (const name of names) values[name] = global[name];
        const fonts = new Set<unknown>();
        try {
                if (global.fonts && typeof global.fonts[Symbol.iterator] === 'function') {
                        for (const font of global.fonts) fonts.add(font);
                }
        } catch { /* the fonts set is optional */ }
        const snapshot: GameSessionSnapshot = {
                names: new Set(names),
                values,
                fonts,
                timers: new Set<number>(),
                rafIds: new Set<number>(),
                nativeClearTimeout: typeof global.clearTimeout === 'function' ? global.clearTimeout.bind(global) : undefined,
                nativeCancelAnimationFrame: typeof global.cancelAnimationFrame === 'function' ? global.cancelAnimationFrame.bind(global) : undefined,
        };
        gameSession = snapshot;
        // Track every timer the game registers so teardown can cancel the ones
        // still pending: a late callback would fire into stopped state and its
        // closure would pin parts of the game in memory forever.
        if (typeof global.setTimeout === 'function') {
                const nativeSetTimeout = global.setTimeout;
                global.setTimeout = function (handler: unknown, timeout?: unknown, ...args: unknown[]) {
                        const id = nativeSetTimeout(handler, timeout, ...args);
                        snapshot.timers.add(id);
                        return id;
                };
        }
        if (typeof global.setInterval === 'function') {
                const nativeSetInterval = global.setInterval;
                global.setInterval = function (handler: unknown, timeout?: unknown, ...args: unknown[]) {
                        const id = nativeSetInterval(handler, timeout, ...args);
                        snapshot.timers.add(id);
                        return id;
                };
        }
        // Track every animation frame the game schedules, for a sharper reason
        // than the timers: the game's pending rAF callback IS its original
        // bound SceneManager.update. Property stubs on the manager cannot
        // reach into that already-bound function, so the only way to stop a
        // QUEUED frame from running after the realm restore deleted the game
        // globals is cancelling its id here (nx.js implements rAF as a plain
        // cancellable callback queue). endGameSession() does exactly that.
        if (typeof global.requestAnimationFrame === 'function' && typeof global.cancelAnimationFrame === 'function') {
                const nativeRequestAnimationFrame = global.requestAnimationFrame;
                global.requestAnimationFrame = function (handler: unknown) {
                        const id = nativeRequestAnimationFrame(handler);
                        if (typeof id === 'number') snapshot.rafIds.add(id);
                        return id;
                };
        }
}

function endGameSession() {
        const snapshot = gameSession;
        if (!snapshot) return;
        gameSession = undefined;
        const global = globalThis as any;
        // 0. Cancel the game's queued animation frames FIRST. The pending rAF
        //    callback runs the original bound SceneManager.update; if it fired
        //    after the globals below are deleted, its first Graphics/Utils
        //    reference would throw a ReferenceError that escapes through the
        //    game's own catchException (which references Graphics too) into
        //    nx.js — and an uncaught rAF exception terminates the whole
        //    process (hardware: "Graphics is not defined" over a frozen
        //    screen). Cancelling the ids plus the manager stubs below make a
        //    dequeued-but-still-running frame a complete no-op, so quitting
        //    cannot be crashed by a late game frame between teardown and
        //    Switch.exit().
        for (const id of snapshot.rafIds) {
                try { snapshot.nativeCancelAnimationFrame?.(id); } catch { /* best-effort */ }
        }
        // 1. Cancel pending game timers first so no callback fires mid-teardown.
        for (const id of snapshot.timers) {
                try { snapshot.nativeClearTimeout?.(id); } catch { /* best-effort */ }
        }
        // 2. Drop fonts the game added (each FontFace keeps a native copy of the
        //    TTF data alive until the object is collected).
        try {
                const fonts = global.fonts;
                if (fonts && typeof fonts[Symbol.iterator] === 'function' && typeof fonts.delete === 'function') {
                        for (const font of [...fonts]) {
                                if (!snapshot.fonts.has(font)) { try { fonts.delete(font); } catch { /* best-effort */ } }
                        }
                }
        } catch { /* font cleanup is optional */ }
        // 3. Delete every global the game or its host added on top of the
        //    snapshot. Game-created globals are plain configurable properties;
        //    some nx.js built-ins are non-configurable and simply can't be
        //    deleted (they are also never the game's, so keeping them is fine).
        for (const name of Object.getOwnPropertyNames(globalThis)) {
                if (snapshot.names.has(name)) continue;
                try { delete global[name]; } catch { /* non-configurable: keep */ }
        }
        // 4. Restore replaced values: document, fetch, Image, XMLHttpRequest,
        //    location, … all go back to the native originals. The next launch
        //    re-installs fresh wrappers around the natives instead of stacking.
        for (const name of snapshot.names) {
                if (!(name in globalThis)) continue;
                try {
                        if (global[name] !== snapshot.values[name]) global[name] = snapshot.values[name];
                } catch { /* non-writable: keep */ }
        }
}

/** Completely stop the running game and release everything it holds: game
 *  audio, the requestAnimationFrame loop, decoded image/bitmap pixel
 *  buffers, every global the game or its host added to this realm (see the
 *  game session snapshot above), and our host references. A final GC pass
 *  returns the freed native buffers to the heap right away. Used by the
 *  quit path ("Quit BurialNX" and B on the error screen) before Switch.exit(),
 *  so no part of a stopped game can keep running, keep playing sound, or
 *  hold on to memory while the runtime tears the process down. */
function teardownGame() {
        // Stop all game audio first so nothing keeps playing over the loader.
        try { runtime.AudioManager?.stopBgm?.(); } catch { /* best-effort */ }
        try { runtime.AudioManager?.stopBgs?.(); } catch { /* best-effort */ }
        try { runtime.AudioManager?.stopMe?.(); } catch { /* best-effort */ }
        try { runtime.AudioManager?.stopSe?.(); } catch { /* best-effort */ }
        // Permanently retire the game's frame loop. Just setting _stopped (or
        // the gameStopped flag) leaves the already-queued rAF callback alive:
        // it re-arms itself every frame and would come back to life — drawing
        // the retired scene on the physical screen or crashing on stale state —
        // as soon as the next launch clears gameStopped. Replacing the loop
        // entry points with no-ops ends the chain for good; the next launch
        // builds a fresh SceneManager from the game's own scripts.
        try {
                const manager = runtime.SceneManager;
                if (manager) {
                        try { manager._stopped = true; } catch { /* best-effort */ }
                        // Drop scene references: scenes hold sprites, and
                        // sprites hold native bitmap buffers.
                        try { manager._scene = null; } catch { /* best-effort */ }
                        try { manager._nextScene = null; } catch { /* best-effort */ }
                        // Retire EVERY method the game's update loop can reach,
                        // not just the four obvious ones. A frame that was
                        // already dequeued for the current vsync batch still
                        // runs the ORIGINAL bound update() after this function
                        // returns: its try block calls tickStart/tickEnd →
                        // Graphics.tickStart/End() and its catch calls
                        // catchException → Graphics.printError() — with the
                        // game globals deleted, both threw escaping
                        // ReferenceErrors and killed the process (hardware
                        // crash "Graphics is not defined"). Stubbing the full
                        // reachable set turns even that late callback into a
                        // complete no-op: the game's own catch swallows the
                        // first error (e.g. "Utils is not defined") and the
                        // stubbed catchException ends the chain for good.
                        for (const name of [
                                'update', 'updateMain', 'requestUpdate', 'renderScene',
                                'tickStart', 'tickEnd', 'updateInputData', 'updateScene',
                                'changeScene', 'catchException', 'stop', 'terminate',
                        ]) {
                                try { manager[name] = function () { /* retired game */ }; } catch { /* best-effort */ }
                        }
                }
        } catch { /* best-effort */ }
        // Release decoded image and bitmap pixel buffers held by the game's caches.
        try { runtime.ImageManager?._imageCache?.clear?.(); } catch { /* best-effort */ }
        try { runtime.ImageManager?._cache?.clear?.(); } catch { /* best-effort */ }
        try { runtime.ImageManager?.clear?.(); } catch { /* best-effort */ }
        try { if (Array.isArray(runtime.Bitmap?._reuseImages)) runtime.Bitmap._reuseImages.length = 0; } catch { /* best-effort */ }
        gameStopped = true;
        // Undo everything the game session added to this realm (globals, host
        // replacements, game fonts, pending game timers) so the data above is no
        // longer reachable from anywhere and the GC below can actually free it.
        endGameSession();
        // Drop the diagnostic scene references too — they would pin the last
        // observed scene (and its whole sprite/bitmap graph) in memory.
        observedScene = undefined;
        snapshotScene = Symbol('no diagnostic snapshot yet');
        host = undefined;
        mapPrefetch = undefined;
        // Reset language state so a subsequent launch scans the new game's packs.
        languageEntries = [];
        activeLanguageCode = '';
        // Ask V8 for a full collection so the released buffers are actually
        // returned to the native heap instead of lingering until the next
        // launch needs the memory.
        try {
                const before = __DEBUG__ ? (Switch as any).memoryUsage?.() : undefined;
                if (typeof runtime.gc === 'function') runtime.gc();
                if (before) {
                        const after = (Switch as any).memoryUsage?.();
                        if (after) log(`_teardown: heap ${(before.usedHeapSize / 1048576).toFixed(1)} MiB -> ${(after.usedHeapSize / 1048576).toFixed(1)} MiB, native malloc ${(after.mallocedMemory / 1048576).toFixed(1)} MiB`);
                }
        } catch { /* best-effort */ }
}

// === Exit modes ========================================================
// Two distinct exit paths, chosen by context:
//
//   'return-to-library' — used when a LIBRARY-LAUNCHED game exits (pause
//     menu or + confirmation). We chain-load burialnx.nro WITHOUT --game via
//     app.launch(), which sets a NEW envSetNextLoad (overwriting the stale
//     forwarder one). hbloader reloads burialnx → library grid shows.
//
//   'shutdown' — used for (a) the library grid's own Quit tile / +
//     confirmation, (b) a FORWARDER-LAUNCHED game's exit, and (c) the
//     error screen's B button. We call Switch.exit() and rely on hbloader
//     to check envSetNextLoad:
//       - If hbloader CLEARS envSetNextLoad after chain-loading (standard
//         hbmenu behavior): the stale forwarder next-load is gone → hbmenu. ✅
//       - If hbloader does NOT clear (some custom loaders): the stale
//         next-load persists → burialnx re-chains. The re-launch detection
//         at startup catches this and shows the library (NOT the game) so
//         the user is not stuck in a game-restart loop. The user can then
//         try quitting again from the library.
//
// CRITICAL: nx.js's Application.launch() uses the CONSTRUCTOR's path for
// envSetNextLoad (not the launch() argument). So `new Switch.Application('')`
// throws (fopen('') fails) — we CANNOT set envSetNextLoad to an empty path
// via the JS API. The only way to "clear" the stale next-load is to
// OVERWRITE it with a valid NRO path (app.launch(burialnx.nro)), which
// chains to that NRO. This is what 'return-to-library' does.
//
type QuitMode = 'shutdown' | 'return-to-library';

// Path to the forwarder-exit flag file. Written just before a shutdown
// attempt so the next boot can detect a stale-next-load re-chain.
const FORWARDER_EXIT_FLAG = 'sdmc:/switch/burialnx/.fwd-exit-flag';
// A re-launch is only "stale" if the flag was written within this window.
const RE_LAUNCH_WINDOW_MS = 30_000;

function writeForwarderExitFlag(): void {
        try {
                const SwitchAny = (Switch as any);
                const payload = new TextEncoder().encode(String(Date.now()));
                if (typeof SwitchAny?.writeFileSync === 'function') {
                        SwitchAny.writeFileSync(FORWARDER_EXIT_FLAG, payload.buffer);
                        log(`_exit: flag written -> ${FORWARDER_EXIT_FLAG}`);
                }
        } catch (e) { log(`_exit: flag write FAILED: ${e instanceof Error ? e.message : String(e)}`); }
}

function clearForwarderExitFlag(): void {
        try {
                const SwitchAny = (Switch as any);
                const remove = SwitchAny?.removeSync || SwitchAny?.unlinkSync;
                if (typeof remove === 'function') {
                        try { remove.call(SwitchAny, FORWARDER_EXIT_FLAG); return; } catch { /* not present */ }
                }
                try { SwitchAny?.writeFileSync?.(FORWARDER_EXIT_FLAG, new ArrayBuffer(0)); } catch { /* ignore */ }
        } catch { /* best-effort */ }
}

/** Read the forwarder-exit flag and return true if it was written within
 *  the re-launch window (i.e. burialnx was just re-chained by a stale
 *  envSetNextLoad after a shutdown attempt). Also returns the timestamp
 *  for diagnostic logging. */
function checkForwarderRelaunch(): { recent: boolean; ageMs: number } {
        try {
                const SwitchAny = (Switch as any);
                if (typeof SwitchAny?.readFileSync !== 'function') return { recent: false, ageMs: -1 };
                const data = SwitchAny.readFileSync(FORWARDER_EXIT_FLAG) as ArrayBuffer | null;
                if (!data || data.byteLength === 0) return { recent: false, ageMs: -1 };
                const text = new TextDecoder().decode(new Uint8Array(data)).trim();
                const ts = parseInt(text, 10);
                if (!Number.isFinite(ts) || ts <= 0) return { recent: false, ageMs: -1 };
                const age = Date.now() - ts;
                return { recent: age >= 0 && age <= RE_LAUNCH_WINDOW_MS, ageMs: age };
        } catch { return { recent: false, ageMs: -1 }; }
}

/** Chain-load burialnx.nro WITHOUT --game so the library grid shows.
 *  Sets a NEW envSetNextLoad (overwriting the stale forwarder one) and
 *  exits the process. If the chain fails (burialnx.nro not found), throws
 *  so the caller can fall back to Switch.exit(). */
function chainToLibrary(): void {
        const SwitchAny = (Switch as any);
        let nroPath = BURIALNX_NRO_PATH;
        let app: any;
        try { app = new SwitchAny.Application(nroPath); }
        catch (e1) {
                log(`_exit: Application(${nroPath}) failed: ${e1 instanceof Error ? e1.message : String(e1)}`);
                nroPath = BURIALNX_DEBUG_NRO_PATH;
                app = new SwitchAny.Application(nroPath);
        }
        log(`_exit: chainToLibrary app.launch(${nroPath}) [no --game]`);
        allowExit = true;
        app.launch(nroPath);
        // launch() is `never` — if it returns, the chain failed.
        throw new Error('chainToLibrary: app.launch returned without exiting');
}

function quitApp(mode: QuitMode) {
        log(`_exit: quitApp(${mode}), forwarderTargetId=${forwarderTargetId || 'null'}, isBakedForwarder=${isBakedForwarder}`);
        // Return all memory and shut everything down: stop the game
        // (audio + frame loop + image buffers) and run a final GC pass.
        try { teardownGame(); } catch (e) { log(`_exit: teardown threw: ${e instanceof Error ? e.message : String(e)}`); }
        const wasForwarder = forwarderTargetId !== null;
        // Capture whether this was a baked-in forwarder BEFORE clearing
        // forwarderTargetId. Baked-in forwarders never set envSetNextLoad,
        // so there is NO re-chain to detect — we skip writing the flag.
        const wasBakedForwarder = isBakedForwarder;
        forwarderTargetId = null;
        isBakedForwarder = false;
        phase = 'library';
        exitNoticeArmed = false;
        plusHoldStart = 0;
        if (mode === 'return-to-library') {
                // Library-launched game exit: chain to burialnx.nro (no --game)
                // → library grid shows. This OVERWRITES any stale next-load.
                try {
                        chainToLibrary();
                } catch (e) {
                        log(`_exit: chainToLibrary FAILED: ${e instanceof Error ? e.message : String(e)}`);
                        removeBeforeUnloadListener();
                        if (realExit) { allowExit = true; try { realExit(); } catch { /* best-effort */ } }
                }
                return;
        }
        // mode === 'shutdown' — the user wants to leave BurialNX entirely.
        // For BAKED-IN forwarders: NO envSetNextLoad was set, so there is
        // NO re-chain to detect. Skip writing the flag (it would cause a
        // false "re-launch" on the next forwarder launch within 30s).
        // For LEGACY argv forwarders: write the flag so the next boot can
        // detect a stale re-chain (if hbloader didn't clear envSetNextLoad).
        if (wasBakedForwarder) {
                clearForwarderExitFlag();
        } else {
                writeForwarderExitFlag();
        }
        // Try calling Switch.exit(). If hbloader cleared the next-load after
        // chain-loading us, this returns to hbmenu. If not, the stale
        // next-load re-chains and the re-launch detection catches it.
        //
        // CRITICAL: Switch.exit() is DEFERRED to the next tick via setTimeout.
        // quitApp() is called from inside the frame() rAF callback — calling
        // Switch.exit() synchronously while the frame is still on the call
        // stack causes a sporadic crash (re-entrancy: the next rAF may fire
        // before Switch.exit finishes, accessing retired state). Deferring
        // lets the current frame return cleanly, then the exit runs on a
        // fresh tick with no frame on the stack.
        log(`_exit: calling Switch.exit() [wasForwarder=${wasForwarder}]`);
        if (realExit) {
                allowExit = true;
                // CRITICAL: Remove all session event listeners BEFORE calling
                // Switch.exit(). The Atmosphere crash report showed infinite
                // recursion (stack overflow) during exit — the repeating stack
                // pattern (nxjs C++ → V8 → C++ → V8 → ...) indicates that
                // Switch.exit() dispatches a beforeunload event, and the
                // handler's execution triggers another beforeunload (or
                // similar event), creating an unbreakable recursive loop that
                // overflows the 1 MB stack. Removing the listeners means
                // Switch.exit() can't dispatch events to our handlers, breaking
                // the recursion cycle. Also deferred to the next tick via
                // setTimeout so the current frame() returns cleanly first.
                removeBeforeUnloadListener();
                setTimeout(() => {
                        try { realExit(); } catch (e) { log(`_exit: Switch.exit threw: ${e instanceof Error ? e.message : String(e)}`); }
                }, 0);
        }
}

// === Library state ======================================================
// The library is the entry point for the loader. The user picks a game from
// the grid; their choice populates `selectedGame`/`sharedSaves`/`selectedMod`
// /`saveLocation` and the existing launch flow takes over. The library file
// lives at sdmc:/switch/burialnx/library.json and replaces the legacy
// single-game settings.json on first load.
let library: LibraryFile = { version: 1, games: [] };
let libraryCursor = 0; // index into library.games, plus 3 action tiles
let libraryPage = 0;
const LIBRARY_COLS = 4;
const LIBRARY_ROWS = 2;
const LIBRARY_PAGE_SIZE = LIBRARY_COLS * LIBRARY_ROWS; // 8 tiles per page
const LIBRARY_ACTION_TILES = 3; // Add Game, Keymap, Quit
const coverCache = new Map<string, { image: any; loaded: boolean; failed: boolean }>();
let currentEntry: LibraryEntry | null = null;
let renameBuffer = '';
let renameCursor = 0;
let renameSubmitted = false;
let renamePreview = '';

// === Add-game-name state ==============================================
// When the user picks a game folder via +Add Game, we open the software
// keyboard so they can name the game before it's added to the library.
// The suggested name is derived from the folder name or a .exe file in
// the parent folder.
let addGamePath = '';
let addGameDefaultName = '';
let addGameSubmitted = false;
let addGamePreview = '';

// === Keymap state =======================================================
// Two keymaps are tracked separately:
//   - globalKeymap: the default loaded from sdmc:/switch/burialnx/keymap.json
//     at startup. Used when a game has no per-game keymap of its own.
//   - editingKeymap / keymapTarget: the working copy the user is currently
//     editing in the keymap phase, and what it targets ("global" or a
//     specific library entry). Per-game keymaps live inside LibraryEntry so
//     each added game can have a fully independent binding set.
let globalKeymap: KeyMap = { buttons: [...DEFAULT_KEYMAP.buttons] };
let editingKeymap: KeyMap = { buttons: [...DEFAULT_KEYMAP.buttons] };
let keymapTarget: 'global' | LibraryEntry | null = null;
let keymapCursor = 0;
let keymapValid = true;

function validSaveLocation(location: SaveLocation, root: string, mod: string | null): boolean {
        if (location.kind === 'switch') return true;
        if (location.kind === 'game' && !safeGameSaveFolder(location.folder, root, mod)) return false;
        if (location.kind === 'sd' && !safeSaveFolder(location.folder, root, mod)) return false;
        try {
                const entry = Switch.statSync(location.folder);
                return entry ? (entry.mode & 0o170000) === 0o040000 : location.kind === 'game';
        } catch { return false; }
}
const debugSettingsPath = 'sdmc:/switch/burialnx/debug-settings.json';
let directScreen = true, directNext = true, debugSettingsValid = true;
if (__DEBUG__) try {
        const raw = Switch.readFileSync(debugSettingsPath);
        if (raw) {
                const value = JSON.parse(new TextDecoder().decode(raw));
                if (typeof value?.directScreen !== 'boolean') throw new Error('Invalid debug settings');
                directScreen = directNext = value.directScreen;
        }
} catch { debugSettingsValid = false; }
// Load the library (migrates from settings.json on first run).
try {
        library = loadLibrary(Switch as unknown as LibraryAccess);
        log(`_9: loadLibrary ok, ${library.games.length} games`);
} catch (error) { log(`_9: loadLibrary failed: ${error instanceof Error ? error.message : String(error)}`); }
// Load the global keymap (used as the default when a library entry has no
// per-game keymap of its own).
try {
        globalKeymap = loadKeyMap(Switch as unknown as LibraryAccess);
        // Seed the working copy with EVERYTHING the loaded map carries
        // (labels, keyCodes, sticks), not just buttons — otherwise the
        // first time the editor opens it would show 'none' for sticks
        // even when keymap.json has stick bindings saved.
        editingKeymap = { buttons: [...globalKeymap.buttons] };
        if (globalKeymap.labels) editingKeymap.labels = [...globalKeymap.labels];
        if (globalKeymap.keyCodes) editingKeymap.keyCodes = [...globalKeymap.keyCodes];
        if (globalKeymap.sticks) {
                editingKeymap.sticks = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = globalKeymap.sticks[dir];
                        if (b) editingKeymap.sticks[dir] = { keyCode: b.keyCode, label: b.label };
                }
        }
        log(`_11: loadKeyMap ok, ${globalKeymap.buttons.filter((b) => b !== 'none').length} active bindings`);
} catch (error) { log(`_11: loadKeyMap failed: ${error instanceof Error ? error.message : String(error)}`); keymapValid = false; }

// Position the library cursor on the last-played game, if any.
try {
        if (library.lastPlayed) {
                const idx = library.games.findIndex((g) => g.id === library.lastPlayed);
                if (idx >= 0) libraryCursor = idx;
        }
} catch { /* ignore */ }

// Legacy settings.json is still read for backward compatibility with the
// old startupSelection() flow used by the debug build. It is only consulted
// if no library entry resolves to the same root.
try {
        const data = Switch.readFileSync(settingsPath);
        if (data) {
                saved = parseSelection(new TextDecoder().decode(data));
                const selected = startupSelection(Switch, saved, __DEBUG__);
                if (selected) {
                        if (!library.games.some((g) => g.root === selected.root)) {
                                const entry = entryFromSelection(selected);
                                try { library = upsertGame(Switch as unknown as LibraryAccess, library, entry); } catch { /* keep empty library */ }
                        }
                }
        }
} catch { settingsValid = false; }
function remember(selection: GameSelection) {
        if (!settingsValid) return false;
        try { Switch.writeFileSync(settingsPath, JSON.stringify(selection, null, 2)); saved = selection; return true; }
        catch (error) { log(`Could not save selection: ${String(error)}`); return false; }
}
function rememberLibrary(entry: LibraryEntry) {
        try { library = upsertGame(Switch as unknown as LibraryAccess, library, entry); return true; }
        catch (error) { log(`Could not save library entry: ${String(error)}`); return false; }
}
/** Read the per-game language preference from the library entry (NOT localStorage).
 *  Returns: undefined = no preference (auto-select first .cld), '' = English,
 *  'ru' = Russian, etc. Uses the library file on the SD card so it works in
 *  forwarder NROs (which have saveData=0, making localStorage unavailable). */
function getGameLanguage(gameRoot: string): string | undefined {
        const entry = library.games.find((g) => g.root === gameRoot || g.id === libraryIdFromRoot(gameRoot));
        return entry?.language;
}
/** Save the per-game language preference to the library file on the SD card.
 *  Works in both the main app and forwarder NROs (no localStorage needed). */
function setGameLanguage(gameRoot: string, code: string): void {
        const id = libraryIdFromRoot(gameRoot);
        const entry = library.games.find((g) => g.id === id);
        if (entry) {
                const updated: LibraryEntry = { ...entry, language: code };
                if (rememberLibrary(updated)) { currentEntry = updated; log(`Language preference saved: ${code || 'English (default)'} for ${id}`); }
        }
}
function currentSelection(saves = saveLocation): GameSelection {
        if (!selectedGame) throw new Error('No game selected');
        return { root: selectedGame, sharedSaves, mod: selectedMod || null, ...(saves ? { saves } : {}) };
}
function loadEntryIntoState(entry: LibraryEntry) {
        selectedGame = entry.root;
        sharedSaves = entry.sharedSaves;
        // Respect modEnabled: if the mod is disabled, don't apply it at launch.
        const modActive = entry.mod !== undefined && entry.mod !== null && entry.modEnabled !== false;
        selectedMod = modActive ? entry.mod : null;
        // Remember the save location from the library entry. Both debug and
        // release builds use the stored saves location so the user is never
        // re-asked after the first launch.
        saveLocation = entry.saves;
        if (saveLocation && !validSaveLocation(saveLocation, entry.root, selectedMod || null)) saveLocation = undefined;
        saved = toSelection(entry);
        currentEntry = entry;
}
function startOrChooseSaves() {
        if (saveLocation) void launch();
        else { choiceFromMenu = false; waitForRelease = true; phase = 'save-choice'; }
}

// === Add-game-name helpers ============================================
/** Suggest a game name from the picked folder path. Looks for a .exe
 *  file in the parent folder (RPG Maker MV games usually have one next
 *  to the www/ folder). If found, uses the .exe filename without the
 *  extension. Otherwise, uses the folder name. */
function suggestGameName(root: string): string {
        try {
                // RPG Maker MV's www/ contains the web assets; the .exe usually
                // lives next to it. Look one level up when the root is www/.
                const clean = root.replace(/\/+$/, '');
                const parent = /\/www$/i.test(clean) ? clean.slice(0, -4) : clean;
                const dir = parent;
                let entries: string[] | null = null;
                try { entries = (Switch as any).readDirSync?.(`${dir}/`) as string[] | null; } catch { /* unreadable */ }
                if (entries) {
                        for (const name of entries) {
                                if (name && /\.exe$/i.test(name)) {
                                        // Use the .exe filename without the extension.
                                        return name.replace(/\.exe$/i, '');
                                }
                        }
                }
        } catch { /* best-effort */ }
        // Fall back to the folder name.
        return root.replace(/\/+$/, '').split('/').pop() || 'Game';
}

/** Finish the add-game flow: create the library entry with the given
 *  name, try to auto-detect a cover, and return to the library. */
function finishAddGame(name: string): void {
        if (!addGamePath) { waitForRelease = true; phase = 'library'; return; }
        const id = libraryIdFromRoot(addGamePath);
        const trimmedName = name.trim() || addGameDefaultName || (addGamePath.split('/').pop() || 'Game');
        // Try to derive a cover from the folder.
        let cover: string | null = null;
        try { cover = deriveDefaultCover(Switch as unknown as LibraryAccess & { readDirSync(path: string): string[] | null }, id, addGamePath); }
        catch (error) { log(`Cover auto-detect failed: ${String(error)}`); }
        const entry: LibraryEntry = { id, name: trimmedName, root: addGamePath, sharedSaves: false, mod: null, ...(cover ? { cover } : { cover: null }) };
        if (rememberLibrary(entry)) { library = loadLibrary(Switch as unknown as LibraryAccess); invalidateCoverCache(); }
        // Pre-select the new game.
        const idx = library.games.findIndex((g) => g.id === id);
        if (idx >= 0) libraryCursor = idx;
        libraryPage = Math.floor(libraryCursor / LIBRARY_PAGE_SIZE);
        // Clean up.
        addGamePath = '';
        addGameDefaultName = '';
        addGameSubmitted = false;
        addGamePreview = '';
        try { navigator?.virtualKeyboard?.removeEventListener?.('change', () => {}); } catch { /* best-effort */ }
        try { navigator?.virtualKeyboard?.removeEventListener?.('submit', () => {}); } catch { /* best-effort */ }
        waitForRelease = true; phase = 'library';
}

// === Forwarder builder entrypoint =====================================
// Drives the buildForwarder() pipeline from main.ts. Reads the embedded
// template NRO from romfs, reads the game's cover PNG from the SD card
// (if present), and hands them to buildForwarder(), updating the loading
// progress bar at each stage so the user sees what's happening. On
// completion it shows a notice with the result. The whole operation runs
// while phase === 'forwarder-building', so the frame loop renders the
// progress bar and B is ignored (we don't want to interrupt a half-written
// NRO).
async function startForwarderBuild(entry: LibraryEntry) {
        const SwitchAny = (Switch as any);
        if (!SwitchAny?.writeFileSync || !SwitchAny?.readFileSync) {
                message = 'Switch filesystem unavailable — cannot build forwarder.'; waitForRelease = true; phase = 'notice'; return;
        }
        // Defer one tick so the new phase paints before the (sync) SD reads
        // start blocking. The phase renders the progress bar.
        waitForRelease = true; phase = 'forwarder-building';
        resetLoading(`Forwarder: ${entry.name}`, 'Reading burialnx.nro…');
        // Yield to the next frame so the loading screen paints.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        try {
                // Read burialnx.nro's OWN file (the running app) to use as the
                // forwarder base. Switch.argv[0] is the path hbmenu used to
                // launch us. The forwarder is built by patching a copy of
                // this NRO: overwrite main.js in the romfs with the forwarder's
                // chain-load script, patch the NACP (title = game name), and
                // optionally patch the icon. No embedded template needed —
                // burialnx.nro stays at ~54 MiB.
                const selfPath = SwitchAny.argv?.[0] as string | undefined;
                if (!selfPath) {
                        message = 'Could not determine the burialnx.nro path (Switch.argv[0] is empty).'; waitForRelease = true; phase = 'notice'; return;
                }
                setLoadingProgress(0.05, 'Reading burialnx.nro…', selfPath);
                const baseNro = SwitchAny.readFileSync(selfPath) as ArrayBuffer | null;
                if (!baseNro || baseNro.byteLength === 0) {
                        message = `Could not read ${selfPath}. Make sure burialnx.nro is at that path.`; waitForRelease = true; phase = 'notice'; return;
                }
                if (__DEBUG__) log(`forwarder: base NRO loaded from ${selfPath}, ${baseNro.byteLength} bytes`);
                setLoadingProgress(0.35, 'Reading game cover…');
                const coverPath = entry.cover || coverPathFor(entry.id);
                const coverExists = coverPath ? !!(Switch as unknown as LibraryAccess).statSync?.(coverPath) : false;
                if (__DEBUG__) log(`forwarder: cover path = ${coverPath || '(none)'}, exists = ${coverExists}`);
                setLoadingProgress(0.50, coverExists ? 'Decoding cover image…' : 'No cover — keeping BurialNX icon…', coverPath || '(none)');
                setLoadingProgress(0.65, 'Patching NACP + main.js + game id…');
                const outputPath = forwarderPathFor(entry.name, entry.id);
                const result = await buildForwarder({
                        game: entry,
                        cover: coverExists ? { path: coverPath } : null,
                        baseNro,
                        outputPath,
                        log,
                });
                setLoadingProgress(1, 'Done.');
                if (result.ok) {
                        const mib = result.bytes ? (result.bytes / 1024 / 1024).toFixed(1) : '?';
                        message = `Forwarder built:\n${outputPath}\n(${mib} MiB). Reboot to hbmenu to see it.`;
                        if (__DEBUG__) log(`forwarder build ok: ${outputPath} (${result.bytes} bytes)`);
                } else {
                        message = `Forwarder build failed: ${result.error || 'unknown error'}`;
                        if (__DEBUG__) log(`forwarder build failed: ${result.error}`);
                }
                // Explicitly free the 54 MB baseNro ArrayBuffer and cover Image
                // before showing the notice. Without this, the large buffers may
                // still be in memory when the user clicks exit — the deferred
                // Switch.exit() can crash during native cleanup if too much
                // memory is still allocated. This GC call is the fix for the
                // sporadic "exit crashes after building/deleting a forwarder" bug.
                try { if (typeof runtime.gc === 'function') runtime.gc(); } catch { /* best-effort */ }
                waitForRelease = true; phase = 'notice';
        } catch (error) {
                const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                log(`startForwarderBuild threw: ${msg}`);
                message = `Forwarder build error: ${msg}`;
                try { if (typeof runtime.gc === 'function') runtime.gc(); } catch { /* best-effort */ }
                waitForRelease = true; phase = 'notice';
        }
}
function chooseSaves(location: SaveLocation) {
        if (!selectedGame) return;
        if (!validSaveLocation(location, selectedGame, selectedMod || null)) {
                message = 'Save folder is unavailable or overlaps the mod.'; waitForRelease = true; phase = 'notice'; return;
        }
        const pendingMod = choiceFromMenu && saved?.root === selectedGame ? saved.mod || null : selectedMod || null;
        if (!validSaveLocation(location, selectedGame, pendingMod)) { message = 'Save folder overlaps the selected mod.'; waitForRelease = true; phase = 'notice'; return; }
        const newSelection = { ...currentSelection(location), mod: pendingMod };
        if (!remember(newSelection)) { log('Could not save settings.json; continuing with library only.'); }
        // Persist the save location into the library entry too.
        if (currentEntry) {
                const updated: LibraryEntry = { ...currentEntry, mod: pendingMod, saves: location };
                if (!rememberLibrary(updated)) { message = 'Could not save library; storage unchanged.'; waitForRelease = true; phase = 'notice'; return; }
                currentEntry = updated;
        }
        if (choiceFromMenu) {
                message = 'Save location saved. Restart the loader to apply it.'; phase = 'notice';
        } else {
                saveLocation = location;
                if (location.kind === 'game') { importRequested = false; waitForRelease = true; void launch(); return; }
                let hasSource = true;
                try { hasSource = hasSteamSaveData(Switch, selectedGame); }
                catch (error) { log(`Could not check Steam saves: ${String(error)}`); }
                if (hasSource) phase = 'import-confirm';
                else { importRequested = false; void launch(); }
        }
        waitForRelease = true;
}

// nx.js's regular console can draw over the game. Debug messages go to the
// runtime's file logger instead; the release build suppresses routine output.
for (const level of ['debug', 'log', 'info', 'warn', 'error', 'trace'] as const) {
        console[level] = (...values: unknown[]) => { if (__DEBUG__) log(`[${level}] ${values.map(String).join(' ')}`); };
}
function log(line: string) {
        if (!__DEBUG__) return;
        debugLines.push(line);
        if (debugLines.length > 6) debugLines.shift();
        try { Switch.appendFileSync(hostLogPath, `${line}\n`); } catch { /* optional diagnostics */ }
}
// nx.js writes its own log to a fixed path. Copy a snapshot instead of moving
// or truncating that file, which the runtime may still have open.
function snapshotRuntimeLog() {
        if (!__DEBUG__) return;
        try {
                const bytes = Switch.readFileSync('sdmc:/switch/nxjs-debug.log');
                if (bytes) Switch.writeFileSync(`${logsPath}/nxjs-debug-${Date.now()}.log`, bytes);
        } catch { /* native log may not exist */ }
}
function panel(lines: string[], full = false) {
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#161823'; ctx.fillRect(0, 0, screen.width, full ? screen.height : Math.min(screen.height, 30 + 30 * lines.length));
        ctx.fillStyle = '#f4f3ef'; ctx.font = '22px sans-serif';
        lines.forEach((line, index) => ctx.fillText(line, 28, 34 + index * 30, screen.width - 56));
        ctx.restore();
}
function hud() {
        if (phase !== 'game') return;
        if (menu.open) {
                renderPauseMenu();
        } else if (menu.fps) {
                // FPS counter only (compact, top-left, no background).
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
                ctx.font = '18px sans-serif';
                ctx.fillStyle = '#3fb950';
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                ctx.fillText(`${fps.toFixed(1)} FPS`, 28, 28);
                ctx.restore();
        }
}

/** Compact pause menu (hold Minus). The background only covers the
 *  menu items, not the full screen — the game is visible around it. */
function renderPauseMenu(): void {
        if (!ctx) return;
        /** Human-readable label for the language currently in use (or 'English' default). */
        function currentLanguageLabel(): string {
                if (!activeLanguageCode) return 'English (default)';
                const entry = languageEntries.find((e) => e.code === activeLanguageCode);
                return entry?.name || activeLanguageCode;
        }
        // The last menu item (pause-menu "quit") is labeled differently
        // depending on how the game was launched:
        //   - Forwarder launch (forwarderTargetId set): the user wants to
        //     LEAVE BurialNX entirely → "Quit BurialNX" (a real exit).
        //   - Library launch (forwarderTargetId null): the user came from
        //     the library grid → "Return to library" (relaunch burialnx.nro
        //     without --game so the grid shows again).
        const quitLabel = forwarderTargetId ? 'Quit BurialNX' : 'Return to library';
        const labels: Record<string, string> = {
                continue: 'Resume', save: 'Save', load: 'Load',
                keymap: 'Edit joycon key bindings',
                another: 'Another...', back: 'Back',
                quit: quitLabel,
                saves: 'Choose save location', import: 'Import Steam saves',
                resolution: `Display: ${fit ? 'fit' : 'native'}`,
                fps: `FPS: ${menu.fps ? 'on' : 'off'}`,
                mod: 'Select mod for next launch',
                direct: `Direct screen: ${directNext ? 'on' : 'off'}`,
                snapshot: 'Diagnostic snapshot',
                language: `Language: ${currentLanguageLabel()}`,
        };
        const items = menu.currentItems;
        // Top bar (always visible when menu is open).
        const topBar = 'BurialNX  |  Up/Down: select  A: choose  B: back/close'
                + (menu.fps ? `  |  ${fps.toFixed(1)} FPS` : '');
        // FIXED panel size — accommodates the larger page (page 2 with
        // 8 items in debug, 6 in release). Using a fixed size means
        // the opaque panel always covers the same screen area, so
        // switching pages doesn't leave ghosting from the old panel.
        // The actual items are vertically CENTERED within the panel.
        const maxItems = __DEBUG__ ? 9 : 7;
        const itemH = 26;
        const topH = 30;
        const padding = 12;
        const panelH = topH + maxItems * itemH + padding * 2;
        const panelW = Math.min(620, screen.width - 80);
        const panelX = Math.floor((screen.width - panelW) / 2);
        const panelY = Math.floor((screen.height - panelH) / 2);
        // Center the actual items between the separator line and the
        // panel bottom (minus padding). This ensures the items column
        // is visually centered in the panel's content area.
        const itemsAreaStart = panelY + padding + topH + 4; // small gap below separator
        const itemsAreaEnd = panelY + panelH - padding;     // panel bottom minus padding
        const itemsAreaH = itemsAreaEnd - itemsAreaStart;
        const actualItemsH = items.length * itemH;
        const itemsOffset = Math.max(0, Math.floor((itemsAreaH - actualItemsH) / 2));
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        // OPAQUE panel background — no full-screen clear needed.
        // The game is visible AROUND the panel (outside its area).
        // The opaque panel covers any previous content underneath.
        ctx.fillStyle = '#161823';
        roundedRectPath(panelX, panelY, panelW, panelH, 8);
        ctx.fill();
        ctx.strokeStyle = '#3a3f4b'; ctx.lineWidth = 1;
        ctx.stroke();
        // Top bar.
        ctx.font = '18px sans-serif';
        ctx.fillStyle = '#9aa0b4';
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(topBar, panelX + padding, panelY + padding + 18);
        // Separator.
        ctx.fillStyle = '#3a3f4b';
        ctx.fillRect(panelX + padding, panelY + padding + topH, panelW - padding * 2, 1);
        // Items (vertically centered between separator and panel bottom).
        ctx.font = '22px sans-serif';
        for (let i = 0; i < items.length; i++) {
                const isSel = i === menu.selected;
                const y = itemsAreaStart + itemsOffset + (i + 1) * itemH;
                ctx.fillStyle = isSel ? '#3fb950' : '#c9cdd6';
                const prefix = isSel ? '> ' : '  ';
                ctx.fillText(prefix + labels[items[i]], panelX + padding, y);
        }
        ctx.restore();
}

/** Centered quit-confirmation dialog. NO background overlay — the game
 *  is fully visible behind the dialog box. */
function renderQuitDialog(): void {
        if (!ctx) return;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        // NO full-screen overlay — the game shows through.
        // Compact dialog box (centered, opaque).
        const boxW = 440, boxH = 140;
        const boxX = Math.floor((screen.width - boxW) / 2);
        const boxY = Math.floor((screen.height - boxH) / 2);
        ctx.fillStyle = '#1f2229';
        roundedRectPath(boxX, boxY, boxW, boxH, 10);
        ctx.fill();
        ctx.strokeStyle = '#3a3f4b'; ctx.lineWidth = 1;
        ctx.stroke();
        // Title.
        ctx.font = '24px sans-serif';
        ctx.fillStyle = '#f4f3ef';
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        // The title reflects the armed exit mode (set when the notice was
        // armed): "Quit BurialNX?" for a real exit (library grid Quit, or a
        // forwarder-launched game), "Return to library?" for a library-
        // launched game.
        ctx.fillText(message || 'Quit BurialNX?', screen.width / 2, boxY + 50);
        // Buttons.
        ctx.font = '18px sans-serif';
        ctx.fillStyle = '#3fb950';
        ctx.fillText('A: Yes', screen.width / 2 - 70, boxY + 95);
        ctx.fillStyle = '#f85149';
        ctx.fillText('B: No', screen.width / 2 + 70, boxY + 95);
        ctx.textAlign = 'left';
        ctx.restore();
}

/** Small centered popup for success/info notices — same visual style as
 *  renderQuitDialog (compact, centered, opaque rounded box, no full-screen
 *  overlay) but for single-button acknowledgment ("B: OK") instead of a
 *  yes/no question. Replaces the old full-screen `panel(...)` notice that
 *  hid the library/options screen behind a big dark rectangle.
 *
 *  The box auto-sizes to the message: long text (e.g. a forwarder path)
 *  word-wraps to a 480px max line width and the box grows downward, so a
 *  short "Name changed." gets a tidy little box while a long build result
 *  still fits without overflowing the screen.
 *
 *  The underlying screen shows through — the game keeps rendering during a
 *  game session, and for the library/game-options the previous frame's
 *  content is retained (those screens are static, so the stale frame reads
 *  as the real background). */
function renderNoticePopup(msg: string): void {
        if (!ctx) return;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        // Word-wrap the message so long notices (forwarder paths, multi-
        // sentence results) stay on screen. Use most of the screen width.
        const maxLineWidth = screen.width - 80;
        ctx.font = '22px sans-serif';
        ctx.textBaseline = 'alphabetic';
        // Split by whitespace, but also break long paths at '/' so a single
        // path like sdmc:/switch/The_Coffin_of_Andy_and_Leyley/The_Coffin_of_Andy_and_Leyley.nro
        // wraps across multiple lines instead of overflowing.
        const words = (msg || '').split(/\s+/).filter(Boolean);
        const lines: string[] = [];
        let line = '';
        const flush = () => { if (line) { lines.push(line); line = ''; } };
        for (const w of words) {
                // If the word itself is wider than maxLineWidth, break it at '/'
                // or '_' boundaries so long paths wrap nicely.
                if (ctx.measureText(w).width > maxLineWidth) {
                        if (line) { flush(); }
                        let chunk = '';
                        for (let i = 0; i < w.length; i++) {
                                const ch = w[i];
                                const test = chunk + ch;
                                if (ctx.measureText(test).width > maxLineWidth && chunk) {
                                        // Break after '/' so the next chunk starts cleanly.
                                        if (chunk.endsWith('/')) { lines.push(chunk); chunk = ch; }
                                        else { lines.push(chunk); chunk = ch; }
                                } else {
                                        chunk = test;
                                }
                        }
                        if (chunk) { line = chunk; }
                        flush();
                        continue;
                }
                const test = line ? line + ' ' + w : w;
                if (ctx.measureText(test).width > maxLineWidth && line) {
                        flush();
                        line = w;
                } else {
                        line = test;
                }
        }
        flush();
        if (!lines.length) lines.push('');
        // Box geometry — auto-size to the wrapped text.
        const padX = 36, padTop = 30, lineH = 28, btnH = 44;
        let maxW = 0;
        for (const l of lines) { const lw = ctx.measureText(l).width; if (lw > maxW) maxW = lw; }
        const boxW = Math.max(300, Math.min(maxW + padX * 2, maxLineWidth + padX * 2));
        const boxH = padTop + lines.length * lineH + btnH;
        const boxX = Math.floor((screen.width - boxW) / 2);
        const boxY = Math.floor((screen.height - boxH) / 2);
        // Box (opaque, rounded, subtle border — same palette as renderQuitDialog).
        ctx.fillStyle = '#1f2229';
        roundedRectPath(boxX, boxY, boxW, boxH, 12);
        ctx.fill();
        ctx.strokeStyle = '#3a3f4b'; ctx.lineWidth = 1;
        ctx.stroke();
        // Thin green accent bar on the left edge — a quiet "success/info"
        // cue that matches the 'ok' color used throughout the keymap UI.
        ctx.fillStyle = '#3fb950';
        ctx.fillRect(boxX, boxY + 12, 4, boxH - 24);
        // Message lines (centered).
        ctx.fillStyle = '#f4f3ef';
        ctx.textAlign = 'center';
        const textTop = boxY + padTop + 18;
        for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], boxX + boxW / 2, textTop + i * lineH);
        }
        // "B: OK" dismiss hint (centered, green).
        ctx.font = '18px sans-serif';
        ctx.fillStyle = '#3fb950';
        ctx.fillText('B: OK', boxX + boxW / 2, boxY + boxH - 16);
        ctx.textAlign = 'left';
        ctx.restore();
}
function fail(error: unknown, async = false) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
        log(`FAILURE: ${detail}`);
        if (phase === 'error') return;
        // Leftover asynchronous callbacks of a retired game (timers, audio
        // promises, late image loads) can still throw after the user quit the
        // app or returned to the error screen. Those errors can no longer be
        // acted on and must not hijack the loader with a red error screen;
        // log them and move on.
        if (async && gameStopped) { log('Suppressed asynchronous error from the stopped game.'); return; }
        snapshotRuntimeLog();
        message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        phase = 'error';
        // Stop game frames from painting over the loader's diagnostic screen.
        try { runtime.SceneManager?.stop?.(); } catch { /* keep the original error */ }
}
function failRequest(error: Error, responseText: string) {
        // Request completions are asynchronous by nature; when they arrive from
        // a game that was already stopped, fail() only logs them.
        fail(error, true);
        if (__DEBUG__ && responseText && responseText.length <= 2 * 1024 * 1024) try {
                void crypto.subtle.digest('SHA-256', new TextEncoder().encode(responseText)).then((digest) => {
                        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
                        log(`Failed response UTF-8 SHA-256: ${hash}`);
                }).catch((reason) => log(`Could not fingerprint failed response: ${String(reason)}`));
        } catch (reason) { log(`Could not fingerprint failed response: ${String(reason)}`); }
}

// === Session lifetime listeners ========================================
// The loader registers these three listeners ONCE on the process-lifetime
// globals. The beforeunload guard ALWAYS prevents the default so the Plus (+)
// button never exits on its own: quitting goes through the pause menu's
// "Quit BurialNX" entry or the double-press confirmation (quitApp sets
// allowExit before calling the real exit). The error/unhandledrejection
// listeners cancel the dispatched events: nx.js otherwise terminates the
// whole process ("Press + to exit" over a frozen screen) for ANY uncaught
// exception or floating promise — the loader shows its own recoverable
// error screen instead.
const sessionErrorListener = ((event: any) => {
        // Image 'error' events (fired when a cover PNG fails to decode) bubble
        // up to globalThis. They are not ErrorEvent and don't have .error or
        // .message. loadCoverImage already handles them via its own 'error'
        // listener (setting entry.failed and drawing a placeholder). Don't
        // double-handle here — that would show a spurious red error panel
        // every time a malformed cover is loaded.
        if (!event) return;
        if (event.error || event.message) {
                const error: unknown = event.error instanceof Error || typeof event.error === 'string' ? event.error : typeof event.message === 'string' ? event.message : null;
                if (error !== null) {
                        // nx.js terminates the whole process for an uncaught
                        // exception ("Press + to exit" over a frozen screen)
                        // unless the dispatched 'error' event is canceled. Take
                        // responsibility for the outcome instead: show our own
                        // recoverable error screen — or just log it when the
                        // error is residue of an already retired session.
                        try { event.preventDefault?.(); } catch { /* best-effort */ }
                        fail(error, true);
                }
        }
}) as EventListener;
const sessionRejectionListener = ((event: PromiseRejectionEvent) => {
        // Unhandled rejections are exactly as fatal as uncaught exceptions in
        // nx.js — and games are full of floating promises. Cancel the default
        // and let fail() decide whether the reason deserves a screen.
        try { event.preventDefault?.(); } catch { /* best-effort */ }
        fail(event.reason, true);
}) as EventListener;
// nx.js checks Plus (+) every frame and dispatches beforeunload when it is
// held; if the event is not canceled the runtime exits. The guard ALWAYS
// prevents the default so + never exits on its own: quitting goes through
// the pause menu or the double-press confirmation (quitApp sets allowExit
// before calling the real exit).
const sessionBeforeUnloadGuard = ((event: Event) => {
        if (!allowExit) event.preventDefault();
}) as EventListener;
function registerSessionListeners() {
        try { globalThis.addEventListener('error', sessionErrorListener); } catch { /* best-effort */ }
        try { globalThis.addEventListener('unhandledrejection', sessionRejectionListener); } catch { /* best-effort */ }
        try { globalThis.addEventListener('beforeunload', sessionBeforeUnloadGuard); } catch { /* best-effort */ }
}
/** Remove the beforeunload listener. Called BEFORE Switch.exit() to prevent
 *  nx.js from dispatching beforeunload during the exit process. The Atmosphere
 *  crash report showed infinite recursion (stack overflow) during exit: the
 *  repeating stack pattern (C++ → V8 → C++ → V8 → ...) indicates that
 *  Switch.exit() dispatches beforeunload, and the handler's execution triggers
 *  another beforeunload (or similar event), creating an unbreakable recursive
 *  loop that overflows the 1 MB stack. Removing ONLY the beforeunload listener
 *  breaks the cycle — the error and unhandledrejection listeners are KEPT so
 *  that residual errors from the retired game are still suppressed (the quit
 *  path test verifies this). Those listeners don't cause recursion because
 *  fail() has an early-return guard (if (phase === 'error') return). */
function removeBeforeUnloadListener() {
        try { globalThis.removeEventListener('beforeunload', sessionBeforeUnloadGuard); } catch { /* best-effort */ }
}

// === Cover image cache ==================================================
// nx.js's native Image decoder crashes (segfault, no catchable JS error)
// on some valid PNGs extracted from .exe resources — particularly
// PNG-embedded Windows icons that use features the native libpng build
// doesn't handle. To work around this, we:
//   1. Read the cover bytes ourselves via Switch.readFile
//   2. Validate the PNG signature + IHDR (bit depth, color type, interlace)
//   3. Convert to a base64 data: URL and set img.src to THAT instead of
//      the sdmc:/ path. The data URL path uses a different native code
//      path in nx.js that decodes from an in-memory buffer, avoiding
//      whatever file-fetch + decode interaction triggers the crash.
//   4. Log the IHDR details so a future crash report tells us exactly
//      which PNG format triggered it.
function loadCoverImage(path: string | null | undefined): { image: any; loaded: boolean; failed: boolean } {
        if (!path) return { image: null, loaded: false, failed: true };
        const cached = coverCache.get(path);
        if (cached) return cached;
        const entry = { image: null as any, loaded: false, failed: false };
        coverCache.set(path, entry);
        try {
                const NativeImage = (globalThis as any).Image;
                if (typeof NativeImage !== 'function') { entry.failed = true; return entry; }
                const img = new NativeImage();
                img.addEventListener('load', () => { entry.loaded = true; entry.image = img; });
                img.addEventListener('error', (event: any) => {
                        entry.failed = true;
                        log(`Cover load failed: ${path}`);
                        try { event?.stopPropagation?.(); } catch { /* best-effort */ }
                });
                // Read the PNG bytes ourselves so we can validate and log the
                // IHDR before handing the data to the native decoder. If the
                // file read fails, fall back to a direct path assignment.
                let bytes: ArrayBuffer | null = null;
                try { bytes = Switch.readFileSync(path); } catch (readErr) {
                        log(`Cover read failed: ${path}: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
                }
                if (!bytes || bytes.byteLength < 24) {
                        entry.failed = true;
                        log(`Cover too small or unreadable: ${path} (${bytes ? bytes.byteLength : 0} bytes)`);
                        return entry;
                }
                const u8 = new Uint8Array(bytes);
                // Detect the image format from the magic bytes so non-PNG
                // covers (JPEG, WebP, GIF) are decoded correctly. Previously
                // only PNG was accepted — JPEG/WebP files saved with a .png
                // extension failed the PNG signature check and showed a
                // question-mark placeholder.
                let mime: string | null = null;
                if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) mime = 'image/png';
                else if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) mime = 'image/jpeg';
                else if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) mime = 'image/gif';
                else if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) mime = 'image/webp';
                if (!mime) {
                        entry.failed = true;
                        log(`Cover unknown format: ${path} (first bytes: ${u8[0].toString(16)} ${u8[1].toString(16)} ${u8[2].toString(16)} ${u8[3].toString(16)})`);
                        return entry;
                }
                // For PNG, validate the IHDR to avoid native decoder crashes
                // on interlaced or unusual bit depths. Non-PNG formats are
                // passed directly to the native decoder (which handles them).
                if (mime === 'image/png') {
                        // IHDR is at offset 8+4+4 = 16 (after signature + length + type).
                        const ihdrView = new DataView(bytes, 16, 13);
                        const ihdrWidth = ihdrView.getUint32(0, false);
                        const ihdrHeight = ihdrView.getUint32(4, false);
                        const bitDepth = u8[24];
                        const colorType = u8[25];
                        const interlace = u8[28];
                        log(`Cover PNG: ${path} ${ihdrWidth}x${ihdrHeight} bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace} (${bytes.byteLength} bytes)`);
                        // nx.js's native decoder is known to crash on interlaced PNGs
                        // and on unusual bit depths (1, 2, 4, 16). Reject those
                        // preemptively so the app doesn't crash.
                        if (interlace !== 0) {
                                entry.failed = true;
                                log(`Cover rejected: interlaced PNG not supported (would crash native decoder)`);
                                return entry;
                        }
                        if (bitDepth !== 8) {
                                entry.failed = true;
                                log(`Cover rejected: bitDepth ${bitDepth} not supported (only 8-bit)`);
                                return entry;
                        }
                        if (colorType !== 2 && colorType !== 6) {
                                entry.failed = true;
                                log(`Cover rejected: colorType ${colorType} not supported (only 2=RGB, 6=RGBA)`);
                                return entry;
                        }
                } else {
                        log(`Cover ${mime}: ${path} (${bytes.byteLength} bytes)`);
                }
                // Convert to base64 data URL with the detected MIME type.
                // The native decoder takes a different code path for data:
                // URLs (in-memory buffer) vs sdmc:/ paths (file fetch), which
                // avoids the crash. Using the correct MIME type is critical
                // for non-PNG formats (JPEG, WebP, GIF) — the native decoder
                // needs to know the format to decode correctly.
                let binary = '';
                const CHUNK = 8192;
                for (let i = 0; i < u8.length; i += CHUNK) {
                        const chunk = u8.subarray(i, Math.min(i + CHUNK, u8.length));
                        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
                }
                const base64 = (typeof btoa === 'function') ? btoa(binary) : '';
                if (base64) {
                        img.src = `data:${mime};base64,${base64}`;
                } else {
                        // btoa not available — fall back to direct path
                        log(`Cover: btoa unavailable, falling back to direct path`);
                        img.src = path;
                }
        } catch (error) { entry.failed = true; log(`Cover init failed: ${path}: ${String(error)}`); }
        return entry;
}
function invalidateCoverCache() {
        // Do NOT call image.close() here — the canvas may still be referencing
        // the native pixel buffer for a queued drawImage. Closing the Image
        // would free the buffer underneath the renderer, which on Switch
        // manifests as a native crash (no catchable JS error). Let the GC
        // reclaim the Image naturally; the new cover loads into a fresh
        // Image object on the next renderLibrary call.
        coverCache.clear();
}

// === Library action-tile icons (bundled in romfs:/icons/) ===========
// Three PNG icons shipped inside the NRO's romfs: add.png, exit.png,
// settings.png. They're drawn STRETCHED to fill the cover area of the
// three library action tiles (240×230), with a text label under them
// (still inside the tile border). Loaded once at startup; reused for
// every renderLibrary call. If a romfs read fails, the tile falls back
// to the original centered-text rendering.
interface ActionIcon { image: any; loaded: boolean; failed: boolean; }
const actionIcons: ActionIcon[] = [
        { image: null, loaded: false, failed: false }, // add
        { image: null, loaded: false, failed: false }, // settings
        { image: null, loaded: false, failed: false }, // exit
];
const actionIconPaths = ['romfs:/icons/add.png', 'romfs:/icons/settings.png', 'romfs:/icons/exit.png'];
function loadActionIcons(): void {
        const NativeImage = (globalThis as any).Image;
        if (typeof NativeImage !== 'function') return;
        for (let i = 0; i < actionIconPaths.length; i++) {
                const path = actionIconPaths[i];
                const entry = actionIcons[i];
                if (entry.loaded || entry.failed) continue;
                try {
                        const bytes = Switch.readFileSync(path);
                        if (!bytes || bytes.byteLength < 24) { entry.failed = true; continue; }
                        const u8 = new Uint8Array(bytes);
                        // Basic PNG signature check — these are our own
                        // bundled files so they should always be valid,
                        // but be defensive.
                        if (u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) {
                                entry.failed = true;
                                log(`Action icon not a PNG: ${path}`);
                                continue;
                        }
                        const img = new NativeImage();
                        img.addEventListener('load', () => { entry.loaded = true; entry.image = img; });
                        img.addEventListener('error', (event: any) => {
                                entry.failed = true;
                                log(`Action icon load failed: ${path}`);
                                try { event?.stopPropagation?.(); } catch { /* best-effort */ }
                        });
                        // Convert to base64 data URL — same workaround as
                        // loadCoverImage (avoids the file-fetch+decode
                        // crash on the native decoder).
                        let binary = '';
                        const CHUNK = 8192;
                        for (let j = 0; j < u8.length; j += CHUNK) {
                                const chunk = u8.subarray(j, Math.min(j + CHUNK, u8.length));
                                binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
                        }
                        const base64 = (typeof btoa === 'function') ? btoa(binary) : '';
                        if (base64) img.src = `data:image/png;base64,${base64}`;
                        else { img.src = path; log(`Action icon: btoa unavailable, falling back to direct path`); }
                } catch (error) {
                        entry.failed = true;
                        log(`Action icon init failed: ${path}: ${String(error)}`);
                }
        }
}
// Kick off the loads at module init — they're async (Image 'load'
// event fires later), but the read+base64 work happens synchronously
// here so by the time renderLibrary is first called the images are
// either loaded or already marked failed.
loadActionIcons();

// === Library UI rendering ==============================================
// IMPORTANT: nx.js allocates ~2MB per ctx.font assignment. This function
// sets the font EXACTLY ONCE ('20px sans-serif') and never changes it.
// All text (header, tile labels, footer, placeholder '?') uses the same
// font. Visual variety comes from fillStyle (color) only.
function renderLibrary() {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#161823';
        ctx.fillRect(0, 0, screen.width, screen.height);
        // Set the font EXACTLY ONCE for the entire function.
        ctx.font = '20px sans-serif';
        ctx.textBaseline = 'alphabetic';
        // Header
        ctx.fillStyle = '#f4f3ef'; ctx.textAlign = 'left';
        ctx.fillText('BurialNX Library', 28, 40);
        ctx.fillStyle = '#9aa0b4';
        const totalPages = Math.max(1, Math.ceil((library.games.length + LIBRARY_ACTION_TILES) / LIBRARY_PAGE_SIZE));
        ctx.fillText(`Page ${libraryPage + 1}/${totalPages}  ·  ${library.games.length} game(s)  ·  L/R: reorder`, 28, 68);
        // Grid: 4 columns x 2 rows. Each tile 240x270, cover 240x230 + text 40px.
        const tileW = 240, tileH = 270, gap = 16;
        const gridW = LIBRARY_COLS * tileW + (LIBRARY_COLS - 1) * gap;
        const startX = Math.floor((screen.width - gridW) / 2);
        // Center vertically when only 1 row of tiles
        const totalRows = Math.ceil((library.games.length + LIBRARY_ACTION_TILES) / LIBRARY_COLS);
        const startY = totalRows <= 1 ? Math.floor((screen.height - tileH) / 2) : 100;
        const totalTiles = library.games.length + LIBRARY_ACTION_TILES;
        const pageStart = libraryPage * LIBRARY_PAGE_SIZE;
        const visible = Math.min(LIBRARY_PAGE_SIZE, totalTiles - pageStart);
        for (let i = 0; i < visible; i++) {
                const tileIndex = pageStart + i;
                const col = i % LIBRARY_COLS;
                const row = Math.floor(i / LIBRARY_COLS);
                const x = startX + col * (tileW + gap);
                const y = startY + row * (tileH + gap);
                const isAction = tileIndex >= library.games.length;
                const actionIdx = tileIndex - library.games.length;
                const selected = tileIndex === libraryCursor;
                ctx.fillStyle = selected ? '#3a3f5c' : '#252840';
                ctx.fillRect(x, y, tileW, tileH);
                // Selection border is drawn AFTER the cover/icon (below) so
                // it appears ON TOP of the cover image, not behind it.
                if (isAction) {
                        // Action tile: draw the bundled PNG icon SHRUNK by
                        // ~1/3 (to ~160×160 = 2/3 of the cover area width)
                        // and CENTERED in the cover area (240×230), with the
                        // text label UNDER it in the bottom 36px text strip
                        // — still inside the outlined tile border. The icon
                        // source PNGs are 512×512 square, so we draw at a
                        // square 160×160 to preserve their aspect ratio (no
                        // squish). If the icon load hasn't completed or
                        // failed, draw a placeholder in the cover area so
                        // the label still reads as a caption.
                        //   actionIdx 0 = "+ Add Game"      → add.png
                        //   actionIdx 1 = "Keymap Settings" → settings.png
                        //   actionIdx 2 = "Quit BurialNX"   → exit.png
                        const labels = ['+ Add Game', 'Keymap Settings', 'Quit BurialNX'];
                        const icon = actionIcons[actionIdx];
                        // Icon size = ~2/3 of the cover area's larger
                        // dimension (240 width → 160), rounded for clean
                        // pixel math. Centered horizontally AND vertically
                        // within the 240×230 cover area.
                        // The EXIT icon (actionIdx 2, "Quit BurialNX") is
                        // shrunk FURTHER by 2× (160 → 80) per the user's
                        // request — the exit/power glyph is visually
                        // heavier than the +/gear icons, so it needs to
                        // be smaller to feel balanced next to them.
                        const coverW = tileW;
                        const coverH = 230;
                        let iconSize = Math.floor(coverW * 2 / 3); // 160 px (default)
                        if (actionIdx === 2) iconSize = Math.floor(iconSize / 2); // 80 px (exit, halved)
                        const iconX = x + Math.floor((coverW - iconSize) / 2);
                        const iconY = y + Math.floor((coverH - iconSize) / 2);
                        if (icon && icon.loaded && icon.image) {
                                try {
                                        ctx.drawImage(icon.image, iconX, iconY, iconSize, iconSize);
                                } catch { drawPlaceholderCover(x, y, coverW, coverH); }
                        } else {
                                drawPlaceholderCover(x, y, coverW, coverH);
                        }
                        // Text label UNDER the icon, in the bottom 36px
                        // strip of the tile (y+234..y+270), still inside
                        // the outlined tile border.
                        ctx.fillStyle = '#f4f3ef';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(labels[actionIdx] || '', x + tileW / 2, y + 252);
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'alphabetic';
                } else {
                        const entry = library.games[tileIndex];
                        if (entry) {
                                const cover = loadCoverImage(entry.cover);
                                if (cover.loaded && cover.image) {
                                        try {
                                                const iw = cover.image.naturalWidth || cover.image.width || tileW;
                                                const ih = cover.image.naturalHeight || cover.image.height || 230;
                                                const scale = Math.min(tileW / iw, 230 / ih);
                                                const dw = iw * scale, dh = ih * scale;
                                                ctx.drawImage(cover.image, x + (tileW - dw) / 2, y + (230 - dh) / 2, dw, dh);
                                        } catch { drawPlaceholderCover(x, y, tileW, 230); }
                                } else if (cover.failed) drawPlaceholderCover(x, y, tileW, 230);
                                else { drawPlaceholderCover(x, y, tileW, 230); }
                                // Draw 'M' indicator in top-left corner if mod is present and enabled
                                const modOn = entry.mod !== undefined && entry.mod !== null && entry.modEnabled !== false;
                                if (modOn) {
                                        ctx.fillStyle = '#58a6ff';
                                        ctx.fillRect(x + 4, y + 4, 28, 28);
                                        ctx.fillStyle = '#161823'; ctx.textAlign = 'center';
                                        ctx.fillText('M', x + 18, y + 25);
                                        ctx.textAlign = 'left';
                                }
                                // Game name — marquee scroll if too long for the tile
                                ctx.fillStyle = '#f4f3ef';
                                ctx.textAlign = 'center';
                                // Clip the text to the tile width
                                ctx.save();
                                ctx.beginPath();
                                ctx.rect(x, y + 234, tileW, 36);
                                ctx.clip();
                                const maxNameW = tileW - 8;
                                const nameW = ctx.measureText(entry.name).width;
                                if (nameW <= maxNameW) {
                                        ctx.fillText(entry.name, x + tileW / 2, y + 252);
                                } else {
                                        // Scroll: append spaces + repeat the name
                                        const scrollText = entry.name + '   ';
                                        const scrollW = ctx.measureText(scrollText).width;
                                        const offset = -(marqueeOffset % scrollW);
                                        ctx.textAlign = 'left';
                                        ctx.fillText(scrollText, x + 4 + offset, y + 252);
                                        if (offset + scrollW < maxNameW) {
                                                ctx.fillText(scrollText, x + 4 + offset + scrollW, y + 252);
                                        }
                                }
                                ctx.restore();
                                ctx.textAlign = 'left';
                        }
                }
                // Draw the selection border ON TOP of everything (cover image,
                // action icon, text) so it's always visible — not hidden behind
                // the cover image.
                ctx.strokeStyle = selected ? '#f4f3ef' : '#3a3f5c';
                ctx.lineWidth = selected ? 3 : 1;
                ctx.strokeRect(x + 1, y + 1, tileW - 2, tileH - 2);
        }
        // Footer hint
        ctx.fillStyle = '#9aa0b4';
        ctx.fillText('D-pad: navigate (Up/Down: row)  A: Play  X: Options  Y: Add game  Hold Minus in Game: Menu  Plus: Quit', 28, screen.height - 24);
        ctx.restore();
}
function drawPlaceholderCover(x: number, y: number, w: number, h: number) {
        // Do NOT set ctx.font here — the caller (renderLibrary) already set it
        // to '20px sans-serif'. Changing it would allocate a new FontFace.
        ctx.save();
        ctx.fillStyle = '#1a1c2e';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#3a3f5c';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', x + w / 2, y + h / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.restore();
}

// === Game options UI ===================================================
// Compact, scrollable layout. With 14 menu items (after adding the
// forwarder entries) the old fixed-height panel overflowed the screen.
// The new layout:
//   - Title (1 line, 20px, white)
//   - 6 header info lines (18px, grey — combined to save vertical space)
//   - A separator line
//   - A scrollable window of menu items (22px, white/green cursor) that
//     auto-scrolls to keep the cursor visible. ▲/▼ indicators on the
//     right margin show when more items exist above/below.
function renderGameOptions() {
        if (!currentEntry) { phase = 'library'; return; }
        if (!ctx) return;
        const hasPerGameKeymap = !!currentEntry.keymap;
        const hasMod = currentEntry.mod !== undefined && currentEntry.mod !== null;
        const modOn = hasMod && currentEntry.modEnabled !== false;
        const hasForwarder = forwarderExists(Switch as unknown as LibraryAccess, currentEntry.name, currentEntry.id);
        // --- Header info (combined to 6 lines to save vertical space). ---
        const coverLabel = currentEntry.cover ? currentEntry.cover.split('/').pop() || currentEntry.cover : '(none)';
        const modLabel = hasMod ? `${modOn ? 'ON' : 'OFF'} — ${currentEntry.mod!.split('/').pop() || currentEntry.mod}` : '(none)';
        const saveLabel = currentEntry.saves ? (currentEntry.saves.kind === 'switch' ? 'Switch user data' : (currentEntry.saves.folder.split('/').pop() || currentEntry.saves.folder)) : '(not set)';
        const fwdLabel = hasForwarder ? 'created' : '(none)';
        const headers: string[] = [
                `Game: ${currentEntry.name}`,
                `Path: ${truncateForDisplay(currentEntry.root, 70)}`,
                `Cover: ${coverLabel}  |  Shared saves: ${currentEntry.sharedSaves ? 'yes' : 'no'}`,
                `Mod: ${modLabel}  |  Keymap: ${hasPerGameKeymap ? 'per-game' : 'global'}`,
                `Save: ${saveLabel}  |  Forwarder: ${fwdLabel}`,
        ];
        // --- Menu items (14 or 15 depending on language availability). ---
        // The "Language" option is inserted between "Change save folder" and
        // "Create forwarder" only when the game ships at least one .cld pack
        // (which means 2+ total languages counting the embedded English data).
        const hasLanguages = currentGameLanguages.length > 0;
        // Determine the current language label for display.
        let langLabel = '(unknown)';
        if (currentEntry) {
                const savedRaw = currentEntry.language; // from library file (SD card)
                if (savedRaw === undefined) {
                        // No preference → default to first .cld (Russian) if available
                        langLabel = currentGameLanguages[0]?.name || currentGameLanguages[0]?.code || 'English (default)';
                } else if (savedRaw === '') {
                        langLabel = 'English (default)';
                } else {
                        const entry2 = currentGameLanguages.find((e) => e.code === savedRaw);
                        langLabel = entry2?.name || savedRaw;
                }
        }
        const items: string[] = [
                'Play',
                'Pick cover image',
                'Auto-detect cover from .exe/.ico',
                'Edit keymap (this game)',
                hasPerGameKeymap ? 'Reset to global keymap' : '(no per-game keymap to reset)',
                'Rename game',
                hasMod ? 'Change mod folder' : 'Select mod folder',
                modOn ? 'Disable mod' : (hasMod ? 'Enable mod' : '(no mod to toggle)'),
                'Toggle shared saves',
                'Change save folder',
        ];
        if (hasLanguages) items.push(`Language: ${langLabel}`);
        items.push(
                hasForwarder ? 'Recreate forwarder NRO' : 'Create forwarder NRO',
                hasForwarder ? 'Delete forwarder NRO' : '(no forwarder to delete)',
                'Delete from library',
                'Back to library (B)',
        );
        // --- Layout constants. ---
        const titleY = 26;
        const headerFont = '18px sans-serif';
        const headerSpacing = 20;
        const headerStartY = 50;
        const itemsStartY = headerStartY + headers.length * headerSpacing + 30; // + separator gap (enough room below the line)
        const itemFont = '22px sans-serif';
        const itemSpacing = 26;
        const bottomMargin = 14;
        const visibleItems = Math.max(1, Math.floor((screen.height - itemsStartY - bottomMargin) / itemSpacing));
        const maxScroll = Math.max(0, items.length - visibleItems);
        // Adjust scroll so the cursor stays visible.
        if (gameOptionsCursor < gameOptionsScroll) gameOptionsScroll = gameOptionsCursor;
        else if (gameOptionsCursor >= gameOptionsScroll + visibleItems) gameOptionsScroll = gameOptionsCursor - visibleItems + 1;
        gameOptionsScroll = Math.max(0, Math.min(gameOptionsScroll, maxScroll));
        // --- Draw. ---
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#161823';
        ctx.fillRect(0, 0, screen.width, screen.height);
        // Title.
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.font = '20px sans-serif';
        ctx.fillStyle = '#f4f3ef';
        ctx.fillText('BurialNX — game options', 28, titleY);
        // Header info.
        ctx.font = headerFont;
        ctx.fillStyle = '#9aa0b4';
        headers.forEach((h, i) => ctx.fillText(h, 28, headerStartY + i * headerSpacing, screen.width - 56));
        // Separator.
        const sepY = headerStartY + headers.length * headerSpacing + 6;
        ctx.fillStyle = '#3a3f4b';
        ctx.fillRect(28, sepY, screen.width - 56, 1);
        // Menu items.
        ctx.font = itemFont;
        const maxItemW = screen.width - 80; // leave room for the scroll indicators
        for (let i = 0; i < visibleItems; i++) {
                const idx = gameOptionsScroll + i;
                if (idx >= items.length) break;
                const isCursor = idx === gameOptionsCursor;
                const y = itemsStartY + i * itemSpacing;
                ctx.fillStyle = isCursor ? '#3fb950' : '#c9cdd6';
                const prefix = isCursor ? '> ' : '  ';
                ctx.fillText(prefix + items[idx], 28, y, maxItemW);
        }
        // Scroll indicators (right margin).
        ctx.font = '16px sans-serif';
        ctx.fillStyle = '#6e7681';
        ctx.textAlign = 'center';
        if (gameOptionsScroll > 0) ctx.fillText('▲', screen.width - 30, itemsStartY + 6);
        if (gameOptionsScroll < maxScroll) ctx.fillText('▼', screen.width - 30, itemsStartY + (visibleItems - 1) * itemSpacing + 6);
        ctx.textAlign = 'left';
        ctx.restore();
}

/** Truncate a string to at most `max` characters, appending '…' if it
 *  was shortened. Used by renderGameOptions for long paths. */
function truncateForDisplay(s: string, max: number): string {
        if (s.length <= max) return s;
        return s.slice(0, max - 1) + '…';
}

// === Keymap UI =========================================================
// Two-phase key remap UI inspired by autorun's launcher_input.c:
//   Phase 1 (button grid): 4×4 grid of joycon buttons with their current
//     bindings. User navigates with D-pad, presses A to edit a button.
//   Phase 2 (keyboard+mouse): visual PC keyboard + mouse. User navigates
//     with D-pad, presses A to bind the selected key to the joycon button
//     from phase 1. Press B to go back to phase 1.
//
// IMPORTANT: nx.js allocates ~2MB per ctx.font assignment. Both renderers
// set ctx.font EXACTLY ONCE and never change it. Visual variety comes from
// fillStyle (colors) only.
const KEYMAP_COLORS: Record<string, string> = {
        ok: '#3fb950', cancel: '#f85149', shift: '#a371f7', menu: '#58a6ff',
        control: '#f0883e', tab: '#f0883e', escape: '#f85149',
        pageup: '#d2a8ff', pagedown: '#d2a8ff',
        up: '#56d364', down: '#56d364', left: '#56d364', right: '#56d364',
        none: '#6e7681',
};

// Full PC keyboard layout (adapted from autorun's launcher_input.c keycap
// array). Positions are in "key units" (1 unit = 1 standard key width).
// The keyboard occupies x=0..15, y=0..5.3. The navigation + arrow cluster
// is at x=15.5..20 (3 columns of 1.5-unit keys, touching — no gaps — so the
// right block reads as one evenly-stretched unit like a real keyboard).
// Each key has a JavaScript keyCode and is looked up in KEYCODE_TO_VKEY.
interface KeyDef { label: string; keyCode: number; x: number; y: number; w: number; h: number; }
const KEYBOARD_LAYOUT: KeyDef[] = [
        // Row 0: function keys (y=0)
        { label: 'Esc', keyCode: 27, x: 0, y: 0, w: 1, h: 1 },
        { label: 'F1', keyCode: 112, x: 2, y: 0, w: 1, h: 1 }, { label: 'F2', keyCode: 113, x: 3, y: 0, w: 1, h: 1 },
        { label: 'F3', keyCode: 114, x: 4, y: 0, w: 1, h: 1 }, { label: 'F4', keyCode: 115, x: 5, y: 0, w: 1, h: 1 },
        { label: 'F5', keyCode: 116, x: 6.5, y: 0, w: 1, h: 1 }, { label: 'F6', keyCode: 117, x: 7.5, y: 0, w: 1, h: 1 },
        { label: 'F7', keyCode: 118, x: 8.5, y: 0, w: 1, h: 1 }, { label: 'F8', keyCode: 119, x: 9.5, y: 0, w: 1, h: 1 },
        { label: 'F9', keyCode: 120, x: 11, y: 0, w: 1, h: 1 }, { label: 'F10', keyCode: 121, x: 12, y: 0, w: 1, h: 1 },
        { label: 'F11', keyCode: 122, x: 13, y: 0, w: 1, h: 1 }, { label: 'F12', keyCode: 123, x: 14, y: 0, w: 1, h: 1 },
        // Row 1: number row (y=1.3)
        { label: '`', keyCode: 192, x: 0, y: 1.3, w: 1, h: 1 },
        { label: '1', keyCode: 49, x: 1, y: 1.3, w: 1, h: 1 }, { label: '2', keyCode: 50, x: 2, y: 1.3, w: 1, h: 1 },
        { label: '3', keyCode: 51, x: 3, y: 1.3, w: 1, h: 1 }, { label: '4', keyCode: 52, x: 4, y: 1.3, w: 1, h: 1 },
        { label: '5', keyCode: 53, x: 5, y: 1.3, w: 1, h: 1 }, { label: '6', keyCode: 54, x: 6, y: 1.3, w: 1, h: 1 },
        { label: '7', keyCode: 55, x: 7, y: 1.3, w: 1, h: 1 }, { label: '8', keyCode: 56, x: 8, y: 1.3, w: 1, h: 1 },
        { label: '9', keyCode: 57, x: 9, y: 1.3, w: 1, h: 1 }, { label: '0', keyCode: 48, x: 10, y: 1.3, w: 1, h: 1 },
        { label: '-', keyCode: 189, x: 11, y: 1.3, w: 1, h: 1 }, { label: '=', keyCode: 187, x: 12, y: 1.3, w: 1, h: 1 },
        { label: 'Bksp', keyCode: 8, x: 13, y: 1.3, w: 2, h: 1 },
        // Row 2: QWERTY (y=2.3)
        { label: 'Tab', keyCode: 9, x: 0, y: 2.3, w: 1.5, h: 1 },
        { label: 'Q', keyCode: 81, x: 1.5, y: 2.3, w: 1, h: 1 }, { label: 'W', keyCode: 87, x: 2.5, y: 2.3, w: 1, h: 1 },
        { label: 'E', keyCode: 69, x: 3.5, y: 2.3, w: 1, h: 1 }, { label: 'R', keyCode: 82, x: 4.5, y: 2.3, w: 1, h: 1 },
        { label: 'T', keyCode: 84, x: 5.5, y: 2.3, w: 1, h: 1 }, { label: 'Y', keyCode: 89, x: 6.5, y: 2.3, w: 1, h: 1 },
        { label: 'U', keyCode: 85, x: 7.5, y: 2.3, w: 1, h: 1 }, { label: 'I', keyCode: 73, x: 8.5, y: 2.3, w: 1, h: 1 },
        { label: 'O', keyCode: 79, x: 9.5, y: 2.3, w: 1, h: 1 }, { label: 'P', keyCode: 80, x: 10.5, y: 2.3, w: 1, h: 1 },
        { label: '[', keyCode: 219, x: 11.5, y: 2.3, w: 1, h: 1 }, { label: ']', keyCode: 221, x: 12.5, y: 2.3, w: 1, h: 1 },
        { label: '\\', keyCode: 220, x: 13.5, y: 2.3, w: 1.5, h: 1 },
        // Row 3: ASDF (y=3.3)
        { label: 'Caps', keyCode: 20, x: 0, y: 3.3, w: 1.75, h: 1 },
        { label: 'A', keyCode: 65, x: 1.75, y: 3.3, w: 1, h: 1 }, { label: 'S', keyCode: 83, x: 2.75, y: 3.3, w: 1, h: 1 },
        { label: 'D', keyCode: 68, x: 3.75, y: 3.3, w: 1, h: 1 }, { label: 'F', keyCode: 70, x: 4.75, y: 3.3, w: 1, h: 1 },
        { label: 'G', keyCode: 71, x: 5.75, y: 3.3, w: 1, h: 1 }, { label: 'H', keyCode: 72, x: 6.75, y: 3.3, w: 1, h: 1 },
        { label: 'J', keyCode: 74, x: 7.75, y: 3.3, w: 1, h: 1 }, { label: 'K', keyCode: 75, x: 8.75, y: 3.3, w: 1, h: 1 },
        { label: 'L', keyCode: 76, x: 9.75, y: 3.3, w: 1, h: 1 }, { label: ';', keyCode: 186, x: 10.75, y: 3.3, w: 1, h: 1 },
        { label: "'", keyCode: 222, x: 11.75, y: 3.3, w: 1, h: 1 }, { label: 'Enter', keyCode: 13, x: 12.75, y: 3.3, w: 2.25, h: 1 },
        // Row 4: ZXCV (y=4.3)
        { label: 'Shift', keyCode: 16, x: 0, y: 4.3, w: 2.25, h: 1 },
        { label: 'Z', keyCode: 90, x: 2.25, y: 4.3, w: 1, h: 1 }, { label: 'X', keyCode: 88, x: 3.25, y: 4.3, w: 1, h: 1 },
        { label: 'C', keyCode: 67, x: 4.25, y: 4.3, w: 1, h: 1 }, { label: 'V', keyCode: 86, x: 5.25, y: 4.3, w: 1, h: 1 },
        { label: 'B', keyCode: 66, x: 6.25, y: 4.3, w: 1, h: 1 }, { label: 'N', keyCode: 78, x: 7.25, y: 4.3, w: 1, h: 1 },
        { label: 'M', keyCode: 77, x: 8.25, y: 4.3, w: 1, h: 1 }, { label: ',', keyCode: 188, x: 9.25, y: 4.3, w: 1, h: 1 },
        { label: '.', keyCode: 190, x: 10.25, y: 4.3, w: 1, h: 1 }, { label: '/', keyCode: 191, x: 11.25, y: 4.3, w: 1, h: 1 },
        { label: 'Shift', keyCode: 16, x: 12.25, y: 4.3, w: 2.75, h: 1 },
        // Row 5: bottom (y=5.3)
        { label: 'Ctrl', keyCode: 17, x: 0, y: 5.3, w: 1.5, h: 1 }, { label: 'Win', keyCode: 91, x: 1.5, y: 5.3, w: 1.25, h: 1 },
        { label: 'Alt', keyCode: 18, x: 2.75, y: 5.3, w: 1.25, h: 1 }, { label: 'Space', keyCode: 32, x: 4, y: 5.3, w: 6, h: 1 },
        { label: 'Alt', keyCode: 18, x: 10, y: 5.3, w: 1.25, h: 1 }, { label: 'Win', keyCode: 92, x: 11.25, y: 5.3, w: 1.25, h: 1 },
        { label: 'Menu', keyCode: 93, x: 12.5, y: 5.3, w: 1.25, h: 1 }, { label: 'Ctrl', keyCode: 17, x: 13.75, y: 5.3, w: 1.25, h: 1 },
        // Navigation cluster + arrow keys — 3 columns, each key 1.5 units
        // wide and TOUCHING (no gap), so the whole right block reads as one
        // evenly-stretched unit like a real keyboard's nav/arrow cluster.
        // Col1 x=15.5, Col2 x=17, Col3 x=18.5 (each w=1.5, adjacent).
        { label: 'Prt', keyCode: 44, x: 15.5, y: 0, w: 1.5, h: 1 }, { label: 'Scr', keyCode: 145, x: 17, y: 0, w: 1.5, h: 1 },
        { label: 'Pause', keyCode: 19, x: 18.5, y: 0, w: 1.5, h: 1 },
        { label: 'Ins', keyCode: 45, x: 15.5, y: 1.3, w: 1.5, h: 1 }, { label: 'Home', keyCode: 36, x: 17, y: 1.3, w: 1.5, h: 1 },
        { label: 'PgUp', keyCode: 33, x: 18.5, y: 1.3, w: 1.5, h: 1 },
        { label: 'Del', keyCode: 46, x: 15.5, y: 2.3, w: 1.5, h: 1 }, { label: 'End', keyCode: 35, x: 17, y: 2.3, w: 1.5, h: 1 },
        { label: 'PgDn', keyCode: 34, x: 18.5, y: 2.3, w: 1.5, h: 1 },
        // Arrow keys — same 3 columns, 1.5-unit width, touching (no gaps),
        // matching the nav cluster above so the whole right block reads as
        // one evenly-stretched unit like a real keyboard's arrow cluster.
        { label: '↑', keyCode: 38, x: 17, y: 4.3, w: 1.5, h: 1 },
        { label: '←', keyCode: 37, x: 15.5, y: 5.3, w: 1.5, h: 1 }, { label: '↓', keyCode: 40, x: 17, y: 5.3, w: 1.5, h: 1 },
        { label: '→', keyCode: 39, x: 18.5, y: 5.3, w: 1.5, h: 1 },
        // "none" key — clears the binding (keyCode 0 → 'none' fallback).
        // Positioned right of Esc with same spacing as Esc→backtick.
        { label: 'none', keyCode: 0, x: 1, y: 0, w: 1, h: 1 },
        // Virtual key buttons — processed as gamepad vkeys (NOT keyboard
        // keyCodes). When selected, keyCode=0 means "use gamepadMapper".
        // Arranged in TWO centered rows below the keyboard:
        //   row 1 (y=7.7): ok, cancel, shift, menu, pageup, pagedown, escape
        //   row 2 (y=8.7): tab, up, down, left, right, control
        // The gap between the keyboard bottom (y=6.3) and vkey row 1 (y=7.7)
        // is 1.4 units — DOUBLE the original 0.7-unit gap, so the joystick
        // action section sits clearly apart from the PC keyboard.
        // Width = 2.4 (×55px scale = 132px, with -2px padding = 130px
        // text area) — wide enough for the longest label "pagedown"
        // (~110px in the Switch system sans-serif at 20px) to fit
        // comfortably with ~20px of margin.
        // Row 1 total = 7 × 2.4 = 16.8 units; centered at x=-0.9
        // (slightly past the keyboard left/right edges, but the nav
        // cluster sits at y=0..2.3, so y=7.7 is clear).
        // Row 2 total = 6 × 2.4 = 14.4 units; centered at x=0.3.
        { label: 'ok', keyCode: -1, x: -0.9, y: 7.7, w: 2.4, h: 1 },
        { label: 'cancel', keyCode: -1, x: 1.5, y: 7.7, w: 2.4, h: 1 },
        { label: 'shift', keyCode: -1, x: 3.9, y: 7.7, w: 2.4, h: 1 },
        { label: 'menu', keyCode: -1, x: 6.3, y: 7.7, w: 2.4, h: 1 },
        { label: 'pageup', keyCode: -1, x: 8.7, y: 7.7, w: 2.4, h: 1 },
        { label: 'pagedown', keyCode: -1, x: 11.1, y: 7.7, w: 2.4, h: 1 },
        { label: 'escape', keyCode: -1, x: 13.5, y: 7.7, w: 2.4, h: 1 },
        { label: 'tab', keyCode: -1, x: 0.3, y: 8.7, w: 2.4, h: 1 },
        { label: 'up', keyCode: -1, x: 2.7, y: 8.7, w: 2.4, h: 1 },
        { label: 'down', keyCode: -1, x: 5.1, y: 8.7, w: 2.4, h: 1 },
        { label: 'left', keyCode: -1, x: 7.5, y: 8.7, w: 2.4, h: 1 },
        { label: 'right', keyCode: -1, x: 9.9, y: 8.7, w: 2.4, h: 1 },
        { label: 'control', keyCode: -1, x: 12.3, y: 8.7, w: 2.4, h: 1 },
];
// RPG Maker MV default keyMapper: keyCode → virtual key.
// Number keys (48-57) are not in the default MV keyMapper, but we map them
// to 'ok' so that binding a joycon button to "1", "2", "5", etc. produces
// a meaningful action (menu/selection confirmation) instead of 'none'.
const KEYCODE_TO_VKEY: Record<number, VirtualKey> = {
        9: 'tab', 13: 'ok', 16: 'shift', 17: 'control', 18: 'control', 27: 'cancel',
        32: 'ok', 33: 'pageup', 34: 'pagedown', 37: 'left', 38: 'up', 39: 'right', 40: 'down',
        45: 'escape', 81: 'pageup', 82: 'pagedown', 87: 'up', 88: 'cancel', 89: 'ok', 90: 'ok',
        48: 'ok', 49: 'ok', 50: 'ok', 51: 'ok', 52: 'ok', 53: 'ok', 54: 'ok', 55: 'ok', 56: 'ok', 57: 'ok',
};
// Mouse buttons removed — RPG Maker MV games use TouchInput for touch,
// not mouse events. Touch support is handled by forwarding screen touch
// events to document in installGameCompatibility.
// Combined pickable list: keyboard keys + virtual-key action buttons.
// Created lazily when the keyboard picker opens, not at module scope.
// Each entry carries the label, the vkey it resolves to, and the keyCode
// to forward to Input._onKeyDown (0 for vkey-only buttons that use
// gamepadMapper).
let _allPickKeys: { label: string; vkey: VirtualKey; keyCode: number }[] | null = null;
function getAllPickKeys() {
        if (!_allPickKeys) _allPickKeys = KEYBOARD_LAYOUT.map(k => {
                if (k.keyCode === -1) {
                        // Virtual-key action button — vkey is the label itself
                        // ('ok', 'cancel', etc.); no keyCode to forward.
                        return { label: k.label, vkey: k.label as VirtualKey, keyCode: 0 };
                }
                return { label: k.label, vkey: KEYCODE_TO_VKEY[k.keyCode] || ('none' as VirtualKey), keyCode: k.keyCode };
        });
        return _allPickKeys;
}

// Spatial navigation: find the nearest key in the given direction.
// For Left/Right: constrain to the SAME ROW (Y distance < 0.6 units)
// so the cursor doesn't jump to a different row when moving horizontally.
// For Up/Down: use full spatial navigation (nearest key above/below).
function findNearestKey(curIdx: number, dx: number, dy: number): number {
        const ALL_PICK_KEYS = getAllPickKeys();
        if (!ALL_PICK_KEYS.length) return 0;
        const cur = curIdx < KEYBOARD_LAYOUT.length ? KEYBOARD_LAYOUT[curIdx] : null;
        if (!cur) {
                if (dy < 0) return 0;
                if (dx < 0 && curIdx > KEYBOARD_LAYOUT.length) return KEYBOARD_LAYOUT.length - 1;
                return curIdx;
        }
        const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
        let bestIdx = curIdx, bestDist = Infinity;
        for (let i = 0; i < KEYBOARD_LAYOUT.length; i++) {
                if (i === curIdx) continue;
                const k = KEYBOARD_LAYOUT[i];
                const kx = k.x + k.w / 2, ky = k.y + k.h / 2;
                const ddx = kx - cx, ddy = ky - cy;
                if (dx > 0 && ddx <= 0) continue;
                if (dx < 0 && ddx >= 0) continue;
                if (dy > 0 && ddy <= 0) continue;
                if (dy < 0 && ddy >= 0) continue;
                // For horizontal movement: require same row (small Y difference)
                if (dx !== 0 && Math.abs(ddy) > 0.6) continue;
                // For vertical movement: require same column-ish (small X difference)
                const dist = dx !== 0 ? Math.abs(ddx) : Math.abs(ddy) + Math.abs(ddx) * 0.3;
                if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        if (dx > 0 && bestIdx === curIdx && cur.x + cur.w >= 14) return KEYBOARD_LAYOUT.length;
        return bestIdx;
}

// Phase 1 = button grid (select which joycon button to edit)
// Phase 2 = keyboard+mouse (pick a key to bind)
let keymapPicking = false;
let keymapPickCursor = 0;

// === Shared layout + touch helpers for keymap pages =============
// Single source of truth for the keymap-page geometry. Both the
// renderers (which DRAW the cells/keys) and the touch handler (which
// HIT-TESTS taps on them) read from these constants so a tap on a
// cell always lands inside the rectangle the user can see.
const KEYMAP_GRID_COLS = 4;
const KEYMAP_GRID_ROWS = 6;
const KEYMAP_CELL_W = 280, KEYMAP_CELL_H = 85, KEYMAP_CELL_GAP = 8;
const KEYMAP_GRID_START_Y = 108;
const KEYMAP_KB_SCALE = 55;
const KEYMAP_KB_UNITS_W = 20; // keyboard x=0..15 + nav cluster x=15.5..20
const KEYMAP_KB_UNITS_H = 9.7; // keyboard y=0..5.3 + doubled gap + vkey rows y=7.7..9.7

interface Rect { x: number; y: number; w: number; h: number; }

function keymapButtonCellRect(i: number): Rect {
        const c = i % KEYMAP_GRID_COLS, r = Math.floor(i / KEYMAP_GRID_COLS);
        const gridW = KEYMAP_GRID_COLS * KEYMAP_CELL_W + (KEYMAP_GRID_COLS - 1) * KEYMAP_CELL_GAP;
        const startX = Math.floor((screen.width - gridW) / 2);
        return {
                x: startX + c * (KEYMAP_CELL_W + KEYMAP_CELL_GAP),
                y: KEYMAP_GRID_START_Y + r * (KEYMAP_CELL_H + KEYMAP_CELL_GAP),
                w: KEYMAP_CELL_W, h: KEYMAP_CELL_H,
        };
}

function keymapKbOrigin(): { x: number; y: number } {
        const kbMaxW = KEYMAP_KB_UNITS_W * KEYMAP_KB_SCALE;
        const kbMaxH = KEYMAP_KB_UNITS_H * KEYMAP_KB_SCALE;
        return {
                x: Math.floor((screen.width - kbMaxW) / 2),
                y: Math.floor((screen.height - kbMaxH) / 2),
        };
}

function keymapKeyRect(i: number): Rect | null {
        const k = KEYBOARD_LAYOUT[i];
        if (!k) return null;
        const o = keymapKbOrigin();
        return {
                x: o.x + k.x * KEYMAP_KB_SCALE,
                y: o.y + k.y * KEYMAP_KB_SCALE,
                w: k.w * KEYMAP_KB_SCALE,
                h: k.h * KEYMAP_KB_SCALE,
        };
}

function keymapBackButtonRect(): Rect {
        return { x: screen.width - 140, y: 24, w: 112, h: 44 };
}

function pointInRect(px: number, py: number, r: Rect): boolean {
        return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function drawBackButton(): void {
        const r = keymapBackButtonRect();
        ctx.fillStyle = '#252840';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = '#565f8d';
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        ctx.fillStyle = '#f4f3ef';
        ctx.textAlign = 'center';
        ctx.fillText('← Back', r.x + r.w / 2, r.y + r.h / 2 + 7);
        ctx.textAlign = 'left';
}

/** Route a single touch tap on the keymap page to the same action as
 *  the gamepad A button: tap a cell/key = move cursor + confirm in one
 *  motion. Tap the "← Back" button (top-right) = same as the B button.
 *  Tapping anywhere else does nothing — the user must hit a real UI
 *  element, which makes the touch zones unambiguous. */
function handleKeymapTouch(px: number, py: number): void {
        if (pointInRect(px, py, keymapBackButtonRect())) {
                if (keymapPicking) {
                        keymapPicking = false;
                        waitForRelease = true;
                } else {
                        waitForRelease = true;
                        phase = host ? 'game' : 'library';
                        if (host) menu.dismiss();
                }
                return;
        }
        if (keymapPicking) {
                for (let i = 0; i < KEYBOARD_LAYOUT.length; i++) {
                        const r = keymapKeyRect(i);
                        if (r && pointInRect(px, py, r)) {
                                keymapPickCursor = i;
                                const def = getAllPickKeys()[i];
                                if (def && def.label) {
                                        if (keymapCursor < 16) {
                                                editingKeymap = setButtonWithLabel(editingKeymap, keymapCursor, def.vkey, def.label, def.keyCode);
                                        } else {
                                                const stickDirs = ['lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight'] as const;
                                                const dir = stickDirs[keymapCursor - 16];
                                                if (!editingKeymap.sticks) editingKeymap.sticks = {};
                                                editingKeymap.sticks[dir] = { keyCode: def.keyCode || 0, label: def.label };
                                        }
                                        saveEditingKeymap();
                                        keymapPicking = false;
                                        waitForRelease = true;
                                }
                                return;
                        }
                }
        } else {
                for (let i = 0; i < 24; i++) {
                        const r = keymapButtonCellRect(i);
                        if (pointInRect(px, py, r)) {
                                keymapCursor = i;
                                keymapPicking = true;
                                keymapPickCursor = 0;
                                waitForRelease = true;
                                return;
                        }
                }
        }
}

function renderKeymap() {
        const targetLabel = keymapTarget === 'global' ? 'GLOBAL DEFAULT' : (keymapTarget ? `PER-GAME: ${keymapTarget.name}` : '(none)');
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#161823';
        ctx.fillRect(0, 0, screen.width, screen.height);
        // Set the font EXACTLY ONCE for the entire function.
        ctx.font = '20px sans-serif';
        ctx.textBaseline = 'alphabetic';

        if (keymapPicking) {
                renderKeyboardPicker(targetLabel);
        } else {
                renderButtonGrid(targetLabel);
        }
        ctx.restore();
}

function renderButtonGrid(targetLabel: string) {
        // Header
        ctx.fillStyle = '#f4f3ef'; ctx.textAlign = 'left';
        ctx.fillText('BurialNX — Joycon key bindings', 28, 36);
        ctx.fillStyle = '#9aa0b4';
        ctx.fillText(`Editing: ${targetLabel}`, 28, 60);
        ctx.fillText('D-pad / tap: pick  X: clear  L/R/ZL/ZR: presets  B / ← Back: back', 28, 84);
        // Back button (also a touch target).
        drawBackButton();
        // Grid: 4 columns × 6 rows = 24 entries (16 buttons + 8 stick dirs).
        // Smaller cells to fit 6 rows on screen.
        const cols = KEYMAP_GRID_COLS;
        const totalEntries = 24;
        const stickNames = ['L↑', 'L↓', 'L←', 'L→', 'R↑', 'R↓', 'R←', 'R→'];
        const stickDirs = ['lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight'] as const;
        const cellW = KEYMAP_CELL_W, cellH = KEYMAP_CELL_H;
        for (let i = 0; i < totalEntries; i++) {
                const rect = keymapButtonCellRect(i);
                const x = rect.x, y = rect.y;
                const selected = i === keymapCursor;
                const isStick = i >= 16;
                // Get the display label and color.
                let displayLabel: string;
                let color: string;
                if (isStick) {
                        const dir = stickDirs[i - 16];
                        const binding = editingKeymap.sticks?.[dir];
                        displayLabel = binding ? binding.label : 'none';
                        color = KEYMAP_COLORS[displayLabel as VirtualKey] || '#6e7681';
                } else {
                        const key = editingKeymap.buttons[i];
                        displayLabel = editingKeymap.labels?.[i] || key;
                        color = KEYMAP_COLORS[key] || '#6e7681';
                }
                ctx.fillStyle = selected ? '#3a3f5c' : '#252840';
                ctx.fillRect(x, y, cellW, cellH);
                ctx.fillStyle = color;
                ctx.fillRect(x, y, 6, cellH);
                ctx.strokeStyle = selected ? '#f4f3ef' : '#3a3f5c';
                ctx.lineWidth = selected ? 3 : 1;
                ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
                ctx.fillStyle = '#f4f3ef'; ctx.textAlign = 'left';
                const name = isStick ? stickNames[i - 16] : BUTTON_NAMES[i];
                ctx.fillText(name, x + 16, y + 24);
                ctx.fillStyle = color; ctx.textAlign = 'center';
                ctx.fillText(displayLabel, x + cellW / 2, y + cellH / 2 + 16);
                ctx.fillStyle = '#6e7681'; ctx.textAlign = 'left';
                ctx.fillText(`#${i}`, x + 12, y + cellH - 8);
        }
        // Footer
        ctx.fillStyle = '#9aa0b4'; ctx.textAlign = 'left';
        ctx.fillText(`Status: ${keymapValid ? 'saved' : 'unsaved'}`, 28, screen.height - 20);
}

function renderKeyboardPicker(targetLabel: string) {
        const isStick = keymapCursor >= 16;
        const stickNames = ['L↑', 'L↓', 'L←', 'L→', 'R↑', 'R↓', 'R←', 'R→'];
        const btn = isStick ? stickNames[keymapCursor - 16] : BUTTON_NAMES[keymapCursor];
        const stickDirs = ['lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight'] as const;
        let curLabel: string;
        if (isStick) {
                const dir = stickDirs[keymapCursor - 16];
                curLabel = editingKeymap.sticks?.[dir]?.label || 'none';
        } else {
                const curKey = editingKeymap.buttons[keymapCursor];
                curLabel = editingKeymap.labels?.[keymapCursor] || curKey;
        }
        // Header
        ctx.fillStyle = '#f4f3ef'; ctx.textAlign = 'left';
        ctx.fillText(`Pick a key for: ${btn}`, 28, 36);
        ctx.fillStyle = '#9aa0b4';
        ctx.fillText(`Current: ${curLabel}  |  ${targetLabel}`, 28, 60);
        ctx.fillText('D-pad / tap: navigate & bind  B / ← Back: back', 28, 84);
        // Back button (also a touch target).
        drawBackButton();
        // Keyboard area: centered horizontally AND vertically, scale=55px per key unit.
        // The layout now spans y=0..9.7 (keyboard rows 0..5.3 + a 1.4-unit
        // doubled gap + 2 rows of virtual-key buttons at y=7.7 and y=8.7,
        // each h=1). kbMaxH accounts for the extra rows so the whole grid
        // stays vertically centered instead of being pushed against the top.
        const scale = KEYMAP_KB_SCALE;
        const o = keymapKbOrigin();
        const kbX = o.x, kbY = o.y;
        // Section label for the joystick-action row, drawn in the gap
        // between the keyboard bottom (y=6.3) and vkey row 1 (y=7.7).
        // Left-aligned at x=28 like the top headers (Current:…, D-pad:…)
        // and placed 0.35 units above vkey row 1 so it visually attaches
        // to the section it labels.
        ctx.fillStyle = '#9aa0b4';
        ctx.textAlign = 'left';
        ctx.fillText('Joystick action buttons', 28, kbY + 7.35 * scale);
        // Draw all keyboard keys
        for (let i = 0; i < KEYBOARD_LAYOUT.length; i++) {
                const k = KEYBOARD_LAYOUT[i];
                const x = kbX + k.x * scale, y = kbY + k.y * scale;
                const w = k.w * scale - 2, h = k.h * scale - 2;
                // Virtual-key buttons (keyCode=-1) are colored by their
                // OWN label — e.g. the "ok" button gets the green 'ok'
                // color. Regular keyboard keys are colored by their
                // keyCode → vkey mapping (e.g. keyCode 13 → 'ok' → green).
                let vkey: VirtualKey;
                if (k.keyCode === -1) {
                        vkey = k.label as VirtualKey;
                } else {
                        vkey = KEYCODE_TO_VKEY[k.keyCode] || 'none';
                }
                const color = KEYMAP_COLORS[vkey] || '#6e7681';
                const selected = i === keymapPickCursor;
                ctx.fillStyle = selected ? '#3a3f5c' : '#252840';
                ctx.fillRect(x, y, w, h);
                ctx.fillStyle = color;
                ctx.fillRect(x, y, 4, h);
                ctx.strokeStyle = selected ? '#f4f3ef' : '#3a3f5c';
                ctx.lineWidth = selected ? 2 : 1;
                ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
                ctx.fillStyle = '#f4f3ef'; ctx.textAlign = 'center';
                ctx.fillText(k.label, x + w / 2, y + h / 2 + 7);
        }
        ctx.textAlign = 'left';
}

/** Live preview screen while the Switch software keyboard is open. The
 * inline swkbd does not render the typed text itself, so this field is the
 * only place the player sees the current name. The text is re-read from the
 * keyboard EVERY FRAME (vk.value / vk.cursorIndex — nx.js keeps them current
 * via the native swkbd callbacks), so the preview updates even if a
 * "change" event is missed; the listeners only keep `renamePreview` warm
 * for runtimes where the keyboard object is opaque.
 * The field is anchored directly above the REAL keyboard rectangle
 * (vk.boundingRect, filled by show() from the applet's touch rectangles),
 * so it visually reads as "the field this keyboard types into". Without
 * geometry the field falls back to a fixed top band that no swkbd layout
 * ever covers. */
function renderRenameKb() {
        const vk = (navigator as any).virtualKeyboard;
        const isAddGame = phase === 'add-game-name';
        const text = typeof vk?.value === 'string' ? vk.value : (isAddGame ? addGamePreview : renamePreview);
        const caret = Math.max(0, Math.min(text.length, Number(vk?.cursorIndex) || 0));
        const max = Number(vk?.maxLength) || 64;
        const oldName = isAddGame ? addGameDefaultName : (currentEntry?.name ?? '');
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#161823';
        ctx.fillRect(0, 0, screen.width, screen.height);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#f4f3ef';
        ctx.font = '24px sans-serif';
        ctx.fillText(isAddGame ? 'BurialNX — name game' : 'BurialNX — rename game', 28, 44);
        ctx.fillStyle = '#9aa0b4';
        ctx.font = '20px sans-serif';
        ctx.fillText(isAddGame
                ? `Adding game from: ${addGamePath}. Type a name below.`
                : (oldName ? `Renaming "${oldName}". Type below — your text appears in this field as you type.` : 'Type below — your text appears in this field as you type.'), 28, 78);
        // Geometry: the applet reports its touch rectangles in show(), so the
        // height is real hardware data. The keyboard hugs the bottom edge;
        // anchor the input field just above it (counter + hint below the
        // field, hint above the keys). Fallback: fixed band at y=150.
        const kbHeight = Math.max(0, Math.round(Number(vk?.boundingRect?.height) || 0));
        const boxX = 60, boxW = screen.width - 120, boxH = 92;
        const boxY = kbHeight > 0 ? Math.max(150, screen.height - kbHeight - boxH - 86) : 150;
        // Field label.
        ctx.fillStyle = '#9aa0b4';
        ctx.font = '19px sans-serif';
        ctx.fillText('Game name', boxX + 4, boxY - 14);
        // The input field itself — big and high contrast.
        ctx.fillStyle = '#252840';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeStyle = '#565f8d';
        ctx.lineWidth = 3;
        ctx.strokeRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2);
        ctx.save();
        ctx.beginPath();
        ctx.rect(boxX + 4, boxY + 4, boxW - 8, boxH - 8);
        ctx.clip();
        ctx.font = '34px sans-serif';
        ctx.fillStyle = '#f4f3ef';
        ctx.textBaseline = 'middle';
        const inner = boxW - 72;
        // Scroll the text so the caret stays visible in long names.
        let offset = 0;
        while (offset < caret && ctx.measureText(text.slice(offset, caret)).width > inner) offset++;
        ctx.fillText(text.slice(offset), boxX + 28, boxY + boxH / 2 + 2);
        const caretX = boxX + 28 + ctx.measureText(text.slice(offset, caret)).width;
        ctx.fillStyle = '#ff6b6b';
        ctx.fillRect(caretX, boxY + boxH / 2 - 22, 3, 44);
        ctx.restore();
        // Counter and controls, between the field and the keyboard.
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#6e7681';
        ctx.font = '19px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${text.length}/${max} characters`, screen.width / 2, boxY + boxH + 32);
        ctx.fillText('OK saves · B cancels · (+) does nothing while typing', screen.width / 2, boxY + boxH + 60);
        ctx.restore();
}

async function launch() {
        phase = 'loading';
        gameStopped = false; // reset for new game launch
        // Reset the progress bar for a fresh launch. The title is the game's
        // display name when known (so the bar shows "The Coffin of Andy and
        // Leyley" instead of just "BurialNX"), falling back to the loader name.
        resetLoading(currentEntry?.name || 'BurialNX', 'Preparing game…');
        try {
                // Snapshot the global scope before anything game-related is installed:
                // every global the game, its fonts, its timers or its host add on top
                // of this point is undone by teardownGame() when the user quits the
                // app, so no game data survives into the next cold boot.
                beginGameSession();
                if (!selectedGame) throw new Error('No game selected');
                setLoadingProgress(0.04, 'Reading game index…', selectedGame);
                const rawAssets = gameAssets(selectedGame, selectedMod || null, { async read(path) {
                        const bytes = await Switch.readFile(path);
                        if (__DEBUG__ && bytes && /\/data\//i.test(path)) log(`Read game data: ${path} (${bytes.byteLength} bytes)`);
                        return bytes;
                } });
                const assets = { async read(path: string) {
                        const result = await rawAssets.read(path);
                        if (result === null) log(`Asset missing: ${path}`);
                        return result;
                } };
                const index = await assets.read('index.html');
                if (!index) throw new Error('Game index.html is missing');
                const scripts = scriptPlan(new TextDecoder().decode(index));
                log(`Game: ${selectedGame}; mod: ${selectedMod || 'none'}; shared saves: ${sharedSaves}`);
                setLoadingProgress(0.12, 'Loading fonts and language…');
                // Load the language table. Start with the DEFAULT English data
                // (always works — it's embedded in data/), then try to UPGRADE
                // to a .cld pack (Russian) if one exists. ALL .cld operations
                // are wrapped in try/catch so they NEVER crash the launch —
                // if anything fails, the game falls back to English. This is
                // critical for forwarder NROs which have saveData=0 (no
                // localStorage) and may have different runtime constraints.
                //
                // CRITICAL: the .cld file is ~25 MB. It is read and parsed ONLY
                // ONCE (for the chosen language). resolveLanguageName is NOT
                // called separately (it would read+parse the same 25 MB file a
                // second time, causing an OOM crash on the first forwarder
                // launch). Instead, the display name is taken from the parsed
                // pack's langName field.
                const [, , pngFix] = await Promise.all([languageTable(assets), registerFonts(assets, runtime), needsPngFix(log)]);
                let language = await languageTable(assets);
                let languagePack: LanguagePack | null = null;
                let imageReader: Reader = assets;
                activeLanguageCode = '';
                languageEntries = [];
                try {
                        const scanFs = (Switch as unknown as LanguageScanFs) ?? null;
                        languageEntries = scanLanguageFiles(scanFs, selectedGame);
                        if (languageEntries.length > 0) {
                                // Use the .cld code as the display name for now (e.g. 'ru').
                                // The real name (e.g. 'Русский') is resolved from the parsed
                                // pack below — NO separate file read needed.
                                // Pick the language: saved preference > first .cld (Russian).
                                const savedRaw = getGameLanguage(selectedGame);
                                let chosen: LanguageEntry | null = null;
                                if (savedRaw === undefined) chosen = languageEntries[0];
                                else if (savedRaw !== '') chosen = languageEntries.find((e) => e.code === savedRaw) ?? null;
                                // savedRaw === '' → explicit English: chosen stays null.
                                if (chosen) {
                                        log(`Languages: ${languageEntries.map((e) => e.code).join(', ')}; loading ${chosen.code}`);
                                        // Read the .cld file ONCE (not twice — resolveLanguageName
                                        // is skipped to avoid an OOM crash on the first launch).
                                        let cldBytes: ArrayBuffer | null = null;
                                        if (chosen.path) cldBytes = await assets.read(chosen.path);
                                        else try { cldBytes = await Switch.readFile(chosen.absPath); } catch { /* unreadable */ }
                                        if (cldBytes) {
                                                languagePack = parseLanguagePack(cldBytes, chosen.path || chosen.absPath);
                                                activeLanguageCode = chosen.code;
                                                language = languagePack.table;
                                                // Update the chosen entry's display name from the
                                                // parsed pack (free — no extra file read).
                                                if (languagePack.langName) chosen.name = languagePack.langName;
                                                // Wrap assets with translated images (best-effort).
                                                try { imageReader = withLanguageImages(assets, languagePack); } catch { imageReader = assets; }
                                        }
                                } else if (savedRaw === '') {
                                        log(`Languages: ${languageEntries.map((e) => e.code).join(', ')}; using English (user preference)`);
                                }
                        }
                } catch (langError) {
                        // Language scanning/loading failed — fall back to English.
                        // The `language` variable still holds the English table.
                        log(`Language .cld loading failed (using English): ${langError instanceof Error ? langError.message : String(langError)}`);
                        languagePack = null;
                        activeLanguageCode = '';
                        imageReader = assets;
                }
                setLoadingProgress(0.20, 'Preparing runtime host…');
                host = createBrowserHost(imageReader, prepareGameScript, log, pngFix, directScreen, failRequest);
                // Install Node.js / NW.js compatibility globals (require, process,
                // Buffer, module, exports, global, __dirname, __filename, nw) BEFORE
                // any game script loads. RPG Maker MV games packaged for NW.js call
                // these the moment a plugin or a patched title window runs — without
                // them the launch dies with `ReferenceError: require is not defined`.
                // `require('fs')` is wired to nx.js's synchronous SD-card I/O via
                // the `Switch` global, with a per-game writable overlay so the game's
                // own files stay pristine. This runs after beginGameSession(), so the
                // installed globals are tracked and cleaned up by teardownGame().
                try { installNodeCompat(runtime, (Switch as unknown as SwitchFs) ?? null, { gameRoot: selectedGame, log: __DEBUG__ ? log : undefined }); }
                catch (compatError) { log(`node-compat install failed: ${compatError instanceof Error ? compatError.message : String(compatError)}`); }
                // Script loading dominates the launch time for RPG Maker MV
                // games (often 40+ scripts, several hundred KiB each). Reserve
                // the 0.20..0.90 range for it and update per-script.
                const total = scripts.length;
                for (let i = 0; i < total; i++) {
                        const path = scripts[i];
                        log(`Loading ${path}`);
                        setLoadingProgress(0.20 + 0.70 * (i + 1) / total, `Loading scripts ${i + 1}/${total}…`, path);
                        await host.loadScript(path);
                }
                setLoadingProgress(0.92, 'Settling runtime…');
                await host.settled();
                setLoadingProgress(0.95, 'Installing compatibility…');
                installGameCompatibility(runtime, selectedGame, sharedSaves, language, pngFix, mergedKeymap());
                // Register the language pack's embedded font (e.g. bitter-pro-regular
                // from ru.cld) and override Window_Base/Yanfly/Graphics font selection
                // so the game draws text in the localized font instead of GameFont.
                // Must run AFTER scripts load (so Window_Base, Yanfly, Graphics exist)
                // and AFTER installGameCompatibility (which may reference the font hooks).
                if (languagePack) {
                        try { await registerLanguageFont(runtime, languagePack); }
                        catch (fontError) { log(`Language font install failed: ${fontError instanceof Error ? fontError.message : String(fontError)}`); }
                }
                // Wrap Input._updateGamepadState so pollStickBindings runs
                // AFTER it — this is the CRITICAL timing fix for vkey stick
                // bindings (keyCode 0 → vkey name like 'ok', 'cancel').
                //
                // MV's Input.update calls _updateGamepadState() FIRST, which
                // reads face buttons + left-stick axes and sets
                // _currentState[vkeyName] via edge detection (true on press,
                // false on release). THEN it iterates _currentState to detect
                // triggered/held/released for the frame.
                //
                // If pollStickBindings ran BEFORE _updateGamepadState (as it
                // did when called from the frame loop), a stick-driven vkey
                // (e.g. R↓→ok → _currentState['ok'] = true) would be
                // OVERRIDDEN by _updateGamepadState setting
                // _currentState['ok'] = false (button A not pressed → release
                // edge). The stick binding would be silently dropped.
                //
                // By wrapping _updateGamepadState to call pollStickBindings
                // AFTER the original, our stick bindings are the FINAL write
                // to _currentState before Input.update's iteration — so
                // _updateGamepadState's edge-detected false can't clobber
                // our true. Combined with the vkey fix (keyCode 0 → label as
                // string key), this makes right-stick→vkey bindings actually
                // fire in-game.
                if (runtime.Input?._updateGamepadState && !(runtime.Input as any).__bnxStickWrap) {
                        const originalUpdateGamepad = runtime.Input._updateGamepadState;
                        (runtime.Input as any).__bnxStickWrap = true;
                        runtime.Input._updateGamepadState = function() {
                                originalUpdateGamepad.apply(this, arguments);
                                try { pollStickBindings(); } catch { /* best-effort */ }
                        };
                }
                mapPrefetch = new MapPrefetcher(assets, log);
                installMapPrefetch(runtime, mapPrefetch, log);
                if (!saveLocation) throw new Error('No save location selected');
                if (saveLocation.kind === 'sd' || saveLocation.kind === 'game') {
                        if (!validSaveLocation(saveLocation, selectedGame, selectedMod || null)) throw new Error('Invalid save folder');
                        if (saveLocation.kind === 'game') ensureGameSaveFolder(Switch, saveLocation.folder, selectedGame, selectedMod || null);
                        installSdSaves(runtime, Switch, saveLocation.folder);
                }
                if (importRequested) { const count = importSteamSaves(runtime, Switch, selectedGame, saveLocation); log(`Imported ${count} Steam save slots`); }
                setLoadingProgress(0.98, 'Starting game…');
                if (runtime.Graphics?.render) {
                        const render = runtime.Graphics.render;
                        runtime.Graphics.render = function() { const result = render.apply(this, arguments); hud(); return result; };
                }
                if (runtime.Graphics?._createRenderer) {
                        const create = runtime.Graphics._createRenderer;
                        runtime.Graphics._createRenderer = function() {
                                const result = create.apply(this, arguments);
                                const renderer = this._renderer, pixi = runtime.PIXI;
                                const saturation = pixi?.BLEND_MODES?.SATURATION;
                                if (renderer?.type === pixi?.RENDERER_TYPE?.CANVAS && renderer.blendModes?.[saturation] === 'saturate') renderer.blendModes[saturation] = 'saturation';
                                this._maxSkip = host?.direct() ? 0 : 1;
                                return result;
                        };
                }
                if (runtime.SceneManager?.updateMain) {
                        const update = runtime.SceneManager.updateMain;
                        runtime.SceneManager.updateMain = function() {
                                // When returning to library, skip the game's update entirely.
                                // The game's rAF callback still fires but does nothing,
                                // preventing crashes from accessing stopped/undefined state.
                                // Also skip during the Plus(+) quit-confirmation notice
                                // so the game doesn't render over the dialog panel.
                                if (gameStopped || (phase === 'notice' && exitNoticeArmed)) { this.requestUpdate(); return; }
                                const now = performance.now();
                                if (lastFrame && now - lastFrame > 2000) {
                                        this._accumulator = 0;
                                        if (this._getTimeInMsWithoutMobileSafari) this._currentTime = this._getTimeInMsWithoutMobileSafari();
                                        runtime.Input?.clear?.(); runtime.TouchInput?.clear?.();
                                }
                                lastFrame = now;
                                if (menu.blocksInput) {
                                        this._accumulator = 0;
                                        if (this._getTimeInMsWithoutMobileSafari) this._currentTime = this._getTimeInMsWithoutMobileSafari();
                                        runtime.Input?.clear?.(); this.requestUpdate(); return;
                                }
                                return update.apply(this, arguments);
                        };
                        const catchException = runtime.SceneManager.catchException;
                        runtime.SceneManager.catchException = function(error: unknown) {
                                fail(error);
                                return catchException.call(this, error);
                        };
                }
                phase = 'game';
                const startup = startGame(runtime);
                log(`Game started: ${startup}`);
                // Record last-played timestamp.
                if (currentEntry) {
                        try { library = markPlayed(Switch as unknown as LibraryAccess, library, currentEntry.id); } catch { /* non-fatal */ }
                }
        } catch (error) { fail(error); }
}
// The global error/rejection listeners live with the session-lifetime
// listeners further up (sessionErrorListener & co.); they are registered at
// the bottom of this file, after every state variable is initialized.

// === Save/Load keymap override ========================================
// During Scene_Save and Scene_Load, override the gamepad keymap to the
// DEFAULT layout (A=ok, B=cancel) so the user always gets standard
// confirm/cancel buttons in the save menu, even if they remapped
// buttons for gameplay. When the scene changes back to the game
// (Scene_Map etc.), the per-game keymap is restored.
let saveLoadKeymapActive = false;
let savedGamepadMapper: any = null;
function overrideKeymapForSaveLoadScene(): void {
        const manager = runtime.SceneManager;
        const scene = manager?._scene;
        if (!scene || !runtime.Scene_Save || !runtime.Input) return;
        const isSaveLoad = scene instanceof runtime.Scene_Save || (runtime.Scene_Load && scene instanceof runtime.Scene_Load);
        if (isSaveLoad && !saveLoadKeymapActive) {
                // Entering save/load scene — save the current mapper and
                // replace it with the default (A=ok, B=cancel, etc.).
                savedGamepadMapper = runtime.Input.gamepadMapper;
                runtime.Input.gamepadMapper = { ...DEFAULT_KEYMAP.buttons.reduce((m, key, i) => { m[i] = key; return m; }, {} as Record<number, string>) };
                saveLoadKeymapActive = true;
                if (__DEBUG__) log('save/load keymap: overridden to default (A=ok, B=cancel)');
        } else if (!isSaveLoad && saveLoadKeymapActive) {
                // Leaving save/load scene — restore the per-game keymap.
                if (savedGamepadMapper) runtime.Input.gamepadMapper = savedGamepadMapper;
                savedGamepadMapper = null;
                saveLoadKeymapActive = false;
                if (__DEBUG__) log('save/load keymap: restored per-game keymap');
        }
}

// === Analog stick bindings ============================================
// Polls the gamepad analog sticks and simulates keyboard key presses
// for the bound keyCodes via Input._currentState. This lets the user
// bind L-stick/R-stick directions to movement keys (W/S/A/D, etc.).
//
// MERGE SEMANTICS (the fix for "right-stick bindings don't fire"):
// When a per-game keymap exists, its stick bindings OVERRIDE the global
// default PER DIRECTION — not wholesale. Previously, if the per-game
// keymap had `sticks: { lUp, lDown, lLeft, lRight }` (left stick only,
// e.g. from an earlier edit session), `pollStickBindings` used ONLY
// those four directions and ignored the global right-stick bindings
// (`rUp/rDown/rLeft/rRight`). Result: left stick worked, right stick
// was dead — even though the user HAD bound right-stick keys (to the
// global keymap). Now each direction falls back to the global binding
// when the per-game keymap doesn't override it, so a per-game keymap
// that only customizes SOME directions still inherits the rest.

/** Build a MERGED KeyMap: the per-game keymap (if any) takes precedence
 *  per-button/per-direction, and the global default fills every gap.
 *  This is the single source of truth for "what keymap is active right
 *  now" — used by installGameCompatibility (to set gamepadMapper at
 *  launch) and by saveEditingKeymap (to re-apply after an edit).
 *
 *  Without this merge, a per-game keymap that only overrides SOME
 *  buttons/directions would silently drop the global bindings for the
 *  rest — the root cause of the "right stick doesn't fire" bug: the
 *  per-game keymap had left-stick bindings but not right-stick ones,
 *  and the global right-stick bindings were ignored. */
function mergedKeymap(): KeyMap {
        const per = currentEntry?.keymap;
        const base = globalKeymap;
        if (!per) return base;
        // Buttons: per-game overrides per index, global fills the rest.
        const buttons: VirtualKey[] = [];
        for (let i = 0; i < 16; i++) buttons[i] = per.buttons[i] ?? base.buttons[i];
        const result: KeyMap = { buttons };
        // Labels: merge — per-game label wins, fall back to global.
        if (per.labels || base.labels) {
                const labels: string[] = [];
                for (let i = 0; i < 16; i++) labels[i] = per.labels?.[i] ?? base.labels?.[i] ?? '';
                result.labels = labels;
        }
        // KeyCodes: merge — per-game keyCode wins, fall back to global.
        if (per.keyCodes || base.keyCodes) {
                const keyCodes: number[] = [];
                for (let i = 0; i < 16; i++) keyCodes[i] = per.keyCodes?.[i] ?? base.keyCodes?.[i] ?? 0;
                result.keyCodes = keyCodes;
        }
        // Sticks: merge per direction.
        const perSticks = per.sticks;
        const baseSticks = base.sticks;
        if (perSticks || baseSticks) {
                const sticks: NonNullable<KeyMap['sticks']> = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = perSticks?.[dir] ?? baseSticks?.[dir];
                        if (b) sticks[dir] = { keyCode: b.keyCode, label: b.label };
                }
                result.sticks = sticks;
        }
        return result;
}

// Track previous stick-direction active states for EDGE-DETECTED release.
// Without this, pollStickBindings would set _currentState[key] = false
// EVERY frame the stick is idle — which would override a face button's
// held-true for the same vkey (e.g. if button A is mapped to 'ok' and
// R↓ is also bound to 'ok', releasing R↓ while holding A would
// prematurely release 'ok'). With edge detection, we only set false on
// the release TRANSITION (stick was active last frame, now inactive).
const prevStickDirActive: Record<string, boolean> = {};

function pollStickBindings(): void {
        const input = runtime.Input;
        if (!input?._currentState) return;
        const perGameSticks = currentEntry?.keymap?.sticks;
        const globalSticks = globalKeymap.sticks;
        // Per-direction merge: per-game wins, global fills the gaps.
        const s = {
                lUp: perGameSticks?.lUp || globalSticks?.lUp,
                lDown: perGameSticks?.lDown || globalSticks?.lDown,
                lLeft: perGameSticks?.lLeft || globalSticks?.lLeft,
                lRight: perGameSticks?.lRight || globalSticks?.lRight,
                rUp: perGameSticks?.rUp || globalSticks?.rUp,
                rDown: perGameSticks?.rDown || globalSticks?.rDown,
                rLeft: perGameSticks?.rLeft || globalSticks?.rLeft,
                rRight: perGameSticks?.rRight || globalSticks?.rRight,
        };
        // No stick bindings at all (neither per-game nor global) — bail.
        if (!s.lUp && !s.lDown && !s.lLeft && !s.lRight && !s.rUp && !s.rDown && !s.rLeft && !s.rRight) return;
        const pad = (navigator as any).getGamepads?.()?.[0];
        if (!pad) return;
        const axes = pad.axes;
        if (!axes || axes.length < 2) return;
        const threshold = 0.5;
        const lx = Number(axes[0]) || 0, ly = Number(axes[1]) || 0;
        const rx = Number(axes[2]) || 0, ry = Number(axes[3]) || 0;

        // Two PATHS for stick bindings, mirroring how face buttons are handled:
        //
        // PATH A — KEYBOARD keyCode bindings (keyCode > 0, e.g. arrow keys):
        //   Fire Input._onKeyDown/_onKeyUp with a synthetic KeyboardEvent on
        //   edge press/release. This runs the game's keyMapper, which
        //   translates keyCode → vkey (e.g. 38 → 'up') and sets
        //   _currentState['up'] = true/false — the SAME path a real keyboard
        //   key press takes. Without this, setting _currentState[38] directly
        //   does NOT translate to a vkey, so Input.dir4 (which reads
        //   _currentState['up'] etc.) never sees the press. This is why
        //   "right-stick → arrow keys" didn't work in-game.
        //
        // PATH B — VKEY bindings (keyCode 0, e.g. 'ok', 'cancel', 'up'):
        //   Set _currentState[vkeyName] directly (e.g. _currentState['ok']=true).
        //   This is the SAME thing gamepadMapper does for face buttons —
        //   _currentState keyed by vkey name string. No keyMapper translation
        //   needed (the vkey IS the final key). With edge-detected release +
        //   OR-merge (multiple stick directions can bind to the same vkey).
        //
        // Both paths run per-frame with edge detection, so holding a stick
        // direction = one keydown (fires once), releasing = one keyup.

        // First: compute each direction's current active state.
        const dirNames = ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const;
        const dirActive: Record<string, boolean> = {
                lUp: ly < -threshold, lDown: ly > threshold,
                lLeft: lx < -threshold, lRight: lx > threshold,
                rUp: ry < -threshold, rDown: ry > threshold,
                rLeft: rx < -threshold, rRight: rx > threshold,
        };

        // PATH A: keyCode bindings — edge-detected _onKeyDown/_onKeyUp.
        for (const name of dirNames) {
                const binding = s[name as keyof typeof s];
                if (!binding || binding.keyCode === 0) continue; // vkey, handled in PATH B
                const active = dirActive[name];
                const wasActive = !!prevStickDirActive[name];
                if (active && !wasActive) {
                        // Press edge — fire keydown. This runs the game's keyMapper
                        // (keyCode → vkey) AND sets _currentState[keyCode]=true,
                        // mirroring a real keyboard key press.
                        if (typeof input._onKeyDown === 'function') {
                                const ev = makeSyntheticKeyboardEvent(binding.keyCode);
                                ev.type = 'keydown';
                                input._onKeyDown(ev);
                        }
                } else if (!active && wasActive) {
                        // Release edge — fire keyup.
                        if (typeof input._onKeyUp === 'function') {
                                const ev = makeSyntheticKeyboardEvent(binding.keyCode);
                                ev.type = 'keyup';
                                input._onKeyUp(ev);
                        }
                }
        }

        // PATH B: vkey bindings — directly set _currentState[vkeyName], with
        // OR-merge (multiple stick directions → same vkey) and edge-detected
        // release (only set false on the release transition, not every idle
        // frame — otherwise we'd fight _updateGamepadState's management of
        // the same vkey from face buttons).
        const vkeyActive = new Map<string, boolean>();
        for (const name of dirNames) {
                const binding = s[name as keyof typeof s];
                if (!binding || binding.keyCode !== 0) continue; // keyCode, handled in PATH A
                const active = dirActive[name];
                vkeyActive.set(binding.label, (vkeyActive.get(binding.label) || false) || active);
        }
        for (const [vkey, active] of vkeyActive) {
                if (active) {
                        input._currentState[vkey] = true;
                } else {
                        // Only set false if some direction bound to this vkey
                        // was active last frame (release transition).
                        let justReleased = false;
                        for (const name of dirNames) {
                                const binding = s[name as keyof typeof s];
                                if (!binding || binding.keyCode !== 0) continue;
                                if (binding.label === vkey && prevStickDirActive[name]) { justReleased = true; break; }
                        }
                        if (justReleased) input._currentState[vkey] = false;
                }
        }

        // Save current states for next frame's edge detection.
        for (const name of dirNames) prevStickDirActive[name] = dirActive[name];
}

/** Build a synthetic KeyboardEvent-like object that RPG Maker MV's
 *  Input._onKeyDown / _onKeyUp can consume without throwing. MV's handlers
 *  call `event.preventDefault()` unconditionally (and some plugins also
 *  call `event.stopPropagation()` / `stopImmediatePropagation()`), so the
 *  event must look like a real DOM KeyboardEvent — not a plain
 *  `{ keyCode }`. The no-op methods safely satisfy those calls without
 *  touching the OS HID stack (which we cannot reach from a homebrew
 *  loader anyway). */
function makeSyntheticKeyboardEvent(keyCode: number) {
        // `key`/`code` are filled in for plugins that read the printable
        // name; `keyCode`/`which` are what MV's _onKeyDown actually reads.
        return {
                keyCode,
                which: keyCode,
                charCode: 0,
                key: '',
                code: '',
                location: 0,
                repeat: false,
                // The four DOM Event no-ops — never throw, never block.
                preventDefault: () => {},
                stopPropagation: () => {},
                stopImmediatePropagation: () => {},
                // Some MV plugins inspect `target` — give them a safe
                // window-shaped stub so `event.target.defaultPrevented`
                // doesn't crash either.
                target: { defaultPrevented: false },
                currentTarget: { defaultPrevented: false },
                defaultPrevented: false,
                bubbles: false,
                cancelable: false,
                type: 'keydown',
        };
}

/** Poll the 16 face buttons. For each button that has a non-zero keyCode
 *  binding, call Input._onKeyDown/_onKeyUp directly. This fires the game's
 *  keyboard handler, which sets _currentState[keyCode] and lets the game's
 *  keyMapper translate the keyCode to a virtual key. This is needed because
 *  RPG Maker MV's _currentState uses keyCodes (from keyboard) AND virtual
 *  key names (from gamepad) — they're separate namespaces. Setting
 *  _currentState[keyCode] directly doesn't work if the game checks
 *  _currentState['ok'] (string). Calling _onKeyDown ensures the game
 *  processes the keyCode through its own keyMapper. */
function pollButtonBindings(): void {
        const input = runtime.Input;
        if (!input) return;
        // Per-button MERGE (same semantics as pollStickBindings): the per-game
        // keymap's keyCode overrides the global one PER BUTTON, so a per-game
        // keymap that only customizes SOME buttons still inherits the rest
        // from the global default. Without this, a per-game keymap with a
        // partial keyCode array would silently drop the global bindings for
        // the buttons it doesn't override.
        const perGameKc = currentEntry?.keymap?.keyCodes;
        const globalKc = globalKeymap.keyCodes;
        if (!perGameKc && !globalKc) return;
        const pad = (navigator as any).getGamepads?.()?.[0];
        if (!pad || !pad.buttons) return;
        for (let i = 0; i < 16; i++) {
                const kc = perGameKc?.[i] || globalKc?.[i];
                if (!kc) continue; // No keyCode binding — gamepadMapper handles it.
                const pressed = !!pad.buttons[i]?.pressed;
                const wasPressed = !!input._buttonKeyState?.[i];
                if (!input._buttonKeyState) input._buttonKeyState = {};
                if (pressed && !wasPressed) {
                        // Button just pressed — fire keydown with a full
                        // KeyboardEvent-shaped object so MV's
                        // `event.preventDefault()` call (and any plugin's
                        // stopPropagation) doesn't throw.
                        if (typeof input._onKeyDown === 'function') {
                                const ev = makeSyntheticKeyboardEvent(kc);
                                ev.type = 'keydown';
                                input._onKeyDown(ev);
                        }
                        input._buttonKeyState[i] = true;
                } else if (!pressed && wasPressed) {
                        // Button just released — fire keyup the same way.
                        if (typeof input._onKeyUp === 'function') {
                                const ev = makeSyntheticKeyboardEvent(kc);
                                ev.type = 'keyup';
                                input._onKeyUp(ev);
                        }
                        input._buttonKeyState[i] = false;
                }
        }
}

let observedScene: any, sceneSince = 0, lastSceneReport = 0;
let snapshotScene: any = Symbol('no diagnostic snapshot yet');
function diagnoseScene(now: number) {
        if (!__DEBUG__) return;
        const manager = runtime.SceneManager, scene = manager?._scene;
        if (scene !== observedScene) {
                observedScene = scene; sceneSince = lastSceneReport = now;
                log(`Scene: ${scene?.constructor?.name || 'none'}`);
        }
        if (now - lastSceneReport < 8000) return;
        lastSceneReport = now;
        if (scene !== snapshotScene) { snapshotScene = scene; snapshotRuntimeLog(); }
        const waiting: string[] = [];
        const items = runtime.ImageManager?._imageCache?._items || {};
        for (const key in items) {
                const bitmap = items[key]?.bitmap;
                if (bitmap && !bitmap.isRequestOnly?.() && !bitmap.isReady?.()) {
                        const image = bitmap._image;
                        waiting.push(`${key}:${bitmap._loadingState || '?'}:complete=${!!image?.complete}:size=${image?.naturalWidth || 0}x${image?.naturalHeight || 0}:src=${image?.src || '?'}`);
                }
                if (waiting.length === 6) break;
        }
        log(`Scene status: ${scene?.constructor?.name || 'none'}, next=${manager?._nextScene?.constructor?.name || 'none'}, started=${!!manager?._sceneStarted}, stopped=${!!manager?._stopped}, seconds=${Math.round((now - sceneSince) / 1000)}, fps=${fps.toFixed(1)}, map=${runtime.$gameMap?.mapId?.() ?? '?'}, mapData=${!!runtime.$dataMap}, error=${runtime.DataManager?._errorUrl || 'none'}, images=${waiting.join(',') || 'none'}`);
}

let gameOptionsCursor = 0;
let gameOptionsScroll = 0; // index of the first visible menu item (auto-adjusted when the cursor moves)
// Play, Pick cover, Auto-detect, Edit keymap, Reset keymap, Rename game,
// Change mod folder, Toggle mod, Toggle shared saves, Change save folder,
// Language (conditional, only when 2+ languages), Create/Recreate forwarder,
// Delete forwarder, Delete, Back = 14 or 15 options depending on language count.
const GAME_OPTIONS_BASE_COUNT = 14;
// Languages discovered for the game currently shown in the game-options screen.
// Scanned synchronously (readDirSync) when entering the options screen; the
// display names are resolved lazily (codes are used if a .cld can't be read).
let currentGameLanguages: LanguageEntry[] = [];

function libraryTileCount() { return library.games.length + LIBRARY_ACTION_TILES; }

/** Navigate the library grid vertically by a full row, preserving the
 *  column. Wraps around (top row ↑ → same column on the bottom row, and
 *  vice versa) so the cursor cycles through one column on every press,
 *  mirroring how horizontal Left/Right cycle through one row.
 *
 *  When the target cell doesn't exist (the last row is partial — e.g.
 *  only 2 action tiles fill a 4-wide row), the cursor clamps to the
 *  last valid tile so the column-jump is minimal instead of skipping
 *  past the end of the list.
 *
 *  Returns the cursor unchanged when there is only a single row
 *  (total <= cols): vertical movement has no meaning on a 1-row grid,
 *  and the caller asked for up/down only "when rows become 2 or more".
 *
 *  `direction` is -1 for Up, +1 for Down. */
function libraryNavigateRow(cursor: number, total: number, cols: number, direction: -1 | 1): number {
        if (total <= cols) return cursor; // single row — no vertical movement
        const rowCount = Math.ceil(total / cols);
        const row = Math.floor(cursor / cols);
        const col = cursor % cols;
        let newRow = row + direction;
        if (newRow < 0) newRow = rowCount - 1;        // wrap top → bottom
        else if (newRow >= rowCount) newRow = 0;       // wrap bottom → top
        let target = newRow * cols + col;
        // Partial last row: the target column may not exist there.
        // Clamp to the last valid tile so the cursor lands on the nearest
        // available cell instead of skipping past the end of the list.
        if (target >= total) target = total - 1;
        return target;
}

let frameLoggedFirst = false;
function frame(now: number) {
        try {
                if (!frameLoggedFirst) { frameLoggedFirst = true; }
                marqueeOffset += 2; // scroll long names in library tiles
                const buttons = navigator.getGamepads?.()?.[0]?.buttons || null;
                const down = (id: number) => !!buttons?.[id]?.pressed;
                const edge = (id: number) => down(id) && !previousButtons[id];
                if (phase === 'library') {
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease) {
                                const total = libraryTileCount();
                                // Horizontal: D-Left/D-Right move by one tile,
                                // wrapping through the whole list (row 0
                                // col 0 ← wraps to the last tile, etc.).
                                if (edge(14)) libraryCursor = (libraryCursor + total - 1) % total;
                                if (edge(15)) libraryCursor = (libraryCursor + 1) % total;
                                // Vertical: D-Up/D-Down move by a FULL ROW
                                // (LIBRARY_COLS), preserving the column, so the
                                // user can move between the two rows of the 4×2
                                // grid instead of stepping one tile at a time.
                                // Wraps top↔bottom on the same column. Only
                                // active when there are 2+ rows; on a single-
                                // row grid Up/Down are no-ops (Left/Right cover
                                // all horizontal movement already).
                                if (edge(12)) libraryCursor = libraryNavigateRow(libraryCursor, total, LIBRARY_COLS, -1);
                                if (edge(13)) libraryCursor = libraryNavigateRow(libraryCursor, total, LIBRARY_COLS, 1);
                                // Page boundary: switch page when crossing rows.
                                const pageStart = libraryPage * LIBRARY_PAGE_SIZE;
                                if (libraryCursor < pageStart) { libraryPage = Math.max(0, libraryPage - 1); invalidateCoverCache(); }
                                else if (libraryCursor >= pageStart + LIBRARY_PAGE_SIZE) { libraryPage = Math.min(Math.ceil(total / LIBRARY_PAGE_SIZE) - 1, libraryPage + 1); invalidateCoverCache(); }
                                const isAction = libraryCursor >= library.games.length;
                                const actionIdx = libraryCursor - library.games.length;
                                const entry = !isAction ? library.games[libraryCursor] : null;
                                if (edge(1)) {
                                        if (isAction) {
                                                if (actionIdx === 0) { browser = new FolderBrowser(Switch, 'game', 'sdmc:/switch/burialnx'); pickerPurpose = 'add-game'; waitForRelease = true; phase = 'picker'; }
                                                else if (actionIdx === 1) openKeymapEditor('global');
                                                else if (actionIdx === 2) { quitApp('shutdown'); }
                                        } else if (entry) {
                                                loadEntryIntoState(entry);
                                                startOrChooseSaves();
                                        }
                                } else if (edge(3) && entry) {
                                        loadEntryIntoState(entry);
                                        gameOptionsCursor = 0; gameOptionsScroll = 0;
                                        // Scan for .cld language packs so the "Language" option
                                        // only appears when the game ships 2+ languages (any .cld
                                        // counts as 2+ because the embedded English data is always
                                        // available). Synchronous readDirSync; names resolved lazily.
                                        currentGameLanguages = scanLanguageFiles((Switch as unknown as LanguageScanFs) ?? null, entry.root);
                                        waitForRelease = true; phase = 'game-options';
                                } else if (edge(2)) {
                                        // Y = Add game from anywhere in the library.
                                        browser = new FolderBrowser(Switch, 'game', 'sdmc:/switch/burialnx'); pickerPurpose = 'add-game'; waitForRelease = true; phase = 'picker';
                                }
                                // L/R shoulder buttons move the selected game up/down
                                // in the library order. The 3 action tiles (Add, Keymap,
                                // Quit) are always at the end and can't be moved.
                                if (!isAction && entry && (edge(4) || edge(5))) {
                                        const dir = edge(4) ? -1 : 1; // L = up, R = down
                                        const oldIdx = libraryCursor;
                                        library = moveGame(Switch as unknown as LibraryAccess, library, entry.id, dir as -1 | 1);
                                        // Move the cursor to follow the game's new position.
                                        const newIdx = library.games.findIndex((g) => g.id === entry.id);
                                        if (newIdx >= 0) libraryCursor = newIdx;
                                        else libraryCursor = Math.max(0, oldIdx + dir);
                                        // Keep the cursor on the current page.
                                        const ps = libraryPage * LIBRARY_PAGE_SIZE;
                                        if (libraryCursor < ps) libraryPage = Math.max(0, libraryPage - 1);
                                        else if (libraryCursor >= ps + LIBRARY_PAGE_SIZE) libraryPage++;
                                        invalidateCoverCache();
                                        try { runtime.SoundManager?.playCursor?.(); } catch { /* best-effort */ }
                                }
                        }
                        renderLibrary();
                } else if (phase === 'game-options') {
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease) {
                                const optsCount = GAME_OPTIONS_BASE_COUNT + (currentGameLanguages.length > 0 ? 1 : 0);
                                if (edge(13)) gameOptionsCursor = (gameOptionsCursor + 1) % optsCount;
                                if (edge(12)) gameOptionsCursor = (gameOptionsCursor + optsCount - 1) % optsCount;
                                // Left/Right on the Language item cycles through available
                                // languages with auto-confirm (no A press needed). Whatever is
                                // shown is saved immediately and applies on the next launch.
                                if (currentGameLanguages.length > 0 && gameOptionsCursor === 10 && currentEntry) {
                                        const codes = currentGameLanguages.map((e) => e.code).concat(['']);
                                        const savedRaw = currentEntry.language; // from library file (SD card)
                                        const currentCode = savedRaw === undefined ? (currentGameLanguages[0]?.code || '') : savedRaw;
                                        const currentIdx = Math.max(0, codes.indexOf(currentCode));
                                        let nextIdx = -1;
                                        if (edge(14)) nextIdx = (currentIdx + codes.length - 1) % codes.length; // Left
                                        if (edge(15)) nextIdx = (currentIdx + 1) % codes.length;               // Right
                                        if (nextIdx >= 0) {
                                                const nextCode = codes[nextIdx];
                                                setGameLanguage(currentEntry.root, nextCode);
                                                // Play a soft click so the user gets feedback.
                                                try { runtime.SoundManager?.playCursor?.(); } catch { /* best-effort */ }
                                        }
                                }
                                if (edge(0)) { waitForRelease = true; phase = 'library'; }
                                else if (edge(1)) {
                                        if (gameOptionsCursor === 0) {
                                                // Play
                                                if (currentEntry) { loadEntryIntoState(currentEntry); startOrChooseSaves(); }
                                        } else if (gameOptionsCursor === 1) {
                                                // Pick cover image
                                                browser = new FolderBrowser(Switch, 'image', currentEntry?.root?.replace(/\/www$/i, '') || currentEntry?.root || 'sdmc:'); pickerPurpose = 'cover-image'; waitForRelease = true; phase = 'picker';
                                        } else if (gameOptionsCursor === 2) {
                                                // Auto-detect cover
                                                if (currentEntry) {
                                                        const cover = deriveDefaultCover(Switch as unknown as LibraryAccess & { readDirSync(path: string): string[] | null }, currentEntry.id, currentEntry.root);
                                                        if (cover) {
                                                                const updated: LibraryEntry = { ...currentEntry, cover };
                                                                if (rememberLibrary(updated)) { currentEntry = updated; invalidateCoverCache(); message = 'Cover auto-detected.'; }
                                                                else message = 'Could not save cover.';
                                                                waitForRelease = true; phase = 'notice';
                                                        } else { message = 'No .exe or .ico icon found in the game folder.'; waitForRelease = true; phase = 'notice'; }
                                                }
                                        } else if (gameOptionsCursor === 3) {
                                                // Edit per-game keymap
                                                if (currentEntry) openKeymapEditor(currentEntry);
                                        } else if (gameOptionsCursor === 4) {
                                                // Reset to global keymap (clear per-game override)
                                                if (currentEntry && currentEntry.keymap) {
                                                        const updated: LibraryEntry = { ...currentEntry };
                                                        delete updated.keymap;
                                                        if (rememberLibrary(updated)) { currentEntry = updated; message = 'Per-game keymap reset to global default.'; }
                                                        else message = 'Could not save setting.';
                                                        waitForRelease = true; phase = 'notice';
                                                } else {
                                                        message = 'No per-game keymap to reset (already using global).';
                                                        waitForRelease = true; phase = 'notice';
                                                }
                                        } else if (gameOptionsCursor === 5) {
                                                // Rename game — show a choice: type a custom name,
                                                // use the folder name, or use the .exe file name.
                                                if (currentEntry) {
                                                        gameOptionsCursor = 0; // reset for the choice panel
                                                        waitForRelease = true; phase = 'rename-choice';
                                                }
                                        } else if (gameOptionsCursor === 6) {
                                                // Select/change mod folder
                                                if (currentEntry) { const modStart = currentEntry.mod ? currentEntry.mod.replace(/\/[^\/]+$/, '') : (currentEntry.root?.replace(/\/www$/i, '') || currentEntry.root); browser = new FolderBrowser(Switch, 'mod', modStart); pickerPurpose = 'game-mod'; waitForRelease = true; phase = 'picker'; }
                                        } else if (gameOptionsCursor === 7) {
                                                // Toggle mod on/off
                                                if (currentEntry && currentEntry.mod !== undefined && currentEntry.mod !== null) {
                                                        const updated: LibraryEntry = { ...currentEntry, modEnabled: currentEntry.modEnabled === false ? true : false };
                                                        if (rememberLibrary(updated)) { currentEntry = updated; message = `Mod ${updated.modEnabled === false ? 'disabled' : 'enabled'}.`; }
                                                        else message = 'Could not save setting.';
                                                        waitForRelease = true; phase = 'notice';
                                                } else {
                                                        message = 'No mod selected. Use "Select mod folder" first.';
                                                        waitForRelease = true; phase = 'notice';
                                                }
                                        } else if (gameOptionsCursor === 8) {
                                                // Toggle shared saves
                                                if (currentEntry) {
                                                        const updated: LibraryEntry = { ...currentEntry, sharedSaves: !currentEntry.sharedSaves };
                                                        if (rememberLibrary(updated)) { currentEntry = updated; message = `Shared saves: ${updated.sharedSaves ? 'on' : 'off'}.`; }
                                                        else message = 'Could not save setting.';
                                                        waitForRelease = true; phase = 'notice';
                                                }
                                        } else if (gameOptionsCursor === 9) {
                                                // Change save folder — opens the save-choice phase
                                                choiceFromMenu = false;
                                                waitForRelease = true;
                                                phase = 'save-choice';
                                        } else if (currentGameLanguages.length > 0 && gameOptionsCursor === 10) {
                                                // Language — A also cycles forward (same as Right), auto-saved.
                                                // Left/Right handling is in the navigation block above.
                                                if (currentEntry) {
                                                        const codes = currentGameLanguages.map((e) => e.code).concat(['']);
                                                        const savedRaw = currentEntry.language;
                                                        const currentCode = savedRaw === undefined ? (currentGameLanguages[0]?.code || '') : savedRaw;
                                                        const currentIdx = Math.max(0, codes.indexOf(currentCode));
                                                        const nextIdx = (currentIdx + 1) % codes.length;
                                                        const nextCode = codes[nextIdx];
                                                        setGameLanguage(currentEntry.root, nextCode);
                                                        try { runtime.SoundManager?.playCursor?.(); } catch { /* best-effort */ }
                                                }
                                        } else {
                                                // Forwarder / delete / back are at the END of the list, but
                                                // their cursor index shifts by +1 when the language option
                                                // is present (it's inserted at index 10). Map by offset.
                                                const offset = currentGameLanguages.length > 0 ? 1 : 0;
                                                const actionIdx = gameOptionsCursor - 10 - offset;
                                                if (actionIdx === 0) {
                                                        // Create / Recreate forwarder NRO
                                                        if (currentEntry) void startForwarderBuild(currentEntry);
                                                } else if (actionIdx === 1) {
                                                        // Delete forwarder NRO
                                                        if (currentEntry) {
                                                                const had = forwarderExists(Switch as unknown as LibraryAccess, currentEntry.name, currentEntry.id);
                                                                const removed = deleteForwarder(Switch as unknown as LibraryAccess & { removeSync?: (p: string) => void; unlinkSync?: (p: string) => void }, currentEntry.name, currentEntry.id);
                                                                if (had && removed) message = `Forwarder deleted:\n${forwarderPathFor(currentEntry.name, currentEntry.id)}`;
                                                                else if (had && !removed) message = 'Forwarder file present but could not be removed.';
                                                                else message = 'No forwarder to delete.';
                                                                waitForRelease = true; phase = 'notice';
                                                        }
                                                } else if (actionIdx === 2) {
                                                        // Delete
                                                        if (currentEntry) {
                                                                // Also remove the forwarder if present, so the SD card
                                                                // doesn't keep a stale shortcut to a deleted game.
                                                                try { deleteForwarder(Switch as unknown as LibraryAccess & { removeSync?: (p: string) => void; unlinkSync?: (p: string) => void }, currentEntry.name, currentEntry.id); } catch { /* non-fatal */ }
                                                                library = removeGame(Switch as unknown as LibraryAccess, library, currentEntry.id);
                                                                invalidateCoverCache();
                                                                currentEntry = null;
                                                                message = 'Game removed from library.';
                                                                waitForRelease = true; phase = 'library';
                                                        }
                                                } else if (actionIdx === 3) {
                                                        // Back
                                                        waitForRelease = true; phase = 'library';
                                                }
                                        }
                                }
                        }
                        renderGameOptions();
                } else if (phase === 'keymap') {
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease) {
                                if (keymapPicking) {
                                        // Phase 2: keyboard+mouse navigation (spatial)
                                        if (edge(12)) keymapPickCursor = findNearestKey(keymapPickCursor, 0, -1); // Up
                                        if (edge(13)) keymapPickCursor = findNearestKey(keymapPickCursor, 0, 1);  // Down
                                        if (edge(14)) keymapPickCursor = findNearestKey(keymapPickCursor, -1, 0); // Left
                                        if (edge(15)) keymapPickCursor = findNearestKey(keymapPickCursor, 1, 0);  // Right
                                        // A: bind the selected key
                                        if (edge(1)) {
                                                const def = getAllPickKeys()[keymapPickCursor];
                                                if (def && def.label) {
                                                        if (keymapCursor < 16) {
                                                                // Face button binding
                                                                editingKeymap = setButtonWithLabel(editingKeymap, keymapCursor, def.vkey, def.label, def.keyCode);
                                                        } else {
                                                                // Stick direction binding
                                                                const stickDirs = ['lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight'] as const;
                                                                const dir = stickDirs[keymapCursor - 16];
                                                                if (!editingKeymap.sticks) editingKeymap.sticks = {};
                                                                editingKeymap.sticks[dir] = { keyCode: def.keyCode || 0, label: def.label };
                                                        }
                                                        saveEditingKeymap();
                                                        keymapPicking = false;
                                                        waitForRelease = true;
                                                }
                                        }
                                        // B: back to button grid
                                        if (edge(0)) { keymapPicking = false; waitForRelease = true; }
                                } else {
                                        // Phase 1: button grid navigation (24 entries: 16 buttons + 8 stick dirs)
                                        if (edge(12)) keymapCursor = (keymapCursor + 20) % 24;
                                        if (edge(13)) keymapCursor = (keymapCursor + 4) % 24;
                                        if (edge(14)) { const r = keymapCursor % 4; keymapCursor = r === 0 ? keymapCursor + 3 : keymapCursor - 1; }
                                        if (edge(15)) { const r = keymapCursor % 4; keymapCursor = r === 3 ? keymapCursor - 3 : keymapCursor + 1; }
                                        // A: enter keyboard picker for this button/stick
                                        if (edge(1)) { keymapPicking = true; keymapPickCursor = 0; waitForRelease = true; }
                                        // X: clear binding (set to none)
                                        if (edge(3)) {
                                                if (keymapCursor < 16) {
                                                        editingKeymap = setButton(editingKeymap, keymapCursor, 'none');
                                                } else {
                                                        const stickDirs = ['lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight'] as const;
                                                        const dir = stickDirs[keymapCursor - 16];
                                                        if (editingKeymap.sticks) delete editingKeymap.sticks[dir];
                                                }
                                                saveEditingKeymap();
                                        }
                                        // B: back to library/game
                                        if (edge(0)) { waitForRelease = true; phase = host ? 'game' : 'library'; if (host) menu.dismiss(); }
                                        // Presets
                                        if (edge(4)) applyPreset(0);
                                        if (edge(5)) applyPreset(1);
                                        if (edge(6)) applyPreset(2);
                                        if (edge(7)) applyPreset(3);
                                }
                        }
                        renderKeymap();
                } else if (phase === 'rename-choice') {
                        // Choose how to rename: type a custom name, or browse
                        // for a folder/file to take the name from.
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease) {
                                if (edge(13)) gameOptionsCursor = (gameOptionsCursor + 1) % 2;
                                if (edge(12)) gameOptionsCursor = (gameOptionsCursor + 2) % 2;
                                if (edge(0)) { waitForRelease = true; phase = 'game-options'; } // B: back
                                else if (edge(1) && currentEntry) {
                                        if (gameOptionsCursor === 0) {
                                                // Option 1: Type a custom name — open the keyboard.
                                                if (navigator?.virtualKeyboard) {
                                                        const vk = navigator.virtualKeyboard;
                                                        vk.okButtonText = 'Save';
                                                        vk.type = 0;
                                                        vk.maxLength = 64;
                                                        vk.value = currentEntry.name;
                                                        renameSubmitted = false;
                                                        renamePreview = currentEntry.name;
                                                        const onLiveInput = () => { renamePreview = vk.value; };
                                                        const onSubmit = () => {
                                                                renameSubmitted = true;
                                                                const text = vk.value || currentEntry!.name;
                                                                const oldName = currentEntry!.name;
                                                                const updated: LibraryEntry = { ...currentEntry!, name: text };
                                                                if (rememberLibrary(updated)) { currentEntry = updated; message = 'Name changed.'; }
                                                                else message = 'Could not save name.';
                                                                // Rename the forwarder if it exists at the old name's path.
                                                                try {
                                                                        if (renameForwarder(Switch as unknown as LibraryAccess & { removeSync?: (p: string) => void; unlinkSync?: (p: string) => void; rmdirSync?: (p: string) => void; readFileSync?: (p: string) => ArrayBuffer | null }, oldName, text, updated.id)) {
                                                                                message += '\n\nForwarder renamed. Recreate it in game options for the Switch Home Menu.';
                                                                        }
                                                                } catch { /* best-effort */ }
                                                                waitForRelease = true; phase = 'notice';
                                                        };
                                                        const onGeometryChange = () => {
                                                                if (vk.boundingRect.height === 0) {
                                                                        setTimeout(() => {
                                                                                vk.removeEventListener('submit', onSubmit as EventListener);
                                                                                vk.removeEventListener('geometrychange', onGeometryChange as EventListener);
                                                                                vk.removeEventListener('change', onLiveInput as EventListener);
                                                                                vk.removeEventListener('cursormove', onLiveInput as EventListener);
                                                                                if (!renameSubmitted) { waitForRelease = true; phase = 'game-options'; }
                                                                        }, 50);
                                                                }
                                                        };
                                                        vk.addEventListener('submit', onSubmit as EventListener);
                                                        vk.addEventListener('geometrychange', onGeometryChange as EventListener);
                                                        vk.addEventListener('change', onLiveInput as EventListener);
                                                        vk.addEventListener('cursormove', onLiveInput as EventListener);
                                                        vk.show();
                                                        phase = 'rename-kb';
                                                } else {
                                                        renameBuffer = currentEntry.name.slice(0, 64);
                                                        while (renameBuffer.length < 8) renameBuffer += ' ';
                                                        renameCursor = 0;
                                                        waitForRelease = true; phase = 'rename';
                                                }
                                        } else if (gameOptionsCursor === 1) {
                                                // Option 2: Browse for a folder or file to take the name from.
                                                // Opens the folder browser starting at the game's parent folder.
                                                // Uses 'file' mode so ALL files are visible (not just folders).
                                                const parent = currentEntry.root.replace(/\/www$/i, '').replace(/\/+$/, '') || 'sdmc:';
                                                browser = new FolderBrowser(Switch, 'file', parent);
                                                pickerPurpose = 'rename-source';
                                                waitForRelease = true; phase = 'picker';
                                        }
                                }
                        }
                        // Render the choice panel.
                        if (ctx) {
                                ctx.save();
                                ctx.setTransform(1, 0, 0, 1, 0, 0);
                                ctx.fillStyle = '#161823';
                                ctx.fillRect(0, 0, screen.width, screen.height);
                                ctx.font = '22px sans-serif';
                                ctx.fillStyle = '#f4f3ef'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                                ctx.fillText('Rename game — choose source', 28, 50);
                                ctx.font = '20px sans-serif';
                                ctx.fillStyle = '#9aa0b4';
                                ctx.fillText(currentEntry?.name || '(unknown)', 28, 78);
                                const items = [
                                        'Type a custom name',
                                        'Use name from folder/file',
                                ];
                                ctx.font = '22px sans-serif';
                                for (let i = 0; i < items.length; i++) {
                                        const isCursor = i === gameOptionsCursor;
                                        ctx.fillStyle = isCursor ? '#3fb950' : '#c9cdd6';
                                        ctx.fillText((isCursor ? '▶ ' : '  ') + items[i], 28, 120 + i * 32);
                                }
                                ctx.font = '16px sans-serif';
                                ctx.fillStyle = '#6e7681';
                                ctx.fillText('Up/Down: select  A: choose  B: back', 28, screen.height - 20);
                                ctx.restore();
                        }
                } else if (phase === 'rename-kb' || phase === 'add-game-name') {
                        // Swkbd is open — render the live preview of the name being typed.
                        // Do NOT process gamepad input here: the keyboard owns it.
                        renderRenameKb();
                } else if (phase === 'rename') {
                        // Character-cycling rename: Up/Down cycle the char at cursor,
                        // Left/Right move cursor, A confirms, B cancels.
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease) {
                                if (edge(12)) { // Up: cycle char backward
                                        const c = renameBuffer.charCodeAt(renameCursor) || 32;
                                        const nc = c <= 32 ? 126 : c - 1;
                                        renameBuffer = renameBuffer.slice(0, renameCursor) + String.fromCharCode(nc) + renameBuffer.slice(renameCursor + 1);
                                }
                                if (edge(13)) { // Down: cycle char forward
                                        const c = renameBuffer.charCodeAt(renameCursor) || 32;
                                        const nc = c >= 126 ? 32 : c + 1;
                                        renameBuffer = renameBuffer.slice(0, renameCursor) + String.fromCharCode(nc) + renameBuffer.slice(renameCursor + 1);
                                }
                                if (edge(14) && renameCursor > 0) renameCursor--;
                                if (edge(15) && renameCursor < renameBuffer.length - 1) renameCursor++;
                                if (edge(1)) { // A: confirm
                                        if (currentEntry) {
                                                const updated: LibraryEntry = { ...currentEntry, name: renameBuffer };
                                                if (rememberLibrary(updated)) { currentEntry = updated; message = 'Name changed.'; }
                                                else message = 'Could not save name.';
                                                waitForRelease = true; phase = 'notice';
                                        }
                                }
                                if (edge(0)) { waitForRelease = true; phase = 'game-options'; } // B: cancel
                        }
                        panel(['BurialNX — rename game', 'Up/Down: cycle char  Left/Right: move  A: save  B: cancel', `Name: ${renameBuffer}`, `Pos: ${renameCursor + 1}/${renameBuffer.length}`], true);
                } else if (phase === 'picker') {
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease) {
                                const result = browser.step(buttons);
                                if (result !== undefined) {
                                        if (pickerPurpose === 'game' && result !== null) {
                                                selectedGame = result; sharedSaves = browser.sharedSaves;
                                                const previousMod = saved?.root === result ? saved.mod || null : null;
                                                selectedMod = previousMod;
                                                saveLocation = saved?.root === result ? saved.saves : undefined;
                                                if (saveLocation && !validSaveLocation(saveLocation, result, previousMod)) saveLocation = undefined;
                                                remember(currentSelection());
                                                if (__DEBUG__) { const modStart3 = selectedMod ? selectedMod.replace(/\/[^\/]+$/, '') : (selectedGame?.replace(/\/www$/i, '') || selectedGame); browser = new FolderBrowser(Switch, 'mod', modStart3); pickerPurpose = 'startup-mod'; waitForRelease = true; }
                                                else startOrChooseSaves();
                                        } else if (pickerPurpose === 'add-game' && result !== null) {
                                                // Open the software keyboard so the user can name the
                                                // game before it's added to the library. The suggested
                                                // name is derived from the folder name or a .exe file
                                                // in the parent folder.
                                                addGamePath = result;
                                                addGameDefaultName = suggestGameName(result);
                                                addGamePreview = addGameDefaultName;
                                                addGameSubmitted = false;
                                                if (navigator?.virtualKeyboard) {
                                                        const vk = navigator.virtualKeyboard;
                                                        vk.okButtonText = 'Add';
                                                        vk.type = 0;
                                                        vk.maxLength = 64;
                                                        vk.value = addGameDefaultName;
                                                        const onSubmit = () => {
                                                                addGameSubmitted = true;
                                                                const text = vk.value || addGameDefaultName;
                                                                addGamePreview = text;
                                                                finishAddGame(text);
                                                        };
                                                        const onLiveInput = () => { addGamePreview = vk.value; };
                                                        vk.addEventListener('change', onLiveInput);
                                                        vk.addEventListener('submit', onSubmit);
                                                        vk.show();
                                                        phase = 'add-game-name';
                                                } else {
                                                        // No swkbd available — add with the suggested name.
                                                        finishAddGame(addGameDefaultName);
                                                }
                                        } else if (pickerPurpose === 'cover-image' && result !== null && currentEntry) {
                                                log(`Cover pick: ${result} for game ${currentEntry.id}`);
                                                const coverPath = saveUserCoverLogged(Switch as unknown as LibraryAccess, currentEntry.id, result, log);
                                                // The .exe can be several MB; explicitly run GC so the
                                                // ArrayBuffer is freed before the cover Image is decoded
                                                // on the next renderLibrary call (avoids OOM crashes on
                                                // Switch's limited heap).
                                                try { if (typeof runtime.gc === 'function') runtime.gc(); } catch { /* gc is best-effort */ }
                                                if (coverPath) {
                                                        const updated: LibraryEntry = { ...currentEntry, cover: coverPath };
                                                        if (rememberLibrary(updated)) { currentEntry = updated; invalidateCoverCache(); message = 'Cover saved.'; }
                                                        else message = 'Could not save cover.';
                                                } else message = 'Unsupported image or no icon in file. Use PNG, JPG, ICO, or .exe with embedded icon.';
                                                waitForRelease = true; phase = 'notice';
                                        } else if (pickerPurpose === 'startup-mod') {
                                                selectedMod = result;
                                                if (saveLocation && !validSaveLocation(saveLocation, selectedGame!, selectedMod)) saveLocation = undefined;
                                                choiceFromMenu = false; waitForRelease = true; phase = 'save-choice';
                                        } else if (pickerPurpose === 'game-mod' && currentEntry) {
                                                // Select/change mod folder from game options
                                                const updated: LibraryEntry = { ...currentEntry, mod: result, modEnabled: true };
                                                if (rememberLibrary(updated)) { currentEntry = updated; message = `Mod set to: ${result}`; }
                                                else message = 'Could not save mod setting.';
                                                waitForRelease = true; phase = 'notice';
                                        } else if (pickerPurpose === 'rename-source' && result !== null && currentEntry) {
                                                // Take the game name from the selected folder or file.
                                                // The result is a full sdmc: path — extract the last segment
                                                // (folder name or filename without extension).
                                                const clean = result.replace(/\/+$/, '');
                                                const lastSegment = clean.split('/').pop() || currentEntry.name;
                                                // If it's a file (has an extension), strip it.
                                                const name = lastSegment.replace(/\.[^.]+$/, '');
                                                const oldName = currentEntry.name;
                                                const updated: LibraryEntry = { ...currentEntry, name: name || currentEntry.name };
                                                if (rememberLibrary(updated)) { currentEntry = updated; message = `Name set to: ${name}`; }
                                                else message = 'Could not save name.';
                                                // Rename the forwarder if it exists at the old name's path.
                                                try {
                                                        if (renameForwarder(Switch as unknown as LibraryAccess & { removeSync?: (p: string) => void; unlinkSync?: (p: string) => void; rmdirSync?: (p: string) => void; readFileSync?: (p: string) => ArrayBuffer | null }, oldName, name, updated.id)) {
                                                                message += '\n\nForwarder renamed. Recreate it in game options for the Switch Home Menu.';
                                                        }
                                                } catch { /* best-effort */ }
                                                waitForRelease = true; phase = 'notice';
                                        }
                                        else if (pickerPurpose === 'menu-mod' && selectedGame) {
                                                const pendingSaves = saved?.root === selectedGame ? saved.saves : saveLocation;
                                                if (pendingSaves && !validSaveLocation(pendingSaves, selectedGame, result)) { browser.message = 'Mod overlaps or invalidates the save folder.'; }
                                                else {
                                                const ok = remember({ ...currentSelection(pendingSaves), mod: result });
                                                message = ok ? 'Mod saved. Restart the loader to apply it.' : 'Could not save mod selection; settings unchanged.';
                                                waitForRelease = true; phase = 'notice'; }
                                        } else if ((pickerPurpose === 'startup-saves' || pickerPurpose === 'menu-saves') && result !== null) {
                                                chooseSaves({ kind: 'sd', folder: result });
                                        } else if ((pickerPurpose === 'startup-saves' || pickerPurpose === 'menu-saves') && result === null) {
                                                waitForRelease = true; phase = 'save-choice';
                                        } else if (result === null) {
                                                // B at root cancels the picker. For 'add-game', always
                                                // return to library (not game-options).
                                                waitForRelease = true;
                                                if (pickerPurpose === 'add-game') phase = 'library';
                                                else phase = currentEntry ? 'game-options' : 'library';
                                        }
                                }
                        }
                        const first = Math.max(0, Math.min(browser.selected - 7, browser.entries.length - 12));
                        const hint = browser.mode === 'game' ? 'A: open  B: back/cancel  X: select  Y: select (shared saves)' : browser.mode === 'mod' ? 'A: open  B: back/cancel  X: select  Y: no mod' : browser.mode === 'image' ? 'A: pick file  B: back/cancel' : 'A: open  B: back/cancel  X: select';
                        const showFiles = browser.mode === 'image';
                        const entryLines = browser.entries.slice(first, first + 12).map((name, index) => {
                                const marker = first + index === browser.selected ? '> ' : '  ';
                                if (!showFiles) return `${marker}${name}/`;
                                let info: { mode: number } | null = null;
                                try { info = Switch.statSync(`${browser.path}/${name}`); } catch { /* unreadable */ }
                                const isFile = info && (info.mode & 0o170000) === 0o100000;
                                const ext = name.toLowerCase().split('.').pop() || '';
                                const tag = isFile ? (ext === 'exe' ? '  [exe→icon]' : '  [image]') : '/';
                                return `${marker}${name}${tag}`;
                        });
                        panel([`BurialNX — select ${browser.mode} ${showFiles ? 'image' : 'folder'}`, `${browser.path}/`,
                                'Up/Down: highlight  A: open/select  B: parent  X: select', hint, browser.message,
                                ...entryLines], true);
                } else if (phase === 'save-choice') {
                        panel(['BurialNX — save location', 'A: Switch user save data', 'X: choose an SD-card folder', 'Y: use the game’s save folder', ...(choiceFromMenu ? ['B: cancel'] : ['Select where new saves will be stored.'])], true);
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease && buttons?.[1]?.pressed && !previousButtons[1]) chooseSaves({ kind: 'switch' });
                        else if (!waitForRelease && buttons?.[3]?.pressed && !previousButtons[3]) { const saveStart = saveLocation?.kind === 'sd' ? saveLocation.folder : (selectedGame?.replace(/\/www$/i, '') || selectedGame); browser = new FolderBrowser(Switch, 'saves', saveStart); pickerPurpose = choiceFromMenu ? 'menu-saves' : 'startup-saves'; waitForRelease = true; phase = 'picker'; }
                        else if (!waitForRelease && buttons?.[2]?.pressed && !previousButtons[2]) { waitForRelease = true; phase = 'game-save-choice'; }
                        else if (!waitForRelease && choiceFromMenu && buttons?.[0]?.pressed && !previousButtons[0]) { menu.dismiss(); phase = 'game'; }
                } else if (phase === 'game-save-choice') {
                        const folders = gameSaveFolders(selectedGame!);
                        panel(['BurialNX — use game-folder saves', 'Saves will be written in the game folder. Back them up first.', `A: ${folders[0]}`, ...(folders[1] ? [`X: ${folders[1]}`] : []), 'A missing save folder will be created. B: back.'], true);
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease && buttons?.[1]?.pressed && !previousButtons[1]) chooseSaves({ kind: 'game', folder: folders[0] });
                        else if (!waitForRelease && folders[1] && buttons?.[3]?.pressed && !previousButtons[3]) chooseSaves({ kind: 'game', folder: folders[1] });
                        else if (!waitForRelease && buttons?.[0]?.pressed && !previousButtons[0]) { waitForRelease = true; phase = 'save-choice'; }
                } else if (phase === 'import-confirm') {
                        panel(['BurialNX — Steam saves', `Current destination: ${saveLocation && saveLocation.kind !== 'switch' ? saveLocation.folder : 'Switch user save data'}`, 'A: import game-folder Steam saves into this empty location', 'B: skip', 'Existing saves are never overwritten.'], true);
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease && ((buttons?.[1]?.pressed && !previousButtons[1]) || (buttons?.[0]?.pressed && !previousButtons[0]))) {
                                const wantsImport = !!buttons?.[1]?.pressed;
                                if (choiceFromMenu) {
                                        try { message = wantsImport ? `Imported ${importSteamSaves(runtime, Switch, selectedGame!, saveLocation!)} Steam save slots.` : 'Import cancelled.'; }
                                        catch (error) { message = `Import failed: ${String(error)}`; }
                                        waitForRelease = true; phase = 'notice';
                                } else { importRequested = wantsImport; void launch(); }
                        }
                } else if (phase === 'notice') {
                        if (exitNoticeArmed) {
                                // Use the centered quit dialog (compact, game visible).
                                renderQuitDialog();
                        } else {
                                // Small centered popup (same style as the exit dialog)
                                // for success/info notices — replaces the old
                                // full-screen panel that hid the underlying screen.
                                renderNoticePopup(message);
                        }
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease && ((buttons?.[0]?.pressed && !previousButtons[0]) || (!exitNoticeArmed && buttons?.[1]?.pressed && !previousButtons[1]))) {
                                // B: cancel — return to previous phase.
                                // For a non-exit notice (success/info popup), A also
                                // dismisses (acts as "OK") — same as B. For an exit
                                // notice (exitNoticeArmed), A is handled by the next
                                // branch and confirms the quit/return-to-library.
                                exitNoticeArmed = false; exitArmed = false;
                                if (host) { menu.dismiss(); phase = 'game'; }
                                else { phase = currentEntry ? 'game-options' : 'library'; waitForRelease = true; }
                        } else if (!waitForRelease && exitNoticeArmed && buttons?.[1]?.pressed && !previousButtons[1]) {
                                // A: confirm quit/return-to-library. The mode
                                // (and the dialog label) were chosen when the
                                // notice was armed — see the Plus handler and
                                // the pause-menu 'quit' action.
                                exitNoticeArmed = false;
                                try { quitApp(pendingExitMode); }
                                catch (error) {
                                        log(`quitApp threw: ${error instanceof Error ? error.message : String(error)}`);
                                        allowExit = true;
                                        try { (Switch as any).exit?.(); } catch { /* best-effort */ }
                                }
                        }
                } else if (phase === 'error') {
                        panel(['BurialNX — game could not start', message, __DEBUG__ ? `Details: ${hostLogPath}` : 'Try the debug build for details.', forwarderTargetId ? 'Press B to exit BurialNX.' : 'Press B to return to the library.'], true);
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease && buttons?.[0]?.pressed && !previousButtons[0]) {
                                waitForRelease = true;
                                // A failed launch leaves half-installed game state behind. Exit
                                // the app fully (teardown + Switch.exit) so the next launch is
                                // a guaranteed clean cold boot. For a forwarder-launched game
                                // this is a full shutdown (quitApp('shutdown')); for a
                                // library-launched game it returns to the library grid so the
                                // user can fix things and try again. Horizon OS reserves the
                                // process memory and reclaims it on exit, which is the only
                                // reliably clean reset; an in-process session reboot proved
                                // unstable on hardware (froze on the "Loading…" splash).
                                quitApp(forwarderTargetId ? 'shutdown' : 'return-to-library');
                        }
                } else if (phase === 'loading' || phase === 'forwarder-building') renderLoading();
                else {
                        diagnoseScene(now);
                        // Override the gamepad keymap during Scene_Save and
                        // Scene_Load so the confirm/cancel buttons always use
                        // the DEFAULT menu layout (A=ok, B=cancel), not the
                        // per-game remapped layout. This prevents confusion when
                        // the user has remapped buttons for gameplay but expects
                        // standard A/B in the save/load menu.
                        overrideKeymapForSaveLoadScene();
                        // NOTE: pollStickBindings() is now called from the
                        // _updateGamepadState wrapper (installed in launch()),
                        // NOT from the frame loop. This ensures it runs AFTER
                        // _updateGamepadState processes face buttons — so a
                        // stick-driven vkey (e.g. R↓→ok → _currentState['ok'])
                        // isn't overridden by _updateGamepadState's edge-detected
                        // false for the same vkey. See the wrapper comment in
                        // launch() for the full rationale.
                        // Poll face-button keyCode bindings: for each button
                        // with a non-zero keyCode, fire Input._onKeyDown/
                        // _onKeyUp with a synthetic KeyboardEvent so the
                        // game's keyMapper translates it (same path as a
                        // real keyboard key press). Buttons without a
                        // keyCode binding are handled by gamepadMapper.
                        pollButtonBindings();
                        if (now - lastMemoryCheck >= 5000) {
                                lastMemoryCheck = now;
                                try {
                                        const memory = (Switch as any).memoryUsage?.();
                                        if (memory?.nativeHeapUsed > 1024 * 1024 * 1024 && typeof runtime.gc === 'function') runtime.gc();
                                } catch { /* memory diagnostics are optional */ }
                        }
                        if (!sampleStart) sampleStart = now;
                        frames++; if (now - sampleStart >= 1000) { fps = frames * 1000 / (now - sampleStart); sampleStart = now; frames = 0; }
                        // If Minus(-) is unbound in the game's keymap, the pause
                        // menu opens immediately (holdMs=0). If bound, require
                        // 800ms hold (so the game's binding fires on press).
                        const minusBound = ((currentEntry?.keymap) || globalKeymap).buttons[8] !== 'none';
                        const action = menu.step(buttons, now, minusBound ? 800 : 0);
                        if (mapPrefetch && fps >= 50 && !menu.blocksInput && typeof runtime.Scene_Map === 'function' &&
                                runtime.SceneManager?._scene instanceof runtime.Scene_Map && runtime.SceneManager._sceneStarted &&
                                !runtime.SceneManager._nextScene && !runtime.SceneManager._stopped && runtime.$dataMap && !runtime.$gamePlayer?.isTransferring?.()) {
                                mapPrefetch.tick(now, true);
                        }
                        if (action === 'load' && runtime.SceneManager && runtime.Scene_Load) runtime.SceneManager.push(runtime.Scene_Load);
                        if (action === 'save' && runtime.SceneManager && runtime.Scene_Save) runtime.SceneManager.push(runtime.Scene_Save);
                        if (action === 'resolution' && host) fit = host.toggleFit();
                        if (action === 'mod') { const modStart2 = selectedMod ? selectedMod.replace(/\/[^\/]+$/, '') : (selectedGame?.replace(/\/www$/i, '') || selectedGame); browser = new FolderBrowser(Switch, 'mod', modStart2); pickerPurpose = 'menu-mod'; waitForRelease = true; phase = 'picker'; }
                        if (action === 'saves') { choiceFromMenu = true; waitForRelease = true; phase = 'save-choice'; }
                        if (action === 'import') { choiceFromMenu = true; waitForRelease = true; phase = 'import-confirm'; }
                        if (action === 'keymap') {
                                // During gameplay, edit the active game's per-game keymap
                                // (so the change is scoped to this game) — or the global
                                // default when no per-game override exists. Saving
                                // re-applies the binding to runtime.Input immediately.
                                if (host && currentEntry) {
                                        // Auto-promote: create a per-game keymap seeded with the
                                        // current global default so subsequent edits are scoped.
                                        // Copy EVERYTHING (buttons, labels, keyCodes, sticks) —
                                        // not just buttons. Previously this only copied buttons,
                                        // so the seeded per-game keymap had NO stick bindings
                                        // (and no keyCodes/labels). The keymap editor then showed
                                        // 'none' for every stick direction, and if the user re-bound
                                        // only the LEFT stick (because it was the one they cared
                                        // about at the moment), the per-game keymap ended up with
                                        // left-stick bindings only — and because the per-game
                                        // keymap took precedence over global in pollStickBindings,
                                        // the RIGHT-stick bindings the user had set globally were
                                        // silently ignored. Now the seed is a FULL copy of the
                                        // global keymap, so the editor shows the user's existing
                                        // bindings and they can edit individual directions without
                                        // losing the rest.
                                        if (!currentEntry.keymap) {
                                                const seededKm: KeyMap = { buttons: [...globalKeymap.buttons] };
                                                if (globalKeymap.labels) seededKm.labels = [...globalKeymap.labels];
                                                if (globalKeymap.keyCodes) seededKm.keyCodes = [...globalKeymap.keyCodes];
                                                if (globalKeymap.sticks) {
                                                        seededKm.sticks = {};
                                                        for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                                                                const b = globalKeymap.sticks[dir];
                                                                if (b) seededKm.sticks[dir] = { keyCode: b.keyCode, label: b.label };
                                                        }
                                                }
                                                const seeded: LibraryEntry = { ...currentEntry, keymap: seededKm };
                                                if (rememberLibrary(seeded)) currentEntry = seeded;
                                        }
                                        openKeymapEditor(currentEntry);
                                } else {
                                        openKeymapEditor('global');
                                }
                        }
                        if (action === 'quit') {
                                // Pause-menu "Quit" (hold Minus, last item on page 1).
                                // For a forwarder-launched game (forwarderTargetId set):
                                //   full shutdown — the user launched via a standalone
                                //   shortcut and expects to leave BurialNX entirely.
                                // For a library-launched game (forwarderTargetId null):
                                //   "return to library" — relaunch burialnx.nro without
                                //   --game so the library grid shows.
                                const mode: QuitMode = forwarderTargetId ? 'shutdown' : 'return-to-library';
                                try { quitApp(mode); }
                                catch (error) {
                                        log(`quitApp threw: ${error instanceof Error ? error.message : String(error)}`);
                                        allowExit = true;
                                        try { (Switch as any).exit?.(); } catch { /* best-effort */ }
                                }
                        }
                        if (action === 'direct' && debugSettingsValid) {
                                try { const value = !directNext; Switch.writeFileSync(debugSettingsPath, JSON.stringify({ directScreen: value })); directNext = value; log('Direct-screen setting saved; restart required.'); }
                                catch (error) { log(`Could not save direct-screen setting: ${String(error)}`); }
                        }
                        if (action === 'snapshot') { log(`Snapshot: scene=${runtime.SceneManager?._scene?.constructor?.name || 'unknown'}, fps=${fps.toFixed(1)}`); snapshotRuntimeLog(); }
                        // Left/Right (or A) on the Language item cycle through available
                        // languages with auto-confirm — the selected language is saved
                        // immediately to the library file (SD card, NOT localStorage —
                        // forwarder NROs have saveData=0) and applies on the next launch.
                        // The pause-menu label shows the newly-selected language on the next render.
                        if (menu.languageCycle !== 0 && selectedGame && languageEntries.length > 0) {
                                const codes = languageEntries.map((e) => e.code).concat(['']);
                                const savedRaw = getGameLanguage(selectedGame);
                                const currentCode = savedRaw === undefined ? (languageEntries[0]?.code || '') : savedRaw;
                                const currentIdx = Math.max(0, codes.indexOf(currentCode));
                                const dir = menu.languageCycle;
                                const nextIdx = (currentIdx + dir + codes.length) % codes.length;
                                const nextCode = codes[nextIdx];
                                setGameLanguage(selectedGame, nextCode);
                                try { runtime.SoundManager?.playCursor?.(); } catch { /* best-effort */ }
                                // Update activeLanguageCode so the label re-renders with the new name.
                                activeLanguageCode = nextCode;
                                log(`Language set to ${nextCode || 'English (default)'}; applies on next launch.`);
                        }
                        host?.present();
                        if (menu.blocksInput || !host?.direct()) hud();
                }
                // Plus(+) quit dialog: if + has a game binding, require
                // 500ms hold (so the game's binding fires on single press
                // and the quit dialog fires on hold). If + is unbound,
                // single press shows the dialog immediately.
                //
                // The label and exit mode depend on context:
                //   - Library grid (+ tile or + button): "Quit BurialNX?" / shutdown
                //   - Forwarder-launched game (forwarderTargetId set): "Quit BurialNX?" / shutdown
                //   - Library-launched game (forwarderTargetId null): "Return to library?" / return-to-library
                const plusDown = down(9);
                const plusBlocked = phase === 'notice' || phase === 'rename-kb' || phase === 'add-game-name' || phase === 'rename-choice' || phase === 'forwarder-building' || phase === 'loading';
                if (plusDown && !plusBlocked) {
                        // Determine the exit mode and dialog label for this
                        // context. A game is running when `host` is set.
                        const inGame = !!host;
                        const plusQuitMode: QuitMode = (inGame && !forwarderTargetId) ? 'return-to-library' : 'shutdown';
                        const plusQuitLabel = plusQuitMode === 'return-to-library' ? 'Return to library?' : 'Quit BurialNX?';
                        // Check if + (button 9) has a binding in the active keymap.
                        const activeKeymap = (currentEntry?.keymap) || globalKeymap;
                        const plusBound = activeKeymap.buttons[9] !== 'none';
                        if (plusBound) {
                                // + has a binding → require 500ms hold.
                                if (plusHoldStart === 0) plusHoldStart = now;
                                else if (now - plusHoldStart >= 500) {
                                        exitArmed = true; exitArmedAt = Date.now(); exitNoticeArmed = true;
                                        pendingExitMode = plusQuitMode;
                                        message = plusQuitLabel;
                                        waitForRelease = true; phase = 'notice';
                                        plusHoldStart = 0;
                                }
                        } else {
                                // + is unbound → single press shows the dialog.
                                if (edge(9)) {
                                        exitArmed = true; exitArmedAt = Date.now(); exitNoticeArmed = true;
                                        pendingExitMode = plusQuitMode;
                                        message = plusQuitLabel;
                                        waitForRelease = true; phase = 'notice';
                                }
                                plusHoldStart = 0;
                        }
                } else {
                        plusHoldStart = 0;
                }
                for (let index = 0; index < 16; index++) previousButtons[index] = !!buttons?.[index]?.pressed;
        } catch (error) { fail(error); }
        requestAnimationFrame(frame);
}

function prevKey(key: VirtualKey): VirtualKey {
        const i = VIRTUAL_KEYS.indexOf(key);
        return VIRTUAL_KEYS[(i + VIRTUAL_KEYS.length - 1) % VIRTUAL_KEYS.length];
}
function nextKey(key: VirtualKey): VirtualKey {
        const i = VIRTUAL_KEYS.indexOf(key);
        return VIRTUAL_KEYS[(i + 1) % VIRTUAL_KEYS.length];
}
function applyPreset(index: number) {
        const preset = PRESETS[index];
        if (!preset) return;
        // A preset only redefines the 16 face-button → vkey mappings. It does
        // NOT touch analog-stick bindings (presets don't model sticks), so the
        // user's L/R-stick → keyboard-key bindings survive a preset switch.
        // Without preserving sticks here, applying any preset would silently
        // wipe the user's stick bindings (same root cause as the editor
        // display bug — sticks were dropped on every KeyMap copy).
        const savedSticks = editingKeymap.sticks;
        editingKeymap = { buttons: [...preset.map.buttons] };
        if (savedSticks) {
                editingKeymap.sticks = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = savedSticks[dir];
                        if (b) editingKeymap.sticks[dir] = { keyCode: b.keyCode, label: b.label };
                }
        }
        saveEditingKeymap();
        if (__DEBUG__) log(`Applied preset: ${preset.name}`);
}

/** Persist the working keymap to the appropriate target. When editing the
 *  global default, this writes keymap.json; when editing a per-game keymap,
 *  this updates the library entry and writes library.json. If a game is
 *  currently running, the change is applied immediately to runtime.Input
 *  so the user can test the new binding without restarting. */
function saveEditingKeymap() {
        if (keymapTarget === 'global') {
                keymapValid = saveKeyMap(Switch as unknown as LibraryAccess, editingKeymap);
                if (keymapValid) {
                        // CRITICAL: copy labels AND sticks, not just buttons.
                        // Without labels, the editor shows 'ok' instead of the
                        // bound key (e.g. '1', 'W'). Without sticks, analog
                        // stick bindings are lost.
                        globalKeymap = { buttons: [...editingKeymap.buttons] };
                        if (editingKeymap.labels) globalKeymap.labels = [...editingKeymap.labels];
                        if (editingKeymap.sticks) globalKeymap.sticks = editingKeymap.sticks;
                }
        } else if (keymapTarget) {
                const entry = keymapTarget;
                const newKeymap: KeyMap = { buttons: [...editingKeymap.buttons] };
                if (editingKeymap.labels) newKeymap.labels = [...editingKeymap.labels];
                if (editingKeymap.sticks) newKeymap.sticks = editingKeymap.sticks;
                const updated: LibraryEntry = { ...entry, keymap: newKeymap };
                if (rememberLibrary(updated)) {
                        if (currentEntry && currentEntry.id === entry.id) currentEntry = updated;
                        keymapTarget = updated;
                        keymapValid = true;
                } else keymapValid = false;
        } else {
                keymapValid = false;
        }
        if (host && runtime?.Input) {
                try {
                        // Re-apply the MERGED keymap (per-game + global) to the
                        // running game's gamepadMapper, so a change to either the
                        // per-game or global keymap takes effect immediately.
                        applyKeyMap(runtime, mergedKeymap());
                        if (__DEBUG__) log('Keymap re-applied to running game');
                } catch (error) { log(`Could not re-apply keymap: ${String(error)}`); }
        }
}

/** Open the keymap editor. If a game is running (host is set), default to
 *  editing the active game's per-game keymap when one exists, otherwise the
 *  global default (which the running game is using). Called from the library
 *  tile, the pause-menu "keymap" entry, or the game-options "Edit keymap". */
function openKeymapEditor(target: 'global' | LibraryEntry) {
        keymapTarget = target;
        const source = target === 'global' ? globalKeymap : (target.keymap || globalKeymap);
        // Copy buttons, labels, keyCodes AND sticks from the source keymap.
        // Missing any one of these caused display bugs:
        //  - no labels  → editor shows the vkey ('ok') instead of the bound
        //    key label ('1', 'W', 'Enter') — the "bindings reset to ok" bug.
        //  - no sticks   → analog-stick bindings (e.g. L-stick ↑ = arrow key)
        //    work at runtime (pollStickBindings reads currentEntry.keymap /
        //    globalKeymap directly) but the editor grid shows 'none' for every
        //    stick direction, so the user thinks nothing is assigned. This
        //    was the root cause of the "stick bindings don't show in settings"
        //    bug.
        editingKeymap = { buttons: [...source.buttons] };
        if (source.labels) editingKeymap.labels = [...source.labels];
        if (source.keyCodes) editingKeymap.keyCodes = [...source.keyCodes];
        if (source.sticks) {
                // Shallow-clone each stick binding so editing the working copy
                // never mutates the saved source map.
                editingKeymap.sticks = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = source.sticks[dir];
                        if (b) editingKeymap.sticks[dir] = { keyCode: b.keyCode, label: b.label };
                }
        }
        keymapCursor = 0;
        waitForRelease = true;
        phase = 'keymap';
}

// === Session listener registration =====================================
// Registered LAST, after every state variable the listeners close over is
// initialized, so an event dispatched during synchronous init cannot trip a
// TDZ. This single process-wide registration installs the
// error/unhandledrejection reporters and the beforeunload guard (see the
// session-lifetime listeners above) for the lifetime of the app. There is
// no session reboot: "Quit BurialNX" (and B on the error screen) perform a
// full teardown + Switch.exit, so the next launch is a guaranteed clean
// cold boot from hbmenu — Horizon OS reclaims the reserved process memory
// on exit, which is the only reliably clean reset on this OS.
registerSessionListeners();

// === Touchscreen listener for keymap pages ===========================
// nx.js dispatches TouchEvent on the global `screen` object. Register
// ONE touchstart listener at startup that routes taps on the keymap
// page to the same actions as the gamepad A button — so the user can
// navigate and bind keys purely with the touch screen. Touches are
// ignored on every other phase so the game's own TouchInput handling
// (forwarded to RPG Maker MV in installGameCompatibility) keeps
// working during gameplay.
try {
        (screen as any).addEventListener?.('touchstart', (e: any) => {
                if (phase !== 'keymap') return;
                const t = e?.touches?.[0] || e?.changedTouches?.[0];
                if (!t) return;
                const x = Number(t.clientX), y = Number(t.clientY);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return;
                handleKeymapTouch(x, y);
        });
} catch { /* touchscreen not available on this device */ }

// === Forwarder auto-launch (--game <id>) ==============================
// A forwarder NRO is a small nx.js app whose own main.js just calls
//   new Switch.Application('sdmc:/switch/burialnx/burialnx.nro').launch('--game', '<id>')
// which (via envSetNextLoad, see source/ns.cc) chains into this NRO with
// `--game <id>` on the argv. Here we parse that argument and, if the
// referenced game is in the library, jump straight into launch() — same
// flow as clicking the game in the library grid. If the game is missing
// or no id was given, we fall through to the library UI so the user can
// fix things (delete the stale forwarder, re-add the game, etc.).
//
// Supported forms (the forwarder builder emits the first one):
//   --game <id>          (two tokens)
//   --game=<id>          (one token)
//   --game-id <id>       (alias, two tokens)
//   --game-id=<id>       (alias, one token)
function parseForwarderTarget(argv: readonly string[]): { gameId: string; modForced: boolean } | null {
        let gameId: string | null = null;
        let modForced = false;
        for (let i = 0; i < argv.length; i++) {
                const a = argv[i] ?? '';
                if (a === '--game' || a === '--game-id') {
                        const v = argv[i + 1];
                        if (typeof v === 'string' && v.length > 0) gameId = v;
                }
                const eq = a.startsWith('--game=') ? a.slice('--game='.length)
                        : a.startsWith('--game-id=') ? a.slice('--game-id='.length)
                        : null;
                if (eq !== null && eq.length > 0) gameId = eq;
                if (a === '--mod') modForced = true;
        }
        return gameId ? { gameId, modForced } : null;
}
let forwarderTargetId: string | null = null;
let forwarderForceMod = false;
// Set to true if this NRO was built as a baked-in forwarder (no chain-load).
// Used by the re-launch detection to distinguish baked-in forwarders from
// legacy argv forwarders WITHOUT re-reading __FORWARDER_GAME_ID__ (which
// would create a second 64-'0' match in the romfs, breaking the forwarder
// builder's patchGameIdInRomfs search).
let isBakedForwarder = false;

// === Baked-in forwarder check (NEW approach — no chain-loading) ==========
// If this NRO was built as a forwarder (by patching the 64-'0' placeholder
// in the romfs at forwarder-build time), __FORWARDER_GAME_ID__ contains the
// target game's id. This means NO chain-loading was used (no
// envSetNextLoad), so quitting is a clean Switch.exit() → hbmenu.
//
// This is the PREFERRED forwarder mechanism. The legacy argv-based
// chain-load approach (--game <id>) is kept as a fallback for old
// forwarders built before this change.
try {
        const bakedId = __FORWARDER_GAME_ID__;
        const bakedMod = __FORWARDER_MOD_FORCED__;
        if (bakedId.length >= 64 && bakedId.slice(0, 64) !== '0'.repeat(64)) {
                forwarderTargetId = bakedId.slice(0, 64).trim();
                forwarderForceMod = bakedMod === 'MODFORCED_1';
                isBakedForwarder = true;
                log(`_fwd: BAKED-IN forwarder game id = ${forwarderTargetId}, mod forced = ${forwarderForceMod} (no chain-load, clean exit)`);
        }
} catch { /* constants not defined — normal burialnx launch */ }

// === Legacy argv-based forwarder check (fallback for old forwarders) ====
// Old forwarders chain-load burialnx.nro with --game <id> on the argv.
// This sets envSetNextLoad, which is persistent on some hbloaders and
// causes re-chain loops. New forwarders use the baked-in approach above
// and never touch envSetNextLoad.
if (!forwarderTargetId) {
        try {
                const argv = (Switch as any).argv as readonly string[] | undefined;
                if (Array.isArray(argv) && argv.length > 1) {
                        const parsed = parseForwarderTarget(argv);
                        if (parsed) {
                                forwarderTargetId = parsed.gameId;
                                forwarderForceMod = parsed.modForced;
                                log(`_fwd: LEGACY argv forwarder launch, target game id = ${forwarderTargetId}, mod forced = ${forwarderForceMod}`);
                        }
                }
        } catch (error) { log(`_fwd: argv parse failed: ${error instanceof Error ? error.message : String(error)}`); }
}

// === Stale-next-load re-launch detection ===============================
// When the user quits a LEGACY argv forwarder-launched game, quitApp('shutdown')
// writes the FORWARDER_EXIT_FLAG and then calls Switch.exit(). IF the
// forwarder's envSetNextLoad is still set (hbloader does not clear it
// after chain-loading), hbloader re-chains to burialnx.nro --game id →
// the game would restart in a loop.
//
// To break the loop, we detect the re-launch here: if the exit flag was
// written within RE_LAUNCH_WINDOW_MS, this boot is a stale re-chain
// (not a fresh forwarder launch). We clear the flag and clear
// forwarderTargetId so the auto-launch trigger does NOT re-launch the
// game — the library grid shows instead.
//
// IMPORTANT: this check is ONLY for LEGACY argv forwarders. BAKED-IN
// forwarders (isBakedForwarder === true) never set envSetNextLoad, so
// there is NO re-chain to detect. Skipping the check for them is critical:
// otherwise, the .fwd-exit-flag from a previous exit (written by any
// quitApp('shutdown') call within 30s) would clear forwarderTargetId and
// show the library instead of the game — exactly the bug where the
// forwarder "launches the library like the main app".
try {
        const relaunch = checkForwarderRelaunch();
        if (isBakedForwarder) {
                // Baked-in forwarder: NO envSetNextLoad was set, so there is
                // NO re-chain to detect. Clear any stale flag from a previous
                // session and proceed with the baked-in game auto-launch.
                clearForwarderExitFlag();
        } else if (relaunch.recent) {
                log(`_fwd: stale next-load re-launch detected (age=${relaunch.ageMs}ms) — showing library, NOT re-launching game`);
                clearForwarderExitFlag();
                // CRITICAL: clear forwarderTargetId so the auto-launch trigger
                // below does NOT re-launch the game. The library grid shows
                // instead. We do NOT call chainToLibrary() here (that would
                // set a new stale next-load → library→library loop).
                forwarderTargetId = null;
        } else {
                // Fresh launch — clear any stale flag from a previous session.
                clearForwarderExitFlag();
        }
} catch (error) { log(`_fwd: re-launch detection failed: ${error instanceof Error ? error.message : String(error)}`); }

if (__DEBUG__) log('Startup ready');
requestAnimationFrame(frame);

// === Forwarder auto-launch trigger =====================================
// Scheduled on the next tick (after the first frame is scheduled) so the
// loading screen can paint immediately. If a forwarder target was found
// and exists in the library, we load it into state and start the launch
// flow exactly as if the user had selected it from the library grid.
// If --mod was passed, force the mod on (override the library entry's
// modEnabled setting).
if (forwarderTargetId) {
        try {
                const entry = library.games.find((g) => g.id === forwarderTargetId);
                if (entry) {
                        log(`_fwd: auto-launching "${entry.name}" (id=${entry.id})`);
                        // If the forwarder passed --mod, force the mod on.
                        if (forwarderForceMod && entry.mod) {
                                const modded: LibraryEntry = { ...entry, modEnabled: true };
                                log(`_fwd: forcing mod ON (${entry.mod})`);
                                loadEntryIntoState(modded);
                        } else {
                                loadEntryIntoState(entry);
                        }
                        // Show the loading bar immediately so the user sees
                        // feedback before the (async) launch starts.
                        resetLoading(entry.name, 'Preparing game…');
                        // Defer one tick so the loading screen paints before the
                        // (synchronous-feeling) launch() work begins to block on
                        // SD reads. startOrChooseSaves() will either call launch()
                        // directly or open the save-choice panel.
                        setTimeout(() => {
                                try { startOrChooseSaves(); }
                                catch (error) { fail(error); }
                        }, 0);
                } else {
                        log(`_fwd: no library entry matches id "${forwarderTargetId}"; falling back to library UI`);
                }
        } catch (error) { log(`_fwd: auto-launch failed: ${error instanceof Error ? error.message : String(error)}`); }
}
