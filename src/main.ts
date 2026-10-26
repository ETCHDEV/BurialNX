import { FolderBrowser } from './folders';
import { gameAssets } from './game-assets';
import { scriptPlan, startGame } from './runtime-plan';
import { createBrowserHost } from './browser-host';
import { installGameCompatibility, languageTable, prepareGameScript, registerFonts } from './game-compat';
import { PauseMenu } from './menu';
import { gameSaveFolders, parseSelection, startupSelection, type GameSelection, type SaveLocation } from './settings';
import { needsPngFix } from './indexed-png';
import { ensureGameSaveFolder, hasSteamSaveData, importSteamSaves, installSdSaves, safeGameSaveFolder, safeSaveFolder } from './saves';
import { installMapPrefetch, MapPrefetcher } from './map-prefetch';
import { entryFromSelection, libraryIdFromRoot, loadLibrary, markPlayed, removeGame, toSelection, upsertGame, type LibraryEntry, type LibraryFile, type LibraryAccess } from './game-library';
import { BUTTON_NAMES, DEFAULT_KEYMAP, applyKeyMap, loadKeyMap, PRESETS, saveKeyMap, setButton, setButtonWithLabel, VIRTUAL_KEYS, type KeyMap, type VirtualKey } from './keymap';
import { COVERS_DIR, coverPathFor, deriveDefaultCover, saveUserCover, saveUserCoverLogged } from './cover';

declare const __DEBUG__: boolean;
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
let waitForRelease = false;
let phase: 'library' | 'picker' | 'game-options' | 'keymap' | 'cover-confirm' | 'notice' | 'save-choice' | 'game-save-choice' | 'import-confirm' | 'loading' | 'game' | 'error' | 'rename' | 'rename-kb' = 'library';
let pickerPurpose: 'game' | 'startup-mod' | 'menu-mod' | 'game-mod' | 'startup-saves' | 'menu-saves' | 'add-game' | 'cover-image' = 'game';
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

// === Plus-button exit guard state ======================================
let exitArmed = false;
let exitArmedAt = 0;
let exitNoticeArmed = false;
let allowExit = false;
const realExit = typeof (Switch as any).exit === 'function' ? (Switch as any).exit.bind(Switch) : null;

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

function quitApp() {
        // Return all memory and shut everything down before exiting: stop the
        // game (audio + frame loop + image buffers) and run a final GC pass,
        // then let the runtime tear the process down — nx.js unmounts save
        // data and releases its native arenas from Switch.exit().
        try { teardownGame(); } catch { /* best-effort */ }
        if (realExit) { allowExit = true; realExit(); }
        else { /* fall back to letting the runtime handle it */ }
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
        editingKeymap = { buttons: [...globalKeymap.buttons] };
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
                const labels: Record<string, string> = { continue: 'Resume', load: 'Load existing save', saves: 'Choose save location (restart)', import: 'Import Steam saves to current location', resolution: `Display: ${fit ? 'fit' : 'native size'}`, fps: `FPS: ${menu.fps ? 'on' : 'off'}`, mod: 'Select mod for next launch', direct: `Direct screen next start: ${directNext ? 'on' : 'off'}`, snapshot: 'Write diagnostic snapshot', keymap: 'Edit joycon key bindings', quit: 'Quit BurialNX (exit to hbmenu)' };
                panel(['BurialNX  |  Up/Down: select  A: choose  B: close', `${fps.toFixed(1)} FPS`, ...menu.items.map((item, i) => `${i === menu.selected ? '> ' : '  '}${labels[item]}`)]);
        } else if (menu.fps) panel([`${fps.toFixed(1)} FPS`]);
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
                // Verify PNG signature
                if (u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) {
                        entry.failed = true;
                        log(`Cover not a PNG: ${path} (first bytes: ${u8[0].toString(16)} ${u8[1].toString(16)} ${u8[2].toString(16)} ${u8[3].toString(16)})`);
                        return entry;
                }
                // IHDR is at offset 8+4+4 = 16 (after signature + length + type).
                // IHDR data: width(4 BE), height(4 BE), bitDepth(1), colorType(1),
                // compression(1), filter(1), interlace(1).
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
                // Convert to base64 data URL. The native decoder takes a
                // different code path for data: URLs (in-memory buffer) vs
                // sdmc:/ paths (file fetch), which avoids the crash.
                let binary = '';
                const CHUNK = 8192;
                for (let i = 0; i < u8.length; i += CHUNK) {
                        const chunk = u8.subarray(i, Math.min(i + CHUNK, u8.length));
                        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
                }
                const base64 = (typeof btoa === 'function') ? btoa(binary) : '';
                if (base64) {
                        img.src = `data:image/png;base64,${base64}`;
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
        ctx.fillText(`Page ${libraryPage + 1}/${totalPages}  ·  ${library.games.length} game(s)`, 28, 68);
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
                ctx.strokeStyle = selected ? '#f4f3ef' : '#3a3f5c';
                ctx.lineWidth = selected ? 3 : 1;
                ctx.strokeRect(x + 1, y + 1, tileW - 2, tileH - 2);
                if (isAction) {
                        // Fixed font (already set to 20px). No auto-shrink.
                        ctx.fillStyle = '#f4f3ef';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        const labels = ['+ Add Game', 'Keymap Settings', 'Quit BurialNX'];
                        ctx.fillText(labels[actionIdx] || '', x + tileW / 2, y + tileH / 2);
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
        }
        // Footer hint
        ctx.fillStyle = '#9aa0b4';
        ctx.fillText('A: Play  X: Options  Y: Add game  B/Minus: Settings menu  Plus: Quit', 28, screen.height - 24);
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
function renderGameOptions() {
        if (!currentEntry) { phase = 'library'; return; }
        const hasPerGameKeymap = !!currentEntry.keymap;
        const hasMod = currentEntry.mod !== undefined && currentEntry.mod !== null;
        const modOn = hasMod && currentEntry.modEnabled !== false;
        const lines = [
                `Game: ${currentEntry.name}`,
                `Path: ${currentEntry.root}`,
                `Cover: ${currentEntry.cover || '(none — auto-detect or pick)'}`,
                `Shared saves: ${currentEntry.sharedSaves ? 'yes' : 'no'}`,
                `Mod: ${hasMod ? (modOn ? 'ON' : 'OFF') + ' — ' + currentEntry.mod : '(none)'}`,
                `Save: ${currentEntry.saves ? (currentEntry.saves.kind === 'switch' ? 'Switch user data' : currentEntry.saves.folder) : '(not set)'}`,
                `Keymap: ${hasPerGameKeymap ? 'per-game (overrides global)' : 'global default'}`,
                '',
                `> Play`,
                '  Pick cover image',
                '  Auto-detect cover from .exe/.ico',
                '  Edit keymap (this game)',
                hasPerGameKeymap ? '  Reset to global keymap' : '  (no per-game keymap to reset)',
                '  Rename game',
                hasMod ? '  Change mod folder' : '  Select mod folder',
                modOn ? '  Disable mod' : (hasMod ? '  Enable mod' : '  (no mod to toggle)'),
                '  Toggle shared saves',
                '  Change save folder',
                '  Delete from library',
                '  Back to library (B)',
        ];
        const start = 8;
        lines[start + gameOptionsCursor] = lines[start + gameOptionsCursor].replace(/^  /, '> ');
        panel(['BurialNX — game options', ...lines], true);
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
// The keyboard occupies x=0..14, y=0..5.3. Navigation keys are at x=15.5..17.5.
// Mouse buttons are drawn separately on the right side.
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
        // Navigation cluster (x=15.5..17.5)
        { label: 'Prt', keyCode: 44, x: 15.5, y: 0, w: 1, h: 1 }, { label: 'Scr', keyCode: 145, x: 16.5, y: 0, w: 1, h: 1 },
        { label: 'Pause', keyCode: 19, x: 17.5, y: 0, w: 1, h: 1 },
        { label: 'Ins', keyCode: 45, x: 15.5, y: 1.3, w: 1, h: 1 }, { label: 'Home', keyCode: 36, x: 16.5, y: 1.3, w: 1, h: 1 },
        { label: 'PgUp', keyCode: 33, x: 17.5, y: 1.3, w: 1, h: 1 },
        { label: 'Del', keyCode: 46, x: 15.5, y: 2.3, w: 1, h: 1 }, { label: 'End', keyCode: 35, x: 16.5, y: 2.3, w: 1, h: 1 },
        { label: 'PgDn', keyCode: 34, x: 17.5, y: 2.3, w: 1, h: 1 },
        { label: '↑', keyCode: 38, x: 16.5, y: 4.3, w: 1, h: 1 },
        { label: '←', keyCode: 37, x: 15.5, y: 5.3, w: 1, h: 1 }, { label: '↓', keyCode: 40, x: 16.5, y: 5.3, w: 1, h: 1 },
        { label: '→', keyCode: 39, x: 17.5, y: 5.3, w: 1, h: 1 },
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
// Combined pickable list: keyboard keys only (no mouse).
// Created lazily when the keyboard picker opens, not at module scope.
let _allPickKeys: { label: string; vkey: VirtualKey }[] | null = null;
function getAllPickKeys() {
        if (!_allPickKeys) _allPickKeys = KEYBOARD_LAYOUT.map(k => ({ label: k.label, vkey: KEYCODE_TO_VKEY[k.keyCode] || ('none' as VirtualKey) }));
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
        ctx.fillText('D-pad: move  A: pick key  L/R/ZL/ZR: presets 1-4  B: back', 28, 84);
        // Grid: 4 columns × 4 rows = 16 buttons. Each cell 280×120 with 10px gaps.
        const cols = 4;
        const cellW = 280, cellH = 120, gap = 10;
        const gridW = cols * cellW + (cols - 1) * gap;
        const startX = Math.floor((screen.width - gridW) / 2);
        const startY = 110;
        for (let i = 0; i < 16; i++) {
                const c = i % cols, r = Math.floor(i / cols);
                const x = startX + c * (cellW + gap), y = startY + r * (cellH + gap);
                const selected = i === keymapCursor;
                const key = editingKeymap.buttons[i];
                const color = KEYMAP_COLORS[key] || '#6e7681';
                ctx.fillStyle = selected ? '#3a3f5c' : '#252840';
                ctx.fillRect(x, y, cellW, cellH);
                ctx.fillStyle = color;
                ctx.fillRect(x, y, 6, cellH);
                ctx.strokeStyle = selected ? '#f4f3ef' : '#3a3f5c';
                ctx.lineWidth = selected ? 3 : 1;
                ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
                ctx.fillStyle = '#f4f3ef'; ctx.textAlign = 'left';
                ctx.fillText(BUTTON_NAMES[i], x + 16, y + 26);
                // Show the keyboard key label (e.g. '5', 'U', 'Enter') if available,
                // otherwise show the virtual key name (e.g. 'ok', 'cancel').
                const displayLabel = editingKeymap.labels?.[i] || key;
                ctx.fillStyle = color; ctx.textAlign = 'center';
                ctx.fillText(displayLabel, x + cellW / 2, y + cellH / 2 + 18);
                ctx.fillStyle = '#6e7681'; ctx.textAlign = 'left';
                ctx.fillText(`#${i}`, x + 12, y + cellH - 8);
        }
        // Footer
        ctx.fillStyle = '#9aa0b4'; ctx.textAlign = 'left';
        ctx.fillText(`Status: ${keymapValid ? 'saved' : 'unsaved'}`, 28, screen.height - 20);
}

function renderKeyboardPicker(targetLabel: string) {
        const btn = BUTTON_NAMES[keymapCursor];
        const curKey = editingKeymap.buttons[keymapCursor];
        const curLabel = editingKeymap.labels?.[keymapCursor] || curKey;
        // Header
        ctx.fillStyle = '#f4f3ef'; ctx.textAlign = 'left';
        ctx.fillText(`Pick a key for: ${btn}`, 28, 36);
        ctx.fillStyle = '#9aa0b4';
        ctx.fillText(`Current: ${curLabel}  |  ${targetLabel}`, 28, 60);
        ctx.fillText('D-pad: navigate  A: bind  B: back', 28, 84);
        // Keyboard area: centered horizontally AND vertically, scale=55px per key unit
        const scale = 55;
        const kbMaxW = 18 * scale;
        const kbX = Math.floor((screen.width - kbMaxW) / 2);
        const kbMaxH = 6.3 * scale; // keyboard spans y=0..5.3+1
        const kbY = Math.floor((screen.height - kbMaxH) / 2);
        // Draw all keyboard keys
        for (let i = 0; i < KEYBOARD_LAYOUT.length; i++) {
                const k = KEYBOARD_LAYOUT[i];
                const x = kbX + k.x * scale, y = kbY + k.y * scale;
                const w = k.w * scale - 2, h = k.h * scale - 2;
                const vkey = KEYCODE_TO_VKEY[k.keyCode] || 'none';
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
        const text = typeof vk?.value === 'string' ? vk.value : renamePreview;
        const caret = Math.max(0, Math.min(text.length, Number(vk?.cursorIndex) || 0));
        const max = Number(vk?.maxLength) || 64;
        const oldName = currentEntry?.name ?? '';
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#161823';
        ctx.fillRect(0, 0, screen.width, screen.height);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#f4f3ef';
        ctx.font = '24px sans-serif';
        ctx.fillText('BurialNX — rename game', 28, 44);
        ctx.fillStyle = '#9aa0b4';
        ctx.font = '20px sans-serif';
        ctx.fillText(oldName ? `Renaming “${oldName}”. Type below — your text appears in this field as you type.` : 'Type below — your text appears in this field as you type.', 28, 78);
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
        try {
                // Snapshot the global scope before anything game-related is installed:
                // every global the game, its fonts, its timers or its host add on top
                // of this point is undone by teardownGame() when the user quits the
                // app, so no game data survives into the next cold boot.
                beginGameSession();
                if (!selectedGame) throw new Error('No game selected');
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
                const [language, , pngFix] = await Promise.all([languageTable(assets), registerFonts(assets, runtime), needsPngFix(log)]);
                host = createBrowserHost(assets, prepareGameScript, log, pngFix, directScreen, failRequest);
                for (const path of scripts) { log(`Loading ${path}`); await host.loadScript(path); }
                await host.settled();
                installGameCompatibility(runtime, selectedGame, sharedSaves, language, pngFix, currentEntry?.keymap || globalKeymap);
                mapPrefetch = new MapPrefetcher(assets, log);
                installMapPrefetch(runtime, mapPrefetch, log);
                if (!saveLocation) throw new Error('No save location selected');
                if (saveLocation.kind === 'sd' || saveLocation.kind === 'game') {
                        if (!validSaveLocation(saveLocation, selectedGame, selectedMod || null)) throw new Error('Invalid save folder');
                        if (saveLocation.kind === 'game') ensureGameSaveFolder(Switch, saveLocation.folder, selectedGame, selectedMod || null);
                        installSdSaves(runtime, Switch, saveLocation.folder);
                }
                if (importRequested) { const count = importSteamSaves(runtime, Switch, selectedGame, saveLocation); log(`Imported ${count} Steam save slots`); }
                if (runtime.Graphics?.render) {
                        const render = runtime.Graphics.render;
                        runtime.Graphics.render = function(...args: unknown[]) { const result = render.apply(this, args); hud(); return result; };
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
                                if (gameStopped) { this.requestUpdate(); return; }
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
// Play, Pick cover, Auto-detect, Edit keymap, Reset keymap, Rename game,
// Change mod folder, Toggle mod, Toggle shared saves, Change save folder,
// Delete, Back = 12 options, indices 0..11.
const GAME_OPTIONS_COUNT = 12;

function libraryTileCount() { return library.games.length + LIBRARY_ACTION_TILES; }

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
                                if (edge(12) || edge(14)) libraryCursor = (libraryCursor + total - 1) % total;
                                if (edge(13) || edge(15)) libraryCursor = (libraryCursor + 1) % total;
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
                                                else if (actionIdx === 2) { quitApp(); }
                                        } else if (entry) {
                                                loadEntryIntoState(entry);
                                                startOrChooseSaves();
                                        }
                                } else if (edge(3) && entry) {
                                        loadEntryIntoState(entry);
                                        gameOptionsCursor = 0;
                                        waitForRelease = true; phase = 'game-options';
                                } else if (edge(2)) {
                                        // Y = Add game from anywhere in the library.
                                        browser = new FolderBrowser(Switch, 'game', 'sdmc:/switch/burialnx'); pickerPurpose = 'add-game'; waitForRelease = true; phase = 'picker';
                                }
                        }
                        renderLibrary();
                } else if (phase === 'game-options') {
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease) {
                                if (edge(13)) gameOptionsCursor = (gameOptionsCursor + 1) % GAME_OPTIONS_COUNT;
                                if (edge(12)) gameOptionsCursor = (gameOptionsCursor + GAME_OPTIONS_COUNT - 1) % GAME_OPTIONS_COUNT;
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
                                                // Rename game — use the Switch's built-in software keyboard (swkbd).
                                                if (currentEntry && navigator?.virtualKeyboard) {
                                                        const vk = navigator.virtualKeyboard;
                                                        vk.okButtonText = 'Save';
                                                        vk.type = 0; // Normal text keyboard
                                                        vk.maxLength = 64; // library names are validated to <= 128
                                                        // Seed the keyboard with the game's current name so it opens
                                                        // for editing (nx.js sends the value as the swkbd input text
                                                        // and places the cursor at its end). Whatever comes back on
                                                        // 'submit' replaces the whole name at once.
                                                        vk.value = currentEntry.name;
                                                        renameSubmitted = false;
                                                        renamePreview = currentEntry.name;
                                                        // nx.js dispatches 'change' on every keypress (and
                                                        // 'cursormove' when the cursor moves) with the keyboard's
                                                        // full current text in vk.value. The swkbd itself does not
                                                        // render the input, so the preview field is the player's
                                                        // only live feedback — keep it in sync while typing.
                                                        const onLiveInput = () => { renamePreview = vk.value; };
                                                        // nx.js dispatches 'geometrychange' (from onHide) BEFORE
                                                        // 'submit'. So we must DELAY the geometrychange processing
                                                        // to give 'submit' a chance to fire first.
                                                        const onSubmit = () => {
                                                                renameSubmitted = true;
                                                                // vk.value is the full text from the keyboard: replace the
                                                                // entire name with it (fall back to the old name if empty).
                                                                const text = vk.value || currentEntry!.name;
                                                                renamePreview = text;
                                                                const updated: LibraryEntry = { ...currentEntry!, name: text };
                                                                if (rememberLibrary(updated)) { currentEntry = updated; message = 'Name changed.'; }
                                                                else message = 'Could not save name.';
                                                                waitForRelease = true; phase = 'notice';
                                                        };
                                                        const onGeometryChange = () => {
                                                                if (vk.boundingRect.height === 0) {
                                                                        // Delay processing to allow 'submit' to fire first
                                                                        setTimeout(() => {
                                                                                vk.removeEventListener('submit', onSubmit as EventListener);
                                                                                vk.removeEventListener('geometrychange', onGeometryChange as EventListener);
                                                                                vk.removeEventListener('change', onLiveInput as EventListener);
                                                                                vk.removeEventListener('cursormove', onLiveInput as EventListener);
                                                                                if (!renameSubmitted) {
                                                                                        // Cancelled (submit didn't fire within the delay)
                                                                                        waitForRelease = true; phase = 'game-options';
                                                                                }
                                                                        }, 50);
                                                                }
                                                        };
                                                        vk.addEventListener('submit', onSubmit as EventListener);
                                                        vk.addEventListener('geometrychange', onGeometryChange as EventListener);
                                                        vk.addEventListener('change', onLiveInput as EventListener);
                                                        vk.addEventListener('cursormove', onLiveInput as EventListener);
                                                        vk.show();
                                                        phase = 'rename-kb'; // freeze game-options rendering
                                                } else {
                                                        // Fallback: character-cycling editor (if swkbd unavailable)
                                                        renameBuffer = currentEntry.name.slice(0, 64);
                                                        while (renameBuffer.length < 8) renameBuffer += ' ';
                                                        renameCursor = 0;
                                                        waitForRelease = true; phase = 'rename';
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
                                        } else if (gameOptionsCursor === 10) {
                                                // Delete
                                                if (currentEntry) {
                                                        library = removeGame(Switch as unknown as LibraryAccess, library, currentEntry.id);
                                                        invalidateCoverCache();
                                                        currentEntry = null;
                                                        message = 'Game removed from library.';
                                                        waitForRelease = true; phase = 'library';
                                                }
                                        } else if (gameOptionsCursor === 11) {
                                                // Back
                                                waitForRelease = true; phase = 'library';
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
                                                        editingKeymap = setButtonWithLabel(editingKeymap, keymapCursor, def.vkey, def.label);
                                                        saveEditingKeymap();
                                                        keymapPicking = false;
                                                        waitForRelease = true;
                                                }
                                        }
                                        // B: back to button grid
                                        if (edge(0)) { keymapPicking = false; waitForRelease = true; }
                                } else {
                                        // Phase 1: button grid navigation
                                        if (edge(12)) keymapCursor = (keymapCursor + 12) % 16;
                                        if (edge(13)) keymapCursor = (keymapCursor + 4) % 16;
                                        if (edge(14)) { const r = keymapCursor % 4; keymapCursor = r === 0 ? keymapCursor + 3 : keymapCursor - 1; }
                                        if (edge(15)) { const r = keymapCursor % 4; keymapCursor = r === 3 ? keymapCursor - 3 : keymapCursor + 1; }
                                        // A: enter keyboard picker for this button
                                        if (edge(1)) { keymapPicking = true; keymapPickCursor = 0; waitForRelease = true; }
                                        // X: clear binding (set to none)
                                        if (edge(3)) { editingKeymap = setButton(editingKeymap, keymapCursor, 'none'); saveEditingKeymap(); }
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
                } else if (phase === 'rename-kb') {
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
                                                // Add a new game to the library.
                                                const id = libraryIdFromRoot(result);
                                                const name = result.split('/').pop() || 'Game';
                                                // Try to derive a cover from the folder.
                                                let cover: string | null = null;
                                                try { cover = deriveDefaultCover(Switch as unknown as LibraryAccess & { readDirSync(path: string): string[] | null }, id, result); }
                                                catch (error) { log(`Cover auto-detect failed: ${String(error)}`); }
                                                const entry: LibraryEntry = { id, name, root: result, sharedSaves: false, mod: null, ...(cover ? { cover } : { cover: null }) };
                                                if (rememberLibrary(entry)) { library = loadLibrary(Switch as unknown as LibraryAccess); invalidateCoverCache(); }
                                                // Pre-select the new game.
                                                const idx = library.games.findIndex((g) => g.id === id);
                                                if (idx >= 0) libraryCursor = idx;
                                                libraryPage = Math.floor(libraryCursor / LIBRARY_PAGE_SIZE);
                                                waitForRelease = true; phase = 'library';
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
                        const lines = ['BurialNX', message];
                        // When the notice is an exit-confirmation, the second + press
                        // triggers the real exit through guardedExit. We just need to
                        // return to the previous phase on B (or + if not the exit notice).
                        if (exitNoticeArmed) lines.push('Press Plus (+) again to confirm quit. B: stay.');
                        else lines.push('B: return');
                        panel(lines, true);
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease && (buttons?.[0]?.pressed && !previousButtons[0])) {
                                exitNoticeArmed = false; exitArmed = false;
                                if (host) { menu.dismiss(); phase = 'game'; }
                                else { phase = currentEntry ? 'game-options' : 'library'; waitForRelease = true; }
                        } else if (!waitForRelease && exitNoticeArmed && down(9)) {
                                // Second + press: real exit. (guardedExit also catches it
                                // via the keydown path; this is the gamepad-side path.)
                                exitNoticeArmed = false;
                                quitApp();
                        }
                } else if (phase === 'error') {
                        panel(['BurialNX — game could not start', message, __DEBUG__ ? `Details: ${hostLogPath}` : 'Try the debug build for details.', 'Press B to exit BurialNX (relaunch for a clean library).'], true);
                        if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
                        else if (!waitForRelease && buttons?.[0]?.pressed && !previousButtons[0]) {
                                waitForRelease = true;
                                // A failed launch leaves half-installed game state behind. Exit
                                // the app fully (teardown + Switch.exit) so the next launch is
                                // a guaranteed clean cold boot — exactly like "Quit BurialNX"
                                // from the pause menu. Horizon OS reserves the process memory
                                // and reclaims it on exit, so this is the only reliably clean
                                // reset; an in-process session reboot proved unstable on
                                // hardware (froze on the "Loading…" splash).
                                quitApp();
                        }
                } else if (phase === 'loading') panel(['BurialNX', 'Opening game…', ...(__DEBUG__ ? debugLines : [])], true);
                else {
                        diagnoseScene(now);
                        if (now - lastMemoryCheck >= 5000) {
                                lastMemoryCheck = now;
                                try {
                                        const memory = (Switch as any).memoryUsage?.();
                                        if (memory?.nativeHeapUsed > 1024 * 1024 * 1024 && typeof runtime.gc === 'function') runtime.gc();
                                } catch { /* memory diagnostics are optional */ }
                        }
                        if (!sampleStart) sampleStart = now;
                        frames++; if (now - sampleStart >= 1000) { fps = frames * 1000 / (now - sampleStart); sampleStart = now; frames = 0; }
                        const action = menu.step(buttons, now);
                        if (mapPrefetch && fps >= 50 && !menu.blocksInput && typeof runtime.Scene_Map === 'function' &&
                                runtime.SceneManager?._scene instanceof runtime.Scene_Map && runtime.SceneManager._sceneStarted &&
                                !runtime.SceneManager._nextScene && !runtime.SceneManager._stopped && runtime.$dataMap && !runtime.$gamePlayer?.isTransferring?.()) {
                                mapPrefetch.tick(now, true);
                        }
                        if (action === 'load' && runtime.SceneManager && runtime.Scene_Load) runtime.SceneManager.push(runtime.Scene_Load);
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
                                        if (!currentEntry.keymap) {
                                                const seeded: LibraryEntry = { ...currentEntry, keymap: { buttons: [...globalKeymap.buttons] } };
                                                if (rememberLibrary(seeded)) currentEntry = seeded;
                                        }
                                        openKeymapEditor(currentEntry);
                                } else {
                                        openKeymapEditor('global');
                                }
                        }
                        if (action === 'quit') { quitApp(); }
                        if (action === 'direct' && debugSettingsValid) {
                                try { const value = !directNext; Switch.writeFileSync(debugSettingsPath, JSON.stringify({ directScreen: value })); directNext = value; log('Direct-screen setting saved; restart required.'); }
                                catch (error) { log(`Could not save direct-screen setting: ${String(error)}`); }
                        }
                        if (action === 'snapshot') { log(`Snapshot: scene=${runtime.SceneManager?._scene?.constructor?.name || 'unknown'}, fps=${fps.toFixed(1)}`); snapshotRuntimeLog(); }
                        host?.present();
                        if (menu.blocksInput || !host?.direct()) hud();
                }
                // Detect + button (gamepad button 9) for quit confirmation.
                // While the software keyboard is open (rename-kb), + belongs to
                // the keyboard session and must not be treated as a quit
                // request — pressing it while typing must do nothing.
                if (edge(9) && phase !== 'notice' && phase !== 'rename-kb') {
                        exitArmed = true; exitArmedAt = Date.now(); exitNoticeArmed = true;
                        message = 'Press Plus (+) again to quit BurialNX. B: stay.';
                        waitForRelease = true; phase = 'notice';
                } else if (edge(9) && exitNoticeArmed && (Date.now() - exitArmedAt < 2000)) {
                        exitNoticeArmed = false;
                        quitApp();
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
        editingKeymap = { buttons: [...preset.map.buttons] };
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
                if (keymapValid) globalKeymap = { buttons: [...editingKeymap.buttons] };
        } else if (keymapTarget) {
                // Per-game keymap: store inline on the library entry.
                const entry = keymapTarget;
                const updated: LibraryEntry = { ...entry, keymap: { buttons: [...editingKeymap.buttons] } };
                if (rememberLibrary(updated)) {
                        // Keep currentEntry in sync when the user is editing the
                        // currently-selected game's keymap.
                        if (currentEntry && currentEntry.id === entry.id) currentEntry = updated;
                        keymapTarget = updated;
                        keymapValid = true;
                } else keymapValid = false;
        } else {
                keymapValid = false;
        }
        // If a game is running, re-apply the (now updated) keymap immediately.
        // This makes in-game key remapping take effect on the very next frame.
        if (host && runtime?.Input) {
                try {
                        const active = (keymapTarget && keymapTarget !== 'global' && (keymapTarget as LibraryEntry).keymap)
                                ? (keymapTarget as LibraryEntry).keymap!
                                : globalKeymap;
                        applyKeyMap(runtime, active);
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
        if (target === 'global') editingKeymap = { buttons: [...globalKeymap.buttons] };
        else editingKeymap = { buttons: [...(target.keymap || globalKeymap).buttons] };
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

if (__DEBUG__) log('Startup ready');
requestAnimationFrame(frame);
