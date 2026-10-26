Here are all the generated files.

## BurialNX NRO files

This folder contains the built Nintendo Switch homebrew binaries for the
improved BurialNX loader.

### Files

- `burialnx.nro` — Release build (53.94 MiB). Use this for normal play.
- `burialnx-debug.nro` — Debug build (53.94 MiB). Adds diagnostic logging
  to `sdmc:/switch/burialnx/LOGS/native-host.log`, asks for save location
  on every launch, and exposes the snapshot/direct-screen menu items.

### Installation

1. Copy the desired NRO to `sdmc:/switch/burialnx/` on a homebrew-enabled
   Switch (Atmosphère).
2. Launch it in **application mode** (title override), not the memory-
   limited Album applet mode, and select your Switch user.
3. Both NROs share the same application ID `01a144e6a07a0000` so existing
   Switch save data is preserved.

### What changed in this build

- **Game library**: the loader now opens to a 4×2 grid of added games
  with cover thumbnails. The old single-game `settings.json` is migrated
  automatically to `sdmc:/switch/burialnx/library.json`. Add games via the
  `+ Add Game` tile or the Y button.
- **Plus button no longer exits**: pressing + in loader UI shows a
  confirmation (press + again within 2 seconds to quit); in-game it is
  silently swallowed so it neither closes the loader nor fires the game's
  cancel action. Use `Quit BurialNX` in the pause menu (hold Minus) to
  exit immediately.
- **Per-game key bindings**: each library entry can have its own joycon →
  virtual-key map stored in `library.json`. The library's `Keymap Settings`
  tile edits the global default; the game-options screen's `Edit keymap`
  entry edits the per-game override. Bindings are applied to RPG Maker MV's
  `Input.gamepadMapper` so a joycon button mapped to `ok` emulates the
  game's primary mouse/Enter action, `cancel` emulates right-click/Esc,
  and so on. Reset to global from the same screen.
- **Cover images**: the game-options screen exposes `Pick cover image`
  (browse for PNG/JPG/ICO on the SD card — ICO is decoded to PNG in
  memory) and `Auto-detect cover from .exe/.ico` (parses the PE resource
  section of a `.exe` in the game folder, or reads a `.ico` file, and
  extracts the largest embedded icon). Covers are stored as
  `sdmc:/switch/burialnx/covers/<game-id>.png`.
- **User selection at startup**: the Switch "select a user" step now
  happens once when the application starts (right after the splash),
  like a retail title — not the first time a launched game touches its
  saves. Title-override launches already carry a preselected user, so
  normally no extra dialog appears.
- **Rename with a real input field**: `Rename game` opens the Switch software
  keyboard pre-filled with the game's current name (cursor at the end); the
  returned text replaces the whole name at once. While the keyboard is
  open, pressing + is ignored instead of asking to quit. The inline swkbd
  never renders the typed text itself, so the loader draws a large input
  field as part of its own UI: the field shows the old name
  (`Renaming “…”`), a `Game name` label, the live text with caret, and an
  `N/64` counter. It re-reads `vk.value`/`vk.cursorIndex` from the virtual
  keyboard EVERY FRAME (nx.js keeps them current from the native swkbd
  callbacks), so the preview updates even if a `change` event is missed,
  and it is anchored directly above the keyboard's real on-screen
  rectangle (`vk.boundingRect`, filled by `show()` from the applet's touch
  rectangles) so it visibly reads as "the field this keyboard types into";
  without geometry it falls back to a top band no swkbd layout covers.
- **Returning to the library = quit and relaunch**: the separate "Back to
  library" pause-menu entry is gone. Returning to the library now means
  quitting BurialNX and relaunching it from hbmenu — a guaranteed clean
  cold boot. Horizon OS reserves the process memory and reclaims it on
  exit, which is the only reliably clean reset on this OS; an in-process
  session reboot (re-running the app bundle from `romfs:/main.js` in a
  fresh function scope) was implemented and hardened across several
  iterations but proved unstable on hardware: it froze on the "Loading…"
  splash with `FAILURE: ReferenceError: Graphics is not defined` (a late
  game frame referencing the deleted `Graphics` global escaped into nx.js,
  which terminates the whole process for any uncaught rAF exception). The
  full game teardown (audio, frame loop, image buffers, realm snapshot/
  restore, GC) is still performed before `Switch.exit()` — by "Quit
  BurialNX" in the pause menu and by B on the "game could not start"
  error screen — so no stopped game can keep running, keep playing sound,
  or hold native memory while the runtime tears the process down, and the
  next launch starts from a clean global scope.
- **Retired frame loop can no longer kill the process** (hardware fix for
  `Graphics is not defined`): the game's pending `requestAnimationFrame`
  callback is its ORIGINAL bound `SceneManager.update` — property stubs
  cannot reach it, and a frame already dequeued for the current vsync
  batch runs even after the teardown. Its `tickStart`/`tickEnd`/`catchException`
  reference the `Graphics` global that the realm restore deletes, so the
  old teardown let a `ReferenceError` escape into nx.js, which terminates
  the whole process for any uncaught rAF exception. Now (1) every frame id
  the game schedules is tracked and the queued ones are cancelled during
  teardown, and (2) EVERY manager method the bound `update()` can reach
  (`tickStart`, `tickEnd`, `catchException`, `stop`, …) is stubbed, so
  however the retired loop fires it is a complete no-op — including a late
  frame that lands between teardown and `Switch.exit()` on the quit path.
  On top of that, the session `error`/`unhandledrejection` listeners now
  cancel the dispatched events (nx.js otherwise kills the process for ANY
  uncaught exception or floating promise!) — the loader shows its own
  recoverable error screen instead.
- **Full game teardown (the quit path's first stage)**: before `Switch.exit()`,
  the game is stopped completely — audio off, the game's frame loop
  permanently retired, decoded image buffers released, and a full GC pass.
  The game runs in the loader's JavaScript realm, so every RPG Maker MV
  global (`$dataXXX`, `SceneManager`, `Graphics`, the patched `WebAudio`, …)
  used to survive on `globalThis` forever and keep its native audio buffers,
  renderer surfaces, fonts and timers pinned in memory. Each launch
  snapshots the global scope and teardown restores it: game-created globals
  are deleted, host-replaced values (`document`, `fetch`, `Image`, …) go
  back to the native originals, game fonts are removed from the font set
  and pending game timers are cancelled. "Quit BurialNX" (pause menu) and
  B on the "game could not start" error screen both perform this teardown
  before `Switch.exit()`, and the debug build logs the heap before/after
  the teardown GC pass (`_teardown: heap … MiB -> … MiB`).
- **Memory budget**: the embedded `nxjs.ini` now requests the maximum
  heap the nx.js runtime allows (`[memory] heap_limit = 512MiB`) up
  front, and disables the WebAssembly code-headroom reservation
  (`[v8] wasm = off`) that RPG Maker MV never uses — freeing roughly
  128 MiB of real RAM for the heap and native buffers. The debug build
  logs the granted heap size (`V8 heap limit=... MiB`) at startup.

### Verifying on Switch

This project is a JavaScript-based nx.js homebrew — the NRO format is
correct (not `.nso`, which would require a native devkitPro C/C++ build).
The NRO magic `NRO0` appears at offset 16 of the file. To verify
functionality, run on hardware and exercise:

1. The library grid renders and the cursor highlights the last-played game.
2. Adding a game via `+ Add Game` opens the SD folder picker and returns
   to the library with the new entry.
3. Pressing + in the library shows the quit confirmation; B dismisses it.
4. Editing per-game keymap (game-options → `Edit keymap`) changes only
   that game's bindings; the global default is left intact.
5. Auto-detect cover finds a `.ico` or `.exe` icon and renders it on the
   library tile.
6. The user is selected at application startup (only in launches that
   have no preselected user); entering a game never shows the profile
   dialog afterwards.
7. `Rename game` opens with the current name; the big input field above the
   keyboard mirrors every keypress the same frame (with caret and `N/64`
   counter), typing and saving replaces the name entirely, long names scroll
   inside the field, and pressing + while typing does nothing.
8. Play a game, open the pause menu (hold Minus) and choose `Quit BurialNX
   (exit to hbmenu)` (the last item): all audio stops immediately and the
   app exits to hbmenu. Relaunching BurialNX returns you to a clean library
   (a guaranteed cold boot — Horizon OS reclaimed the reserved process
   memory on exit). Entering the same game again starts it as cleanly as the
   first time, with working touch input. In the debug build the log shows
   `_teardown: heap X MiB -> Y MiB` (much smaller Y) before the exit, and
   `[v8] … free=… MiB` at startup is the normal application-mode reading,
   not an out-of-memory indicator.
9. The pause menu no longer has a `Back to library` entry — there is a
   single exit path (`Quit BurialNX`). Repeat the game → quit → relaunch →
   game cycle several times: every launch behaves the same as a cold boot.
10. If a game fails to start (“game could not start” screen), B exits
    BurialNX cleanly (teardown + `Switch.exit`) so the half-installed game
    state cannot pollute the next launch.
11. The exit itself must NOT freeze (the previous reboot build died on the
    “Loading…” splash with `Graphics is not defined`). Check the newest
    `LOGS/native-host_N.log`: no `FAILURE:` lines, and the app returns to
    hbmenu cleanly. Even a game that throws inside its own loop now shows
    the loader's red error screen (B exits to hbmenu) instead of a frozen
    “Press + to exit”.
12. `Quit BurialNX` stops all audio immediately and exits; the next launch
    of the loader (or of another homebrew app) starts normally, which
    confirms the memory was returned.
