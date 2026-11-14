# `script-queue.ts`

Serializes dynamically appended scripts to preserve game/plugin order. A small `Promise`-chain wrapper that reads each script asset and calls an `evaluate` callback, retaining the first failure so later scripts cannot execute after a broken dependency, and exposing `settled()` to wait until a running script has finished appending more work.

## `ScriptQueue` (class doc)
> /** Serializes dynamically appended scripts to preserve game/plugin order. */

## `ScriptQueue.append`
> // Retain failure so later scripts cannot execute after a broken dependency.

## `ScriptQueue.settled`
> // A running script can append another script while the current tail is
> // executing, so wait until the queue has stopped growing.
