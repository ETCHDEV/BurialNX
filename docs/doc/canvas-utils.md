# `canvas-utils.ts`

Small pure helpers shared by the loader's render functions, extracted from main.ts. Includes `roundedRectPath` (because nx.js canvas does not expose `ctx.roundRect`), `truncateForDisplay`, and `panel`.

## File header
> === Canvas + text utilities ==========================================
> Small pure helpers shared by the loader's render functions. Extracted
> from main.ts to reduce the 4000-line file's surface area.
>
> `roundedRectPath` traces a rounded-rectangle path on the supplied 2D
> context (nx.js's canvas does not expose ctx.roundRect, so we approximate
> it with quadratic curves, matching the WHATWG roundRect proposal).
> `truncateForDisplay` truncates a string to a max length with an ellipsis.

## `roundedRectPath`
> Trace a rounded-rectangle path on the supplied 2D context. nx.js's canvas
>  does not expose ctx.roundRect, so we approximate it with quadratic curves
>  (matches the Geometry in the WHATWG roundRect proposal).

## `truncateForDisplay`
> Truncate a string to at most `max` characters, appending '…' if it
>  was shortened. Used by renderGameOptions for long paths.

## `panel`
> Draw a simple top-left text panel. Used by the frame loop's picker,
>  save-choice, import-confirm, and error phases. `screen` is read as a
>  global (nx.js and the test VM both expose it).
