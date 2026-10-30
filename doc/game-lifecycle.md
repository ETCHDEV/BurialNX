# `game-lifecycle.ts`

Extracted from `main.ts`, this module owns the end-of-game / end-of-process transitions: `teardownGame()`, `removeLegacyExitFlagFile()`, `chainToLibrary()`, `quitApp()`, and the module-level `realExit` constant. It reads/writes the shared `S` state and calls into the session-listener removers in `src/error-handling.ts`.

## File-level header

```
=== Game lifecycle: teardown + quit + chain-load =====================
Extracted from main.ts. Four functions and one module-level constant
that own the end-of-game / end-of-process transitions:

  teardownGame()    — stops game audio, retires the frame loop, drops
                      image caches, undoes the realm snapshot, runs GC.
  removeLegacyExitFlagFile() — one-time cleanup of the v0.1.6–0.1.8
                               .fwd-exit-flag marker file.
  chainToLibrary()  — chain-loads burialnx.nro without --game so the
                      library grid shows in a fresh process.
  quitApp()         — consumes the exit behavior flag ('shutdown' or
                      'restart') and either exits or chain-loads.
  realExit          — Switch.exit() bound to the Switch global, captured
                      once at module load so the quit path can defer it
                      via setTimeout and still call the native exit.

Reads/writes the shared `S` state. Calls into the session-listener
removers (removeBeforeUnloadListener / removeAllSessionListeners) which
live in src/error-handling.ts.
```

## `realExit` — module-level constant

```
// Captured at module load so the quit path can defer the native exit via
// setTimeout and still call the real Switch.exit (not a property stub).
// Uses globalThis.Switch (not the bare `Switch` identifier) so this module
// is safe to import in environments where Switch is not defined (the Node
// test harness bundles several src/ modules that transitively reach this
// line). globalThis.Switch is undefined in those envs -> realExit = null,
// no ReferenceError.
```

## `teardownGame()` — JSDoc summary + rationale

```
/** Completely stop the running game and release everything it holds: game
 *  audio, the requestAnimationFrame loop, decoded image/bitmap pixel
 *  buffers, every global the game or its host added to this realm (see the
 *  game session snapshot above), and our host references. A final GC pass
 *  returns the freed native buffers to the heap right away. Used by the
 *  quit path ("Quit BurialNX" and B on the error screen) before Switch.exit(),
 *  so no part of a stopped game can keep running, keep playing sound, or
 *  hold on to memory while the runtime tears the process down. */
```

## `teardownGame()` — stop audio first

```
// Stop all game audio first so nothing keeps playing over the loader.
```

## `teardownGame()` — retire the frame loop

```
// Permanently retire the game's frame loop. Just setting _stopped (or
// the gameStopped flag) leaves the already-queued rAF callback alive:
// it re-arms itself every frame and would come back to life — drawing
// the retired scene on the physical screen or crashing on stale state —
// as soon as the next launch clears gameStopped. Replacing the loop
// entry points with no-ops ends the chain for good; the next launch
// builds a fresh SceneManager from the game's own scripts.
```

## `teardownGame()` — drop scene references

```
// Drop scene references: scenes hold sprites, and
// sprites hold native bitmap buffers.
```

## `teardownGame()` — retire every reachable SceneManager method

```
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
```

## `teardownGame()` — release image/bitmap caches

```
// Release decoded image and bitmap pixel buffers held by the game's caches.
```

## `teardownGame()` — undo the realm snapshot

```
// Undo everything the game session added to this realm (globals, host
// replacements, game fonts, pending game timers) so the data above is no
// longer reachable from anywhere and the GC below can actually free it.
```

## `teardownGame()` — reset diagnostics

```
// Drop the diagnostic scene references too — they would pin the last
// observed scene (and its whole sprite/bitmap graph) in memory.
```

## `teardownGame()` — reset language state

```
// Reset language state so a subsequent launch scans the new game's packs.
```

## `teardownGame()` — final GC pass

```
// Ask V8 for a full collection so the released buffers are actually
// returned to the native heap instead of lingering until the next
// launch needs the memory.
```

## `removeLegacyExitFlagFile()` — one-time v0.1.6–0.1.8 cleanup

```
// One-time cleanup: versions 0.1.6–0.1.8 wrote a .fwd-exit-flag marker file
// to the SD card for their boot-time re-chain detection. Nothing reads it
// anymore — remove it when present so no stale artifact from those builds
// survives on the card.
```

## `chainToLibrary()` — JSDoc

```
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
```

## `chainToLibrary()` — use running NRO path

```
// Use the ACTUALLY RUNNING NRO path as the chain target. The hardcoded
// BURIALNX_NRO_PATH assumes the file is at sdmc:/switch/burialnx/burialnx.nro,
// but the user may have renamed it (e.g. BurialNX-v0.1.5.nro) — in that case
// Application(burialnx.nro) fails with "No such file or directory" and we
// fall back to burialnx-debug.nro, chaining to a DIFFERENT file from what
// the loader actually loaded. The loader then either ignores envSetNextLoad
// (reloading the original) or loads the wrong NRO. Using Switch.argv[0]
// guarantees the chain target is the file the loader actually loaded this
// boot — so envSetNextLoad points at a file that exists and matches.
```

## `quitApp()` — JSDoc + flag lifecycle

```
/** Quit BurialNX. No parameters: the exit behavior FLAG (see its lifecycle
 *  above) is the single source of truth —
 *    'shutdown' (library session, forwarder-launched game) → full close,
 *    'restart'  (library-launched game)                    → chainToLibrary.
 *  The flag is consumed here: a failed chain falls back to a full close and
 *  no later path in this process can trigger a second restart. */
```

## `quitApp()` — teardown before exit

```
// Return all memory and shut everything down: stop the game
// (audio + frame loop + image buffers) and run a final GC pass.
```

## `quitApp()` — restart branch (library-launched game)

```
// Library-launched game exit: chain to burialnx.nro (no --game)
// → the library grid shows in a FRESH process that starts with
// exitBehavior = 'shutdown' (quitting there is a clean exit).
```

## `quitApp()` — shutdown branch (deferred exit)

```
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
```

## `quitApp()` — Atmosphere crash reports / infinite recursion fix

```
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
```
