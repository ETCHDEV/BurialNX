# `keymap.ts`

Joycon → virtual mouse/keyboard remapping. Defines a portable, JSON-serializable keymap so RPG Maker MV's `Input.gamepadMapper` can be edited at runtime, plus a set of presets for common control schemes. The Switch runtime cannot synthesize real HID mouse/keyboard events from a homebrew loader, so this module remaps each joycon button's *meaning* as the game sees it via RPG Maker MV's small set of named virtual keys.

## Module overview

> Joycon → virtual mouse/keyboard remapping.
>
> The Switch runtime cannot synthesize a real mouse or keyboard event from
> inside a homebrew loader: those HID devices belong to the OS and are not
> writable by user-mode applications. What we *can* do is remap the meaning
> of each joycon button *as the game sees it*: RPG Maker MV reads input
> through a small number of named virtual keys (`ok`, `cancel`, `shift`,
> `menu`, `up/down/left/right`, `pageup/pagedown`). By editing
> `Input.gamepadMapper` we can make button 1 act like "left mouse button"
> (i.e. the game's `ok`), button 0 act like "right mouse button"
> (i.e. the game's `cancel`), and the D-pad move the in-game cursor — which
> is exactly what a mouse would do in an RPG Maker MV game.
>
> This module defines a portable, JSON-serializable mapping so the user can
> edit it from the in-app settings UI without writing code, and a small set
> of presets for common control schemes ("Default", "Mouse", "Keyboard",
> "WASD + Mouse").

## `BUTTON_NAMES`

> Logical names for the 16 standard Web Gamepad button indices.
>  The index follows the Web Gamepad API standard mapping:
>    0 = South (Nintendo B), 1 = East (Nintendo A),
>    2 = North (Nintendo X), 3 = West (Nintendo Y).

## `BUTTON_DISPLAY_ORDER`

> Display order for the 16 buttons in the keymap editor grid.
>  Position 0 = button index 1 (East / Nintendo A) — shown FIRST.
>  Position 1 = button index 0 (South / Nintendo B) — shown SECOND.
>  Positions 2..15 = unchanged. This way the user sees "A" first, "B"
>  second in the grid, matching the physical Switch layout (A = right).

## `displayToButtonIndex`

> Convert a grid display position (0..15) to the real button index.
>  For stick directions (16..23) returns the position as-is.

## `StickBinding.keyCode`

> JavaScript keyCode (e.g. 87 for 'W', 83 for 'S').

## `StickBinding.label`

> Display label (e.g. 'W', 'S', 'A', 'D').

## `KeyMap.buttons`

> Maps a gamepad button index (0-15) to a virtual RPG Maker MV key.

## `KeyMap.labels`

> Optional display labels (keyboard key names like '5', 'U', 'Enter').
>  When present, the UI shows the label instead of the virtual key name
>  so the user can see which keyboard key is bound to each button.

## `KeyMap.keyCodes`

> Optional keyCodes — when present, the bound keyCode is sent
>  directly to Input._currentState (simulating a keyboard key press)
>  instead of using the vkey via gamepadMapper. This lets the game's
>  own keyMapper decide what the key does.

## `KeyMap.sticks`

> Analog stick → keyboard key bindings. When the stick is pushed
>  past 0.5 in a direction, the bound keyCode is "pressed" via
>  Input._currentState. This lets the user bind sticks to movement
>  keys (e.g. L-stick up = W, L-stick down = S, etc.).

## `FACE_BUTTON_LETTERS`

> Nintendo face-button LETTERS for the 16 gamepad button indices, where
>  the index follows the Web Gamepad API standard mapping (which BurialNX
>  uses via `navigator.getGamepads()[0].buttons`):
>    0 = South = Nintendo B (bottom)
>    1 = East  = Nintendo A (right)
>    2 = North = Nintendo X (top)
>    3 = West  = Nintendo Y (left)
>  4..11 are shoulder/trigger/stick-clicks (L/R/ZL/ZR/Minus/Plus/LSt/RSt),
>  12..15 are the D-pad. Only the face buttons (0..3) have meaningful
>  single-letter labels; the rest render their index so they're never
>  blank. This is what the loader's own menu panels use to print the
>  correct "A:" / "B:" hint for whichever button the active keymap maps
>  to ok/cancel (see menuButtonIndices).

## `faceButtonLetter`

> The printable letter for a gamepad button index (0..15). Face buttons
>  return their Nintendo label ('B'/'A'/'X'/'Y'); others return a short
>  symbol. Never returns an empty string.

## `KEYCODE_ENTER` / `KEYCODE_SPACE` / `KEYCODE_ESCAPE`

> keyCode constants used to detect "ok" / "cancel" roles from a button's
>  optional keyCode binding (the `keyCodes` array on a KeyMap). RPG Maker
>  MV's default Input.keyMapper maps these keyCodes to the named vkeys:
>    enter (13) → 'ok', space (32) → 'ok', esc (27) → 'escape' (≈ cancel).
>  So a button bound to keyCode 13 "is ok" for menu purposes even if its
>  vkey entry is 'none' — the game's keyMapper translates the fired keydown
>  to 'ok' at runtime.

## `isOkRoleAt`

> True if button `i` acts as the "ok" (confirm) role in the game — either
>  via its vkey being 'ok', OR via its keyCode binding being enter/space
>  (which RPG Maker MV's keyMapper translates to 'ok').

## `isCancelRoleAt`

> True if button `i` acts as the "cancel" role in the game — either via
>  its vkey being 'cancel' or 'escape' (RPG Maker MV treats 'escape' as a
>  cancel/back key alongside 'cancel'), OR via its keyCode binding being
>  esc (27, which the keyMapper maps to 'escape').

## `menuButtonIndicesFor`

> Determine which face-button indices act as CONFIRM (ok) and CANCEL in
>  the loader's OWN menus (pause menu, save-choice, save/load scene,
>  quit/return notice, keymap editor, picker, rename, game-options,
>  library — EVERY loader screen).
>
>  Rule (per the user's spec, with the priority made explicit):
>
>    1. A is checked FIRST. If A (Nintendo A, button 1) is set to
>       ok(enter/space) or cancel(esc) — by vkey OR by keyCode — A
>       determines BOTH menu roles: A = its role, B = the opposite.
>       This holds REGARDLESS of what B is set to ("вне зависимости от
>       того что на B установлено").
>
>    2. Only if A is NOT set (not ok/enter/space AND not cancel/esc) do we
>       check B (Nintendo B, button 0). If B is set to ok or cancel, B
>       determines both roles: B = its role, A = the opposite.
>
>    3. If NEITHER A nor B is set → default: A = ok (confirm), B = cancel.
>
>  "Set to ok"   = vkey 'ok'                 OR keyCode enter(13)/space(32).
>  "Set to cancel" = vkey 'cancel'/'escape'  OR keyCode esc(27).
>
>  Only buttons 0 and 1 (Nintendo A/B) are considered — X/Y/shoulders/
>  D-pad never become the menu confirm/cancel.
>
>  Button indices follow the Web Gamepad API standard mapping BurialNX
>  uses: 0 = Nintendo B (South), 1 = Nintendo A (East). Returns
>  { confirm, cancel } where both are 0 or 1.

### `menuButtonIndicesFor` — inline rationale

> const A = 1; // Nintendo A (East) = button index 1
> const B = 0; // Nintendo B (South) = button index 0
> // Priority: A first. If A is set (ok or cancel), A wins and B takes
> // the opposite role — regardless of B's own binding.
> // A is NOT set → check B. If B is set, B wins and A takes the
> // opposite role.
> // Neither A nor B is set → default: A = ok (confirm), B = cancel.

## `applyKeyMap`

> Apply the user's remap to RPG Maker MV's Input.gamepadMapper, replacing the
>  hard-coded default. Only buttons remapped to `none` are removed; others are
>  set so the engine sees the chosen virtual key.
>
>  Buttons with a non-zero keyCode binding are SKIPPED here — those are sent
>  via Input._onKeyDown by pollButtonBindings() in main.ts. Setting
>  gamepadMapper for them too would cause DOUBLE input (gamepad vkey +
>  keyboard keyCode). keyCode=0 means "no keyboard binding, use
>  gamepadMapper" — don't skip those.

### `applyKeyMap` — per-button inline rationale

> // Skip buttons with a keyCode binding — those are sent via
> // Input._onKeyDown by pollButtonBindings(). Setting
> // gamepadMapper would cause DOUBLE input (gamepad vkey +
> // keyboard keyCode). keyCode=0 means "no keyboard binding,
> // use gamepadMapper" — don't skip those.
>
> // The original loader also maps buttons 9 and 12-15 to in-game menu and
> // directions. If the user has remapped them, honor the user. Otherwise,
> // keep them so a fresh KeyMap behaves like the original loader.

## `setButton`

> Edit a single button binding in place and return a new immutable map.

## `setButtonWithLabel`

> Set a button binding with a display label AND a keyCode. The keyCode
>  is sent to Input._currentState at runtime so the game's keyMapper
>  (not gamepadMapper) decides what the key does.
