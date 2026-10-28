// === Error handling + session lifetime listeners =====================
// Extracted from main.ts. fail()/failRequest() turn any error into the
// loader's recoverable red error screen (or just log it for residue from
// a retired game). The three session-lifetime listeners (error,
// unhandledrejection, beforeunload) are registered ONCE on globalThis and
// removeBeforeUnloadListener/removeAllSessionListeners are called by the
// quit path to prevent infinite recursion during Switch.exit().
//
// fail() reads/writes the shared `S` state: phase, message, runtime.
// The listeners close over `S.allowExit` and `fail()`.

import { S } from './state';
import { log, snapshotRuntimeLog } from './log';

declare const __DEBUG__: boolean;

export function fail(error: unknown, async = false) {
	const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
	log(`FAILURE: ${detail}`);
	if (S.phase === 'error') return;
	// Leftover asynchronous callbacks of a retired game (timers, audio
	// promises, late image loads) can still throw after the user quit the
	// app or returned to the error screen. Those errors can no longer be
	// acted on and must not hijack the loader with a red error screen;
	// log them and move on.
	if (async && S.gameStopped) { log('Suppressed asynchronous error from the stopped game.'); return; }
	snapshotRuntimeLog();
	S.message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	S.phase = 'error';
	// Stop game frames from painting over the loader's diagnostic screen.
	try { S.runtime.SceneManager?.stop?.(); } catch { /* keep the original error */ }
}

export function failRequest(error: Error, responseText: string) {
	// Request completions are asynchronous by nature; when they arrive from
	// a game that was already stopped, fail() only logs them.
	fail(error, true);
	if (__DEBUG__ && responseText && responseText.length <= 2 * 1024 * 1024) try {
		void crypto.subtle.digest('SHA-256', new TextEncoder().encode(responseText)).then((digest) => {
			const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
			log(`Failed response UTF-8 SHA-256: ${hash}`);
		}).catch((reason) => log(`Could not fingerprint failed response: ${String(reason)}`));
	} catch (reason) { log(`Could not fingerprint failed response: ${String(reason)}`); }
}

// === Session lifetime listeners ========================================
// The loader registers these three listeners ONCE on the process-lifetime
// globals. The beforeunload guard ALWAYS prevents the default so the Plus (+)
// button never exits on its own: quitting goes through the pause menu's
// "Quit BurialNX" entry or the double-press confirmation (quitApp sets
// allowExit before calling the real exit). The error/unhandledrejection
// listeners cancel the dispatched events: nx.js otherwise terminates the
// whole process ("Press + to exit" over a frozen screen) for ANY uncaught
// exception or floating promise — the loader shows its own recoverable
// error screen instead.
const sessionErrorListener = ((event: any) => {
	// Image 'error' events (fired when a cover PNG fails to decode) bubble
	// up to globalThis. They are not ErrorEvent and don't have .error or
	// .message. loadCoverImage already handles them via its own 'error'
	// listener (setting entry.failed and drawing a placeholder). Don't
	// double-handle here — that would show a spurious red error panel
	// every time a malformed cover is loaded.
	if (!event) return;
	if (event.error || event.message) {
		const error: unknown = event.error instanceof Error || typeof event.error === 'string' ? event.error : typeof event.message === 'string' ? event.message : null;
		if (error !== null) {
			// nx.js terminates the whole process for an uncaught
			// exception ("Press + to exit" over a frozen screen)
			// unless the dispatched 'error' event is canceled. Take
			// responsibility for the outcome instead: show our own
			// recoverable error screen — or just log it when the
			// error is residue of an already retired session.
			try { event.preventDefault?.(); } catch { /* best-effort */ }
			fail(error, true);
		}
	}
}) as EventListener;
const sessionRejectionListener = ((event: PromiseRejectionEvent) => {
	// Unhandled rejections are exactly as fatal as uncaught exceptions in
	// nx.js — and games are full of floating promises. Cancel the default
	// and let fail() decide whether the reason deserves a screen.
	try { event.preventDefault?.(); } catch { /* best-effort */ }
	fail(event.reason, true);
}) as EventListener;
// nx.js checks Plus (+) every frame and dispatches beforeunload when it is
// held; if the event is not canceled the runtime exits. The guard ALWAYS
// prevents the default so + never exits on its own: quitting goes through
// the pause menu or the double-press confirmation (quitApp sets allowExit
// before calling the real exit).
const sessionBeforeUnloadGuard = ((event: Event) => {
	if (!S.allowExit) event.preventDefault();
}) as EventListener;

export function registerSessionListeners() {
	try { globalThis.addEventListener('error', sessionErrorListener); } catch { /* best-effort */ }
	try { globalThis.addEventListener('unhandledrejection', sessionRejectionListener); } catch { /* best-effort */ }
	try { globalThis.addEventListener('beforeunload', sessionBeforeUnloadGuard); } catch { /* best-effort */ }
}

/** Remove the beforeunload listener. Called BEFORE Switch.exit() to prevent
 *  nx.js from dispatching beforeunload during the exit process. The Atmosphere
 *  crash report showed infinite recursion (stack overflow) during exit: the
 *  repeating stack pattern (C++ → V8 → C++ → V8 → ...) indicates that
 *  Switch.exit() dispatches beforeunload, and the handler's execution triggers
 *  another beforeunload (or similar event), creating an unbreakable recursive
 *  loop that overflows the 1 MB stack. Removing ONLY the beforeunload listener
 *  breaks the cycle — the error and unhandledrejection listeners are KEPT so
 *  that residual errors from the retired game are still suppressed (the quit
 *  path test verifies this). Those listeners don't cause recursion because
 *  fail() has an early-return guard (if (phase === 'error') return). */
export function removeBeforeUnloadListener() {
	try { globalThis.removeEventListener('beforeunload', sessionBeforeUnloadGuard); } catch { /* best-effort */ }
}

/** Remove ALL session event listeners (error, unhandledrejection, beforeunload).
 *  Called INSIDE the setTimeout callback, right before Switch.exit() — so that
 *  Switch.exit() can't dispatch ANY events to our handlers. The error and
 *  unhandledrejection listeners are kept active between quitApp returning and
 *  the setTimeout firing (so residual errors are still suppressed), then
 *  removed inside the callback. */
export function removeAllSessionListeners() {
	try { globalThis.removeEventListener('error', sessionErrorListener); } catch { /* best-effort */ }
	try { globalThis.removeEventListener('unhandledrejection', sessionRejectionListener); } catch { /* best-effort */ }
	try { globalThis.removeEventListener('beforeunload', sessionBeforeUnloadGuard); } catch { /* best-effort */ }
}
