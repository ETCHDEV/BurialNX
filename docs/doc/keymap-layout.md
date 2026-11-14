# `keymap-layout.ts`

Keymap layout data + pure helpers extracted from main.ts. Holds the static keymap data tables (keyboard layout, color palette, keyCode→vkey map) and the pure spatial-navigation helpers that only touch those tables. None of these read or write any shared runtime state.

## Module overview (file header)

> === Keymap layout data + pure helpers ================================
> Extracted from main.ts to keep the 4000-line file manageable. This module
> holds the static keymap data tables (keyboard layout, color palette,
> keyCode→vkey map) and the pure spatial-navigation helpers that only touch
> those tables. None of these read or write any shared runtime state.
>
> Consumers: renderButtonGrid, renderKeyboardPicker, handleKeymapTouch,
> and the keymap-phase frame() input handler all import these constants and
> helpers. The `_allPickKeys` cache is module-private so the lazy init still
> happens exactly once per process.

## `KEYMAP_COLORS`

> Color palette for the keymap UI. Each virtual key (and the 'none' fallback)
> maps to a fill color used by the button grid (left accent bar) and the
> keyboard picker (key cap background). Visual variety comes from these
> colors only — the renderers set ctx.font EXACTLY ONCE and never change it
> (nx.js allocates ~2MB per font assignment).

## `KEYBOARD_LAYOUT`

> Full PC keyboard layout (adapted from autorun's launcher_input.c keycap
> array). Positions are in "key units" (1 unit = 1 standard key width).
> The keyboard occupies x=0..15, y=0..5.3. The navigation + arrow cluster
> is at x=15.5..20 (3 columns of 1.5-unit keys, touching — no gaps — so the
> right block reads as one evenly-stretched unit like a real keyboard).
> Each key has a JavaScript keyCode and is looked up in KEYCODE_TO_VKEY.

### Row dividers inside `KEYBOARD_LAYOUT`

> // Row 0: function keys (y=0)
> // Row 1: number row (y=1.3)
> // Row 2: QWERTY (y=2.3)
> // Row 3: ASDF (y=3.3)
> // Row 4: ZXCV (y=4.3)
> // Row 5: bottom (y=5.3)

### Navigation cluster block

> // Navigation cluster + arrow keys — 3 columns, each key 1.5 units
> // wide and TOUCHING (no gap), so the whole right block reads as one
> // evenly-stretched unit like a real keyboard's nav/arrow cluster.
> // Col1 x=15.5, Col2 x=17, Col3 x=18.5 (each w=1.5, adjacent).

### Arrow keys block

> // Arrow keys — same 3 columns, 1.5-unit width, touching (no gaps),
> // matching the nav cluster above so the whole right block reads as
> // one evenly-stretched unit like a real keyboard's arrow cluster.

### "none" key

> // "none" key — clears the binding (keyCode 0 → 'none' fallback).
> // Positioned right of Esc with same spacing as Esc→backtick.

### Virtual-key action buttons (rows 1 & 2)

> // Virtual key buttons — processed as gamepad vkeys (NOT keyboard
> // keyCodes). When selected, keyCode=0 means "use gamepadMapper".
> // Arranged in TWO centered rows below the keyboard:
> //   row 1 (y=7.7): ok, cancel, shift, menu, pageup, pagedown, escape
> //   row 2 (y=8.7): tab, up, down, left, right, control
> // The gap between the keyboard bottom (y=6.3) and vkey row 1 (y=7.7)
> // is 1.4 units — DOUBLE the original 0.7-unit gap, so the joystick
> // action section sits clearly apart from the PC keyboard.
> // Width = 2.4 (×55px scale = 132px, with -2px padding = 130px
> // text area) — wide enough for the longest label "pagedown"
> // (~110px in the Switch system sans-serif at 20px) to fit
> // comfortably with ~20px of margin.
> // Row 1 total = 7 × 2.4 = 16.8 units; centered at x=-0.9
> // (slightly past the keyboard left/right edges, but the nav
> // cluster sits at y=0..2.3, so y=7.7 is clear).
> // Row 2 total = 6 × 2.4 = 14.4 units; centered at x=0.3.

## `KEYCODE_TO_VKEY`

> RPG Maker MV default keyMapper: keyCode → virtual key.
> Number keys (48-57) are not in the default MV keyMapper, but we map them
> to 'ok' so that binding a joycon button to "1", "2", "5", etc. produces
> a meaningful action (menu/selection confirmation) instead of 'none'.

## `_allPickKeys` cache + `getAllPickKeys`

> Mouse buttons removed — RPG Maker MV games use TouchInput for touch,
> not mouse events. Touch support is handled by forwarding screen touch
> events to document in installGameCompatibility.
> Combined pickable list: keyboard keys + virtual-key action buttons.
> Created lazily when the keyboard picker opens, not at module scope.
> Each entry carries the label, the vkey it resolves to, and the keyCode
> to forward to Input._onKeyDown (0 for vkey-only buttons that use
> gamepadMapper).

### `getAllPickKeys` — virtual-key branch inline

> // Virtual-key action button — vkey is the label itself
> // ('ok', 'cancel', etc.); no keyCode to forward.

## `findNearestKey`

> Spatial navigation: find the nearest key in the given direction.
> For Left/Right: constrain to the SAME ROW (Y distance < 0.6 units)
> so the cursor doesn't jump to a different row when moving horizontally.
> For Up/Down: use full spatial navigation (nearest key above/below).

### `findNearestKey` — row/column inlines

> // For horizontal movement: require same row (small Y difference)
> // For vertical movement: require same column-ish (small X difference)

## `prevKey` / `nextKey`

> Cycle a virtual key to the previous/next in the VIRTUAL_KEYS list. Kept
> for completeness; the main picker UI uses the visual keyboard grid instead.
