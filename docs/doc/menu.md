# `menu.ts`

Controller-only pause-menu overlay state: tracks open/close, current page (main vs. "Another"), the selected item, and the per-frame button-edge detection that drives navigation. Button numbering follows the Web Gamepad API.

## `PauseMenu` class
> Controller-only overlay state. Button numbering follows the Web Gamepad API.

## `PauseMenu.page`
> 1 = main, 2 = "Another"

## `PauseMenu.languageCycle`
> Set by step() when Left/Right is pressed on the Language item.
>  -1 = previous language, +1 = next language, 0 = no change.
>  The frame function reads this after step() and cycles the language.

## `PauseMenu` constructor — page contents
> Page 1 (main): Resume, Save, Load, Edit keymap, Another, Quit

> Page 2 (Another): all remaining options + Back

## `step` — confirm/cancel mapping
> The pause menu mirrors the game's ok/cancel button mapping:
> the button the game uses for 'ok' selects/confirms menu items,
> the button the game uses for 'cancel' closes the menu / goes
> back. confirmIndex/cancelIndex are computed by
> menuButtonIndicesFor() in src/keymap.ts and passed in from the
> frame loop (frame-loop.ts). Defaults (1, 0) reproduce the
> long-standing BurialNX convention for games that haven't
> remapped A/B.

## `step` — language cycling
> Left/Right on the Language item cycle through languages with
> auto-confirm (no confirm press needed). The frame function reads
> languageCycle and saves the new preference immediately.

## `step` — Left/Right arrows
> Left
> Right

## `step` — cancel branch
> CANCEL: close (or go back to page 1)

## `step` — language confirm
> confirm = cycle forward
