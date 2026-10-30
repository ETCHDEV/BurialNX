import { S } from './state';
import { log } from './log';
import { endGameSession } from './game-session';
import { resetDiagnostics } from './diagnostics';
import { removeBeforeUnloadListener, removeAllSessionListeners } from './error-handling';
import { BURIALNX_NRO_PATH, BURIALNX_DEBUG_NRO_PATH } from './forwarder';

declare const __DEBUG__: boolean;

const __SwitchGlobal: any = (globalThis as any).Switch;
export const realExit: ((() => void) | null) =
        typeof __SwitchGlobal?.exit === 'function' ? __SwitchGlobal.exit.bind(__SwitchGlobal) : null;

/** Stop the running game and release audio, frame loop, image buffers, realm globals, then GC. */
export function teardownGame() {
        try { S.runtime.AudioManager?.stopBgm?.(); } catch { /* best-effort */ }
        try { S.runtime.AudioManager?.stopBgs?.(); } catch { /* best-effort */ }
        try { S.runtime.AudioManager?.stopMe?.(); } catch { /* best-effort */ }
        try { S.runtime.AudioManager?.stopSe?.(); } catch { /* best-effort */ }
        try {
                const manager = S.runtime.SceneManager;
                if (manager) {
                        try { manager._stopped = true; } catch { /* best-effort */ }
                        try { manager._scene = null; } catch { /* best-effort */ }
                        try { manager._nextScene = null; } catch { /* best-effort */ }
                        for (const name of [
                                'update', 'updateMain', 'requestUpdate', 'renderScene',
                                'tickStart', 'tickEnd', 'updateInputData', 'updateScene',
                                'changeScene', 'catchException', 'stop', 'terminate',
                        ]) {
                                try { manager[name] = function () { /* retired game */ }; } catch { /* best-effort */ }
                        }
                }
        } catch { /* best-effort */ }
        try { S.runtime.ImageManager?._imageCache?.clear?.(); } catch { /* best-effort */ }
        try { S.runtime.ImageManager?._cache?.clear?.(); } catch { /* best-effort */ }
        try { S.runtime.ImageManager?.clear?.(); } catch { /* best-effort */ }
        try { if (Array.isArray(S.runtime.Bitmap?._reuseImages)) S.runtime.Bitmap._reuseImages.length = 0; } catch { /* best-effort */ }
        S.gameStopped = true;
        endGameSession();
        resetDiagnostics();
        S.host = undefined;
        S.mapPrefetch = undefined;
        S.languageEntries = [];
        S.activeLanguageCode = '';
        try {
                const before = __DEBUG__ ? (Switch as any).memoryUsage?.() : undefined;
                if (typeof S.runtime.gc === 'function') S.runtime.gc();
                if (before) {
                        const after = (Switch as any).memoryUsage?.();
                        if (after) log(`_teardown: heap ${(before.usedHeapSize / 1048576).toFixed(1)} MiB -> ${(after.usedHeapSize / 1048576).toFixed(1)} MiB, native malloc ${(after.mallocedMemory / 1048576).toFixed(1)} MiB`);
                }
        } catch { /* best-effort */ }
}

/** Remove the stale v0.1.6–0.1.8 .fwd-exit-flag marker file if present. */
export function removeLegacyExitFlagFile(): void {
        try {
                const SwitchAny = (Switch as any);
                const remove = SwitchAny?.removeSync || SwitchAny?.unlinkSync;
                if (typeof remove === 'function') { try { remove.call(SwitchAny, 'sdmc:/switch/burialnx/.fwd-exit-flag'); } catch { /* not present */ } }
        } catch { /* best-effort */ }
}

/** Chain-load burialnx.nro without --game so the library grid shows in a fresh process. */
export function chainToLibrary(): void {
        const SwitchAny = (Switch as any);
        let nroPath: string = BURIALNX_NRO_PATH;
        try {
                const argv = (Switch as any).argv as readonly string[] | undefined;
                if (Array.isArray(argv) && argv.length > 0 && typeof argv[0] === 'string' && /\.nro$/i.test(argv[0])) {
                        nroPath = argv[0];
                }
        } catch { /* argv unavailable — keep hardcoded default */ }
        let app: any;
        try { app = new SwitchAny.Application(nroPath); }
        catch (e1) {
                log(`_exit: Application(${nroPath}) failed: ${e1 instanceof Error ? e1.message : String(e1)}`);
                nroPath = BURIALNX_DEBUG_NRO_PATH;
                app = new SwitchAny.Application(nroPath);
        }
        log(`_exit: chainToLibrary app.launch(${nroPath}) [no --game]`);
        S.allowExit = true;
        app.launch(nroPath);
}

/** Quit BurialNX: consumes the exit-behavior flag and either chain-loads or fully exits. */
export function quitApp() {
        const behavior = S.exitBehavior;
        S.exitBehavior = 'shutdown';
        log(`_exit: quitApp(${behavior}), forwarderTargetId=${S.forwarderTargetId || 'null'}, isBakedForwarder=${S.isBakedForwarder}`);
        try { teardownGame(); } catch (e) { log(`_exit: teardown threw: ${e instanceof Error ? e.message : String(e)}`); }
        S.forwarderTargetId = null;
        S.isBakedForwarder = false;
        S.phase = 'library';
        S.exitNoticeArmed = false;
        S.plusHoldStart = 0;
        if (behavior === 'restart') {
                try {
                        chainToLibrary();
                } catch (e) {
                        log(`_exit: chainToLibrary FAILED: ${e instanceof Error ? e.message : String(e)}`);
                        removeBeforeUnloadListener();
                        if (realExit) { S.allowExit = true; try { realExit(); } catch { /* best-effort */ } }
                }
                return;
        }
        log('_exit: calling Switch.exit()');
        if (realExit) {
                S.allowExit = true;
                removeBeforeUnloadListener();
                setTimeout(() => {
                        removeAllSessionListeners();
                        try { realExit(); } catch (e) { log(`_exit: Switch.exit threw: ${e instanceof Error ? e.message : String(e)}`); }
                }, 0);
        }
}
