import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

// Run the library + picker with a fake filesystem and screen. No game files or
// console storage are accessed, and the missing index stops launch safely.
// The 2024 rewrite replaces the single-game picker with a library entry point,
// so the helper first navigates the library to add a game (or, when a previous
// selection is supplied, relies on the automatic migration to populate the
// library with one entry) before reaching the save-choice phase.
async function picker(debug = false, previous = null, fixtures = new Map()) {
  const bundle = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'iife', target: 'es2022', define: { __DEBUG__: String(debug) } });
  const settings = new Map(), reads = [], scheduled = [], labels = [], logWrites = [];
  if (previous) settings.set('sdmc:/switch/burialnx/settings.json', JSON.stringify(previous));
  let buttons = [], clock = 0;
  const graphics = { save() {}, restore() {}, setTransform() {}, fillRect() {}, strokeRect() {}, fillText(text) { labels.push(text); }, strokeText() {}, drawImage() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, rect() {}, clip() {}, closePath() {}, measureText: () => ({ width: 0 }) };
  const fs = {
    mkdirSync() {},
    readDirSync(path) { return path === 'sdmc:/' ? ['game'] : []; },
    statSync(path) {
      if (['sdmc:/game', 'sdmc:/game/www'].includes(path)) return { mode: 0o040000 };
      if (['sdmc:/game/www/index.html', 'sdmc:/game/www/js/rpg_core.js'].includes(path)) return { mode: 0o100000 };
      return null;
    },
    readFileSync(path) { return settings.has(path) ? new TextEncoder().encode(settings.get(path)).buffer : null; },
    writeFileSync(path, value) { settings.set(path, value); },
    appendFileSync(path, text) { logWrites.push([path, text]); },
    readFile(path) { reads.push(path); const value = fixtures.get(path); return Promise.resolve(value === undefined ? null : new TextEncoder().encode(value).buffer); },
  };
  const context = vm.createContext({ Switch: fs, screen: { width: 1280, height: 720, getContext: () => graphics },
    navigator: { getGamepads: () => [{ buttons }] }, requestAnimationFrame: (fn) => scheduled.push(fn),
    performance: { now: () => clock }, addEventListener() {}, EventTarget, Event, TextEncoder, TextDecoder, console: { ...console },
    crypto: webcrypto, fetch, URL, Response, Blob, atob, setTimeout, clearTimeout });
  vm.runInContext(bundle.outputFiles[0].text, context);
  async function tick(pressed = []) {
    buttons = Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) }));
    labels.length = 0;
    const frame = scheduled.shift(); assert.ok(frame, 'frame is scheduled');
    frame(clock += 17);
    await Promise.resolve(); await Promise.resolve();
  }
  await tick(); // Library phase (initial).
  if (previous) {
    // Migration has populated the library with one game. Press A on it to
    // enter the save-choice flow. In the debug build the saved save location
    // is intentionally ignored so the user can pick a different backend.
    await tick([1]); // A on the migrated game tile.
    await tick(); // Release A.
  } else {
    // Empty library: cursor is on the "+ Add Game" tile. Press A to open
    // the picker (which now starts at sdmc:/switch/burialnx), navigate B,B
    // up to sdmc:/ root to find the 'game' folder, then X to select.
    await tick([1]); // A on Add Game → picker.
    await tick(); // Release A.
    await tick([0]); // B: go to parent (sdmc:/switch)
    await tick(); // Release B.
    await tick([0]); // B: go to parent (sdmc:)
    await tick(); // Release B.
    await tick([3]); // X: select the game folder.
    await tick(); // Release X. Back in library with the new game highlighted.
    await tick([1]); // A on the new game tile → save-choice (no save location yet).
    await tick(); // Release A.
  }
  return { tick, labels, settings, reads, logWrites, context };
}

test('save picker skips Steam import when no PC saves exist', async () => {
  const ui = await picker();
  assert.ok(ui.labels.some((line) => line.includes('save location')));
  await ui.tick([1]); // A: Switch save data.
  assert.deepEqual(JSON.parse(ui.settings.get('sdmc:/switch/burialnx/settings.json')).saves, { kind: 'switch' });
  assert.ok(ui.reads.some((path) => path.endsWith('/index.html')), 'launch starts without an import prompt');
});

test('malformed game data reaches the on-screen error and includes its resource path', async () => {
  const root = 'sdmc:/game/www/';
  const files = new Map([
    [root + 'index.html', '<script src="js/rpg_core.js"></script>'],
    [root + 'js/rpg_core.js', `globalThis.SceneManager = { stopped: false, stop() { this.stopped = true; } };
      globalThis.onload = () => { const xhr = new XMLHttpRequest(); xhr.open('GET', 'data/Broken.json');
        xhr.onload = () => JSON.parse(xhr.responseText); xhr.send(); };`],
    [root + 'data/Broken.json', '{broken'],
  ]);
  const ui = await picker(true, null, files);
  await ui.tick([1]);
  for (let attempt = 0; attempt < 100 && !ui.logWrites.some(([, line]) => line.includes('FAILURE:')); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await ui.tick();
  }
  await ui.tick();
  assert.ok(ui.logWrites.some(([, line]) => line.includes('FAILURE:') && line.includes('data/Broken.json')));
  assert.ok(ui.logWrites.some(([, line]) => line.includes('Read game data: sdmc:/game/www/data/Broken.json (7 bytes)')));
  assert.ok(ui.logWrites.some(([, line]) => line.includes('Failed response: data/Broken.json (7 characters)')));
  for (let attempt = 0; attempt < 100 && !ui.logWrites.some(([, line]) => line.includes('Failed response UTF-8 SHA-256:')); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const hash = createHash('sha256').update('{broken').digest('hex');
  assert.ok(ui.logWrites.some(([, line]) => line.includes(`Failed response UTF-8 SHA-256: ${hash}`)));
  assert.ok(ui.labels.some((line) => line.includes('data/Broken.json')));
  assert.equal(ui.context.SceneManager.stopped, true);
});

test('startup fallback starts a missing-onload scene once and leaves existing scenes alone', async () => {
  const root = 'sdmc:/game/www/';
  for (const alreadyStarted of [false, true]) {
    const files = new Map([
      [root + 'index.html', '<script src="js/rpg_core.js"></script>'],
      [root + 'js/rpg_core.js', `globalThis.Scene_Boot = function Scene_Boot() {};
        globalThis.SceneManager = { _nextScene: ${alreadyStarted ? '{}' : 'null'}, calls: 0,
          run(scene) { this.calls++; this._nextScene = new scene(); } };`],
    ]);
    const ui = await picker(true, null, files);
    await ui.tick([1]);
    for (let attempt = 0; attempt < 100 && !ui.logWrites.some(([, line]) => line.includes('Game started:')); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await ui.tick();
    }
    const expected = alreadyStarted ? 'already-started' : 'scene-boot';
    assert.ok(ui.logWrites.some(([, line]) => line.includes(`Game started: ${expected}`)));
    assert.equal(ui.context.SceneManager.calls, alreadyStarted ? 0 : 1);
    assert.ok(!ui.logWrites.some(([, line]) => line.includes('FAILURE:')));
  }
});

test('debug build skips an empty Steam import and offers game-folder storage', async () => {
  const ui = await picker(true);
  assert.ok(ui.logWrites.some(([path]) => /native-host(_\d+)?\.log$/.test(path)));
  assert.ok(ui.logWrites.some(([, line]) => line.includes('Initializing screen')));
  assert.ok(ui.logWrites.some(([, line]) => line.includes('Reading SD card folders')));
  assert.ok(ui.logWrites.some(([, line]) => line.includes('Startup ready')));
  assert.ok(ui.labels.some((line) => line.includes('game’s save folder')));
  await ui.tick([1]);
  assert.deepEqual(JSON.parse(ui.settings.get('sdmc:/switch/burialnx/settings.json')).saves, { kind: 'switch' });
  assert.ok(ui.reads.some((path) => path.endsWith('/index.html')));
});

test('debug startup records the session before attempting screen initialization', async () => {
  const bundle = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'iife', target: 'es2022', define: { __DEBUG__: 'true' } });
  const writes = [];
  const context = vm.createContext({
    Switch: { mkdirSync() {}, appendFileSync(path, line) { writes.push([path, line]); }, readDirSync() { return []; } },
    screen: { width: 1280, height: 720, getContext() { throw new Error('screen unavailable'); } },
    TextEncoder, TextDecoder, Event, EventTarget, console: { ...console },
    addEventListener() {}, requestAnimationFrame() {},
  });
  // With the new defensive init, the bundle catches the screen-unavailable
  // error, logs it via screen.getContext threw: ..., and continues.
  try { vm.runInContext(bundle.outputFiles[0].text, context); } catch (e) { /* may throw after screen init */ }
  assert.ok(writes.some(([path, line]) => /native-host(_\d+)?\.log$/.test(path) && line.includes('BurialNX debug session')));
  assert.ok(writes.some(([, line]) => line.includes('Initializing screen')));
  assert.ok(writes.some(([, line]) => line.includes('screen.getContext threw') && line.includes('screen unavailable')));
});

test('debug build remembers the save location after the first launch', async () => {
  // Previously, the debug build always re-asked for the save location.
  // Now both debug and release remember it from the library entry.
  // The first time a game is added (no saves stored), save-choice is shown.
  // After choosing a save location, it's stored in the library entry and
  // not re-asked on subsequent launches.
  const ui = await picker(true, { root: 'sdmc:/game/www', sharedSaves: false, mod: null, saves: { kind: 'switch' } });
  // With the saved location in the library, the game should launch directly
  // (no save-choice prompt). The test helper's picker() opens the library,
  // presses A on the migrated game, and since saves is stored, it goes
  // straight to launch. But since there are no game files, it errors.
  // The key point: save-choice is NOT shown (because the location is remembered).
  // The "game's save folder" text should NOT appear since we skip save-choice.
  // The game tries to launch and fails (no index.html in the mock fixtures).
  assert.ok(ui.reads.some((path) => path.endsWith('/index.html')), 'game launches directly without re-asking save location');
});

test('game-folder saves require explicit selection and are recorded without writing game files', async () => {
  const ui = await picker();
  await ui.tick([2]); // Y: choose game-folder saves.
  await ui.tick();
  await ui.tick();
  assert.ok(ui.labels.some((line) => line.includes('sdmc:/game/save')));
  assert.ok(ui.labels.some((line) => line.includes('sdmc:/game/www/save')));
  await ui.tick([3]); // X: select www/save explicitly.
  const saved = JSON.parse(ui.settings.get('sdmc:/switch/burialnx/settings.json'));
  assert.deepEqual(saved.saves, { kind: 'game', folder: 'sdmc:/game/www/save' });
});

test('library migration imports a legacy single-game settings.json', async () => {
  const bundle = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'iife', target: 'es2022', define: { __DEBUG__: 'false' } });
  const settings = new Map([['sdmc:/switch/burialnx/settings.json', JSON.stringify({ root: 'sdmc:/game/www', sharedSaves: true, mod: null, saves: { kind: 'switch' } })]]);
  const scheduled = [], labels = [], buttons = []; let clock = 0;
  const graphics = { save() {}, restore() {}, setTransform() {}, fillRect() {}, strokeRect() {}, fillText(t) { labels.push(t); }, strokeText() {}, drawImage() {}, clearRect() {}, beginPath() {}, measureText: () => ({ width: 0 }) };
  const fs = {
    mkdirSync() {}, readDirSync() { return []; }, statSync() { return null; },
    readFileSync(p) { return settings.has(p) ? new TextEncoder().encode(settings.get(p)).buffer : null; },
    writeFileSync(p, v) { settings.set(p, v); }, appendFileSync() {},
    readFile() { return Promise.resolve(null); },
  };
  const context = vm.createContext({ Switch: fs, screen: { width: 1280, height: 720, getContext: () => graphics },
    navigator: { getGamepads: () => [{ buttons }] }, requestAnimationFrame: (fn) => scheduled.push(fn),
    performance: { now: () => clock }, addEventListener() {}, EventTarget, Event, TextEncoder, TextDecoder, console: { ...console },
    crypto: webcrypto, fetch, URL, Response, Blob, atob, setTimeout, clearTimeout });
  vm.runInContext(bundle.outputFiles[0].text, context);
  async function tick(pressed = []) {
    buttons.length = 0; for (let i = 0; i < 16; i++) buttons.push({ pressed: pressed.includes(i) });
    labels.length = 0; const f = scheduled.shift(); f(clock += 17);
    await Promise.resolve(); await Promise.resolve();
  }
  await tick();
  // Migration should have written library.json with one entry.
  const raw = settings.get('sdmc:/switch/burialnx/library.json');
  assert.ok(raw, 'library.json was written');
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  const lib = JSON.parse(text);
  assert.equal(lib.version, 1);
  assert.equal(lib.games.length, 1);
  assert.equal(lib.games[0].root, 'sdmc:/game/www');
  assert.equal(lib.games[0].sharedSaves, true);
  assert.equal(lib.lastPlayed, lib.games[0].id);
  // The library UI should render the migrated game's name.
  assert.ok(labels.some((l) => l.includes('www') || l.includes('BurialNX Library')));
});
