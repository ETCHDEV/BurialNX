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
import { BUTTON_NAMES, DEFAULT_KEYMAP, applyKeyMap, loadKeyMap, PRESETS, saveKeyMap, setButton, setButtonWithLabel, type KeyMap, type VirtualKey } from './keymap';
import { COVERS_DIR, coverPathFor, deriveDefaultCover, saveUserCover, saveUserCoverLogged } from './cover';
import { buildForwarder, deleteForwarder, forwarderExists, forwarderPathFor, forwarderDirFor, renameForwarder, sanitizeGameName, BURIALNX_NRO_PATH, BURIALNX_DEBUG_NRO_PATH } from './forwarder';
import { log, snapshotRuntimeLog, debugLines, hostLogPath, logsPath } from './log';
import { drawSplash, fatal } from './splash';
import { setLoadingProgress, resetLoading, renderLoading } from './loading-screen';
import { KEYMAP_COLORS, KEYBOARD_LAYOUT, KEYCODE_TO_VKEY, getAllPickKeys, findNearestKey, prevKey, nextKey } from './keymap-layout';
import { KEYMAP_GRID_COLS, KEYMAP_CELL_W, KEYMAP_CELL_H, KEYMAP_KB_SCALE, keymapButtonCellRect, keymapKbOrigin, keymapKeyRect, keymapBackButtonRect, pointInRect, drawBackButton } from './keymap-geometry';
import { roundedRectPath, truncateForDisplay, panel } from './canvas-utils';
import { parseForwarderTarget } from './forwarder-argv';
import { libraryTileCount, libraryNavigateRow } from './library-nav';
import { beginGameSession, endGameSession } from './game-session';
import { diagnoseScene, resetDiagnostics } from './diagnostics';
import { pollStickBindings, pollButtonBindings, makeSyntheticKeyboardEvent } from './stick-bindings';
import { overrideKeymapForSaveLoadScene } from './save-load-keymap';
import { loadCoverImage, invalidateCoverCache } from './cover-cache';
import { actionIcons } from './action-icons';
import { renderPauseMenu, renderQuitDialog, renderNoticePopup, hud } from './render-overlay';
import { renderLibrary, drawPlaceholderCover, LIBRARY_COLS, LIBRARY_ROWS, LIBRARY_PAGE_SIZE, LIBRARY_ACTION_TILES } from './render-library';
import { renderGameOptions } from './render-options';
import { renderKeymap, renderRenameKb } from './keymap-render';
import { teardownGame, quitApp, chainToLibrary, removeLegacyExitFlagFile, realExit } from './game-lifecycle';
import { fail, failRequest, registerSessionListeners, removeBeforeUnloadListener, removeAllSessionListeners } from './error-handling';
import { launch } from './game-launch';
import { validSaveLocation, remember, rememberLibrary, getGameLanguage, setGameLanguage, currentSelection, loadEntryIntoState, startOrChooseSaves, chooseSaves, settingsPath } from './selection';
import { suggestGameName, finishAddGame, startForwarderBuild } from './add-game';
import { mergedKeymap, openKeymapEditor, saveEditingKeymap, applyPreset, handleKeymapTouch } from './keymap-editor';
import { frame } from './frame-loop';
import { installLocalStorageShim } from './localstorage-shim';
import { consumeSleepMarker, installSleepAutoload } from './sleep-recovery';
import { S, type Phase, type ExitBehavior } from './state';
import { resetMouseCursor } from './mouse-input';

declare const __DEBUG__: boolean;
declare const __FORWARDER_GAME_ID__: string;
declare const __FORWARDER_MOD_FORCED__: string;
const settingsPath = 'sdmc:/switch/burialnx/settings.json';

installLocalStorageShim();

try {
        S.ctx = screen.getContext('2d');
        log(`_2: screen.getContext returned ${S.ctx ? 'a context' : 'null'}`);
} catch (error) {
        log(`_2: screen.getContext threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
}

drawSplash(S.ctx, 'Loading…');

// Center the virtual mouse cursor on the physical screen now that the screen
// global is available. (createState defaults to 640x360; this corrects for
// docked 1080p or any other resolution.)
try { resetMouseCursor(); } catch { /* best-effort — screen global always present on Switch */ }

log('_3: startupUserAccount=0 in NACP, localStorage intentionally untouched — no profile dialog');
if (__DEBUG__) try {
        const memory = (Switch as any).memoryUsage?.();
        if (memory) log(`_4: V8 heap limit=${Math.round(memory.heapSizeLimit / 1048576)} MiB, native heap=${Math.round(memory.nativeHeapTotal / 1048576)} MiB`);
} catch {}


if (__DEBUG__) log('Reading SD card folders');



const debugSettingsPath = 'sdmc:/switch/burialnx/debug-settings.json';
if (__DEBUG__) try {
        const raw = Switch.readFileSync(debugSettingsPath);
        if (raw) {
                const value = JSON.parse(new TextDecoder().decode(raw));
                if (typeof value?.directScreen !== 'boolean') throw new Error('Invalid debug settings');
                S.directScreen = S.directNext = value.directScreen;
        }
} catch { S.debugSettingsValid = false; }
try {
        S.library = loadLibrary(Switch as unknown as LibraryAccess);
        log(`_9: loadLibrary ok, ${S.library.games.length} games`);
} catch (error) { log(`_9: loadLibrary failed: ${error instanceof Error ? error.message : String(error)}`); }
try {
        S.globalKeymap = loadKeyMap(Switch as unknown as LibraryAccess);
        S.editingKeymap = { buttons: [...S.globalKeymap.buttons] };
        if (S.globalKeymap.labels) S.editingKeymap.labels = [...S.globalKeymap.labels];
        if (S.globalKeymap.keyCodes) S.editingKeymap.keyCodes = [...S.globalKeymap.keyCodes];
        if (S.globalKeymap.sticks) {
                S.editingKeymap.sticks = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = S.globalKeymap.sticks[dir];
                        if (b) S.editingKeymap.sticks[dir] = { keyCode: b.keyCode, label: b.label, vkey: b.vkey };
                }
        }
        log(`_11: loadKeyMap ok, ${S.globalKeymap.buttons.filter((b) => b !== 'none').length} active bindings`);
} catch (error) { log(`_11: loadKeyMap failed: ${error instanceof Error ? error.message : String(error)}`); S.keymapValid = false; }

// Load the persisted mouse-speed slider value (pause menu → Another…). Default 5.
try {
        const raw = Switch.readFileSync('sdmc:/switch/burialnx/mouse-settings.json');
        if (raw) {
                const value = JSON.parse(new TextDecoder().decode(raw));
                if (typeof value?.speed === 'number') S.mouseSpeed = Math.max(1, Math.min(10, Math.round(value.speed)));
        }
} catch { /* defaults to 5 */ }

try {
        if (S.library.lastPlayed) {
                const idx = S.library.games.findIndex((g) => g.id === S.library.lastPlayed);
                if (idx >= 0) S.libraryCursor = idx;
        }
} catch {}

try {
        const data = Switch.readFileSync(settingsPath);
        if (data) {
                S.saved = parseSelection(new TextDecoder().decode(data));
                const selected = startupSelection(Switch, S.saved, __DEBUG__);
                if (selected) {
                        if (!S.library.games.some((g) => g.root === selected.root)) {
                                const entry = entryFromSelection(selected);
                                try { S.library = upsertGame(Switch as unknown as LibraryAccess, S.library, entry); } catch {}
                        }
                }
        }
} catch { S.settingsValid = false; }






const GAME_OPTIONS_BASE_COUNT = 14;

registerSessionListeners();

try {
        (screen as any).addEventListener?.('touchstart', (e: any) => {
                if (S.phase !== 'keymap') return;
                const t = e?.touches?.[0] || e?.changedTouches?.[0];
                if (!t) return;
                const x = Number(t.clientX), y = Number(t.clientY);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return;
                handleKeymapTouch(x, y);
        });
} catch {}

try {
        const bakedId = __FORWARDER_GAME_ID__;
        const bakedMod = __FORWARDER_MOD_FORCED__;
        if (bakedId.length >= 64 && bakedId.slice(0, 64) !== '0'.repeat(64)) {
                S.forwarderTargetId = bakedId.slice(0, 64).trim();
                S.forwarderForceMod = bakedMod === 'MODFORCED_1';
                S.isBakedForwarder = true;
                log(`_fwd: BAKED-IN forwarder game id = ${S.forwarderTargetId}, mod forced = ${S.forwarderForceMod} (no chain-load, clean exit)`);
        }
} catch {}

if (!S.forwarderTargetId) {
        try {
                const argv = (Switch as any).argv as readonly string[] | undefined;
                if (Array.isArray(argv) && argv.length > 1) {
                        const parsed = parseForwarderTarget(argv);
                        if (parsed) {
                                S.forwarderTargetId = parsed.gameId;
                                S.forwarderForceMod = parsed.modForced;
                                log(`_fwd: LEGACY argv forwarder launch, target game id = ${S.forwarderTargetId}, mod forced = ${S.forwarderForceMod}`);
                        }
                }
        } catch (error) { log(`_fwd: argv parse failed: ${error instanceof Error ? error.message : String(error)}`); }
}

try {
        const marker = consumeSleepMarker();
        if (marker) {
                S.sleepAutoloadGameId = marker.gameId;
                S.sleepAutoloadPending = true;
                S.sleepAutoloadBgm = marker.bgm;
                S.sleepAutoloadBgs = marker.bgs;
                log(`_sleep: autoload requested: gameId=${marker.gameId}, bgm=${marker.bgm?.name || 'none'}, bgs=${marker.bgs?.name || 'none'}`);
        }
} catch (error) { log(`_sleep: marker consume failed: ${error instanceof Error ? error.message : String(error)}`); }

removeLegacyExitFlagFile();

if (__DEBUG__) log('Startup ready');
requestAnimationFrame(frame);

if (S.forwarderTargetId) {
        try {
                const entry = S.library.games.find((g) => g.id === S.forwarderTargetId);
                if (entry) {
                        log(`_fwd: auto-launching "${entry.name}" (id=${entry.id})`);
                        if (S.forwarderForceMod && entry.mod) {
                                const modded: LibraryEntry = { ...entry, modEnabled: true };
                                log(`_fwd: forcing mod ON (${entry.mod})`);
                                loadEntryIntoState(modded);
                        } else {
                                loadEntryIntoState(entry);
                        }
                        resetLoading(entry.name, 'Preparing game…');
                        setTimeout(() => {
                                try { startOrChooseSaves(); }
                                catch (error) { fail(error); }
                        }, 0);
                } else {
                        log(`_fwd: no library entry matches id "${S.forwarderTargetId}"; falling back to library UI`);
                }
        } catch (error) { log(`_fwd: auto-launch failed: ${error instanceof Error ? error.message : String(error)}`); }
}

if (S.sleepAutoloadGameId && S.forwarderTargetId) {
        if (S.sleepAutoloadGameId !== S.forwarderTargetId) {
                log(`_sleep: marker gameId "${S.sleepAutoloadGameId}" != forwarder id "${S.forwarderTargetId}" — discarding autoload`);
                S.sleepAutoloadGameId = null;
                S.sleepAutoloadPending = false;
                S.sleepAutoloadBgm = null;
                S.sleepAutoloadBgs = null;
        }
} else if (S.sleepAutoloadGameId && !S.forwarderTargetId) {
        try {
                const entry = S.library.games.find((g) => g.id === S.sleepAutoloadGameId);
                if (entry) {
                        log(`_sleep: auto-launching "${entry.name}" for sleep autoload (id=${entry.id})`);
                        loadEntryIntoState(entry);
                        resetLoading(entry.name, 'Resuming after sleep…');
                        setTimeout(() => {
                                try { startOrChooseSaves(); }
                                catch (error) { fail(error); }
                        }, 0);
                } else {
                        log(`_sleep: no library entry matches sleep gameId "${S.sleepAutoloadGameId}" — discarding autoload`);
                        S.sleepAutoloadGameId = null;
                        S.sleepAutoloadPending = false;
                        S.sleepAutoloadBgm = null;
                        S.sleepAutoloadBgs = null;
                }
        } catch (error) {
                log(`_sleep: library autoload failed: ${error instanceof Error ? error.message : String(error)} — discarding autoload`);
                S.sleepAutoloadGameId = null;
                S.sleepAutoloadPending = false;
                S.sleepAutoloadBgm = null;
                S.sleepAutoloadBgs = null;
        }
}
