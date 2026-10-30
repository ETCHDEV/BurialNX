declare const __DEBUG__: boolean;

export const logsPath = 'sdmc:/switch/burialnx/LOGS';
export const hostLogPath = `${logsPath}/native-host.log`;

export const debugLines: string[] = [];

export function log(line: string) {
        if (!__DEBUG__) return;
        debugLines.push(line);
        if (debugLines.length > 6) debugLines.shift();
        try { (Switch as any).appendFileSync?.(hostLogPath, `${line}\n`); } catch { /* optional diagnostics */ }
}

export function snapshotRuntimeLog() {
        if (!__DEBUG__) return;
        try {
                const bytes = (Switch as any).readFileSync?.('sdmc:/switch/nxjs-debug.log');
                if (bytes) (Switch as any).writeFileSync?.(`${logsPath}/nxjs-debug-last.log`, bytes);
        } catch { /* native log may not exist */ }
}

for (const level of ['debug', 'log', 'info', 'warn', 'error', 'trace'] as const) {
        (console as any)[level] = (...values: unknown[]) => { if (__DEBUG__) log(`[${level}] ${values.map(String).join(' ')}`); };
}

try { (Switch as any).mkdirSync?.('sdmc:/switch/burialnx'); } catch { /* report write failures later */ }
if (__DEBUG__) {
        try { (Switch as any).mkdirSync?.(logsPath); } catch { /* diagnostics are optional */ }
        try { (Switch as any).writeFileSync?.(hostLogPath, new ArrayBuffer(0)); } catch { /* optional */ }
        log(`--- BurialNX debug session ${new Date().toISOString()} ---`);
        log(`Log file: ${hostLogPath}`);
        log('Initializing screen');
}
