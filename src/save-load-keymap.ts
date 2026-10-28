// === Save/Load keymap override =======================================
// Extracted from main.ts. During Scene_Save and Scene_Load, override the
// gamepad keymap so the save/load menu's confirm (ok) and cancel buttons
// MATCH the game's A/B mapping — i.e. whichever button the game uses for
// 'ok' confirms a save slot, and whichever it uses for 'cancel' backs out.
// When the scene changes back to the game (Scene_Map etc.), the per-game
// keymap is restored.
//
// === WHY DYNAMIC (not hardcoded DEFAULT) ===============================
// An earlier version forced the DEFAULT layout (A=ok, B=cancel) here so
// the save menu was "always usable" with face buttons — but that IGNORED
// the user's A/B remapping: a player who set B=ok / A=cancel for the game
// got B=cancel / A=ok in the save menu (inverted!). Now the override
// builds a mapper from menuButtonIndicesFor(mergedKeymap()):
//   buttons[mc] = 'ok'     (mc = the game's 'ok' button, or default A)
//   buttons[mx] = 'cancel' (mx = the game's 'cancel' button, or default B)
// so the save menu mirrors the game's A/B exactly, while keeping the rest
// of the DEFAULT layout (D-pad = up/down/left/right, X/Y/shoulders =
// shift/menu/pageup/pagedown) so save-slot navigation still works when
// the game bound ok/cancel to a non-face button.
//
// The module owns the `saveLoadKeymapActive` and `savedGamepadMapper`
// flags so they persist across frames. The runtime (globalThis) is read
// via the `globalThis` global — identical to the `runtime` alias in
// main.ts.
//
// === INPUT ISOLATION (the "B in save menu → game fast-forwards" fix) ===
// While `saveLoadKeymapActive` is true, the frame loop and the
// _updateGamepadState wrapper SKIP pollButtonBindings / pollStickBindings
// (see frame-loop.ts and game-launch.ts). This is the decisive fix for the
// bug where pressing B in the save menu saved AND triggered accelerated
// fast-forward in the game: pollButtonBindings was firing
// Input._onKeyDown(B's keyCode) every frame during Scene_Save, leaving
// stale _currentState[pageDown]=true that Scene_Map read as "held" after
// the save menu closed. By skipping the per-frame keyCode injection while
// the save/load scene is active AND clearing stale state on entry/exit
// (clearButtonKeyState), no button-keyCode state can survive the scene
// boundary — so the game can't fast-forward from a held save-menu button.
//
// isSaveLoadKeymapActive() is exported so frame-loop.ts and game-launch.ts
// can gate their polling calls without reaching into module-private state.

import { DEFAULT_KEYMAP, menuButtonIndicesFor, type KeyMap } from './keymap';
import { mergedKeymap } from './keymap-editor';
import type { LibraryEntry } from './game-library';
import { clearButtonKeyState } from './stick-bindings';

declare const __DEBUG__: boolean;

export type LogFn = (line: string) => void;

let saveLoadKeymapActive = false;
let savedGamepadMapper: any = null;
// The currentEntry / globalKeymap are passed in at call time so
// clearButtonKeyState can clear the RIGHT button keyCode bindings on
// save/load enter/exit (the per-game keymap may bind different buttons
// than the global default).

/** True while the active scene is Scene_Save or Scene_Load (the save/load
 *  keymap override is in effect). The frame loop and the
 *  _updateGamepadState wrapper read this to SKIP pollButtonBindings /
 *  pollStickBindings during the save/load scene — see the module header
 *  for why that prevents the "B in save menu → game fast-forwards" bug. */
export function isSaveLoadKeymapActive(): boolean {
        return saveLoadKeymapActive;
}

/** Build a gamepadMapper for the save/load scene that mirrors the game's
 *  A/B mapping. Starts from DEFAULT_KEYMAP (so D-pad = up/down/left/right,
 *  X/Y/shoulders keep their navigation roles) and SWAPS the ok/cancel
 *  vkeys onto the dynamic confirm/cancel button indices (mc/mx from
 *  menuButtonIndicesFor). So:
 *    - if the game has B=ok / A=cancel → mc=0, mx=1 → button 0='ok',
 *      button 1='cancel' (the save menu confirms with B, cancels with A);
 *    - if neither A nor B is ok/cancel → mc=1, mx=0 (default) → button
 *      1='ok', button 0='cancel' (save menu usable with face buttons even
 *      when the game bound ok to a shoulder).
 *  Exported so tests can verify the mapping in isolation. */
export function buildSaveLoadMapper(mc: number, mx: number): Record<number, string> {
        const mapper: Record<number, string> = {};
        DEFAULT_KEYMAP.buttons.forEach((vkey, i) => {
                if (i === mc) mapper[i] = 'ok';
                else if (i === mx) mapper[i] = 'cancel';
                else mapper[i] = vkey;
        });
        return mapper;
}

/** Clear the 'ok' / 'cancel' input state that Scene_Save / Scene_Load
 *  touched so a stale trigger/repeat doesn't leak into the resumed scene,
 *  AND set _currentState/_previousState to match the physical gamepad so
 *  the next Input._updateGamepadState / Input.update sees NO fresh edge
 *  (which would re-trigger the vkey and cause the same leak the clear was
 *  meant to prevent).
 *
 *  This is the fix for BOTH reported bugs:
 *
 *  Bug "save → fast-forward": Window_Message.isTriggered() returns
 *    `Input.isRepeated('ok') || Input.isRepeated('cancel')`, and
 *    isRepeated needs `_latestButton === keyName`. After saving (A=ok
 *    held), _latestButton was 'ok' with _pressedTime incrementing; on
 *    scene resume isRepeated('ok') returned true → _showFast=true → the
 *    typewriter fast-forwarded. Clearing _latestButton=null (and
 *    _pressedTime=0) breaks that leak — no vkey is "repeated" until the
 *    user physically re-presses the button.
 *
 *  Bug "cancel during a choice → bitmap crash": a stale 'ok'/'cancel'
 *    trigger leaking into the resumed Scene_Message could make the
 *    dialogue auto-advance / the choice window auto-select during the
 *    fresh scene's setup (when windows are half-created), touching a
 *    sprite whose bitmap wasn't ready → "Cannot read properties of
 *    undefined (reading 'bitmap')". Clearing the stale trigger prevents
 *    the auto-advance so the choice window's start()/refresh() runs
 *    cleanly on the next user-driven frame, not during the half-set-up
 *    resume frame.
 *
 *  RPG Maker MV's Input system (rpg_core.js) uses `_currentState`,
 *  `_previousState`, `_latestButton`, `_pressedTime` — NOT `_events`
 *  (an earlier version of this function cleared `_events`, which was a
 *  no-op since RPG Maker MV has no such property). Exported for testing. */
export function clearSaveLoadVkeyState(mc: number, mx: number): void {
        const runtime = globalThis as any;
        const input = runtime.Input;
        if (!input) return;
        const pad = (navigator as any).getGamepads?.()?.[0];
        const physical = (i: number) => !!pad?.buttons?.[i]?.pressed;
        const okHeld = physical(mc);
        const cancelHeld = physical(mx);
        // _currentState: match the physical button state so
        // _updateGamepadState (which keys off _gamepadStates edges) and
        // Input.update (which keys off _currentState vs _previousState)
        // both see NO up→down edge → no fresh _latestButton assignment.
        if (input._currentState) {
                input._currentState['ok'] = okHeld;
                input._currentState['cancel'] = cancelHeld;
        }
        // _previousState: also match physical so Input.update's edge check
        // (`_currentState[name] && !_previousState[name]`) is false for
        // ok/cancel even if they're held across the scene boundary.
        if (input._previousState) {
                input._previousState['ok'] = okHeld;
                input._previousState['cancel'] = cancelHeld;
        }
        // _latestButton + _pressedTime: the CRUCIAL clear. This is what stops
        // isRepeated('ok'/'cancel') from returning true on the resumed
        // scene's first frames (the fast-forward bug) and stops a stale
        // trigger from auto-advancing the dialogue/choice during the
        // half-set-up resume frame (the bitmap crash).
        input._latestButton = null;
        input._pressedTime = 0;
}

/** Detect whether the game is currently showing a dialogue CHOICE
 *  (Window_ChoiceList active/open). When the user opens Scene_Save/Scene_Load
 *  during an active choice and then cancels, the game's scene-resume logic
 *  RE-DRAWS the choice window — and that re-draw crashes with
 *  "Cannot read properties of undefined (reading 'bitmap')" because the
 *  choice window's shared bitmaps were disposed during the Scene_Save
 *  overlay. (Regular dialogue without choices re-animates fine; only the
 *  choice window's re-creation fails.)
 *
 *  This helper lets the pause menu BLOCK Save/Load while a choice is on
 *  screen, so the crash never happens. The user can still Save/Load during
 *  a regular dialogue (no choices active).
 *
 *  DETECTION (two paths, either is sufficient):
 *   1. `$gameMessage.choices` is a non-empty array (standard RPG Maker MV —
 *      populated by the "Show Choices" event command, cleared when the user
 *      picks one). Also honor `$gameMessage.isChoice()` if a plugin exposes
 *      it. NOTE: we do NOT require the active scene to be `Scene_Message`
 *      — in RPG Maker MV, `Scene_Message` is a MIXIN baked into Scene_Map /
 *      Scene_Battle, so the active scene during a dialogue is `Scene_Map`
 *      (NOT an instance of Scene_Message). Requiring `instanceof
 *      Scene_Message` would make this check always-false and the block
 *      would never trigger (that was the bug — the crash kept happening
 *      because Save/Load opened during choices).
 *   2. The active scene has an OPEN choice window (`_choiceWindow` /
 *      `_choiceListWindow` with `open`/`active`/`visible` true). This is a
 *      fallback for custom message systems (Yanfly etc.) that might store
 *      the choice list under a different property name or not populate
 *      `$gameMessage.choices` the standard way. */
export function isActiveChoice(runtime: any = globalThis as any): boolean {
        const sm = runtime.SceneManager;
        const scene = sm?._scene;
        if (!scene) return false;
        // Path 1: $gameMessage.choices (standard RPG Maker MV). No scene-type
        // check — see the comment above for why (Scene_Message is a mixin).
        const msg = runtime.$gameMessage;
        if (msg) {
                if (Array.isArray(msg.choices) && msg.choices.length > 0) return true;
                if (typeof msg.isChoice === 'function' && msg.isChoice()) return true;
        }
        // Path 2: the active scene has an open choice window. RPG Maker MV's
        // Scene_Message mixin creates `this._choiceWindow`; some plugins /
        // custom systems name it `_choiceListWindow`. Check `open`, `active`,
        // and `visible` (any of them true means the window is on screen).
        const cw = scene._choiceWindow ?? scene._choiceListWindow;
        if (cw && (cw.open === true || cw.active === true || cw.visible === true)) return true;
        return false;
}

/** Wrap `SceneManager.pop` so that when Scene_Save/Scene_Load pops, the
 *  save/load override (gamepadMapper + vkey state) is cleared AT THE MOMENT
 *  of pop — BEFORE the resumed scene's update runs in the same updateMain
 *  call.
 *
 *  WHY: `overrideKeymapForSaveLoadScene` runs in BurialNX's frame() rAF,
 *  but the game's `SceneManager.updateMain` (which pops the scene AND runs
 *  the resumed scene's update in the same call) is a SEPARATE rAF. So the
 *  frame()-based EXIT detection always lags one frame behind the actual
 *  scene transition — the resumed Scene_Message had already updated (with
 *  the stale override mapper + stale ok/cancel vkey trigger from the save
 *  scene's last frame) before frame() got to clear it. That stale trigger
 *  made the dialogue advance/close in a half-set-up state → crash.
 *
 *  By hooking pop() directly, the clear runs synchronously when Scene_Save
 *  calls SceneManager.pop() (in its processCancel / processOk), BEFORE
 *  updateMain transitions to the resumed scene. Idempotent — safe to call
 *  multiple times (the wrapper checks `__bnxPopHooked`). */
export function installSaveLoadPopHook(): void {
        const runtime = globalThis as any;
        const sm = runtime.SceneManager;
        if (!sm || typeof sm.pop !== 'function' || sm.__bnxPopHooked) return;
        sm.__bnxPopHooked = true;
        const origPop = sm.pop;
        sm.pop = function() {
                // Only act when the save/load override is active (i.e. the
                // scene popping IS Scene_Save/Scene_Load). For every other
                // pop, this is a transparent passthrough.
                if (saveLoadKeymapActive) {
                        try {
                                const km = mergedKeymap();
                                const { confirm: mc, cancel: mx } = menuButtonIndicesFor(km);
                                clearSaveLoadVkeyState(mc, mx);
                                clearButtonKeyState(null, km);
                        } catch { /* best-effort — never block the pop */ }
                        if (savedGamepadMapper && runtime.Input) runtime.Input.gamepadMapper = savedGamepadMapper;
                        savedGamepadMapper = null;
                        saveLoadKeymapActive = false;
                        // Suppress the dialogue/choice re-display for a few frames after
                        // the pop so the freshly-created scene's windows + bitmaps
                        // settle before Window_Message.canStart → startMessage →
                        // choice-window start()/refresh() runs. This is the fix for the
                        // "Cannot read properties of undefined (reading 'bitmap')"
                        // crash on cancelling save/load during a dialogue choice.
                        // The flag is read + decremented by the Window_Message.canStart
                        // wrapper installed in installGameCompatibility (game-compat.ts).
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
                // Entering save/load scene — save the current (per-game) mapper
                // and replace it with the DYNAMIC one that mirrors the game's
                // A/B mapping (ok on the game's 'ok' button, cancel on the
                // game's 'cancel' button), keeping the DEFAULT D-pad/shoulders
                // for save-slot navigation.
                savedGamepadMapper = runtime.Input.gamepadMapper;
                const { confirm: mc, cancel: mx } = menuButtonIndicesFor(mergedKeymap());
                runtime.Input.gamepadMapper = buildSaveLoadMapper(mc, mx);
                saveLoadKeymapActive = true;
                // CRITICAL: clear any button-keyCode state that pollButtonBindings
                // already injected this frame (before the scene changed). Without
                // this, a button held at the moment the save menu opened would
                // keep firing keydown into the game via the stale _currentState.
                try { clearButtonKeyState(currentEntry, globalKeymap); } catch { /* best-effort */ }
                // Also clear the ok/cancel vkey state so a stale trigger from the
                // PREVIOUS scene (e.g. the user pressed 'ok' to advance a
                // dialogue, then opened the save menu) doesn't leak INTO the
                // save scene and auto-select a save slot on the first frame.
                try { clearSaveLoadVkeyState(mc, mx); } catch { /* best-effort */ }
                if (__DEBUG__) log(`save/load keymap: overridden to mirror game A/B (confirm=button ${mc}, cancel=button ${mx}); button keyCode + vkey state cleared`);
        } else if (!isSaveLoad && saveLoadKeymapActive) {
                // Leaving save/load scene — restore the per-game keymap.
                if (savedGamepadMapper) runtime.Input.gamepadMapper = savedGamepadMapper;
                savedGamepadMapper = null;
                saveLoadKeymapActive = false;
                // Recompute mc/mx (the restored per-game mapper will use these)
                // and clear the ok/cancel vkey state. This is the fix for the
                // "press Cancel in save menu → bitmap crash" bug: a stale
                // 'ok'/'cancel' trigger from Scene_Save's last frame would
                // otherwise leak into the resumed Scene_Message and make it
                // advance/close a dialogue choice in a half-set-up state.
                const { confirm: mc, cancel: mx } = menuButtonIndicesFor(mergedKeymap());
                try { clearSaveLoadVkeyState(mc, mx); } catch { /* best-effort */ }
                // Clear again on exit: any button the user held inside the
                // save/load scene (where polling was skipped) must not leak as
                // stale _currentState into the now-active gameplay scene.
                try { clearButtonKeyState(currentEntry, globalKeymap); } catch { /* best-effort */ }
                if (__DEBUG__) log('save/load keymap: restored per-game keymap; button keyCode + vkey state cleared');
        }
}
