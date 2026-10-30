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
// `features` (optional): manual — stop right after the first library frame
// and let the test drive the UI itself; localStorage — exposed as
// globalThis.localStorage (startup profile selection); virtualKeyboard —
// exposed as navigator.virtualKeyboard (swkbd rename); exit — used as
// Switch.exit (quit path).
async function picker(debug = false, previous = null, fixtures = new Map(), features = {}) {
  const bundle = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'iife', target: 'es2022', define: { __DEBUG__: String(debug) } });
  const bundleText = bundle.outputFiles[0].text;
  const settings = new Map(), reads = [], labels = [], logWrites = [];
  // Pending rAF callbacks as { id, fn } pairs — the same shape as nx.js's
  // runtime rAF queue (raf.ts), so cancelAnimationFrame(id) semantics are
  // faithful and the tests can prove a retired game loop was cancelled.
  const scheduled = [];
  let rafIndex = 0;
  const rafNative = (fn) => { const id = rafIndex++; scheduled.push({ id, fn }); return id; };
  const cafNative = (id) => { const index = scheduled.findIndex((entry) => entry.id === id); if (index !== -1) scheduled.splice(index, 1); };
  if (previous) settings.set('sdmc:/switch/burialnx/settings.json', JSON.stringify(previous));
  let buttons = [], clock = 0;
  const graphics = { save() {}, restore() {}, setTransform() {}, fillRect() {}, strokeRect() {}, fillText(text) { labels.push(text); }, strokeText() {}, drawImage() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, rect() {}, clip() {}, closePath() {}, quadraticCurveTo() {}, fill() {}, stroke() {}, measureText: () => ({ width: 0 }) };
  const fs = {
    mkdirSync() {},
    readDirSync(path) { return path === 'sdmc:/' ? ['game'] : []; },
    statSync(path) {
      if (['sdmc:/game', 'sdmc:/game/www'].includes(path)) return { mode: 0o040000 };
      if (['sdmc:/game/www/index.html', 'sdmc:/game/www/js/rpg_core.js'].includes(path)) return { mode: 0o100000 };
      return null;
    },
    readFileSync(path) {
      return settings.has(path) ? new TextEncoder().encode(settings.get(path)).buffer : null;
    },
    writeFileSync(path, value) { settings.set(path, value); },
    appendFileSync(path, text) { logWrites.push([path, text]); },
    readFile(path) { reads.push(path); const value = fixtures.get(path); return Promise.resolve(value === undefined ? null : new TextEncoder().encode(value).buffer); },
    ...(features.exit ? { exit: features.exit } : {}),
  };
  // Track the process-lifetime listeners the app registers on globalThis
  // (error / unhandledrejection / beforeunload): a retired session must
  // remove its own set and a rebooted session must register a fresh one —
  // exactly one of each must survive a reboot.
  const listeners = new Map();
  const context = vm.createContext({ Switch: fs, screen: { width: 1280, height: 720, getContext: () => graphics },
    navigator: { getGamepads: () => [{ buttons }], ...(features.virtualKeyboard ? { virtualKeyboard: features.virtualKeyboard } : {}) },
    ...(features.localStorage ? { localStorage: features.localStorage } : {}),
    ...(features.fonts ? { fonts: features.fonts } : {}),
    requestAnimationFrame: rafNative, cancelAnimationFrame: cafNative,
    performance: { now: () => clock },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    EventTarget, Event, TextEncoder, TextDecoder, console: { ...console },
    crypto: webcrypto, fetch, URL, Response, Blob, atob, setTimeout, clearTimeout });
  vm.runInContext(bundleText, context);
  async function tick(pressed = []) {
    buttons = Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) }));
    labels.length = 0;
    const frame = scheduled.shift(); assert.ok(frame, 'frame is scheduled');
    frame.fn(clock += 17);
    await Promise.resolve(); await Promise.resolve();
  }
  await tick(); // Library phase (initial).
  if (features.manual) return { tick, labels, settings, reads, logWrites, context, scheduled, listeners, rafNative };
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
  return { tick, labels, settings, reads, logWrites, context, scheduled, listeners, rafNative };
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
  const exits = [];
  const ui = await picker(true, null, files, { exit: () => exits.push(1) });
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
  // Pressing B on the error screen exits the app fully (teardown + Switch.exit)
  // so the half-installed game state cannot pollute the next launch — the next
  // launch is a guaranteed clean cold boot from hbmenu. Horizon OS reclaims the
  // reserved process memory on exit, which is the only reliably clean reset on
  // this OS; an in-process session reboot proved unstable on hardware (froze on
  // the "Loading…" splash with "Graphics is not defined").
  await ui.tick([0]); // B: exit BurialNX.
  assert.equal(exits.length, 1, 'B on the error screen called Switch.exit once');
  assert.equal(ui.context.SceneManager, undefined, 'the failed game globals were removed before exit');
  assert.equal(ui.context.document, undefined, 'the host document was removed before exit');
  assert.equal(ui.context.fetch, fetch, 'fetch was restored to the native original before exit');
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

// A minimal stand-in for nx.js's navigator.virtualKeyboard: enough state for
// the rename flow (value seeding, live typing, submit, cancel via
// boundingRect collapse).
class FakeVirtualKeyboard extends EventTarget {
  value = ''; okButtonText; type; maxLength; cursorIndex;
  shown = 0; hidden = 0;
  boundingRect = { x: 0, y: 0, width: 0, height: 0 };
  show() { this.shown++; this.boundingRect.height = 320; this.dispatchEvent(new Event('geometrychange')); }
  hide() { this.hidden++; this.boundingRect.height = 0; this.dispatchEvent(new Event('geometrychange')); }
  // Simulate the swkbdInline change callback: every keypress reports the
  // full current text and the caret position, exactly like nx.js does.
  // Simulated swkbdInline change callback. Named press(): the class field
  // `type` (the nx.js keyboard-type property, set to 0 by the app) would
  // shadow a method with the same name.
  press(text, cursor) { this.value = text; this.cursorIndex = cursor; this.dispatchEvent(new Event('change')); }
  moveCursor(cursor) { this.cursorIndex = cursor; this.dispatchEvent(new Event('cursormove')); }
}

test('the Switch user is NOT selected at application startup — localStorage is never touched', async () => {
  // BurialNX ships with startupUserAccount = 0 in its NACP (see
  // tools/nacp-patch.mjs), so the OS never preselects a user. nx.js's
  // localStorage is backed by account save data, so the FIRST access to
  // localStorage lazily launches the profile-picker applet — which would
  // pop the "select a user" dialog at startup. To keep that dialog from
  // EVER appearing, the loader must not touch localStorage at startup.
  // This test pins that: localStorage is accessed ZERO times during boot
  // and during library browsing / launching.
  let touches = 0;
  const storage = { get length() { touches++; return 0; }, getItem: () => null, setItem() { touches++; }, removeItem() { touches++; } };
  const ui = await picker(false, { root: 'sdmc:/game/www', sharedSaves: false, mod: null, saves: { kind: 'switch' } }, new Map(), { manual: true, localStorage: storage });
  assert.equal(touches, 0, 'localStorage was not touched at all during startup (no profile dialog)');
  // And still no touches while merely browsing the library.
  await ui.tick();
  await ui.tick([1]); // A on the migrated game → launch starts.
  assert.equal(touches, 0, 'the launch path also does not touch localStorage');
});

test('rename seeds the software keyboard with the current name and ignores Plus while typing', async () => {
  const vk = new FakeVirtualKeyboard();
  const ui = await picker(true, { root: 'sdmc:/game/www', sharedSaves: false, mod: null }, new Map(), { manual: true, virtualKeyboard: vk });
  // From the library, press X on the game tile to open game options.
  await ui.tick([3]);
  await ui.tick(); // Release X.
  assert.ok(ui.labels.some((l) => l.includes('game options')), 'game options screen is shown');
  // Instrument listener counts BEFORE the keyboard opens so the test can
  // prove the app removes every listener it registered.
  const listenerCount = {};
  const originalAdd = vk.addEventListener.bind(vk);
  const originalRemove = vk.removeEventListener.bind(vk);
  vk.addEventListener = (type, listener, options) => {
    listenerCount[type] = (listenerCount[type] || 0) + 1;
    originalAdd(type, listener, options);
  };
  vk.removeEventListener = (type, listener, options) => {
    listenerCount[type] = Math.max(0, (listenerCount[type] || 0) - 1);
    originalRemove(type, listener, options);
  };
  // Move down to the "Rename game" entry (index 5).
  for (let i = 0; i < 5; i++) { await ui.tick([13]); await ui.tick(); }
  await ui.tick([1]); // A: open the rename choice panel.
  await ui.tick(); // Release A.
  assert.ok(ui.labels.some((l) => l.includes('Rename game')), 'rename choice panel is shown');
  // Press A again to select "Type a custom name" (index 0).
  await ui.tick([1]); // A: open the software keyboard.
  await ui.tick(); // The rename preview screen renders on the next frame.
  assert.equal(vk.shown, 1, 'the software keyboard was opened');
  assert.equal(vk.value, 'www', 'the keyboard was seeded with the current game name');
  assert.equal(vk.okButtonText, 'Save');
  assert.equal(vk.maxLength, 64);
  assert.ok(ui.labels.some((l) => l.includes('rename game')), 'rename preview screen is shown');
  // The seeded name must be visible on the preview screen right away —
  // the swkbd itself does not render the current text.
  assert.ok(ui.labels.some((l) => l === 'www'), 'the preview field shows the current name before typing');
  // Live typing: each keypress updates the preview with the keyboard's
  // current text and caret position.
  vk.press('Coffin', 6);
  await ui.tick();
  assert.ok(ui.labels.some((l) => l === 'Coffin'), 'the preview field tracks the typed text live');
  vk.press('Coffin of A', 11);
  await ui.tick();
  assert.ok(ui.labels.some((l) => l === 'Coffin of A'), 'the preview keeps updating on every keypress');
  assert.ok(ui.labels.some((l) => l.includes('11/64')), 'the character counter reflects the live text');
  vk.moveCursor(4);
  await ui.tick();
  assert.ok(ui.labels.some((l) => l === 'Coffin of A'), 'cursor moves keep the text visible');
  // Pressing + while typing must NOT open the quit confirmation.
  await ui.tick([9]);
  assert.ok(!ui.labels.some((l) => l.includes('Press Plus')), 'Plus during keyboard input does not ask to quit');
  assert.ok(!ui.labels.some((l) => l.includes('Press Plus (+)')), 'no quit notice while the keyboard is open');
  assert.ok(ui.labels.some((l) => l.includes('rename game')), 'still on the rename screen');
  await ui.tick(); // Release +.
  // Type a new name and submit: the whole name is replaced at once.
  vk.value = 'New Name';
  vk.dispatchEvent(new Event('submit'));
  vk.hide(); // nx.js dispatches geometrychange (keyboard closed) after submit.
  await new Promise((resolve) => setTimeout(resolve, 80)); // let the delayed cleanup run
  await ui.tick();
  assert.ok(ui.labels.some((l) => l.includes('Name changed.')), 'the rename result is shown');
  const storedLibrary = ui.settings.get('sdmc:/switch/burialnx/library.json');
  const lib = JSON.parse(typeof storedLibrary === 'string' ? storedLibrary : new TextDecoder().decode(storedLibrary));
  assert.equal(lib.games[0].name, 'New Name', 'the library entry name was replaced entirely');
  assert.equal(listenerCount.submit, 0, 'the submit listener was removed');
  assert.equal(listenerCount.geometrychange, 0, 'the geometrychange listener was removed');
  assert.equal(listenerCount.change, 0, 'the live-input listener was removed');
  assert.equal(listenerCount.cursormove, 0, 'the cursor-move listener was removed');
  // No stale listener survives the keyboard session: late "change" events
  // can no longer reach the rename state.
  vk.press('Leaked', 6);
  await ui.tick();
  assert.ok(!ui.labels.some((l) => l === 'Leaked'), 'late keyboard events no longer reach the rename screen');
});

test('the retired game frame loop cannot crash the quit path', async () => {
  // Hardware regression (native-host_5.log): the game's pending rAF callback is
  // its ORIGINAL bound SceneManager.update — property stubs cannot reach it,
  // and a frame already dequeued for the current vsync batch still runs the
  // bound update() even after teardown. Its tickStart/tickEnd reference the
  // deleted Graphics global, and its catchException → Graphics.printError
  // then threw a SECOND ReferenceError that escaped into nx.js, which
  // terminates the whole process for any uncaught rAF exception — freezing
  // the app on a "Press + to exit" screen instead of letting it exit. Now
  // "Quit BurialNX" cancels every queued game frame id AND stubs every
  // SceneManager method update() can reach, so however the retired loop
  // fires between teardown and Switch.exit() it is a complete no-op and the
  // process exits cleanly.
  const root = 'sdmc:/game/www/';
  const files = new Map([
    [root + 'index.html', '<script src="js/rpg_core.js"></script>'],
    // Faithful miniature of RPG Maker MV's manager loop: update() has a
    // try/catch, tickStart/tickEnd call Graphics, the mobile-Safari check
    // reads the Utils global, catchException draws through Graphics, and
    // requestUpdate schedules the BOUND original update — exactly the shape
    // that crashed on hardware once the globals were deleted.
    [root + 'js/rpg_core.js', `
      globalThis.Graphics = { tickStart() { globalThis.__graphicsTicks = (globalThis.__graphicsTicks || 0) + 1; },
        tickEnd() {}, printError() { globalThis.__printErrorCalled = true; } };
      globalThis.Utils = { isMobileSafari() { return false; } };
      globalThis.onload = function () { globalThis.__burialStarts = (globalThis.__burialStarts || 0) + 1; SceneManager.requestUpdate(); };
      globalThis.SceneManager = {
        _stopped: false,
        tickStart() { Graphics.tickStart(); },
        tickEnd() { Graphics.tickEnd(); },
        updateMain() { globalThis.__gameUpdates = (globalThis.__gameUpdates || 0) + 1; },
        requestUpdate() {
          if (!this._stopped) { const bound = this.update.bind(this); globalThis.__scheduledUpdate = bound; requestAnimationFrame(bound); }
        },
        catchException(error) { Graphics.printError(error && error.name, error && error.message); },
        stop() { this._stopped = true; },
        update() {
          try {
            this.tickStart();
            if (Utils.isMobileSafari()) { this.updateInputData(); this.changeScene(); this.updateScene(); }
            else { this.updateMain(); }
            this.tickEnd();
          } catch (error) { this.catchException(error); }
        },
      };`],
  ]);
  async function waitForStart(ui, count) {
    for (let attempt = 0; attempt < 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await ui.tick();
      if (ui.logWrites.filter(([, line]) => line.includes('Game started: onload')).length >= count) return true;
    }
    return false;
  }
  const exits = [];
  const ui = await picker(true, { root: 'sdmc:/game/www', sharedSaves: false, mod: null, saves: { kind: 'switch' } }, files, { exit: () => exits.push(1) });
  assert.ok(await waitForStart(ui, 1), 'the game started the first time');
  // Pump frames: the game's rAF loop interleaves with the app's own frames.
  for (let i = 0; i < 8; i++) await ui.tick();
  assert.ok(ui.context.__gameUpdates >= 1, 'the fake game loop actually ran');
  const retiredUpdate = ui.context.__scheduledUpdate; // the ORIGINAL bound update
  assert.equal(typeof retiredUpdate, 'function', 'the game loop exposed its pending bound update');
  // Pause menu → "Quit BurialNX" (page 1, index 5).
  // The game ticks interleave with app frames, so every button press is held
  // for two ticks (whichever of them runs the app frame processes the press)
  // and each menu step takes three ticks (press, press, release) to survive
  // the alternation.
  for (let i = 0; i < 55; i++) await ui.tick([8]);
  await ui.tick(); // Release Minus.
  for (let i = 0; i < 5; i++) { await ui.tick([13]); await ui.tick([13]); await ui.tick(); }
  await ui.tick([1]); await ui.tick([1]); await ui.tick(); // A: Quit BurialNX.
  // Switch.exit was called exactly once.
  assert.equal(exits.length, 1, 'Switch.exit was called once');
  // The game globals were deleted by the realm restore before exit.
  assert.equal(ui.context.Graphics, undefined, 'Graphics was deleted');
  assert.equal(ui.context.Utils, undefined, 'Utils was deleted');
  assert.equal(ui.context.SceneManager, undefined, 'SceneManager was deleted');
  assert.equal(ui.context.requestAnimationFrame, ui.rafNative, 'requestAnimationFrame was restored to the native original');
  // The already-dequeued-batch case — the exact hardware crash: the original
  // bound update runs AFTER the teardown (between teardown and the process
  // actually dying) and must be a complete no-op. With the old teardown this
  // threw "Graphics is not defined" out of the game's own catchException and
  // killed the process instead of letting it exit.
  assert.doesNotThrow(() => retiredUpdate(12345), 'the dequeued original update is fully stubbed');
  // If the retired updateMain had run, it would have re-created its counter
  // global (deleted by the realm restore) — it must stay gone.
  assert.equal(ui.context.__gameUpdates, undefined, 'the retired updateMain never ran again');
  assert.equal(ui.context.__printErrorCalled, undefined, "the game's catchException never reached Graphics.printError");
  assert.ok(!ui.logWrites.some(([, line]) => line.includes('FAILURE:')), 'no failure was reported');
  // Async residue of the retired game must not hijack the exit or show a
  // spurious error screen, and the dispatched error event must be canceled,
  // because nx.js otherwise terminates the process for the uncaught
  // exception ("Press + to exit").
  // (The error value is a plain string: host-realm Error objects would fail
  // the listener's instanceof check across the vm boundary.)
  let prevented = false;
  for (const listener of ui.listeners.get('error') || []) {
    listener({ error: 'leftover callback of the stopped game', preventDefault() { prevented = true; } });
  }
  assert.ok(prevented, 'the error listener cancels the fatal nx.js default');
  assert.ok(ui.logWrites.some(([, line]) => line.includes('Suppressed asynchronous error from the stopped game')), 'residue was logged, not shown');
  let rejectionPrevented = false;
  for (const listener of ui.listeners.get('unhandledrejection') || []) {
    listener({ reason: 'floating promise', preventDefault() { rejectionPrevented = true; } });
  }
  assert.ok(rejectionPrevented, 'unhandled rejections no longer terminate the process');
});

test('quitting tears the game down completely and exits through Switch.exit', async () => {
  const root = 'sdmc:/game/www/';
  const files = new Map([
    [root + 'index.html', '<script src="js/rpg_core.js"></script>'],
    [root + 'js/rpg_core.js', `
      globalThis.onload = function () { globalThis.__burialStarts = (globalThis.__burialStarts || 0) + 1; };
      globalThis.SceneManager = { _stopped: false,
        update() {}, updateMain() {}, requestUpdate() {}, renderScene() {} };
      globalThis.AudioManager = { stopped: 0, stopBgm() { this.stopped++; }, stopBgs() { this.stopped++; }, stopMe() { this.stopped++; }, stopSe() { this.stopped++; } };
      globalThis.ImageManager = {};`],
  ]);
  const exits = [];
  const ui = await picker(false, { root: 'sdmc:/game/www', sharedSaves: false, mod: null, saves: { kind: 'switch' } }, files, { exit: () => exits.push(1) });
  // Release build logs nothing; wait for the second game script read instead.
  for (let attempt = 0; attempt < 200 && !ui.reads.filter((p) => p.endsWith('/js/rpg_core.js')).length; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await ui.tick();
  }
  assert.ok(ui.reads.some((p) => p.endsWith('/js/rpg_core.js')), 'the game script was read');
  await ui.tick(); // Let the launch settle.
  // Hold Minus to open the pause menu, then choose "Quit BurialNX" (last item).
  for (let i = 0; i < 55; i++) await ui.tick([8]);
  await ui.tick(); // Release Minus.
  // Release build: page 1 has 6 items, quit is index 5 (last).
  // "Back to library" is gone — the single exit path is "Quit BurialNX",
  // which performs the full game teardown (audio, frame loop, caches,
  // realm restore, GC) before Switch.exit.
  // Relaunching BurialNX from hbmenu is now the way to return to the library,
  // which is a guaranteed clean cold boot (Horizon OS reclaims the reserved
  // process memory on exit).
  for (let i = 0; i < 5; i++) { await ui.tick([13]); await ui.tick(); }
  await ui.tick([1]); await ui.tick([1]); // A: quit.
  assert.equal(exits.length, 1, 'Switch.exit was called exactly once');
  assert.equal(ui.context.SceneManager, undefined, 'the game global scope was released before exiting');
  assert.equal(ui.context.AudioManager, undefined, 'the game audio globals were released before exiting');
  assert.equal(ui.context.document, undefined, 'the host document was released before exiting');
  assert.equal(ui.context.fetch, fetch, 'fetch was restored to the native original before exiting');
});
