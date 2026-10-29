// === Shared mutable state ============================================
// One typed bag holding every `let` that used to live at the top of
// main.ts. The frame loop, launch(), teardownGame(), quitApp(), the
// render functions, the keymap editor, and the selection helpers all
// read/write fields on this object instead of closing over ~60 separate
// module-level `let` bindings — that's what lets those functions move
// into their own modules and shrinks main.ts to a thin entry point.
//
// `S` is the conventional short alias used throughout the loader; main.ts
// imports it as `import { S } from './state'`.

import { DEFAULT_KEYMAP, type KeyMap, type VirtualKey } from './keymap';
import { FolderBrowser } from './folders';
import { PauseMenu } from './menu';
import type { MapPrefetcher } from './map-prefetch';
import type { createBrowserHost } from './browser-host';
import type { GameSelection, SaveLocation } from './settings';
import type { LibraryEntry, LibraryFile } from './game-library';
import type { LanguageEntry } from './game-compat';

declare const __DEBUG__: boolean;

export type Phase = 'library' | 'picker' | 'game-options' | 'keymap' | 'cover-confirm' | 'notice' | 'save-choice' | 'game-save-choice' | 'import-confirm' | 'loading' | 'game' | 'error' | 'rename' | 'rename-kb' | 'rename-choice' | 'add-game-name' | 'forwarder-building';
export type PickerPurpose = 'game' | 'startup-mod' | 'menu-mod' | 'game-mod' | 'startup-saves' | 'menu-saves' | 'add-game' | 'cover-image' | 'rename-source';
export type ExitBehavior = 'shutdown' | 'restart';

export interface AppState {
        // === Runtime + screen (set at startup, then read-only) ===
        ctx: CanvasRenderingContext2D | null;
        runtime: any;
        menu: PauseMenu;
        previousButtons: boolean[];

        // === Picker + current game selection (mutated by the frame loop) ===
        browser: FolderBrowser;
        selectedGame: string | undefined;
        selectedMod: string | null | undefined;
        sharedSaves: boolean;
        languageEntries: LanguageEntry[];
        activeLanguageCode: string;
        waitForRelease: boolean;
        phase: Phase;
        pickerPurpose: PickerPurpose;
        noticeReturnPhase: 'library' | 'game-options';
        saveLocation: SaveLocation | undefined;
        choiceFromMenu: boolean;
        importRequested: boolean;
        message: string;
        host: ReturnType<typeof createBrowserHost> | undefined;
        mapPrefetch: MapPrefetcher | undefined;
        frames: number;
        sampleStart: number;
        fps: number;
        lastFrame: number;
        lastMemoryCheck: number;
        lastFrameWall: number;
        fit: boolean;
        saved: GameSelection | null;
        settingsValid: boolean;
        marqueeOffset: number;
        gameStopped: boolean;

        // === Plus-button exit guard + session exit behavior ===
        exitArmed: boolean;
        exitArmedAt: number;
        exitNoticeArmed: boolean;
        allowExit: boolean;
        plusHoldStart: number;
        exitBehavior: ExitBehavior;

        // === Library grid + per-game state ===
        library: LibraryFile;
        libraryCursor: number;
        libraryPage: number;
        currentEntry: LibraryEntry | null;

        // === Rename + add-game inline state ===
        renameBuffer: string;
        renameCursor: number;
        renameSubmitted: boolean;
        renamePreview: string;
        addGamePath: string;
        addGameDefaultName: string;
        addGameSubmitted: boolean;
        addGamePreview: string;

        // === Keymap editor state ===
        globalKeymap: KeyMap;
        editingKeymap: KeyMap;
        keymapTarget: 'global' | LibraryEntry | null;
        keymapCursor: number;
        keymapValid: boolean;
        keymapPicking: boolean;
        keymapPickCursor: number;

        // === Game options screen state ===
        gameOptionsCursor: number;
        gameOptionsScroll: number;
        currentGameLanguages: LanguageEntry[];

        // === Debug settings (debug build only) ===
        directScreen: boolean;
        directNext: boolean;
        debugSettingsValid: boolean;

        // === Forwarder launch state (set at boot, read by launch/quitApp) ===
        forwarderTargetId: string | null;
        forwarderForceMod: boolean;
        isBakedForwarder: boolean;

        // === Sleep-mode autosave recovery (see src/sleep-recovery.ts) ===
        // When the console wakes from Sleep Mode, nx.js v1.0.0-beta.7 cannot
        // recover the GPU surface — any heavy GPU work crashes with 0x95D. The
        // recovery flow: detect the wake (frame gap), save the live game to a
        // HIDDEN slot (above the game's normal max-savefiles range so the
        // save/load UI never shows it), write a marker file, teardown the game,
        // and chain-launch a FRESH process (fresh GPU surface). The fresh
        // process reads the marker at boot and auto-loads the hidden slot so
        // the player resumes exactly where they were.
        sleepAutoloadPending: boolean;   // true = autoload the hidden save after boot
        sleepAutoloadGameId: string | null; // the game id the marker requested (sanity check)
        sleepAutoloadArmed: boolean;     // set true once the autoload hook is installed in launch()
        // BGM/BGS captured directly from AudioManager at save time (via
        // AudioManager.saveBgm/saveBgs) and passed through the marker file.
        // More reliable than $gameSystem._bgm (which some games/plugins don't
        // populate): this is exactly what was playing through the speakers
        // when the console slept, captured at the AudioManager level.
        sleepAutoloadBgm: any;           // null = none; otherwise {name, volume, pitch, pos}
        sleepAutoloadBgs: any;           // null = none; otherwise {name, volume, pitch, pos}

        // === Frame loop bookkeeping ===
        frameLoggedFirst: boolean;
}

/** Construct the singleton state object. Called ONCE from main.ts at the
 *  top of the file (after the log module init runs). The returned object
 *  is shared across every module that imports `S`. */
export function createState(debug: boolean): AppState {
        const SwitchAny = (globalThis as any).Switch;
        return {
                ctx: null,
                runtime: globalThis as any,
                menu: new PauseMenu(debug),
                previousButtons: Array(16).fill(false),

                browser: new FolderBrowser(SwitchAny, 'game'),
                selectedGame: undefined,
                selectedMod: undefined,
                sharedSaves: false,
                languageEntries: [],
                activeLanguageCode: '',
                waitForRelease: false,
                phase: 'library',
                pickerPurpose: 'game',
                noticeReturnPhase: 'library',
                saveLocation: undefined,
                choiceFromMenu: false,
                importRequested: false,
                message: '',
                host: undefined,
                mapPrefetch: undefined,
                frames: 0,
                sampleStart: 0,
                fps: 0,
                lastFrame: 0,
                lastMemoryCheck: 0,
                lastFrameWall: 0,
                fit: true,
                saved: null,
                settingsValid: true,
                marqueeOffset: 0,
                gameStopped: false,

                exitArmed: false,
                exitArmedAt: 0,
                exitNoticeArmed: false,
                allowExit: false,
                plusHoldStart: 0,
                exitBehavior: 'shutdown',

                library: { version: 1, games: [] },
                libraryCursor: 0,
                libraryPage: 0,
                currentEntry: null,

                renameBuffer: '',
                renameCursor: 0,
                renameSubmitted: false,
                renamePreview: '',
                addGamePath: '',
                addGameDefaultName: '',
                addGameSubmitted: false,
                addGamePreview: '',

                globalKeymap: { buttons: [...DEFAULT_KEYMAP.buttons] },
                editingKeymap: { buttons: [...DEFAULT_KEYMAP.buttons] },
                keymapTarget: null,
                keymapCursor: 0,
                keymapValid: true,
                keymapPicking: false,
                keymapPickCursor: 0,

                gameOptionsCursor: 0,
                gameOptionsScroll: 0,
                currentGameLanguages: [],

                directScreen: true,
                directNext: true,
                debugSettingsValid: true,

                forwarderTargetId: null,
                forwarderForceMod: false,
                isBakedForwarder: false,

                sleepAutoloadPending: false,
                sleepAutoloadGameId: null,
                sleepAutoloadArmed: false,
                sleepAutoloadBgm: null,
                sleepAutoloadBgs: null,

                frameLoggedFirst: false,
        };
}

// The singleton state object, created at module load. Every module that
// imports `S` reads/writes the SAME object — that's the whole point.
export const S: AppState = createState(__DEBUG__);

// Re-export the types this module's callers commonly need so they don't
// each have to import them from three different files.
export type { LibraryEntry, LibraryFile, KeyMap, VirtualKey, GameSelection, SaveLocation, LanguageEntry };
