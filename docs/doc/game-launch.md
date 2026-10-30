# `game-launch.ts`

Extracted from `main.ts`, this module owns the async `launch()` pipeline that snaps a realm snapshot, reads game assets + scripts, installs the browser host + Node compat + game compatibility, installs the `Input._updateGamepadState` wrapper that drives `pollStickBindings`, installs the save-location storage, optionally imports Steam saves, installs the `Graphics.render` + `SceneManager.updateMain` wrappers, and starts the game's own scenes. It reads/writes the shared `S` state extensively.

## File-level header

```
=== Game launch =====================================================
Extracted from main.ts. The async launch() pipeline: snapshot the
realm, read game assets + scripts, install the browser host + Node
compat + game compatibility, install the Input._updateGamepadState
wrapper that drives pollStickBindings, install the save-location
storage, optionally import Steam saves, install the Graphics.render
+ SceneManager.updateMain wrappers, and start the game's own scenes.

Reads/writes the shared `S` state extensively (host, mapPrefetch,
languageEntries, activeLanguageCode, phase, exitBehavior, gameStopped,
library, etc.). The wrappers installed here close over `S` and read
gameStopped / phase / exitNoticeArmed / lastFrame / menu / fail at
call time — they're the reason main.ts still owns those state fields
even though launch() lives in this module.
```

## `launch()` — exit behavior arming

```
S.gameStopped = false; // reset for new game launch
// Arm this session's exit behavior (see the exitBehavior lifecycle):
// a game launched FROM THE LIBRARY returns to the library on exit
// ('restart' — quitApp chain-loads burialnx and the grid shows in a
// fresh process); a game launched via a FORWARDER (baked-in or legacy
// argv — forwarderTargetId is set at boot for those) fully closes
// BurialNX on exit ('shutdown'). Set at the point of no return, so a
// canceled save-choice or options screen never arms the restart
// without a game actually loading. Every app load boots with
// 'shutdown' and only this line can change it.
```

## `launch()` — loading bar reset

```
// Reset the progress bar for a fresh launch. The title is the game's
// display name when known (so the bar shows "The Coffin of Andy and
// Leyley" instead of just "BurialNX"), falling back to the loader name.
```

## `launch()` — realm snapshot (`beginGameSession`)

```
// Snapshot the global scope before anything game-related is installed:
// every global the game, its fonts, its timers or its host add on top
// of this point is undone by teardownGame() when the user quits the
// app, so no game data survives into the next cold boot.
```

## `launch()` — language table loading (.cld handling)

```
// Load the language table. Start with the DEFAULT English data
// (always works — it's embedded in data/), then try to UPGRADE
// to a .cld pack (Russian) if one exists. ALL .cld operations
// are wrapped in try/catch so they NEVER crash the launch —
// if anything fails, the game falls back to English. This is
// critical for forwarder NROs which have saveData=0 (no
// localStorage) and may have different runtime constraints.
//
// CRITICAL: the .cld file is ~25 MB. It is read and parsed ONLY
// ONCE (for the chosen language). resolveLanguageName is NOT
// called separately (it would read+parse the same 25 MB file a
// second time, causing an OOM crash on the first forwarder
// launch). Instead, the display name is taken from the parsed
// pack's langName field.
```

## `launch()` — picking the language entry

```
// Use the .cld code as the display name for now (e.g. 'ru').
// The real name (e.g. 'Русский') is resolved from the parsed
// pack below — NO separate file read needed.
// Pick the language: saved preference > first .cld (Russian).
```

```
// savedRaw === '' → explicit English: chosen stays null.
```

## `launch()` — reading .cld bytes once

```
// Read the .cld file ONCE (not twice — resolveLanguageName
// is skipped to avoid an OOM crash on the first launch).
```

## `launch()` — updating display name + image wrapping

```
// Update the chosen entry's display name from the
// parsed pack (free — no extra file read).
// Wrap assets with translated images (best-effort).
```

## `launch()` — language-load fallback to English

```
// Language scanning/loading failed — fall back to English.
// The `language` variable still holds the English table.
```

## `launch()` — Node compat install

```
// Install Node.js / NW.js compatibility globals (require, process,
// Buffer, module, exports, global, __dirname, __filename, nw) BEFORE
// any game script loads. RPG Maker MV games packaged for NW.js call
// these the moment a plugin or a patched title window runs — without
// them the launch dies with `ReferenceError: require is not defined`.
// `require('fs')` is wired to nx.js's synchronous SD-card I/O via
// the `Switch` global, with a per-game writable overlay so the game's
// own files stay pristine. This runs after beginGameSession(), so the
// installed globals are tracked and cleaned up by teardownGame().
```

## `launch()` — script-loading progress range

```
// Script loading dominates the launch time for RPG Maker MV
// games (often 40+ scripts, several hundred KiB each). Reserve
// the 0.20..0.90 range for it and update per-script.
```

## `launch()` — language-font registration timing

```
// Register the language pack's embedded font (e.g. bitter-pro-regular
// from ru.cld) and override Window_Base/Yanfly/Graphics font selection
// so the game draws text in the localized font instead of GameFont.
// Must run AFTER scripts load (so Window_Base, Yanfly, Graphics exist)
// and AFTER installGameCompatibility (which may reference the font hooks).
```

## `launch()` — `Input._updateGamepadState` wrapper (stick-bindings timing fix)

```
// Wrap Input._updateGamepadState so pollStickBindings runs
// AFTER it — this is the CRITICAL timing fix for vkey stick
// bindings (keyCode 0 → vkey name like 'ok', 'cancel').
//
// MV's Input.update calls _updateGamepadState() FIRST, which
// reads face buttons + left-stick axes and sets
// _currentState[vkeyName] via edge detection (true on press,
// false on release). THEN it iterates _currentState to detect
// triggered/held/released for the frame.
//
// If pollStickBindings ran BEFORE _updateGamepadState (as it
// did when called from the frame loop), a stick-driven vkey
// (e.g. R↓→ok → _currentState['ok'] = true) would be
// OVERRIDDEN by _updateGamepadState setting
// _currentState['ok'] = false (button A not pressed → release
// edge). The stick binding would be silently dropped.
//
// By wrapping _updateGamepadState to call pollStickBindings
// AFTER the original, our stick bindings are the FINAL write
// to _currentState before Input.update's iteration — so
// _updateGamepadState's edge-detected false can't clobber
// our true. Combined with the vkey fix (keyCode 0 → label as
// string key), this makes right-stick→vkey bindings actually
// fire in-game.
```

## `launch()` — save/load scene guard inside the stick wrapper

```
// SKIP stick-keyCode injection while the save/load scene is
// active — see save-load-keymap.ts for the full rationale.
// The short version: a stick direction bound to a keyCode
// (e.g. L-stick down → 'S') would fire _onKeyDown every
// frame during Scene_Save, leaving stale _currentState
// that Scene_Map reads as held after the menu closes (the
// "B in save menu → game fast-forwards" bug, but for sticks).
// overrideKeymapForSaveLoadScene() also clears state on
// enter/exit as a belt-and-braces guard.
```

## `launch()` — `SceneManager.updateMain` pop hook installation

```
// Install the SceneManager.pop hook ONCE, before the game's
// updateMain runs. The pop hook clears the save/load override
// (gamepadMapper + vkey state) AT THE MOMENT Scene_Save/Load
// pops — synchronously, before the resumed scene's update runs
// in the same updateMain call. This closes the one-frame timing
// gap that let a stale ok/cancel vkey trigger leak from
// Scene_Save into the resumed Scene_Message (the "cancel in
// save menu → bitmap crash" bug). See installSaveLoadPopHook
// in src/save-load-keymap.ts for the full rationale.
```

## `launch()` — `updateMain` early-return for stop / Plus-quit notice

```
// When returning to library, skip the game's update entirely.
// The game's rAF callback still fires but does nothing,
// preventing crashes from accessing stopped/undefined state.
// Also skip during the Plus(+) quit-confirmation notice
// so the game doesn't render over the dialog panel.
```

## `launch()` — `updateMain` removed sleep-recovery guard

```
// NOTE: an earlier version of this wrapper had a ">2 s
// performance.now() gap" guard that reset the accumulator
// and cleared input state — an attempt to let the game
// resume in place after Sleep Mode. It was part of the
// "continue in place" wake-recovery strategy that proved
// unstable on hardware and has been REMOVED. Sleep/wake
// is now handled entirely by src/sleep-recovery.ts: the
// frame loop detects the >3 s gap, saves the live game to
// a hidden slot, tears down, and chain-launches a FRESH
// process which reloads the save. The game never sees a
// post-sleep frame in the same process.
```

## `launch()` — sleep-mode autoload hook

```
// If this launch is a sleep-mode autoload (the boot consumed a
// fresh sleep marker for this game), install the one-shot hook
// that intercepts the FIRST scene transition out of Scene_Boot
// and replaces it with: read the hidden save file →
// DataManager.createGameObjects + extractSaveContents →
// $gamePlayer.requestMapReload() → goto(Scene_Map). The player
// resumes exactly where they were when the console slept, in a
// clean process with a healthy GPU surface. See sleep-recovery.ts.
```

## `launch()` — record last-played

```
// Record last-played timestamp.
```
