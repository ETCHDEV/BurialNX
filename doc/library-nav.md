# `library-nav.ts`

Pure helpers for the library grid: counting tiles (games plus action tiles) and moving the cursor by a full row with column preservation, top↔bottom wraparound, and clamping on a partial last row.

## File header
> === Library grid navigation helpers =================================
> Extracted from main.ts. Pure helpers for the library grid — one reads
> the library size, the other moves the cursor by a full row (preserving
> the column and wrapping top↔bottom). No shared state is touched.

## `libraryTileCount`
> Number of tiles shown in the library grid: games + the trailing
>  action tiles (Add Game, Keymap Settings, Quit BurialNX).

## `libraryNavigateRow`
> Navigate the library grid vertically by a full row, preserving the
>  column. Wraps around (top row ↑ → same column on the bottom row, and
>  vice versa) so the cursor cycles through one column on every press,
>  mirroring how horizontal Left/Right cycle through one row.
>
>  When the target cell doesn't exist (the last row is partial — e.g.
>  only 2 action tiles fill a 4-wide row), the cursor clamps to the
>  last valid tile so the column-jump is minimal instead of skipping
>  past the end of the list.
>
>  Returns the cursor unchanged when there is only a single row
>  (total <= cols): vertical movement has no meaning on a 1-row grid,
>  and the caller asked for up/down only "when rows become 2 or more".
>
>  `direction` is -1 for Up, +1 for Down.

## `libraryNavigateRow` — single-row early return
> single row — no vertical movement

## `libraryNavigateRow` — wrap branches
> wrap top → bottom
> wrap bottom → top

## `libraryNavigateRow` — partial last row clamp
> Partial last row: the target column may not exist there.
> Clamp to the last valid tile so the cursor lands on the nearest
> available cell instead of skipping past the end of the list.
