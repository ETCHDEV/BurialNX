# `saves.ts`

This module installs RPG Maker MV's `StorageManager` over the SD card (or `localStorage`) using an LZString base64 on-disk format compatible with MV's own save format. It implements crash-safe journaled writes, an in-memory exists-cache and decompressed-global cache to collapse the per-slot SD reads that dominate Save/Load scene open time, Steam save import, and the save-folder safety validators that prevent the writable save folder from being placed inside the game or mod directories.

## `SaveFiles` interface — `readDirSync?`

> nx.js exposes `Switch.readDirSync`; optional here so the unit-test
> MemorySaveFiles (which has no dir listing) still works. When present,
> the exists-cache is built with a SINGLE directory scan instead of one
> statSync per slot — the decisive speed-up for the Save/Load scene.

## `safeSaveFolder`

> Never put the writable save folder inside the game or mod directories.

## `safeGameSaveFolder`

> Only an explicitly selected game save directory may overlap the game.

## `ensureGameSaveFolder`

> Create the explicitly selected save directory only; do not touch saves.

## `installSdSaves`

> MV uses the same LZString base64 format on disk and in localStorage.

### `remove` (internal helper)

> nx.js removes directories recursively. A crafted save-folder entry
> must never turn a save cleanup into deletion of an entire directory.

### `write` (internal helper)

> A journal is left intact after an interrupted write; don't guess which
> copy is correct or overwrite it. The user can recover it manually.

### In-memory exists + global caches (Save/Load scene speed-up)

> RPG Maker MV's Scene_Save / Scene_Load list up to maxSavefiles() slots
> and, for EACH slot, call:
>   • StorageManager.exists(id)        → our `exists(path(id))`  (statSync)
>   • DataManager.makeSavefileInfo(id) → DataManager.loadGlobalInfo()
>                                       → StorageManager.load(0)
> `loadGlobalInfo` caches its parsed result via `_lastGlobalInfo === savefile`
> (string equality), so after the first slot it stops re-parsing — BUT each
> `StorageManager.load(0)` still re-reads global.rpgsave from the SD card
> and re-decompresses it, and each `StorageManager.exists(id)` is a
> synchronous statSync (one FS-service IPC round-trip per file, ~1-5 ms on
> the Switch's SD card). For the default 20 slots that is ~20 statSync +
> ~20 reads + ~20 LZString decompresses on EVERY scene open — the dominant
> cost of the "slots take long to load" complaint.
>
> We collapse that to:
>   • ONE readDirSync at install time (or a one-pass per-slot statSync
>     fallback when readDirSync is unavailable, e.g. in unit tests) builds
>     a Map<slotId, boolean> of every save file in the folder.
>   • manager.exists(id) becomes an O(1) Map lookup with populate-on-miss,
>     so even externally-written files (Steam import) are picked up on the
>     first query and cached forever after.
>   • manager.load(0) caches the DECOMPRESSED global string, so MV's own
>     `_lastGlobalInfo === savefile` cache hits on every call after the
>     first — no SD read, no decompress.
> Both caches are updated on save/remove/restoreBackup so they stay
> correct without any re-scan. Steam import (the only writer that bypasses
> the manager) calls manager.refreshSaveCache() after copying.

### `scanEntrySlot` (internal helper)

> Match exactly config.rpgsave / global.rpgsave / fileN.rpgsave (N=1..999).
> The trailing `$` excludes .burialnx-backup / .burialnx-journal siblings
> so they never pollute the slot set.

### `refreshExistsCache` (fallback branch)

> Fallback (no readDirSync, e.g. MemorySaveFiles in unit tests): one
> statSync per slot up to maxSavefiles. Still a single pass at install
> time, not per-scene-open.

### `globalCache` (internal cache variable)

> globalCache mirrors global.rpgsave's DECOMPRESSED content (what
> manager.load(0) would return after decompress). undefined = not yet
> loaded; null = loaded and the file is absent; string = loaded content.
> Returning a stable string reference lets MV's `_lastGlobalInfo === savefile`
> cache hit, skipping JSON.parse on every slot after the first.

### `manager.save` — keep-caches-in-sync notes

> Keep caches in sync with the new on-disk state.

> We just wrote `json` (decompressed) compressed to disk, so the
> decompressed form on disk is exactly `json`. Cache it directly —
> the next load(0) returns instantly with no SD read / decompress.

> id ≠ 0: the global file is untouched by this write. MV follows a
> slot save with saveGlobalInfo() → manager.save(0, …), which updates
> globalCache via the id===0 branch above. So we leave it alone here.

### `manager.exists` — populate-on-miss note

> Populate-on-miss: an external writer (Steam import before the
> refreshSaveCache call, or a hand-placed save) is still detected
> correctly with one statSync, then cached for every future query.

### `manager.remove` — global cache notes

> The global file itself was removed.

> id ≠ 0: MV's removeSavefile follows with saveGlobalInfo(), which
> rewrites global.rpgsave via manager.save(0, …) and refreshes
> globalCache. If a caller removes a slot without that follow-up, the
> on-disk global is unchanged, so globalCache stays accurate.

### `manager.refreshSaveCache`

> Rebuild the exists-cache from a fresh directory scan. Called by
> importSteamSaves after it copies save files directly into the folder
> (bypassing manager.save), so the imported slots appear in the
> Save/Load scene without a per-slot statSync on first query. Safe to
> call at any time; idempotent.

### `DataManager.saveGame` rescue override

> MV's default rescue removes the slot even when backup creation failed.
> Never delete an existing save in that case; leave journals/backups for
> explicit recovery if any part of the write was interrupted.

## `steamSaveSources`

> Locate possible Steam save indexes without changing the source folders.

## `hasSteamSaveData`

> A save index alone is not a saved game; don't prompt when no slots exist.

### `hasSteamSaveData` — unreadable-directory note

> An unreadable directory is not proof that no saves exist.

## `importSteamSaves`

> Copy only into an entirely empty destination; source files are never written.

### `importSteamSaves` — write-order note

> Write metadata last, so an interrupted import cannot expose partial slots.

### `importSteamSaves` — cache-refresh note

> The import wrote save files DIRECTLY into the destination folder,
> bypassing manager.save — so installSdSaves's in-memory exists-cache
> (and the cached decompressed global) are now stale. Rebuild them so
> the Save/Load scene sees the imported slots with zero per-slot
> statSync on first query. For 'switch' there is no manager cache
> (installSdSaves isn't called), so the optional chaining no-ops.
