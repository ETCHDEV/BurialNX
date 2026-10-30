import { S } from './state';
import { loadCoverImage } from './cover-cache';
import { actionIcons } from './action-icons';
import { menuButtonIndicesFor, faceButtonLetter } from './keymap';
import { mergedKeymap } from './keymap-editor';

export const LIBRARY_COLS = 4;
export const LIBRARY_ROWS = 2;
export const LIBRARY_PAGE_SIZE = LIBRARY_COLS * LIBRARY_ROWS;
export const LIBRARY_ACTION_TILES = 3;

/** Draws the 4×2 library tile grid (covers, action tiles, marquee labels). */
export function renderLibrary() {
        S.ctx.save();
        S.ctx.setTransform(1, 0, 0, 1, 0, 0);
        S.ctx.fillStyle = '#161823';
        S.ctx.fillRect(0, 0, (screen as any).width, (screen as any).height);
        S.ctx.font = '20px sans-serif';
        S.ctx.textBaseline = 'alphabetic';
        S.ctx.fillStyle = '#f4f3ef'; S.ctx.textAlign = 'left';
        S.ctx.fillText('BurialNX Library', 28, 40);
        S.ctx.fillStyle = '#9aa0b4';
        const totalPages = Math.max(1, Math.ceil((S.library.games.length + LIBRARY_ACTION_TILES) / LIBRARY_PAGE_SIZE));
        S.ctx.fillText(`Page ${S.libraryPage + 1}/${totalPages}  ·  ${S.library.games.length} game(s)  ·  L/R: reorder`, 28, 68);
        const tileW = 240, tileH = 270, gap = 16;
        const gridW = LIBRARY_COLS * tileW + (LIBRARY_COLS - 1) * gap;
        const startX = Math.floor(((screen as any).width - gridW) / 2);
        const totalRows = Math.ceil((S.library.games.length + LIBRARY_ACTION_TILES) / LIBRARY_COLS);
        const startY = totalRows <= 1 ? Math.floor(((screen as any).height - tileH) / 2) : 100;
        const totalTiles = S.library.games.length + LIBRARY_ACTION_TILES;
        const pageStart = S.libraryPage * LIBRARY_PAGE_SIZE;
        const visible = Math.min(LIBRARY_PAGE_SIZE, totalTiles - pageStart);
        for (let i = 0; i < visible; i++) {
                const tileIndex = pageStart + i;
                const col = i % LIBRARY_COLS;
                const row = Math.floor(i / LIBRARY_COLS);
                const x = startX + col * (tileW + gap);
                const y = startY + row * (tileH + gap);
                const isAction = tileIndex >= S.library.games.length;
                const actionIdx = tileIndex - S.library.games.length;
                const selected = tileIndex === S.libraryCursor;
                S.ctx.fillStyle = selected ? '#3a3f5c' : '#252840';
                S.ctx.fillRect(x, y, tileW, tileH);
                if (isAction) {
                        const labels = ['+ Add Game', 'Keymap Settings', 'Quit BurialNX'];
                        const icon = actionIcons[actionIdx];
                        const coverW = tileW;
                        const coverH = 230;
                        let iconSize = Math.floor(coverW * 2 / 3);
                        if (actionIdx === 2) iconSize = Math.floor(iconSize / 2);
                        const iconX = x + Math.floor((coverW - iconSize) / 2);
                        const iconY = y + Math.floor((coverH - iconSize) / 2);
                        if (icon && icon.loaded && icon.image) {
                                try {
                                        S.ctx.drawImage(icon.image, iconX, iconY, iconSize, iconSize);
                                } catch { drawPlaceholderCover(x, y, coverW, coverH); }
                        } else {
                                drawPlaceholderCover(x, y, coverW, coverH);
                        }
                        S.ctx.fillStyle = '#f4f3ef';
                        S.ctx.textAlign = 'center';
                        S.ctx.textBaseline = 'middle';
                        S.ctx.fillText(labels[actionIdx] || '', x + tileW / 2, y + 252);
                        S.ctx.textAlign = 'left';
                        S.ctx.textBaseline = 'alphabetic';
                } else {
                        const entry = S.library.games[tileIndex];
                        if (entry) {
                                const cover = loadCoverImage(entry.cover);
                                if (cover.loaded && cover.image) {
                                        try {
                                                const iw = cover.image.naturalWidth || cover.image.width || tileW;
                                                const ih = cover.image.naturalHeight || cover.image.height || 230;
                                                const scale = Math.min(tileW / iw, 230 / ih);
                                                const dw = iw * scale, dh = ih * scale;
                                                S.ctx.drawImage(cover.image, x + (tileW - dw) / 2, y + (230 - dh) / 2, dw, dh);
                                        } catch { drawPlaceholderCover(x, y, tileW, 230); }
                                } else if (cover.failed) drawPlaceholderCover(x, y, tileW, 230);
                                else { drawPlaceholderCover(x, y, tileW, 230); }
                                const modOn = entry.mod !== undefined && entry.mod !== null && entry.modEnabled !== false;
                                if (modOn) {
                                        S.ctx.fillStyle = '#58a6ff';
                                        S.ctx.fillRect(x + 4, y + 4, 28, 28);
                                        S.ctx.fillStyle = '#161823'; S.ctx.textAlign = 'center';
                                        S.ctx.fillText('M', x + 18, y + 25);
                                        S.ctx.textAlign = 'left';
                                }
                                S.ctx.fillStyle = '#f4f3ef';
                                S.ctx.textAlign = 'center';
                                S.ctx.save();
                                S.ctx.beginPath();
                                S.ctx.rect(x, y + 234, tileW, 36);
                                S.ctx.clip();
                                const maxNameW = tileW - 8;
                                const nameW = S.ctx.measureText(entry.name).width;
                                if (nameW <= maxNameW) {
                                        S.ctx.fillText(entry.name, x + tileW / 2, y + 252);
                                } else {
                                        const scrollText = entry.name + '   ';
                                        const scrollW = S.ctx.measureText(scrollText).width;
                                        const offset = -(S.marqueeOffset % scrollW);
                                        S.ctx.textAlign = 'left';
                                        S.ctx.fillText(scrollText, x + 4 + offset, y + 252);
                                        if (offset + scrollW < maxNameW) {
                                                S.ctx.fillText(scrollText, x + 4 + offset + scrollW, y + 252);
                                        }
                                }
                                S.ctx.restore();
                                S.ctx.textAlign = 'left';
                        }
                }
                S.ctx.strokeStyle = selected ? '#f4f3ef' : '#3a3f5c';
                S.ctx.lineWidth = selected ? 3 : 1;
                S.ctx.strokeRect(x + 1, y + 1, tileW - 2, tileH - 2);
        }
        let lc = 'A', lx = 'B';
        try { const m = menuButtonIndicesFor(mergedKeymap()); lc = faceButtonLetter(m.confirm); lx = faceButtonLetter(m.cancel); } catch { /* default A/B */ }
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.fillText(`D-pad: navigate (Up/Down: row)  ${lc}: Play  X: Options  Y: Add game  Hold Minus in Game: Menu  Plus: Quit`, 28, (screen as any).height - 24);
        S.ctx.restore();
}

/** Draws a placeholder '?' cover rectangle when an image is unavailable. */
export function drawPlaceholderCover(x: number, y: number, w: number, h: number) {
        S.ctx.save();
        S.ctx.fillStyle = '#1a1c2e';
        S.ctx.fillRect(x, y, w, h);
        S.ctx.fillStyle = '#3a3f5c';
        S.ctx.textAlign = 'center';
        S.ctx.textBaseline = 'middle';
        S.ctx.fillText('?', x + w / 2, y + h / 2);
        S.ctx.textAlign = 'left';
        S.ctx.textBaseline = 'alphabetic';
        S.ctx.restore();
}
