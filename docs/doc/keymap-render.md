# `keymap-render.ts`

Keymap page renderers extracted from main.ts. Two-phase key remap UI inspired by autorun's launcher_input.c. Renders the button grid (phase 1) and the visual PC keyboard + virtual-key buttons (phase 2), plus a live preview screen while the Switch software keyboard is open.

## Module overview (file header)

> === Keymap page renderers ===========================================
> Extracted from main.ts. Two-phase key remap UI inspired by autorun's
> launcher_input.c:
>   Phase 1 (button grid): 4×4 grid of joycon buttons with their current
>     bindings. User navigates with D-pad, presses A to edit a button.
>   Phase 2 (keyboard+mouse): visual PC keyboard + mouse. User navigates
>     with D-pad, presses A to bind the selected key to the joycon button
>     from phase 1. Press B to go back to phase 1.
>
> IMPORTANT: nx.js allocates ~2MB per ctx.font assignment. Both renderers
> set ctx.font EXACTLY ONCE and never change it. Visual variety comes from
> fillStyle (colors) only.
>
> Reads from S: ctx, keymapTarget, keymapPicking, keymapCursor,
>                keymapPickCursor, editingKeymap, keymapValid, phase,
>                addGamePath, addGameDefaultName, addGamePreview,
>                renamePreview, currentEntry.
> Does NOT mutate S.

## `menuLetters`

> The CONFIRM/CANCEL button letters for the active keymap, so the keymap
>  editor's hints ("A: bind", "B: back") mirror the game's ok/cancel
>  mapping — same as every other loader screen.

## `renderKeymap` — font-once inline

> // Set the font EXACTLY ONCE for the entire function.

## `renderButtonGrid` — header / back / grid / footer inlines

> // Header
> // Back button (also a touch target).
> // Grid: 4 columns × 6 rows = 24 entries (16 buttons + 8 stick dirs).
> // Smaller cells to fit 6 rows on screen.
> // Get the display label and color.
> // Footer

## `renderKeyboardPicker`

### Keyboard geometry inline

> // Keyboard area: centered horizontally AND vertically, scale=55px per key unit.
> // The layout now spans y=0..9.7 (keyboard rows 0..5.3 + a 1.4-unit
> // doubled gap + 2 rows of virtual-key buttons at y=7.7 and y=8.7,
> // each h=1). kbMaxH accounts for the extra rows so the whole grid
> // stays vertically centered instead of being pushed against the top.

### Section label inline

> // Section label for the joystick-action row, drawn in the gap
> // between the keyboard bottom (y=6.3) and vkey row 1 (y=7.7).
> // Left-aligned at x=28 like the top headers (Current:…, D-pad:…)
> // and placed 0.35 units above vkey row 1 so it visually attaches
> // to the section it labels.

### Virtual-key color inline

> // Virtual-key buttons (keyCode=-1) are colored by their
> // OWN label — e.g. the "ok" button gets the green 'ok'
> // color. Regular keyboard keys are colored by their
> // keyCode → vkey mapping (e.g. keyCode 13 → 'ok' → green).

## `renderRenameKb`

> Live preview screen while the Switch software keyboard is open. The
>  inline swkbd does not render the typed text itself, so this field is the
>  only place the player sees the current name. The text is re-read from the
>  keyboard EVERY FRAME (vk.value / vk.cursorIndex — nx.js keeps them current
>  via the native swkbd callbacks), so the preview updates even if a
>  "change" event is missed; the listeners only keep `renamePreview` warm
>  for runtimes where the keyboard object is opaque.
>  The field is anchored directly above the REAL keyboard rectangle
>  (vk.boundingRect, filled by show() from the applet's touch rectangles),
>  so it visually reads as "the field this keyboard types into". Without
>  geometry the field falls back to a fixed top band that no swkbd layout
>  ever covers.

### `renderRenameKb` — geometry / field / caret inlines

> // Geometry: the applet reports its touch rectangles in show(), so the
> // height is real hardware data. The keyboard hugs the bottom edge;
> // anchor the input field just above it (counter + hint below the
> // field, hint above the keys). Fallback: fixed band at y=150.
> // Field label.
> // The input field itself — big and high contrast.
> // Scroll the text so the caret stays visible in long names.
> // Counter and controls, between the field and the keyboard.
