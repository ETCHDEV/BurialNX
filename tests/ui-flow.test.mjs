import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

// Run just the picker with a fake filesystem and screen. No game files or
// console storage are accessed, and the missing index stops launch safely.
async function picker(debug = false, previous = null, fixtures = new Map()) {
  const bundle = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'iife', target: 'es2022', define: { __DEBUG__: String(debug) } });
  const settings = new Map(), reads = [], scheduled = [], labels = [], logWrites = [];
  if (previous) settings.set('sdmc:/switch/burialnx/settings.json', JSON.stringify(previous));
  let buttons = [], clock = 0;
  const graphics = { save() {}, restore() {}, setTransform() {}, fillRect() {}, fillText(text) { labels.push(text); } };
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
  await tick();
  await tick([3]); // X: select the game folder.
  await tick(); // Release X.
  if (debug) { await tick([2]); await tick(); } // Y: no startup mod.
  await tick(); // Display the save choice.
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
  assert.ok(ui.logWrites.some(([path]) => path === 'sdmc:/switch/burialnx/LOGS/native-host.log'));
  assert.ok(ui.logWrites.some(([, line]) => line.includes('Initializing screen')));
  assert.ok(ui.logWrites.some(([, line]) => line.includes('Reading SD card folders')));
  assert.ok(ui.logWrites.some(([, line]) => line.includes('Startup ready: picker')));
  assert.ok(ui.labels.some((line) => line.includes('game’s save folder')));
  await ui.tick([1]);
  assert.deepEqual(JSON.parse(ui.settings.get('sdmc:/switch/burialnx/settings.json')).saves, { kind: 'switch' });
  assert.ok(ui.reads.some((path) => path.endsWith('/index.html')));
});

test('debug startup records the session before attempting screen initialization', async () => {
  const bundle = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'iife', target: 'es2022', define: { __DEBUG__: 'true' } });
  const writes = [];
  const context = vm.createContext({
    Switch: { mkdirSync() {}, appendFileSync(path, line) { writes.push([path, line]); } },
    screen: { getContext() { throw new Error('screen unavailable'); } },
    TextEncoder, TextDecoder, Event, EventTarget, console: { ...console },
  });
  assert.throws(() => vm.runInContext(bundle.outputFiles[0].text, context), /screen unavailable/);
  assert.ok(writes.some(([path, line]) => path === 'sdmc:/switch/burialnx/LOGS/native-host.log' && line.includes('BurialNX debug session')));
  assert.ok(writes.some(([, line]) => line.includes('Initializing screen')));
  assert.ok(!writes.some(([, line]) => line.includes('Reading SD card folders')));
});

test('debug build offers save choice even when an earlier location is remembered', async () => {
  const ui = await picker(true, { root: 'sdmc:/game/www', sharedSaves: false, mod: null, saves: { kind: 'switch' } });
  assert.ok(ui.labels.some((line) => line.includes('game’s save folder')));
  assert.equal(ui.reads.length, 0, 'does not launch before the save choice');
  await ui.tick([2]); await ui.tick(); await ui.tick();
  await ui.tick([1]);
  assert.deepEqual(JSON.parse(ui.settings.get('sdmc:/switch/burialnx/settings.json')).saves, { kind: 'game', folder: 'sdmc:/game/save' });
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
  assert.deepEqual([...ui.settings.keys()], ['sdmc:/switch/burialnx/settings.json']);
});
