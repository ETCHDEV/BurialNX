# `frame-loop.ts`

The single `requestAnimationFrame`-driven frame dispatcher for BurialNX. Reads gamepad buttons each frame, dispatches on `S.phase` to the per-phase input handlers, calls the matching renderer, and handles the Plus(+)/Minus(-) hold timers for quit/pause confirmation. This is the only top-level function that closes over the entire `S` state and the full set of imported helpers — that's why it lives in its own module instead of `main.ts`. It mutates essentially every field on `S` as the user navigates and calls into every render-*, selection-, keymap-, lifecycle-, and forwarder-helper module.

## File header
> // === Main frame loop =================================================
> // Extracted from main.ts. The single requestAnimationFrame-driven frame
> // dispatcher. Reads gamepad buttons each frame, dispatches on S.phase to
> // the per-phase input handlers, calls the matching renderer, and handles
> // the Plus(+) quit-confirmation hold timer. This is the ONLY top-level
> // function that closes over the entire `S` state and the full set of
> // imported helpers — that's why it lives in its own module instead of
> // main.ts.
> //
> // Mutates essentially every field on `S` as the user navigates. Calls into
> // renderLibrary/renderGameOptions/renderKeymap/renderRenameKb/pattern
> // panel/renderQuitDialog/renderNoticePopup/renderLoading/renderPauseMenu
> // via the render-* modules, into the selection helpers (loadEntryIntoState,
> // startOrChooseSaves, chooseSaves, remember, rememberLibrary,
> // setGameLanguage, getGameLanguage), into the keymap editor
> // (openKeymapEditor, applyPreset, saveEditingKeymap, handleKeymapTouch,
> // getAllPickKeys, findNearestKey), into the game lifecycle (quitApp,
> // chainToLibrary, teardownGame via quitApp), and into the forwarder
> // builder (startForwarderBuild, forwarderExists, deleteForwarder,
> // renameForwarder).

## Sleep/wake detection (above `GAME_OPTIONS_BASE_COUNT`)
> // === Sleep/wake detection =============================================
> // Wake detection lives in src/sleep-detect.ts. It has two layers:
> //   1. NATIVE (deterministic): Switch.appletConsumeSleepWake(), exposed by
> //      the patched nx.js runtime (patches/nxjs-applet-sleep.patch registers
> //      an AppletHook for AppletHookType_OnFocusState in source/applet.cc).
> //      Zero false positives — a synchronous load stall never changes the
> //      applet focus state, so only a REAL sleep→wake returns true.
> //   2. HEURISTIC (fallback for the stock runtime): a >WAKE_GAP_MS gap, but
> //      ONLY when the detector is ARMED (>= STEADY_FRAMES_TO_ARM consecutive
> //      steady frames in an armable phase). The game's own boot / first
> //      map-data load / map transfers produce gappy or blocked frames, so the
> //      detector stays DISARMED during them and a >1 s load stall is IGNORED
> //      — this is the fix for the "game restarted mid-load" false positive.
> // See src/sleep-detect.ts for the full rationale and thresholds.

## `frame` — deferred-exit render guard
> // === Deferred-exit render guard =====================================
> // A previous frame armed a DEFERRED exit (the sleep-wake
> // title-save/load path for a forwarder, which defers
> // Switch.exit() via setTimeout to avoid the re-entrancy
> // crash of calling it synchronously inside frame()). Between
> // that frame returning and the deferred exit firing, the
> // event loop may dispatch another rAF — and ANY render on the
> // stale post-wake GPU surface crashes with 0x95D. While this
> // flag is true, skip ALL work (rendering, input, scene
> // updates) and just re-arm rAF until the process exits.
> // See handleWakeTitleSaveLoadExit() in sleep-recovery.ts.

## `frame` — sleep/wake recovery
> // === Sleep/wake recovery ============================================
> // Detect a system sleep→wake via sleep-detect.ts (native applet hook
> // when the patched runtime is present, else a steady-frame-armed
> // heuristic). nx.js v1.0.0-beta.7 has NO GPU surface recovery after
> // wake — the EGL/Skia surface holds stale syncpts, and any heavy GPU
> // present crashes with 0x95D (LibnxBinder BadValue). The single
> // recovery strategy is handled by sleep-recovery.ts:
> //   1. If a game is live, save it to a HIDDEN autosave file
> //      (.sleep-autosave.rpgsave, bypassing StorageManager entirely
> //      so the game's save/load UI never sees it), write a marker
> //      file with {gameId, savedAt, bgm, bgs}, and teardown the game.
> //   2. Whether or not a game is live, chain-launch the SAME NRO
> //      (argv[0]) into a FRESH process — fresh GPU surface, no
> //      stale syncpts. The chain does NOT touch the GPU.
> //   3. The fresh process reads the marker at boot and auto-loads
> //      the hidden save, so the player resumes exactly where they
> //      were. If no game was live, the fresh process just boots to
> //      the library (or the forwarder's auto-launch) as normal.

## `frame` — wake-detection guard for game-phase menus and save/load
> // GUARD: a game-phase NON-Scene_Map scene (Scene_Title / Scene_Boot
> // / Scene_Load / Scene_Save) does SYNCHRONOUS SD-card reads as
> // part of normal operation. Reloading there loses the player's
> // position-to-title and gains nothing (those scenes render
> // lightly, so a stale GPU surface usually survives). So a wake
> // detected during a game-phase menu is IGNORED — the same
> // accepted edge case as before. Only real gameplay (Scene_Map)
> // and the non-game UI phases trigger a reload.
> //
> // EXCEPTION (the save/load fix): a wake during a save/load MENU
> // (Scene_Save / Scene_Load) is NOT ignored — the stale post-wake
> // GPU surface crashes the game on the menu's next render (the
> // reported bug: "при выходе из сна игра крашится"). We dispatch
> // to handleWakeFromSaveLoad(), which:
> //   • IN-GAME save/load (opened from the pause menu over
> //     Scene_Map, $gameMap._mapId > 0): saves the UNDERLYING game
> //     state (makeSaveContents serializes the paused game, NOT the
> //     menu UI) to the hidden sleep-autosave file, teardown, and
> //     chain-reload self. The fresh process auto-loads the save →
> //     the player resumes in Scene_Map (the save/load menu is
> //     gone). "сохранять нужно без них … и перезагружать игру с
> //     автозагрузкой этого сохранения".
> //   • TITLE save/load (Scene_Load from Scene_Title, no live game):
> //     saves nothing, exits to the library / quits the forwarder
> //     (the "+ and confirm yes" flow).

## `frame` — wake-detection guard notes
> // Game-phase menu (title/boot) — ignore the wake.

> // Non-game UI (library, options, picker, …) — no saveable
> // game, just refresh the GPU surface.

> // scroll long names in library tiles

## `frame` — dynamic confirm/cancel button indices
> // Dynamic confirm/cancel button indices for the loader's OWN
> // menus (save-choice, game-save-choice, import-confirm, notice,
> // pause menu). If the active keymap (per-game merged with the
> // global default) maps Nintendo A/B to ok/cancel, the menus
> // mirror that assignment so a player who swapped A/B for the
> // game gets the SAME swap in every loader screen. See
> // menuButtonIndicesFor() in src/keymap.ts for the exact rule.
> // `mc` / `mx` are the CONFIRM / CANCEL button indices; `lc` /
> // `lx` are their printable letters ('A'/'B') for panel hints.

## `frame` — library phase, D-Left/D-Right horizontal movement
> // Horizontal: D-Left/D-Right move by one tile,
> // wrapping through the whole list (row 0
> // col 0 ← wraps to the last tile, etc.).

## `frame` — library phase, D-Up/D-Down vertical movement
> // Vertical: D-Up/D-Down move by a FULL ROW
> // (LIBRARY_COLS), preserving the column, so the
> // user can move between the two rows of the 4×2
> // grid instead of stepping one tile at a time.
> // Wraps top↔bottom on the same column. Only
> // active when there are 2+ rows; on a single-
> // row grid Up/Down are no-ops (Left/Right cover
> // all horizontal movement already).

## `frame` — library phase, page boundary
> // Page boundary: switch page when crossing rows.

## `frame` — library phase, X on entry → scan for .cld language packs
> // Scan for .cld language packs so the "Language" option
> // only appears when the game ships 2+ languages (any .cld
> // counts as 2+ because the embedded English data is always
> // available). Synchronous readDirSync; names resolved lazily.

## `frame` — library phase, Y button (add game)
> // Y = Add game from anywhere in the library.

## `frame` — library phase, L/R shoulder reordering
> // L/R shoulder buttons move the selected game up/down
> // in the library order. The 3 action tiles (Add, Keymap,
> // Quit) are always at the end and can't be moved.

> // L = up, R = down

> // Move the cursor to follow the game's new position.

> // Keep the cursor on the current page.

## `frame` — game-options phase, Language item (Left/Right cycle)
> // Left/Right on the Language item cycles through available
> // languages with auto-confirm (no A press needed). Whatever is
> // shown is saved immediately and applies on the next launch.

> // Left

> // Right

> // Play a soft click so the user gets feedback.

## `frame` — game-options phase, cursor index labels
> // Play

> // Pick cover image

> // Auto-detect cover

> // Edit per-game keymap

> // Reset to global keymap (clear per-game override)

## `frame` — game-options phase, Rename choice
> // Rename game — show a choice: type a custom name,
> // use the folder name, or use the .exe file name.

> // reset for the choice panel

> // Select/change mod folder

> // Toggle mod on/off

> // Toggle shared saves

## `frame` — game-options phase, save folder
> // Change save folder — opens the save-choice phase

## `frame` — game-options phase, Language item (A cycles forward)
> // Language — A also cycles forward (same as Right), auto-saved.
> // Left/Right handling is in the navigation block above.

## `frame` — game-options phase, forwarder/delete/back offset mapping
> // Forwarder / delete / back are at the END of the list, but
> // their cursor index shifts by +1 when the language option
> // is present (it's inserted at index 10). Map by offset.

> // Create / Recreate forwarder NRO

> // Delete forwarder NRO

> // Delete

## `frame` — game-options phase, Delete action also removes forwarder
> // Also remove the forwarder if present, so the SD card
> // doesn't keep a stale shortcut to a deleted game.

> // Back

## `frame` — keymap phase, phase 2 (keyboard+mouse picker)
> // Phase 2: keyboard+mouse navigation (spatial)

> // Up

> // Down

> // Left

> // Right

> // CONFIRM: bind the selected key

> // Stick direction binding

> // CANCEL: back to button grid

## `frame` — keymap phase, phase 1 (button grid)
> // Phase 1: button grid navigation (24 entries: 16 buttons + 8 stick dirs)

> // CONFIRM: enter keyboard picker for this button/stick

> // X: clear binding (set to none)

> // CANCEL: back to library/game

> // Presets

## `frame` — rename-choice phase
> // Choose how to rename: type a custom name, or browse
> // for a folder/file to take the name from.

> // CANCEL: back

> // Option 1: Type a custom name — open the keyboard.

> // Rename the forwarder if it exists at the old name's path.

## `frame` — rename-choice phase, Option 2 (browse for name source)
> // Option 2: Browse for a folder or file to take the name from.
> // Opens the folder browser starting at the game's parent folder.
> // Uses 'file' mode so ALL files are visible (not just folders).

> // Render the choice panel.

## `frame` — rename-kb / add-game-name phase
> // Swkbd is open — render the live preview of the name being typed.
> // Do NOT process gamepad input here: the keyboard owns it.

## `frame` — rename phase (character cycling)
> // Character-cycling rename: Up/Down cycle the char at cursor,
> // Left/Right move cursor, A confirms, B cancels.

> // Up: cycle char backward

> // Down: cycle char forward

> // CONFIRM: save

> // CANCEL: back

## `frame` — picker phase, add-game naming keyboard
> // Open the software keyboard so the user can name the
> // game before it's added to the library. The suggested
> // name is derived from the folder name or a .exe file
> // in the parent folder.

> // No swkbd available — add with the suggested name.

## `frame` — picker phase, cover-image pick — explicit GC
> // The .exe can be several MB; explicitly run GC so the
> // ArrayBuffer is freed before the cover Image is decoded
> // on the next renderLibrary call (avoids OOM crashes on
> // Switch's limited heap).

## `frame` — picker phase, game-mod
> // Select/change mod folder from game options

## `frame` — picker phase, rename-source (last segment / strip extension)
> // Take the game name from the selected folder or file.
> // The result is a full sdmc: path — extract the last segment
> // (folder name or filename without extension).

> // If it's a file (has an extension), strip it.

> // Rename the forwarder if it exists at the old name's path.

## `frame` — picker phase, B at root cancels
> // B at root cancels the picker. For 'add-game', always
> // return to library (not game-options).

## `frame` — notice phase, exit-notice vs. popup
> // Use the centered quit dialog (compact, game visible).

> // Small centered popup (same style as the exit dialog)
> // for success/info notices — replaces the old
> // full-screen panel that hid the underlying screen.

## `frame` — notice phase, CANCEL/CONFIRM dismiss
> // CANCEL: return to previous phase.
> // For a non-exit notice (success/info popup), CONFIRM also
> // dismisses (acts as "OK") — same as CANCEL. For an exit
> // notice (exitNoticeArmed), CONFIRM is handled by the next
> // branch and confirms the quit/return-to-library.

## `frame` — notice phase, exit-notice CONFIRM
> // A: confirm quit/return-to-library. The exit
> // behavior flag (see the exitBehavior
> // lifecycle) decides what quitApp() does; the
> // dialog label was chosen when the notice was
> // armed — see the Plus handler and the
> // pause-menu 'quit' action.

## `frame` — error phase, exit on cancel
> // A failed launch leaves half-installed game state behind. Exit
> // the app (teardown + exit) so the next launch is a guaranteed
> // clean cold boot. The exit behavior flag armed at launch
> // decides the target: a forwarder-launched game fully shuts
> // down; a library-launched game returns to the library grid so
> // the user can fix things and try again. Horizon OS reserves
> // the process memory and reclaims it on exit, which is the only
> // reliably clean reset; an in-process session reboot proved
> // unstable on hardware (froze on the "Loading…" splash).

## `frame` — game phase, save/load keymap override
> // Override the gamepad keymap during Scene_Save and
> // Scene_Load so the confirm/cancel buttons always use
> // the DEFAULT menu layout (A=ok, B=cancel), not the
> // per-game remapped layout. This prevents confusion when
> // the user has remapped buttons for gameplay but expects
> // standard A/B in the save/load menu.

## `frame` — game phase, stick/pollButtonBindings placement & save/load skip
> // NOTE: pollStickBindings() is now called from the
> // _updateGamepadState wrapper (installed in launch()),
> // NOT from the frame loop. This ensures it runs AFTER
> // _updateGamepadState processes face buttons — so a
> // stick-driven vkey (e.g. R↓→ok → _currentState['ok'])
> // isn't overridden by _updateGamepadState's edge-detected
> // false for the same vkey. See the wrapper comment in
> // launch() for the full rationale. The wrapper ALSO skips
> // pollStickBindings while the save/load scene is active
> // (isSaveLoadKeymapActive) — see save-load-keymap.ts.
> //
> // SKIP pollButtonBindings while the save/load scene is
> // active: this is the fix for the "press B in the save
> // menu → game fast-forwards" bug. pollButtonBindings fires
> // Input._onKeyDown(B's keyCode) every frame; during
> // Scene_Save those keydowns leave stale _currentState
> // (e.g. pageDown=held) that Scene_Map reads as "fast-forward"
> // the moment the save menu closes. overrideKeymapForSaveLoadScene
> // also clears button-keyCode state on enter/exit so nothing
> // survives the scene boundary.

## `frame` — game phase, Minus hold timer
> // If Minus(-) is unbound in the game's keymap, the pause
> // menu opens immediately (holdMs=0). If bound, require
> // 800ms hold (so the game's binding fires on press).

> // Pass the dynamic confirm/cancel indices so the pause
> // menu mirrors the game's ok/cancel button mapping (the
> // same swap the save-choice / notice screens above use).

## `frame` — game phase, pause-menu 'keymap' action
> // During gameplay, edit the active game's per-game keymap
> // (so the change is scoped to this game) — or the global
> // default when no per-game override exists. Saving
> // re-applies the binding to runtime.Input immediately.

## `frame` — game phase, pause-menu 'keymap' action — auto-promote
> // Auto-promote: create a per-game keymap seeded with the
> // current global default so subsequent edits are scoped.
> // Copy EVERYTHING (buttons, labels, keyCodes, sticks) —
> // not just buttons. Previously this only copied buttons,
> // so the seeded per-game keymap had NO stick bindings
> // (and no keyCodes/labels). The keymap editor then showed
> // 'none' for every stick direction, and if the user re-bound
> // only the LEFT stick (because it was the one they cared
> // about at the moment), the per-game keymap ended up with
> // left-stick bindings only — and because the per-game
> // keymap took precedence over global in pollStickBindings,
> // the RIGHT-stick bindings the user had set globally were
> // silently ignored. Now the seed is a FULL copy of the
> // global keymap, so the editor shows the user's existing
> // bindings and they can edit individual directions without
> // losing the rest.

## `frame` — game phase, pause-menu 'quit' action
> // Pause-menu "Quit" (hold Minus, last item on page 1).
> // The exit behavior flag armed at launch decides:
> //   forwarder-launched game ('shutdown') — the user launched
> //   via a standalone shortcut and expects to leave BurialNX
> //   entirely;
> //   library-launched game ('restart') — relaunch burialnx.nro
> //   without --game so the library grid shows.

## `frame` — game phase, pause-menu Language cycle
> // Left/Right (or A) on the Language item cycle through available
> // languages with auto-confirm — the selected language is saved
> // immediately to the library file (SD card, NOT localStorage —
> // forwarder NROs have saveData=0) and applies on the next launch.
> // The pause-menu label shows the newly-selected language on the next render.

> // Update activeLanguageCode so the label re-renders with the new name.

## `frame` — Plus(+) quit dialog hold timer
> // Plus(+) quit dialog: if + has a game binding, require
> // 500ms hold (so the game's binding fires on single press
> // and the quit dialog fires on hold). If + is unbound,
> // single press shows the dialog immediately.
> //
> // The label comes from the exit behavior flag (see the
> // exitBehavior lifecycle), which is the single source of truth
> // for what the confirmation does:
> //   - Library grid (no game running): "Quit BurialNX?" / shutdown
> //   - Forwarder-launched game: "Quit BurialNX?" / shutdown
> //   - Library-launched game: "Return to library?" / restart

> // quitApp() reads the flag at confirm time; the label
> // is derived from the same flag so it can never lie.

> // Check if + (button 9) has a binding in the active keymap.

> // + has a binding → require 500ms hold.

> // + is unbound → single press shows the dialog.

## Trailing import rationale (lazy `setButton`/`setButtonWithLabel`)
> // Lazy require() for setButton/setButtonWithLabel — these live in the
> // keymap module and are also imported directly by keymap-editor.ts. We
> // import them lazily here only to avoid a redundant top-level import
> // (esbuild would tree-shake this anyway, but the explicit helper makes
> // the intent clear: the frame loop reads them at call time when the user
> // actually binds a key in the keyboard picker).

## `anyPressed` (module-scope helper)
> Zero-allocation replacement for `Array.from(buttons).some((b) => b.pressed)`
> — a plain indexed loop over the gamepad buttons, used at 12 call sites
> (one per phase) on the hot `waitForRelease` path. The original allocated
> a new array AND a closure every frame; this allocates nothing.

## `frame` — frame skip delta
> The "Frame skip" pause-menu slider sets `S.menu.frameSkipDelta` to -1/+1;
> the frame loop applies it to `S.frameSkip` (clamped 0..10) and persists
> the value to `sdmc:/switch/burialnx/frame-skip-settings.json`. The value
> is read by the `SceneManager.updateMain` wrapper in game-compat.ts.
