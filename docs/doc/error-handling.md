# `error-handling.ts`

Error handling and session-lifetime listeners for the BurialNX loader. `fail()`/`failRequest()` turn any error into the loader's recoverable red error screen (or just log it for residue from a retired game). Three session-lifetime listeners (`error`, `unhandledrejection`, `beforeunload`) are registered once on `globalThis`; `removeBeforeUnloadListener`/`removeAllSessionListeners` are called by the quit path to prevent infinite recursion during `Switch.exit()`.

## Module header

Extracted from `main.ts`. `fail()`/`failRequest()` turn any error into the loader's recoverable red error screen (or just log it for residue from a retired game). The three session-lifetime listeners (error, unhandledrejection, beforeunload) are registered ONCE on globalThis and `removeBeforeUnloadListener`/`removeAllSessionListeners` are called by the quit path to prevent infinite recursion during `Switch.exit()`.

`fail()` reads/writes the shared `S` state: phase, message, runtime. The listeners close over `S.allowExit` and `fail()`.

## `fail`

Leftover asynchronous callbacks of a retired game (timers, audio promises, late image loads) can still throw after the user quit the app or returned to the error screen. Those errors can no longer be acted on and must not hijack the loader with a red error screen; log them and move on.

Stop game frames from painting over the loader's diagnostic screen.

## `failRequest`

Request completions are asynchronous by nature; when they arrive from a game that was already stopped, `fail()` only logs them.

## Session lifetime listeners

The loader registers these three listeners ONCE on the process-lifetime globals. The beforeunload guard ALWAYS prevents the default so the Plus (+) button never exits on its own: quitting goes through the pause menu's "Quit BurialNX" entry or the double-press confirmation (`quitApp` sets `allowExit` before calling the real exit). The error/unhandledrejection listeners cancel the dispatched events: nx.js otherwise terminates the whole process ("Press + to exit" over a frozen screen) for ANY uncaught exception or floating promise — the loader shows its own recoverable error screen instead.

### `sessionErrorListener`

Image 'error' events (fired when a cover PNG fails to decode) bubble up to globalThis. They are not ErrorEvent and don't have `.error` or `.message`. `loadCoverImage` already handles them via its own 'error' listener (setting `entry.failed` and drawing a placeholder). Don't double-handle here — that would show a spurious red error panel every time a malformed cover is loaded.

nx.js terminates the whole process for an uncaught exception ("Press + to exit" over a frozen screen) unless the dispatched 'error' event is canceled. Take responsibility for the outcome instead: show our own recoverable error screen — or just log it when the error is residue of an already retired session.

### `sessionRejectionListener`

Unhandled rejections are exactly as fatal as uncaught exceptions in nx.js — and games are full of floating promises. Cancel the default and let `fail()` decide whether the reason deserves a screen.

### `sessionBeforeUnloadGuard`

nx.js checks Plus (+) every frame and dispatches beforeunload when it is held; if the event is not canceled the runtime exits. The guard ALWAYS prevents the default so + never exits on its own: quitting goes through the pause menu or the double-press confirmation (`quitApp` sets `allowExit` before calling the real exit).

## `removeBeforeUnloadListener`

Remove the beforeunload listener. Called BEFORE `Switch.exit()` to prevent nx.js from dispatching beforeunload during the exit process. The Atmosphere crash report showed infinite recursion (stack overflow) during exit: the repeating stack pattern (C++ → V8 → C++ → V8 → ...) indicates that `Switch.exit()` dispatches beforeunload, and the handler's execution triggers another beforeunload (or similar event), creating an unbreakable recursive loop that overflows the 1 MB stack. Removing ONLY the beforeunload listener breaks the cycle — the error and unhandledrejection listeners are KEPT so that residual errors from the retired game are still suppressed (the quit path test verifies this). Those listeners don't cause recursion because `fail()` has an early-return guard (`if (phase === 'error') return`).

## `removeAllSessionListeners`

Remove ALL session event listeners (error, unhandledrejection, beforeunload). Called INSIDE the setTimeout callback, right before `Switch.exit()` — so that `Switch.exit()` can't dispatch ANY events to our handlers. The error and unhandledrejection listeners are kept active between `quitApp` returning and the setTimeout firing (so residual errors are still suppressed), then removed inside the callback.
