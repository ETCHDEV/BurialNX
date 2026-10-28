// === File logger ======================================================
// Extracted from main.ts. Owns the debug-lines ring buffer, the log file
// path constants, the `log()` and `snapshotRuntimeLog()` helpers, the
// console-method overrides (so nx.js's regular console can't draw over
// the game), and the one-time startup init (mkdir + truncate the log
// file + the first diagnostic lines).
//
// The init runs at THIS module's load time. Because main.ts imports this
// module before its own body runs, the log directory is created and the
// first "BurialNX debug session" line is written BEFORE any main.ts
// statement executes — preserving the original ordering where `log()`
// was hoisted and called from the top of main.ts.

declare const __DEBUG__: boolean;

// One log file per launch, overwritten on every start. The earlier numbered
// scheme (native-host_1.log, native-host_2.log, …) accumulated one file per
// session on the SD card and buried the useful log under dozens of stale
// ones; now the most recent session always wins and the file is the single
// source of truth for "what happened on the last run".
export const logsPath = 'sdmc:/switch/burialnx/LOGS';
export const hostLogPath = `${logsPath}/native-host.log`;

// Ring buffer of the most recent log lines, shown in the top-left of the
// loading screen in debug builds so devs get diagnostics without losing
// the bar UI. `log()` pushes and shifts to keep it bounded.
export const debugLines: string[] = [];

export function log(line: string) {
	if (!__DEBUG__) return;
	debugLines.push(line);
	if (debugLines.length > 6) debugLines.shift();
	try { (Switch as any).appendFileSync?.(hostLogPath, `${line}\n`); } catch { /* optional diagnostics */ }
}

// nx.js writes its own log to a fixed path. Copy a snapshot instead of moving
// or truncating that file, which the runtime may still have open. The snapshot
// goes to ONE file (overwritten each time) — the earlier timestamped names
// (nxjs-debug-<Date.now()>.log) accumulated a new file per scene change.
export function snapshotRuntimeLog() {
	if (!__DEBUG__) return;
	try {
		const bytes = (Switch as any).readFileSync?.('sdmc:/switch/nxjs-debug.log');
		if (bytes) (Switch as any).writeFileSync?.(`${logsPath}/nxjs-debug-last.log`, bytes);
	} catch { /* native log may not exist */ }
}

// nx.js's regular console can draw over the game. Debug messages go to the
// runtime's file logger instead; the release build suppresses routine output.
for (const level of ['debug', 'log', 'info', 'warn', 'error', 'trace'] as const) {
	(console as any)[level] = (...values: unknown[]) => { if (__DEBUG__) log(`[${level}] ${values.map(String).join(' ')}`); };
}

// Start diagnostics before accessing the screen or enumerating the SD card.
// Runs at module import time (before main.ts's body), matching the original
// placement at the top of main.ts where `log()` was hoisted.
try { (Switch as any).mkdirSync?.('sdmc:/switch/burialnx'); } catch { /* report write failures later */ }
if (__DEBUG__) {
	try { (Switch as any).mkdirSync?.(logsPath); } catch { /* diagnostics are optional */ }
	// Truncate the previous session's log so this file always holds
	// exactly one launch (writeFileSync opens in "w" mode). All later
	// writes (log(), fatal()) append to the freshly truncated file.
	try { (Switch as any).writeFileSync?.(hostLogPath, new ArrayBuffer(0)); } catch { /* optional */ }
	log(`--- BurialNX debug session ${new Date().toISOString()} ---`);
	log(`Log file: ${hostLogPath}`);
	log('Initializing screen');
}
