# BurialNX

An optimized Nintendo Switch homebrew runtime environment for **The Coffin of
Andy and Leyley** (TCOAAL), built around nx.js and a targeted RPG Maker MV
compatibility host.

## Project Scope & Compatibility

> [!IMPORTANT]
> **BurialNX is a specialized loader, not a universal RPG Maker MV player.**
> Its runtime behavior and compatibility code are tailored to TCOAAL's
> specific memory demands, asset layout, and plugin footprint. Other RPG Maker
> MV deployments are not supported, and compatibility with every version or
> mod of TCOAAL is not guaranteed.

The project loads an independently supplied game deployment; it is **not a
decompilation or recreation of the game**. Gameplay has been reported working
on Switch, but additional hardware, game versions, and configurations require
testing. Back up saves before use.

BurialNX was informed by the earlier
[TCOAALBrowserLoader](https://github.com/Kidev-org/TCOAALBrowserLoader)
implementation. The original desktop deployment uses [NW.js](https://nwjs.io/);
BurialNX uses [nx.js](https://github.com/TooTallNate/nx.js) instead, without
the Switch WebApplet. The earlier loader and game behavior were inspected;
this is not a clean-room implementation. OpenAI Codex assisted with
investigation, implementation, tests, and documentation. See
[AGENTS.md](AGENTS.md), [WORKING.md](WORKING.md), and [NOTICE.md](NOTICE.md).

## Technical Highlights

- **Switch runtime integration:** Runs the game's JavaScript through nx.js,
  which builds on libnx, and supplies the browser-facing interfaces required by
  the game. The packaged application does not need Node.js on the console.
- **Memory-aware optimization:** A bounded 16 MiB cache reduces repeated
  reads of small assets and map data; large audio files are excluded. The
  renderer reuses appropriate canvas surfaces to reduce allocation churn.
- **File-system routing:** Resolves game resources and TCOAAL's hashed asset
  paths from a user-selected SD-card directory, with an optional unpacked mod
  overlay. Saves and loader settings are kept separate from the game files.
- **Input and display:** Maps Switch controller input to game-facing controls,
  provides fit/native display modes, and offers a long-press Minus menu for
  loader settings and FPS display.
- **Diagnostics:** An optional debug build exposes progress, runtime logs,
  and diagnostic snapshots for investigating compatibility and performance.

## Installation and Usage

1. Build `burialnx.nro` using [Building & Debugging](<Building & Debugging.md>).
   A separate `burialnx-debug.nro` is available for troubleshooting. No game
   content is needed to build the loader.
2. Copy the NRO to `sdmc:/switch/burialnx/` on a homebrew-enabled Switch.
   Launch it in application mode rather than the memory-limited Album applet
   mode, and select your Switch user.
3. Copy your own legally obtained TCOAAL game files to the SD card. For
   example, the folder layout can be:

   ```text
   sdmc:/switch/burialnx/burialnx.nro
   sdmc:/games/TCOAAL/
   ├── save/                  # optional existing PC saves
   └── www/
       ├── index.html
       ├── js/rpg_core.js
       ├── data/
       └── img/
   ```

   This is an example, not a fixed game path. In the picker, highlight the game
   folder containing `www/` and press X. A folder directly containing
   `index.html` and `js/rpg_core.js` also works. Use Up/Down to highlight, A
   to open a folder, and B to go back. Press Y instead of X when selecting a
   game only if you need the earlier loader's shared save keys.
4. Choose Switch user save data or an existing separate SD-card folder. You
   can optionally import compatible Steam saves from the game's `save/` folder
   into an **empty** destination; existing saves are not overwritten. The
   release build remembers the selected game and save location, prompting
   again if unavailable. The debug build asks for the game and mod on startup.

Hold Minus during gameplay to open the loader menu; navigate with Up/Down and
A, and close with B. The menu provides the game's load screen, display mode,
FPS display, save-location selection, Steam-save import, and mod selection.
Save-location and mod changes require restarting and do not move existing
saves. To load a mod, select an unpacked folder whose paths match the game's
`www/` tree; its files take precedence. Select Y for no mod. Archives are not
supported. Use only trusted games and mods: their scripts run with native
runtime privileges, and the loader is not a security sandbox. See
[SECURITY.md](SECURITY.md).

Switch saves belong to the selected user and application ID; an SD save folder
is shared between users. Game-path-specific save keys depend on the selected
path, so moving the game can change which saves appear. Loader settings are in
`sdmc:/switch/burialnx/settings.json`; they are not save files. Back up saves
with a trusted save manager before testing or changing storage. See
[Building & Debugging](<Building & Debugging.md>) for log collection and
reporting instructions. Debug diagnostics are stored under
`sdmc:/switch/tcoaal/LOGS/`; nx.js may also write
`sdmc:/switch/nxjs-debug.log`.

**Known limitation:** The Credits scene can hang or crash on Switch. Its title
menu entry is disabled and script requests to open it are skipped as a
temporary safeguard; this safeguard has been tested in desktop simulation but
still needs verification on Switch. Other versions and mods may encounter
additional issues.

## Legal Disclaimer

BurialNX is an independent homebrew project and is not affiliated with or
endorsed by the game's creators, Nintendo, Valve, or Steam. No game assets,
game files, ROMs, or proprietary Nintendo SDK code are included. Obtain game
files and mods legally and verify your right to use and distribute any artwork
or other third-party material. See [NOTICE.md](NOTICE.md) for licensing and
attribution information; this disclaimer is not legal advice.
