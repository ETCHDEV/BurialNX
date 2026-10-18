import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { prepareIcon } from '../tools/icon.mjs';

test('custom NRO icons: fallback, PNG, JPEG, priority, and invalid input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'burialnx-icon-test-'));
  const staging = join(root, 'staging');
  try {
    await mkdir(staging);
    await prepareIcon(root, staging);
    await assert.rejects(readFile(join(staging, 'icon.jpg')), { code: 'ENOENT' });
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([255, 0, 0, 255, 0, 255, 0, 0]);
    await writeFile(join(root, 'icon.png'), PNG.sync.write(png));
    await prepareIcon(root, staging);
    const converted = jpeg.decode(await readFile(join(staging, 'icon.jpg')), { useTArray: true });
    assert.equal(converted.width, 256);
    assert.equal(converted.height, 256);
    const red = (128 * 256 + 32) * 4, transparent = (128 * 256 + 224) * 4;
    assert.ok(converted.data[red] > 200);
    assert.ok(converted.data[transparent + 1] < 30);
    const original = jpeg.encode({ data: Buffer.alloc(256 * 256 * 4, 255), width: 256, height: 256 }, 90).data;
    await writeFile(join(root, 'icon.jpg'), original);
    await prepareIcon(root, staging);
    assert.deepEqual(await readFile(join(staging, 'icon.jpg')), original);
    const small = jpeg.encode({ data: Buffer.alloc(8 * 4 * 4, 255), width: 8, height: 4 }, 90).data;
    await writeFile(join(root, 'icon.jpg'), small);
    await prepareIcon(root, staging);
    const resized = jpeg.decode(await readFile(join(staging, 'icon.jpg')), { useTArray: true });
    assert.equal(resized.width, 256);
    assert.equal(resized.height, 256);
    assert.ok(resized.data[0] < 30); // Aspect-fit padding.
    await writeFile(join(root, 'icon.jpg'), 'not a JPEG');
    await assert.rejects(prepareIcon(root, staging), /Could not prepare icon\.jpg/);
    await rm(join(root, 'icon.jpg'));
    await writeFile(join(root, 'icon.png'), 'not a PNG');
    await assert.rejects(prepareIcon(root, staging), /Could not prepare icon\.png/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
