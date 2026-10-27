import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { assetPath, overlayReader } from '../src/library';
import { interactionTextY } from '../src/dialogue';
import { PauseMenu } from '../src/menu';
import { FolderBrowser, gameRoot } from '../src/folders';
import { scriptPlan, startGame, viewport } from '../src/runtime-plan';
import { listExistingSlots, saveKey } from '../src/save-slots';
import { ScriptQueue } from '../src/script-queue';
import { LocalRequest } from '../src/request';
import { gameAssetNames, gameAssets, unpackGameAsset } from '../src/game-assets';
import { installMapPrefetch, MapPrefetcher } from '../src/map-prefetch';
import { fixIndexedPng } from '../src/indexed-png';
import { gameSaveFolders, parseSelection, startupSelection } from '../src/settings';
import { prepareGameScript, translate, installGameCompatibility } from '../src/game-compat';
import { createBrowserHost, resourceFetch } from '../src/browser-host';
import { RepeatedPattern } from '../src/repeated-pattern';
import { ensureGameSaveFolder, hasSteamSaveData, importSteamSaves, installSdSaves, safeGameSaveFolder, safeSaveFolder, steamSaveSources } from '../src/saves';

test('map prefetch warms only bounded direct transfers and waits for an idle frame', async () => {
        let now = 0;
        const reads: string[] = [];
        let finish!: (value: ArrayBuffer) => void;
        const pending = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
        const reader = { async read(path: string) { reads.push(path); return reads.length === 1 ? pending : new ArrayBuffer(1); } };
        const prefetch = new MapPrefetcher(reader, () => {}, () => now);
        const command = (mode: number, id: unknown) => ({ code: 201, parameters: [mode, id] });
        prefetch.plan({ events: [null, { pages: [{ list: [command(1, 9), command(0, '9'), command(0, -1), command(0, 2), command(0, 2), command(0, 3), command(0, 4), command(0, 5)] }] }] });
        prefetch.tick(999, true); prefetch.tick(1000, false);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(reads, []);
        now = 1000; prefetch.tick(now, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(reads, ['data/Map002.json']);
        prefetch.tick(2000, true); // Never start a second read while one is pending.
        assert.equal(reads.length, 1);
        finish(new ArrayBuffer(1));
        await new Promise<void>((resolve) => setImmediate(resolve));
        now = 1249; prefetch.tick(now, true);
        now = 1250; prefetch.tick(now, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        now = 1500; prefetch.tick(now, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        now = 1750; prefetch.tick(now, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(reads, ['data/Map002.json', 'data/Map003.json', 'data/Map004.json']);
});

test('map prefetch cancels stale queues and observes only actual map loads', async () => {
        let now = 0, release!: (value: ArrayBuffer) => void;
        const reads: string[] = [], failures: string[] = [];
        const reader = { read(path: string) {
                reads.push(path);
                if (reads.length === 1) return new Promise<ArrayBuffer>((resolve) => { release = resolve; });
                return Promise.reject(new Error('disk error'));
        } };
        const prefetch = new MapPrefetcher(reader, (line) => failures.push(line), () => now);
        const map = (ids: number[]) => ({ events: [{ pages: [{ list: ids.map((id) => ({ code: 201, parameters: [0, id] })) }] }] });
        const runtime: any = { $dataMap: map([1, 2]), DataManager: { calls: 0, onLoad() { this.calls++; return 'original'; } } };
        assert.equal(installMapPrefetch(runtime, prefetch, () => {}), true);
        assert.equal(runtime.DataManager.onLoad({}), 'original');
        prefetch.tick(2000, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(reads, []);
        runtime.DataManager.onLoad(runtime.$dataMap);
        now = 1000; prefetch.tick(now, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        runtime.$dataMap = map([7]); runtime.DataManager.onLoad(runtime.$dataMap);
        release(new ArrayBuffer(1));
        await new Promise<void>((resolve) => setImmediate(resolve));
        prefetch.tick(1999, true); now = 2000; prefetch.tick(now, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(reads, ['data/Map001.json', 'data/Map007.json']);
        assert.equal(runtime.DataManager.calls, 3);
        assert.ok(failures[0].includes('disk error'));
        assert.equal(installMapPrefetch({}, prefetch, () => {}), false);
});

test('map warm-up uses the existing mod-aware cache without a second disk read', async () => {
        let now = 0;
        const diskReads: string[] = [];
        const assets = gameAssets('game', 'mod', { async read(path) {
                diskReads.push(path);
                return path === 'mod/data/Map002.json' ? new Uint8Array([1, 2, 3]).buffer : null;
        } });
        const prefetch = new MapPrefetcher(assets, () => {}, () => now);
        prefetch.plan({ events: [{ pages: [{ list: [{ code: 201, parameters: [0, 2] }] }] }] });
        now = 1000; prefetch.tick(now, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(diskReads, ['mod/data/Map002.json']);
        assert.deepEqual([...new Uint8Array((await assets.read('data/Map002.json'))!)], [1, 2, 3]);
        assert.deepEqual(diskReads, ['mod/data/Map002.json']);
});

test('rejects absolute, malformed, and encoded traversal paths', () => {
        for (const value of ['', '/etc', 'sdmc:/test', 'a/../b', 'a/%2e%2e/b', 'a/%5cb', 'a/%00b', 'a//b', 'bad%zz', 'a/%0ab', 'a/%E2%80%A8b', 'a/b:c']) assert.equal(assetPath(value), null);
        assert.equal(assetPath('img/portrait%20one.png'), 'img/portrait one.png');
});

test('resource fetch refuses external URLs, native filesystem URLs, and non-GET methods', async () => {
        const calls: string[] = [], reads: string[] = [];
        const native = (async (input: any) => { calls.push(String(input)); return new Response('local blob'); }) as typeof fetch;
        const load = resourceFetch({ read: async (path) => { reads.push(path); return new TextEncoder().encode('ok').buffer; } }, native, () => {});
        assert.equal(await (await load('romfs:/data/a.json')).text(), 'ok');
        assert.deepEqual(reads, ['data/a.json']);
        for (const url of ['https://example.invalid/x', 'http://localhost:1234/', '//example.invalid/x', 'sdmc:/private', 'file:///private', 'x1:payload', '../secret', 'data/%0ascript']) {
                await assert.rejects(load(url));
        }
        await assert.rejects(load('data/a.json', { method: 'POST' }));
        assert.equal(await (await load('blob:local-id')).text(), 'local blob');
        assert.deepEqual(calls, ['blob:local-id']);
});

test('resource fetch keeps failure diagnostics without logging successful image loads', async () => {
        const logs: string[] = [];
        const reader = { async read(path: string) {
                if (path === 'img/missing.png') return null;
                if (path === 'img/error.png') throw new Error('disk failure');
                return new Uint8Array([1, 2]).buffer;
        } };
        const load = resourceFetch(reader, fetch, (line) => logs.push(line));
        assert.equal((await load('img/ok.png')).status, 200);
        assert.deepEqual(logs, []);
        assert.equal((await load('img/missing.png')).status, 404);
        await assert.rejects(load('img/error.png'), /disk failure/);
        assert.ok(logs.some((line) => line.includes('img/missing.png')));
        assert.ok(logs.some((line) => line.includes('img/error.png') && line.includes('disk failure')));
});

test('mod overlay wins without writing or changing the game directory', async () => {
        const visits: string[] = [];
        const io = { read: async (path: string) => { visits.push(path); return path === 'sdmc:/mod/img/a.png' ? new ArrayBuffer(0) : null; } };
        const reader = overlayReader('sdmc:/game', 'sdmc:/mod', io);
        assert.equal((await reader.read('img/a.png'))?.byteLength, 0);
        assert.deepEqual(visits, ['sdmc:/mod/img/a.png']);
        visits.length = 0;
        await reader.read('data/file.json');
        assert.deepEqual(visits, ['sdmc:/mod/data/file.json', 'sdmc:/game/data/file.json']);
        await assert.rejects(() => reader.read('../other'));
});

test('interaction text is raised and never pushed outside its content box', () => {
        assert.equal(interactionTextY(144, 36, 0), 42);
        assert.equal(interactionTextY(144, 144, 200), 0);
        assert.equal(interactionTextY(144, 36, -200), 0);
        assert.equal(interactionTextY(144, 36, 200), 108);
        assert.equal(interactionTextY(NaN, 36, 0), 0);
});

test('release menu excludes debug actions and closes only with B', () => {
        const menu = new PauseMenu(false);
        const buttonsBuffer = (menu as any).pressed;
        const press = (i: number) => Array.from({ length: 16 }, (_, n) => ({ pressed: n === i }));
        menu.step(press(8), 0); menu.step(press(8), 801);
        assert.equal(menu.open, true);
        menu.step(press(8), 2000); assert.equal(menu.open, true);
        // Page 1 (main): Resume, Save, Load, Edit keymap, Another, Quit
        assert.deepEqual(menu.currentItems, ['continue', 'save', 'load', 'keymap', 'another', 'quit']);
        // Navigate to "Another" (index 4) and select it.
        menu.selected = 4;
        menu.step(press(1), 2001);
        // Now on page 2.
        assert.equal(menu.page, 2);
        // Page 2: saves, import, resolution, fps, mod, back (no snapshot/direct in release)
        assert.deepEqual(menu.currentItems, ['saves', 'import', 'resolution', 'fps', 'mod', 'back']);
        // B goes back to page 1.
        menu.step(press(0), 2002);
        assert.equal(menu.page, 1);
        // Release B, then press B again to close the menu.
        menu.step(null, 2003); // release
        menu.step(press(0), 2004); assert.equal(menu.open, false);
        menu.step(null, 2004); assert.equal(menu.blocksInput, false);
        assert.equal((menu as any).pressed, buttonsBuffer);
        // Debug build includes snapshot and direct on page 2.
        assert.ok(new PauseMenu(true).itemsPage2.includes('snapshot'));
        assert.ok(new PauseMenu(true).itemsPage2.includes('direct'));
        // Release build does NOT include snapshot or direct.
        assert.ok(!new PauseMenu(false).itemsPage2.includes('snapshot'));
        assert.ok(!new PauseMenu(false).itemsPage2.includes('direct'));
        menu.open = true; menu.dismiss();
        assert.equal(menu.blocksInput, true);
        menu.step(null, 2005); assert.equal(menu.blocksInput, false);
});

test('folder browser selects a highlighted game and optional mod without writing', () => {
        const paths = new Map<string, number>([
                ['sdmc:/Games', 0o040000], ['sdmc:/Games/Title', 0o040000],
                ['sdmc:/Games/Title/www/index.html', 0o100000], ['sdmc:/Games/Title/www/js/rpg_core.js', 0o100000],
        ]);
        const fs = { readDirSync: (path: string) => path === 'sdmc:/' ? ['Games', '../escape'] : path === 'sdmc:/Games/' ? ['Title'] : [], statSync: (path: string) => paths.has(path) ? { mode: paths.get(path)! } : null };
        const buttons = (i: number) => Array.from({ length: 16 }, (_, n) => ({ pressed: n === i }));
        const browser = new FolderBrowser(fs, 'game');
        assert.deepEqual(browser.entries, ['Games']);
        browser.step(buttons(1)); browser.step(null);
        assert.equal(browser.step(buttons(3)), 'sdmc:/Games/Title/www');
        assert.equal(gameRoot(fs, 'sdmc:/Games'), null);
        const mod = new FolderBrowser(fs, 'mod');
        assert.equal(mod.step(buttons(2)), null);
});

test('entry point scripts stay ordered and cannot escape the game folder', () => {
        const html = `<!-- <script src="bad.js"></script> --><script data-src="not-a-script.js"></script><script src="js/rpg_core.js"></script><script src='./js/main.js'></script>`;
        assert.deepEqual(scriptPlan(html), ['js/rpg_core.js', 'js/main.js']);
        assert.throws(() => scriptPlan('<script src="js/rpg_core.js"></script><script src="../bad.js"></script>'));
        assert.throws(() => scriptPlan('<script src="https://example.invalid/a.js"></script>'));
        assert.throws(() => scriptPlan('<script src="js/main.js"></script>'));
});

test('game startup prefers onload and only falls back when no scene has started', () => {
        let loads = 0, runs = 0;
        function Boot() {}
        const runtime: any = {
                Scene_Boot: Boot,
                SceneManager: { _scene: null, _nextScene: null, run(scene: unknown) { assert.equal(scene, Boot); runs++; } },
                onload(event: Event) { assert.equal(this, runtime); assert.equal(event.type, 'load'); loads++; },
        };
        assert.equal(startGame(runtime), 'onload');
        assert.equal(loads, 1); assert.equal(runs, 0);
        delete runtime.onload;
        assert.equal(startGame(runtime), 'scene-boot');
        assert.equal(runs, 1);
        runtime.SceneManager._scene = {};
        assert.equal(startGame(runtime), 'already-started');
        runtime.SceneManager._scene = null; runtime.SceneManager._nextScene = {};
        assert.equal(startGame(runtime), 'already-started');
        assert.equal(runs, 1);
        runtime.SceneManager._nextScene = null;
        delete runtime.Scene_Boot;
        assert.throws(() => startGame(runtime), /no load handler or usable Scene_Boot/);
        assert.throws(() => startGame({}), /no load handler or usable Scene_Boot/);
});

test('viewport keeps the correct aspect ratio', () => {
        assert.deepEqual(viewport(640, 480, 1280, 720), { x: 160, y: 0, width: 960, height: 720 });
        assert.equal(viewport(0, 1, 1, 1), null);
});

test('slot inspection preserves old isolated and shared save keys and never writes', () => {
        assert.equal(saveKey('sdmc:/games/a/www/', 1, false), 'NX:sdmc%3A%2Fgames%2Fa%2Fwww:RPG File1');
        assert.equal(saveKey('sdmc:/games/a/www', 0, true), 'RPG Global');
        const storage = { getItem: (key: string) => key === 'RPG File2' ? 'existing' : null };
        assert.deepEqual(listExistingSlots(storage, 'sdmc:/games/a', true, 3), [2]);
        assert.throws(() => listExistingSlots(storage, 'sdmc:/games/a', true, 1000));
});

class MemorySaveFiles {
        files = new Map<string, string>();
        writes: string[] = [];
        failPath = '';
        readFileSync(path: string) { const value = this.files.get(path); return value === undefined ? null : new TextEncoder().encode(value).buffer; }
        writeFileSync(path: string, value: string | ArrayBuffer) {
                this.writes.push(path);
                if (path === this.failPath) throw new Error('simulated write failure');
                this.files.set(path, typeof value === 'string' ? value : new TextDecoder().decode(value));
        }
        removeSync(path: string) { this.files.delete(path); }
        statSync(path: string) { return this.files.has(path) ? { mode: 0o100000 } : null; }
}

test('save cleanup refuses directory entries instead of recursively deleting them', () => {
        const fs = new MemorySaveFiles();
        const originalStat = fs.statSync.bind(fs);
        fs.statSync = (path) => path === 'sdmc:/saves/file1.rpgsave' ? { mode: 0o040000 } : originalStat(path);
        let removed = false; fs.removeSync = () => { removed = true; };
        const runtime: any = { StorageManager: {}, LZString: {}, DataManager: { maxSavefiles: () => 2 } };
        installSdSaves(runtime, fs, 'sdmc:/saves');
        assert.throws(() => runtime.StorageManager.remove(1), /Not a regular save file/);
        assert.equal(removed, false);
});

test('save folder cannot overlap the game or mod, including case and traversal', () => {
        const root = 'sdmc:/Games/Title/www';
        assert.equal(safeSaveFolder('sdmc:/saves', root, null), true);
        for (const path of ['sdmc:/games/title', 'sdmc:/Games/Title/save', 'sdmc:/mods/test/saves', 'sdmc:/saves/../Games', 'sdmc:/'])
                assert.equal(safeSaveFolder(path, root, 'sdmc:/mods/test'), false, path);
});

test('game-folder saves require an explicit supported path and do not overlap mods', () => {
        const root = 'sdmc:/games/title/www';
        assert.deepEqual(gameSaveFolders(root), ['sdmc:/games/title/save', 'sdmc:/games/title/www/save']);
        assert.deepEqual(gameSaveFolders('sdmc:/games/title'), ['sdmc:/games/title/save']);
        assert.equal(safeGameSaveFolder('sdmc:/games/title/save', root, null), true);
        for (const bad of ['sdmc:/games/title', 'sdmc:/games/title/save/other', 'sdmc:/games/other/save', 'sdmc:/games/title/../save'])
                assert.equal(safeGameSaveFolder(bad, root, null), false, bad);
        assert.equal(safeGameSaveFolder('sdmc:/games/title/save', root, 'sdmc:/games/title/save/mod'), false);
        assert.equal(safeGameSaveFolder('sdmc:/games/title/save', root, 'sdmc:/games/title'), false);
        assert.equal(safeGameSaveFolder('sdmc:/games/title/save', root, 'sdmc:/mods/a'), true);
        const saved = parseSelection('{"root":"sdmc:/games/title/www","sharedSaves":false,"saves":{"kind":"game","folder":"sdmc:/games/title/save"}}');
        assert.deepEqual(saved.saves, { kind: 'game', folder: 'sdmc:/games/title/save' });
        assert.throws(() => parseSelection('{"root":"sdmc:/games/title/www","sharedSaves":false,"saves":{"kind":"game","folder":"sdmc:/other"}}'));
});

test('game-folder saves create only the chosen directory and preserve existing saves', () => {
        const fs = new MemorySaveFiles();
        const directories = new Set(['sdmc:/game', 'sdmc:/game/www']);
        const originalStat = fs.statSync.bind(fs);
        fs.statSync = (path) => directories.has(path) ? { mode: 0o040000 } : originalStat(path);
        const made: string[] = [];
        const withMkdir = Object.assign(fs, { mkdirSync: (path: string) => { made.push(path); directories.add(path); } });
        const root = 'sdmc:/game/www', folder = 'sdmc:/game/save';
        assert.throws(() => ensureGameSaveFolder(withMkdir, 'sdmc:/other', root, null));
        assert.deepEqual(made, []);
        ensureGameSaveFolder(withMkdir, folder, root, null);
        ensureGameSaveFolder(withMkdir, folder, root, null);
        assert.deepEqual(made, [folder]);
        fs.files.set(`${folder}/file1.rpgsave`, 'existing');
        const runtime: any = { StorageManager: {}, LZString: { compressToBase64: (s: string) => s, decompressFromBase64: (s: string) => s }, DataManager: { maxSavefiles: () => 2 } };
        installSdSaves(runtime, fs, folder);
        assert.equal(runtime.StorageManager.load(1), 'existing');
        assert.equal(fs.files.get(`${folder}/file1.rpgsave`), 'existing');
        assert.deepEqual(fs.writes, []);
        runtime.StorageManager.save(1, 'updated by game');
        assert.equal(fs.files.get(`${folder}/file1.rpgsave`), 'updated by game');
        assert.throws(() => importSteamSaves(runtime, fs, root, { kind: 'game', folder }), /no import is needed/);
});

test('SD saves preserve old data and leave recoverable journals after failure', () => {
        const fs = new MemorySaveFiles();
        const runtime: any = { StorageManager: {}, LZString: { compressToBase64: (s: string) => s, decompressFromBase64: (s: string) => s }, DataManager: { maxSavefiles: () => 2 } };
        runtime.DataManager.saveGameWithoutRescue = (id: number) => { runtime.StorageManager.save(id, 'new'); return true; };
        fs.files.set('sdmc:/saves/file1.rpgsave', 'old');
        installSdSaves(runtime, fs, 'sdmc:/saves');
        assert.equal(runtime.DataManager.saveGame(1), true);
        assert.equal(fs.files.get('sdmc:/saves/file1.rpgsave'), 'new');
        assert.equal(fs.files.get('sdmc:/saves/file1.rpgsave.burialnx-backup'), 'old');
        runtime.StorageManager.cleanBackup(1);
        fs.failPath = 'sdmc:/saves/file1.rpgsave';
        const oldConsole = console.error; console.error = () => {};
        try { assert.equal(runtime.DataManager.saveGame(1), false); } finally { console.error = oldConsole; }
        assert.equal(fs.files.get('sdmc:/saves/file1.rpgsave'), 'new');
        assert.equal(fs.files.get('sdmc:/saves/file1.rpgsave.burialnx-backup'), 'new');
        assert.equal(fs.files.get('sdmc:/saves/file1.rpgsave.burialnx-journal'), 'new');
        assert.throws(() => installSdSaves(runtime, fs, 'sdmc:/saves'), /Interrupted save/);
        fs.files.set('sdmc:/saves/file2.rpgsave.burialnx-backup', 'do not remove');
        const mute = console.error; console.error = () => {};
        try { assert.equal(runtime.DataManager.saveGame(2), false); } finally { console.error = mute; }
        assert.equal(fs.files.get('sdmc:/saves/file2.rpgsave.burialnx-backup'), 'do not remove');
        assert.equal(fs.files.has('sdmc:/saves/file2.rpgsave'), false);
});

test('Steam import copies only to an empty target and never writes source files', () => {
        const fs = new MemorySaveFiles();
        const source = 'sdmc:/game/save/';
        fs.files.set(source + 'global.rpgsave', JSON.stringify([null, { title: 'game' }]));
        fs.files.set(source + 'file1.rpgsave', JSON.stringify({ system: {}, map: {}, player: {}, party: {} }));
        const local = new Map<string, string>();
        const runtime: any = {
                StorageManager: { webStorageKey: (id: number) => id ? `RPG File${id}` : 'RPG Global' },
                DataManager: { maxSavefiles: () => 3 }, LZString: { decompressFromBase64: (s: string) => s },
                localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => local.set(k, v) },
        };
        assert.equal(importSteamSaves(runtime, fs, 'sdmc:/game/www', { kind: 'sd', folder: 'sdmc:/saves' }), 1);
        assert.deepEqual(fs.writes, ['sdmc:/saves/file1.rpgsave', 'sdmc:/saves/global.rpgsave']);
        assert.throws(() => importSteamSaves(runtime, fs, 'sdmc:/game/www', { kind: 'sd', folder: 'sdmc:/saves' }), /existing saves/);
        assert.equal(importSteamSaves(runtime, fs, 'sdmc:/game/www', { kind: 'switch' }), 1);
        assert.throws(() => importSteamSaves(runtime, fs, 'sdmc:/game/www', { kind: 'switch' }), /existing saves/);
        assert.equal(fs.files.get(source + 'global.rpgsave'), JSON.stringify([null, { title: 'game' }]));
        assert.throws(() => importSteamSaves(runtime, fs, 'sdmc:/game/www', { kind: 'sd', folder: 'sdmc:/game/save' }), /overlaps/);
});

test('Steam save discovery handles missing, present, and ambiguous indexes without writes', () => {
        const fs = new MemorySaveFiles();
        assert.deepEqual(steamSaveSources(fs, 'sdmc:/game/www'), []);
        fs.files.set('sdmc:/game/save/global.rpgsave', 'index');
        assert.deepEqual(steamSaveSources(fs, 'sdmc:/game/www'), ['sdmc:/game/save']);
        fs.files.set('sdmc:/game/www/save/global.rpgsave', 'another index');
        assert.deepEqual(steamSaveSources(fs, 'sdmc:/game/www'), ['sdmc:/game/save', 'sdmc:/game/www/save']);
        assert.deepEqual(steamSaveSources(fs, 'sdmc:/game'), ['sdmc:/game/save']);
        assert.deepEqual(fs.writes, []);
});

test('Steam import prompt is skipped when there are no save slots', () => {
        const fs = new MemorySaveFiles();
        const dirs = new Map<string, string[]>();
        const reader = Object.assign(fs, { readDirSync: (path: string) => dirs.get(path) || null });
        assert.equal(hasSteamSaveData(reader, 'sdmc:/game/www'), false);
        fs.files.set('sdmc:/game/save/global.rpgsave', 'index');
        dirs.set('sdmc:/game/save', ['global.rpgsave', 'config.rpgsave']);
        assert.equal(hasSteamSaveData(reader, 'sdmc:/game/www'), false);
        dirs.set('sdmc:/game/save', ['global.rpgsave', 'file1.rpgsave']);
        assert.equal(hasSteamSaveData(reader, 'sdmc:/game/www'), true);
        dirs.delete('sdmc:/game/save');
        assert.equal(hasSteamSaveData(reader, 'sdmc:/game/www'), true);
        assert.deepEqual(fs.writes, []);
});

test('interrupted Steam import never creates the destination index first', () => {
        const fs = new MemorySaveFiles();
        fs.files.set('sdmc:/game/save/global.rpgsave', JSON.stringify([null, {}, {}]));
        for (const id of [1, 2]) fs.files.set(`sdmc:/game/save/file${id}.rpgsave`, JSON.stringify({ system: {}, map: {}, player: {}, party: {} }));
        fs.failPath = 'sdmc:/saves/file2.rpgsave';
        const runtime: any = { DataManager: { maxSavefiles: () => 2 }, LZString: { decompressFromBase64: (s: string) => s }, StorageManager: {} };
        assert.throws(() => importSteamSaves(runtime, fs, 'sdmc:/game/www', { kind: 'sd', folder: 'sdmc:/saves' }), /simulated write failure/);
        assert.equal(fs.files.has('sdmc:/saves/file1.rpgsave'), true);
        assert.equal(fs.files.has('sdmc:/saves/global.rpgsave'), false);
        assert.equal(fs.files.has('sdmc:/game/save/global.rpgsave'), true);
});

test('script queue executes in order, includes nested loads, and stops on errors', async () => {
        const encoded = new TextEncoder();
        const events: string[] = [];
        const queue = new ScriptQueue({ read: async (path) => path === 'missing' ? null : encoded.encode(path).buffer }, (source) => {
                events.push(source);
                if (source === 'first') void queue.append('nested');
        });
        await queue.append('first');
        await queue.settled();
        assert.deepEqual(events, ['first', 'nested']);
        await assert.rejects(queue.append('missing'));
        await assert.rejects(queue.append('later'));
        await assert.rejects(queue.settled());
        assert.deepEqual(events, ['first', 'nested']);
});

test('local requests preserve binary bytes and surface callback errors', async () => {
        const reader = { read: async (path: string) => path === 'missing' ? null : new Uint8Array([0, 255, 1]).buffer };
        const request = new LocalRequest(reader);
        request.open('GET', 'file'); request.responseType = 'arraybuffer';
        request.onload = () => { throw new Error('game callback'); };
        await assert.rejects(request.send(), /game callback/);
        assert.equal(request.status, 200);
        assert.deepEqual([...new Uint8Array(request.response as ArrayBuffer)], [0, 255, 1]);
        const absent = new LocalRequest(reader); absent.open('GET', 'missing'); await absent.send();
        assert.equal(absent.status, 404);
});

test('browser request callback errors report the resource without becoming unhandled rejections', async () => {
        const names = ['screen', 'Image', 'document', 'XMLHttpRequest', 'HTMLElement', 'HTMLCanvasElement', 'location', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'fetch', 'moveBy', 'moveTo', 'resizeBy', 'resizeTo', 'focus', 'blur', 'close'];
        const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        const errors: Error[] = [];
        try {
                Object.assign(globalThis, { screen: { width: 1280, height: 720, getContext: () => ({}) }, Image: undefined });
                createBrowserHost({ read: async () => new TextEncoder().encode('{bad').buffer }, (_path, source) => source, () => {}, false, true, (error) => errors.push(error));
                const request = new (globalThis as any).XMLHttpRequest();
                request.open('GET', 'data/Actors.json');
                request.onload = () => JSON.parse(request.responseText);
                // MV does not await send(). The host must still handle callback errors.
                request.send();
                await new Promise((resolve) => setTimeout(resolve, 0));
                assert.equal(errors.length, 1);
                assert.match(errors[0].message, /data\/Actors\.json/);
                assert.match(errors[0].message, /SyntaxError/);
        } finally {
                for (const name of names) {
                        const descriptor = previous.get(name);
                        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                        else Reflect.deleteProperty(globalThis, name);
                }
        }
});

test('hashed asset lookup prefers mod files and retains independent cache copies', async () => {
        const logical = 'img/picture.png';
        const hashed = (await gameAssetNames(logical)).at(-1)!;
        const files = new Map([['sdmc:/game/' + hashed, new Uint8Array([2]).buffer], ['sdmc:/mod/' + logical, new Uint8Array([1]).buffer]]);
        const reader = gameAssets('sdmc:/game', 'sdmc:/mod', { read: async (path) => files.get(path) || null });
        const first = await reader.read(logical);
        assert.deepEqual([...new Uint8Array(first!)], [1]);
        new Uint8Array(first!)[0] = 99;
        assert.deepEqual([...new Uint8Array((await reader.read(logical))!)], [1]);
        const plain = new Uint8Array([0, 1, 2]).buffer;
        assert.equal(unpackGameAsset(plain, 'x'), plain);
});

test('simultaneous image requests share a read but never share mutable buffers', async () => {
        let reads = 0;
        let finish!: (data: ArrayBuffer) => void;
        const disk = { read: async () => { reads++; return new Promise<ArrayBuffer>((resolve) => { finish = resolve; }); } };
        const reader = gameAssets('sdmc:/game', null, disk);
        const first = reader.read('img/example.png');
        const second = reader.read('img/example.png');
        assert.equal(reads, 1);
        finish(new Uint8Array([1, 2, 3]).buffer);
        const [one, two] = await Promise.all([first, second]);
        assert.notEqual(one, two);
        new Uint8Array(one!)[0] = 99;
        assert.deepEqual([...new Uint8Array(two!)], [1, 2, 3]);
        assert.deepEqual([...new Uint8Array((await reader.read('img/example.png'))!)], [1, 2, 3]);
        assert.equal(reads, 1);
});

test('failed shared asset reads are not cached and can be retried', async () => {
        let attempts = 0;
        const reader = gameAssets('sdmc:/game', null, { async read() {
                if (++attempts === 1) throw new Error('temporary disk error');
                return new Uint8Array([4]).buffer;
        } });
        const results = await Promise.allSettled([reader.read('data/example.json'), reader.read('data/example.json')]);
        assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
        assert.equal(attempts, 1);
        assert.deepEqual([...new Uint8Array((await reader.read('data/example.json'))!)], [4]);
        assert.equal(attempts, 2);
});

test('hashed filenames with a literal percent sign are decoded only once', async () => {
        const path = 'img/100%25.png';
        const hash = (await gameAssetNames(path)).at(-1)!;
        const disk = { read: async (name: string) => name === 'sdmc:/game/' + hash ? new Uint8Array([7]).buffer : null };
        const result = await gameAssets('sdmc:/game', null, disk).read(path);
        assert.deepEqual([...new Uint8Array(result!)], [7]);
});

test('indexed PNG correction only changes its palette and valid CRC', () => {
        const raw = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAA1BMVEXIZDLxgAUBAAAAAXRSTlOArV5bRgAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=', 'base64')).buffer;
        const fixed = fixIndexedPng(raw);
        assert.deepEqual([...new Uint8Array(fixed).slice(41, 44)], [100, 50, 25]);
        assert.equal(new DataView(fixed).getUint32(44), 0x61bfa297);
        assert.deepEqual([...new Uint8Array(raw).slice(41, 44)], [200, 100, 50]);
});

test('saved game selection validation rejects traversal and missing save mode', () => {
        assert.deepEqual(parseSelection('{"root":"sdmc:/games/test/","sharedSaves":false}'), { root: 'sdmc:/games/test', sharedSaves: false });
        assert.deepEqual(parseSelection('{"root":"sdmc:/games/test","sharedSaves":true,"mod":"sdmc:/mods/test/"}'), { root: 'sdmc:/games/test', sharedSaves: true, mod: 'sdmc:/mods/test' });
        assert.deepEqual(parseSelection('{"root":"sdmc:/games/test","sharedSaves":false,"mod":null}'), { root: 'sdmc:/games/test', sharedSaves: false, mod: null });
        assert.throws(() => parseSelection('{"root":"sdmc:/games/../test","sharedSaves":false}'));
        assert.throws(() => parseSelection('{"root":"sdmc:/games/test"}'));
        assert.throws(() => parseSelection('{"root":"sdmc:/games/test","sharedSaves":false,"mod":"sdmc:/mods/../other"}'));
        assert.deepEqual(parseSelection('{"root":"sdmc:/games/test","sharedSaves":false,"saves":{"kind":"sd","folder":"sdmc:/saves/test/"}}').saves, { kind: 'sd', folder: 'sdmc:/saves/test' });
        assert.throws(() => parseSelection('{"root":"sdmc:/games/test","sharedSaves":false,"saves":{"kind":"sd","folder":"sdmc:/saves/../other"}}'));
        for (const path of ['sdmc:/', 'sdmc:/games//test', 'sdmc:/games/a:other', 'sdmc:/games/a\\nother']) {
                assert.throws(() => parseSelection(JSON.stringify({ root: path, sharedSaves: false })));
        }
});

test('release remembers a present game and debug always asks again', () => {
        const paths = new Map([
                ['sdmc:/game/www/index.html', 0o100000], ['sdmc:/game/www/js/rpg_core.js', 0o100000],
                ['sdmc:/mod', 0o040000],
        ]);
        const fs = { readDirSync: () => [], statSync: (path: string) => paths.has(path) ? { mode: paths.get(path)! } : null };
        const saved = { root: 'sdmc:/game/www', sharedSaves: false, mod: 'sdmc:/mod' };
        assert.deepEqual(startupSelection(fs, saved, false), saved);
        assert.equal(startupSelection(fs, saved, true), null);
        paths.delete('sdmc:/mod');
        assert.deepEqual(startupSelection(fs, saved, false), { ...saved, mod: null });
        paths.delete('sdmc:/game/www/index.html');
        assert.equal(startupSelection(fs, saved, false), null);
});

test('game adapters retain collision plugin and isolate save keys', () => {
        assert.equal(prepareGameScript('js/plugins/AudioStreaming.js', 'unused'), null);
        const regionPlugin = "before\n};(function(Buffer['zlib']))\nafter";
        assert.equal(prepareGameScript('js/plugins/YEP_RegionRestrictions.js', regionPlugin), 'before\n};\nafter');
        assert.throws(() => prepareGameScript('js/plugins/YEP_RegionRestrictions.js', "before };(function(Buffer['zlib']))\nafter"));
        assert.throws(() => prepareGameScript('js/plugins/YEP_RegionRestrictions.js', `${regionPlugin}\n};(function(Buffer['zlib']))`));
        assert.equal(translate('(lines)[sample]', { linesLUT: { sample: ['hello', 'world'] } }), 'hello\nworld');
        const manager = { webStorageKey: (id: number) => `RPG File${id}` };
        const runtime: any = { StorageManager: manager, Input: {}, DataManager: {} };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        assert.equal(manager.webStorageKey(1), 'NX:sdmc%3A%2Fgame%2Fwww:RPG File1');
        assert.equal(runtime.Input.gamepadMapper[1], 'ok');
});

test('region plugin bootstrap removal preserves both supported layouts', () => {
        const path = 'js/plugins/YEP_RegionRestrictions.js';
        const bootstrap = "(function(){ const z = 'zlib'; Buffer['from']('unreachable'); })();";
        const oldLayout = [
                'var Yanfly = { RR: {} };',
                'Yanfly.RR.region = function() {',
                '  return 42;',
                `};${bootstrap}`,
                'globalThis.result = Yanfly.RR.region();',
        ].join('\n');
        const newLayout = [
                'var Yanfly = {};',
                `Yanfly.RR = Yanfly.RR || {};${bootstrap}`,
                'Yanfly.RR.region = function() { return 42; };',
                'globalThis.result = Yanfly.RR.region();',
        ].join('\n');
        for (const input of [oldLayout, newLayout, newLayout.replace(/\n/g, '\r\n')]) {
                const output = prepareGameScript(path, input)!;
                const context: { result?: number } = {};
                runInNewContext(output, context);
                assert.equal(context.result, 42);
                assert.ok(!output.includes('Buffer['));
        }
        const unchanged = 'var Yanfly = { RR: {} };';
        assert.equal(prepareGameScript(path, unchanged), unchanged);
        assert.throws(() => prepareGameScript(path, `other(); Yanfly.RR = Yanfly.RR || {};${bootstrap}`));
        assert.throws(() => prepareGameScript(path, `${newLayout}\n};${bootstrap}`));
});

test('top-level use strict is stripped so function declarations become global under indirect eval', () => {
        // Regression for Claire's Quest: plugins with 'use strict' at the top
        // level declare classes with `function Game_EnemyEvent() {}`. Under
        // indirect eval (which BurialNX uses), strict mode prevents the function
        // declaration from becoming a global — so subsequent plugins that reference
        // it throw ReferenceError. prepareGameScript strips the top-level directive
        // so eval runs in sloppy mode (like a browser <script> tag).
        const plugin = `/*:\n* @plugindesc test\n*/\n'use strict';\nfunction Game_EnemyEvent() { this.x = 1; }\nGame_EnemyEvent.prototype.ok = function() { return true; };`;
        const prepared = prepareGameScript('js/plugins/CQ_EventEnemy.js', plugin)!;
        assert.ok(!prepared.includes("'use strict'"), "top-level 'use strict' stripped");
        assert.ok(prepared.includes('function Game_EnemyEvent'), 'function declaration preserved');
        // Indirect eval: the function must become global.
        (0, eval)(prepared);
        // @ts-expect-error — global injected by eval
        assert.equal(typeof Game_EnemyEvent, 'function', 'Game_EnemyEvent is global');
        // @ts-expect-error
        assert.equal(new Game_EnemyEvent().x, 1);
        // @ts-expect-error
        assert.equal(new Game_EnemyEvent().ok(), true);
});

test('use strict inside function bodies is preserved', () => {
        // 'use strict' inside a function body affects that function's semantics
        // (this binding, undeclared variable assignment, etc.) and must NOT be
        // stripped — only the top-level directive prologue is removed.
        const plugin = `var outer = function() {\n  'use strict';\n  return typeof this;\n};\nfunction strictFn() {\n  'use strict';\n  return typeof this;\n}`;
        const prepared = prepareGameScript('js/plugins/test.js', plugin)!;
        assert.ok(prepared.includes("'use strict'"), "function-body 'use strict' preserved");
        (0, eval)(prepared);
        // @ts-expect-error — globals injected by eval
        assert.equal(outer.call(undefined), 'undefined', 'strict mode makes this=undefined in non-method');
        // @ts-expect-error
        assert.equal(strictFn.call(undefined), 'undefined');
});

test('use strict with double quotes is also stripped', () => {
        const plugin = `"use strict";\nfunction MyClass() { return 42; }`;
        const prepared = prepareGameScript('js/plugins/test.js', plugin)!;
        assert.ok(!prepared.includes('"use strict"'), 'double-quote use strict stripped');
        (0, eval)(prepared);
        // @ts-expect-error — global injected by eval
        assert.equal(new MyClass().constructor(), 42);
});

test('scripts without use strict are unchanged', () => {
        const plugin = `var Game_Map = Game_Map || {};\nGame_Map.prototype.update = function() { return true; };`;
        const prepared = prepareGameScript('js/rpg_objects.js', plugin)!;
        assert.equal(prepared, plugin, 'no use strict → no change');
});

test('use strict after a line comment is stripped', () => {
        const plugin = `// header comment\n'use strict';\nfunction Foo() {}`;
        const prepared = prepareGameScript('js/plugins/test.js', plugin)!;
        assert.ok(!prepared.includes("'use strict'"), 'use strict after line comment stripped');
        (0, eval)(prepared);
        // @ts-expect-error — global injected by eval
        assert.equal(typeof Foo, 'function');
});

test('unreliable credits stay disabled and cannot trap the title menu', () => {
        let starts = 0, activations = 0, buzzes = 0;
        function Title(this: any) { this._commandWindow = { activate: () => activations++ }; }
        Title.prototype.commandCredits = () => { throw new Error('unsafe title command'); };
        function Commands(this: any) { this._list = []; }
        Commands.prototype.makeCommandList = function(this: any) { this._list = [{ symbol: 'newGame', enabled: true }, { symbol: 'credits', enabled: true }]; };
        const runtime: any = { Galv: { CRED: { start: () => starts++ } }, Scene_Title: Title, Window_TitleCommand: Commands, SoundManager: { playBuzzer: () => buzzes++ } };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        const commands: any = new (Commands as any)(); commands.makeCommandList();
        assert.deepEqual(commands._list.map((item: any) => item.enabled), [true, false]);
        (new (Title as any)()).commandCredits();
        runtime.Galv.CRED.start();
        assert.equal(activations, 1); assert.equal(buzzes, 1); assert.equal(starts, 0);
});

test('new recovery snapshots do not overwrite the earlier loader snapshot', () => {
        const values = new Map([['RPG NX Autosave', 'older snapshot']]);
        const runtime: any = {
                DataManager: { makeSaveContents: () => ({ sample: 1 }) },
                JsonEx: { stringify: JSON.stringify },
                LZString: { compressToBase64: (text: string) => text },
                localStorage: { setItem: (key: string, value: string) => values.set(key, value) },
        };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        assert.equal(runtime.DataManager.autoSave(), true);
        assert.equal(values.get('RPG NX Autosave'), 'older snapshot');
        assert.equal(values.get('BurialNX Autosave:sdmc%3A%2Fgame%2Fwww'), '{"sample":1}');
});

test('clearing an image does not pass an empty URL to the native decoder', () => {
        const names = ['screen', 'Image', 'document', 'XMLHttpRequest', 'HTMLElement', 'HTMLCanvasElement', 'location', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'fetch', 'moveBy', 'moveTo', 'resizeBy', 'resizeTo', 'focus', 'blur', 'close'];
        const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        let nativeWrites = 0;
        class NativeImage extends EventTarget {
                private path = '';
                get src() { return this.path; }
                set src(value: string) { if (!value) throw new Error('native empty URL'); nativeWrites++; this.path = value; }
        }
        try {
                Object.assign(globalThis, { screen: { width: 1280, height: 720, getContext: () => ({}) }, Image: NativeImage });
                createBrowserHost({ read: async () => null }, (_path, source) => source, () => {});
                const image = new (globalThis as any).Image();
                image.src = 'img/test.png'; image.src = '';
                assert.equal(image.src, '');
                assert.equal(nativeWrites, 1);
        } finally {
                for (const name of names) {
                        const descriptor = previous.get(name);
                        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                        else Reflect.deleteProperty(globalThis, name);
                }
        }
});

test('canvas method wrappers are reused and still track drawing and replacements', () => {
        const names = ['screen', 'OffscreenCanvas', 'Image', 'document', 'XMLHttpRequest', 'HTMLElement', 'HTMLCanvasElement', 'location', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'fetch', 'moveBy', 'moveTo', 'resizeBy', 'resizeTo', 'focus', 'blur', 'close'];
        const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        let draws = 0, replacements = 0;
        class FakeCanvas {
                constructor(public width: number, public height: number) {}
                getContext() { return { drawImage() { draws++; }, fillRect() {}, save() {}, restore() {} }; }
        }
        try {
                Object.assign(globalThis, { screen: { width: 1280, height: 720, getContext: () => ({}) }, OffscreenCanvas: FakeCanvas, Image: undefined });
                createBrowserHost({ read: async () => null }, (_path, source) => source, () => {});
                const canvas = (globalThis as any).document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                assert.equal(ctx.drawImage, ctx.drawImage);
                assert.equal(ctx.fillRect, ctx.fillRect);
                ctx.drawImage(new FakeCanvas(1, 1), 0, 0);
                assert.equal(draws, 1); assert.equal(canvas.revision, 1);
                // Replacing a method via own-property assignment creates a new own
                // property on the wrapper — the replacement is called directly
                // (without revision tracking, since it's a user override).
                ctx.drawImage = () => { replacements++; };
                ctx.drawImage(new FakeCanvas(1, 1), 0, 0);
                assert.equal(replacements, 1);
        } finally {
                for (const name of names) {
                        const descriptor = previous.get(name);
                        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                        else Reflect.deleteProperty(globalThis, name);
                }
        }
});

// An intentionally small pixel canvas checks the batching code without a GPU.
class TestSurface {
        pixels: Uint8Array;
        draws = 0;
        constructor(readonly width: number, readonly height: number) { this.pixels = new Uint8Array(width * height); }
        getContext() {
                return { drawImage: (src: TestSurface, ...args: number[]) => {
                        this.draws++;
                        const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 2
                                ? [0, 0, src.width, src.height, args[0], args[1], src.width, src.height]
                                : args;
                        const source = src === this ? src.pixels.slice() : src.pixels;
                        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
                                const tx = dx + x, ty = dy + y;
                                if (tx >= 0 && ty >= 0 && tx < this.width && ty < this.height)
                                        this.pixels[ty * this.width + tx] = source[(sy + Math.floor(y * sh / dh)) * src.width + sx + Math.floor(x * sw / dw)];
                        }
                } };
        }
}

test('repeated patterns preserve pixels, cropping, repetition modes and negative rectangles', () => {
        const source = new TestSurface(2, 2);
        source.pixels.set([1, 2, 3, 4]);
        for (const mode of ['repeat', 'repeat-x', 'repeat-y', 'no-repeat']) {
                const dest = new TestSurface(6, 5);
                new RepeatedPattern(source, mode).fill(dest.getContext(), 5, 4, -5, -4, (w, h) => new TestSurface(w, h));
                for (let y = 0; y < dest.height; y++) for (let x = 0; x < dest.width; x++) {
                        const inside = x < 5 && y < 4;
                        const allowedX = mode === 'repeat' || mode === 'repeat-x' || x < 2;
                        const allowedY = mode === 'repeat' || mode === 'repeat-y' || y < 2;
                        const expected = inside && allowedX && allowedY ? source.pixels[(y % 2) * 2 + x % 2] : 0;
                        assert.equal(dest.pixels[y * dest.width + x], expected, `${mode} at ${x},${y}`);
                }
        }
        const shifted = new TestSurface(5, 4);
        new RepeatedPattern(source, 'repeat').fill(shifted.getContext(), -3, -2, 8, 6, (w, h) => new TestSurface(w, h));
        for (let y = 0; y < shifted.height; y++) for (let x = 0; x < shifted.width; x++)
                assert.equal(shifted.pixels[y * shifted.width + x], source.pixels[(y % 2) * 2 + x % 2]);
});

test('one-pixel patterns are batched and updated when the source changes', () => {
        const source = new TestSurface(1, 1), dest = new TestSurface(1280, 720);
        let version = 0, builds = 0;
        const pattern = new RepeatedPattern(source, 'repeat', () => version);
        const make = (w: number, h: number) => { builds++; return new TestSurface(w, h); };
        source.pixels[0] = 7;
        pattern.fill(dest.getContext(), 0, 0, 1280, 720, make);
        assert.equal(dest.pixels[719 * 1280 + 1279], 7);
        assert.ok(dest.draws <= 20, `too many native draws: ${dest.draws}`);
        pattern.fill(dest.getContext(), 0, 0, 1, 1, make);
        assert.equal(builds, 1);
        source.pixels[0] = 9; version++;
        pattern.fill(dest.getContext(), 0, 0, 1, 1, make);
        assert.equal(dest.pixels[0], 9); assert.equal(builds, 2);
});

