/** Analog stick + face-button bindings: per-frame polling and synthetic keyup/keydown dispatch. */
import { isMouseAction, type KeyMap, type VirtualKey } from './keymap';
import type { LibraryEntry } from './game-library';

const prevStickDirActive: Record<string, boolean> = {};

/** Build a synthetic KeyboardEvent-like object safe to pass to MV's _onKeyDown/_onKeyUp. */
export function makeSyntheticKeyboardEvent(keyCode: number) {
        return {
                keyCode,
                which: keyCode,
                charCode: 0,
                key: '',
                code: '',
                location: 0,
                repeat: false,
                preventDefault: () => {},
                stopPropagation: () => {},
                stopImmediatePropagation: () => {},
                target: { defaultPrevented: false },
                currentTarget: { defaultPrevented: false },
                defaultPrevented: false,
                bubbles: false,
                cancelable: false,
                type: 'keydown',
        };
}

/** Poll the gamepad analog sticks and fire the bound keys (per-direction merge of per-game + global). */
export function pollStickBindings(currentEntry: LibraryEntry | null, globalKeymap: KeyMap): void {
        const runtime = globalThis as any;
        const input = runtime.Input;
        if (!input?._currentState) return;
        const perGameSticks = currentEntry?.keymap?.sticks;
        const globalSticks = globalKeymap.sticks;
        const s = {
                lUp: perGameSticks?.lUp || globalSticks?.lUp,
                lDown: perGameSticks?.lDown || globalSticks?.lDown,
                lLeft: perGameSticks?.lLeft || globalSticks?.lLeft,
                lRight: perGameSticks?.lRight || globalSticks?.lRight,
                rUp: perGameSticks?.rUp || globalSticks?.rUp,
                rDown: perGameSticks?.rDown || globalSticks?.rDown,
                rLeft: perGameSticks?.rLeft || globalSticks?.rLeft,
                rRight: perGameSticks?.rRight || globalSticks?.rRight,
        };
        if (!s.lUp && !s.lDown && !s.lLeft && !s.lRight && !s.rUp && !s.rDown && !s.rLeft && !s.rRight) return;
        const pad = (navigator as any).getGamepads?.()?.[0];
        if (!pad) return;
        const axes = pad.axes;
        if (!axes || axes.length < 2) return;
        const threshold = 0.5;
        const lx = Number(axes[0]) || 0, ly = Number(axes[1]) || 0;
        const rx = Number(axes[2]) || 0, ry = Number(axes[3]) || 0;

        const dirNames = ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const;
        const dirActive: Record<string, boolean> = {
                lUp: ly < -threshold, lDown: ly > threshold,
                lLeft: lx < -threshold, lRight: lx > threshold,
                rUp: ry < -threshold, rDown: ry > threshold,
                rLeft: rx < -threshold, rRight: rx > threshold,
        };

        for (const name of dirNames) {
                const binding = s[name as keyof typeof s];
                if (!binding || binding.keyCode === 0) continue;
                if (isMouseAction(binding.vkey)) continue;   // mouse-bound sticks handled by pollMouseInput
                const active = dirActive[name];
                const wasActive = !!prevStickDirActive[name];
                if (active && !wasActive) {
                        if (typeof input._onKeyDown === 'function') {
                                const ev = makeSyntheticKeyboardEvent(binding.keyCode);
                                ev.type = 'keydown';
                                input._onKeyDown(ev);
                        }
                } else if (!active && wasActive) {
                        if (typeof input._onKeyUp === 'function') {
                                const ev = makeSyntheticKeyboardEvent(binding.keyCode);
                                ev.type = 'keyup';
                                input._onKeyUp(ev);
                        }
                }
        }

        const vkeyActive = new Map<string, boolean>();
        for (const name of dirNames) {
                const binding = s[name as keyof typeof s];
                if (!binding || binding.keyCode !== 0) continue;
                if (isMouseAction(binding.vkey)) continue;   // mouse-bound sticks handled by pollMouseInput
                const active = dirActive[name];
                const vk = binding.vkey || binding.label;
                vkeyActive.set(vk, (vkeyActive.get(vk) || false) || active);
        }
        for (const [vkey, active] of vkeyActive) {
                if (active) {
                        input._currentState[vkey] = true;
                } else {
                        let justReleased = false;
                        for (const name of dirNames) {
                                const binding = s[name as keyof typeof s];
                                if (!binding || binding.keyCode !== 0) continue;
                                if (isMouseAction(binding.vkey)) continue;
                                const vk = binding.vkey || binding.label;
                                if (vk === vkey && prevStickDirActive[name]) { justReleased = true; break; }
                        }
                        if (justReleased) input._currentState[vkey] = false;
                }
        }

        for (const name of dirNames) prevStickDirActive[name] = dirActive[name];
}

/** Poll the 16 face buttons and fire _onKeyDown/_onKeyUp for buttons with keyCode bindings. */
export function pollButtonBindings(currentEntry: LibraryEntry | null, globalKeymap: KeyMap): void {
        const runtime = globalThis as any;
        const input = runtime.Input;
        if (!input) return;
        const perGameKc = currentEntry?.keymap?.keyCodes;
        const globalKc = globalKeymap.keyCodes;
        if (!perGameKc && !globalKc) return;
        const pad = (navigator as any).getGamepads?.()?.[0];
        if (!pad || !pad.buttons) return;
        for (let i = 0; i < 16; i++) {
                const kc = perGameKc?.[i] || globalKc?.[i];
                if (!kc) continue;
                const pressed = !!pad.buttons[i]?.pressed;
                const wasPressed = !!input._buttonKeyState?.[i];
                if (!input._buttonKeyState) input._buttonKeyState = {};
                if (pressed && !wasPressed) {
                        if (typeof input._onKeyDown === 'function') {
                                const ev = makeSyntheticKeyboardEvent(kc);
                                ev.type = 'keydown';
                                input._onKeyDown(ev);
                        }
                        input._buttonKeyState[i] = true;
                } else if (!pressed && wasPressed) {
                        if (typeof input._onKeyUp === 'function') {
                                const ev = makeSyntheticKeyboardEvent(kc);
                                ev.type = 'keyup';
                                input._onKeyUp(ev);
                        }
                        input._buttonKeyState[i] = false;
                }
        }
}

/** Clear all button/stick keyCode state by firing keyup for every binding (used at save/load scene boundaries). */
export function clearButtonKeyState(currentEntry: LibraryEntry | null, globalKeymap: KeyMap): void {
        const runtime = globalThis as any;
        const input = runtime.Input;
        if (!input) return;
        const perGameKc = currentEntry?.keymap?.keyCodes;
        const globalKc = globalKeymap.keyCodes;
        if (perGameKc || globalKc) {
                for (let i = 0; i < 16; i++) {
                        const kc = perGameKc?.[i] || globalKc?.[i];
                        if (!kc) continue;
                        if (typeof input._onKeyUp === 'function') {
                                const ev = makeSyntheticKeyboardEvent(kc);
                                ev.type = 'keyup';
                                try { input._onKeyUp(ev); } catch { /* best-effort */ }
                        }
                }
        }
        const pad = (navigator as any).getGamepads?.()?.[0];
        const physical = (i: number) => !!pad?.buttons?.[i]?.pressed;
        if (input._buttonKeyState) {
                for (let i = 0; i < 16; i++) input._buttonKeyState[i] = physical(i);
        } else if (pad) {
                input._buttonKeyState = {};
                for (let i = 0; i < 16; i++) input._buttonKeyState[i] = physical(i);
        }
}

export type { VirtualKey };
