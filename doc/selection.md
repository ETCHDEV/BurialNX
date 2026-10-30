# `selection.ts`

This file holds the "current game selection" mutators extracted from `main.ts`: the functions that translate a library entry into the `S.selectedGame` / `S.sharedSaves` / `S.selectedMod` / `S.saveLocation` state consumed by `launch()`, the save-location picker that decides whether to import Steam saves before launching, plus pure validation (`validSaveLocation`), persistence (`remember` / `rememberLibrary`), and per-game language preference helpers (`getGameLanguage` / `setGameLanguage`).

## Module header
> === Selection helpers ===============================================
> Extracted from main.ts. The "current game selection" mutators — the
> functions that translate a library entry into the S.selectedGame /
> S.sharedSaves / S.selectedMod / S.saveLocation state consumed by
> launch(), and the save-location picker that decides whether to import
> Steam saves before launching.
>
> Also contains:
>   validSaveLocation()  — pure validation against the Switch fs.
>   remember() / rememberLibrary() — persist the selection / a library
>                          entry to settings.json / library.json.
>   getGameLanguage() / setGameLanguage() — per-game language pref
>                          (stored in library.json, not localStorage, so
>                          it works in forwarder NROs with saveData=0).

## Lazy `launch` import
> launch() is imported LAZILY (via the function call site, not the
> top-level import) to avoid a circular-init issue: game-launch.ts
> imports getGameLanguage from this module, and this module imports
> launch from game-launch.ts. ES module live bindings handle this fine
> as long as both functions are only CALLED at runtime (which they are).

## `getGameLanguage`
> Read the per-game language preference from the library entry (NOT localStorage).
> Returns: undefined = no preference (auto-select first .cld), '' = English,
> 'ru' = Russian, etc. Uses the library file on the SD card so it works in
> forwarder NROs (which have saveData=0, making localStorage unavailable).

## `setGameLanguage`
> Save the per-game language preference to the library file on the SD card.
> Works in both the main app and forwarder NROs (no localStorage needed).

## `loadEntryIntoState` (inline notes)
> Respect modEnabled: if the mod is disabled, don't apply it at launch.

> Remember the save location from the library entry. Both debug and
> release builds use the stored saves location so the user is never
> re-asked after the first launch.

## `chooseSaves` (inline note)
> Persist the save location into the library entry too.

## Re-export block
> Re-export the helpers the startup init block in main.ts still uses.
