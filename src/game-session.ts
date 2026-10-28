// === Game session snapshot ============================================
// Extracted from main.ts. The game runs in THIS JavaScript realm: its
// scripts are eval'd at global scope, so every RPG Maker MV global
// ($dataXXX, SceneManager, Graphics, the patched WebAudio, the host's
// document/fetch/Image, …) lands on globalThis — and, without this
// machinery, STAYS there after "Back to library". V8 can never free the
// map data, sprite graphs, the PIXI renderer or the native audio buffers
// while those references remain, and the next launch stacks a whole
// second game on top of the first until native allocations start failing
// (observed on hardware as "RangeError: Out of memory (failed to
// allocate … bytes)"). To return ALL memory we snapshot globalThis right
// before a launch and restore it during teardown: globals added by the
// game are deleted, globals the host replaced are set back to their
// original values, game-registered timers are cancelled and fonts the
// game added are dropped — then one full GC pass retires everything that
// is no longer reachable.

export interface GameSessionSnapshot {
	names: Set<string>;
	values: Record<string, unknown>;
	fonts: Set<unknown>;
	timers: Set<number>;
	rafIds: Set<number>;
	nativeClearTimeout: ((id: number) => void) | undefined;
	nativeCancelAnimationFrame: ((id: number) => void) | undefined;
}

let gameSession: GameSessionSnapshot | undefined;

export function beginGameSession() {
	const global = globalThis as any;
	const values: Record<string, unknown> = {};
	const names = Object.getOwnPropertyNames(globalThis);
	for (const name of names) values[name] = global[name];
	const fonts = new Set<unknown>();
	try {
		if (global.fonts && typeof global.fonts[Symbol.iterator] === 'function') {
			for (const font of global.fonts) fonts.add(font);
		}
	} catch { /* the fonts set is optional */ }
	const snapshot: GameSessionSnapshot = {
		names: new Set(names),
		values,
		fonts,
		timers: new Set<number>(),
		rafIds: new Set<number>(),
		nativeClearTimeout: typeof global.clearTimeout === 'function' ? global.clearTimeout.bind(global) : undefined,
		nativeCancelAnimationFrame: typeof global.cancelAnimationFrame === 'function' ? global.cancelAnimationFrame.bind(global) : undefined,
	};
	gameSession = snapshot;
	// Track every timer the game registers so teardown can cancel the ones
	// still pending: a late callback would fire into stopped state and its
	// closure would pin parts of the game in memory forever.
	if (typeof global.setTimeout === 'function') {
		const nativeSetTimeout = global.setTimeout;
		global.setTimeout = function (handler: unknown, timeout?: unknown, ...args: unknown[]) {
			const id = nativeSetTimeout(handler, timeout, ...args);
			snapshot.timers.add(id);
			return id;
		};
	}
	if (typeof global.setInterval === 'function') {
		const nativeSetInterval = global.setInterval;
		global.setInterval = function (handler: unknown, timeout?: unknown, ...args: unknown[]) {
			const id = nativeSetInterval(handler, timeout, ...args);
			snapshot.timers.add(id);
			return id;
		};
	}
	// Track every animation frame the game schedules, for a sharper reason
	// than the timers: the game's pending rAF callback IS its original
	// bound SceneManager.update. Property stubs on the manager cannot
	// reach into that already-bound function, so the only way to stop a
	// QUEUED frame from running after the realm restore deleted the game
	// globals is cancelling its id here (nx.js implements rAF as a plain
	// cancellable callback queue). endGameSession() does exactly that.
	if (typeof global.requestAnimationFrame === 'function' && typeof global.cancelAnimationFrame === 'function') {
		const nativeRequestAnimationFrame = global.requestAnimationFrame;
		global.requestAnimationFrame = function (handler: unknown) {
			const id = nativeRequestAnimationFrame(handler);
			if (typeof id === 'number') snapshot.rafIds.add(id);
			return id;
		};
	}
}

export function endGameSession() {
	const snapshot = gameSession;
	if (!snapshot) return;
	gameSession = undefined;
	const global = globalThis as any;
	// 0. Cancel the game's queued animation frames FIRST. The pending rAF
	//    callback runs the original bound SceneManager.update; if it fired
	//    after the globals below are deleted, its first Graphics/Utils
	//    reference would throw a ReferenceError that escapes through the
	//    game's own catchException (which references Graphics too) into
	//    nx.js — and an uncaught rAF exception terminates the whole
	//    process (hardware: "Graphics is not defined" over a frozen
	//    screen). Cancelling the ids plus the manager stubs below make a
	//    dequeued-but-still-running frame a complete no-op, so quitting
	//    cannot be crashed by a late game frame between teardown and
	//    Switch.exit().
	for (const id of snapshot.rafIds) {
		try { snapshot.nativeCancelAnimationFrame?.(id); } catch { /* best-effort */ }
	}
	// 1. Cancel pending game timers first so no callback fires mid-teardown.
	for (const id of snapshot.timers) {
		try { snapshot.nativeClearTimeout?.(id); } catch { /* best-effort */ }
	}
	// 2. Drop fonts the game added (each FontFace keeps a native copy of the
	//    TTF data alive until the object is collected).
	try {
		const fonts = global.fonts;
		if (fonts && typeof fonts[Symbol.iterator] === 'function' && typeof fonts.delete === 'function') {
			for (const font of [...fonts]) {
				if (!snapshot.fonts.has(font)) { try { fonts.delete(font); } catch { /* best-effort */ } }
			}
		}
	} catch { /* font cleanup is optional */ }
	// 3. Delete every global the game or its host added on top of the
	//    snapshot. Game-created globals are plain configurable properties;
	//    some nx.js built-ins are non-configurable and simply can't be
	//    deleted (they are also never the game's, so keeping them is fine).
	for (const name of Object.getOwnPropertyNames(globalThis)) {
		if (snapshot.names.has(name)) continue;
		try { delete global[name]; } catch { /* non-configurable: keep */ }
	}
	// 4. Restore replaced values: document, fetch, Image, XMLHttpRequest,
	//    location, … all go back to the native originals. The next launch
	//    re-installs fresh wrappers around the natives instead of stacking.
	for (const name of snapshot.names) {
		if (!(name in globalThis)) continue;
		try {
			if (global[name] !== snapshot.values[name]) global[name] = snapshot.values[name];
		} catch { /* non-writable: keep */ }
	}
}
