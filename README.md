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
