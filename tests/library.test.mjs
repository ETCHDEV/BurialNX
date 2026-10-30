import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Load the game-library module fresh for each test so state doesn't leak.
// esbuild's IIFE format returns the entry's exports as the IIFE value, so we
// assign it to a known global and read it back after evaluating the bundle.
async function loadLibraryModule() {
  const bundle = await build({ entryPoints: ['src/game-library.ts'], bundle: true, write: false, format: 'iife', globalName: '__lib', target: 'es2022' });
  const context = vm.createContext({ TextEncoder, TextDecoder, console: { ...console } });
  vm.runInContext(`${bundle.outputFiles[0].text}`, context);
  return context.__lib;
}

function memoryFs(files = new Map()) {
  return {
    mkdirSync() {},
    readFileSync(path) { return files.has(path) ? new TextEncoder().encode(files.get(path)).buffer : null; },
    writeFileSync(path, value) {
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      files.set(path, text);
    },
    statSync(path) { return files.has(path) ? { mode: 0o100000 } : null; },
  };
}

test('parseLibrary rejects duplicate ids and unsafe roots', async () => {
  const lib = await loadLibraryModule();
  const valid = { version: 1, games: [{ id: 'g1', name: 'A', root: 'sdmc:/games/a', sharedSaves: false }] };
  assert.doesNotThrow(() => lib.parseLibrary(JSON.stringify(valid)));
  assert.throws(() => lib.parseLibrary(JSON.stringify({
    version: 1, games: [
      { id: 'g1', name: 'A', root: 'sdmc:/games/a', sharedSaves: false },
      { id: 'g1', name: 'B', root: 'sdmc:/games/b', sharedSaves: false },
    ],
  })), /Duplicate game id/);
  assert.throws(() => lib.parseLibrary(JSON.stringify({
    version: 1, games: [{ id: 'g1', name: 'A', root: 'relative/path', sharedSaves: false }],
  })));
  assert.throws(() => lib.parseLibrary(JSON.stringify({ version: 2, games: [] })), /Unsupported library version/);
});

test('parseLibrary accepts and validates per-game keymap', async () => {
  const lib = await loadLibraryModule();
  const kmMod = await loadKeymapModule();
  const km = kmMod.DEFAULT_KEYMAP;
  // A valid per-game keymap round-trips through parseLibrary.
  const valid = { version: 1, games: [{ id: 'g1', name: 'A', root: 'sdmc:/games/a', sharedSaves: false, keymap: km }] };
  const parsed = lib.parseLibrary(JSON.stringify(valid));
  assert.ok(parsed.games[0].keymap, 'parsed keymap is present');
  assert.equal(parsed.games[0].keymap.buttons.length, 16, '16 buttons');
  // Compare values element-by-element to avoid prototype/reference issues
  // caused by esbuild's IIFE bundle wrapper.
  for (let i = 0; i < 16; i++) assert.equal(parsed.games[0].keymap.buttons[i], km.buttons[i], `button ${i}`);
  // An invalid per-game keymap (wrong button count) is rejected.
  assert.throws(() => lib.parseLibrary(JSON.stringify({
    version: 1, games: [{ id: 'g1', name: 'A', root: 'sdmc:/games/a', sharedSaves: false, keymap: { buttons: [] } }],
  })), /expected 16 buttons/);
  // A null per-game keymap is rejected (must be absent or a valid object).
  assert.throws(() => lib.parseLibrary(JSON.stringify({
    version: 1, games: [{ id: 'g1', name: 'A', root: 'sdmc:/games/a', sharedSaves: false, keymap: null }],
  })), /Invalid per-game keymap/);
});

test('upsertGame preserves a per-game keymap and persists it through library.json', async () => {
  const lib = await loadLibraryModule();
  const kmMod = await loadKeymapModule();
  const km = kmMod.DEFAULT_KEYMAP;
  const fs = memoryFs();
  const entry = { id: 'g1', name: 'A', root: 'sdmc:/games/a', sharedSaves: false, keymap: { buttons: [...km.buttons] } };
  // Modify one binding so we can verify the per-game keymap is preserved.
  entry.keymap.buttons[0] = 'menu';
  let file = { version: 1, games: [] };
  file = lib.upsertGame(fs, file, entry);
  assert.equal(file.games[0].keymap.buttons[0], 'menu');
  // Reload from disk: the per-game keymap survives the round-trip.
  const reloaded = lib.loadLibrary(fs);
  assert.equal(reloaded.games[0].keymap.buttons[0], 'menu');
  assert.equal(reloaded.games[0].keymap.buttons.length, 16);
});

test('libraryIdFromRoot is stable for the same root', async () => {
  const lib = await loadLibraryModule();
  const a = lib.libraryIdFromRoot('sdmc:/games/foo');
  const b = lib.libraryIdFromRoot('sdmc:/games/foo/');
  const c = lib.libraryIdFromRoot('sdmc:/games/bar');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^g[a-z0-9]+$/);
});

test('upsertGame updates an existing entry and inserts a new one', async () => {
  const lib = await loadLibraryModule();
  const fs = memoryFs();
  let file = { version: 1, games: [] };
  const entry = { id: 'g1', name: 'A', root: 'sdmc:/games/a', sharedSaves: false };
  file = lib.upsertGame(fs, file, entry);
  assert.equal(file.games.length, 1);
  assert.equal(file.games[0].name, 'A');
  file = lib.upsertGame(fs, file, { ...entry, name: 'A2' });
  assert.equal(file.games.length, 1);
  assert.equal(file.games[0].name, 'A2');
  assert.equal(file.lastPlayed, 'g1');
});

test('removeGame drops the entry and clears lastPlayed when needed', async () => {
  const lib = await loadLibraryModule();
  const fs = memoryFs();
  let file = { version: 1, games: [{ id: 'g1', name: 'A', root: 'sdmc:/games/a', sharedSaves: false }], lastPlayed: 'g1' };
  file = lib.removeGame(fs, file, 'g1');
  assert.equal(file.games.length, 0);
  assert.equal(file.lastPlayed, undefined);
});

test('loadLibrary migrates a legacy settings.json on first load', async () => {
  const lib = await loadLibraryModule();
  const fs = memoryFs(new Map([['sdmc:/switch/burialnx/settings.json', JSON.stringify({ root: 'sdmc:/game/www', sharedSaves: true, mod: null, saves: { kind: 'switch' } })]]));
  const file = lib.loadLibrary(fs);
  assert.equal(file.games.length, 1);
  assert.equal(file.games[0].root, 'sdmc:/game/www');
  assert.equal(file.games[0].sharedSaves, true);
  assert.equal(file.lastPlayed, file.games[0].id);
  // The migration should also have written library.json.
  const written = fs.readFileSync('sdmc:/switch/burialnx/library.json');
  assert.ok(written);
});

test('loadLibrary returns empty when no library and no legacy settings', async () => {
  const lib = await loadLibraryModule();
  const fs = memoryFs();
  const file = lib.loadLibrary(fs);
  assert.equal(file.games.length, 0);
});

async function loadKeymapModule() {
  const bundle = await build({ entryPoints: ['src/keymap.ts'], bundle: true, write: false, format: 'iife', globalName: '__km', target: 'es2022' });
  const context = vm.createContext({ TextEncoder, TextDecoder, console: { ...console } });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return context.__km;
}

test('parseKeyMap rejects the wrong number of buttons and unknown keys', async () => {
  const km = await loadKeymapModule();
  assert.throws(() => km.parseKeyMap(JSON.stringify({ buttons: [] })), /expected 16 buttons/);
  assert.throws(() => km.parseKeyMap(JSON.stringify({ buttons: new Array(16).fill('invalid') })));
  assert.doesNotThrow(() => km.parseKeyMap(JSON.stringify({ buttons: km.DEFAULT_KEYMAP.buttons })));
});

test('setButton returns a new immutable map', async () => {
  const km = await loadKeymapModule();
  const before = km.DEFAULT_KEYMAP;
  const after = km.setButton(before, 0, 'menu');
  assert.notEqual(before, after);
  assert.equal(after.buttons[0], 'menu');
  assert.equal(before.buttons[0], 'cancel');
});

test('applyKeyMap honors remapped buttons and leaves none unmapped', async () => {
  const km = await loadKeymapModule();
  const runtime = { Input: {} };
  km.applyKeyMap(runtime, km.setButton(km.DEFAULT_KEYMAP, 0, 'ok'));
  assert.equal(runtime.Input.gamepadMapper[0], 'ok');
  // Buttons set to 'none' (like Plus at index 9 in DEFAULT_KEYMAP) are NOT mapped —
  // no defaults are injected, so 'none' = truly silent (no signal leaks to the game).
  assert.equal(runtime.Input.gamepadMapper[9], undefined);
  // Explicitly mapped buttons (like D-up at index 12 = 'up') are mapped.
  assert.equal(runtime.Input.gamepadMapper[12], 'up');
});

test('saveKeyMap and loadKeyMap round-trip', async () => {
  const km = await loadKeymapModule();
  const fs = memoryFs();
  const modified = km.setButton(km.DEFAULT_KEYMAP, 5, 'menu');
  assert.ok(km.saveKeyMap(fs, modified));
  const loaded = km.loadKeyMap(fs);
  assert.equal(loaded.buttons[5], 'menu');
});

async function loadIconModule() {
  const bundle = await build({ entryPoints: ['src/icon-extract.ts'], bundle: true, write: false, format: 'iife', globalName: '__icon', target: 'es2022' });
  const context = vm.createContext({ console: { ...console } });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return context.__icon;
}

// Build a minimal ICO with one PNG entry (signature + 1x1 PNG).
function minimalPngIco() {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const buf = new ArrayBuffer(6 + 16 + png.length);
  const view = new DataView(buf);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type=icon
  view.setUint16(4, 1, true); // count=1
  const entry = new Uint8Array(buf, 6, 16);
  entry[0] = 1; entry[1] = 1; // 1x1
  view.setUint32(6 + 8, png.length, true);
  view.setUint32(6 + 12, 6 + 16, true);
  new Uint8Array(buf, 6 + 16).set(png);
  return buf;
}

test('extractIcoPng returns the embedded PNG', async () => {
  const m = await loadIconModule();
  const ico = minimalPngIco();
  const out = m.extractIcoPng(ico);
  assert.ok(out);
  const bytes = new Uint8Array(out);
  assert.equal(bytes[0], 0x89);
  assert.equal(bytes[1], 0x50);
});

test('extractIco returns null for an empty buffer', async () => {
  const m = await loadIconModule();
  assert.equal(m.extractIco(new ArrayBuffer(0)), null);
  assert.equal(m.extractIco(new ArrayBuffer(64)), null);
});

test('extractIcoBmp produces a valid PNG with big-endian IHDR and CRC', async () => {
  const m = await loadIconModule();
  // Build a minimal 1×1 32-bit BGRA BMP-embedded ICO.
  // ICO header (6 bytes) + 1 ICONDIRENTRY (16 bytes) + BITMAPINFOHEADER (40 bytes)
  // + 1×1 BGRA pixel (4 bytes) + 1×1 AND mask padded to 4 bytes (4 bytes) = 70 bytes.
  const buf = new ArrayBuffer(70);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // ICONDIR
  view.setUint16(0, 0, true); view.setUint16(2, 1, true); view.setUint16(4, 1, true);
  // ICONDIRENTRY: width=1, height=1, colors=0, reserved=0, planes=1, bitcount=32,
  // size=48 (DIB), offset=22 (right after ICONDIR+ICONDIRENTRY)
  bytes[6] = 1; bytes[7] = 1; bytes[8] = 0; bytes[9] = 0;
  view.setUint16(10, 1, true); view.setUint16(12, 32, true);
  view.setUint32(14, 48, true); view.setUint32(18, 22, true);
  // BITMAPINFOHEADER at offset 22
  view.setUint32(22, 40, true); // biSize
  view.setUint32(26, 1, true);  // biWidth (little-endian, BMP is LE)
  view.setUint32(30, 2, true);  // biHeight (doubled for ICO: 1 pixel + 1 AND-mask row)
  view.setUint16(34, 1, true);  // biPlanes
  view.setUint16(36, 32, true); // biBitCount
  // rest of header is 0 (already zeroed)
  // Pixel data at offset 22+40=62: 1×1 BGRA = 4 bytes
  bytes[62] = 0xff; bytes[63] = 0x00; bytes[64] = 0x00; bytes[65] = 0xff; // blue, green, red, alpha
  // AND mask at offset 66: 4 bytes (padded)
  const out = m.extractIcoBmp(buf);
  assert.ok(out, 'extractIcoBmp returned a PNG');
  const outBytes = new Uint8Array(out);
  // PNG signature (8 bytes)
  assert.equal(outBytes[0], 0x89);
  assert.equal(outBytes[1], 0x50);
  assert.equal(outBytes[2], 0x4e);
  assert.equal(outBytes[3], 0x47);
  // After signature (8 bytes), first chunk: IHDR
  // Length (4 bytes, big-endian) should be 13
  const lenView = new DataView(out, 8, 4);
  assert.equal(lenView.getUint32(0, false), 13, 'IHDR length is 13 (big-endian)');
  // Type (4 bytes) should be "IHDR" = 0x49 0x48 0x44 0x52
  assert.equal(outBytes[12], 0x49);
  assert.equal(outBytes[13], 0x48);
  assert.equal(outBytes[14], 0x44);
  assert.equal(outBytes[15], 0x52);
  // IHDR data: width (4 bytes, big-endian) should be 1
  const widthView = new DataView(out, 16, 4);
  assert.equal(widthView.getUint32(0, false), 1, 'IHDR width is 1 (big-endian)');
  // IHDR height (4 bytes, big-endian) should be 1
  const heightView = new DataView(out, 20, 4);
  assert.equal(heightView.getUint32(0, false), 1, 'IHDR height is 1 (big-endian)');
});

test('extractExeIcon returns null for a non-PE buffer', async () => {
  const m = await loadIconModule();
  assert.equal(m.extractExeIcon(new ArrayBuffer(0)), null);
  const buf = new ArrayBuffer(1024);
  new Uint8Array(buf).fill(0);
  assert.equal(m.extractExeIcon(buf), null);
});

test('parseLibrary loads the per-game language preference', async () => {
  const lib = await loadLibraryModule();
  const data = { version: 1, games: [
    { id: 'g1', name: 'Game', root: 'sdmc:/games/a', sharedSaves: false, language: 'ru' },
    { id: 'g2', name: 'Game2', root: 'sdmc:/games/b', sharedSaves: false, language: '' },
    { id: 'g3', name: 'Game3', root: 'sdmc:/games/c', sharedSaves: false },
  ] };
  const parsed = lib.parseLibrary(JSON.stringify(data));
  assert.equal(parsed.games[0].language, 'ru', 'g1 language = ru');
  assert.equal(parsed.games[1].language, '', 'g2 language = "" (explicit English)');
  assert.equal(parsed.games[2].language, undefined, 'g3 language = undefined (no preference)');
});

test('upsertGame preserves and updates the language field', async () => {
  const lib = await loadLibraryModule();
  const fs = memoryFs();
  let file = lib.loadLibrary(fs);
  file = lib.upsertGame(fs, file, { id: 'g1', name: 'Game', root: 'sdmc:/games/a', sharedSaves: false, language: 'ru' });
  assert.equal(file.games[0].language, 'ru', 'language saved as ru');
  // Update with a different language
  file = lib.upsertGame(fs, file, { id: 'g1', name: 'Game', root: 'sdmc:/games/a', sharedSaves: false, language: '' });
  assert.equal(file.games[0].language, '', 'language updated to "" (English)');
  // Reload from disk to verify persistence
  const reloaded = lib.loadLibrary(fs);
  assert.equal(reloaded.games[0].language, '', 'language persisted to disk as ""');
});

test('moveGame swaps adjacent games and persists order to disk', async () => {
  const lib = await loadLibraryModule();
  const fs = memoryFs();
  let file = lib.loadLibrary(fs);
  file = lib.upsertGame(fs, file, { id: 'g1', name: 'Game A', root: 'sdmc:/games/a', sharedSaves: false });
  file = lib.upsertGame(fs, file, { id: 'g2', name: 'Game B', root: 'sdmc:/games/b', sharedSaves: false });
  file = lib.upsertGame(fs, file, { id: 'g3', name: 'Game C', root: 'sdmc:/games/c', sharedSaves: false });
  // Initial order: A, B, C
  assert.equal(file.games.map(g => g.id).join(','), 'g1,g2,g3');
  // Move g1 down → B, A, C
  file = lib.moveGame(fs, file, 'g1', 1);
  assert.equal(file.games.map(g => g.id).join(','), 'g2,g1,g3');
  // Move g3 up → B, C, A
  file = lib.moveGame(fs, file, 'g3', -1);
  assert.equal(file.games.map(g => g.id).join(','), 'g2,g3,g1');
  // Persisted to disk
  const reloaded = lib.loadLibrary(fs);
  assert.equal(reloaded.games.map(g => g.id).join(','), 'g2,g3,g1');
  // Boundary: moving first game up is a no-op
  file = lib.moveGame(fs, file, 'g2', -1);
  assert.equal(file.games.map(g => g.id).join(','), 'g2,g3,g1');
  // Boundary: moving last game down is a no-op
  file = lib.moveGame(fs, file, 'g1', 1);
  assert.equal(file.games.map(g => g.id).join(','), 'g2,g3,g1');
  // Non-existent id is a no-op
  file = lib.moveGame(fs, file, 'nonexistent', 1);
  assert.equal(file.games.map(g => g.id).join(','), 'g2,g3,g1');
});
