# `game-library.ts`

This module defines the persisted library of added games: the `LibraryEntry`/`LibraryFile` interfaces, the strict `parseLibrary` validator, and helpers for upsert / move / remove / mark-played / lookup, plus a one-time legacy `settings.json` migration on first load.

## `LibraryEntry` interface — JSDoc

```
/**
 * A library entry is the persisted, editable description of one added game.
 * It is richer than {@link GameSelection}: it adds an id, display name, an
 * optional cover image path so the library UI can render a thumbnail grid,
 * and an optional per-game keymap that overrides the global default.
 *
 * Cover paths are absolute SD paths (`sdmc:/...`) that point at a regular file.
 * They are not stored as data URLs because the library file is meant to stay
 * small and editable, and because cover images can be large.
 */
```

## `LibraryEntry.keymap`

```
/** Per-game joycon key bindings. When absent the global default is used. */
```

## `LibraryEntry.lastPlayed`

```
/** ISO timestamp of the last launch. Used for sorting and "recent". */
```

## `LibraryEntry.language`

```
/** Per-game language preference: a .cld code (e.g. 'ru') or '' for
 *  English (default). Absent = no preference (auto-select first .cld).
 *  Stored in the library file (SD card), NOT localStorage, so it works
 *  in forwarder NROs which have saveData=0 (localStorage unavailable). */
```

## `LibraryFile.lastPlayed`

```
/** Id of the game to highlight / auto-launch on the next startup. */
```

## `parseLibrary()` — JSDoc summary

```
/** Reject corrupt or unsafe library files rather than guessing or overwriting. */
```

## `parseLibrary()` — keymap validation note

```
// The per-game keymap is optional but, if present, must be a
// valid KeyMap (16 buttons, all known virtual keys).
```

## `libraryIdFromRoot()` — JSDoc

```
/** Stable, URL-safe id derived from the SD path. Two entries with the same root
 * resolve to the same id, which keeps the library deduplicated. */
```

## `entryFromSelection()` — JSDoc

```
/** Convert a legacy single-game {@link GameSelection} to a library entry. */
```

## `loadLibrary()` — JSDoc

```
/** Load the library, or return an empty one. Migrates a legacy settings.json
 * the first time so existing users keep their remembered game. */
```

## `loadLibrary()` — legacy migration note

```
// Migrate the legacy single-game settings file the first time.
```

## `loadLibrary()` — parseSelection strictness note

```
// parseSelection is intentionally strict; ignore if invalid.
```

## `saveLibrary()` — JSDoc

```
/** Write the library atomically. A failure (e.g. read-only SD) is reported
 * through the boolean return value; callers can surface it to the user. */
```

## `moveGame()` — JSDoc

```
/** Move a game up (dir=-1) or down (dir=+1) in the library order. The three
 *  action tiles (Add Game, Keymap, Quit) are always at the end and never
 *  move. Swaps the game at the given index with its neighbor. No-op at the
 *  boundaries (first game can't move up, last game can't move down). */
```
