import { DEFAULT_KEYMAP, menuButtonIndicesFor, type KeyMap } from './keymap';
import { mergedKeymap } from './keymap-editor';
import type { LibraryEntry } from './game-library';
import { clearButtonKeyState } from './stick-bindings';

declare const __DEBUG__: boolean;

export type LogFn = (line: string) => void;

let saveLoadKeymapActive = false;
let savedGamepadMapper: any = null;

/** True while the active scene is Scene_Save or Scene_Load. */
export function isSaveLoadKeymapActive(): boolean {
        return saveLoadKeymapActive;
}

/** Build a gamepadMapper for the save/load scene mirroring the game's A/B mapping. */
export function buildSaveLoadMapper(mc: number, mx: number): Record<number, string> {
        const mapper: Record<number, string> = {};
        DEFAULT_KEYMAP.buttons.forEach((vkey, i) => {
                if (i === mc) mapper[i] = 'ok';
                else if (i === mx) mapper[i] = 'cancel';
                else mapper[i] = vkey;
        });
        return mapper;
}

/** Clear the ok/cancel vkey state touched by Scene_Save/Scene_Load. */
export function clearSaveLoadVkeyState(mc: number, mx: number): void {
        const runtime = globalThis as any;
        const input = runtime.Input;
        if (!input) return;
        const pad = (navigator as any).getGamepads?.()?.[0];
        const physical = (i: number) => !!pad?.buttons?.[i]?.pressed;
        const okHeld = physical(mc);
        const cancelHeld = physical(mx);
        if (input._currentState) {
                input._currentState['ok'] = okHeld;
                input._currentState['cancel'] = cancelHeld;
        }
        if (input._previousState) {
                input._previousState['ok'] = okHeld;
                input._previousState['cancel'] = cancelHeld;
        }
        input._latestButton = null;
        input._pressedTime = 0;
}

/** Detect whether the game is currently showing a dialogue choice. */
export function isActiveChoice(runtime: any = globalThis as any): boolean {
        const sm = runtime.SceneManager;
        const scene = sm?._scene;
        if (!scene) return false;
        const msg = runtime.$gameMessage;
        if (msg) {
                if (Array.isArray(msg.choices) && msg.choices.length > 0) return true;
                if (typeof msg.isChoice === 'function' && msg.isChoice()) return true;
        }
        const cw = scene._choiceWindow ?? scene._choiceListWindow;
        if (cw && (cw.open === true || cw.active === true || cw.visible === true)) return true;
        return false;
}

/** Wrap SceneManager.pop so the save/load override clears on Scene_Save/Scene_Load pop. */
export function installSaveLoadPopHook(): void {
        const runtime = globalThis as any;
        const sm = runtime.SceneManager;
        if (!sm || typeof sm.pop !== 'function' || sm.__bnxPopHooked) return;
        sm.__bnxPopHooked = true;
        const origPop = sm.pop;
        sm.pop = function() {
                if (saveLoadKeymapActive) {
                        try {
                                const km = mergedKeymap();
                                const { confirm: mc, cancel: mx } = menuButtonIndicesFor(km);
                                clearSaveLoadVkeyState(mc, mx);
                                clearButtonKeyState(null, km);
                        } catch {}
                        if (savedGamepadMapper && runtime.Input) runtime.Input.gamepadMapper = savedGamepadMapper;
                        savedGamepadMapper = null;
                        saveLoadKeymapActive = false;
                        (runtime as any)._bnxSuppressMessageStart = 3;
                }
                return origPop.apply(this, arguments);
        };
}

export function overrideKeymapForSaveLoadScene(
        log: LogFn = () => {},
        currentEntry: LibraryEntry | null = null,
        globalKeymap: KeyMap = DEFAULT_KEYMAP,
): void {
        const runtime = globalThis as any;
        const manager = runtime.SceneManager;
        const scene = manager?._scene;
        if (!scene || !runtime.Scene_Save || !runtime.Input) return;
        const isSaveLoad = scene instanceof runtime.Scene_Save || (runtime.Scene_Load && scene instanceof runtime.Scene_Load);
        if (isSaveLoad && !saveLoadKeymapActive) {
                savedGamepadMapper = runtime.Input.gamepadMapper;
                const { confirm: mc, cancel: mx } = menuButtonIndicesFor(mergedKeymap());
                runtime.Input.gamepadMapper = buildSaveLoadMapper(mc, mx);
                saveLoadKeymapActive = true;
                try { clearButtonKeyState(currentEntry, globalKeymap); } catch {}
                try { clearSaveLoadVkeyState(mc, mx); } catch {}
                if (__DEBUG__) log(`save/load keymap: overridden to mirror game A/B (confirm=button ${mc}, cancel=button ${mx}); button keyCode + vkey state cleared`);
        } else if (!isSaveLoad && saveLoadKeymapActive) {
                if (savedGamepadMapper) runtime.Input.gamepadMapper = savedGamepadMapper;
                savedGamepadMapper = null;
                saveLoadKeymapActive = false;
                const { confirm: mc, cancel: mx } = menuButtonIndicesFor(mergedKeymap());
                try { clearSaveLoadVkeyState(mc, mx); } catch {}
                try { clearButtonKeyState(currentEntry, globalKeymap); } catch {}
                if (__DEBUG__) log('save/load keymap: restored per-game keymap; button keyCode + vkey state cleared');
        }
}
