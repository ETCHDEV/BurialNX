# `log.ts`

Owns the debug-lines ring buffer, the log file path constants, the `log()` and `snapshotRuntimeLog()` helpers, the console-method overrides (so nx.js's regular console can't draw over the game), and the one-time startup init (mkdir + truncate the log file + the first diagnostic lines). The init runs at this module's load time so the log directory is created and the first "BurialNX debug session" line is written BEFORE any main.ts statement executes — preserving the original ordering where `log()` was hoisted and called from the top of main.ts.

## File header
> === File logger ======================================================
> Extracted from main.ts. Owns the debug-lines ring buffer, the log file
> path constants, the `log()` and `snapshotRuntimeLog()` helpers, the
> console-method overrides (so nx.js's regular console can't draw over
> the game), and the one-time startup init (mkdir + truncate the log
> file + the first diagnostic lines).
>
> The init runs at THIS module's load time. Because main.ts imports this
> module before its own body runs, the log directory is created and the
> first "BurialNX debug session" line is written BEFORE any main.ts
> statement executes — preserving the original ordering where `log()`
> was hoisted and called from the top of main.ts.

## `logsPath` / `hostLogPath` constants
> // One log file per launch, overwritten on every start. The earlier numbered
> // scheme (native-host_1.log, native-host_2.log, …) accumulated one file per
> // session on the SD card and buried the useful log under dozens of stale
> // ones; now the most recent session always wins and the file is the single
> // source of truth for "what happened on the last run".

## `debugLines` (ring buffer)
> // Ring buffer of the most recent log lines, shown in the top-left of the
> // loading screen in debug builds so devs get diagnostics without losing
> // the bar UI. `log()` pushes and shifts to keep it bounded.

## `snapshotRuntimeLog`
> // nx.js writes its own log to a fixed path. Copy a snapshot instead of moving
> // or truncating that file, which the runtime may still have open. The snapshot
> // goes to ONE file (overwritten each time) — the earlier timestamped names
> // (nxjs-debug-<Date.now()>.log) accumulated a new file per scene change.

## Console-method overrides
> // nx.js's regular console can draw over the game. Debug messages go to the
> // runtime's file logger instead; the release build suppresses routine output.

## Module-load startup init
> // Start diagnostics before accessing the screen or enumerating the SD card.
> // Runs at module import time (before main.ts's body), matching the original
> // placement at the top of main.ts where `log()` was hoisted.

## Module-load startup init — truncate previous session
> // Truncate the previous session's log so this file always holds
> // exactly one launch (writeFileSync opens in "w" mode). All later
> // writes (log(), fatal()) append to the freshly truncated file.
