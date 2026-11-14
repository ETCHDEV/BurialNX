# `runtime-plan.ts`

Inspects the game's HTML entry point to collect the ordered list of local `<script src>` references, then drives the RPG Maker MV runtime into a running state by either invoking its `onload` handler or booting `Scene_Boot` directly, and computes the centered aspect-preserving viewport used to map the game's logical canvas onto the Switch's output dimensions. All comments in this file are single-line summaries preserved verbatim in the `.ts` source; there are no multi-line rationale blocks to relocate.

## `scriptPlan`

> /** Read ordered local script references without loading arbitrary URLs. */

## `startGame`

> /** Start the normal MV entry point, or use its boot scene if no handler exists. */

## `viewport`

> /** Compute a centered aspect-preserving destination on the Switch screen. */
