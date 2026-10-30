# `stick-bindings.ts`

Analog stick + face-button bindings extracted from main.ts. Polls the gamepad analog sticks and face buttons each frame and simulates keyboard key presses (or sets vkey state directly) for the bound keys via `Input._currentState`, letting the user bind L/R-stick directions to movement keys and bind face buttons to keyboard keyCodes that the game's keyMapper then translates.

## Module overview (file header)

> === Analog stick + face-button bindings =============================
> Extracted from main.ts. Polls the gamepad analog sticks and face buttons
> each frame and simulates keyboard key presses (or sets vkey state
> directly) for the bound keys via Input._currentState. This lets the user
> bind L-stick/R-stick directions to movement keys and bind face buttons
> to keyboard keyCodes that the game's keyMapper then translates.
>
> The module owns the `prevStickDirActive` edge-detection state so it
> stays consistent across frames. `currentEntry` and `globalKeymap` are
> passed in at call time (they live in main.ts as the user edits them).
> `runtime` is the game's global scope (globalThis) — the same alias
> main.ts uses.

## `prevStickDirActive`

> Track previous stick-direction active states for EDGE-DETECTED release.
> Without this, pollStickBindings would set _currentState[key] = false
> EVERY frame the stick is idle — which would override a face button's
> held-true for the same vkey (e.g. if button A is mapped to 'ok' and
> R↓ is also bound to 'ok', releasing R↓ while holding A would
> prematurely release 'ok'). With edge detection, we only set false on
> the release TRANSITION (stick was active last frame, now inactive).

## `makeSyntheticKeyboardEvent`

> Build a synthetic KeyboardEvent-like object that RPG Maker MV's
>  Input._onKeyDown / _onKeyUp can consume without throwing. MV's handlers
>  call `event.preventDefault()` unconditionally (and some plugins also
>  call `event.stopPropagation()` / `stopImmediatePropagation()`), so the
>  event must look like a real DOM KeyboardEvent — not a plain
>  `{ keyCode }`. The no-op methods safely satisfy those calls without
>  touching the OS HID stack (which we cannot reach from a homebrew
>  loader anyway).

### `makeSyntheticKeyboardEvent` — field inlines

> // `key`/`code` are filled in for plugins that read the printable
> // name; `keyCode`/`which` are what MV's _onKeyDown actually reads.
> // The four DOM Event no-ops — never throw, never block.
> // Some MV plugins inspect `target` — give them a safe
> // window-shaped stub so `event.target.defaultPrevented`
> // doesn't crash either.

## `pollStickBindings`

> Poll the gamepad analog sticks and fire the bound keys.
>
>  MERGE SEMANTICS (the fix for "right-stick bindings don't fire"):
>  When a per-game keymap exists, its stick bindings OVERRIDE the global
>  default PER DIRECTION — not wholesale. Previously, if the per-game
>  keymap had `sticks: { lUp, lDown, lLeft, lRight }` (left stick only,
>  e.g. from an earlier edit session), `pollStickBindings` used ONLY
>  those four directions and ignored the global right-stick bindings
>  (`rUp/rDown/rLeft/rRight`). Result: left stick worked, right stick
>  was dead — even though the user HAD bound right-stick keys (to the
>  global keymap). Now each direction falls back to the global binding
>  when the per-game keymap doesn't override it, so a per-game keymap
>  that only customizes SOME directions still inherits the rest.

### `pollStickBindings` — per-direction merge inline

> // Per-direction merge: per-game wins, global fills the gaps.

### `pollStickBindings` — no-bindings bail inline

> // No stick bindings at all (neither per-game nor global) — bail.

### `pollStickBindings` — two-paths rationale

> // Two PATHS for stick bindings, mirroring how face buttons are handled:
> //
> // PATH A — KEYBOARD keyCode bindings (keyCode > 0, e.g. arrow keys):
> //   Fire Input._onKeyDown/_onKeyUp with a synthetic KeyboardEvent on
> //   edge press/release. This runs the game's keyMapper, which
> //   translates keyCode → vkey (e.g. 38 → 'up') and sets
> //   _currentState['up'] = true/false — the SAME path a real keyboard
> //   key press takes. Without this, setting _currentState[38] directly
> //   does NOT translate to a vkey, so Input.dir4 (which reads
> //   _currentState['up'] etc.) never sees the press. This is why
> //   "right-stick → arrow keys" didn't work in-game.
> //
> // PATH B — VKEY bindings (keyCode 0, e.g. 'ok', 'cancel', 'up'):
> //   Set _currentState[vkeyName] directly (e.g. _currentState['ok']=true).
> //   This is the SAME thing gamepadMapper does for face buttons —
> //   _currentState keyed by vkey name string. No keyMapper translation
> //   needed (the vkey IS the final key). With edge-detected release +
> //   OR-merge (multiple stick directions can bind to the same vkey).
> //
> // Both paths run per-frame with edge detection, so holding a stick
> // direction = one keydown (fires once), releasing = one keyup.

### `pollStickBindings` — dirActive inline

> // First: compute each direction's current active state.

### `pollStickBindings` — PATH A inlines

> // PATH A: keyCode bindings — edge-detected _onKeyDown/_onKeyUp.
> // Press edge — fire keydown. This runs the game's keyMapper
> // (keyCode → vkey) AND sets _currentState[keyCode]=true,
> // mirroring a real keyboard key press.
> // Release edge — fire keyup.

### `pollStickBindings` — PATH B rationale

> // PATH B: vkey bindings — directly set _currentState[vkeyName], with
> // OR-merge (multiple stick directions → same vkey) and edge-detected
> // release (only set false on the release transition, not every idle
> // frame — otherwise we'd fight _updateGamepadState's management of
> // the same vkey from face buttons).

### `pollStickBindings` — release-only inline

> // Only set false if some direction bound to this vkey
> // was active last frame (release transition).

### `pollStickBindings` — save-states inline

> // Save current states for next frame's edge detection.

## `pollButtonBindings`

> Poll the 16 face buttons. For each button that has a non-zero keyCode
>  binding, call Input._onKeyDown/_onKeyUp directly. This fires the game's
>  keyboard handler, which sets _currentState[keyCode] and lets the game's
>  keyMapper translate the keyCode to a virtual key. This is needed because
>  RPG Maker MV's _currentState uses keyCodes (from keyboard) AND virtual
>  key names (from gamepad) — they're separate namespaces. Setting
>  _currentState[keyCode] directly doesn't work if the game checks
>  _currentState['ok'] (string). Calling _onKeyDown ensures the game
>  processes the keyCode through its own keyMapper.

### `pollButtonBindings` — per-button MERGE inline

> // Per-button MERGE (same semantics as pollStickBindings): the per-game
> // keymap's keyCode overrides the global one PER BUTTON, so a per-game
> // keymap that only customizes SOME buttons still inherits the rest
> // from the global default. Without this, a per-game keymap with a
> // partial keyCode array would silently drop the global bindings for
> // the buttons it doesn't override.

### `pollButtonBindings` — no-binding inline

> // No keyCode binding — gamepadMapper handles it.

### `pollButtonBindings` — press/release edge inlines

> // Button just pressed — fire keydown with a full
> // KeyboardEvent-shaped object so MV's
> // `event.preventDefault()` call (and any plugin's
> // stopPropagation) doesn't throw.
> // Button just released — fire keyup the same way.

## `clearButtonKeyState`

> Clear ALL currently-pressed button keyCode state and stick keyCode
>  state, by firing synthetic `keyup` events for every button keyCode
>  binding AND syncing the per-button press tracker to the ACTUAL physical
>  gamepad state. Used when entering OR leaving the save/load scene so the
>  game's per-frame keyCode injection (pollButtonBindings) can't leave
>  stale `_currentState[key]` behind — which caused two bugs:
>
>  Bug A ("press A to save → game fast-forwards"):
>    An earlier version of this function reset _buttonKeyState to `false`
>    unconditionally on save/load EXIT. If the user was STILL holding the
>    confirm button (e.g. A with a keyCode binding like PageDown) when the
>    save menu closed, the next pollButtonBindings frame saw
>    `pressed && !wasPressed` (wasPressed was just reset to false) →
>    re-fired `Input._onKeyDown(PageDown)` → `_currentState[34]=true` →
>    Scene_Map fast-forwarded. Syncing _buttonKeyState to the REAL gamepad
>    state means a held button keeps `wasPressed=true`, so pollButtonBindings
>    does NOT re-fire keydown for it.
>
>  Bug B (the original "B in save menu → game fast-forwards"):
>    pollButtonBindings fired `Input._onKeyDown(B's keyCode)` every frame
>    during Scene_Save, leaving stale `_currentState[pageDown]=true` that
>    Scene_Map read as "held" after the save menu closed. That's now
>    prevented by SKIPPING pollButtonBindings during save/load
>    (isSaveLoadKeymapActive) AND by this function firing keyup on
>    enter/exit to clear any pre-existing state.
>
>  Calling this on save/load ENTER and EXIT guarantees no button-keyCode
>  state survives the scene boundary. Idempotent and safe when there's
>  no Input/_buttonKeyState (e.g. before the game runtime exists).

### `clearButtonKeyState` — keyup inline

> // Fire keyup for every button keyCode binding (whether or
> // not it was "pressed" — over-firing keyup is harmless,
> // under-firing leaves stale state).

### `clearButtonKeyState` — sync-tracker inline

> // Sync the per-button press tracker to the ACTUAL physical gamepad
> // state (NOT a blanket `false`). This is the fix for Bug A above: a
> // button held across the scene boundary must keep wasPressed=true so
> // pollButtonBindings's edge detection doesn't treat it as a fresh
> // press and re-fire keydown (which would leak a stale keydown into
> // the resumed scene). When there's no gamepad (e.g. in unit tests, or
> // before the runtime is wired up), fall back to `false`.

## Module trailer — re-export

> // Re-export VirtualKey so callers that type against this module don't have
> // to import it separately. (No behavior; type-only.)
