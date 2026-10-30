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
        ctx: CanvasRenderingContext2D | null;
        runtime: any;
        menu: PauseMenu;
        previousButtons: boolean[];

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

        exitArmed: boolean;
        exitArmedAt: number;
        exitNoticeArmed: boolean;
        allowExit: boolean;
        plusHoldStart: number;
        exitBehavior: ExitBehavior;

        library: LibraryFile;
        libraryCursor: number;
        libraryPage: number;
        currentEntry: LibraryEntry | null;

        renameBuffer: string;
        renameCursor: number;
        renameSubmitted: boolean;
        renamePreview: string;
        addGamePath: string;
        addGameDefaultName: string;
        addGameSubmitted: boolean;
        addGamePreview: string;

        globalKeymap: KeyMap;
        editingKeymap: KeyMap;
        keymapTarget: 'global' | LibraryEntry | null;
        keymapCursor: number;
        keymapValid: boolean;
        keymapPicking: boolean;
        keymapPickCursor: number;

        gameOptionsCursor: number;
        gameOptionsScroll: number;
        currentGameLanguages: LanguageEntry[];

        directScreen: boolean;
        directNext: boolean;
        debugSettingsValid: boolean;

        forwarderTargetId: string | null;
        forwarderForceMod: boolean;
        isBakedForwarder: boolean;

        sleepAutoloadPending: boolean;
        sleepAutoloadGameId: string | null;
        sleepAutoloadArmed: boolean;
        sleepAutoloadBgm: any;
        sleepAutoloadBgs: any;

        wakeSteadyFrames: number;
        wakeArmed: boolean;
        wakeNativeEnabled: boolean;

        exitInProgress: boolean;

        frameLoggedFirst: boolean;
}

/** Construct the singleton state object shared across every loader module. */
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

                wakeSteadyFrames: 0,
                wakeArmed: false,
                wakeNativeEnabled: true,

                exitInProgress: false,

                frameLoggedFirst: false,
        };
}

export const S: AppState = createState(__DEBUG__);

export type { LibraryEntry, LibraryFile, KeyMap, VirtualKey, GameSelection, SaveLocation, LanguageEntry };
