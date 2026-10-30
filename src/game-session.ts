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

/** Snapshot globalThis before launch so teardown can restore it. */
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
        if (typeof global.requestAnimationFrame === 'function' && typeof global.cancelAnimationFrame === 'function') {
                const nativeRequestAnimationFrame = global.requestAnimationFrame;
                global.requestAnimationFrame = function (handler: unknown) {
                        const id = nativeRequestAnimationFrame(handler);
                        if (typeof id === 'number') snapshot.rafIds.add(id);
                        return id;
                };
        }
}

/** Restore globalThis to the pre-launch snapshot: cancel queued rAFs + timers, drop fonts + game globals, restore replaced values. */
export function endGameSession() {
        const snapshot = gameSession;
        if (!snapshot) return;
        gameSession = undefined;
        const global = globalThis as any;
        for (const id of snapshot.rafIds) {
                try { snapshot.nativeCancelAnimationFrame?.(id); } catch { /* best-effort */ }
        }
        for (const id of snapshot.timers) {
                try { snapshot.nativeClearTimeout?.(id); } catch { /* best-effort */ }
        }
        try {
                const fonts = global.fonts;
                if (fonts && typeof fonts[Symbol.iterator] === 'function' && typeof fonts.delete === 'function') {
                        for (const font of [...fonts]) {
                                if (!snapshot.fonts.has(font)) { try { fonts.delete(font); } catch { /* best-effort */ } }
                        }
                }
        } catch { /* font cleanup is optional */ }
        for (const name of Object.getOwnPropertyNames(globalThis)) {
                if (snapshot.names.has(name)) continue;
                try { delete global[name]; } catch { /* non-configurable: keep */ }
        }
        for (const name of snapshot.names) {
                if (!(name in globalThis)) continue;
                try {
                        if (global[name] !== snapshot.values[name]) global[name] = snapshot.values[name];
                } catch { /* non-writable: keep */ }
        }
}
