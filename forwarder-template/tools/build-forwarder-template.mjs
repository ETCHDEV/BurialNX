// Builds the BurialNX forwarder template NRO.
//
// The forwarder template is a small FAT self-contained nx.js NRO whose
// main.js reads a sidecar JSON file and chain-launches burialnx.nro with
// `--game <id>`. At runtime, BurialNX copies this template, patches its
// NACP (title = game name, id = a hash of the game id) and icon (the
// game's cover JPEG), and writes the result as
// `sdmc:/switch/burialnx/forwarders/<game-id>.nro`.
//
// This script is invoked by the main build (tools/build.mjs) so the
// template is rebuilt whenever BurialNX itself is. The output NRO is
// `forwarder-template.nro` in the project root, and build.mjs copies it
// into burialnx.nro's romfs so the runtime builder can read it via
// `romfs:/forwarder-template.nro`.

import { build } from 'esbuild';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const project = resolve('.');
const staging = await mkdtemp(join(tmpdir(), 'burialnx-forwarder-'));
try {
        await mkdir(join(staging, 'romfs'));
        const meta = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
        await writeFile(join(staging, 'package.json'), JSON.stringify(meta));
        await copyFile(join(project, 'romfs', 'nxjs.ini'), join(staging, 'romfs', 'nxjs.ini'));
        // Bundle the forwarder main.ts (TypeScript) into a single ES module
        // main.js, the entrypoint nx.js loads.
        await build({
                entryPoints: [join(project, 'romfs', 'main.ts')],
                outfile: join(staging, 'romfs', 'main.js'),
                bundle: true,
                format: 'esm',
                target: 'es2022',
                define: { __DEBUG__: 'false' },
        });
        // No per-app icon: the nx.js/nro packager supplies its own default
        // placeholder. BurialNX patches the icon at runtime with the game's
        // cover JPEG when building each forwarder.
        const require = createRequire(import.meta.url);
        // --fat makes the NRO self-contained (no shared runtime dependency).
        // Each forwarder is ~56 MiB but works on any Switch with the nx.js
        // runtime baked in. This is the safest option for a one-click
        // forwarder the user can drop onto their SD card.
        execFileSync(process.execPath, [require.resolve('@nx.js/nro/dist/main.js'), '--fat'], { cwd: staging, stdio: 'inherit' });
        const outName = `${meta.name}.nro`;
        const outPath = join(project, '..', 'forwarder-template.nro');
        await copyFile(join(staging, outName), outPath);
        const s = await stat(outPath);
        console.log(`forwarder-template: built ${outPath} (${(s.size / 1024 / 1024).toFixed(1)} MiB)`);
} finally {
        await rm(staging, { recursive: true, force: true });
}
