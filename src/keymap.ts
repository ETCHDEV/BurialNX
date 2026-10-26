import { safeSdPath } from './settings';

/**
 * Joycon → virtual mouse/keyboard remapping.
 *
 * The Switch runtime cannot synthesize a real mouse or keyboard event from
 * inside a homebrew loader: those HID devices belong to the OS and are not
 * writable by user-mode applications. What we *can* do is remap the meaning
 * of each joycon button *as the game sees it*: RPG Maker MV reads input
 * through a small number of named virtual keys (`ok`, `cancel`, `shift`,
 * `menu`, `up/down/left/right`, `pageup/pagedown`). By editing
 * `Input.gamepadMapper` we can make button 1 act like "left mouse button"
 * (i.e. the game's `ok`), button 0 act like "right mouse button"
 * (i.e. the game's `cancel`), and the D-pad move the in-game cursor — which
 * is exactly what a mouse would do in an RPG Maker MV game.
 *
 * This module defines a portable, JSON-serializable mapping so the user can
 * edit it from the in-app settings UI without writing code, and a small set
 * of presets for common control schemes ("Default", "Mouse", "Keyboard",
 * "WASD + Mouse").
 */

export type VirtualKey =
        | 'ok' | 'cancel' | 'shift' | 'control' | 'tab' | 'escape'
        | 'menu' | 'pageup' | 'pagedown'
        | 'up' | 'down' | 'left' | 'right' | 'none';

/** Logical names for the 16 standard Web Gamepad button indices. */
export const BUTTON_NAMES: readonly string[] = Object.freeze([
        'A (B / South)', 'B (A / East)', 'X (Y / North)', 'Y (X / West)',
        'L (LB)', 'R (RB)', 'ZL (LT)', 'ZR (RT)',
        'Minus (-)', 'Plus (+)', 'L Stick', 'R Stick',
        'D-Up', 'D-Down', 'D-Left', 'D-Right',
]);

export const VIRTUAL_KEYS: readonly VirtualKey[] = Object.freeze([
        'none', 'ok', 'cancel', 'shift', 'control', 'tab', 'escape', 'menu', 'pageup', 'pagedown',
        'up', 'down', 'left', 'right',
]);

export interface StickBinding {
        /** JavaScript keyCode (e.g. 87 for 'W', 83 for 'S'). */
        keyCode: number;
        /** Display label (e.g. 'W', 'S', 'A', 'D'). */
        label: string;
}

export interface KeyMap {
        /** Maps a gamepad button index (0-15) to a virtual RPG Maker MV key. */
        buttons: VirtualKey[];
        /** Optional display labels (keyboard key names like '5', 'U', 'Enter').
         *  When present, the UI shows the label instead of the virtual key name
         *  so the user can see which keyboard key is bound to each button. */
        labels?: string[];
        /** Analog stick → keyboard key bindings. When the stick is pushed
         *  past 0.5 in a direction, the bound keyCode is "pressed" via
         *  Input._currentState. This lets the user bind sticks to movement
         *  keys (e.g. L-stick up = W, L-stick down = S, etc.). */
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

/** Apply the user's remap to RPG Maker MV's Input.gamepadMapper, replacing the
 *  hard-coded default. Only buttons remapped to `none` are removed; others are
 *  set so the engine sees the chosen virtual key. */
export function applyKeyMap(runtime: any, map: KeyMap): void {
        if (!runtime?.Input) return;
        const mapper: Record<number, string> = {};
        map.buttons.forEach((key, index) => { if (key !== 'none') mapper[index] = key; });
        // The original loader also maps buttons 9 and 12-15 to in-game menu and
        // directions. If the user has remapped them, honor the user. Otherwise,
        // keep them so a fresh KeyMap behaves like the original loader.
        if (mapper[9] === undefined) mapper[9] = 'menu';
        if (mapper[12] === undefined) mapper[12] = 'up';
        if (mapper[13] === undefined) mapper[13] = 'down';
        if (mapper[14] === undefined) mapper[14] = 'left';
        if (mapper[15] === undefined) mapper[15] = 'right';
        runtime.Input.gamepadMapper = mapper;
}

/** Edit a single button binding in place and return a new immutable map. */
export function setButton(map: KeyMap, index: number, key: VirtualKey): KeyMap {
        if (index < 0 || index >= 16) throw new Error('Invalid button index');
        const buttons = map.buttons.slice();
        buttons[index] = key;
        return { buttons, ...(map.labels ? { labels: map.labels.slice() } : {}) };
}

/** Set a button binding with a display label (e.g. '5' for the '5' key). */
export function setButtonWithLabel(map: KeyMap, index: number, key: VirtualKey, label: string): KeyMap {
        if (index < 0 || index >= 16) throw new Error('Invalid button index');
        const buttons = map.buttons.slice();
        buttons[index] = key;
        const labels = map.labels ? map.labels.slice() : new Array(16).fill('');
        labels[index] = label;
        return { buttons, labels };
}

export { KEYMAP_PATH };
