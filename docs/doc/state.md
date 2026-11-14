# `state.ts`

A single typed bag (`AppState`) holding every `let` that used to live at the top of `main.ts`, plus a singleton `S` constructed once at module load and shared across every loader module. Splitting the shared mutable state out into its own file is what let the frame loop, `launch()`, `teardownGame()`, `quitApp()`, the render functions, the keymap editor, and the selection helpers all move into their own modules while still reading/writing the same global state.

## Module header
> === Shared mutable state ============================================
> One typed bag holding every `let` that used to live at the top of
> main.ts. The frame loop, launch(), teardownGame(), quitApp(), the
> render functions, the keymap editor, and the selection helpers all
> read/write fields on this object instead of closing over ~60 separate
> module-level `let` bindings — that's what lets those functions move
> into their own modules and shrinks main.ts to a thin entry point.
>
> `S` is the conventional short alias used throughout the loader; main.ts
> imports it as `import { S } from './state'`.

## `AppState.sleepAutoload*` fields (sleep-mode autosave recovery)
> === Sleep-mode autosave recovery (see src/sleep-recovery.ts) ===
> When the console wakes from Sleep Mode, nx.js v1.0.0-beta.7 cannot
> recover the GPU surface — any heavy GPU work crashes with 0x95D. The
> recovery flow: detect the wake (frame gap), save the live game to a
> HIDDEN slot (above the game's normal max-savefiles range so the
> save/load UI never shows it), write a marker file, teardown the game,
> and chain-launch a FRESH process (fresh GPU surface). The fresh
> process reads the marker at boot and auto-loads the hidden slot so
> the player resumes exactly where they were.

> `sleepAutoloadPending`:   true = autoload the hidden save after boot
> `sleepAutoloadGameId`:    the game id the marker requested (sanity check)
> `sleepAutoloadArmed`:     set true once the autoload hook is installed in launch()

> BGM/BGS captured directly from AudioManager at save time (via
> AudioManager.saveBgm/saveBgs) and passed through the marker file.
> More reliable than $gameSystem._bgm (which some games/plugins don't
> populate): this is exactly what was playing through the speakers
> when the console slept, captured at the AudioManager level.
> `sleepAutoloadBgm`: null = none; otherwise {name, volume, pitch, pos}
> `sleepAutoloadBgs`: null = none; otherwise {name, volume, pitch, pos}

## `AppState.wake*` fields (sleep / wake detection)
> === Sleep / wake detection (see src/sleep-detect.ts) ===
> The wake detector has two layers: a deterministic NATIVE signal
> (Switch.appletConsumeSleepWake, exposed by the patched nx.js
> runtime — patches/nxjs-applet-sleep.patch) and a HEURISTIC
> steady-frame gap fallback for the stock runtime. The fields below
> drive the heuristic arming state; the native layer is stateless
> (it polls + clears a native flag each frame).
> `wakeSteadyFrames`:   consecutive steady-frame count (resets on hiccup/phase change)
> `wakeArmed`:          true once steady frames >= STEADY_FRAMES_TO_ARM in an armable phase
> `wakeNativeEnabled`:  false once the native probe fails/throws (falls back to heuristic)

## `AppState.exitInProgress` (deferred-exit render guard)
> === Deferred-exit render guard (see src/sleep-recovery.ts) ===
> Set true when a wake during a TITLE-screen save/load menu arms a
> DEFERRED exit (the forwarder case: quitApp() defers Switch.exit()
> via setTimeout to avoid the re-entrancy crash of calling it
> synchronously inside frame()). Between the wake frame returning
> and the deferred Switch.exit firing, the event loop may dispatch
> another rAF — and ANY render on the stale post-wake GPU surface
> crashes with 0x95D. While this flag is true, frame() skips ALL
> work (rendering, input, scene updates) and just re-arms rAF until
> the process actually exits. The library-launched title save/load
> path (chainToLibrary) stops the event loop immediately so this
> flag is belt-and-braces there; for the forwarder path it is the
> decisive guard. Never reset in-process (the process is dying);
> the fresh process starts with it false (createState default).

## `createState`
> Construct the singleton state object. Called ONCE from main.ts at the
> top of the file (after the log module init runs). The returned object
> is shared across every module that imports `S`.

## Singleton `S`
> The singleton state object, created at module load. Every module that
> imports `S` reads/writes the SAME object — that's the whole point.

## Type re-exports
> Re-export the types this module's callers commonly need so they don't
> each have to import them from three different files.

## `frameSkip` (AppState field)
> User-adjustable slider (0..10), default 0. On a stable scene, the
> `SceneManager.updateMain` wrapper (see game-compat.ts) skips N dirty
> frames between renders when this is > 0. 0 = render every dirty
> frame (dirty-flag still skips static frames). Persisted to
> `sdmc:/switch/burialnx/frame-skip-settings.json` and loaded at startup
> in main.ts. Adjusted in the pause menu under "Another…" → "Frame skip".
