# `settings.ts`

This file defines the persistence types for a saved game selection (`SaveLocation`, `GameSelection`) plus pure validation helpers (`safeSdPath`, `gameSaveFolders`, `parseSelection`, `startupSelection`) used at boot to read `sdmc:/switch/burialnx/settings.json` and decide whether to skip the picker and launch straight into the previously-selected game.

## `gameSaveFolders`
> The two locations used by PC deployments; a non-www root has only one.

## `parseSelection`
> Reject corrupt or unsafe settings rather than guessing or overwriting them.

## `startupSelection`
> Debug always asks again. Release only skips the picker for a valid game.

## `startupSelection` catch block (removed mod)
> A removed mod must not prevent the game from starting.
