import type { LibraryFile } from './game-library';

/** Number of tiles shown in the library grid (games + action tiles). */
export function libraryTileCount(library: LibraryFile, actionTiles: number): number {
        return library.games.length + actionTiles;
}

/** Move the library cursor by one row, preserving column; wraps top↔bottom. */
export function libraryNavigateRow(cursor: number, total: number, cols: number, direction: -1 | 1): number {
        if (total <= cols) return cursor;
        const rowCount = Math.ceil(total / cols);
        const row = Math.floor(cursor / cols);
        const col = cursor % cols;
        let newRow = row + direction;
        if (newRow < 0) newRow = rowCount - 1;
        else if (newRow >= rowCount) newRow = 0;
        let target = newRow * cols + col;
        if (target >= total) target = total - 1;
        return target;
}
