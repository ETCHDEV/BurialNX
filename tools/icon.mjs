import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

// The NRO packager expects a 256x256 JPEG. Keep image conversion build-only.
export async function prepareIcon(project, staging, { defaultIcon = false } = {}) {
  if (defaultIcon) return; // Explicitly ignore local artwork for public builds.
  let name;
  for (const candidate of ['icon.jpg', 'icon.png']) {
    try { await stat(join(project, candidate)); name = candidate; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!name) return; // The NRO packager provides its own placeholder.

  try {
    const path = join(project, name);
    if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('image exceeds 16 MiB');
    const input = await readFile(path);
    let image;
    if (name.endsWith('.png')) {
      const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (input.length < 24 || !input.subarray(0, 8).equals(signature)) throw new Error('invalid PNG');
      const width = input.readUInt32BE(16), height = input.readUInt32BE(20);
      if (!width || !height || width * height > 16_000_000) throw new Error('image exceeds 16 megapixels');
      image = PNG.sync.read(input);
    } else {
      image = jpeg.decode(input, { useTArray: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 128 });
    }
    // Preserve a ready-to-use JPEG byte for byte.
    if (name.endsWith('.jpg') && image.width === 256 && image.height === 256) {
      await writeFile(join(staging, 'icon.jpg'), input);
      return;
    }
    // Fit without distortion; composite transparency and padding over black.
    const pixels = Buffer.alloc(256 * 256 * 4);
    const scale = Math.min(256 / image.width, 256 / image.height);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const left = Math.floor((256 - width) / 2), top = Math.floor((256 - height) / 2);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const source = (Math.floor(y * image.height / height) * image.width + Math.floor(x * image.width / width)) * 4;
      const target = ((top + y) * 256 + left + x) * 4;
      const alpha = image.data[source + 3] / 255;
      for (let channel = 0; channel < 3; channel++) pixels[target + channel] = Math.round(image.data[source + channel] * alpha);
      pixels[target + 3] = 255;
    }
    await writeFile(join(staging, 'icon.jpg'), jpeg.encode({ data: pixels, width: 256, height: 256 }, 90).data);
  } catch (error) {
    throw new Error(`Could not prepare ${name}: ${error.message}`, { cause: error });
  }
}
