# `main.ts`

The thin entry point of the BurialNX loader. It wires together the imported modules (shared state `S`, log, splash, render-library, render-options, keymap, save/load, sleep recovery, forwarder auto-launch, etc.), installs the localStorage shim and session listeners, parses the baked-in/legacy forwarder target, consumes the sleep-mode autoload marker, removes the legacy exit flag, then schedules the first `requestAnimationFrame(frame)` and any deferred auto-launch / sleep-autoload callback. All `let` state that used to live here has been moved to `src/state.ts`; the comment chain in this file mostly describes WHAT was extracted WHERE (so the rationale survives the comment-stripping pass that follows).

## Extracted modules
> === Extracted modules ===============================================
> The following groups were split out of this file to keep it manageable.
> No function bodies changed — only their location and (for functions that
> closed over main.ts's module-level `ctx`/`screen`) the signature grew a
> `ctx`/`screen` parameter. See each module's header comment for rationale.

## Shared mutable state (extract note)
> Shared mutable state object — every field that used to be a `let` at the
> top of this file now lives on `S` (see src/state.ts). Functions moved into
> other modules (render-*, frame-loop, game-launch, game-lifecycle, etc.)
> import the SAME `S` and read/write its fields. This file mutates `S`
> directly without going through any accessor — exactly the same number
> of state accesses as before, just spelled `S.field` instead of `field`.

## Build-time constants (`__FORWARDER_GAME_ID__`)
> Baked-in forwarder game id. For the main burialnx.nro, this is a 64-'0'
> placeholder string. When burialnx builds a forwarder, it patches this
> placeholder in the romfs with the target game's id (padded to 64 chars).
> At startup, if the value is NOT all zeros, this IS a forwarder NRO — no
> chain-loading was used (no envSetNextLoad), so quitting is a clean
> Switch.exit() → hbmenu.

## Build-time constants (`__FORWARDER_MOD_FORCED__`)
> Baked-in mod-forced flag. "MODFORCED_0" (off) or "MODFORCED_1" (on).
> Patched by the forwarder builder when the game's mod is enabled.

## Log module init / numbered checkpoints
> The log module's one-time startup init (mkdir + truncate the log file +
> the first "BurialNX debug session …" diagnostic lines) runs at import
> time, before any statement in this file — see src/log.ts. `debugLines`,
> `hostLogPath`, and `logsPath` are re-exported from that module so the
> rest of main.ts can read them as before.

> Numbered checkpoint logs so a crash leaves a clear trail of which step
> succeeded last. The user can then share the log and we know exactly where
> to look. Format: `_N: <step>` with N incrementing across the whole init.

## localStorage shim (install BEFORE anything else)
> === localStorage shim (install BEFORE anything else can touch it) ======
> This is the SECOND half of the "no profile dialog" fix. The FIRST half
> (startupUserAccount=0 in the NACP + removing the startup `void storage
> .length`) stopped the dialog at app boot. But nx.js's native localStorage
> getter STILL lazily launches the profile-picker applet on first access —
> and RPG Maker MV games/plugins reference `localStorage` directly during
> script eval (before installSdSaves overrides StorageManager). That
> re-triggered the dialog when the user pressed A on a game tile.
>
> installLocalStorageShim() replaces globalThis.localStorage with an
> in-memory + SD-card-backed shim (sdmc:/switch/burialnx/localstorage.json)
> that never touches account save data. Installed here, at the very first
> init step, so it is in place for the entire app lifetime — library,
> game launch, script eval, gameplay, autosave, everything. Idempotent.

## Splash helper note
> Splash + fatal-error helpers live in src/splash.ts. drawSplash takes the
> 2D context as a parameter (ctx is a module-level binding here, not a
> global), so the call site passes it explicitly.

## Switch user selection (profile dialog suppression)
> === Switch user selection (fully disabled — no profile dialog) ========
> Two things cooperate to suppress the "select a user" profile dialog:
>
>   1. tools/build.mjs patches the NACP with startupUserAccount = 0, so the
>      Switch OS does NOT preselect a user or pop its own profile picker at
>      launch, relaunch, post-sleep resume, or return from a forwarder.
>
>   2. THIS block deliberately does NOT touch localStorage. nx.js implements
>      localStorage on top of account save data; the very first access to
>      localStorage lazily calls libnx `accountGetPreselectedUser`, and
>      when no user is preselected (startupUserAccount=0) that call falls
>      back to LAUNCHING THE PROFILE-PICKER APPLET — i.e. exactly the
>      dialog we are trying to avoid. An earlier version of this block did
>      `void storage.length;` "to mount save data early"; that single line
>      was the reason the dialog kept appearing at startup even after the
>      NACP flag was flipped. It is gone now.
>
> Nothing the app does at startup needs a user:
>   • settings.json and library.json are on the SD card via
>     Switch.writeFileSync at sdmc:/switch/burialnx/;
>   • RPG Maker MV game saves are on the SD card via installSdSaves()
>     overriding StorageManager to write .rpgsave files in the per-game
>     save folder;
>   • the autosave snapshot in src/game-compat.ts is redirected to the SD
>     card too (see that file) so it never reaches localStorage mid-game.
> So no user is requested, no dialog appears, and the app boots straight
> into the library grid on every launch.

## Heap budget diagnostics
> Log how much memory the runtime actually granted (the nxjs.ini
> [memory] heap_limit request) so debug logs prove the heap budget.

### `memoryUsage` try/catch (inline marker)
> memory diagnostics are optional

## Languages / selected-game / last-frame / loading-screen / roundedRectPath notes
> Languages discovered for the currently-selected game (scanned at launch).
> Empty when no .cld packs are present; the game then uses the default English
> data embedded in data/. The user's choice is persisted per-game in the
> LIBRARY FILE (sdmc:/switch/burialnx/library.json), NOT localStorage, so it
> works in forwarder NROs which have saveData=0 (localStorage unavailable).

> The code of the language pack currently loaded into the running game, or ''
> when only the default English data is in use. Drives the pause-menu label.

> Wall-clock timestamp of the last frame() call. Used by the frame loop to
> detect system sleep/wake: rAF is tied to display vsync, which stops when
> the console sleeps, so a >1 s gap between consecutive frame() calls means
> the console slept and woke. (nx.js v1.0.0-beta.7 exposes NO applet
> lifecycle hooks — appletGetMessage/AppletHook are not bound, and devkitPro
> is not available in this environment to build a native applet-hook
> extension — so the rAF gap is the only reliable wake signal; see the
> WAKE_GAP_MS comment in frame-loop.ts for why 1000 ms is the threshold.)

> The recovery is handled entirely by src/sleep-recovery.ts: save the live
> game to a HIDDEN FILE (bypasses StorageManager entirely so the game's
> save/load UI never sees it), write a marker, teardown, and chain-launch a
> FRESH process (fresh GPU surface — nx.js has NO in-process GPU surface
> recovery after wake, and all earlier in-process attempts to resume the
> game crashed). The fresh process reads the marker here at boot
> (see consumeSleepMarker below)
> and auto-loads the hidden slot so the player resumes where they were.

> S.gameStopped is initialized in src/state.ts (createState). The flag is
> set to true by teardownGame() so the SceneManager.updateMain wrapper
> returns early after the game is retired.

> Loading progress bar state + renderLoading/setLoadingProgress/resetLoading
> live in src/loading-screen.ts; they're imported above. The frame loop
> calls renderLoading(ctx) on the 'loading' and 'forwarder-building'
> phases, and launch()/startForwarderBuild() drive the progress via
> setLoadingProgress()/resetLoading().

> roundedRectPath (used by renderLoading, renderPauseMenu, renderQuitDialog,
> renderNoticePopup) lives in src/canvas-utils.ts and takes ctx as a param.

## Plus-button exit guard state
> === Plus-button exit guard state ======================================
> realExit (Switch.exit bound to Switch) lives in src/game-lifecycle.ts and
> is imported below. Plus(+) hold timer — the quit dialog only appears when
> + is held for 500ms (like Minus for the pause menu). Prevents accidental exits.

## Game session snapshot note
> Game session snapshot (interface + beginGameSession/endGameSession) lives
> in src/game-session.ts. It snapshots globalThis at launch and restores it
> during teardown so the next launch starts from a clean realm. The two
> functions are imported above and called from launch() and teardownGame().

## `teardownGame` (doc comment)
> Completely stop the running game and release everything it holds: game
> audio, the requestAnimationFrame loop, decoded image/bitmap pixel
> buffers, every global the game or its host added to this realm (see the
> game session snapshot above), and our host references. A final GC pass
> returns the freed native buffers to the heap right away. Used by the
> quit path ("Quit BurialNX" and B on the error screen) before Switch.exit(),
> so no part of a stopped game can keep running, keep playing sound, or
> hold on to memory while the runtime tears the process down.

## Library state
> === Library state ======================================================
> The library is the entry point for the loader. The user picks a game from
> the grid; their choice populates `selectedGame`/`sharedSaves`/`selectedMod`
> /`saveLocation` and the existing launch flow takes over. The library file
> lives at sdmc:/switch/burialnx/library.json and replaces the legacy
> single-game settings.json on first load.

> S.libraryCursor and S.libraryPage are initialized in src/state.ts.
> libraryCursor indexes into library.games plus the 3 action tiles.
> LIBRARY_COLS/ROWS/PAGE_SIZE/ACTION_TILES constants live in src/render-library.ts
> (imported above) alongside renderLibrary/drawPlaceholderCover.
> coverCache (the Map of loaded cover Image objects) lives in src/cover-cache.ts
> alongside loadCoverImage/invalidateCoverCache; both are imported above.

## Add-game-name state
> === Add-game-name state ==============================================
> When the user picks a game folder via +Add Game, we open the software
> keyboard so they can name the game before it's added to the library.
> The suggested name is derived from the folder name or a .exe file in
> the parent folder.

## Keymap state
> === Keymap state =======================================================
> Two keymaps are tracked separately:
>   - globalKeymap: the default loaded from sdmc:/switch/burialnx/keymap.json
>     at startup. Used when a game has no per-game keymap of its own.
>   - editingKeymap / keymapTarget: the working copy the user is currently
>     editing in the keymap phase, and what it targets ("global" or a
>     specific library entry). Per-game keymaps live inside LibraryEntry so
>     each added game can have a fully independent binding set.

## Load-library init note
> Load the library (migrates from settings.json on first run).

## Load global keymap init note + editor seed
> Load the global keymap (used as the default when a library entry has no
> per-game keymap of its own).

> Seed the working copy with EVERYTHING the loaded map carries
> (labels, keyCodes, sticks), not just buttons — otherwise the
> first time the editor opens it would show 'none' for sticks
> even when keymap.json has stick bindings saved.

## Position library cursor on last-played
> Position the library cursor on the last-played game, if any.

### `lastPlayed` lookup try/catch (inline marker)
> ignore

## Legacy settings.json read
> Legacy settings.json is still read for backward compatibility with the
> old startupSelection() flow used by the debug build. It is only consulted
> if no library entry resolves to the same root.

### Legacy settings upsertGame try/catch (inline marker)
> keep empty S.library

## log module / panel / truncateForDisplay / keymap-layout-geometry cross-references
> log(), snapshotRuntimeLog(), debugLines, hostLogPath, logsPath, and the
> console-method overrides all live in src/log.ts (imported at the top of
> this file). The log module's one-time startup init (mkdir + truncate +
> first diagnostic lines) runs at import time, before this file's body.
> panel(lines, full) lives in src/canvas-utils.ts and is also imported; it
> takes ctx as its first parameter, so callers use `panel(ctx, …)`.

> truncateForDisplay lives in src/canvas-utils.ts (imported above).
> The keymap data tables (KEYMAP_COLORS, KEYBOARD_LAYOUT, KEYCODE_TO_VKEY),
> the pure spatial-navigation helpers (getAllPickKeys, findNearestKey,
> prevKey, nextKey), and the keymap page geometry (KEYMAP_* consts,
> keymapButtonCellRect, keymapKbOrigin, keymapKeyRect, keymapBackButtonRect,
> pointInRect, drawBackButton) all live in src/keymap-layout.ts and
> src/keymap-geometry.ts, imported above. drawBackButton takes ctx as a
> parameter (ctx is a module-level binding here, not a global).

## Keymap editor phase notes
> Phase 1 = button grid (select which joycon button to edit)
> Phase 2 = keyboard+mouse (pick a key to bind)

## Save/Load keymap override + stick/button binding cross-reference
> Save/Load keymap override (saveLoadKeymapActive, savedGamepadMapper,
> overrideKeymapForSaveLoadScene) lives in src/save-load-keymap.ts and is
> imported above. Stick/button binding polling (pollStickBindings,
> pollButtonBindings, makeSyntheticKeyboardEvent) lives in
> src/stick-bindings.ts and is also imported. The frame loop calls
> pollButtonBindings(currentEntry, globalKeymap) each game frame, and
> launch()'s Input._updateGamepadState wrapper calls
> pollStickBindings(currentEntry, globalKeymap) after the game's own
> gamepad state update (see the wrapper comment in launch()).

## Scene diagnostics cross-reference
> Scene diagnostics (observedScene, sceneSince, lastSceneReport, snapshotScene,
> diagnoseScene, resetDiagnostics) lives in src/diagnostics.ts and is
> imported above. The frame loop calls diagnoseScene(now, runtime, fps, log,
> snapshotRuntimeLog) each game frame; teardownGame() calls resetDiagnostics()
> to drop the scene references so they don't pin the sprite graph in memory.

## Game options count
> Play, Pick cover, Auto-detect, Edit keymap, Reset keymap, Rename game,
> Change mod folder, Toggle mod, Toggle shared saves, Change save folder,
> Language (conditional, only when 2+ languages), Create/Recreate forwarder,
> Delete forwarder, Delete, Back = 14 or 15 options depending on language count.

## Game-options languages note
> Languages discovered for the game currently shown in the game-options screen.
> Scanned synchronously (readDirSync) when entering the options screen; the
> display names are resolved lazily (codes are used if a .cld can't be read).

## library-nav cross-reference
> libraryTileCount(library, actionTiles) and libraryNavigateRow(cursor, total,
> cols, direction) live in src/library-nav.ts (imported above). The frame
> loop calls libraryTileCount(library, LIBRARY_ACTION_TILES) and
> libraryNavigateRow(...) for the library grid's Up/Down navigation.

## Session listener registration
> === Session listener registration =====================================
> Registered LAST, after every state variable the listeners close over is
> initialized, so an event dispatched during synchronous init cannot trip a
> TDZ. This single process-wide registration installs the
> error/unhandledrejection reporters and the beforeunload guard (see the
> session-lifetime listeners above) for the lifetime of the app. There is
> no session reboot: "Quit BurialNX" (and B on the error screen) perform a
> full teardown + Switch.exit, so the next launch is a guaranteed clean
> cold boot from hbmenu — Horizon OS reclaims the reserved process memory
> on exit, which is the only reliably clean reset on this OS.

## Touchscreen listener for keymap pages
> === Touchscreen listener for keymap pages ===========================
> nx.js dispatches TouchEvent on the global `screen` object. Register
> ONE touchstart listener at startup that routes taps on the keymap
> page to the same actions as the gamepad A button — so the user can
> navigate and bind keys purely with the touch screen. Touches are
> ignored on every other phase so the game's own TouchInput handling
> (forwarded to RPG Maker MV in installGameCompatibility) keeps
> working during gameplay.

### Touch listener try/catch (inline marker)
> touchscreen not available on this device

## Forwarder auto-launch (--game <id>)
> === Forwarder auto-launch (--game <id>) ==============================
> A forwarder NRO is a small nx.js app whose own main.js just calls
>   new Switch.Application('sdmc:/switch/burialnx/burialnx.nro').launch('--game', '<id>')
> which (via envSetNextLoad, see source/ns.cc) chains into this NRO with
> `--game <id>` on the argv. Here we parse that argument and, if the
> referenced game is in the library, jump straight into launch() — same
> flow as clicking the game in the library grid. If the game is missing
> or no id was given, we fall through to the library UI so the user can
> fix things (delete the stale forwarder, re-add the game, etc.).
>
> parseForwarderTarget lives in src/forwarder-argv.ts (imported above). It
> supports `--game <id>`, `--game=<id>`, `--game-id <id>`, `--game-id=<id>`,
> and the `--mod` flag (the forwarder builder emits the first form).

## Baked-in forwarder flag note
> Set to true if this NRO was built as a baked-in forwarder (no chain-load).
> Used by the re-launch detection to distinguish baked-in forwarders from
> legacy argv forwarders WITHOUT re-reading __FORWARDER_GAME_ID__ (which
> would create a second 64-'0' match in the romfs, breaking the forwarder
> builder's patchGameIdInRomfs search).

## Baked-in forwarder check (NEW approach)
> === Baked-in forwarder check (NEW approach — no chain-loading) ==========
> If this NRO was built as a forwarder (by patching the 64-'0' placeholder
> in the romfs at forwarder-build time), __FORWARDER_GAME_ID__ contains the
> target game's id. This means NO chain-loading was used (no
> envSetNextLoad), so quitting is a clean Switch.exit() → hbmenu.
>
> This is the PREFERRED forwarder mechanism. The legacy argv-based
> chain-load approach (--game <id>) is kept as a fallback for old
> forwarders built before this change.

### Baked-in forwarder try/catch (inline marker)
> constants not defined — normal burialnx launch

## Legacy argv-based forwarder check (fallback)
> === Legacy argv-based forwarder check (fallback for old forwarders) ====
> Old forwarders chain-load burialnx.nro with --game <id> on the argv.
> This sets envSetNextLoad, which is persistent on some hbloaders and
> causes re-chain loops. New forwarders use the baked-in approach above
> and never touch envSetNextLoad.

## Sleep-mode autoload marker
> === Sleep-mode autoload marker (consume early) =======================
> On wake from Sleep Mode, the PREVIOUS process (before chain-launching
> this fresh one) wrote a marker file recording {gameId, savedAt, bgm, bgs}
> after saving the live game to a HIDDEN file — see src/sleep-recovery.ts.
> If the marker is fresh (< 2 min), we record the requested gameId + audio
> on S so the launch flow below can auto-launch that game and, after
> startGame(), install the hook that loads the hidden save file. The marker
> is ALWAYS consumed (deleted) here whether fresh or stale, so a single
> wake cannot re-trigger on every subsequent boot.

## No boot-time exit detection
> No boot-time exit detection: the exit behavior flag is in-memory only and
> every load starts from the clean 'shutdown' default (see the exitBehavior
> lifecycle near the top of the exit section). The only boot-time cleanup is
> removing the obsolete .fwd-exit-flag marker file that versions 0.1.6–0.1.8
> left on the SD card — nothing reads it anymore.

## Forwarder auto-launch trigger
> === Forwarder auto-launch trigger =====================================
> Scheduled on the next tick (after the first frame is scheduled) so the
> loading screen can paint immediately. If a forwarder target was found
> and exists in the library, we load it into state and start the launch
> flow exactly as if the user had selected it from the library grid.
> If --mod was passed, force the mod on (override the library entry's
> modEnabled setting).

## Forwarder auto-launch trigger inline notes
> If the forwarder passed --mod, force the mod on.

> Show the loading bar immediately so the user sees
> feedback before the (async) launch starts.

> Defer one tick so the loading screen paints before the
> (synchronous-feeling) launch() work begins to block on
> SD reads. startOrChooseSaves() will either call launch()
> directly or open the save-choice panel.

## Sleep-mode autoload (library-launched game case)
> === Sleep-mode autoload (library-launched game case) =================
> A sleep marker was consumed above. Two cases:
>
>  (a) BAKED-IN FORWARDER + sleep marker: the forwarder auto-launch
>      block above already starts the correct game. We only need to
>      sanity-check that the marker's gameId matches the baked-in id
>      (a mismatch means the marker is stale or for a different game —
>      discard the autoload slot so launch() doesn't try to load a
>      save that doesn't belong to this game). On match, leave the
>      slot set so launch() arms the autoload hook after startGame().
>
>  (b) NO FORWARDER (library-launched game that was running when the
>      console slept): auto-launch the recorded game here, exactly as
>      the forwarder block above does but keyed on sleepAutoloadGameId
>      instead of forwarderTargetId. launch() then arms the autoload
>      hook and the player resumes at their saved position.
>
> If the marker's gameId doesn't resolve to a library entry (game was
> deleted between sleep and wake), the autoload is silently discarded
> and the library grid shows as normal — the hidden .rpgsave file is
> still on the SD card in the game's old save folder, but there's no
> game to load it into.

## Sleep autoload case inline notes
> Case (a): forwarder + marker. Verify match.

> else: match — forwarder block above started the game; launch()
> will read S.sleepAutoloadPending and arm the autoload hook.

> Case (b): library-launched game. Auto-launch it.
