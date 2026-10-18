import { build } from 'esbuild';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { prepareIcon } from './icon.mjs';

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--debug')) throw new Error('Usage: npm run build -- [--debug]');
const debug = flags.includes('--debug');
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
  await prepareIcon(project, staging);
  await build({
    entryPoints: [join(project, 'src', 'main.ts')],
    outfile: join(staging, 'romfs', 'main.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    define: { __DEBUG__: JSON.stringify(debug) },
  });
  const require = createRequire(import.meta.url);
  execFileSync(process.execPath, [require.resolve('@nx.js/nro/dist/main.js'), '--fat'], { cwd: staging, stdio: 'inherit' });
  await copyFile(join(staging, 'burialnx.nro'), join(project, debug ? 'burialnx-debug.nro' : 'burialnx.nro'));
} finally {
  await rm(staging, { recursive: true, force: true });
}
