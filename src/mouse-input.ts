/** Virtual mouse cursor: maps joycon buttons + analog sticks to cursor motion
 *  (mup/mdown/mleft/mright) and click buttons (lmb/rmb), drives RPG Maker MV's
 *  TouchInput with synthetic mousemove/mousedown/mouseup events, and renders an
 *  on-screen arrow cursor when at least one movement binding is active.
 *
 *  Coordinate spaces:
 *    - S.mouseX / S.mouseY are kept in SCREEN pixels (0..screen.width, 0..screen.height).
 *    - Synthetic events carry pageX/pageY in screen pixels; RPG Maker's TouchInput
 *      converts them to game-canvas pixels via Graphics.pageToCanvasX/Y (which uses
 *      the GameCanvas bounding rect — the full screen — so the mapping is correct
 *      in both direct-screen and fit/scaled modes).
 *    - The cursor is drawn in screen space with an identity transform, so it
 *      visually sits exactly where TouchInput reports the pointer. */
import { isMouseMoveAction, isMouseClickAction, type KeyMap, type VirtualKey } from './keymap';
import type { LibraryEntry } from './game-library';
import { S } from './state';

declare const __DEBUG__: boolean;

/** Base cursor speed in screen pixels per frame (60 fps) at multiplier 1.0×.
 *  Doubled from 8→16 per request; the slider multiplier (0.3/unit) scales this further. */
const MOUSE_SPEED = 16;
/** Analog stick deadzone below which no motion is emitted. */
const STICK_DEADZONE = 0.25;
/** Analog stick deflection at which full speed is reached. */
const STICK_FULL_DEFLECTION = 0.9;
/** Click detection threshold for stick-driven clicks. */
const STICK_CLICK_THRESHOLD = 0.5;

const STICK_DIRS = ['lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight'] as const;
type StickDir = typeof STICK_DIRS[number];

/** Maps a stick direction to {axis index, sign} so a positive signed value means
 *  "pushed in the bound direction". Standard Web Gamepad axes: 0=LX, 1=LY, 2=RX, 3=RY. */
const STICK_AXIS: Record<StickDir, { axis: number; sign: number }> = {
        lUp: { axis: 1, sign: -1 }, lDown: { axis: 1, sign: 1 },
        lLeft: { axis: 0, sign: -1 }, lRight: { axis: 0, sign: 1 },
        rUp: { axis: 3, sign: -1 }, rDown: { axis: 3, sign: 1 },
        rLeft: { axis: 2, sign: -1 }, rRight: { axis: 2, sign: 1 },
};

/** Previous-frame click state for edge detection. */
let prevLmbDown = false;
let prevRmbDown = false;

/** Sub-pixel cursor position (screen-space floats) for smooth fractional movement.
 *  S.mouseX/mouseY hold the rounded integer position used for rendering + click hit-tests;
 *  these floats accumulate fractional deltas so low speeds don't produce uneven steps. */
let mouseXf = 0;
let mouseYf = 0;

/** Acceleration ramp 0..1 — ramps up while movement is active so the cursor eases in
 *  from 25% to 100% of full speed over ~0.13s, giving smoother motion. */
let moveRamp = 0;

/** Timestamp of the last poll (Date.now). Used for delta-time movement so cursor speed
 *  stays constant regardless of FPS — if the game stutters, the cursor doesn't slow down. */
let lastPollTime = 0;

/** True if the merged keymap has at least one button or stick bound to a mouse
 *  MOVEMENT action (mup/mdown/mleft/mright). This gates cursor visibility, per the
 *  requirement: render the cursor only when at least one movement binding exists. */
export function hasMouseMovementBinding(map: KeyMap): boolean {
        for (let i = 0; i < 16; i++) {
                if (isMouseMoveAction(map.buttons[i])) return true;
        }
        const sticks = map.sticks;
        if (sticks) {
                for (const dir of STICK_DIRS) {
                        const vkey = sticks[dir]?.vkey;
                        if (vkey && isMouseMoveAction(vkey)) return true;
                }
        }
        return false;
}

/** True if the merged keymap has at least one mouse CLICK binding (lmb/rmb). */
export function hasMouseClickBinding(map: KeyMap): boolean {
        for (let i = 0; i < 16; i++) {
                if (isMouseClickAction(map.buttons[i])) return true;
        }
        const sticks = map.sticks;
        if (sticks) {
                for (const dir of STICK_DIRS) {
                        const vkey = sticks[dir]?.vkey;
                        if (vkey && isMouseClickAction(vkey)) return true;
                }
        }
        return false;
}

/** Build a minimal synthetic MouseEvent-like object safe to pass to TouchInput's
 *  _onMouseMove / _onMouseDown / _onMouseUp handlers (they read pageX/pageY/button). */
function synthMouseEvent(pageX: number, pageY: number, button: number, type: string): any {
        return {
                type,
                pageX,
                pageY,
                clientX: pageX,
                clientY: pageY,
                screenX: pageX,
                screenY: pageY,
                button,
                buttons: button === 0 ? 1 : button === 2 ? 2 : 0,
                isTrusted: true,   // so games/plugins that gate on isTrusted accept synthetic events
                shiftKey: false,
                ctrlKey: false,
                altKey: false,
                metaKey: false,
                defaultPrevented: false,
                bubbles: false,
                cancelable: false,
                preventDefault() {},
                stopPropagation() {},
                stopImmediatePropagation() {},
                target: null,
                currentTarget: null,
        };
}

/** Dispatch a synthetic mouse event through `document` so the game's TouchInput
 *  listeners (registered via document.addEventListener in TouchInput._setupEventHandlers)
 *  fire — the same path real mouse/touch events take. This is more reliable than calling
 *  TouchInput methods directly because it goes through the game's own bound handlers.
 *  Creates a MouseEvent if the constructor is available, else a plain Event with pageX/pageY. */
function dispatchThroughDocument(type: 'mousemove' | 'mousedown' | 'mouseup', x: number, y: number, button: number): void {
        const doc = (globalThis as any).document;
        if (!doc || typeof doc.dispatchEvent !== 'function') return;
        let ev: any;
        try {
                const MouseEventCtor = (globalThis as any).MouseEvent;
                if (typeof MouseEventCtor === 'function') {
                        ev = new MouseEventCtor(type, {
                                bubbles: false, cancelable: false,
                                button, buttons: button === 0 ? 1 : button === 2 ? 2 : 0,
                                clientX: x, clientY: y, screenX: x, screenY: y,
                        });
                }
        } catch { /* fall through to plain Event */ }
        if (!ev) {
                try { ev = new Event(type, { bubbles: false, cancelable: false }); } catch { return; }
        }
        try {
                // MouseEvent's init dict doesn't include pageX/pageY in the spec; set them manually.
                ev.pageX = x; ev.pageY = y;
                if (ev.clientX === undefined) ev.clientX = x;
                if (ev.clientY === undefined) ev.clientY = y;
                if (ev.button === undefined) ev.button = button;
                if (ev.buttons === undefined) ev.buttons = button === 0 ? 1 : 2;
        } catch { /* expandos may be locked on some engines */ }
        try { doc.dispatchEvent(ev); } catch { /* best-effort */ }
}

/** Dispatch a mousemove (updates TouchInput._x/_y → hover). Routes through document
 *  first (the real event path), then also calls TouchInput._onMouseMove directly as a
 *  fallback. The double-call is idempotent (_x/_y just get re-set to the same value). */
function dispatchMove(touch: any, x: number, y: number): void {
        dispatchThroughDocument('mousemove', x, y, 0);
        if (touch && typeof touch._onMouseMove === 'function') {
                try { touch._onMouseMove(synthMouseEvent(x, y, 0, 'mousemove')); } catch { /* best-effort */ }
        } else if (touch && typeof touch._onMove === 'function') {
                const g = (globalThis as any).Graphics;
                let gx = x, gy = y;
                if (g && typeof g.pageToCanvasX === 'function') { try { gx = g.pageToCanvasX(x); gy = g.pageToCanvasY(y); } catch {} }
                try { touch._onMove(gx, gy); } catch { /* best-effort */ }
        }
}

/** Dispatch a mousedown (button 0 = LMB → trigger; button 2 = RMB → cancel). */
function dispatchDown(touch: any, x: number, y: number, button: number): void {
        dispatchThroughDocument('mousedown', x, y, button);
        if (touch && typeof touch._onMouseDown === 'function') {
                try { touch._onMouseDown(synthMouseEvent(x, y, button, 'mousedown')); } catch { /* best-effort */ }
        }
}

/** Dispatch a mouseup (button 0 → release trigger; button 2 → release cancel). */
function dispatchUp(touch: any, x: number, y: number, button: number): void {
        dispatchThroughDocument('mouseup', x, y, button);
        if (touch && typeof touch._onMouseUp === 'function') {
                try { touch._onMouseUp(synthMouseEvent(x, y, button, 'mouseup')); } catch { /* best-effort */ }
        }
}

/** Resolve the effective per-button VirtualKey, merging per-game + global (per-game wins). */
function mergedButtonKey(per: KeyMap | undefined, base: KeyMap, i: number): VirtualKey {
        return (per?.buttons?.[i] ?? base.buttons[i]) as VirtualKey;
}

/** Resolve the effective stick binding for a direction, merging per-game + global. */
function mergedStickBinding(per: KeyMap | undefined, base: KeyMap, dir: StickDir) {
        return per?.sticks?.[dir] ?? base.sticks?.[dir];
}

/** Read the signed stick deflection in the bound direction (positive = pushed). */
function signedStick(axes: number[] | readonly number[], dir: StickDir): number {
        const { axis, sign } = STICK_AXIS[dir];
        const raw = Number(axes[axis]) || 0;
        return raw * sign;
}

/** Per-frame: read the gamepad, move the cursor, and fire synthetic mouse events.
 *  Suppressed by the caller during save/load scenes and while the pause menu is open.
 *  Speed: base MOUSE_SPEED (16) × slider multiplier (0.3/unit) × acceleration ramp.
 *  The slider default (5) → multiplier 1.5 → 24 px/frame at 60fps full ramp. Movement
 *  is DELTA-TIME based (speed is in px/sec, multiplied by the frame delta) so the cursor
 *  moves at the same rate regardless of FPS — if the game stutters to 30fps, each frame
 *  moves twice as far, keeping the per-second speed constant. Clamp dt to 100ms max so a
 *  long freeze doesn't send the cursor flying. Movement eases in from 25%→100% over
 *  ~0.13s; sub-pixel accumulation prevents uneven steps at fractional speeds.
 *  Events are dispatched through `document` (the real event path the game's TouchInput
 *  listeners use) plus a direct TouchInput method call fallback — so hover + clicks
 *  reliably reach RPG Maker MV's windows and sprites. */
export function pollMouseInput(currentEntry: LibraryEntry | null, globalKeymap: KeyMap): void {
        const runtime = globalThis as any;
        const touch = runtime.TouchInput;
        if (!touch) return;
        const per = currentEntry?.keymap;
        const base = globalKeymap;

        const pad = (navigator as any).getGamepads?.()?.[0];
        if (!pad) return;
        const buttons = pad.buttons;
        if (!buttons) return;
        const axes = pad.axes || [];

        const sw = (screen as any).width || 1280;
        const sh = (screen as any).height || 720;

        // Delta time: convert per-frame speed to per-second so FPS doesn't affect cursor speed.
        const now = Date.now();
        const dt = lastPollTime > 0 ? Math.min(0.1, (now - lastPollTime) / 1000) : 1 / 60;
        lastPollTime = now;

        // Speed multiplier from the slider: 0.3 per unit (base 1.0× ≈ slider 3.3).
        // ×60 converts px/frame@60fps → px/sec so delta-time scaling keeps speed constant.
        const speedMul = S.mouseSpeed * 0.3;
        const buttonSpeed = MOUSE_SPEED * speedMul * 60;
        const stickSpeed = MOUSE_SPEED * 1.5 * speedMul * 60;

        // --- Movement (digital buttons + analog sticks) ---
        let dx = 0, dy = 0;

        for (let i = 0; i < 16; i++) {
                const key = mergedButtonKey(per, base, i);
                if (!isMouseMoveAction(key)) continue;
                if (!buttons[i]?.pressed) continue;
                if (key === 'mup') dy -= buttonSpeed * dt;
                else if (key === 'mdown') dy += buttonSpeed * dt;
                else if (key === 'mleft') dx -= buttonSpeed * dt;
                else if (key === 'mright') dx += buttonSpeed * dt;
        }

        for (const dir of STICK_DIRS) {
                const binding = mergedStickBinding(per, base, dir);
                const vkey = binding?.vkey;
                if (!vkey || !isMouseMoveAction(vkey)) continue;
                const signed = signedStick(axes, dir);
                if (signed <= STICK_DEADZONE) continue;
                // Analog speed: ramp from deadzone to full deflection → 0..stickSpeed.
                const t = Math.min(1, (signed - STICK_DEADZONE) / (STICK_FULL_DEFLECTION - STICK_DEADZONE));
                const mag = t * stickSpeed * dt;
                if (vkey === 'mup') dy -= mag;
                else if (vkey === 'mdown') dy += mag;
                else if (vkey === 'mleft') dx -= mag;
                else if (vkey === 'mright') dx += mag;
        }

        // Acceleration ramp (delta-time): ease in from 25% → 100% over ~0.13s while
        // moving; decays over ~0.08s when idle so a brief pause doesn't leave it "hot".
        const moving = dx !== 0 || dy !== 0;
        if (moving) moveRamp = Math.min(1, moveRamp + dt * 8);
        else moveRamp = Math.max(0, moveRamp - dt * 12);
        const rampMul = 0.25 + 0.75 * moveRamp;
        dx *= rampMul;
        dy *= rampMul;

        // Sub-pixel accumulation: keep a float position so fractional speeds produce
        // evenly distributed integer steps (no 1/2/1/2 jitter). Sync if cursor was reset.
        if (Math.abs(mouseXf - S.mouseX) > 2) mouseXf = S.mouseX;
        if (Math.abs(mouseYf - S.mouseY) > 2) mouseYf = S.mouseY;
        if (dx !== 0 || dy !== 0) {
                mouseXf = Math.max(0, Math.min(sw - 1, mouseXf + dx));
                mouseYf = Math.max(0, Math.min(sh - 1, mouseYf + dy));
                S.mouseX = Math.round(mouseXf);
                S.mouseY = Math.round(mouseYf);
        }
        // Always emit a mousemove so TouchInput._x/_y track the cursor even when idle;
        // RPG Maker windows use these for hover highlighting.
        dispatchMove(touch, S.mouseX, S.mouseY);

        // --- Clicks (LMB / RMB) from buttons + sticks ---
        let lmbDown = false, rmbDown = false;
        for (let i = 0; i < 16; i++) {
                const key = mergedButtonKey(per, base, i);
                if (key === 'lmb' && buttons[i]?.pressed) lmbDown = true;
                else if (key === 'rmb' && buttons[i]?.pressed) rmbDown = true;
        }
        for (const dir of STICK_DIRS) {
                const binding = mergedStickBinding(per, base, dir);
                const vkey = binding?.vkey;
                if (!vkey) continue;
                if (signedStick(axes, dir) < STICK_CLICK_THRESHOLD) continue;
                if (vkey === 'lmb') lmbDown = true;
                else if (vkey === 'rmb') rmbDown = true;
        }

        S.mouseLmbDown = lmbDown;
        S.mouseRmbDown = rmbDown;

        // Edge-triggered mousedown / mouseup so a single press = one click.
        if (lmbDown && !prevLmbDown) dispatchDown(touch, S.mouseX, S.mouseY, 0);
        if (!lmbDown && prevLmbDown) dispatchUp(touch, S.mouseX, S.mouseY, 0);
        if (rmbDown && !prevRmbDown) dispatchDown(touch, S.mouseX, S.mouseY, 2);
        if (!rmbDown && prevRmbDown) dispatchUp(touch, S.mouseX, S.mouseY, 2);

        prevLmbDown = lmbDown;
        prevRmbDown = rmbDown;
}

/** Clear held-button state so a scene change doesn't leave a stuck mousedown.
 *  Fires mouseup for any button that was down. */
export function clearMouseButtons(): void {
        const runtime = globalThis as any;
        const touch = runtime.TouchInput;
        if (touch) {
                if (prevLmbDown) dispatchUp(touch, S.mouseX, S.mouseY, 0);
                if (prevRmbDown) dispatchUp(touch, S.mouseX, S.mouseY, 2);
        }
        prevLmbDown = false;
        prevRmbDown = false;
        S.mouseLmbDown = false;
        S.mouseRmbDown = false;
}

/** Center the cursor on the physical screen. Called at startup and on game start. */
export function resetMouseCursor(): void {
        const sw = (typeof screen !== 'undefined' && (screen as any).width) || 1280;
        const sh = (typeof screen !== 'undefined' && (screen as any).height) || 720;
        S.mouseX = Math.floor(sw / 2);
        S.mouseY = Math.floor(sh / 2);
        mouseXf = S.mouseX;
        mouseYf = S.mouseY;
        moveRamp = 0;
        lastPollTime = 0;
        S.mouseLmbDown = false;
        S.mouseRmbDown = false;
        prevLmbDown = false;
        prevRmbDown = false;
}

/** Draw the arrow cursor on top of the rendered game frame. Screen-space, identity
 *  transform, source-over. The hotspot (tip) sits at (S.mouseX, S.mouseY).
 *  A subtle ring is drawn around the tip while a click is held. */
export function renderMouseCursor(ctx: CanvasRenderingContext2D | null): void {
        if (!ctx) return;
        if (!S.mouseVisible) return;
        if (S.phase !== 'game') return;
        const x = Math.round(S.mouseX);
        const y = Math.round(S.mouseY);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        // Classic arrow silhouette with the hotspot at the tip (0,0).
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + 22);
        ctx.lineTo(x + 6, y + 16);
        ctx.lineTo(x + 11, y + 24);
        ctx.lineTo(x + 14, y + 22);
        ctx.lineTo(x + 9, y + 14);
        ctx.lineTo(x + 16, y + 14);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.fill();
        ctx.stroke();
        // Click feedback: green ring for LMB, orange ring for RMB.
        if (S.mouseLmbDown || S.mouseRmbDown) {
                ctx.beginPath();
                ctx.arc(x, y, 7, 0, Math.PI * 2);
                ctx.strokeStyle = S.mouseRmbDown ? '#f0883e' : '#3fb950';
                ctx.lineWidth = 2;
                ctx.stroke();
        }
        ctx.restore();
}
