import { build } from 'esbuild';

const result = await build({
  entryPoints: ['tests/core.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
await import('../tests/icon.test.mjs');
