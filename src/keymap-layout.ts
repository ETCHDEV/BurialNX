// === Keymap layout data + pure helpers ================================
// Extracted from main.ts to keep the 4000-line file manageable. This module
// holds the static keymap data tables (keyboard layout, color palette,
// keyCode→vkey map) and the pure spatial-navigation helpers that only touch
// those tables. None of these read or write any shared runtime state.
//
// Consumers: renderButtonGrid, renderKeyboardPicker, handleKeymapTouch,
// and the keymap-phase frame() input handler all import these constants and
// helpers. The `_allPickKeys` cache is module-private so the lazy init still
// happens exactly once per process.

import { type VirtualKey, VIRTUAL_KEYS } from './keymap';

// Color palette for the keymap UI. Each virtual key (and the 'none' fallback)
// maps to a fill color used by the button grid (left accent bar) and the
// keyboard picker (key cap background). Visual variety comes from these
// colors only — the renderers set ctx.font EXACTLY ONCE and never change it
// (nx.js allocates ~2MB per font assignment).
export const KEYMAP_COLORS: Record<string, string> = {
        ok: '#3fb950', cancel: '#f85149', shift: '#a371f7', menu: '#58a6ff',
        control: '#f0883e', tab: '#f0883e', escape: '#f85149',
        pageup: '#d2a8ff', pagedown: '#d2a8ff',
        up: '#56d364', down: '#56d364', left: '#56d364', right: '#56d364',
        none: '#6e7681',
};

// Full PC keyboard layout (adapted from autorun's launcher_input.c keycap
// array). Positions are in "key units" (1 unit = 1 standard key width).
// The keyboard occupies x=0..15, y=0..5.3. The navigation + arrow cluster
// is at x=15.5..20 (3 columns of 1.5-unit keys, touching — no gaps — so the
// right block reads as one evenly-stretched unit like a real keyboard).
// Each key has a JavaScript keyCode and is looked up in KEYCODE_TO_VKEY.
export interface KeyDef { label: string; keyCode: number; x: number; y: number; w: number; h: number; }
export const KEYBOARD_LAYOUT: KeyDef[] = [
        // Row 0: function keys (y=0)
        { label: 'Esc', keyCode: 27, x: 0, y: 0, w: 1, h: 1 },
        { label: 'F1', keyCode: 112, x: 2, y: 0, w: 1, h: 1 }, { label: 'F2', keyCode: 113, x: 3, y: 0, w: 1, h: 1 },
        { label: 'F3', keyCode: 114, x: 4, y: 0, w: 1, h: 1 }, { label: 'F4', keyCode: 115, x: 5, y: 0, w: 1, h: 1 },
        { label: 'F5', keyCode: 116, x: 6.5, y: 0, w: 1, h: 1 }, { label: 'F6', keyCode: 117, x: 7.5, y: 0, w: 1, h: 1 },
        { label: 'F7', keyCode: 118, x: 8.5, y: 0, w: 1, h: 1 }, { label: 'F8', keyCode: 119, x: 9.5, y: 0, w: 1, h: 1 },
        { label: 'F9', keyCode: 120, x: 11, y: 0, w: 1, h: 1 }, { label: 'F10', keyCode: 121, x: 12, y: 0, w: 1, h: 1 },
        { label: 'F11', keyCode: 122, x: 13, y: 0, w: 1, h: 1 }, { label: 'F12', keyCode: 123, x: 14, y: 0, w: 1, h: 1 },
        // Row 1: number row (y=1.3)
        { label: '`', keyCode: 192, x: 0, y: 1.3, w: 1, h: 1 },
        { label: '1', keyCode: 49, x: 1, y: 1.3, w: 1, h: 1 }, { label: '2', keyCode: 50, x: 2, y: 1.3, w: 1, h: 1 },
        { label: '3', keyCode: 51, x: 3, y: 1.3, w: 1, h: 1 }, { label: '4', keyCode: 52, x: 4, y: 1.3, w: 1, h: 1 },
        { label: '5', keyCode: 53, x: 5, y: 1.3, w: 1, h: 1 }, { label: '6', keyCode: 54, x: 6, y: 1.3, w: 1, h: 1 },
        { label: '7', keyCode: 55, x: 7, y: 1.3, w: 1, h: 1 }, { label: '8', keyCode: 56, x: 8, y: 1.3, w: 1, h: 1 },
        { label: '9', keyCode: 57, x: 9, y: 1.3, w: 1, h: 1 }, { label: '0', keyCode: 48, x: 10, y: 1.3, w: 1, h: 1 },
        { label: '-', keyCode: 189, x: 11, y: 1.3, w: 1, h: 1 }, { label: '=', keyCode: 187, x: 12, y: 1.3, w: 1, h: 1 },
        { label: 'Bksp', keyCode: 8, x: 13, y: 1.3, w: 2, h: 1 },
        // Row 2: QWERTY (y=2.3)
        { label: 'Tab', keyCode: 9, x: 0, y: 2.3, w: 1.5, h: 1 },
        { label: 'Q', keyCode: 81, x: 1.5, y: 2.3, w: 1, h: 1 }, { label: 'W', keyCode: 87, x: 2.5, y: 2.3, w: 1, h: 1 },
        { label: 'E', keyCode: 69, x: 3.5, y: 2.3, w: 1, h: 1 }, { label: 'R', keyCode: 82, x: 4.5, y: 2.3, w: 1, h: 1 },
        { label: 'T', keyCode: 84, x: 5.5, y: 2.3, w: 1, h: 1 }, { label: 'Y', keyCode: 89, x: 6.5, y: 2.3, w: 1, h: 1 },
        { label: 'U', keyCode: 85, x: 7.5, y: 2.3, w: 1, h: 1 }, { label: 'I', keyCode: 73, x: 8.5, y: 2.3, w: 1, h: 1 },
        { label: 'O', keyCode: 79, x: 9.5, y: 2.3, w: 1, h: 1 }, { label: 'P', keyCode: 80, x: 10.5, y: 2.3, w: 1, h: 1 },
        { label: '[', keyCode: 219, x: 11.5, y: 2.3, w: 1, h: 1 }, { label: ']', keyCode: 221, x: 12.5, y: 2.3, w: 1, h: 1 },
        { label: '\\', keyCode: 220, x: 13.5, y: 2.3, w: 1.5, h: 1 },
        // Row 3: ASDF (y=3.3)
        { label: 'Caps', keyCode: 20, x: 0, y: 3.3, w: 1.75, h: 1 },
        { label: 'A', keyCode: 65, x: 1.75, y: 3.3, w: 1, h: 1 }, { label: 'S', keyCode: 83, x: 2.75, y: 3.3, w: 1, h: 1 },
        { label: 'D', keyCode: 68, x: 3.75, y: 3.3, w: 1, h: 1 }, { label: 'F', keyCode: 70, x: 4.75, y: 3.3, w: 1, h: 1 },
        { label: 'G', keyCode: 71, x: 5.75, y: 3.3, w: 1, h: 1 }, { label: 'H', keyCode: 72, x: 6.75, y: 3.3, w: 1, h: 1 },
        { label: 'J', keyCode: 74, x: 7.75, y: 3.3, w: 1, h: 1 }, { label: 'K', keyCode: 75, x: 8.75, y: 3.3, w: 1, h: 1 },
        { label: 'L', keyCode: 76, x: 9.75, y: 3.3, w: 1, h: 1 }, { label: ';', keyCode: 186, x: 10.75, y: 3.3, w: 1, h: 1 },
        { label: "'", keyCode: 222, x: 11.75, y: 3.3, w: 1, h: 1 }, { label: 'Enter', keyCode: 13, x: 12.75, y: 3.3, w: 2.25, h: 1 },
        // Row 4: ZXCV (y=4.3)
        { label: 'Shift', keyCode: 16, x: 0, y: 4.3, w: 2.25, h: 1 },
        { label: 'Z', keyCode: 90, x: 2.25, y: 4.3, w: 1, h: 1 }, { label: 'X', keyCode: 88, x: 3.25, y: 4.3, w: 1, h: 1 },
        { label: 'C', keyCode: 67, x: 4.25, y: 4.3, w: 1, h: 1 }, { label: 'V', keyCode: 86, x: 5.25, y: 4.3, w: 1, h: 1 },
        { label: 'B', keyCode: 66, x: 6.25, y: 4.3, w: 1, h: 1 }, { label: 'N', keyCode: 78, x: 7.25, y: 4.3, w: 1, h: 1 },
        { label: 'M', keyCode: 77, x: 8.25, y: 4.3, w: 1, h: 1 }, { label: ',', keyCode: 188, x: 9.25, y: 4.3, w: 1, h: 1 },
        { label: '.', keyCode: 190, x: 10.25, y: 4.3, w: 1, h: 1 }, { label: '/', keyCode: 191, x: 11.25, y: 4.3, w: 1, h: 1 },
        { label: 'Shift', keyCode: 16, x: 12.25, y: 4.3, w: 2.75, h: 1 },
        // Row 5: bottom (y=5.3)
        { label: 'Ctrl', keyCode: 17, x: 0, y: 5.3, w: 1.5, h: 1 }, { label: 'Win', keyCode: 91, x: 1.5, y: 5.3, w: 1.25, h: 1 },
        { label: 'Alt', keyCode: 18, x: 2.75, y: 5.3, w: 1.25, h: 1 }, { label: 'Space', keyCode: 32, x: 4, y: 5.3, w: 6, h: 1 },
        { label: 'Alt', keyCode: 18, x: 10, y: 5.3, w: 1.25, h: 1 }, { label: 'Win', keyCode: 92, x: 11.25, y: 5.3, w: 1.25, h: 1 },
        { label: 'Menu', keyCode: 93, x: 12.5, y: 5.3, w: 1.25, h: 1 }, { label: 'Ctrl', keyCode: 17, x: 13.75, y: 5.3, w: 1.25, h: 1 },
        // Navigation cluster + arrow keys — 3 columns, each key 1.5 units
        // wide and TOUCHING (no gap), so the whole right block reads as one
        // evenly-stretched unit like a real keyboard's nav/arrow cluster.
        // Col1 x=15.5, Col2 x=17, Col3 x=18.5 (each w=1.5, adjacent).
        { label: 'Prt', keyCode: 44, x: 15.5, y: 0, w: 1.5, h: 1 }, { label: 'Scr', keyCode: 145, x: 17, y: 0, w: 1.5, h: 1 },
        { label: 'Pause', keyCode: 19, x: 18.5, y: 0, w: 1.5, h: 1 },
        { label: 'Ins', keyCode: 45, x: 15.5, y: 1.3, w: 1.5, h: 1 }, { label: 'Home', keyCode: 36, x: 17, y: 1.3, w: 1.5, h: 1 },
        { label: 'PgUp', keyCode: 33, x: 18.5, y: 1.3, w: 1.5, h: 1 },
        { label: 'Del', keyCode: 46, x: 15.5, y: 2.3, w: 1.5, h: 1 }, { label: 'End', keyCode: 35, x: 17, y: 2.3, w: 1.5, h: 1 },
        { label: 'PgDn', keyCode: 34, x: 18.5, y: 2.3, w: 1.5, h: 1 },
        // Arrow keys — same 3 columns, 1.5-unit width, touching (no gaps),
        // matching the nav cluster above so the whole right block reads as
        // one evenly-stretched unit like a real keyboard's arrow cluster.
        { label: '↑', keyCode: 38, x: 17, y: 4.3, w: 1.5, h: 1 },
        { label: '←', keyCode: 37, x: 15.5, y: 5.3, w: 1.5, h: 1 }, { label: '↓', keyCode: 40, x: 17, y: 5.3, w: 1.5, h: 1 },
        { label: '→', keyCode: 39, x: 18.5, y: 5.3, w: 1.5, h: 1 },
        // "none" key — clears the binding (keyCode 0 → 'none' fallback).
        // Positioned right of Esc with same spacing as Esc→backtick.
        { label: 'none', keyCode: 0, x: 1, y: 0, w: 1, h: 1 },
        // Virtual key buttons — processed as gamepad vkeys (NOT keyboard
        // keyCodes). When selected, keyCode=0 means "use gamepadMapper".
        // Arranged in TWO centered rows below the keyboard:
        //   row 1 (y=7.7): ok, cancel, shift, menu, pageup, pagedown, escape
        //   row 2 (y=8.7): tab, up, down, left, right, control
        // The gap between the keyboard bottom (y=6.3) and vkey row 1 (y=7.7)
        // is 1.4 units — DOUBLE the original 0.7-unit gap, so the joystick
        // action section sits clearly apart from the PC keyboard.
        // Width = 2.4 (×55px scale = 132px, with -2px padding = 130px
        // text area) — wide enough for the longest label "pagedown"
        // (~110px in the Switch system sans-serif at 20px) to fit
        // comfortably with ~20px of margin.
        // Row 1 total = 7 × 2.4 = 16.8 units; centered at x=-0.9
        // (slightly past the keyboard left/right edges, but the nav
        // cluster sits at y=0..2.3, so y=7.7 is clear).
        // Row 2 total = 6 × 2.4 = 14.4 units; centered at x=0.3.
        { label: 'ok', keyCode: -1, x: -0.9, y: 7.7, w: 2.4, h: 1 },
        { label: 'cancel', keyCode: -1, x: 1.5, y: 7.7, w: 2.4, h: 1 },
        { label: 'shift', keyCode: -1, x: 3.9, y: 7.7, w: 2.4, h: 1 },
        { label: 'menu', keyCode: -1, x: 6.3, y: 7.7, w: 2.4, h: 1 },
        { label: 'pageup', keyCode: -1, x: 8.7, y: 7.7, w: 2.4, h: 1 },
        { label: 'pagedown', keyCode: -1, x: 11.1, y: 7.7, w: 2.4, h: 1 },
        { label: 'escape', keyCode: -1, x: 13.5, y: 7.7, w: 2.4, h: 1 },
        { label: 'tab', keyCode: -1, x: 0.3, y: 8.7, w: 2.4, h: 1 },
        { label: 'up', keyCode: -1, x: 2.7, y: 8.7, w: 2.4, h: 1 },
        { label: 'down', keyCode: -1, x: 5.1, y: 8.7, w: 2.4, h: 1 },
        { label: 'left', keyCode: -1, x: 7.5, y: 8.7, w: 2.4, h: 1 },
        { label: 'right', keyCode: -1, x: 9.9, y: 8.7, w: 2.4, h: 1 },
        { label: 'control', keyCode: -1, x: 12.3, y: 8.7, w: 2.4, h: 1 },
];
// RPG Maker MV default keyMapper: keyCode → virtual key.
// Number keys (48-57) are not in the default MV keyMapper, but we map them
// to 'ok' so that binding a joycon button to "1", "2", "5", etc. produces
// a meaningful action (menu/selection confirmation) instead of 'none'.
export const KEYCODE_TO_VKEY: Record<number, VirtualKey> = {
        9: 'tab', 13: 'ok', 16: 'shift', 17: 'control', 18: 'control', 27: 'cancel',
        32: 'ok', 33: 'pageup', 34: 'pagedown', 37: 'left', 38: 'up', 39: 'right', 40: 'down',
        45: 'escape', 81: 'pageup', 82: 'pagedown', 87: 'up', 88: 'cancel', 89: 'ok', 90: 'ok',
        48: 'ok', 49: 'ok', 50: 'ok', 51: 'ok', 52: 'ok', 53: 'ok', 54: 'ok', 55: 'ok', 56: 'ok', 57: 'ok',
};

// Mouse buttons removed — RPG Maker MV games use TouchInput for touch,
// not mouse events. Touch support is handled by forwarding screen touch
// events to document in installGameCompatibility.
// Combined pickable list: keyboard keys + virtual-key action buttons.
// Created lazily when the keyboard picker opens, not at module scope.
// Each entry carries the label, the vkey it resolves to, and the keyCode
// to forward to Input._onKeyDown (0 for vkey-only buttons that use
// gamepadMapper).
let _allPickKeys: { label: string; vkey: VirtualKey; keyCode: number }[] | null = null;
export function getAllPickKeys() {
        if (!_allPickKeys) _allPickKeys = KEYBOARD_LAYOUT.map(k => {
                if (k.keyCode === -1) {
                        // Virtual-key action button — vkey is the label itself
                        // ('ok', 'cancel', etc.); no keyCode to forward.
                        return { label: k.label, vkey: k.label as VirtualKey, keyCode: 0 };
                }
                return { label: k.label, vkey: KEYCODE_TO_VKEY[k.keyCode] || ('none' as VirtualKey), keyCode: k.keyCode };
        });
        return _allPickKeys;
}

// Spatial navigation: find the nearest key in the given direction.
// For Left/Right: constrain to the SAME ROW (Y distance < 0.6 units)
// so the cursor doesn't jump to a different row when moving horizontally.
// For Up/Down: use full spatial navigation (nearest key above/below).
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
                // For horizontal movement: require same row (small Y difference)
                if (dx !== 0 && Math.abs(ddy) > 0.6) continue;
                // For vertical movement: require same column-ish (small X difference)
                const dist = dx !== 0 ? Math.abs(ddx) : Math.abs(ddy) + Math.abs(ddx) * 0.3;
                if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        if (dx > 0 && bestIdx === curIdx && cur.x + cur.w >= 14) return KEYBOARD_LAYOUT.length;
        return bestIdx;
}

// Cycle a virtual key to the previous/next in the VIRTUAL_KEYS list. Kept
// for completeness; the main picker UI uses the visual keyboard grid instead.
export function prevKey(key: VirtualKey): VirtualKey {
        const i = VIRTUAL_KEYS.indexOf(key);
        return VIRTUAL_KEYS[(i + VIRTUAL_KEYS.length - 1) % VIRTUAL_KEYS.length];
}
export function nextKey(key: VirtualKey): VirtualKey {
        const i = VIRTUAL_KEYS.indexOf(key);
        return VIRTUAL_KEYS[(i + 1) % VIRTUAL_KEYS.length];
}
