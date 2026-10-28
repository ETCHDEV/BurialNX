// === Forwarder argv parser ===========================================
// Extracted from main.ts. Parses the legacy `--game <id>` / `--game-id <id>`
// argv forms (and the `--mod` flag) used by the OLD chain-load forwarder
// mechanism. The new baked-in forwarder mechanism (no chain-loading, no
// envSetNextLoad) is detected separately via the __FORWARDER_GAME_ID__
// constant at module init in main.ts.
//
// Supported forms (the forwarder builder emits the first one):
//   --game <id>          (two tokens)
//   --game=<id>          (one token)
//   --game-id <id>       (alias, two tokens)
//   --game-id=<id>       (alias, one token)
//   --mod                (flag — force the mod on at auto-launch)

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
