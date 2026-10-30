import { S } from './state';
import { log } from './log';
import { isInSaveLoadScene } from './sleep-recovery';

let __nativeConsumeSleepWake: (() => boolean) | null | undefined;
let __nativeProbed = false;
function nativeConsumeSleepWake(): boolean {
        if (!__nativeProbed) {
                __nativeProbed = true;
                try {
                        const sw = (globalThis as any).Switch;
                        const fn = sw?.appletConsumeSleepWake;
                        __nativeConsumeSleepWake = typeof fn === 'function' ? fn.bind(sw) : null;
                } catch {
                        __nativeConsumeSleepWake = null;
                }
                log(`_wake: native appletConsumeSleepWake ${__nativeConsumeSleepWake ? 'available (deterministic detection active)' : 'unavailable — using steady-frame heuristic fallback'}`);
        }
        return __nativeConsumeSleepWake ? __nativeConsumeSleepWake() : false;
}

export const STEADY_GAP_MS = 200;
export const HICCUP_GAP_MS = 600;
export const WAKE_GAP_MS = 1000;
export const STEADY_FRAMES_TO_ARM = 60;
export const SAVELOAD_WAKE_GAP_MS = 6000;

const ARMABLE_PHASES = new Set<string>([
        'game', 'notice',
        'library', 'game-options', 'picker',
        'save-choice', 'game-save-choice',
        'rename', 'rename-choice', 'rename-kb', 'add-game-name',
]);

const NO_RELOAD_PHASES = new Set<string>(['forwarder-building']);

let __lastPhase = '';
let __lastInSaveLoad = false;

/** Reset the steady-frame arming state; called on phase transitions. */
export function resetWakeArming(): void {
        S.wakeSteadyFrames = 0;
        S.wakeArmed = false;
}

/** Returns true if a sleep→wake was detected THIS frame; called at the top of frame(). */
export function detectWakeThisFrame(wallNow: number): boolean {
        const prev = S.lastFrameWall;
        S.lastFrameWall = wallNow;

        const phase = S.phase;
        if (phase !== __lastPhase) {
                __lastPhase = phase;
                resetWakeArming();
        }

        if (S.wakeNativeEnabled !== false) {
                let woke = false;
                try { woke = nativeConsumeSleepWake(); }
                catch (e) {
                        S.wakeNativeEnabled = false;
                        log(`_wake: native appletConsumeSleepWake threw — disabling native path: ${e instanceof Error ? e.message : String(e)}`);
                }
                if (woke) {
                        if (NO_RELOAD_PHASES.has(phase)) {
                                log(`_wake: native wake ignored during '${phase}' (in-progress write protected)`);
                                return false;
                        }
                        log(`_wake: native applet sleep→wake signal (phase=${phase})`);
                        resetWakeArming();
                        return true;
                }
        }

        if (!prev) return false;
        const gap = wallNow - prev;

        const inSaveLoad = isInSaveLoadScene();
        if (inSaveLoad !== __lastInSaveLoad) {
                __lastInSaveLoad = inSaveLoad;
                resetWakeArming();
                if (inSaveLoad) log(`_wake: entered save/load scene — arming reset (slot-list refresh gap will not false-trigger)`);
        }

        if ((S.wakeArmed && gap > WAKE_GAP_MS) || (inSaveLoad && gap > SAVELOAD_WAKE_GAP_MS)) {
                log(`_wake: heuristic sleep→wake (gap=${gap}ms, phase=${phase}, armed=${S.wakeArmed}, saveLoad=${inSaveLoad})`);
                resetWakeArming();
                return true;
        }

        if (!ARMABLE_PHASES.has(phase)) {
                if (S.wakeSteadyFrames !== 0) S.wakeSteadyFrames = 0;
                if (S.wakeArmed) S.wakeArmed = false;
        } else if (gap < STEADY_GAP_MS) {
                S.wakeSteadyFrames++;
                if (!S.wakeArmed && S.wakeSteadyFrames >= STEADY_FRAMES_TO_ARM) {
                        S.wakeArmed = true;
                }
        } else {
                S.wakeSteadyFrames = 0;
                S.wakeArmed = false;
        }

        return false;
}

/** Whether the native applet sleep/wake signal is available in this build. */
export function nativeSleepWakeAvailable(): boolean {
        if (S.wakeNativeEnabled === false) return false;
        if (!__nativeProbed) {
                try { nativeConsumeSleepWake(); } catch { /* disabled inside */ }
        }
        return !!__nativeConsumeSleepWake;
}
