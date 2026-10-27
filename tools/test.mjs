import { build } from 'esbuild';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Write test bundles into a temp dir INSIDE the project root so Node's
// ESM loader can still resolve `esbuild` from the project's node_modules.
const tmpDir = join(process.cwd(), '.test-tmp');
await mkdir(tmpDir, { recursive: true });
try {
  const sharedBuildOptions = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    // Mark these as external so the test bundle can `require()` them at
    // runtime instead of being inlined (esbuild's own JS API cannot be
    // bundled into another esbuild bundle, and Node built-ins must be
    // resolved by the runtime, not the bundler).
    external: ['esbuild', 'node:*'],
  };

  // core.test.ts has no runtime npm imports, so the data: URL trick still
  // works for it.
  const coreResult = await build({ ...sharedBuildOptions, entryPoints: ['tests/core.test.ts'] });
  await import(`data:text/javascript;base64,${Buffer.from(coreResult.outputFiles[0].contents).toString('base64')}`);

  // node-compat.test.ts exercises the Node/NW.js compatibility layer
  // (require/process/Buffer/fs/path/events/nw shims) using an in-memory
  // fake of nx.js's synchronous `Switch` fs.
  const compatResult = await build({ ...sharedBuildOptions, entryPoints: ['tests/node-compat.test.ts'] });
  await import(`data:text/javascript;base64,${Buffer.from(compatResult.outputFiles[0].contents).toString('base64')}`);

  // forwarder.test.ts imports `esbuild` at runtime to bundle src/forwarder.ts
  // in a vm context. Loading it via a `data:` URL would leave Node unable to
  // resolve the bare `esbuild` specifier (data: URLs have no base for
  // relative resolution), so write the bundle to a real file inside the
  // project so node_modules resolution works.
  const fwdResult = await build({ ...sharedBuildOptions, entryPoints: ['tests/forwarder.test.ts'] });
  const fwdPath = join(tmpDir, 'forwarder.test.mjs');
  await writeFile(fwdPath, fwdResult.outputFiles[0].text);
  await import(pathToFileURL(fwdPath).href);

  await import('../tests/icon.test.mjs');
  await import('../tests/ui-flow.test.mjs');
  await import('../tests/library.test.mjs');
  await import('../tests/ini.test.mjs');
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

