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

/** Logical names for the 16 standard Web Gamepad button indices.
 *  The index follows the Web Gamepad API standard mapping:
 *    0 = South (Nintendo B), 1 = East (Nintendo A),
 *    2 = North (Nintendo X), 3 = West (Nintendo Y). */
export const BUTTON_NAMES: readonly string[] = Object.freeze([
        'B / South', 'A / East', 'X', 'Y',
        'L (LB)', 'R (RB)', 'ZL (LT)', 'ZR (RT)',
        'Minus (-)', 'Plus (+)', 'L Stick', 'R Stick',
        'D-Up', 'D-Down', 'D-Left', 'D-Right',
]);

/** Display order for the 16 buttons in the keymap editor grid.
 *  Position 0 = button index 1 (East / Nintendo A) — shown FIRST.
 *  Position 1 = button index 0 (South / Nintendo B) — shown SECOND.
 *  Positions 2..15 = unchanged. This way the user sees "A" first, "B"
 *  second in the grid, matching the physical Switch layout (A = right). */
export const BUTTON_DISPLAY_ORDER: readonly number[] = Object.freeze([
        1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
]);

/** Convert a grid display position (0..15) to the real button index.
 *  For stick directions (16..23) returns the position as-is. */
export function displayToButtonIndex(displayPos: number): number {
        if (displayPos < 16) return BUTTON_DISPLAY_ORDER[displayPos] ?? displayPos;
        return displayPos;
}

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
        /** Optional keyCodes — when present, the bound keyCode is sent
         *  directly to Input._currentState (simulating a keyboard key press)
         *  instead of using the vkey via gamepadMapper. This lets the game's
         *  own keyMapper decide what the key does. */
        keyCodes?: number[];
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

/** Nintendo face-button LETTERS for the 16 gamepad button indices, where
 *  the index follows the Web Gamepad API standard mapping (which BurialNX
 *  uses via `navigator.getGamepads()[0].buttons`):
 *    0 = South = Nintendo B (bottom)
 *    1 = East  = Nintendo A (right)
 *    2 = North = Nintendo X (top)
 *    3 = West  = Nintendo Y (left)
 *  4..11 are shoulder/trigger/stick-clicks (L/R/ZL/ZR/Minus/Plus/LSt/RSt),
 *  12..15 are the D-pad. Only the face buttons (0..3) have meaningful
 *  single-letter labels; the rest render their index so they're never
 *  blank. This is what the loader's own menu panels use to print the
 *  correct "A:" / "B:" hint for whichever button the active keymap maps
 *  to ok/cancel (see menuButtonIndices). */
export const FACE_BUTTON_LETTERS: readonly string[] = Object.freeze([
        'B', 'A', 'X', 'Y', '4', '5', '6', '7', '-', '+', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→',
]);

/** The printable letter for a gamepad button index (0..15). Face buttons
 *  return their Nintendo label ('B'/'A'/'X'/'Y'); others return a short
 *  symbol. Never returns an empty string. */
export function faceButtonLetter(index: number): string {
        return FACE_BUTTON_LETTERS[index] ?? String(index);
}

/** keyCode constants used to detect "ok" / "cancel" roles from a button's
 *  optional keyCode binding (the `keyCodes` array on a KeyMap). RPG Maker
 *  MV's default Input.keyMapper maps these keyCodes to the named vkeys:
 *    enter (13) → 'ok', space (32) → 'ok', esc (27) → 'escape' (≈ cancel).
 *  So a button bound to keyCode 13 "is ok" for menu purposes even if its
 *  vkey entry is 'none' — the game's keyMapper translates the fired keydown
 *  to 'ok' at runtime. */
export const KEYCODE_ENTER = 13;
export const KEYCODE_SPACE = 32;
export const KEYCODE_ESCAPE = 27;

/** True if button `i` acts as the "ok" (confirm) role in the game — either
 *  via its vkey being 'ok', OR via its keyCode binding being enter/space
 *  (which RPG Maker MV's keyMapper translates to 'ok'). */
function isOkRoleAt(keymap: KeyMap, i: number): boolean {
        if (keymap.buttons[i] === 'ok') return true;
        const kc = keymap.keyCodes?.[i];
        return kc === KEYCODE_ENTER || kc === KEYCODE_SPACE;
}

/** True if button `i` acts as the "cancel" role in the game — either via
 *  its vkey being 'cancel' or 'escape' (RPG Maker MV treats 'escape' as a
 *  cancel/back key alongside 'cancel'), OR via its keyCode binding being
 *  esc (27, which the keyMapper maps to 'escape'). */
function isCancelRoleAt(keymap: KeyMap, i: number): boolean {
        const v = keymap.buttons[i];
        if (v === 'cancel' || v === 'escape') return true;
        const kc = keymap.keyCodes?.[i];
        return kc === KEYCODE_ESCAPE;
}

/** Determine which face-button indices act as CONFIRM (ok) and CANCEL in
 *  the loader's OWN menus (pause menu, save-choice, save/load scene,
 *  quit/return notice, keymap editor, picker, rename, game-options,
 *  library — EVERY loader screen).
 *
 *  Rule (per the user's spec, with the priority made explicit):
 *
 *    1. A is checked FIRST. If A (Nintendo A, button 1) is set to
 *       ok(enter/space) or cancel(esc) — by vkey OR by keyCode — A
 *       determines BOTH menu roles: A = its role, B = the opposite.
 *       This holds REGARDLESS of what B is set to ("вне зависимости от
 *       того что на B установлено").
 *
 *    2. Only if A is NOT set (not ok/enter/space AND not cancel/esc) do we
 *       check B (Nintendo B, button 0). If B is set to ok or cancel, B
 *       determines both roles: B = its role, A = the opposite.
 *
 *    3. If NEITHER A nor B is set → default: A = ok (confirm), B = cancel.
 *
 *  "Set to ok"   = vkey 'ok'                 OR keyCode enter(13)/space(32).
 *  "Set to cancel" = vkey 'cancel'/'escape'  OR keyCode esc(27).
 *
 *  Only buttons 0 and 1 (Nintendo A/B) are considered — X/Y/shoulders/
 *  D-pad never become the menu confirm/cancel.
 *
 *  Button indices follow the Web Gamepad API standard mapping BurialNX
 *  uses: 0 = Nintendo B (South), 1 = Nintendo A (East). Returns
 *  { confirm, cancel } where both are 0 or 1. */
export function menuButtonIndicesFor(keymap: KeyMap): { confirm: number; cancel: number } {
        const A = 1; // Nintendo A (East) = button index 1
        const B = 0; // Nintendo B (South) = button index 0
        // Priority: A first. If A is set (ok or cancel), A wins and B takes
        // the opposite role — regardless of B's own binding.
        if (isOkRoleAt(keymap, A)) return { confirm: A, cancel: B };
        if (isCancelRoleAt(keymap, A)) return { confirm: B, cancel: A };
        // A is NOT set → check B. If B is set, B wins and A takes the
        // opposite role.
        if (isOkRoleAt(keymap, B)) return { confirm: B, cancel: A };
        if (isCancelRoleAt(keymap, B)) return { confirm: A, cancel: B };
        // Neither A nor B is set → default: A = ok (confirm), B = cancel.
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

/** Apply the user's remap to RPG Maker MV's Input.gamepadMapper, replacing the
 *  hard-coded default. Only buttons remapped to `none` are removed; others are
 *  set so the engine sees the chosen virtual key.
 *
 *  Buttons with a non-zero keyCode binding are SKIPPED here — those are sent
 *  via Input._onKeyDown by pollButtonBindings() in main.ts. Setting
 *  gamepadMapper for them too would cause DOUBLE input (gamepad vkey +
 *  keyboard keyCode). keyCode=0 means "no keyboard binding, use
 *  gamepadMapper" — don't skip those. */
export function applyKeyMap(runtime: any, map: KeyMap): void {
        if (!runtime?.Input) return;
        const mapper: Record<number, string> = {};
        map.buttons.forEach((key, index) => {
                // Skip buttons with a keyCode binding — those are sent via
                // Input._onKeyDown by pollButtonBindings(). Setting
                // gamepadMapper would cause DOUBLE input (gamepad vkey +
                // keyboard keyCode). keyCode=0 means "no keyboard binding,
                // use gamepadMapper" — don't skip those.
                if (map.keyCodes && map.keyCodes[index]) return;
                if (key !== 'none') mapper[index] = key;
        });
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
        const result: KeyMap = { buttons };
        if (map.labels) result.labels = map.labels.slice();
        if (map.keyCodes) {
                result.keyCodes = map.keyCodes.slice();
                result.keyCodes[index] = 0;
        }
        if (map.sticks) result.sticks = map.sticks;
        return result;
}

/** Set a button binding with a display label AND a keyCode. The keyCode
 *  is sent to Input._currentState at runtime so the game's keyMapper
 *  (not gamepadMapper) decides what the key does. */
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
