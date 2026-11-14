import test from 'node:test';
import assert from 'node:assert/strict';
import { installNodeCompat, resolveFsPath, appRootFrom, overlayBaseFor, type SwitchFs } from '../src/node-compat';

// An in-memory fake of nx.js's synchronous `Switch` fs, used to verify the
// fs polyfill maps reads/writes correctly and never touches the game dir.
function fakeSwitch(realFiles: Record<string, string | ArrayBuffer> = {}): SwitchFs & { written: Record<string, ArrayBuffer>; removed: string[]; dirs: string[] } {
        const store = new Map<string, ArrayBuffer>();
        for (const [k, v] of Object.entries(realFiles)) store.set(k, typeof v === 'string' ? new TextEncoder().encode(v).buffer : v);
        const written: Record<string, ArrayBuffer> = {};
        const removed: string[] = [];
        const dirs: string[] = [];
        const stat = (p: string) => store.has(p) ? { mode: 0o100000 } : (dirs.includes(p) ? { mode: 0o040000 } : null);
        return {
                readFileSync: (p) => store.get(p) ?? null,
                writeFileSync: (p, v) => { const buf = typeof v === 'string' ? new TextEncoder().encode(v).buffer : v; store.set(p, buf); written[p] = buf; },
                removeSync: (p) => { store.delete(p); removed.push(p); },
                mkdirSync: (p) => { if (!dirs.includes(p)) dirs.push(p); },
                statSync: stat,
                readDirSync: (p) => [...store.keys(), ...dirs].filter((k) => k.startsWith(p + '/')).map((k) => k.slice(p.length + 1).split('/')[0]).filter((v, i, a) => v && a.indexOf(v) === i),
                readFile: async (p) => store.get(p) ?? null,
                appendFileSync: (p, v) => { const prev = store.get(p); const buf = typeof v === 'string' ? new TextEncoder().encode(v).buffer : v; const merged = prev ? merge(prev, buf) : buf; store.set(p, merged); written[p] = merged; },
                written, removed, dirs,
        } as any;
}
function merge(a: ArrayBuffer, b: ArrayBuffer): ArrayBuffer { const out = new Uint8Array(a.byteLength + b.byteLength); out.set(new Uint8Array(a), 0); out.set(new Uint8Array(b), a.byteLength); return out.buffer; }

const GAME = 'sdmc:/switch/burialnx/Games/NEET/www';
const APPROOT = 'sdmc:/switch/burialnx/Games/NEET';

function fresh(switchFs: SwitchFs | null = null, gameRoot = GAME) {
        const runtime: Record<string, unknown> = {};
        installNodeCompat(runtime, switchFs, { gameRoot, log: undefined });
        return runtime as any;
}

test('appRootFrom strips a trailing /www', () => {
        assert.equal(appRootFrom('sdmc:/x/y/www'), 'sdmc:/x/y');
        assert.equal(appRootFrom('sdmc:/x/y/WWW'), 'sdmc:/x/y');
        assert.equal(appRootFrom('sdmc:/x/y'), 'sdmc:/x/y');
        assert.equal(appRootFrom('sdmc:/x/y/www/'), 'sdmc:/x/y');
});

test('overlayBaseFor is stable per game root', () => {
        assert.equal(overlayBaseFor(GAME), 'sdmc:/switch/burialnx/nwfs/' + overlayBaseFor(GAME).split('/').pop());
        assert.equal(overlayBaseFor(GAME), overlayBaseFor(GAME));
        assert.notEqual(overlayBaseFor(GAME), overlayBaseFor('sdmc:/switch/burialnx/Games/Other/www'));
});

test('resolveFsPath resolves relative, absolute, URL, and rejects traversal', () => {
        assert.equal(resolveFsPath(GAME, 'data/Map001.json'), `${APPROOT}/data/Map001.json`);
        assert.equal(resolveFsPath(GAME, './cheats.json'), `${APPROOT}/cheats.json`);
        assert.equal(resolveFsPath(GAME, 'sdmc:/switch/burialnx/Games/NEET/x.json'), 'sdmc:/switch/burialnx/Games/NEET/x.json');
        assert.equal(resolveFsPath(GAME, 'file:///switch/burialnx/Games/NEET/x.json'), `${APPROOT}/x.json`);
        assert.equal(resolveFsPath(GAME, 'C:\\switch\\neet\\x.json'), `${APPROOT}/switch/neet/x.json`);
        assert.equal(resolveFsPath(GAME, '../escape.json'), null);
        assert.equal(resolveFsPath(GAME, ''), null);
        assert.equal(resolveFsPath(GAME, 'a/../b'), null); // traversal segment rejected wholesale
});

test('installNodeCompat installs all expected globals', () => {
        const r = fresh();
        const expected: Record<string, string> = {
                require: 'function', process: 'object', Buffer: 'function', module: 'object',
                exports: 'object', global: 'object', __dirname: 'string', __filename: 'string', nw: 'object',
        };
        for (const [name, type] of Object.entries(expected)) {
                assert.ok(name in r, `${name} installed`);
                assert.equal(typeof r[name], type, `global ${name} is ${type}`);
        }
        assert.equal(r.__dirname, APPROOT);
        assert.equal(r.__filename, `${APPROOT}/index.html`);
        assert.equal(r.global, r);
        assert.equal(r.module.exports, r.exports);
});

test('require("fs") writes go to the per-game overlay, never the game dir', () => {
        const sw = fakeSwitch({ [`${APPROOT}/orig.json`]: '{"orig":true}' });
        const r = fresh(sw);
        const fs = r.require('fs');
        // Write a new file — must land in the overlay, not under the app root.
        fs.writeFileSync('cheats.json', '{"godMode":true}');
        assert.ok(sw.written[`${overlayBaseFor(GAME)}/cheats.json`], 'write landed in overlay');
        assert.ok(!sw.written[`${APPROOT}/cheats.json`], 'write did NOT touch the game dir');
        // Read it back by the original path: overlay is checked first.
        assert.equal(fs.readFileSync('cheats.json', 'utf8'), '{"godMode":true}');
        assert.ok(fs.existsSync('cheats.json'));
});

test('require("fs") reads fall through to the real game dir when not in overlay', () => {
        const sw = fakeSwitch({ [`${APPROOT}/orig.json`]: '{"orig":true}' });
        const r = fresh(sw);
        const fs = r.require('fs');
        assert.equal(fs.readFileSync('orig.json', 'utf8'), '{"orig":true}');
        assert.ok(fs.existsSync('orig.json'));
        assert.throws(() => fs.readFileSync('missing.json'), /ENOENT/);
        assert.throws(() => fs.statSync('missing.json'), /ENOENT/);
});

test('require("fs") overlay shadows the real file after a write', () => {
        const sw = fakeSwitch({ [`${APPROOT}/cfg.json`]: '{"v":1}' });
        const r = fresh(sw);
        const fs = r.require('fs');
        assert.equal(fs.readFileSync('cfg.json', 'utf8'), '{"v":1}');
        fs.writeFileSync('cfg.json', '{"v":2}');
        assert.equal(fs.readFileSync('cfg.json', 'utf8'), '{"v":2}');
        // The real file is unchanged.
        assert.equal(new TextDecoder().decode(sw.readFileSync(`${APPROOT}/cfg.json`)), '{"v":1}');
});

test('require("fs") unlink removes only the overlay copy', () => {
        const sw = fakeSwitch({ [`${APPROOT}/cfg.json`]: '{"v":1}' });
        const r = fresh(sw);
        const fs = r.require('fs');
        fs.writeFileSync('cfg.json', '{"v":2}');
        fs.unlinkSync('cfg.json');
        // Overlay copy gone → falls back to the real file again.
        assert.equal(fs.readFileSync('cfg.json', 'utf8'), '{"v":1}');
        assert.deepEqual(sw.removed, [`${overlayBaseFor(GAME)}/cfg.json`]);
});

test('require("fs") rejects paths outside the app root', () => {
        const sw = fakeSwitch();
        const r = fresh(sw);
        const fs = r.require('fs');
        assert.throws(() => fs.writeFileSync('../escape.json', 'x'), /EPERM/);
});

test('require("fs") works without a Switch (in-memory fallback)', () => {
        const r = fresh(null);
        const fs = r.require('fs');
        fs.writeFileSync('mem.json', 'hi');
        assert.equal(fs.readFileSync('mem.json', 'utf8'), 'hi');
        assert.ok(fs.existsSync('mem.json'));
});

test('require("path") implements the common surface', () => {
        const r = fresh();
        const path = r.require('path');
        assert.equal(path.join('a', 'b', 'c'), 'a/b/c');
        assert.equal(path.join('a', '/b', 'c'), '/b/c');
        assert.equal(path.normalize('a/b/../c/./d'), 'a/c/d');
        assert.equal(path.dirname('/a/b/c.json'), '/a/b');
        assert.equal(path.basename('/a/b/c.json'), 'c.json');
        assert.equal(path.basename('/a/b/c.json', '.json'), 'c');
        assert.equal(path.extname('/a/b/c.json'), '.json');
        assert.ok(path.isAbsolute('/x'));
        assert.ok(!path.isAbsolute('x'));
        assert.equal(path.relative('/a/b', '/a/c'), '../c');
});

test('Buffer round-trips utf8, base64, hex and concats', () => {
        const r = fresh();
        const Buffer = r.Buffer;
        const b = Buffer.from('hello', 'utf8');
        assert.equal(b.toString('utf8'), 'hello');
        assert.equal(b.toString('base64'), 'aGVsbG8=');
        assert.equal(Buffer.from('aGVsbG8=', 'base64').toString('utf8'), 'hello');
        assert.equal(b.toString('hex'), '68656c6c6f');
        assert.equal(Buffer.from('68656c6c6f', 'hex').toString('utf8'), 'hello');
        assert.equal(Buffer.concat([Buffer.from('a'), Buffer.from('b')]).toString(), 'ab');
        assert.ok(Buffer.isBuffer(b));
        assert.equal(Buffer.byteLength('é'), 2);
        const u = Buffer.alloc(4, 65);
        assert.equal(u.toString(), 'AAAA');
        const w = Buffer.allocUnsafe(2);
        assert.equal(w.length, 2);
        // little-endian read/write helpers
        const n = Buffer.alloc(4);
        n.writeUInt32LE(0x12345678, 0);
        assert.equal(n.readUInt32LE(0), 0x12345678);
});

test('require("events") EventEmitter on/once/off/emit', () => {
        const r = fresh();
        const { EventEmitter } = r.require('events');
        const e = new EventEmitter();
        const seen: any[] = [];
        e.on('x', (v) => seen.push(['on', v]));
        e.once('y', () => seen.push(['once']));
        e.emit('x', 1);
        e.emit('y');
        e.emit('y');
        e.off('x', seen[0] && (() => {}));
        const cb = (v: any) => seen.push(['on2', v]);
        e.on('z', cb);
        e.off('z', cb);
        e.emit('z', 9);
        assert.deepEqual(seen[0], ['on', 1]);
        assert.deepEqual(seen[1], ['once']);
        assert.equal(seen.length, 2);
});

test('require of an unknown bare module returns a callable no-throw stub', () => {
        const r = fresh();
        const stub = r.require('some-unknown-npm-pkg');
        // Property chains and calls must never throw.
        assert.doesNotThrow(() => { const x = stub.foo.bar.baz(1, 2).deep[0](); typeof x; });
        assert.equal(typeof stub, 'function');
});

test('require("nw.gui") returns the nw object with Window.get()', () => {
        const r = fresh();
        const nw = r.require('nw.gui');
        assert.equal(nw, r.require('nw'));
        assert.equal(typeof nw.Window.get, 'function');
        assert.equal(nw.Window.get(), nw.Window);
        assert.equal(typeof nw.App.quit, 'function');
        assert.equal(typeof nw.Shell.openExternal, 'function');
});

test('relative require loads and caches a local module', () => {
        const sw = fakeSwitch({ [`${APPROOT}/helper.js`]: 'module.exports = { greet: function(){ return "hi"; } }' });
        const r = fresh(sw);
        const helper = r.require('./helper');
        assert.equal(typeof helper.greet, 'function');
        assert.equal(helper.greet(), 'hi');
        // Second require returns the cached exports (same identity).
        assert.equal(r.require('./helper'), helper);
});

test('relative require under www/ is found via the www fallback base', () => {
        // A helper placed directly under www/ (where RPG Maker MV's index.html
        // lives). The www fallback base in requireRelative finds it even though
        // the root require's fromDir is the app root (parent of www).
        const sw = fakeSwitch({ [`${APPROOT}/www/plugin-helper.js`]: 'module.exports = { ok: true }' });
        const r = fresh(sw);
        const helper = r.require('./plugin-helper');
        assert.equal(helper.ok, true);
});

test('process.cwd() returns the NW.js app root', () => {
        const r = fresh();
        assert.equal(r.process.cwd(), APPROOT);
        assert.equal(r.process.platform, 'switch');
        assert.equal(typeof r.process.nextTick, 'function');
});

test('process.mainModule.filename points at www/index.html (used by StorageManager + patch plugins)', () => {
        // RPG Maker MV's StorageManager.localFileDirectoryPath() and the
        // Wataridori_AddFileSystem patch plugin call
        // `path.dirname(process.mainModule.filename)` to find the game's base
        // directory, then resolve `save/` or `../patch/` relative to it.
        // Without a real mainModule, `process.mainModule.filename` throws
        // TypeError and (for the patch plugin) the APPLY PATCH command silently
        // disables — or worse, crashes an unguarded caller.
        const r = fresh();
        const path = r.require('path');
        assert.ok(r.process.mainModule, 'process.mainModule is defined');
        assert.equal(r.process.mainModule.filename, `${APPROOT}/www/index.html`);
        // dirname() = <appRoot>/www, so `../patch/` resolves to <appRoot>/patch —
        // matching the on-disk Windows/NW.js layout (patch/ is a sibling of www/).
        const base = path.dirname(r.process.mainModule.filename);
        assert.equal(base, `${APPROOT}/www`);
        assert.equal(path.join(base, '../patch/'), `${APPROOT}/patch`);
});

test('installNodeCompat does not overwrite an already-present native require', () => {
        const runtime: any = { require: () => 'native', process: { native: true } };
        installNodeCompat(runtime, null, { gameRoot: GAME });
        assert.equal(runtime.require(), 'native');
        assert.equal(runtime.process.native, true);
        // But missing globals are still filled in.
        assert.ok(typeof runtime.Buffer === 'function');
        assert.ok(runtime.nw);
});

test('stub module is callable and chainable without throwing', () => {
        const r = fresh();
        const s = r.require('totally-fake');
        let result: any;
        assert.doesNotThrow(() => { result = s().foo().bar.baz[0]; });
        assert.equal(typeof result, 'function');
});

// Regression for the exact reported crash:
//   FAILURE: ReferenceError: require is not defined
//       at Window_TitleCommand.checkAddCommandEnable
//       at Window_TitleCommand.makeCommandList
// A DLC+Cheats build patches the title command window to call `require`
// (typically to check for a cheat config file via fs.existsSync). Before the
// polyfill, `require` was undefined → ReferenceError killed the launch at the
// title screen. This test reproduces that flow and asserts it now succeeds.
test('regression: Window_TitleCommand.checkAddCommandEnable can call require (the reported crash)', () => {
        // Install on globalThis (as the real loader does) so bare `require` inside
        // the game's functions resolves to the polyfill. Snapshot & restore.
        const globals = ['require', 'process', 'Buffer', 'module', 'exports', '__dirname', '__filename', 'nw'];
        const saved: Record<string, unknown> = {};
        for (const g of globals) saved[g] = (globalThis as any)[g];
        try {
                const sw = fakeSwitch({ [`${APPROOT}/cheats.json`]: '{"enabled":true}' });
                installNodeCompat(globalThis as any, sw, { gameRoot: GAME });
                // Simulate a cheat-patched title command window exactly like the game's.
                const Window_TitleCommand: any = function () {};
                Window_TitleCommand.prototype.makeCommandList = function () {
                        this._list = [
                                { symbol: 'newGame', enabled: true },
                                { symbol: 'cheats', enabled: this.checkAddCommandEnable('cheats') },
                        ];
                };
                Window_TitleCommand.prototype.checkAddCommandEnable = function (symbol: string) {
                        // The pattern that used to throw ReferenceError: require is not defined.
                        if (typeof require === 'undefined') return false;
                        if (symbol === 'cheats') return require('fs').existsSync('cheats.json');
                        return true;
                };
                const win = new Window_TitleCommand();
                assert.doesNotThrow(() => win.makeCommandList(), 'makeCommandList must not throw ReferenceError');
                assert.equal(win._list[1].enabled, true, 'cheats command enabled because cheats.json exists');

                // When the file is absent, the command is simply disabled — no crash.
                // Clear the globals first so installNodeCompat installs a fresh fs
                // against the empty Switch (the loader does this via teardownGame()).
                for (const g of globals) { try { delete (globalThis as any)[g]; } catch { /* keep */ } }
                installNodeCompat(globalThis as any, fakeSwitch({}), { gameRoot: GAME });
                const w2 = new Window_TitleCommand();
                w2.makeCommandList();
                assert.equal(w2._list[1].enabled, false, 'cheats command disabled when file absent');
        } finally {
                for (const g of globals) {
                        if (saved[g] === undefined) { try { delete (globalThis as any)[g]; } catch { /* keep */ } }
                        else (globalThis as any)[g] = saved[g];
                }
        }
});
