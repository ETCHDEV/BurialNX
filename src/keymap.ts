import { safeSdPath } from './settings';

/** Joycon → virtual mouse/keyboard remapping (JSON-serializable KeyMap + presets). */
export type VirtualKey =
        | 'ok' | 'cancel' | 'shift' | 'control' | 'tab' | 'escape'
        | 'menu' | 'pageup' | 'pagedown'
        | 'up' | 'down' | 'left' | 'right' | 'none'
        | 'mup' | 'mdown' | 'mleft' | 'mright' | 'lmb' | 'rmb';

/** Logical names for the 16 standard Web Gamepad button indices. */
export const BUTTON_NAMES: readonly string[] = Object.freeze([
        'B / South', 'A / East', 'X', 'Y',
        'L (LB)', 'R (RB)', 'ZL (LT)', 'ZR (RT)',
        'Minus (-)', 'Plus (+)', 'L Stick', 'R Stick',
        'D-Up', 'D-Down', 'D-Left', 'D-Right',
]);

/** Display order for the 16 buttons in the keymap editor grid (A first, B second). */
export const BUTTON_DISPLAY_ORDER: readonly number[] = Object.freeze([
        1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);

/** Convert a grid display position (0..15) to the real button index. */
export function displayToButtonIndex(displayPos: number): number {
        if (displayPos < 16) return BUTTON_DISPLAY_ORDER[displayPos] ?? displayPos;
        return displayPos;
}

export const VIRTUAL_KEYS: readonly VirtualKey[] = Object.freeze([
        'none', 'ok', 'cancel', 'shift', 'control', 'tab', 'escape', 'menu', 'pageup', 'pagedown',
        'up', 'down', 'left', 'right',
        'mup', 'mdown', 'mleft', 'mright', 'lmb', 'rmb',
]);

/** Virtual keys that drive the on-screen mouse cursor instead of RPG Maker's Input. */
export const MOUSE_ACTIONS: readonly VirtualKey[] = Object.freeze([
        'mup', 'mdown', 'mleft', 'mright', 'lmb', 'rmb',
]);

/** Mouse movement directions (cursor motion), excludes click buttons. */
export const MOUSE_MOVE_ACTIONS: readonly VirtualKey[] = Object.freeze([
        'mup', 'mdown', 'mleft', 'mright',
]);

/** Mouse click buttons (LMB / RMB). */
export const MOUSE_CLICK_ACTIONS: readonly VirtualKey[] = Object.freeze([
        'lmb', 'rmb',
]);

/** Friendly display labels for the mouse virtual keys.
 *  Movements use an "M" prefix + arrow glyph (M↑/M↓/M←/M→) so they are visually
 *  distinct from the keyboard arrow keys (↑↓←→); clicks use LMB/RMB. */
export const MOUSE_DISPLAY: Readonly<Record<string, string>> = Object.freeze({
        mup: 'M↑', mdown: 'M↓', mleft: 'M←', mright: 'M→', lmb: 'LMB', rmb: 'RMB',
});

/** True if `key` is any mouse action (movement or click). */
export function isMouseAction(key: unknown): key is VirtualKey {
        return key === 'mup' || key === 'mdown' || key === 'mleft' || key === 'mright' || key === 'lmb' || key === 'rmb';
}

/** True if `key` drives cursor movement (mup/mdown/mleft/mright). */
export function isMouseMoveAction(key: unknown): boolean {
        return key === 'mup' || key === 'mdown' || key === 'mleft' || key === 'mright';
}

/** True if `key` drives a mouse click (lmb/rmb). */
export function isMouseClickAction(key: unknown): boolean {
        return key === 'lmb' || key === 'rmb';
}

export interface StickBinding {
        /** JavaScript keyCode (e.g. 87 for 'W', 83 for 'S'). 0 for virtual-action / mouse bindings. */
        keyCode: number;
        /** Display label (e.g. 'W', 'S', 'A', 'D', 'M↑'). */
        label: string;
        /** Virtual key name for keyCode===0 bindings (e.g. 'ok', 'mup'). Keyboard keys leave this undefined. */
        vkey?: string;
}

export interface KeyMap {
        /** Maps a gamepad button index (0-15) to a virtual RPG Maker MV key. */
        buttons: VirtualKey[];
        /** Optional display labels (keyboard key names like '5', 'U', 'Enter'). */
        labels?: string[];
        /** Optional keyCodes sent directly to Input._currentState. */
        keyCodes?: number[];
        /** Analog stick → keyboard key bindings. */
        sticks?: {
                lUp?: StickBinding; lDown?: StickBinding;
                lLeft?: StickBinding; lRight?: StickBinding;
                rUp?: StickBinding; rDown?: StickBinding;
                rLeft?: StickBinding; rRight?: StickBinding;
        };
}

export const DEFAULT_KEYMAP: KeyMap = {
        buttons: ['cancel', 'ok', 'shift', 'menu', 'pageup', 'pagedown', 'none', 'none', 'none', 'none', 'none', 'none', 'up', 'down', 'left', 'right'],
};

export const PRESETS: { name: string; map: KeyMap }[] = [
        { name: 'Default', map: DEFAULT_KEYMAP },
        {
                name: 'Mouse',
                map: {
                        buttons: ['cancel', 'ok', 'ok', 'cancel', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'up', 'down', 'left', 'right'],
                },
        },
        {
                name: 'Keyboard (WASD + E/Q)',
                map: {
                        buttons: ['none', 'ok', 'shift', 'cancel', 'pageup', 'pagedown', 'none', 'none', 'none', 'none', 'none', 'none', 'up', 'down', 'left', 'right'],
                },
        },
        {
                name: 'Twin-Stick',
                map: {
                        buttons: ['ok', 'cancel', 'shift', 'menu', 'pageup', 'pagedown', 'none', 'none', 'none', 'none', 'none', 'none', 'up', 'down', 'left', 'right'],
                },
        },
];

/** Nintendo face-button letters for the 16 gamepad button indices. */
export const FACE_BUTTON_LETTERS: readonly string[] = Object.freeze([
        'B', 'A', 'X', 'Y', '4', '5', '6', '7', '-', '+', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→',
]);

/** The printable letter for a gamepad button index (0..15). */
export function faceButtonLetter(index: number): string {
        return FACE_BUTTON_LETTERS[index] ?? String(index);
}

/** keyCode constants for ok/space/esc used to detect menu roles from keyCode bindings. */
export const KEYCODE_ENTER = 13;
export const KEYCODE_SPACE = 32;
export const KEYCODE_ESCAPE = 27;

/** True if button `i` acts as the "ok" (confirm) role in the game. */
function isOkRoleAt(keymap: KeyMap, i: number): boolean {
        if (keymap.buttons[i] === 'ok') return true;
        const kc = keymap.keyCodes?.[i];
        return kc === KEYCODE_ENTER || kc === KEYCODE_SPACE;
}

/** True if button `i` acts as the "cancel" role in the game. */
function isCancelRoleAt(keymap: KeyMap, i: number): boolean {
        const v = keymap.buttons[i];
        if (v === 'cancel' || v === 'escape') return true;
        const kc = keymap.keyCodes?.[i];
        return kc === KEYCODE_ESCAPE;
}

/** Determine which face-button indices act as CONFIRM and CANCEL in the loader's menus. */
export function menuButtonIndicesFor(keymap: KeyMap): { confirm: number; cancel: number } {
        const A = 1;
        const B = 0;
        if (isOkRoleAt(keymap, A)) return { confirm: A, cancel: B };
        if (isCancelRoleAt(keymap, A)) return { confirm: B, cancel: A };
        if (isOkRoleAt(keymap, B)) return { confirm: B, cancel: A };
        if (isCancelRoleAt(keymap, B)) return { confirm: A, cancel: B };
        return { confirm: A, cancel: B };
}

export function parseKeyMap(text: string): KeyMap {
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object') throw new Error('Invalid key map');
        if (!Array.isArray(data.buttons) || data.buttons.length !== 16) throw new Error('Invalid key map: expected 16 buttons');
        const buttons = data.buttons.map((value: unknown, index: number) => {
                if (typeof value !== 'string' || !VIRTUAL_KEYS.includes(value as VirtualKey)) throw new Error(`Invalid key for button ${index}`);
                return value as VirtualKey;
        });
        const map: KeyMap = { buttons };
        if (Array.isArray(data.labels)) map.labels = data.labels;
        if (Array.isArray(data.keyCodes)) map.keyCodes = data.keyCodes;
        if (data.sticks && typeof data.sticks === 'object') map.sticks = data.sticks;
        return map;
}

const KEYMAP_PATH = 'sdmc:/switch/burialnx/keymap.json';

export interface KeyMapAccess {
        readFileSync(path: string): ArrayBuffer | null;
        writeFileSync(path: string, value: string | ArrayBuffer): void;
        mkdirSync(path: string): void;
}

export function loadKeyMap(fs: KeyMapAccess): KeyMap {
        try {
                const raw = fs.readFileSync(KEYMAP_PATH);
                if (raw) return parseKeyMap(new TextDecoder().decode(raw));
        } catch { /* fall back to default */ }
        return { buttons: [...DEFAULT_KEYMAP.buttons] };
}

export function saveKeyMap(fs: KeyMapAccess, map: KeyMap): boolean {
        try {
                try { fs.mkdirSync('sdmc:/switch/burialnx'); } catch { /* may already exist */ }
                fs.writeFileSync(KEYMAP_PATH, JSON.stringify(map, null, 2));
                return true;
        } catch (error) { console.error(`Could not save key map: ${String(error)}`); return false; }
}

/** Apply the user's remap to RPG Maker MV's Input.gamepadMapper. Mouse-action bindings
 *  are skipped here (they drive the on-screen cursor via mouse-input.ts, not RPG Maker's Input).
 *  Buttons set to 'none' are left unmapped — RPG Maker MV's _updateGamepadState checks
 *  gamepadMapper[j] and only fires if the entry exists, so 'none' = truly silent.
 *  No default fallbacks are injected — if the user explicitly unmapped a button, it
 *  must stay unmapped (previously D-pad/Minus were force-added, leaking signals). */
export function applyKeyMap(runtime: any, map: KeyMap): void {
        if (!runtime?.Input) return;
        const mapper: Record<number, string> = {};
        map.buttons.forEach((key, index) => {
                if (map.keyCodes && map.keyCodes[index]) return;
                if (isMouseAction(key)) return;
                if (key !== 'none') mapper[index] = key;
        });
        runtime.Input.gamepadMapper = mapper;
}

/** Edit a single button binding in place and return a new immutable map. */
export function setButton(map: KeyMap, index: number, key: VirtualKey): KeyMap {
        if (index < 0 || index >= 16) throw new Error('Invalid button index');
        const buttons = map.buttons.slice();
        buttons[index] = key;
        const result: KeyMap = { buttons };
        if (map.labels) result.labels = map.labels.slice();
        if (map.keyCodes) {
                result.keyCodes = map.keyCodes.slice();
                result.keyCodes[index] = 0;
        }
        if (map.sticks) result.sticks = map.sticks;
        return result;
}

/** Set a button binding with a display label AND a keyCode. */
export function setButtonWithLabel(map: KeyMap, index: number, key: VirtualKey, label: string, keyCode: number): KeyMap {
        if (index < 0 || index >= 16) throw new Error('Invalid button index');
        const buttons = map.buttons.slice();
        buttons[index] = key;
        const labels = map.labels ? map.labels.slice() : new Array(16).fill('');
        labels[index] = label;
        const keyCodes = map.keyCodes ? map.keyCodes.slice() : new Array(16).fill(0);
        keyCodes[index] = keyCode;
        const result: KeyMap = { buttons, labels, keyCodes };
        if (map.sticks) result.sticks = map.sticks;
        return result;
}

export { KEYMAP_PATH };
