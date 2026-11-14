# `keymap-geometry.ts`

Shared layout + touch helpers for the keymap pages. Single source of truth for the keymap-page geometry — both the renderers (which draw cells/keys) and the touch handler (which hit-tests taps) read from these constants so a tap on a cell always lands inside the rectangle the user can see.

## Module overview (file header)

> === Shared layout + touch helpers for keymap pages =================
> Extracted from main.ts. Single source of truth for the keymap-page
> geometry. Both the renderers (which DRAW the cells/keys) and the touch
> handler (which HIT-TESTS taps on them) read from these constants so a
> tap on a cell always lands inside the rectangle the user can see.
>
> `screen` is read as a global (nx.js and the test VM both expose it).
> `drawBackButton` takes the 2D context as a parameter because `ctx` is a
> module-level binding in main.ts, not a global.

## `KEYMAP_KB_UNITS_W` (inline)

> keyboard x=0..15 + nav cluster x=15.5..20

## `KEYMAP_KB_UNITS_H` (inline)

> keyboard y=0..5.3 + doubled gap + vkey rows y=7.7..9.7
