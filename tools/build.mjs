import { build } from 'esbuild';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { prepareIcon } from './icon.mjs';
import { patchNacpDefaults } from './nacp-patch.mjs';

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--debug' && flag !== '--default-icon')) throw new Error('Usage: npm run build -- [--debug] [--default-icon]');
const debug = flags.includes('--debug');
const defaultIcon = flags.includes('--default-icon');
const project = resolve('.');
const staging = await mkdtemp(join(tmpdir(), 'burialnx-build-'));
try {
  await mkdir(join(staging, 'romfs'));
  const meta = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  // Keep the same application ID for existing saves; only the visible title
  // differs between the two NROs.
  meta.nacp.title = debug ? 'BurialNX-Debug' : 'BurialNX';
  await writeFile(join(staging, 'package.json'), JSON.stringify(meta));
  await copyFile(join(project, 'romfs', 'nxjs.ini'), join(staging, 'romfs', 'nxjs.ini'));
  // Recursively copy any other files in romfs/ (e.g. the bundled
  // action-tile PNG icons under romfs/icons/) into the staging dir
  // so @nx.js/nro --fat bundles them into the NRO's romfs. Without
  // this, only nxjs.ini (manually copied above) ends up in the NRO
  // and romfs:/icons/*.png reads fail at runtime.
  try {
    await cp(join(project, 'romfs'), join(staging, 'romfs'), { recursive: true });
  } catch { /* if romfs/ has no extra files, that's fine — nxjs.ini is already there */ }
  await prepareIcon(project, staging, { defaultIcon });

  // === Baked-in forwarder placeholders ==================================
  // burialnx.nro's main.js contains TWO placeholder string literals that
  // the runtime forwarder builder patches (byte-level search + replace in
  // the romfs) to turn a COPY of burialnx.nro into a per-game forwarder:
  //
  //   __FORWARDER_GAME_ID__ = "0000...0000" (64 '0' chars)
  //     → patched to the game id (UTF-8, space-padded to 64 chars)
  //     → at startup, if the value is NOT all zeros, this IS a forwarder
  //       → set forwarderTargetId and auto-launch the game
  //       → NO chain-loading, NO envSetNextLoad → clean Switch.exit() → hbmenu
  //
  //   __FORWARDER_MOD_FORCED__ = "MODFORCED_0"
  //     → patched to "MODFORCED_1" if the game's mod is enabled
  //     → forces the mod on at auto-launch (same as the legacy --mod argv)
  //
  // This replaces the old chain-load approach (forwarder-template/romfs/main.ts
  // called app.launch(burialnx.nro, '--game', id) which set envSetNextLoad
  // — persistent on some hbloaders, causing re-chain loops). The forwarder
  // IS burialnx (same main.js) with a baked-in game id — no chain-loading.

  await build({
    entryPoints: [join(project, 'src', 'main.ts')],
    outfile: join(staging, 'romfs', 'main.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    define: {
      __DEBUG__: JSON.stringify(debug),
      __FORWARDER_GAME_ID__: JSON.stringify('0'.repeat(64)),
      __FORWARDER_MOD_FORCED__: JSON.stringify('MODFORCED_0'),
    },
  });
  const require = createRequire(import.meta.url);
  execFileSync(process.execPath, [require.resolve('@nx.js/nro/dist/main.js'), '--fat'], { cwd: staging, stdio: 'inherit' });

  // === NACP post-build patching ==========================================
  // Delegated to tools/nacp-patch.mjs so the logic is unit-tested (see
  // tests/nacp-patch.test.mjs). The high-level intent:
  //   - startupUserAccount = 0  → the Switch OS does NOT show the "select a
  //     user" profile dialog at launch, relaunch, post-sleep resume, or
  //     return from a forwarder. The app drops straight into the library.
  //   - saveDataSize / journalSize kept consistent (32 KiB = 32 KiB) to
  //     avoid Switch error 2016-0910 (the @nx.js/patch-nacp step leaves the
  //     journal at its 1.5 MiB template default, which mismatched the
  //     32 KiB save-data size).
  //   - bcatDeliveryCacheStorageSize zeroed (unused).
  //
  // WHY startupUserAccount=0 IS SAFE FOR THE MAIN APP (not just forwarders):
  //   • The app's own settings.json + library.json are written DIRECTLY to
  //     sdmc:/switch/burialnx/ via Switch.writeFileSync — no localStorage.
  //   • RPG Maker MV game saves never touch localStorage: installSdSaves()
  //     in src/saves.ts overrides runtime.StorageManager.{save,load,exists,
  //     remove,backup,...} to read/write regular .rpgsave files inside the
  //     per-game save folder on the SD card.
  //   • The autosave snapshot in src/game-compat.ts and the startup
  //     localStorage probe in src/main.ts are both wrapped in try/catch and
  //     degrade silently when localStorage is unavailable.
  // See the matching long comment in src/main.ts (the startup localStorage
  // probe) and src/forwarder.ts (writeNacpForwarderDefaults) — the main
  // app and forwarders now use the same no-profile-dialog behavior.
  const builtNroPath = join(staging, 'burialnx.nro');
  const nroBuf = Buffer.from(readFileSync(builtNroPath));
  console.log(patchNacpDefaults(nroBuf));
  writeFileSync(builtNroPath, nroBuf);

  await copyFile(builtNroPath, join(project, debug ? 'burialnx-debug.nro' : 'burialnx.nro'));
} finally {
  await rm(staging, { recursive: true, force: true });
}
