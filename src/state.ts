import { DEFAULT_KEYMAP, type KeyMap, type VirtualKey } from './keymap';
import type { MessageRenderMode } from './partial-render';
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

        // Virtual mouse cursor (driven by joycon → mouse-action bindings; see mouse-input.ts).
        mouseX: number;
        mouseY: number;
        mouseLmbDown: boolean;
        mouseRmbDown: boolean;
        mouseVisible: boolean;
        /** Mouse-speed slider value (1..10). Effective speed = MOUSE_SPEED × (mouseSpeed × 0.3) × ramp.
         *  Default 5 → multiplier 1.5. Adjusted in the pause menu under "Another…". */
        mouseSpeed: number;
        /** Frame-skip slider value (0..10). 0 = render every dirty frame; 1..10 = on a stable
         *  scene, skip N frames between renders (extra throttle for low-intensity movement).
         *  Adjusted in the pause menu under "Another…" → "Frame skip". Default 0. */
        frameSkip: number;
        /** Message-render mode — how the renderer handles frames where the ONLY visible
         *  change is the message/choice window (cursor blink, finished typewriter):
         *  - 'full'       = render every frame (original behavior, safest).
         *  - 'blink-skip' = skip render on stable-message frames except every Nth
         *                   (default; big FPS win during dialogue, cursor still blinks).
         *  Adjusted in the pause menu under "Another…" → "Message render". Default 'blink-skip'. */
        messageRender: MessageRenderMode;
        /** -1 / 0 / +1 — set by Left/Right while the messageRender item is selected; consumed by the frame loop. */
        messageRenderDelta: number;
        /** Skip the blur in SceneManager.snapForBackground (patch T1). ON = the menu/save/load
         *  background is a crisp snapshot (faster transition); OFF = stock 2-pass box blur
         *  (smoother darkening, but ~18 full-screen blends per transition). Per-game, toggle
         *  in the pause menu under "Another…" → "Experimental" → "Skip fade blur". Default OFF. */
        skipFadeBlur: boolean;
        /** Skip ScreenSprite's 100× fillRect when its alpha is 0 (patch T2). ON = PIXI skips
         *  the giant no-op fill every frame (faster); OFF = stock (always fill, slightly
         *  smoother fade-in first frame). Per-game, toggle in the pause menu under "Another…"
         *  → "Experimental" → "Skip fade fill". Default OFF. */
        skipFadeFill: boolean;
        /** Patch WL: skip WindowLayer's temp-canvas dance when no windows are visible. ON =
         *  skip ~3.2M pixel ops/frame per WindowLayer with no open menus (faster); OFF =
         *  stock (always run the temp-canvas clear+clip+drawImage). Default OFF. */
        windowLayerSkip: boolean;
        /** Patch WR: reuse the window frame/cursor Bitmap instead of allocating a new
         *  OffscreenCanvas on every _refreshFrame/_refreshCursor. ON = reuse (avoids canvas
         *  churn that collapses FPS 60→18); OFF = stock (new Bitmap every refresh). Default OFF. */
        windowBitmapReuse: boolean;
        /** Patch E: raise textureGC.maxIdle from 1 to 600 (keep textures hot 10s). No-op on
         *  CanvasRenderer; only matters if WebGL is ever enabled. ON = 600 (hot); OFF =
         *  stock 1 (aggressive GC). Default OFF. */
        textureGcIdle: boolean;
        /** Patch G: the dirty-flag render-skip + accumulator cap in SceneManager.updateMain.
         *  ON = skip renderScene when nothing changed + cap accumulator to 2 updates/tick
         *  (the biggest single FPS win on static scenes); OFF = stock (render every frame,
         *  accumulator can spiral). Default OFF. */
        dirtyRenderSkip: boolean;
        /** Patch C: cache the present() destination rect (game canvas → screen). ON =
         *  recompute only on resize/fit-toggle (faster); OFF = recompute every present()
         *  (stock). Default OFF. */
        presentCache: boolean;
        /** Patch CanvasNode: skip the same-value canvas.width/height assignment (which clears
         *  the surface per spec). ON = skip when unchanged (faster); OFF = stock (always
         *  assign, always clear). Default OFF. */
        canvasNodeSkip: boolean;
        /** A2 (toggle smoothingOff): nearest downscale for present(). Default OFF. */
        smoothingOff: boolean;
        /** A3 (toggle skipPresent): skip present() when render was skip'ed + no overlay. Default OFF. */
        skipPresent: boolean;
        /** B1 (toggle eventUpdateSkip): skip Game_Event.update for static events. Default OFF. */
        eventUpdateSkip: boolean;
        /** D1 (toggle spriteRenderSkip): Sprite._renderCanvas early-return for invisible sprites. Default OFF. */
        spriteRenderSkip: boolean;
        /** Internal: true if renderScene() ran this frame (read by A3). Not a user toggle. */
        lastFrameRendered: boolean;
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

                mouseX: 640,
                mouseY: 360,
                mouseLmbDown: false,
                mouseRmbDown: false,
                mouseVisible: false,
                mouseSpeed: 5,
                frameSkip: 0,
                messageRender: 'blink-skip',
                messageRenderDelta: 0,
                skipFadeBlur: false,
                skipFadeFill: false,
                windowLayerSkip: false,
                windowBitmapReuse: false,
                textureGcIdle: false,
                dirtyRenderSkip: false,
                presentCache: false,
                canvasNodeSkip: false,
                smoothingOff: false,
                skipPresent: false,
                eventUpdateSkip: false,
                spriteRenderSkip: false,
                lastFrameRendered: false,
        };
}

export const S: AppState = createState(__DEBUG__);

export type { LibraryEntry, LibraryFile, KeyMap, VirtualKey, GameSelection, SaveLocation, LanguageEntry };
