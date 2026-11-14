# `keymap-editor.ts`

Keymap editor logic extracted from main.ts: the editor's mutators plus the touch handler for the keymap page. Reads/writes the shared `S` state and merges per-game overrides over the global default keymap.

## Module overview (file header)

> === Keymap editor logic ============================================
> Extracted from main.ts. The keymap editor's mutators + the touch
> handler for the keymap page. Reads/writes the shared `S` state.
>
> mergedKeymap() — pure read of S.currentEntry?.keymap + S.globalKeymap
>                  that returns the per-game-override-merged KeyMap used
>                  by installGameCompatibility and saveEditingKeymap.
> applyPreset(i) — applies one of the 4 L/ZL/R/ZR presets to the working
>                  keymap, preserving stick bindings, then saves.
> saveEditingKeymap() — persists the working keymap to the appropriate
>                  target (global keymap.json or per-game library entry)
>                  and re-applies it to the running game's gamepadMapper
>                  if a game is currently running.
> openKeymapEditor(target) — opens the editor for 'global' or a specific
>                  library entry, copying every field (buttons, labels,
>                  keyCodes, sticks) into the working copy.
> handleKeymapTouch(px, py) — routes a single touch tap on the keymap
>                  page to the same action as the gamepad A button.

## `mergedKeymap`

> Build a MERGED KeyMap: the per-game keymap (if any) takes precedence
>  per-button/per-direction, and the global default fills every gap.
>  This is the single source of truth for "what keymap is active right
>  now" — used by installGameCompatibility (to set gamepadMapper at
>  launch) and by saveEditingKeymap (to re-apply after an edit).
>
>  Without this merge, a per-game keymap that only overrides SOME
>  buttons/directions would silently drop the global bindings for the
>  rest — the root cause of the "right stick doesn't fire" bug: the
>  per-game keymap had left-stick bindings but not right-stick ones,
>  and the global right-stick bindings were ignored.

### `mergedKeymap` — inline rationale

> // Buttons: per-game overrides per index, global fills the rest.
> // Labels: merge — per-game label wins, fall back to global.
> // KeyCodes: merge — per-game keyCode wins, fall back to global.
> // Sticks: merge per direction.

## `applyPreset`

### `applyPreset` — inline rationale

> // A preset only redefines the 16 face-button → vkey mappings. It does
> // NOT touch analog-stick bindings (presets don't model sticks), so the
> // user's L/R-stick → keyboard-key bindings survive a preset switch.
> // Without preserving sticks here, applying any preset would silently
> // wipe the user's stick bindings (same root cause as the editor
> // display bug — sticks were dropped on every KeyMap copy).

## `saveEditingKeymap`

> Persist the working keymap to the appropriate target. When editing the
>  global default, this writes keymap.json; when editing a per-game keymap,
>  this updates the library entry and writes library.json. If a game is
>  currently running, the change is applied immediately to runtime.Input
>  so the user can test the new binding without restarting.

### `saveEditingKeymap` — inline rationale (CRITICAL note)

> // CRITICAL: copy labels AND sticks, not just buttons.
> // Without labels, the editor shows 'ok' instead of the
> // bound key (e.g. '1', 'W'). Without sticks, analog
> // stick bindings are lost.

### `saveEditingKeymap` — re-apply inline rationale

> // Re-apply the MERGED keymap (per-game + global) to the
> // running game's gamepadMapper, so a change to either the
> // per-game or global keymap takes effect immediately.

## `openKeymapEditor`

> Open the keymap editor. If a game is running (host is set), default to
>  editing the active game's per-game keymap when one exists, otherwise the
>  global default (which the running game is using). Called from the library
>  tile, the pause-menu "keymap" entry, or the game-options "Edit keymap".

### `openKeymapEditor` — copy-fields rationale

> // Copy buttons, labels, keyCodes AND sticks from the source keymap.
> // Missing any one of these caused display bugs:
> //  - no labels  → editor shows the vkey ('ok') instead of the bound
> //    key label ('1', 'W', 'Enter') — the "bindings reset to ok" bug.
> //  - no sticks   → analog-stick bindings (e.g. L-stick ↑ = arrow key)
> //    work at runtime (pollStickBindings reads currentEntry.keymap /
> //    globalKeymap directly) but the editor grid shows 'none' for every
> //    stick direction, so the user thinks nothing is assigned. This
> //    was the root cause of the "stick bindings don't show in settings"
> //    bug.

### `openKeymapEditor` — shallow-clone rationale

> // Shallow-clone each stick binding so editing the working copy
> // never mutates the saved source map.

## `handleKeymapTouch`

> Route a single touch tap on the keymap page to the same action as
>  the gamepad A button: tap a cell/key = move cursor + confirm in one
>  motion. Tap the "← Back" button (top-right) = same as the B button.
>  Tapping anywhere else does nothing — the user must hit a real UI
>  element, which makes the touch zones unambiguous.
