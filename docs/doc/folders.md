# `folders.ts`

`folders.ts` provides a `FolderBrowser` class that lets the user navigate the SD-card directory tree with gamepad input to pick a game folder, mod folder, saves folder, image file, or arbitrary file path. It also exposes `gameRoot()`, which locates the game's `www` root (or the folder itself) by probing for `index.html` and `js/rpg_core.js`. The browser supports several modes (`game`, `mod`, `saves`, `image`, `file`) with mode-specific listing and selection rules, and mirrors the game's A/B (confirm/cancel) button mapping so the picker feels native to the running game.

## `gameRoot` — candidate fallback (trailing catch)
> another candidate may work

## `FolderBrowser.refresh` — image mode file listing
> In image mode, files matching supported extensions are
> listed alongside directories.

## `FolderBrowser.refresh` — `.exe` cover extraction
> 'exe' is included so the user can pick a .exe file
> and have its embedded PE icon resource extracted
> as the cover (handled in src/cover.ts).

## `FolderBrowser.refresh` — file mode shows all files
> In file mode, ALL files are shown (for picking a name
> from any folder or file — used by the rename feature).

## `FolderBrowser.step` — confirm/cancel button mapping
> CONFIRM (the game's 'ok' button) opens/selects; CANCEL (the
> game's 'cancel' button) goes to the parent / cancels at root.
> confirmIndex/cancelIndex come from menuButtonIndicesFor() so
> the picker mirrors the game's A/B mapping — see frame-loop.ts.

## `FolderBrowser.step` — CANCEL navigation semantics
> CANCEL navigates to the parent folder. At the SD root, CANCEL
> cancels the picker for every mode (returns null), so the user can
> always back out to the previous menu — not just from the
> 'saves' / 'image' modes. The legacy 'game' purpose also
> returns null so the new library picker can be cancelled.

## `FolderBrowser.step` — file mode X button
> In file mode, X selects the CURRENT entry (folder or file) as
> the name source. A on a folder navigates into it; X on a
> folder picks it. A on a file picks it (handled above).
