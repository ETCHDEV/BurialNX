/** Parse the legacy --game/--game-id argv forms and --mod flag used by chain-load forwarders. */
export interface ForwarderTarget {
        gameId: string;
        modForced: boolean;
}

export function parseForwarderTarget(argv: readonly string[]): ForwarderTarget | null {
        let gameId: string | null = null;
        let modForced = false;
        for (let i = 0; i < argv.length; i++) {
                const a = argv[i] ?? '';
                if (a === '--game' || a === '--game-id') {
                        const v = argv[i + 1];
                        if (typeof v === 'string' && v.length > 0) gameId = v;
                }
                const eq = a.startsWith('--game=') ? a.slice('--game='.length)
                        : a.startsWith('--game-id=') ? a.slice('--game-id='.length)
                        : null;
                if (eq !== null && eq.length > 0) gameId = eq;
                if (a === '--mod') modForced = true;
        }
        return gameId ? { gameId, modForced } : null;
}
