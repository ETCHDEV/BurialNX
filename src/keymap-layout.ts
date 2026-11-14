/** Keymap layout data tables + pure spatial-navigation helpers. */
import { type VirtualKey, VIRTUAL_KEYS } from './keymap';

export const KEYMAP_COLORS: Record<string, string> = {
        ok: '#3fb950', cancel: '#f85149', shift: '#a371f7', menu: '#58a6ff',
        control: '#f0883e', tab: '#f0883e', escape: '#f85149',
        pageup: '#d2a8ff', pagedown: '#d2a8ff',
        up: '#56d364', down: '#56d364', left: '#56d364', right: '#56d364',
        // Mouse movement = cyan, mouse clicks = orange/amber.
        mup: '#39d0d8', mdown: '#39d0d8', mleft: '#39d0d8', mright: '#39d0d8',
        lmb: '#f0883e', rmb: '#f5b85a',
        none: '#6e7681',
};

export interface KeyDef { label: string; keyCode: number; x: number; y: number; w: number; h: number; vkey?: import('./keymap').VirtualKey; }
export const KEYBOARD_LAYOUT: KeyDef[] = [
        { label: 'Esc', keyCode: 27, x: 0, y: 0, w: 1, h: 1 },
        { label: 'F1', keyCode: 112, x: 2, y: 0, w: 1, h: 1 }, { label: 'F2', keyCode: 113, x: 3, y: 0, w: 1, h: 1 },
        { label: 'F3', keyCode: 114, x: 4, y: 0, w: 1, h: 1 }, { label: 'F4', keyCode: 115, x: 5, y: 0, w: 1, h: 1 },
        { label: 'F5', keyCode: 116, x: 6.5, y: 0, w: 1, h: 1 }, { label: 'F6', keyCode: 117, x: 7.5, y: 0, w: 1, h: 1 },
        { label: 'F7', keyCode: 118, x: 8.5, y: 0, w: 1, h: 1 }, { label: 'F8', keyCode: 119, x: 9.5, y: 0, w: 1, h: 1 },
        { label: 'F9', keyCode: 120, x: 11, y: 0, w: 1, h: 1 }, { label: 'F10', keyCode: 121, x: 12, y: 0, w: 1, h: 1 },
        { label: 'F11', keyCode: 122, x: 13, y: 0, w: 1, h: 1 }, { label: 'F12', keyCode: 123, x: 14, y: 0, w: 1, h: 1 },
        { label: '`', keyCode: 192, x: 0, y: 1.3, w: 1, h: 1 },
        { label: '1', keyCode: 49, x: 1, y: 1.3, w: 1, h: 1 }, { label: '2', keyCode: 50, x: 2, y: 1.3, w: 1, h: 1 },
        { label: '3', keyCode: 51, x: 3, y: 1.3, w: 1, h: 1 }, { label: '4', keyCode: 52, x: 4, y: 1.3, w: 1, h: 1 },
        { label: '5', keyCode: 53, x: 5, y: 1.3, w: 1, h: 1 }, { label: '6', keyCode: 54, x: 6, y: 1.3, w: 1, h: 1 },
        { label: '7', keyCode: 55, x: 7, y: 1.3, w: 1, h: 1 }, { label: '8', keyCode: 56, x: 8, y: 1.3, w: 1, h: 1 },
        { label: '9', keyCode: 57, x: 9, y: 1.3, w: 1, h: 1 }, { label: '0', keyCode: 48, x: 10, y: 1.3, w: 1, h: 1 },
        { label: '-', keyCode: 189, x: 11, y: 1.3, w: 1, h: 1 }, { label: '=', keyCode: 187, x: 12, y: 1.3, w: 1, h: 1 },
        { label: 'Bksp', keyCode: 8, x: 13, y: 1.3, w: 2, h: 1 },
        { label: 'Tab', keyCode: 9, x: 0, y: 2.3, w: 1.5, h: 1 },
        { label: 'Q', keyCode: 81, x: 1.5, y: 2.3, w: 1, h: 1 }, { label: 'W', keyCode: 87, x: 2.5, y: 2.3, w: 1, h: 1 },
        { label: 'E', keyCode: 69, x: 3.5, y: 2.3, w: 1, h: 1 }, { label: 'R', keyCode: 82, x: 4.5, y: 2.3, w: 1, h: 1 },
        { label: 'T', keyCode: 84, x: 5.5, y: 2.3, w: 1, h: 1 }, { label: 'Y', keyCode: 89, x: 6.5, y: 2.3, w: 1, h: 1 },
        { label: 'U', keyCode: 85, x: 7.5, y: 2.3, w: 1, h: 1 }, { label: 'I', keyCode: 73, x: 8.5, y: 2.3, w: 1, h: 1 },
        { label: 'O', keyCode: 79, x: 9.5, y: 2.3, w: 1, h: 1 }, { label: 'P', keyCode: 80, x: 10.5, y: 2.3, w: 1, h: 1 },
        { label: '[', keyCode: 219, x: 11.5, y: 2.3, w: 1, h: 1 }, { label: ']', keyCode: 221, x: 12.5, y: 2.3, w: 1, h: 1 },
        { label: '\\', keyCode: 220, x: 13.5, y: 2.3, w: 1.5, h: 1 },
        { label: 'Caps', keyCode: 20, x: 0, y: 3.3, w: 1.75, h: 1 },
        { label: 'A', keyCode: 65, x: 1.75, y: 3.3, w: 1, h: 1 }, { label: 'S', keyCode: 83, x: 2.75, y: 3.3, w: 1, h: 1 },
        { label: 'D', keyCode: 68, x: 3.75, y: 3.3, w: 1, h: 1 }, { label: 'F', keyCode: 70, x: 4.75, y: 3.3, w: 1, h: 1 },
        { label: 'G', keyCode: 71, x: 5.75, y: 3.3, w: 1, h: 1 }, { label: 'H', keyCode: 72, x: 6.75, y: 3.3, w: 1, h: 1 },
        { label: 'J', keyCode: 74, x: 7.75, y: 3.3, w: 1, h: 1 }, { label: 'K', keyCode: 75, x: 8.75, y: 3.3, w: 1, h: 1 },
        { label: 'L', keyCode: 76, x: 9.75, y: 3.3, w: 1, h: 1 }, { label: ';', keyCode: 186, x: 10.75, y: 3.3, w: 1, h: 1 },
        { label: "'", keyCode: 222, x: 11.75, y: 3.3, w: 1, h: 1 }, { label: 'Enter', keyCode: 13, x: 12.75, y: 3.3, w: 2.25, h: 1 },
        { label: 'Shift', keyCode: 16, x: 0, y: 4.3, w: 2.25, h: 1 },
        { label: 'Z', keyCode: 90, x: 2.25, y: 4.3, w: 1, h: 1 }, { label: 'X', keyCode: 88, x: 3.25, y: 4.3, w: 1, h: 1 },
        { label: 'C', keyCode: 67, x: 4.25, y: 4.3, w: 1, h: 1 }, { label: 'V', keyCode: 86, x: 5.25, y: 4.3, w: 1, h: 1 },
        { label: 'B', keyCode: 66, x: 6.25, y: 4.3, w: 1, h: 1 }, { label: 'N', keyCode: 78, x: 7.25, y: 4.3, w: 1, h: 1 },
        { label: 'M', keyCode: 77, x: 8.25, y: 4.3, w: 1, h: 1 }, { label: ',', keyCode: 188, x: 9.25, y: 4.3, w: 1, h: 1 },
        { label: '.', keyCode: 190, x: 10.25, y: 4.3, w: 1, h: 1 }, { label: '/', keyCode: 191, x: 11.25, y: 4.3, w: 1, h: 1 },
        { label: 'Shift', keyCode: 16, x: 12.25, y: 4.3, w: 2.75, h: 1 },
        { label: 'Ctrl', keyCode: 17, x: 0, y: 5.3, w: 1.5, h: 1 }, { label: 'Win', keyCode: 91, x: 1.5, y: 5.3, w: 1.25, h: 1 },
        { label: 'Alt', keyCode: 18, x: 2.75, y: 5.3, w: 1.25, h: 1 }, { label: 'Space', keyCode: 32, x: 4, y: 5.3, w: 6, h: 1 },
        { label: 'Alt', keyCode: 18, x: 10, y: 5.3, w: 1.25, h: 1 }, { label: 'Win', keyCode: 92, x: 11.25, y: 5.3, w: 1.25, h: 1 },
        { label: 'Menu', keyCode: 93, x: 12.5, y: 5.3, w: 1.25, h: 1 }, { label: 'Ctrl', keyCode: 17, x: 13.75, y: 5.3, w: 1.25, h: 1 },
        { label: 'Prt', keyCode: 44, x: 15.5, y: 0, w: 1.5, h: 1 }, { label: 'Scr', keyCode: 145, x: 17, y: 0, w: 1.5, h: 1 },
        { label: 'Pause', keyCode: 19, x: 18.5, y: 0, w: 1.5, h: 1 },
        { label: 'Ins', keyCode: 45, x: 15.5, y: 1.3, w: 1.5, h: 1 }, { label: 'Home', keyCode: 36, x: 17, y: 1.3, w: 1.5, h: 1 },
        { label: 'PgUp', keyCode: 33, x: 18.5, y: 1.3, w: 1.5, h: 1 },
        { label: 'Del', keyCode: 46, x: 15.5, y: 2.3, w: 1.5, h: 1 }, { label: 'End', keyCode: 35, x: 17, y: 2.3, w: 1.5, h: 1 },
        { label: 'PgDn', keyCode: 34, x: 18.5, y: 2.3, w: 1.5, h: 1 },
        { label: '↑', keyCode: 38, x: 17, y: 4.3, w: 1.5, h: 1 },
        { label: '←', keyCode: 37, x: 15.5, y: 5.3, w: 1.5, h: 1 }, { label: '↓', keyCode: 40, x: 17, y: 5.3, w: 1.5, h: 1 },
        { label: '→', keyCode: 39, x: 18.5, y: 5.3, w: 1.5, h: 1 },
        { label: 'none', keyCode: 0, x: 1, y: 0, w: 1, h: 1 },
        // Joystick action buttons — 3 rows so they don't crowd the mouse-control group
        // on the right. Row 1 (y=7.7): ok/cancel/shift/menu/pageup (5 buttons).
        // Row 2 (y=8.7): pagedown/escape/tab/control (4 buttons).
        // Row 3 (y=9.7): up/down/left/right (4 buttons, moved here from row 2).
        { label: 'ok', keyCode: -1, x: -0.9, y: 7.7, w: 2.4, h: 1 },
        { label: 'cancel', keyCode: -1, x: 1.5, y: 7.7, w: 2.4, h: 1 },
        { label: 'shift', keyCode: -1, x: 3.9, y: 7.7, w: 2.4, h: 1 },
        { label: 'menu', keyCode: -1, x: 6.3, y: 7.7, w: 2.4, h: 1 },
        { label: 'pageup', keyCode: -1, x: 8.7, y: 7.7, w: 2.4, h: 1 },
        { label: 'pagedown', keyCode: -1, x: 0.3, y: 8.7, w: 2.4, h: 1 },
        { label: 'escape', keyCode: -1, x: 2.7, y: 8.7, w: 2.4, h: 1 },
        { label: 'tab', keyCode: -1, x: 5.1, y: 8.7, w: 2.4, h: 1 },
        { label: 'control', keyCode: -1, x: 7.5, y: 8.7, w: 2.4, h: 1 },
        { label: 'up', keyCode: -1, x: 0.3, y: 9.7, w: 2.4, h: 1 },
        { label: 'down', keyCode: -1, x: 2.7, y: 9.7, w: 2.4, h: 1 },
        { label: 'left', keyCode: -1, x: 5.1, y: 9.7, w: 2.4, h: 1 },
        { label: 'right', keyCode: -1, x: 7.5, y: 9.7, w: 2.4, h: 1 },
        // Mouse-control picker tiles — right-bottom, 2 rows × 3 cols, placed after
        // the joystick action buttons. The "Mouse Control" caption is drawn in
        // renderKeyboardPicker above this group. Movement tiles use an "M" prefix +
        // arrow glyph (M↑/M↓/M←/M→) to distinguish them from keyboard arrow keys;
        // click tiles use LMB/RMB. vkey carries the real VirtualKey (label is a glyph).
        // Top row:  LMB       M↑(mup)   RMB
        // Bot row:  M←(mleft) M↓(mdown) M→(mright)
        { label: 'LMB', keyCode: -1, vkey: 'lmb', x: 15.0, y: 8.7, w: 1.6, h: 1 },
        { label: 'M↑', keyCode: -1, vkey: 'mup', x: 16.7, y: 8.7, w: 1.6, h: 1 },
        { label: 'RMB', keyCode: -1, vkey: 'rmb', x: 18.4, y: 8.7, w: 1.6, h: 1 },
        { label: 'M←', keyCode: -1, vkey: 'mleft', x: 15.0, y: 9.7, w: 1.6, h: 1 },
        { label: 'M↓', keyCode: -1, vkey: 'mdown', x: 16.7, y: 9.7, w: 1.6, h: 1 },
        { label: 'M→', keyCode: -1, vkey: 'mright', x: 18.4, y: 9.7, w: 1.6, h: 1 },
];

/** RPG Maker MV default keyMapper: keyCode → virtual key (number keys mapped to 'ok'). */
export const KEYCODE_TO_VKEY: Record<number, VirtualKey> = {
        9: 'tab', 13: 'ok', 16: 'shift', 17: 'control', 18: 'control', 27: 'cancel',
        32: 'ok', 33: 'pageup', 34: 'pagedown', 37: 'left', 38: 'up', 39: 'right', 40: 'down',
        45: 'escape', 81: 'pageup', 82: 'pagedown', 87: 'up', 88: 'cancel', 89: 'ok', 90: 'ok',
        48: 'ok', 49: 'ok', 50: 'ok', 51: 'ok', 52: 'ok', 53: 'ok', 54: 'ok', 55: 'ok', 56: 'ok', 57: 'ok',
};

let _allPickKeys: { label: string; vkey: VirtualKey; keyCode: number }[] | null = null;
/** Combined pickable list of keyboard keys + virtual-key buttons (lazy-init).
 *  For keyCode===-1 tiles, the KeyDef.vkey field (if present) overrides the label as the vkey,
 *  so a tile can show a glyph label ('M↑') while binding the real VirtualKey ('mup'). */
export function getAllPickKeys() {
        if (!_allPickKeys) _allPickKeys = KEYBOARD_LAYOUT.map(k => {
                if (k.keyCode === -1) {
                        return { label: k.label, vkey: (k.vkey ?? k.label) as VirtualKey, keyCode: 0 };
                }
                return { label: k.label, vkey: (k.vkey ?? KEYCODE_TO_VKEY[k.keyCode] ?? 'none') as VirtualKey, keyCode: k.keyCode };
        });
        return _allPickKeys;
}

/** Find the nearest key in the given direction (same-row constraint for Left/Right). */
export function findNearestKey(curIdx: number, dx: number, dy: number): number {
        const ALL_PICK_KEYS = getAllPickKeys();
        if (!ALL_PICK_KEYS.length) return 0;
        const cur = curIdx < KEYBOARD_LAYOUT.length ? KEYBOARD_LAYOUT[curIdx] : null;
        if (!cur) {
                if (dy < 0) return 0;
                if (dx < 0 && curIdx > KEYBOARD_LAYOUT.length) return KEYBOARD_LAYOUT.length - 1;
                return curIdx;
        }
        const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
        let bestIdx = curIdx, bestDist = Infinity;
        for (let i = 0; i < KEYBOARD_LAYOUT.length; i++) {
                if (i === curIdx) continue;
                const k = KEYBOARD_LAYOUT[i];
                const kx = k.x + k.w / 2, ky = k.y + k.h / 2;
                const ddx = kx - cx, ddy = ky - cy;
                if (dx > 0 && ddx <= 0) continue;
                if (dx < 0 && ddx >= 0) continue;
                if (dy > 0 && ddy <= 0) continue;
                if (dy < 0 && ddy >= 0) continue;
                if (dx !== 0 && Math.abs(ddy) > 0.6) continue;
                const dist = dx !== 0 ? Math.abs(ddx) : Math.abs(ddy) + Math.abs(ddx) * 0.3;
                if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        if (dx > 0 && bestIdx === curIdx && cur.x + cur.w >= 14) return KEYBOARD_LAYOUT.length;
        return bestIdx;
}

/** Cycle a virtual key to the previous in VIRTUAL_KEYS (completeness helper). */
export function prevKey(key: VirtualKey): VirtualKey {
        const i = VIRTUAL_KEYS.indexOf(key);
        return VIRTUAL_KEYS[(i + VIRTUAL_KEYS.length - 1) % VIRTUAL_KEYS.length];
}

/** Cycle a virtual key to the next in VIRTUAL_KEYS (completeness helper). */
export function nextKey(key: VirtualKey): VirtualKey {
        const i = VIRTUAL_KEYS.indexOf(key);
        return VIRTUAL_KEYS[(i + 1) % VIRTUAL_KEYS.length];
}
