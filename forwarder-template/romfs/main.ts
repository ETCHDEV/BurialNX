// BurialNX forwarder template.
//
// This is the main.js of the small nx.js NRO that BurialNX produces for
// each game in the user's library. When launched from the Switch homebrew
// menu (hbmenu), it chain-loads burialnx.nro with `--game <id>` on its
// argv. burialnx.nro sees the arg, skips the library grid, and launches
// the game directly.
//
// HOW THE GAME ID GETS HERE:
// BurialNX's forwarder builder (src/forwarder.ts) takes this template NRO
// and patches the GAME_ID placeholder below — a 64-byte sequence of '0'
// characters — with the target game's id (padded with spaces to 64 bytes).
// This is a byte-level patch in the romfs data, so the forwarder is fully
// self-contained: no sidecar JSON, no external file dependency, nothing
// the user can accidentally delete. The game id is baked into the NRO.
//
// The BURIALNX_NRO_PATH is hardcoded to the standard location
// (sdmc:/switch/burialnx/burialnx.nro). If the user moved burialnx.nro,
// the forwarder will show a clear error. The fix is to put burialnx.nro
// back where the forwarder expects it (or rebuild the forwarder).

// === Placeholders (patched by src/forwarder.ts at build time) ==========
// GAME_ID is exactly 64 '0' characters. The forwarder builder searches
// the romfs for this exact byte sequence and overwrites it with the
// game id (UTF-8, padded with spaces to 64 bytes). The .trim() call
// below strips the padding so the launch arg is clean.
// MOD_ENABLED is exactly 1 character: '0' (no mod) or '1' (mod on).
// The forwarder builder patches it to '1' if the game's mod is enabled
// at build time, so the forwarder always launches with the mod — even
// if the user later disables the mod in the library.
const GAME_ID = "0000000000000000000000000000000000000000000000000000000000000000";
const MOD_ENABLED = "0";
const BURIALNX_NRO_PATH = "sdmc:/switch/burialnx/burialnx.nro";
const BURIALNX_DEBUG_NRO_PATH = "sdmc:/switch/burialnx/burialnx-debug.nro";

// === Error screen =====================================================
// Draws a simple error message on the Switch screen if the chain-launch
// fails. The user can press + to exit to hbmenu.
function showFatal(message: string): void {
        try {
                const ctx = (screen as any).getContext?.('2d');
                if (!ctx) return;
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = '#161823';
                ctx.fillRect(0, 0, (screen as any).width, (screen as any).height);
                ctx.fillStyle = '#f4f3ef';
                ctx.font = '26px sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText('BurialNX Forwarder', 28, 50);
                ctx.fillStyle = '#ff6b6b';
                ctx.font = '18px sans-serif';
                const maxW = (screen as any).width - 56;
                const words = message.split(/(\s+)/);
                let line = '', y = 90;
                for (const w of words) {
                        const test = line + w;
                        if (ctx.measureText(test).width > maxW && line) {
                                ctx.fillText(line, 28, y); y += 26; line = w.trimStart();
                        } else line = test;
                }
                if (line) { ctx.fillText(line, 28, y); y += 26; }
                ctx.fillStyle = '#9aa0b4';
                ctx.font = '16px sans-serif';
                ctx.fillText('Press + to exit, then relaunch BurialNX to rebuild this forwarder.', 28, y + 20);
                ctx.restore();
        } catch { /* nothing more we can do */ }
}

// Wait for + (button 9) to exit. nx.js dispatches beforeunload when +
// is held; we cancel it so the runtime does NOT auto-exit, then exit
// ourselves when we see the button go down via requestAnimationFrame.
function waitForPlusThenExit(): void {
        try { globalThis.addEventListener?.('beforeunload', (e: Event) => { (e as any).preventDefault?.(); }); } catch { /* ignore */ }
        const check = () => {
                try {
                        const pad = (navigator as any).getGamepads?.()?.[0];
                        if (pad?.buttons?.[9]?.pressed) { (Switch as any).exit?.(); return; }
                } catch { /* ignore */ }
                requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
}

// === Debug info screen ===============================================
// Shows a green debug screen with the forwarder's configuration BEFORE
// attempting the chain-launch. This stays on screen for 2 seconds so
// the user can see what's happening, then the chain-launch proceeds.
// If the chain-launch fails, the error screen (showFatal) takes over.
function showDebugScreen(gameId: string): void {
        try {
                const ctx = (screen as any).getContext?.('2d');
                if (!ctx) return;
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = '#161823';
                ctx.fillRect(0, 0, (screen as any).width, (screen as any).height);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.fillStyle = '#3fb950';
                ctx.font = '24px sans-serif';
                ctx.fillText('BurialNX Forwarder', 28, 40);
                ctx.fillStyle = '#c9cdd6';
                ctx.font = '18px sans-serif';
                let y = 75;
                const lines = [
                        'Game ID: ' + gameId,
                        'Mod: ' + (MOD_ENABLED === '1' ? 'ON' : 'OFF'),
                        'Target: ' + BURIALNX_NRO_PATH,
                        '  (fallback: ' + BURIALNX_DEBUG_NRO_PATH + ')',
                        'Self: ' + ((Switch as any).argv?.[0] || '(unknown)'),
                        '',
                        'Chain-launching in 2s...',
                ];
                for (const line of lines) { ctx.fillText(line, 28, y); y += 24; }
                ctx.restore();
        } catch { /* best-effort */ }
}

// === Main =============================================================
function main(): void {
        const gameId = GAME_ID.trim();
        if (!gameId) {
                showFatal('Forwarder game id is empty. The forwarder was not built correctly — rebuild it from the BurialNX library.');
                waitForPlusThenExit();
                return;
        }
        // Show the debug screen so the user can see the forwarder's
        // configuration before the chain-launch.
        showDebugScreen(gameId);
        // Wait 2 seconds so the user can read the debug info.
        const start = Date.now();
        while (Date.now() - start < 2000) { /* busy-wait — no rAF loop yet */ }

        try {
                // Switch.Application is the nx.js class for NRO apps. Its
                // launch() method calls libnx envSetNextLoad(path, argv)
                // (see nx.js source/ns.cc:270) and then exits the current
                // process. hbloader chains into burialnx.nro with the given
                // args.
                //
                // CRITICAL: the FIRST arg to launch() MUST be the burialnx.nro
                // path (NOT '--game'). nx.js's resolve_entrypoint
                // (source/main.cc:1313) checks argv[1]:
                //   - If argv[1] ends with ".nro" → bootstrap launch: mount
                //     that NRO's romfs and run its main.js (burialnx's main.js).
                //   - Else → treat argv[1] as a .js file path →
                //     "No such file or directory: --game".
                //
                // So we pass BURIALNX_NRO_PATH as the first arg (becomes
                // argv[1], triggers bootstrap launch of burialnx.nro), then
                // '--game' and gameId (become argv[2] and argv[3], which
                // burialnx reads via Switch.argv).
                //
                // If MOD_ENABLED is "1" (the mod was enabled when the
                // forwarder was built), pass '--mod' so burialnx forces the
                // mod on — even if the user later disabled it in the library.
                //
                // Try burialnx.nro first; if it doesn't exist, fall back to
                // burialnx-debug.nro. The user might only have the debug
                // build installed.
                let nroPath = BURIALNX_NRO_PATH;
                let app: any;
                try {
                        app = new (Switch as any).Application(nroPath);
                } catch (e1) {
                        // burialnx.nro not found — try the debug build.
                        nroPath = BURIALNX_DEBUG_NRO_PATH;
                        try {
                                app = new (Switch as any).Application(nroPath);
                        } catch (e2) {
                                throw e1; // Throw the original error if both fail.
                        }
                }
                if (MOD_ENABLED === "1") {
                        app.launch(nroPath, '--game', gameId, '--mod');
                } else {
                        app.launch(nroPath, '--game', gameId);
                }
                // launch() is typed `never` — if it returns, the chain
                // failed (burialnx.nro missing, corrupt, etc.).
                showFatal('Could not chain-launch BurialNX.\n\nTarget: ' + BURIALNX_NRO_PATH + '\nGame id: ' + gameId + '\n\nMake sure burialnx.nro is at the path above, then relaunch this forwarder.');
                waitForPlusThenExit();
        } catch (error) {
                const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                showFatal('Could not launch BurialNX:\n' + msg + '\n\nTarget: ' + BURIALNX_NRO_PATH + '\nGame id: ' + gameId);
                waitForPlusThenExit();
        }
}

main();
