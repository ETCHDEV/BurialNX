# `sleep-recovery.ts`

This module is the self-contained wake-detection + hidden-file autosave + fresh-process reload flow for Sleep Mode recovery. It exists because nx.js v1.0.0-beta.7 has no GPU surface recovery after the console wakes from Sleep Mode; the only reliable fix is to save the live game's state to a hidden file on the SD card, teardown the running process, and chain-launch a fresh NRO so the game resumes in a clean process with a healthy GPU surface. The fresh process reads a small marker file, auto-launches the right game, intercepts the first scene transition out of `Scene_Boot`, and loads the hidden save exactly as `Scene_Load.onLoadSuccess` would — then deletes the hidden file.

## Module-level rationale — THE PROBLEM

> nx.js v1.0.0-beta.7 has NO GPU surface recovery after the console wakes
> from Sleep Mode. The EGL/Skia surface holds stale syncpts, and the next
> heavy GPU present (a game launch's font-atlas + texture uploads) crashes
> with 0x95D (LibnxBinder BadValue — stale binder fence on eglSwapBuffers).
> Previous attempts to "continue in place" after wake (letting the game's
> own SceneManager.update guard resume) proved unstable on hardware: the
> game either froze on the next scene transition or fell into the nx.js
> error screen. None of the in-process recovery strategies worked.

## Module-level rationale — THE SOLUTION (per the user's design)

> When a wake is detected (a >1 s gap between consecutive frame() calls —
> rAF does not fire during sleep; see WAKE_GAP_MS in frame-loop.ts), do
> EXACTLY this, nothing else:
>
>   1. Save the live game's state to a HIDDEN FILE on the SD card
>      (sdmc:/switch/burialnx/.sleep-autosave.rpgsave), bypassing the
>      game's StorageManager entirely (no slot, no global-index update,
>      no file in the game's save folder). Uses the game's OWN
>      DataManager.makeSaveContents (which includes the interpreter-
>      rollback wrapper from game-compat.ts) + JsonEx.stringify +
>      LZString.compressToBase64 — the same serialization
>      saveGameWithoutRescue uses, just written to a different file.
>   2. Write a small marker file recording {gameId, savedAt, bgm, bgs}
>      so the fresh process knows which game to autoload and what audio
>      to replay.
>   3. teardownGame() — stop audio, retire the frame loop, drop image
>      caches, restore the realm, GC. Nothing keeps running.
>   4. chain-launch the SAME NRO the user is running (argv[0]) into a
>      FRESH process. A fresh process gets a fresh GPU surface, dodging
>      the 0x95D entirely. The chain does NOT touch the GPU.
>
> On the fresh process's boot, main.ts reads + consumes the marker. If it
> is fresh (< 2 minutes old) and the gameId matches a library entry (or
> this is a baked-in forwarder for that game), the loader auto-launches
> the game. After launch()'s startGame() returns, installSleepAutoload()
> hooks SceneManager.goto: the FIRST transition out of Scene_Boot (which
> would normally go to Scene_Title or Scene_Map for a new game) is
> intercepted and replaced with: read the hidden file → decompress → parse
> → DataManager.createGameObjects + extractSaveContents (the exact sequence
> loadGame uses) → $gamePlayer.requestMapReload() → goto(Scene_Map). The
> player resumes exactly where they were, in a clean process with a healthy
> GPU surface. After a successful load, the hidden file is DELETED.
>
> If ANY step fails (save fails, marker write fails, no library entry
> matches, load fails, hidden file missing), the loader falls back to the
> library grid (or the forwarder's normal auto-launch → title screen).

## Module-level rationale — WHY A HIDDEN FILE (not a save slot)

> An earlier version used slot 99 (above RPG Maker MV's default maxSavefiles
> of 20). But writing to a slot goes through DataManager.saveGame →
> StorageManager.save + saveGlobalInfo, which updates the global save index
> (global.rpgsave) and leaves a file99.rpgsave in the game's save folder.
> Some games/plugins derive the visible slot count from the index length or
> scan the folder, so a slot-99 save would APPEAR in the in-game Load menu
> — defeating the "hidden" requirement and causing the user to accidentally
> load the sleep autosave. By writing directly to a separate hidden file
> (bypassing StorageManager entirely), the game's save/load UI is
> completely unaffected: no slot, no index entry, no visible file.
>
> The save still captures EVERYTHING the game serializes (makeSaveContents
> includes map state, player, variables, self-switches, interpreter
> position — including the save-mid-choice rollback fix in game-compat.ts),
> because it uses the game's OWN serialization. Only the STORAGE LOCATION
> differs (a hidden file instead of a slot).

## `SLEEP_SAVE_PATH` — hidden-file rationale

> The sleep autosave is written to a SEPARATE HIDDEN FILE, NOT to one of the
> game's save slots. This is critical: writing to a slot (even one above
> maxSavefiles) goes through DataManager.saveGame → StorageManager.save +
> saveGlobalInfo, which updates the global save index (global.rpgsave) and
> leaves a file99.rpgsave in the game's save folder. Some games/plugins
> derive the visible slot count from the index length or scan the folder,
> so a slot-99 save would APPEAR in the in-game Load menu — defeating the
> "hidden" requirement. By writing directly to a hidden file (bypassing
> StorageManager entirely), the game's save/load UI is completely
> unaffected: no slot, no index entry, no visible file in the save folder.
> The file lives in the burialnx config dir (not the game's save folder),
> starts with a dot (hidden on most filesystems), and is only ever touched
> by sleep-recovery.ts.

## `SLEEP_MARKER_PATH`

> Marker file on the SD card. Tiny JSON. Written by handleWake(),
> consumed + deleted by consumeSleepMarker() at the next boot.

## `SLEEP_MARKER_TTL_MS`

> A marker older than this is considered stale and ignored. Generous on
> purpose: the chain-load + cold boot + SD-card I/O can take several
> seconds, and hbmenu may add its own delay before relaunching the NRO.
> 2 minutes is far longer than the actual reload takes but far shorter
> than any real "user walked away and came back hours later" gap.

## `saveGameForSleep`

> Save the live game's state to the hidden sleep-autosave file.
> Bypasses StorageManager entirely (no slot, no global index update) so
> the game's save/load UI never sees the save. Uses the game's OWN
> DataManager.makeSaveContents (which includes the interpreter-rollback
> wrapper from game-compat.ts for the save-mid-choice fix) + JsonEx.stringify
> + LZString.compressToBase64 — the same serialization saveGameWithoutRescue
> uses, just written to a different file.
> Returns true on success, false on any failure (the caller falls back
> to a marker-less reload so at least the GPU surface is refreshed).

### `saveGameForSleep` — saveBgm/saveBgs belt-and-braces note

> Match DataManager.saveGameWithoutRescue: save current BGM/BGS
> into $gameSystem BEFORE serializing, so the save captures what
> was playing (the audio is also captured separately by
> captureAudioState for the marker, but having it in $gameSystem
> too is belt-and-braces).

### `saveGameForSleep` — interpreter rollback note

> makeSaveContents serializes the full game state. The wrapper
> installed in game-compat.ts rolls back any interpreter waiting
> on a message so a save-mid-choice resumes correctly on load.

## `readSleepSave`

> Read the hidden sleep-autosave file. Returns the compressed (base64)
> string, or null if the file is missing/unreadable. The caller
> decompresses + parses + extractSaveContents.

## `deleteSleepSave`

> Delete the hidden sleep-autosave file. Called after a successful autoload
> so the file doesn't linger (a stale hidden save would be loaded on the
> next sleep wake even if the user made progress since). Best-effort.

## `captureAudioState`

> Capture the current BGM/BGS state directly from AudioManager. This is
> MORE reliable than relying on $gameSystem._bgm (which some games/plugins
> don't populate via saveBgm): it reads the actual audio buffer state at
> the AudioManager level — exactly what's playing through the speakers when
> the console sleeps. The captured descriptors are passed through the marker
> file and replayed in the fresh process after the map loads.
> Returns { bgm, bgs } where each is null (nothing playing) or a
> {name, volume, pitch, pos, ...} descriptor suitable for AudioManager.playBgm.

### `captureAudioState` — saveBgm semantics note

> AudioManager.saveBgm() returns the current BGM descriptor
> (with playback position) or an empty {name:""} object if
> nothing is playing. We keep both cases — replaying an empty
> descriptor is a no-op (silence), which is the correct state
> if no BGM was playing at sleep time.

### `captureAudioState` — empty-name filter note

> Only keep it if there's an actual name (a real track).
> An empty name means nothing was playing — don't replay.

### `captureAudioState` — _currentBgm fallback note

> Fallback: some engines expose _currentBgm directly.

## `writeSleepMarker`

> Write the sleep-autoload marker to the SD card. Records the game id
> (so the fresh process knows which game to auto-launch, for the
> library-launched case) and the captured BGM/BGS state (so the fresh
> process can replay the exact audio that was playing when the console
> slept — more reliable than $gameSystem._bgm). The save itself lives in
> a separate hidden file (SLEEP_SAVE_PATH), NOT in a slot, so no slot id
> is recorded.

### `writeSleepMarker` — defensive mkdir note

> Ensure the burialnx dir exists (it does in normal operation,
> but be defensive — the marker is useless if the dir is gone).

## `consumeSleepMarker`

> Read + delete the sleep-autoload marker. Returns the requested
> {gameId, bgm, bgs} if the marker exists AND is fresh
> (< SLEEP_MARKER_TTL_MS), otherwise null (and any stale marker is still
> deleted so it can't fire on a much later boot). The marker is ALWAYS
> consumed — a fresh one triggers the autoload; a stale one is silently
> cleaned up.

### `consumeSleepMarker` — always-remove note

> Always remove the marker once read, regardless of freshness, so a
> single wake does not re-trigger on every subsequent boot.

## `chainReloadSelf`

> Chain-launch the SAME NRO the user is currently running (argv[0]),
> into a FRESH process. The fresh process gets a clean GPU surface,
> which is the whole point of the reload. If argv[0] is unavailable or
> is not a .nro path, falls back to the canonical burialnx.nro path,
> then to burialnx-debug.nro.
>
> CRITICAL: app.launch() RETURNS normally after arming envSetNextLoad
> (it does not throw on success — see the matching comment on
> chainToLibrary() in game-lifecycle.ts). The caller must NOT treat a
> normal return as a failure.

## `isLiveGameRunning`

> Detect whether a live, SAVEABLE game is running — specifically, whether
> Scene_Map is the active scene. This is the gate for the wake handler's
> autosave+reload path.
>
> WHY Scene_Map IS REQUIRED (not just phase='game'):
> During Scene_Title / Scene_Load / Scene_Save, the game does SYNCHRONOUS
> SD-card reads (the save-slot list reads every slot's header to render
> the load menu). With 20 slots on a slow SD card, that easily exceeds
> the 1 s wake threshold — rAF doesn't fire during the sync reads. If
> we fired handleWake on that gap, we'd teardown the game + chain-reload
> EVERY TIME the user opens the Load menu — the app would appear to
> "crash/restart" on Continue. Requiring Scene_Map (real gameplay) means
> a > 1 s gap during a save/load menu is correctly recognized as a sync
> read, not a sleep, and ignored.
>
> The pause menu (hold Minus → phase='notice') overlays Scene_Map
> WITHOUT replacing it — SceneManager._scene is STILL Scene_Map while
> the pause menu is open. So isLiveGameRunning correctly returns true
> during the pause menu (the game is live and saveable).
>
> Returns true ONLY when:
>   - phase is 'game' AND SceneManager._scene is an instance of Scene_Map
>   - OR phase is 'notice' (pause menu) AND the underlying scene is
>     Scene_Map (checked the same way).
> Returns false for Scene_Title, Scene_Load, Scene_Save, Scene_Boot,
> and all non-game phases (library, options, picker, etc.).

## `isInSaveLoadScene`

> Detect whether the active scene is the in-game save/load menu
> (Scene_Save or Scene_Load). Uses the same instanceof check as
> save-load-keymap.ts's overrideKeymapForSaveLoadScene so the two modules
> agree on what counts as a "save/load scene".
>
> This is the gate for the wake handler's save/load-specific path
> (see handleWakeFromSaveLoad). When the console sleeps while a save/load
> menu is on screen, the previous "ignore the wake" behavior left the
> stale post-wake GPU surface live and the next render crashed the game.
> Now a wake during a save/load scene is handled explicitly: either save
> the underlying state + reload with autoload (in-game save/load), or
> exit to the library / quit the forwarder (title-screen save/load).
>
> Returns true ONLY when SceneManager._scene is an instance of the game's
> Scene_Save or Scene_Load. Returns false for Scene_Map, Scene_Title,
> Scene_Boot, and any scene a custom engine doesn't register under those
> two constructors.

## `hasLiveGameUnderneath`

> Detect whether a live, saveable game is in progress UNDERNEATH the
> current scene — i.e. a map has been loaded via New Game or Load, so
> $gameMap / $gamePlayer / $gameSystem / $gameSwitches / … are all
> populated with real play state.
>
> WHY $gameMap._mapId: RPG Maker MV's DataManager.createGameObjects() runs
> at Scene_Boot and constructs a fresh `new Game_Map()`, whose constructor
> sets `this._mapId = 0`. Game_Map.setup(mapId) — called only on New Game
> or Load — sets `_mapId` to the real map. So:
>   • On the title screen (and during Scene_Load opened FROM the title,
>     before a slot is picked): $gameMap._mapId === 0 → no live game.
>   • In-game (Scene_Map running, or Scene_Save/Scene_Load opened from the
>     pause menu over Scene_Map): $gameMap._mapId > 0 → live game.
>
> This is the distinction the user drew between "save/load screen" (in-game,
> save the underlying state + reload) and "title screen in save/load"
> (title's Load menu, no game to save — just exit). makeSaveContents only
> produces a meaningful save when a live game is underneath; calling it on
> the title screen would serialize an empty/default state.
>
> Returns true when $gameMap exists and has a numeric _mapId > 0.

## `handleWakeTitleSaveLoadExit`

> Wake handler for the TITLE-screen save/load case (Scene_Load opened from
> Scene_Title, no live game underneath). Per the user's spec: do NOT save
> anything — there's no game state to preserve — and just exit to the
> library (library-launched game) or quit the NRO to hbmenu (forwarder).
> This is exactly what the "+" quit dialog's "yes" does, i.e. quitApp().
>
> GPU-SAFETY: the wake left the EGL/Skia surface stale. quitApp()'s
> 'restart' branch calls chainToLibrary(), which arms envSetNextLoad +
> STOPS the event loop (no GPU touch) → the process exits cleanly and the
> fresh burialnx.nro boots to the library grid. quitApp()'s 'shutdown'
> branch (forwarder) DEFERS Switch.exit() via setTimeout(0) to avoid the
> re-entrancy crash of calling it synchronously inside frame() — which
> opens a window where rAF could fire and render on the stale surface.
> We set S.exitInProgress=true BEFORE quitApp() so frame() skips ALL
> rendering during that window (see the guard at the top of frame() in
> frame-loop.ts). The flag is never reset in-process (the process is
> dying); the fresh process starts with it false.
>
> A stale hidden sleep-autosave file (from an earlier wake whose autoload
> failed) is best-effort deleted here so it can't surprise a later boot.

### `handleWakeTitleSaveLoadExit` — stale-save cleanup note

> Best-effort: clean up a stale hidden sleep save so it doesn't
> linger and trigger a surprise autoload on a later library boot.

### `handleWakeTitleSaveLoadExit` — deferred-exit render-guard note

> Arm the deferred-exit render guard so frame() skips ALL rendering
> (the stale post-wake GPU surface would crash on any present).
> For 'restart' (chainToLibrary stops the event loop) this is
> belt-and-braces; for 'shutdown' (forwarder, deferred Switch.exit)
> it is the decisive guard against the rAF window.

### `handleWakeTitleSaveLoadExit` — quitApp branch note

> quitApp() reads S.exitBehavior:
>   'restart'  (library-launched game) → chainToLibrary() →
>              fresh burialnx.nro boots to the library grid.
>   'shutdown' (forwarder) → deferred Switch.exit() → NRO
>              exits to hbmenu.
> This is the "+ and confirm yes" flow the user specified.

### `handleWakeTitleSaveLoadExit` — fallback-on-quitApp-failure note

> quitApp failed before arming the chain/exit. Clear the
> guard (we're not in the deferred path anymore) and exit
> directly, removing listeners first to avoid recursion.

## `handleWakeFromSaveLoad`

> Wake dispatcher for a wake detected while a save/load menu
> (Scene_Save / Scene_Load) is on screen. Decides based on whether a live
> game is in progress underneath:
>
>   LIVE GAME UNDERNEATH (in-game save/load opened from the pause menu over
>   Scene_Map): save the underlying game state and reload with autoload.
>   The save/load menu is NOT part of DataManager.makeSaveContents (that
>   serializes $gameSystem/$gameMap/$gamePlayer/… — the paused game state,
>   not the menu UI), so saveGameForSleep produces exactly "the state
>   without the save/load screen". handleWake(true) does the full sequence:
>   capture audio → save hidden file → write marker → teardown →
>   chain-reload self. The fresh process auto-loads the hidden save and
>   lands the player in Scene_Map (the save/load menu is gone). This is
>   the user's requirement: "сохранять нужно без них … и перезагружать
>   игру с автозагрузкой этого сохранения".
>
>   NO LIVE GAME UNDERNEATH (Scene_Load opened from Scene_Title, no map
>   loaded yet): nothing to save. Exit to the library / quit the forwarder
>   via handleWakeTitleSaveLoadExit() (the "+ and confirm yes" flow).

## `currentGameIdForSleep`

> The game id to record in the sleep marker. Uses the current library
> entry's id when available; falls back to deriving one from the selected
> game root. For baked-in forwarders, the baked id is the source of truth
> (forwarderTargetId is set at boot from the romfs placeholder).

### `currentGameIdForSleep` — hashing note

> Mirror libraryIdFromRoot so the fresh process can match the
> marker's gameId against a library entry. Imported lazily to
> avoid a circular module init (game-library imports nothing
> from this module, but the lazy import keeps the dependency
> direction explicit and robust to future changes).

## `handleWake`

> Full wake handler. Called from the frame loop when a sleep→wake gap
> is detected. Performs the save → marker → teardown → chain-reload
> sequence. Every step is best-effort: if the save fails, we still
> teardown + reload (the player loses at most the last few seconds of
> progress, but the GPU surface is refreshed and the game restarts
> cleanly instead of freezing). If the marker write fails, we still
> reload — the fresh process just won't autoload, and the user lands
> on the library/forwarder launch as if they'd quit normally.
>
> `gameLive` is passed in by the caller (computed once from S.phase) so
> this function stays pure w.r.t. phase detection. When no game is live
> (library/options/etc.), the autosave+marker steps are skipped — there's
> nothing to preserve — and we just refresh the GPU surface.

### `handleWake` — step 0 (audio capture) rationale

> 0. Capture the current BGM/BGS state BEFORE any teardown.
>    This reads AudioManager directly (not $gameSystem._bgm,
>    which some games/plugins don't populate), so it captures
>    EXACTLY what was playing through the speakers. Must run
>    before saveGameForSleep/teardownGame stop the audio.

### `handleWake` — step 1 (save) rationale

> 1. Save the live game to the hidden slot. Best-effort: a
>    failed save does NOT abort the reload — the GPU surface
>    still needs to be refreshed or the next launch crashes.

### `handleWake` — step 2 (marker) rationale

> 2. Write the marker (only if the save produced a loadable
>    slot — a marker pointing at an empty slot would make the
>    fresh process's loadGame fail and fall back to the title
>    screen, which is still acceptable but noisier than just
>    not writing the marker). The captured audio is included
>    so the fresh process can replay it even if the game's save
>    format didn't store $gameSystem._bgm.

### `handleWake` — step 3 (teardown) rationale

> 3. Stop the game: audio, frame loop, image caches, realm
>    restore, GC. Nothing keeps running while the chain
>    arms the next process.

### `handleWake` — step 4 (beforeunload) rationale

> 4. Remove the beforeunload listener so the chain-load's process
>    teardown isn't held up by a recursive beforeunload handler.

### `handleWake` — step 5 (chain-reload) rationale

> 5. Chain-launch a fresh process. app.launch() arms envSetNextLoad
>    and stops the event loop WITHOUT touching the GPU (nx.js
>    source/ns.cc), so it is safe to call against the stale GPU
>    state. The process exits through the regular teardown path
>    once the current script unwinds.

## `installSavedAudioReplay`

> Install a ONE-SHOT hook on `Game_Map.prototype.autoplay` that, AFTER the
> original autoplay runs, replays the SAVED BGM/BGS.
>
> AUDIO SOURCE PRIORITY:
>   1. S.sleepAutoloadBgm / sleepAutoloadBgs — captured directly from
>      AudioManager at SAVE time (see captureAudioState in handleWake) and
>      passed through the marker file. This is the MOST reliable source:
>      it's exactly what was playing through the speakers when the console
>      slept, regardless of whether the game's save format stored
>      $gameSystem._bgm.
>   2. $gameSystem._bgm / _bgs — the standard MV save-field, restored by
>      DataManager.loadGame → extractSaveContents. Used as a fallback if
>      the marker didn't carry audio (older marker format, or capture
>      failed at save time).
>
> WHY THIS IS NEEDED: RPG Maker MV's `Game_Map.autoplay()` plays the MAP's
> autoplay BGM (from `$dataMap`), which is the map's DEFAULT track. If an
> in-game event changed the BGM mid-map (extremely common — cutscenes,
> battles, scene transitions all swap BGM), the saved BGM differs from the
> map's autoplay BGM. Without this hook, `autoplay()` plays the map's
> default and OVERRIDES the saved BGM → the player hears the wrong track
> (or silence, if the map has no autoplay BGM). With this hook, the saved
> BGM is replayed AFTER autoplay, so the player hears exactly what was
> playing when they entered sleep.
>
> The hook restores the original `autoplay` after the first call, so
> subsequent map transfers (which SHOULD play their own autoplay BGM) are
> unaffected.
>
> FALLBACK: if `Game_Map.autoplay` never fires within 1.5 s (e.g. the map
> data was already loaded by a preload so setup doesn't re-run autoplay,
> or a custom engine doesn't use the standard autoplay path), a setTimeout
> replays the saved BGM anyway. A shared `replayed` flag ensures the BGM
> is only replayed ONCE (no double-restart stutter) regardless of which
> path fires first.

### `installSavedAudioReplay` — audio-source priority note

> Priority 1: marker audio (captured from AudioManager at
> save time). Priority 2: $gameSystem._bgm (MV save field).

### `installSavedAudioReplay` — one-shot replay note

> Replay the SAVED BGM/BGS AFTER the map's autoplay ran,
> so the saved track wins over the map's default.

### `installSavedAudioReplay` — one-shot restore note

> One-shot: restore the original so normal map transfers
> (which SHOULD play their own autoplay) aren't affected.

### `installSavedAudioReplay` — fallback timer note

> Fallback: if autoplay doesn't fire within 1.5 s (map data was
> preloaded, or a custom engine skips the standard autoplay path),
> replay the saved BGM anyway. The `replayed` flag makes this a
> no-op if the autoplay hook already fired. 1.5 s is long enough
> for any reasonable map-data load to complete and autoplay to run.

## `installSleepAutoload`

> Install the sleep-autoload hook in a freshly-launched game. Called
> from launch() AFTER startGame() returns and S.phase is set to 'game'.
>
> The hook intercepts the FIRST scene transition OUT of Scene_Boot.
> RPG Maker MV's Scene_Boot loads the database ($dataSystem, $dataActors,
> ...) and then goto()s either Scene_Title (normal) or Scene_Map (when a
> "skip title" plugin is active). We replace that first goto with the SAME
> flow Scene_Load.onLoadSuccess uses, but reading from our HIDDEN save
> file (SLEEP_SAVE_PATH) instead of a StorageManager slot:
>
>   1. Read SLEEP_SAVE_PATH → LZString.decompressFromBase64 → JsonEx.parse
>      → the saved contents object (gameSystem, gameMap, gamePlayer, …).
>   2. DataManager.createGameObjects() — fresh $gameSystem/$gameMap/etc.
>   3. DataManager.extractSaveContents(contents) — overwrites the fresh
>      objects with the saved data (same as loadGame → extractSaveContents).
>   4. $gamePlayer.requestMapReload() — marks the player as transferring to
>      the CURRENT map. CRITICAL: without this, Scene_Map's performTransfer
>      does NOT call Game_Map.setup, so the map's events aren't initialized
>      and Game_Map.autoplay never fires.
>   5. installSavedAudioReplay() — arms a one-shot Game_Map.autoplay hook
>      so the saved BGM/BGS is replayed AFTER the map's autoplay runs.
>   6. SceneManager.goto(Scene_Map) — Scene_Map.start() → performTransfer
>      → Game_Map.setup(mapId) → loadMapData → autoplay (hook fires).
>
> Reading from a hidden file (NOT a slot) means the game's save/load UI
> is completely unaffected — no slot 99 in the Load menu, no global-index
> entry, no file99.rpgsave in the save folder. The save is truly hidden.
>
> After a successful load, the hidden save file is DELETED so it doesn't
> linger (a stale hidden save would be reloaded on the next sleep wake
> even if the user made progress since — the next sleep writes a fresh one).
>
> If the hidden file is missing or the load fails (corrupt, schema
> mismatch), the hook logs the failure and lets the original goto proceed
> — the player lands on the title screen and can start/load normally.
>
> The hook is ONE-SHOT: it removes itself after the first intercepted
> transition, so a later in-game Scene_Title → Scene_Map flow is unaffected.

### `installSleepAutoload` — boot-transition gate note

> ONLY intercept the boot→non-Boot transition: the current
> scene must BE Scene_Boot (so the database is loaded —
> Scene_Boot.start, which fires this goto, only runs once
> isReady() confirms the database is loaded), AND the
> target must NOT be Scene_Boot (otherwise we'd hijack the
> initial goto(Scene_Boot) that some SceneManager.run
> implementations use to start the boot scene).

### `installSleepAutoload` — read hidden save note

> Read the hidden save file (NOT a StorageManager slot).

### `installSleepAutoload` — decompress note

> Decompress + parse, exactly as loadGame → loadSavefileData
> does, but from our file instead of StorageManager.load(slot).

### `installSleepAutoload` — createGameObjects + extractSaveContents note

> createGameObjects freshens $gameSystem/$gameMap/etc.,
> then extractSaveContents overwrites them with the saved
> data. This is the exact sequence loadGame uses.

### `installSleepAutoload` — delete-after-load note

> Delete the hidden save so it doesn't linger and get
> reloaded on a later sleep wake after the user made
> progress. The next sleep writes a fresh one.

### `installSleepAutoload` — requestMapReload rationale

> CRITICAL: requestMapReload() marks $gamePlayer as
> transferring to the current map. Without this,
> Scene_Map.performTransfer does NOT call
> Game_Map.setup → the map's events are never
> initialized and autoplay never fires. This is the
> exact step Scene_Load.onLoadSuccess →
> reloadMapIfUpdated performs before goto(Scene_Map).

### `installSleepAutoload` — audio-replay arming note

> Arm the saved-BGM replay BEFORE goto(Scene_Map) so
> the hook is in place when Scene_Map eventually calls
> Game_Map.autoplay during map-data load.

### `installSleepAutoload` — restore-goto-before-call note

> Restore goto BEFORE calling it so the
> Scene_Map goto itself isn't intercepted
> (fired=true already guards it, but this is
> cleaner and self-uninstalling).

### `installSleepAutoload` — discard next-scene note

> Discard the boot→title/bookkeeping so the
> original goto doesn't try to resume a Boot
> scene we're about to replace.

### `installSleepAutoload` — pass-through note

> Not the transition we care about (e.g. the initial goto(Scene_Boot),
> or any in-game scene change after the autoload already fired) — pass
> through untouched.
