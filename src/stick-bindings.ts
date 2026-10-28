// === Analog stick + face-button bindings =============================
// Extracted from main.ts. Polls the gamepad analog sticks and face buttons
// each frame and simulates keyboard key presses (or sets vkey state
// directly) for the bound keys via Input._currentState. This lets the user
// bind L-stick/R-stick directions to movement keys and bind face buttons
// to keyboard keyCodes that the game's keyMapper then translates.
//
// The module owns the `prevStickDirActive` edge-detection state so it
// stays consistent across frames. `currentEntry` and `globalKeymap` are
// passed in at call time (they live in main.ts as the user edits them).
// `runtime` is the game's global scope (globalThis) — the same alias
// main.ts uses.

import type { KeyMap, VirtualKey } from './keymap';
import type { LibraryEntry } from './game-library';

// Track previous stick-direction active states for EDGE-DETECTED release.
// Without this, pollStickBindings would set _currentState[key] = false
// EVERY frame the stick is idle — which would override a face button's
// held-true for the same vkey (e.g. if button A is mapped to 'ok' and
// R↓ is also bound to 'ok', releasing R↓ while holding A would
// prematurely release 'ok'). With edge detection, we only set false on
// the release TRANSITION (stick was active last frame, now inactive).
const prevStickDirActive: Record<string, boolean> = {};

/** Build a synthetic KeyboardEvent-like object that RPG Maker MV's
 *  Input._onKeyDown / _onKeyUp can consume without throwing. MV's handlers
 *  call `event.preventDefault()` unconditionally (and some plugins also
 *  call `event.stopPropagation()` / `stopImmediatePropagation()`), so the
 *  event must look like a real DOM KeyboardEvent — not a plain
 *  `{ keyCode }`. The no-op methods safely satisfy those calls without
 *  touching the OS HID stack (which we cannot reach from a homebrew
 *  loader anyway). */
export function makeSyntheticKeyboardEvent(keyCode: number) {
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

/** Poll the gamepad analog sticks and fire the bound keys.
 *
 *  MERGE SEMANTICS (the fix for "right-stick bindings don't fire"):
 *  When a per-game keymap exists, its stick bindings OVERRIDE the global
 *  default PER DIRECTION — not wholesale. Previously, if the per-game
 *  keymap had `sticks: { lUp, lDown, lLeft, lRight }` (left stick only,
 *  e.g. from an earlier edit session), `pollStickBindings` used ONLY
 *  those four directions and ignored the global right-stick bindings
 *  (`rUp/rDown/rLeft/rRight`). Result: left stick worked, right stick
 *  was dead — even though the user HAD bound right-stick keys (to the
 *  global keymap). Now each direction falls back to the global binding
 *  when the per-game keymap doesn't override it, so a per-game keymap
 *  that only customizes SOME directions still inherits the rest. */
export function pollStickBindings(currentEntry: LibraryEntry | null, globalKeymap: KeyMap): void {
        const runtime = globalThis as any;
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

/** Poll the 16 face buttons. For each button that has a non-zero keyCode
 *  binding, call Input._onKeyDown/_onKeyUp directly. This fires the game's
 *  keyboard handler, which sets _currentState[keyCode] and lets the game's
 *  keyMapper translate the keyCode to a virtual key. This is needed because
 *  RPG Maker MV's _currentState uses keyCodes (from keyboard) AND virtual
 *  key names (from gamepad) — they're separate namespaces. Setting
 *  _currentState[keyCode] directly doesn't work if the game checks
 *  _currentState['ok'] (string). Calling _onKeyDown ensures the game
 *  processes the keyCode through its own keyMapper. */
export function pollButtonBindings(currentEntry: LibraryEntry | null, globalKeymap: KeyMap): void {
        const runtime = globalThis as any;
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

/** Clear ALL currently-pressed button keyCode state and stick keyCode
 *  state, by firing synthetic `keyup` events for every button keyCode
 *  binding AND syncing the per-button press tracker to the ACTUAL physical
 *  gamepad state. Used when entering OR leaving the save/load scene so the
 *  game's per-frame keyCode injection (pollButtonBindings) can't leave
 *  stale `_currentState[key]` behind — which caused two bugs:
 *
 *  Bug A ("press A to save → game fast-forwards"):
 *    An earlier version of this function reset _buttonKeyState to `false`
 *    unconditionally on save/load EXIT. If the user was STILL holding the
 *    confirm button (e.g. A with a keyCode binding like PageDown) when the
 *    save menu closed, the next pollButtonBindings frame saw
 *    `pressed && !wasPressed` (wasPressed was just reset to false) →
 *    re-fired `Input._onKeyDown(PageDown)` → `_currentState[34]=true` →
 *    Scene_Map fast-forwarded. Syncing _buttonKeyState to the REAL gamepad
 *    state means a held button keeps `wasPressed=true`, so pollButtonBindings
 *    does NOT re-fire keydown for it.
 *
 *  Bug B (the original "B in save menu → game fast-forwards"):
 *    pollButtonBindings fired `Input._onKeyDown(B's keyCode)` every frame
 *    during Scene_Save, leaving stale `_currentState[pageDown]=true` that
 *    Scene_Map read as "held" after the save menu closed. That's now
 *    prevented by SKIPPING pollButtonBindings during save/load
 *    (isSaveLoadKeymapActive) AND by this function firing keyup on
 *    enter/exit to clear any pre-existing state.
 *
 *  Calling this on save/load ENTER and EXIT guarantees no button-keyCode
 *  state survives the scene boundary. Idempotent and safe when there's
 *  no Input/_buttonKeyState (e.g. before the game runtime exists). */
export function clearButtonKeyState(currentEntry: LibraryEntry | null, globalKeymap: KeyMap): void {
        const runtime = globalThis as any;
        const input = runtime.Input;
        if (!input) return;
        const perGameKc = currentEntry?.keymap?.keyCodes;
        const globalKc = globalKeymap.keyCodes;
        if (perGameKc || globalKc) {
                for (let i = 0; i < 16; i++) {
                        const kc = perGameKc?.[i] || globalKc?.[i];
                        if (!kc) continue;
                        // Fire keyup for every button keyCode binding (whether or
                        // not it was "pressed" — over-firing keyup is harmless,
                        // under-firing leaves stale state).
                        if (typeof input._onKeyUp === 'function') {
                                const ev = makeSyntheticKeyboardEvent(kc);
                                ev.type = 'keyup';
                                try { input._onKeyUp(ev); } catch { /* best-effort */ }
                        }
                }
        }
        // Sync the per-button press tracker to the ACTUAL physical gamepad
        // state (NOT a blanket `false`). This is the fix for Bug A above: a
        // button held across the scene boundary must keep wasPressed=true so
        // pollButtonBindings's edge detection doesn't treat it as a fresh
        // press and re-fire keydown (which would leak a stale keydown into
        // the resumed scene). When there's no gamepad (e.g. in unit tests, or
        // before the runtime is wired up), fall back to `false`.
        const pad = (navigator as any).getGamepads?.()?.[0];
        const physical = (i: number) => !!pad?.buttons?.[i]?.pressed;
        if (input._buttonKeyState) {
                for (let i = 0; i < 16; i++) input._buttonKeyState[i] = physical(i);
        } else if (pad) {
                input._buttonKeyState = {};
                for (let i = 0; i < 16; i++) input._buttonKeyState[i] = physical(i);
        }
}

// Re-export VirtualKey so callers that type against this module don't have
// to import it separately. (No behavior; type-only.)
export type { VirtualKey };
