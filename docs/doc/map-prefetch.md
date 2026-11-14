# `map-prefetch.ts`

Speculatively pre-reads the small set of map JSON files referenced by the current map's transfer commands so the player never waits on a synchronous disk read when stepping through a doorway. `MapPrefetcher` walks the RPG Maker MV `$dataMap` event/page/command tree looking for direct `201` (Transfer Player) commands whose first parameter is `0` (a literal map id, not a variable), schedules those reads at a slow cadence over idle frames, and re-plans whenever a new map finishes loading — without altering the data the game receives. `installMapPrefetch` wraps `DataManager.onLoad` to observe normal map loads.

## Module constants (`MAX_MAPS`, etc.)

> // MV's transfer command names the destination directly only when the first
> // parameter is zero. Variable-based destinations cannot be predicted safely.

## `MapPrefetcher.plan`

> // Count events and pages as well as commands so even unusual maps have
> // a bounded scan. Missing or malformed event lists are simply ignored.

## `MapPrefetcher.tick`

> // Called once per frame, but issues at most one asynchronous read at a
> // time. A new map discards the old queue; an already-started read may finish.

## `installMapPrefetch`

> /** Observe normal MV map loads without changing the data given to the game. */
