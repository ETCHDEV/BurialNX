// === Game lifecycle: teardown + quit + chain-load =====================
// Extracted from main.ts. Four functions and one module-level constant
// that own the end-of-game / end-of-process transitions:
//
//   teardownGame()    — stops game audio, retires the frame loop, drops
//                       image caches, undoes the realm snapshot, runs GC.
//   removeLegacyExitFlagFile() — one-time cleanup of the v0.1.6–0.1.8
//                                .fwd-exit-flag marker file.
//   chainToLibrary()  — chain-loads burialnx.nro without --game so the
//                       library grid shows in a fresh process.
//   quitApp()         — consumes the exit behavior flag ('shutdown' or
//                       'restart') and either exits or chain-loads.
//   realExit          — Switch.exit() bound to the Switch global, captured
//                       once at module load so the quit path can defer it
//                       via setTimeout and still call the native exit.
//
// Reads/writes the shared `S` state. Calls into the session-listener
// removers (removeBeforeUnloadListener / removeAllSessionListeners) which
// live in src/error-handling.ts.

import { S } from './state';
import { log } from './log';
import { endGameSession } from './game-session';
import { resetDiagnostics } from './diagnostics';
import { removeBeforeUnloadListener, removeAllSessionListeners } from './error-handling';
import { BURIALNX_NRO_PATH, BURIALNX_DEBUG_NRO_PATH } from './forwarder';

declare const __DEBUG__: boolean;

// Captured at module load so the quit path can defer the native exit via
// setTimeout and still call the real Switch.exit (not a property stub).
// Uses globalThis.Switch (not the bare `Switch` identifier) so this module
// is safe to import in environments where Switch is not defined (the Node
// test harness bundles several src/ modules that transitively reach this
// line). globalThis.Switch is undefined in those envs -> realExit = null,
// no ReferenceError.
const __SwitchGlobal: any = (globalThis as any).Switch;
export const realExit: ((() => void) | null) =
	typeof __SwitchGlobal?.exit === 'function' ? __SwitchGlobal.exit.bind(__SwitchGlobal) : null;

/** Completely stop the running game and release everything it holds: game
 *  audio, the requestAnimationFrame loop, decoded image/bitmap pixel
 *  buffers, every global the game or its host added to this realm (see the
 *  game session snapshot above), and our host references. A final GC pass
 *  returns the freed native buffers to the heap right away. Used by the
 *  quit path ("Quit BurialNX" and B on the error screen) before Switch.exit(),
 *  so no part of a stopped game can keep running, keep playing sound, or
 *  hold on to memory while the runtime tears the process down. */
export function teardownGame() {
	// Stop all game audio first so nothing keeps playing over the loader.
	try { S.runtime.AudioManager?.stopBgm?.(); } catch { /* best-effort */ }
	try { S.runtime.AudioManager?.stopBgs?.(); } catch { /* best-effort */ }
	try { S.runtime.AudioManager?.stopMe?.(); } catch { /* best-effort */ }
	try { S.runtime.AudioManager?.stopSe?.(); } catch { /* best-effort */ }
	// Permanently retire the game's frame loop. Just setting _stopped (or
	// the gameStopped flag) leaves the already-queued rAF callback alive:
	// it re-arms itself every frame and would come back to life — drawing
	// the retired scene on the physical screen or crashing on stale state —
	// as soon as the next launch clears gameStopped. Replacing the loop
	// entry points with no-ops ends the chain for good; the next launch
	// builds a fresh SceneManager from the game's own scripts.
	try {
		const manager = S.runtime.SceneManager;
		if (manager) {
			try { manager._stopped = true; } catch { /* best-effort */ }
			// Drop scene references: scenes hold sprites, and
			// sprites hold native bitmap buffers.
			try { manager._scene = null; } catch { /* best-effort */ }
			try { manager._nextScene = null; } catch { /* best-effort */ }
			// Retire EVERY method the game's update loop can reach,
			// not just the four obvious ones. A frame that was
			// already dequeued for the current vsync batch still
			// runs the ORIGINAL bound update() after this function
			// returns: its try block calls tickStart/tickEnd →
			// Graphics.tickStart/End() and its catch calls
			// catchException → Graphics.printError() — with the
			// game globals deleted, both threw escaping
			// ReferenceErrors and killed the process (hardware
			// crash "Graphics is not defined"). Stubbing the full
			// reachable set turns even that late callback into a
			// complete no-op: the game's own catch swallows the
			// first error (e.g. "Utils is not defined") and the
			// stubbed catchException ends the chain for good.
			for (const name of [
				'update', 'updateMain', 'requestUpdate', 'renderScene',
				'tickStart', 'tickEnd', 'updateInputData', 'updateScene',
				'changeScene', 'catchException', 'stop', 'terminate',
			]) {
				try { manager[name] = function () { /* retired game */ }; } catch { /* best-effort */ }
			}
		}
	} catch { /* best-effort */ }
	// Release decoded image and bitmap pixel buffers held by the game's caches.
	try { S.runtime.ImageManager?._imageCache?.clear?.(); } catch { /* best-effort */ }
	try { S.runtime.ImageManager?._cache?.clear?.(); } catch { /* best-effort */ }
	try { S.runtime.ImageManager?.clear?.(); } catch { /* best-effort */ }
	try { if (Array.isArray(S.runtime.Bitmap?._reuseImages)) S.runtime.Bitmap._reuseImages.length = 0; } catch { /* best-effort */ }
	S.gameStopped = true;
	// Undo everything the game session added to this realm (globals, host
	// replacements, game fonts, pending game timers) so the data above is no
	// longer reachable from anywhere and the GC below can actually free it.
	endGameSession();
	// Drop the diagnostic scene references too — they would pin the last
	// observed scene (and its whole sprite/bitmap graph) in memory.
	resetDiagnostics();
	S.host = undefined;
	S.mapPrefetch = undefined;
	// Reset language state so a subsequent launch scans the new game's packs.
	S.languageEntries = [];
	S.activeLanguageCode = '';
	// Ask V8 for a full collection so the released buffers are actually
	// returned to the native heap instead of lingering until the next
	// launch needs the memory.
	try {
		const before = __DEBUG__ ? (Switch as any).memoryUsage?.() : undefined;
		if (typeof S.runtime.gc === 'function') S.runtime.gc();
		if (before) {
			const after = (Switch as any).memoryUsage?.();
			if (after) log(`_teardown: heap ${(before.usedHeapSize / 1048576).toFixed(1)} MiB -> ${(after.usedHeapSize / 1048576).toFixed(1)} MiB, native malloc ${(after.mallocedMemory / 1048576).toFixed(1)} MiB`);
		}
	} catch { /* best-effort */ }
}

// One-time cleanup: versions 0.1.6–0.1.8 wrote a .fwd-exit-flag marker file
// to the SD card for their boot-time re-chain detection. Nothing reads it
// anymore — remove it when present so no stale artifact from those builds
// survives on the card.
export function removeLegacyExitFlagFile(): void {
	try {
		const SwitchAny = (Switch as any);
		const remove = SwitchAny?.removeSync || SwitchAny?.unlinkSync;
		if (typeof remove === 'function') { try { remove.call(SwitchAny, 'sdmc:/switch/burialnx/.fwd-exit-flag'); } catch { /* not present */ } }
	} catch { /* best-effort */ }
}

/** Chain-load burialnx.nro WITHOUT --game so the library grid shows.
 *  Sets a NEW envSetNextLoad (overwriting the stale forwarder one) and
 *  stops the event loop — the process exits through the regular teardown
 *  path and the loader chain-loads burialnx into a FRESH process, whose
 *  exitBehavior starts at 'shutdown' again (see the flag lifecycle above).
 *  If the chain fails (both NRO paths missing), throws so the caller can
 *  fall back to Switch.exit().
 *
 *  CRITICAL: the FIRST argument to app.launch() MUST be the burialnx.nro
 *  path — nx.js's resolve_entrypoint treats argv[1] as a file path (a
 *  ".nro" suffix means "bootstrap this NRO"; anything else is opened as a
 *  .js file and the chain dies with "No such file or directory").
 *
 *  NOTE: app.launch() RETURNS normally after a successful chain (nx.js
 *  source/ns.cc — it only calls envSetNextLoad + stops the event loop;
 *  the process exits when the current script finishes unwinding). Do NOT
 *  throw after it: that would misread every successful chain as a failure
 *  and run the plain-exit fallback right after arming the chain. */
export function chainToLibrary(): void {
	const SwitchAny = (Switch as any);
	// Use the ACTUALLY RUNNING NRO path as the chain target. The hardcoded
	// BURIALNX_NRO_PATH assumes the file is at sdmc:/switch/burialnx/burialnx.nro,
	// but the user may have renamed it (e.g. BurialNX-v0.1.5.nro) — in that case
	// Application(burialnx.nro) fails with "No such file or directory" and we
	// fall back to burialnx-debug.nro, chaining to a DIFFERENT file from what
	// the loader actually loaded. The loader then either ignores envSetNextLoad
	// (reloading the original) or loads the wrong NRO. Using Switch.argv[0]
	// guarantees the chain target is the file the loader actually loaded this
	// boot — so envSetNextLoad points at a file that exists and matches.
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

/** Quit BurialNX. No parameters: the exit behavior FLAG (see its lifecycle
 *  above) is the single source of truth —
 *    'shutdown' (library session, forwarder-launched game) → full close,
 *    'restart'  (library-launched game)                    → chainToLibrary.
 *  The flag is consumed here: a failed chain falls back to a full close and
 *  no later path in this process can trigger a second restart. */
export function quitApp() {
	const behavior = S.exitBehavior;
	S.exitBehavior = 'shutdown';
	log(`_exit: quitApp(${behavior}), forwarderTargetId=${S.forwarderTargetId || 'null'}, isBakedForwarder=${S.isBakedForwarder}`);
	// Return all memory and shut everything down: stop the game
	// (audio + frame loop + image buffers) and run a final GC pass.
	try { teardownGame(); } catch (e) { log(`_exit: teardown threw: ${e instanceof Error ? e.message : String(e)}`); }
	S.forwarderTargetId = null;
	S.isBakedForwarder = false;
	S.phase = 'library';
	S.exitNoticeArmed = false;
	S.plusHoldStart = 0;
	if (behavior === 'restart') {
		// Library-launched game exit: chain to burialnx.nro (no --game)
		// → the library grid shows in a FRESH process that starts with
		// exitBehavior = 'shutdown' (quitting there is a clean exit).
		try {
			chainToLibrary();
		} catch (e) {
			log(`_exit: chainToLibrary FAILED: ${e instanceof Error ? e.message : String(e)}`);
			removeBeforeUnloadListener();
			if (realExit) { S.allowExit = true; try { realExit(); } catch { /* best-effort */ } }
		}
		return;
	}
	// 'shutdown' — the user wants to leave BurialNX entirely: a plain
	// Switch.exit() back to hbmenu.
	//
	// CRITICAL: Switch.exit() is DEFERRED to the next tick via setTimeout.
	// quitApp() is called from inside the frame() rAF callback — calling
	// Switch.exit() synchronously while the frame is still on the call
	// stack causes a sporadic crash (re-entrancy: the next rAF may fire
	// before Switch.exit finishes, accessing retired state). Deferring
	// lets the current frame return cleanly, then the exit runs on a
	// fresh tick with no frame on the stack.
	log('_exit: calling Switch.exit()');
	if (realExit) {
		S.allowExit = true;
		// CRITICAL: The Atmosphere crash reports (3 separate crashes, all
		// identical) show infinite recursion in the nx.js event loop during
		// Switch.exit(): the repeating stack pattern (nxjs C++ → V8 → C++ →
		// V8 → ...) overflows the 1 MB stack. Switch.exit() dispatches events
		// (beforeunload, error, etc.) to our handlers, which trigger JavaScript
		// callbacks, which call back into C++, creating the cycle.
		//
		// Previous fix (removeBeforeUnloadListener only) was INSUFFICIENT —
		// the crash still occurs. The crash happens even on release builds.
		//
		// NEW FIX: remove the beforeunload listener IMMEDIATELY (so the
		// beforeunload during the current tick is harmless), then inside
		// the setTimeout callback (right before Switch.exit), remove ALL
		// remaining listeners (error, unhandledrejection). This ensures
		// that when Switch.exit() runs on the next tick, NO event listeners
		// are registered — no recursion is possible.
		//
		// The error/unhandledrejection listeners are kept active BETWEEN
		// quitApp returning and the setTimeout firing, so residual errors
		// from the retired game frame loop are still suppressed (the test
		// "retired game frame loop" verifies this — it dispatches a fake
		// error event synchronously, before the setTimeout fires).
		removeBeforeUnloadListener();
		setTimeout(() => {
			removeAllSessionListeners();
			try { realExit(); } catch (e) { log(`_exit: Switch.exit threw: ${e instanceof Error ? e.message : String(e)}`); }
		}, 0);
	}
}
