# `repeated-pattern.ts`

A small substitute for the `CanvasPattern` operation used by PIXI 4. The `RepeatedPattern` class lazily builds a bounded, enlarged tile from a tiny source (so a 1px source does not cost one `drawImage` per pixel) using an exponential copy-doubling fill, then tiles it across the target rectangle honoring `repeat` / `repeat-x` / `repeat-y` / `no-repeat` semantics.

## `RepeatedPattern` (class doc)
> /** A small substitute for the CanvasPattern operation used by PIXI 4. */

## `RepeatedPattern.enlarged`
> /** Build a bounded, repeated tile so a 1px source does not cost a draw per pixel. */

## `RepeatedPattern.enlarged` — exponential copy-doubling
> // Double the filled portion each time. The copies do not overlap, so
> // transparent pixels keep the same appearance as the original source.
