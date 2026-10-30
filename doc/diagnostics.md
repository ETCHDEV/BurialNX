# `diagnostics.ts`

Scene diagnostics for debug builds: tracks the currently-observed scene, reports scene transitions immediately, and writes a periodic status line (with the `ImageManager` cache contents) every 8 s when `__DEBUG__` is on. Owns the four diagnostic `let`s so `teardownGame()` can call `resetDiagnostics()` to drop the scene references they would otherwise pin in memory after a game quits.

## File header
> === Scene diagnostics (debug-only) ==================================
> Extracted from main.ts. Tracks the currently-observed scene and reports
> scene status + image-cache state every 8 s when __DEBUG__ is on. The
> module owns the four diagnostic `let`s so `teardownGame` can call
> `resetDiagnostics()` to drop the scene references they would otherwise
> pin in memory after a game quits.

## `resetDiagnostics`
> /** Drop the diagnostic scene references. Called by `teardownGame()` so the
>  *  last observed scene (and its whole sprite/bitmap graph) is no longer
>  *  pinned in memory by this module's closures. */

## `diagnoseScene`
> /** Per-frame scene diagnostics. Only runs work when __DEBUG__ is on. Logs
>  *  scene transitions immediately and reports a status line (with the
>  *  image-cache contents) every 8 s. `runtime` is the game's global scope
>  *  (globalThis), `fps` is the current frames-per-second counter, and
>  *  `log` / `snapshotRuntimeLog` are the loader's logging helpers. */
