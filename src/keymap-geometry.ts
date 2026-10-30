/** Shared layout + touch helpers for keymap pages. */
import { KEYBOARD_LAYOUT } from './keymap-layout';

export const KEYMAP_GRID_COLS = 4;
export const KEYMAP_GRID_ROWS = 6;
export const KEYMAP_CELL_W = 280, KEYMAP_CELL_H = 85, KEYMAP_CELL_GAP = 8;
export const KEYMAP_GRID_START_Y = 108;
export const KEYMAP_KB_SCALE = 55;
export const KEYMAP_KB_UNITS_W = 20;
export const KEYMAP_KB_UNITS_H = 9.7;

export interface Rect { x: number; y: number; w: number; h: number; }

export function keymapButtonCellRect(i: number): Rect {
        const c = i % KEYMAP_GRID_COLS, r = Math.floor(i / KEYMAP_GRID_COLS);
        const gridW = KEYMAP_GRID_COLS * KEYMAP_CELL_W + (KEYMAP_GRID_COLS - 1) * KEYMAP_CELL_GAP;
        const startX = Math.floor(((screen as any).width - gridW) / 2);
        return {
                x: startX + c * (KEYMAP_CELL_W + KEYMAP_CELL_GAP),
                y: KEYMAP_GRID_START_Y + r * (KEYMAP_CELL_H + KEYMAP_CELL_GAP),
                w: KEYMAP_CELL_W, h: KEYMAP_CELL_H,
        };
}

export function keymapKbOrigin(): { x: number; y: number } {
        const kbMaxW = KEYMAP_KB_UNITS_W * KEYMAP_KB_SCALE;
        const kbMaxH = KEYMAP_KB_UNITS_H * KEYMAP_KB_SCALE;
        return {
                x: Math.floor(((screen as any).width - kbMaxW) / 2),
                y: Math.floor(((screen as any).height - kbMaxH) / 2),
        };
}

export function keymapKeyRect(i: number): Rect | null {
        const k = KEYBOARD_LAYOUT[i];
        if (!k) return null;
        const o = keymapKbOrigin();
        return {
                x: o.x + k.x * KEYMAP_KB_SCALE,
                y: o.y + k.y * KEYMAP_KB_SCALE,
                w: k.w * KEYMAP_KB_SCALE,
                h: k.h * KEYMAP_KB_SCALE,
        };
}

export function keymapBackButtonRect(): Rect {
        return { x: (screen as any).width - 140, y: 24, w: 112, h: 44 };
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
        return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

export function drawBackButton(ctx: CanvasRenderingContext2D): void {
        const r = keymapBackButtonRect();
        ctx.fillStyle = '#252840';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = '#565f8d';
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        ctx.fillStyle = '#f4f3ef';
        ctx.textAlign = 'center';
        ctx.fillText('← Back', r.x + r.w / 2, r.y + r.h / 2 + 7);
        ctx.textAlign = 'left';
}
