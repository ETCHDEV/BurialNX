import { build } from 'esbuild';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { prepareIcon } from './icon.mjs';

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
  await prepareIcon(project, staging, { defaultIcon });

  // Bundle the forwarder's main.js (from forwarder-template/romfs/main.ts)
  // to a STRING and inject it via esbuild's `define` as
  // __FORWARDER_MAIN_JS__. At runtime, src/forwarder.ts patches the
  // 64-'0' game-id placeholder in this string and writes it into the
  // romfs of a COPY of burialnx.nro itself — so each forwarder is a
  // self-contained FAT NRO that uses burialnx.nro's own code segment
  // (the nx.js runtime) as its base. No 54 MiB template embedded in
  // burialnx.nro's romfs — burialnx.nro stays at ~54 MiB.
  const forwarderMainResult = await build({
    entryPoints: [join(project, 'forwarder-template', 'romfs', 'main.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    define: { __DEBUG__: 'false' },
  });
  const forwarderMainJs = forwarderMainResult.outputFiles[0].text;
  if (!forwarderMainJs.includes('0'.repeat(64))) {
    throw new Error('forwarder-template/romfs/main.ts does not contain the 64-zero GAME_ID placeholder — the runtime forwarder builder cannot patch it');
  }

  await build({
    entryPoints: [join(project, 'src', 'main.ts')],
    outfile: join(staging, 'romfs', 'main.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    define: {
      __DEBUG__: JSON.stringify(debug),
      __FORWARDER_MAIN_JS__: JSON.stringify(forwarderMainJs),
    },
  });
  const require = createRequire(import.meta.url);
  execFileSync(process.execPath, [require.resolve('@nx.js/nro/dist/main.js'), '--fat'], { cwd: staging, stdio: 'inherit' });

  // Post-build: patch the NACP's save-data fields to be CONSISTENT.
  // The @nx.js/patch-nacp package sets userAccountSaveDataSize from
  // package.json (32768 = 32 KiB) but leaves userAccountSaveDataJournalSize
  // at its NACP template default (0x180000 = 1.5 MiB). The inconsistency
  // (32 KiB save data but 1.5 MiB journal) caused Switch error 2016-0910.
  //
  // Fix: set journalSize = saveDataSize = 32768 (consistent). Also
  // zero bcatDeliveryCacheStorageSize (not needed). Keep
  // startupUserAccount = 1 (the template default) so the user-selection
  // dialog appears and save data is mounted → localStorage works →
  // RPG Maker MV game saves work.
  //
  // The per-game forwarder NACP is separately zeroed by
  // writeNacpForwarderDefaults() (saveData=0, journal=0,
  // startupUserAccount=0) — the forwarder doesn't need save data.
  const builtNroPath = join(staging, 'burialnx.nro');
  const nroBuf = Buffer.from(readFileSync(builtNroPath));
  const nroSize = nroBuf.readUInt32LE(0x18);
  const assetBase = nroSize;
  const nacpRel = nroBuf.readUInt32LE(assetBase + 0x18);
  const nacpAbs = assetBase + nacpRel;
  // userAccountSaveDataSize (0x3080, s64) = 32768 (from package.json, already set)
  // userAccountSaveDataJournalSize (0x3088, s64) = 32768 (match saveDataSize)
  nroBuf.writeBigUInt64LE(32768n, nacpAbs + 0x3088);
  // bcatDeliveryCacheStorageSize (0x3090, s64) = 0 (not needed)
  nroBuf.writeBigUInt64LE(0n, nacpAbs + 0x3090);
  writeFileSync(builtNroPath, nroBuf);
  console.log(`Patched NACP: saveDataSize=32768, journalSize=32768, bcatSize=0 (consistent, enables localStorage for game saves, prevents 2016-0910)`);

  await copyFile(builtNroPath, join(project, debug ? 'burialnx-debug.nro' : 'burialnx.nro'));
} finally {
  await rm(staging, { recursive: true, force: true });
}
