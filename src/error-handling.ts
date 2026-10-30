import { S } from './state';
import { log, snapshotRuntimeLog } from './log';

declare const __DEBUG__: boolean;

/** Turn any error into the loader's recoverable red error screen (or just log it for residue from a retired game). */
export function fail(error: unknown, async = false) {
	const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
	log(`FAILURE: ${detail}`);
	if (S.phase === 'error') return;
	if (async && S.gameStopped) { log('Suppressed asynchronous error from the stopped game.'); return; }
	snapshotRuntimeLog();
	S.message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	S.phase = 'error';
	try { S.runtime.SceneManager?.stop?.(); } catch { /* keep the original error */ }
}

/** Report a failed request: fail(async) + optional SHA-256 fingerprint of the response in debug builds. */
export function failRequest(error: Error, responseText: string) {
	fail(error, true);
	if (__DEBUG__ && responseText && responseText.length <= 2 * 1024 * 1024) try {
		void crypto.subtle.digest('SHA-256', new TextEncoder().encode(responseText)).then((digest) => {
			const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
			log(`Failed response UTF-8 SHA-256: ${hash}`);
		}).catch((reason) => log(`Could not fingerprint failed response: ${String(reason)}`));
	} catch (reason) { log(`Could not fingerprint failed response: ${String(reason)}`); }
}

const sessionErrorListener = ((event: any) => {
	if (!event) return;
	if (event.error || event.message) {
		const error: unknown = event.error instanceof Error || typeof event.error === 'string' ? event.error : typeof event.message === 'string' ? event.message : null;
		if (error !== null) {
			try { event.preventDefault?.(); } catch { /* best-effort */ }
			fail(error, true);
		}
	}
}) as EventListener;

const sessionRejectionListener = ((event: PromiseRejectionEvent) => {
	try { event.preventDefault?.(); } catch { /* best-effort */ }
	fail(event.reason, true);
}) as EventListener;

const sessionBeforeUnloadGuard = ((event: Event) => {
	if (!S.allowExit) event.preventDefault();
}) as EventListener;

/** Register the three process-lifetime session listeners once on globalThis. */
export function registerSessionListeners() {
	try { globalThis.addEventListener('error', sessionErrorListener); } catch { /* best-effort */ }
	try { globalThis.addEventListener('unhandledrejection', sessionRejectionListener); } catch { /* best-effort */ }
	try { globalThis.addEventListener('beforeunload', sessionBeforeUnloadGuard); } catch { /* best-effort */ }
}

/** Remove the beforeunload listener before Switch.exit() to prevent infinite recursion. */
export function removeBeforeUnloadListener() {
	try { globalThis.removeEventListener('beforeunload', sessionBeforeUnloadGuard); } catch { /* best-effort */ }
}

/** Remove all session listeners right before Switch.exit() so it can't dispatch to our handlers. */
export function removeAllSessionListeners() {
	try { globalThis.removeEventListener('error', sessionErrorListener); } catch { /* best-effort */ }
	try { globalThis.removeEventListener('unhandledrejection', sessionRejectionListener); } catch { /* best-effort */ }
	try { globalThis.removeEventListener('beforeunload', sessionBeforeUnloadGuard); } catch { /* best-effort */ }
}
