# `game-session.ts`

Extracted from `main.ts`, this module snapshots `globalThis` before a game launch and restores it during teardown. Because the game's scripts are eval'd at global scope, every RPG Maker MV global (`$dataXXX`, `SceneManager`, `Graphics`, the patched `WebAudio`, the host's `document/fetch/Image`, …) lands on `globalThis` — and without this machinery stays there after "Back to library", so V8 can never free the map data, sprite graphs, the PIXI renderer or the native audio buffers. The snapshot/restore pair lets all that memory be returned on teardown.

## File-level header

```
=== Game session snapshot ============================================
Extracted from main.ts. The game runs in THIS JavaScript realm: its
scripts are eval'd at global scope, so every RPG Maker MV global
($dataXXX, SceneManager, Graphics, the patched WebAudio, the host's
document/fetch/Image, …) lands on globalThis — and, without this
machinery, STAYS there after "Back to library". V8 can never free the
map data, sprite graphs, the PIXI renderer or the native audio buffers
while those references remain, and the next launch stacks a whole
second game on top of the first until native allocations start failing
(observed on hardware as "RangeError: Out of memory (failed to
allocate … bytes)"). To return ALL memory we snapshot globalThis right
before a launch and restore it during teardown: globals added by the
game are deleted, globals the host replaced are set back to their
original values, game-registered timers are cancelled and fonts the
game added are dropped — then one full GC pass retires everything that
is no longer reachable.
```

## `beginGameSession()` — timer tracking

```
// Track every timer the game registers so teardown can cancel the ones
// still pending: a late callback would fire into stopped state and its
// closure would pin parts of the game in memory forever.
```

## `beginGameSession()` — rAF tracking

```
// Track every animation frame the game schedules, for a sharper reason
// than the timers: the game's pending rAF callback IS its original
// bound SceneManager.update. Property stubs on the manager cannot
// reach into that already-bound function, so the only way to stop a
// QUEUED frame from running after the realm restore deleted the game
// globals is cancelling its id here (nx.js implements rAF as a plain
// cancellable callback queue). endGameSession() does exactly that.
```

## `endGameSession()` — step 0: cancel queued rAFs first

```
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
```

## `endGameSession()` — step 1: cancel pending timers

```
// 1. Cancel pending game timers first so no callback fires mid-teardown.
```

## `endGameSession()` — step 2: drop game-added fonts

```
// 2. Drop fonts the game added (each FontFace keeps a native copy of the
//    TTF data alive until the object is collected).
```

## `endGameSession()` — step 3: delete game-added globals

```
// 3. Delete every global the game or its host added on top of the
//    snapshot. Game-created globals are plain configurable properties;
//    some nx.js built-ins are non-configurable and simply can't be
//    deleted (they are also never the game's, so keeping them is fine).
```

## `endGameSession()` — step 4: restore replaced values

```
// 4. Restore replaced values: document, fetch, Image, XMLHttpRequest,
//    location, … all go back to the native originals. The next launch
//    re-installs fresh wrappers around the natives instead of stacking.
```
