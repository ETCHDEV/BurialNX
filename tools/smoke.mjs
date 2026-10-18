// Development-only smoke test. The game root is supplied by the developer and
// is read-only. This does not emulate nx.js, rendering, audio or controller IO.
import { build } from 'esbuild';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { webcrypto } from 'node:crypto';
import { PNG } from 'pngjs';

const root = process.env.BURIALNX_GAME_ROOT;
if (!root) throw new Error('Set BURIALNX_GAME_ROOT to your own game www folder');
const base = resolve(root);
const read = async (path) => {
  if (!path.startsWith('game/')) throw new Error('Unexpected read root');
  const resolved = resolve(base, path.slice(5));
  if (!resolved.startsWith(base + sep)) throw new Error('Read outside game folder');
  try { const data = await readFile(resolved); return Uint8Array.from(data).buffer; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const result = await build({ entryPoints: ['tests/smoke-entry.ts'], bundle: true, write: false, format: 'iife', globalName: 'Smoke', target: 'es2022' });
const drawing = new Proxy({ canvas: null, measureText: () => ({ width: 30 }), getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }), createPattern: () => ({}), createLinearGradient: () => ({ addColorStop() {} }) }, {
  get(target, key) { return key in target ? target[key] : () => {}; },
  set(target, key, value) { target[key] = value; return true; },
});
class Canvas { constructor(width = 300, height = 150) { this.width = width; this.height = height; } getContext(kind) { return kind === '2d' ? drawing : null; } }
const imageErrors = [];
class Image extends EventTarget {
  width = 64; height = 64; complete = false;
  set src(value) {
    this._src = value;
    if (!value) return;
    this.complete = false;
    // A fake successful Image masked missing map assets. Read the same local
    // URL the host handles on Switch, then deliver the corresponding event.
    sandbox.fetch(value).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80) throw new Error('Not a PNG');
      // Validate the entire PNG, including chunks and compressed pixel data;
      // checking just the header cannot reveal a corrupt game asset.
      PNG.sync.read(Buffer.from(bytes));
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.width = data.getUint32(16); this.height = data.getUint32(20);
      this.complete = true; this.dispatchEvent(new Event('load'));
    }).catch((error) => {
      imageErrors.push(`${value}: ${error}`);
      console.error(`Image load failed: ${value}: ${error}`);
      this.dispatchEvent(new Event('error'));
    });
  }
  get src() { return this._src; }
}
class AudioContext {
  currentTime = 0; destination = {}; state = 'running';
  createGain() { return { gain: { setValueAtTime() {} }, connect() {} }; }
  createStereoPanner() { return { pan: { setValueAtTime() {} }, connect() {} }; }
}
const callbacks = [];
let elapsed = 0;
const sandbox = { TextEncoder, TextDecoder, URL, Blob, Response, Request, Event, EventTarget, crypto: webcrypto, performance: { now: () => elapsed }, setTimeout, clearTimeout, setInterval, clearInterval,
  screen: new Canvas(1280, 720), OffscreenCanvas: Canvas, Image, AudioContext, navigator: { userAgent: 'nx.js', platform: 'Nintendo Switch', getGamepads: () => [] },
  fetch, console, requestAnimationFrame: (callback) => { callbacks.push(callback); return callbacks.length; }, cancelAnimationFrame() {}, fonts: { add() {} }, FontFace: class {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, readGame: read,
};
const context = vm.createContext(sandbox);
vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis; globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};', context);
vm.runInContext(result.outputFiles[0].text, context, { timeout: 5000 });
await context.Smoke.smoke(read, (message) => console.log(message), async () => {
  elapsed += 17;
  const pending = callbacks.splice(0);
  for (const callback of pending) callback(elapsed);
  await new Promise((done) => setTimeout(done, 2));
});
if (imageErrors.length) throw new Error(`Image decoding failed: ${imageErrors.join('; ')}`);
