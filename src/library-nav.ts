// === Library grid navigation helpers =================================
// Extracted from main.ts. Pure helpers for the library grid — one reads
// the library size, the other moves the cursor by a full row (preserving
// the column and wrapping top↔bottom). No shared state is touched.

import type { LibraryFile } from './game-library';

/** Number of tiles shown in the library grid: games + the trailing
 *  action tiles (Add Game, Keymap Settings, Quit BurialNX). */
export function libraryTileCount(library: LibraryFile, actionTiles: number): number {
	return library.games.length + actionTiles;
}

/** Navigate the library grid vertically by a full row, preserving the
 *  column. Wraps around (top row ↑ → same column on the bottom row, and
 *  vice versa) so the cursor cycles through one column on every press,
 *  mirroring how horizontal Left/Right cycle through one row.
 *
 *  When the target cell doesn't exist (the last row is partial — e.g.
 *  only 2 action tiles fill a 4-wide row), the cursor clamps to the
 *  last valid tile so the column-jump is minimal instead of skipping
 *  past the end of the list.
 *
 *  Returns the cursor unchanged when there is only a single row
 *  (total <= cols): vertical movement has no meaning on a 1-row grid,
 *  and the caller asked for up/down only "when rows become 2 or more".
 *
 *  `direction` is -1 for Up, +1 for Down. */
export function libraryNavigateRow(cursor: number, total: number, cols: number, direction: -1 | 1): number {
	if (total <= cols) return cursor; // single row — no vertical movement
	const rowCount = Math.ceil(total / cols);
	const row = Math.floor(cursor / cols);
	const col = cursor % cols;
	let newRow = row + direction;
	if (newRow < 0) newRow = rowCount - 1;        // wrap top → bottom
	else if (newRow >= rowCount) newRow = 0;       // wrap bottom → top
	let target = newRow * cols + col;
	// Partial last row: the target column may not exist there.
	// Clamp to the last valid tile so the cursor lands on the nearest
	// available cell instead of skipping past the end of the list.
	if (target >= total) target = total - 1;
	return target;
}
