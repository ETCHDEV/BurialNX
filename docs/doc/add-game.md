# `add-game.ts`

Extracted from `main.ts`, this module exposes three entrypoints: `suggestGameName(root)` derives a default game name from the picked folder path; `finishAddGame(name)` creates the library entry, auto-detects a cover, and returns to the grid; `startForwarderBuild(entry)` is the async pipeline that drives `buildForwarder()` with a loading-screen progress bar.

## File-level header

```
=== Add-game + forwarder builder entrypoints =========================
Extracted from main.ts.

suggestGameName(root) — derives a default game name from the picked
                        folder path (looks for a .exe one level up from
                        www/, falls back to the folder name).
finishAddGame(name)   — creates the library entry with the given name,
                        tries to auto-detect a cover, returns to the
                        library grid.
startForwarderBuild(entry) — async pipeline that drives buildForwarder()
                        with the loading-screen progress bar: reads the
                        running burialnx.nro as the base, optionally
                        reads the game cover, patches the romfs + NACP,
                        writes the per-game forwarder NRO to the SD card.
```

## `suggestGameName()` — JSDoc

```
/** Suggest a game name from the picked folder path. Looks for a .exe
 *  file in the parent folder (RPG Maker MV games usually have one next
 *  to the www/ folder). If found, uses the .exe filename without the
 *  extension. Otherwise, uses the folder name. */
```

## `suggestGameName()` — `www/` parent handling

```
// RPG Maker MV's www/ contains the web assets; the .exe usually
// lives next to it. Look one level up when the root is www/.
```

## `suggestGameName()` — strip .exe extension

```
// Use the .exe filename without the extension.
```

## `suggestGameName()` — folder fallback

```
// Fall back to the folder name.
```

## `finishAddGame()` — JSDoc

```
/** Finish the add-game flow: create the library entry with the given
 *  name, try to auto-detect a cover, and return to the library. */
```

## `finishAddGame()` — derive cover

```
// Try to derive a cover from the folder.
```

## `finishAddGame()` — pre-select new game

```
// Pre-select the new game.
```

## `finishAddGame()` — cleanup add-game state

```
// Clean up.
```

## `startForwarderBuild()` — JSDoc

```
/** Drives the buildForwarder() pipeline. Reads the running burialnx.nro
 *  as the base, optionally reads the game cover PNG, patches the romfs +
 *  NACP + game id, writes the per-game forwarder NRO. Updates the loading
 *  progress bar at each stage so the user sees what's happening. The
 *  whole operation runs while phase === 'forwarder-building' so the frame
 *  loop renders the progress bar and B is ignored (we don't want to
 *  interrupt a half-written NRO). */
```

## `startForwarderBuild()` — defer one tick for paint

```
// Defer one tick so the new phase paints before the (sync) SD reads
// start blocking. The phase renders the progress bar.
```

## `startForwarderBuild()` — yield to next frame

```
// Yield to the next frame so the loading screen paints.
```

## `startForwarderBuild()` — read burialnx.nro as base

```
// Read burialnx.nro's OWN file (the running app) to use as the
// forwarder base. Switch.argv[0] is the path hbmenu used to
// launch us. The forwarder is built by patching a copy of
// this NRO: overwrite main.js in the romfs with the forwarder's
// chain-load script, patch the NACP (title = game name), and
// optionally patch the icon. No embedded template needed —
// burialnx.nro stays at ~54 MiB.
```

## `startForwarderBuild()` — free baseNro before notice (exit-crash fix)

```
// Explicitly free the 54 MB baseNro ArrayBuffer and cover Image
// before showing the notice. Without this, the large buffers may
// still be in memory when the user clicks exit — the deferred
// Switch.exit() can crash during native cleanup if too much
// memory is still allocated. This GC call is the fix for the
// sporadic "exit crashes after building/deleting a forwarder" bug.
```
