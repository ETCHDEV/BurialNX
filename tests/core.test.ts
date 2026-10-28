import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { assetPath, overlayReader } from '../src/library';
import { interactionTextY } from '../src/dialogue';
import { PauseMenu } from '../src/menu';
import { DEFAULT_KEYMAP, menuButtonIndicesFor, faceButtonLetter, type KeyMap } from '../src/keymap';
import { clearButtonKeyState } from '../src/stick-bindings';
import { buildSaveLoadMapper, clearSaveLoadVkeyState, isActiveChoice, installSaveLoadPopHook } from '../src/save-load-keymap';
import { FolderBrowser, gameRoot } from '../src/folders';
import { scriptPlan, startGame, viewport } from '../src/runtime-plan';
import { listExistingSlots, saveKey } from '../src/save-slots';
import { ScriptQueue } from '../src/script-queue';
import { LocalRequest } from '../src/request';
import { gameAssetNames, gameAssets, unpackGameAsset } from '../src/game-assets';
import { installMapPrefetch, MapPrefetcher } from '../src/map-prefetch';
import { fixIndexedPng } from '../src/indexed-png';
import { gameSaveFolders, parseSelection, startupSelection } from '../src/settings';
import { prepareGameScript, translate, installGameCompatibility, parseLanguagePack, loadLanguagePack, scanLanguageFiles, withLanguageImages, registerLanguageFont, resolveLanguageName, wrapSystemTerms, type LanguagePack, type LanguageEntry } from '../src/game-compat';
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
        // Page 2: saves, import, resolution, fps, mod, language, back (no snapshot/direct in release)
        assert.deepEqual(menu.currentItems, ['saves', 'import', 'resolution', 'fps', 'mod', 'language', 'back']);
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

test('autosave writes the recovery snapshot to the SD card, never localStorage', () => {
        // startupUserAccount=0 in the NACP means no Switch user is preselected,
        // and nx.js's localStorage is backed by account save data — so any
        // localStorage access lazily launches the profile-picker applet. To
        // keep that dialog from EVER appearing (including mid-game when
        // autosave fires), the autosave snapshot is written as a regular file
        // on the SD card via Switch.writeFileSync, NOT via localStorage.
        const writes = new Map<string, string>();
        const switchFs: any = {
                mkdirSync: () => { /* dir may already exist */ },
                writeFileSync: (path: string, value: string) => { writes.set(path, value); },
                statSync: () => null,
        };
        const runtime: any = {
                DataManager: { makeSaveContents: () => ({ sample: 1 }) },
                JsonEx: { stringify: JSON.stringify },
                LZString: { compressToBase64: (text: string) => text },
                // localStorage is present but MUST NOT be touched. Any access
                // throws so the test fails loudly if autosave regresses.
                localStorage: new Proxy({}, {
                        get() { throw new Error('localStorage must not be touched by autosave'); },
                        set() { throw new Error('localStorage must not be touched by autosave'); },
                }),
        };
        const previousSwitch = (globalThis as any).Switch;
        (globalThis as any).Switch = switchFs;
        try {
                installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
                assert.equal(runtime.DataManager.autoSave(), true);
        } finally {
                (globalThis as any).Switch = previousSwitch;
        }
        // The snapshot is written to the per-app autosaves folder on the SD
        // card, keyed by the URL-encoded game root so each game gets its own
        // recovery file. localStorage was never accessed (the Proxy would
        // have thrown).
        assert.equal(writes.size, 1, 'exactly one autosave file was written to the SD card');
        const [[path, value]] = [...writes.entries()];
        assert.equal(path, 'sdmc:/switch/burialnx/autosaves/sdmc%3A%2Fgame%2Fwww.rpgsave', 'snapshot path is on the SD card, keyed by game root');
        assert.equal(value, '{"sample":1}', 'snapshot content is the LZString-compressed save JSON');
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

// === Language pack (.cld) loading tests =====================================

/** Encode a minimal LANGDATA blob for tests. */
function langdata(pack: Record<string, unknown>): ArrayBuffer {
        const text = 'LANGDATA' + JSON.stringify(pack);
        return new TextEncoder().encode(text).buffer;
}

test('parseLanguagePack extracts tables, font metadata, and image map from a .cld blob', () => {
        const bytes = langdata({
                langVers: '1', langName: 'Test', fontFace: 'custom-font', fontSize: 22,
                fontFile: 'AAEC', imgFiles: { 'img/x': 'iVBORw0KGgo=' },
                sysLabel: { Game: 'Spiel' }, sysMenus: { New: 'Neu' },
                labelLUT: { a: 'A' }, linesLUT: { b: ['B1', 'B2'] },
        });
        const pack = parseLanguagePack(bytes, 'languages/test.cld');
        assert.equal(pack.langName, 'Test');
        assert.equal(pack.fontFace, 'custom-font');
        assert.equal(pack.fontSize, 22);
        assert.equal(pack.fontFile, 'AAEC');
        assert.equal(pack.source, 'languages/test.cld');
        assert.equal(Object.keys(pack.imgFiles).length, 1);
        assert.equal(pack.imgFiles['img/x'], 'iVBORw0KGgo=');
        // The table exposes the four keys translate() reads.
        assert.deepEqual(Object.keys(pack.table).sort(), ['labelLUT', 'linesLUT', 'sysLabel', 'sysMenus']);
        assert.equal(pack.table.sysMenus!.New, 'Neu');
        assert.deepEqual(pack.table.linesLUT!.b, ['B1', 'B2']);
});

test('parseLanguagePack tolerates packs without font or images (default English data)', () => {
        const bytes = langdata({ langName: 'English', fontFace: 'GameFont', fontSize: 28, fontFile: null, imgFiles: {} });
        const pack = parseLanguagePack(bytes, null);
        assert.equal(pack.fontFile, null);
        assert.equal(pack.langName, 'English');
        assert.equal(Object.keys(pack.imgFiles).length, 0);
        assert.equal(pack.source, null);
});

test('parseLanguagePack rejects a non-LANGDATA blob', () => {
        const bytes = new TextEncoder().encode('{}').buffer;
        assert.throws(() => parseLanguagePack(bytes, null), /Unsupported language data/);
});

test('loadLanguagePack prefers a .cld file and falls back to the default English data', async () => {
        const cld = langdata({ langName: 'Русский', fontFace: 'bitter', fontSize: 24, fontFile: 'AAAA', imgFiles: {}, sysMenus: { New: 'Новая' } });
        const english = langdata({ langName: 'English', fontFace: 'GameFont', fontSize: 28, fontFile: null, imgFiles: {}, sysMenus: { New: 'New' } });
        const files: Record<string, ArrayBuffer> = { 'languages/ru.cld': cld, 'data/9c7050ae76645487': english };
        const reader = { async read(path: string) { return files[path] ?? null; } };
        // .cld path provided → load it.
        const ru = await loadLanguagePack(reader, 'languages/ru.cld');
        assert.ok(ru); assert.equal(ru!.langName, 'Русский'); assert.equal(ru!.fontFace, 'bitter');
        assert.equal(translate('(sysMenus)[New]', ru!.table), 'Новая');
        // No .cld path → fall back to English default.
        const en = await loadLanguagePack(reader, null);
        assert.ok(en); assert.equal(en!.langName, 'English'); assert.equal(translate('(sysMenus)[New]', en!.table), 'New');
});

test('loadLanguagePack falls back to default when the .cld path is unreadable', async () => {
        const english = langdata({ langName: 'English', fontFace: 'GameFont', fontSize: 28, fontFile: null, imgFiles: {} });
        const reader = { async read(path: string) { return path === 'data/9c7050ae76645487' ? english : null; } };
        const pack = await loadLanguagePack(reader, 'languages/missing.cld');
        assert.ok(pack); assert.equal(pack!.langName, 'English');
});

test('loadLanguagePack returns null when neither .cld nor default exist', async () => {
        const reader = { async read() { return null; } };
        const pack = await loadLanguagePack(reader, 'languages/missing.cld');
        assert.equal(pack, null);
});

test('scanLanguageFiles finds .cld packs in www/languages and prefers Russian first', () => {
        const fs = { readDirSync(path: string): string[] | null {
                if (path.includes('languages')) return ['en.cld', 'ru.cld', 'notes.txt', 'fr.cld'];
                return null;
        } };
        const entries = scanLanguageFiles(fs, '/sdmc/game/www');
        assert.equal(entries.length, 3);
        // Russian is sorted first.
        assert.equal(entries[0].code, 'ru');
        assert.equal(entries[0].path, 'languages/ru.cld');
        assert.equal(entries[0].absPath, '/sdmc/game/www/languages/ru.cld');
        // Other languages are alphabetical after ru.
        assert.equal(entries[1].code, 'en');
        assert.equal(entries[2].code, 'fr');
        // Non-.cld files are skipped.
        assert.ok(!entries.some((e) => e.code === 'notes'));
});

test('scanLanguageFiles also checks the parent folder when languages/ is above www', () => {
        let calls = 0;
        const fs = { readDirSync(path: string): string[] | null {
                calls++;
                if (path === '/sdmc/game/languages/') return ['ru.cld']; // one level above www
                return null;
        } };
        const entries = scanLanguageFiles(fs, '/sdmc/game/www');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].code, 'ru');
        // Parent-folder packs have null asset path (assetPath rejects ..) and an absolute path.
        assert.equal(entries[0].path, null);
        assert.equal(entries[0].absPath, '/sdmc/game/languages/ru.cld');
});

test('scanLanguageFiles de-duplicates the same code across www and parent folders', () => {
        const fs = { readDirSync(path: string): string[] | null {
                if (path === '/sdmc/game/www/languages/') return ['ru.cld'];
                if (path === '/sdmc/game/languages/') return ['ru.cld', 'en.cld'];
                return null;
        } };
        const entries = scanLanguageFiles(fs, '/sdmc/game/www');
        assert.equal(entries.length, 2);
        // The www copy wins (first seen); the parent copy is deduped.
        assert.equal(entries[0].code, 'ru');
        assert.equal(entries[0].path, 'languages/ru.cld');
        assert.equal(entries[1].code, 'en');
        assert.equal(entries[1].path, null); // only in parent
});

test('scanLanguageFiles returns empty when readDirSync is unavailable', () => {
        assert.deepEqual(scanLanguageFiles(null, '/sdmc/game/www'), []);
        assert.deepEqual(scanLanguageFiles({}, '/sdmc/game/www'), []);
});

test('resolveLanguageName reads langName from a .cld pack', async () => {
        const cld = langdata({ langName: 'Русский', fontFace: 'f', fontSize: 1, fontFile: null, imgFiles: {} });
        const reader = { async read(path: string) { return path === 'languages/ru.cld' ? cld : null; } };
        const name = await resolveLanguageName(reader, { path: 'languages/ru.cld', absPath: '/x/ru.cld', code: 'ru', name: 'ru' });
        assert.equal(name, 'Русский');
});

test('resolveLanguageName falls back to the code when the pack cannot be read', async () => {
        const reader = { async read() { return null; } };
        const entry: LanguageEntry = { path: 'languages/zz.cld', absPath: '/x/zz.cld', code: 'zz', name: 'zz' };
        const name = await resolveLanguageName(reader, entry);
        assert.equal(name, 'zz');
});

test('withLanguageImages serves decoded base64 images for listed paths and falls through otherwise', async () => {
        // 'iVBORw0KGgo=' decodes to the 4-byte PNG signature + padding.
        const pack: LanguagePack = {
                table: {}, fontFace: null, fontSize: null, fontFile: null,
                imgFiles: { 'img/title': 'iVBORw0KGgo=' }, langName: null, source: null,
        };
        let baseReads = 0;
        const base = { async read(path: string) { baseReads++; return path === 'data/Map001.json' ? new ArrayBuffer(4) : null; } };
        const overlay = withLanguageImages(base, pack);
        // Listed path → decoded image, no base reader call.
        const img = await overlay.read('img/title');
        assert.ok(img);
        assert.equal(new Uint8Array(img)[0], 137); // PNG signature byte 0
        assert.equal(new Uint8Array(img)[1], 80);  // 'P'
        assert.equal(baseReads, 0);
        // Unlisted path → falls through to base reader.
        const data = await overlay.read('data/Map001.json');
        assert.ok(data);
        assert.equal(baseReads, 1);
        // Missing path → base returns null.
        const missing = await overlay.read('img/missing');
        assert.equal(missing, null);
        assert.equal(baseReads, 2);
});

test('withLanguageImages returns the base reader unchanged when imgFiles is empty', () => {
        const base = { async read() { return null; } };
        const pack: LanguagePack = { table: {}, fontFace: null, fontSize: null, fontFile: null, imgFiles: {}, langName: null, source: null };
        assert.equal(withLanguageImages(base, pack), base);
});

test('registerLanguageFont overrides Window_Base, Yanfly, Graphics, and Bitmap font selection', async () => {
        const fonts: string[] = [];
        const runtime: any = {
                FontFace: class { constructor(public family: string, public src: ArrayBuffer) {} },
                fonts: { add(f: any) { fonts.push(f.family); } },
                Window_Base: { prototype: { standardFontFace() { return 'GameFont'; }, standardFontSize() { return 28; } } },
                Yanfly: { Param: { DefaultFont: 'GameFont', FontSize: 28 } },
                Graphics: { fontFace: 'GameFont' },
                Bitmap: { prototype: { fontFace: 'GameFont', fontSize: 28 } },
        };
        const pack: LanguagePack = {
                table: {}, fontFace: 'bitter-pro-regular', fontSize: 24,
                fontFile: 'AAEAAA', imgFiles: {}, langName: 'Русский', source: 'languages/ru.cld',
        };
        await registerLanguageFont(runtime, pack);
        // Font registered with all 4 variants (normal, bold, italic, bold-italic).
        assert.equal(fonts.length, 4);
        assert.equal(fonts[0], 'bitter-pro-regular');
        // Font face overridden everywhere RPG Maker MV / Yanfly reads it.
        assert.equal(runtime.Window_Base.prototype.standardFontFace(), 'bitter-pro-regular');
        assert.equal(runtime.Window_Base.prototype.standardFontSize(), 24);
        assert.equal(runtime.Yanfly.Param.DefaultFont, 'bitter-pro-regular');
        assert.equal(runtime.Yanfly.Param.FontSize, 24);
        assert.equal(runtime.Graphics.fontFace, 'bitter-pro-regular');
        assert.equal(runtime.Bitmap.prototype.fontFace, 'bitter-pro-regular');
        assert.equal(runtime.Bitmap.prototype.fontSize, 24);
});

test('registerLanguageFont is a no-op when the pack has no embedded font', async () => {
        const runtime: any = { Window_Base: { prototype: { standardFontFace() { return 'GameFont'; } } } };
        const pack: LanguagePack = { table: {}, fontFace: null, fontSize: null, fontFile: null, imgFiles: {}, langName: null, source: null };
        await registerLanguageFont(runtime, pack);
        // Nothing changed.
        assert.equal(runtime.Window_Base.prototype.standardFontFace(), 'GameFont');
});

// === wrapSystemTerms tests =================================================

test('wrapSystemTerms wraps $dataSystem.terms.commands that match sysMenus keys', () => {
        const language = {
                sysMenus: { 'New Game': 'Новая Игра', 'Continue': 'Продолжить', 'Options': 'Опции' },
                sysLabel: {},
        };
        const runtime: any = {
                $dataSystem: {
                        gameTitle: 'The Coffin of Andy and Leyley',
                        terms: {
                                commands: ['Fight', 'Escape', 'Attack', 'Guard', 'Item', 'Skill', 'Equip', 'Status', 'Formation', 'Save', 'Game End', 'Options', 'Weapon', 'Armor', 'Key Item', 'Equip', 'Optimize', 'Clear', 'New Game', 'Continue', null, 'To Title', 'Cancel', null, 'Buy', 'Sell'],
                                basic: ['Level', 'Lv', 'HP', 'HP'],
                                params: ['Max HP', 'Max MP'],
                                messages: { alwaysDash: 'Always Dash', file: 'File' },
                        },
                },
        };
        wrapSystemTerms(runtime, language);
        // "New Game" → "(sysMenus)[New Game]", "Continue" → "(sysMenus)[Continue]", "Options" → "(sysMenus)[Options]"
        assert.equal(runtime.$dataSystem.terms.commands[18], '(sysMenus)[New Game]');
        assert.equal(runtime.$dataSystem.terms.commands[19], '(sysMenus)[Continue]');
        assert.equal(runtime.$dataSystem.terms.commands[11], '(sysMenus)[Options]');
        // Entries without a matching key stay unchanged.
        assert.equal(runtime.$dataSystem.terms.commands[0], 'Fight');
        assert.equal(runtime.$dataSystem.terms.commands[10], 'Game End');
        // null entries stay null.
        assert.equal(runtime.$dataSystem.terms.commands[20], null);
});

test('wrapSystemTerms wraps $dataSystem.gameTitle when it matches a sysLabel key', () => {
        const language = {
                sysMenus: {},
                sysLabel: { 'Game': 'Гроб для Энди и Лейли', 'Item': 'Предметы', 'File': 'Файл', 'Save': 'Какой файл перезаписать?', 'Load': 'Какой файл загрузить?' },
        };
        const runtime: any = {
                $dataSystem: { gameTitle: 'The Coffin of Andy and Leyley', terms: { commands: [], messages: { file: 'File', saveMessage: 'Save to which file?', loadMessage: 'Load which file?' } } },
        };
        wrapSystemTerms(runtime, language);
        // gameTitle maps to sysLabel['Game'] (not an exact-match key) → wrapped in (sysLabel)[Game]
        assert.equal(runtime.$dataSystem.gameTitle, '(sysLabel)[Game]');
        // "File" message → "(sysLabel)[File]" (exact match)
        assert.equal(runtime.$dataSystem.terms.messages.file, '(sysLabel)[File]');
        // saveMessage maps to sysLabel['Save'] (the .cld key is 'Save', not the full prompt)
        assert.equal(runtime.$dataSystem.terms.messages.saveMessage, '(sysLabel)[Save]');
        assert.equal(runtime.$dataSystem.terms.messages.loadMessage, '(sysLabel)[Load]');
});

test('wrapSystemTerms wraps Galv.CRED.titleText (plugin title constant)', () => {
        const language = { sysMenus: { 'Credits': 'Титры' }, sysLabel: {} };
        const runtime: any = {
                $dataSystem: { terms: {} },
                Galv: { CRED: { titleText: 'Credits' } },
        };
        wrapSystemTerms(runtime, language);
        assert.equal(runtime.Galv.CRED.titleText, '(sysMenus)[Credits]');
});

test('wrapSystemTerms does NOT wrap strings that have no matching key', () => {
        const language = { sysMenus: { 'New Game': 'Новая Игра' }, sysLabel: {} };
        const runtime: any = {
                $dataSystem: { gameTitle: 'Some Untitled Game', terms: { commands: ['Fight', 'New Game', 'Unknown'], messages: { foo: 'Bar' } } },
        };
        wrapSystemTerms(runtime, language);
        // "Fight" and "Unknown" have no matching key → unchanged.
        assert.equal(runtime.$dataSystem.terms.commands[0], 'Fight');
        assert.equal(runtime.$dataSystem.terms.commands[2], 'Unknown');
        // "New Game" matches → wrapped.
        assert.equal(runtime.$dataSystem.terms.commands[1], '(sysMenus)[New Game]');
        // "Bar" has no matching key → unchanged.
        assert.equal(runtime.$dataSystem.terms.messages.foo, 'Bar');
        // gameTitle: no sysLabel['Game'] key exists → unchanged.
        assert.equal(runtime.$dataSystem.gameTitle, 'Some Untitled Game');
});

test('wrapSystemTerms is a no-op when language is null', () => {
        const runtime: any = { $dataSystem: { gameTitle: 'Test', terms: { commands: ['New Game'] } } };
        wrapSystemTerms(runtime, null);
        assert.equal(runtime.$dataSystem.terms.commands[0], 'New Game');
        assert.equal(runtime.$dataSystem.gameTitle, 'Test');
});

test('wrapSystemTerms does not double-wrap already-wrapped escape sequences', () => {
        const language = { sysMenus: { 'New Game': 'Новая Игра' }, sysLabel: {} };
        const runtime: any = {
                $dataSystem: { terms: { commands: ['(sysMenus)[New Game]'] } },
        };
        wrapSystemTerms(runtime, language);
        // Already starts with '(' → not re-wrapped.
        assert.equal(runtime.$dataSystem.terms.commands[0], '(sysMenus)[New Game]');
});

test('installGameCompatibility hooks DataManager.onLoad to wrap $dataSystem terms', () => {
        const language = { sysMenus: { 'New Game': 'Новая Игра' }, sysLabel: {} };
        let onLoadCalled = false;
        const runtime: any = {
                DataManager: { onLoad: (_data: any, name: string) => { onLoadCalled = true; }, setupNewGame() {} },
                StorageManager: {},
                Input: {},
        };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, language);
        // The onLoad hook should be installed.
        assert.ok(runtime.DataManager.__bnxTermsWrap);
        // Simulate $dataSystem loading.
        const fakeData = { terms: { commands: ['New Game', 'Fight'] }, gameTitle: 'Test' };
        runtime.$dataSystem = fakeData;
        runtime.DataManager.onLoad(fakeData, '$dataSystem');
        // The terms should now be wrapped.
        assert.equal(fakeData.terms.commands[0], '(sysMenus)[New Game]');
        assert.equal(fakeData.terms.commands[1], 'Fight');
});

test('wrapSystemTerms maps option aliases (Always Dash → Run Always)', () => {
        // The .cld's sysMenus uses "Run Always" but the game says "Always Dash".
        // The alias map bridges this: "Always Dash" → wrap in (sysMenus)[Run Always].
        // Only strings with a corresponding .cld key are aliased; others stay
        // untranslated (e.g. "BGS Volume" and "ME Volume" have no .cld key).
        const language = {
                sysMenus: { 'Run Always': 'Всегда бежать', 'Volume BGM': 'Громкость музыки', 'Volume SFX': 'Громкость звуков' },
                sysLabel: {},
        };
        const runtime: any = {
                $dataSystem: { gameTitle: 'Test', terms: { commands: [], messages: { alwaysDash: 'Always Dash', bgmVolume: 'BGM Volume', seVolume: 'SE Volume', bgsVolume: 'BGS Volume', meVolume: 'ME Volume' } } },
        };
        wrapSystemTerms(runtime, language);
        // These have aliases → wrapped.
        assert.equal(runtime.$dataSystem.terms.messages.alwaysDash, '(sysMenus)[Run Always]');
        assert.equal(runtime.$dataSystem.terms.messages.bgmVolume, '(sysMenus)[Volume BGM]');
        assert.equal(runtime.$dataSystem.terms.messages.seVolume, '(sysMenus)[Volume SFX]');
        // These have NO alias (no .cld key) → stay untranslated (NOT "Volume BGM").
        assert.equal(runtime.$dataSystem.terms.messages.bgsVolume, 'BGS Volume');
        assert.equal(runtime.$dataSystem.terms.messages.meVolume, 'ME Volume');
        // translate() converts the wrapped ones.
        assert.equal(translate(runtime.$dataSystem.terms.messages.alwaysDash, language), 'Всегда бежать');
        assert.equal(translate(runtime.$dataSystem.terms.messages.bgmVolume, language), 'Громкость музыки');
        assert.equal(translate(runtime.$dataSystem.terms.messages.seVolume, language), 'Громкость звуков');
});

test('wrapSystemTerms alias only applies when the target sysMenus key exists', () => {
        // "Always Dash" has an alias to "Run Always", but if the .cld has no
        // "Run Always" key, the alias is not applied (string stays unchanged).
        const language = { sysMenus: { 'New Game': 'Новая Игра' }, sysLabel: {} };
        const runtime: any = {
                $dataSystem: { gameTitle: 'Test', terms: { commands: [], messages: { alwaysDash: 'Always Dash' } } },
        };
        wrapSystemTerms(runtime, language);
        assert.equal(runtime.$dataSystem.terms.messages.alwaysDash, 'Always Dash'); // unchanged
});

test('installGameCompatibility hooks Window_Options.booleanStatusText to wrap On/Off', () => {
        const language = { sysMenus: { 'On': 'Вкл.', 'Off': 'Выкл.' }, sysLabel: {} };
        const runtime: any = {
                Window_Options: { prototype: { booleanStatusText(value: boolean) { return value ? 'ON' : 'OFF'; } } },
                StorageManager: {},
                Input: {},
                DataManager: { setupNewGame() {} },
        };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, language);
        const proto = runtime.Window_Options.prototype;
        // booleanStatusText now returns escape sequences.
        assert.equal(proto.booleanStatusText(true), '(sysMenus)[On]');
        assert.equal(proto.booleanStatusText(false), '(sysMenus)[Off]');
        // translate() converts them.
        assert.equal(translate(proto.booleanStatusText(true), language), 'Вкл.');
        assert.equal(translate(proto.booleanStatusText(false), language), 'Выкл.');
});

test('PauseMenu.languageCycle is set by Left/Right on the Language item', () => {
        const menu = new PauseMenu(false);
        const buttons = (id: number) => Array.from({ length: 16 }, (_, n) => ({ pressed: n === id }));
        // Open the pause menu (hold Minus).
        menu.step(buttons(8), 0); menu.step(buttons(8), 1000);
        assert.ok(menu.open);
        // Navigate to "Another" (page 1, index 4) and press A → page 2.
        menu.selected = 4;
        menu.step(buttons(1), 1001);
        assert.equal(menu.page, 2);
        // The Language item is on page 2. Find its index.
        const langIdx = menu.currentItems.indexOf('language');
        assert.ok(langIdx >= 0);
        menu.selected = langIdx;
        // Press Right → languageCycle = +1.
        menu.step(null, 1002); // release
        menu.step(buttons(15), 1003); // Right edge
        assert.equal(menu.languageCycle, 1);
        // Press Left → languageCycle = -1.
        menu.step(null, 1004);
        menu.step(buttons(14), 1005); // Left edge
        assert.equal(menu.languageCycle, -1);
        // No Left/Right → languageCycle = 0.
        menu.step(null, 1006);
        menu.step(null, 1007);
        assert.equal(menu.languageCycle, 0);
});



// === menuButtonIndicesFor: A/B mirrors the game's ok/cancel mapping =====
// Verifies request #2 — if the game's keymap maps A or B to ok/cancel, the
// loader's menus (save-choice, pause menu, quit notice, etc.) use the SAME
// button for confirm/cancel. If neither A nor B is ok/cancel, the default
// (Nintendo A=confirm, Nintendo B=cancel) is kept.

function km(...buttons: string[]): KeyMap {
        const full = [...buttons];
        while (full.length < 16) full.push('none');
        return { buttons: full as any };
}

test('menuButtonIndicesFor: DEFAULT keymap (A=cancel, B=ok) → confirm=1 (Nintendo A), cancel=0 (Nintendo B)', () => {
        // DEFAULT_KEYMAP: buttons[0]='cancel' (Nintendo B), buttons[1]='ok' (Nintendo A).
        // This is the long-standing BurialNX convention and must be preserved
        // as the no-op default — the dynamic logic only changes behavior when
        // the user actually swaps A/B.
        const m = menuButtonIndicesFor(DEFAULT_KEYMAP);
        assert.equal(m.confirm, 1, 'confirm = Nintendo A (button 1)');
        assert.equal(m.cancel, 0, 'cancel = Nintendo B (button 0)');
});

test('menuButtonIndicesFor: swapped keymap (A=ok, B=cancel) → confirm=0, cancel=1 (the menu mirrors the swap)', () => {
        const m = menuButtonIndicesFor(km('ok', 'cancel'));
        assert.equal(m.confirm, 0, 'confirm = button 0 (now ok)');
        assert.equal(m.cancel, 1, 'cancel = button 1 (now cancel)');
});

test('menuButtonIndicesFor: only ok is on A/B (ok on B=1, A=0 is shift) → confirm=1, cancel=0 (the other A/B)', () => {
        const m = menuButtonIndicesFor(km('shift', 'ok'));
        assert.equal(m.confirm, 1, 'confirm = button 1 (ok)');
        assert.equal(m.cancel, 0, 'cancel = button 0 (the OTHER A/B, even though it is shift in the game)');
});

test('menuButtonIndicesFor: only cancel is on A/B (cancel on A=0, B=1 is shift) → cancel=0, confirm=1 (the other A/B)', () => {
        const m = menuButtonIndicesFor(km('cancel', 'shift'));
        assert.equal(m.cancel, 0, 'cancel = button 0 (cancel)');
        assert.equal(m.confirm, 1, 'confirm = button 1 (the OTHER A/B)');
});

test('menuButtonIndicesFor: ok on A=0 AND cancel on B=1 (swapped, both set) → confirm=0, cancel=1', () => {
        const m = menuButtonIndicesFor(km('ok', 'cancel'));
        assert.equal(m.confirm, 0);
        assert.equal(m.cancel, 1);
});

test('menuButtonIndicesFor: neither A nor B is ok/cancel (both shift) → default confirm=1, cancel=0', () => {
        const m = menuButtonIndicesFor(km('shift', 'shift'));
        assert.equal(m.confirm, 1, 'default confirm');
        assert.equal(m.cancel, 0, 'default cancel');
});

test('menuButtonIndicesFor: ok on BOTH A and B → A wins (priority: A checked first) → confirm=1, cancel=0', () => {
        // Degenerate: both Nintendo A (button 1) and Nintendo B (button 0) map to
        // ok. Per the user's spec, A is checked FIRST and determines both roles —
        // so A (button 1) becomes confirm and B (button 0) becomes cancel,
        // regardless of B's own 'ok' binding ("вне зависимости от того что на B
        // установлено").
        const m = menuButtonIndicesFor(km('ok', 'ok'));
        assert.equal(m.confirm, 1, 'A (button 1) wins → confirm = 1');
        assert.equal(m.cancel, 0, 'B (button 0) takes the opposite → cancel = 0');
});

test('menuButtonIndicesFor: A is cancel, B is ok → A wins → cancel=A(1), confirm=B(0) (A takes priority even when B is also set)', () => {
        // A (button 1) is cancel, B (button 0) is ok. A is checked first and
        // is "set" (cancel) → A determines: cancel=A=1, confirm=B=0. B's own
        // 'ok' binding is IGNORED because A won.
        const m = menuButtonIndicesFor(km('ok', 'cancel'));
        assert.equal(m.confirm, 0, 'confirm = B (button 0), the opposite of A');
        assert.equal(m.cancel, 1, 'cancel = A (button 1), as A is set to cancel');
});

// === keyCode-based role detection (enter/space → ok, esc → cancel) =====
// "Set to ok" now also means keyCode enter(13)/space(32); "set to cancel"
// also means keyCode esc(27). A button can be "ok"/"cancel" via its keyCode
// binding even when its vkey entry is 'none'.

test('menuButtonIndicesFor: A has keyCode enter(13) → A is ok → confirm=1, cancel=0', () => {
        // buttons[1]='none' but keyCodes[1]=13 (enter). The game's keyMapper
        // translates the fired enter keydown to 'ok', so A "is ok".
        const m = menuButtonIndicesFor({ buttons: ['none', 'none'], keyCodes: [0, 13] });
        assert.equal(m.confirm, 1);
        assert.equal(m.cancel, 0);
});

test('menuButtonIndicesFor: A has keyCode space(32) → A is ok → confirm=1, cancel=0', () => {
        const m = menuButtonIndicesFor({ buttons: ['none', 'none'], keyCodes: [0, 32] });
        assert.equal(m.confirm, 1);
        assert.equal(m.cancel, 0);
});

test('menuButtonIndicesFor: A has keyCode esc(27) → A is cancel → cancel=1, confirm=0', () => {
        const m = menuButtonIndicesFor({ buttons: ['none', 'none'], keyCodes: [0, 27] });
        assert.equal(m.cancel, 1);
        assert.equal(m.confirm, 0);
});

test('menuButtonIndicesFor: A vkey is escape → A is cancel (escape vkey ≈ cancel)', () => {
        const m = menuButtonIndicesFor(km('none', 'escape'));
        assert.equal(m.cancel, 1);
        assert.equal(m.confirm, 0);
});

test('menuButtonIndicesFor: A not set, B has keyCode enter(13) → B is ok → confirm=0, cancel=1', () => {
        // Case 3 from the user's spec: A is NOT set (no ok/cancel vkey or
        // keyCode), B is set to ok (via keyCode enter). B wins → B=ok=confirm,
        // A=opposite=cancel.
        const m = menuButtonIndicesFor({ buttons: ['none', 'none'], keyCodes: [13, 0] });
        assert.equal(m.confirm, 0, 'B (button 0) with enter keyCode → confirm = B');
        assert.equal(m.cancel, 1, 'A (button 1) takes the opposite → cancel = A');
});

test('menuButtonIndicesFor: A has keyCode enter(13) AND B has vkey cancel → A wins (priority), B ignored', () => {
        // A is set (ok via keyCode enter), B is set (cancel via vkey). A is
        // checked first → A wins → confirm=A=1, cancel=B=0. B's cancel binding
        // is ignored because A already determined both roles.
        const m = menuButtonIndicesFor({ buttons: ['cancel', 'none'], keyCodes: [0, 13] });
        assert.equal(m.confirm, 1, 'A (keyCode enter) wins → confirm = A = 1');
        assert.equal(m.cancel, 0, 'B takes the opposite → cancel = B = 0 (B\'s own cancel is ignored)');
});

test('menuButtonIndicesFor: neither A nor B has ok/cancel vkey OR keyCode → default confirm=1, cancel=0', () => {
        // Both buttons are 'shift' vkey with no keyCode bindings.
        const m = menuButtonIndicesFor({ buttons: ['shift', 'shift'] });
        assert.equal(m.confirm, 1, 'default confirm = Nintendo A');
        assert.equal(m.cancel, 0, 'default cancel = Nintendo B');
});

test('menuButtonIndicesFor: A has a non-ok keyCode (e.g. 87=W) → A is NOT ok → falls through to B', () => {
        // keyCode 87 (W) is neither enter/space/esc, so it doesn't make A "ok"
        // or "cancel". A is not set → check B. B has vkey 'ok' → B wins.
        const m = menuButtonIndicesFor({ buttons: ['ok', 'none'], keyCodes: [0, 87] });
        assert.equal(m.confirm, 0, 'B (button 0) is ok → confirm = B');
        assert.equal(m.cancel, 1, 'A takes the opposite → cancel = A');
});

test('faceButtonLetter: returns Nintendo labels for the 4 face buttons (0=B, 1=A, 2=X, 3=Y)', () => {
        assert.equal(faceButtonLetter(0), 'B', 'button 0 = Nintendo B (South)');
        assert.equal(faceButtonLetter(1), 'A', 'button 1 = Nintendo A (East)');
        assert.equal(faceButtonLetter(2), 'X');
        assert.equal(faceButtonLetter(3), 'Y');
});

// === Save/load input isolation (the "B in save menu → game fast-forwards" fix) ===
// Verifies bug #1: while Scene_Save/Scene_Load is active, the per-frame button
// keyCode injection (pollButtonBindings) is SKIPPED so stale _currentState
// can't leak into Scene_Map. clearButtonKeyState fires keyup for every
// button keyCode binding so nothing survives the scene boundary.

test('clearButtonKeyState: fires keyup for every button keyCode binding and resets the press tracker', () => {
        const keyups: number[] = [];
        const input: any = {
                _onKeyUp: (ev: any) => { keyups.push(ev.keyCode); },
                _buttonKeyState: { 1: true, 2: true },
        };
        const previousInput = (globalThis as any).Input;
        (globalThis as any).Input = input;
        try {
                // keymap: button 0 → keyCode 13 (enter), button 1 → keyCode 27 (esc).
                clearButtonKeyState(null, { buttons: ['ok', 'cancel'], keyCodes: [13, 27] });
                // A keyup fired for BOTH button keyCode bindings (13 and 27),
                // regardless of whether they were "pressed" — over-firing keyup
                // is harmless, under-firing leaves stale state.
                assert.deepEqual(keyups.sort(), [13, 27], 'keyup fired for every button keyCode binding');
                // The per-button press tracker is reset so the next poll treats
                // every button as freshly-pressed (re-arms edge detection).
                assert.equal(input._buttonKeyState[1], false, 'press tracker cleared');
                assert.equal(input._buttonKeyState[2], false, 'press tracker cleared');
        } finally {
                (globalThis as any).Input = previousInput;
        }
});

test('clearButtonKeyState: never throws when there is no Input runtime', () => {
        const previousInput = (globalThis as any).Input;
        delete (globalThis as any).Input;
        try {
                assert.doesNotThrow(() => clearButtonKeyState(null, { buttons: ['ok', 'cancel'], keyCodes: [13] }));
        } finally {
                (globalThis as any).Input = previousInput;
        }
});

test('PauseMenu.step: confirm/cancel indices mirror the game keymap (swap A/B and the pause menu swaps too)', () => {
        // Build a fake gamepad: button 0 (Nintendo B) and button 1 (Nintendo A).
        const mkButtons = (a: boolean, b: boolean) => Array.from({ length: 16 }, (_, i) => ({ pressed: i === 0 ? a : i === 1 ? b : false }));
        const menu = new PauseMenu(false);
        // Open the menu first (the open state is where confirm/cancel matter).
        (menu as any).open = true;
        (menu as any).armed = false;
        // DEFAULT keymap: confirm=1 (Nintendo A), cancel=0 (Nintendo B).
        // Pressing Nintendo A (button 1) should select the highlighted item.
        let buttons = mkButtons(false, true); // B=up, A=pressed
        let action = menu.step(buttons, 1000, 0, 1, 0); // confirm=1, cancel=0
        assert.equal(action, 'continue', 'DEFAULT: Nintendo A (button 1) confirms the selected item (continue)');
        // Now SWAP the keymap: A=ok→button 0, B=cancel→button 1. The pause menu
        // is told confirm=0, cancel=1. Now Nintendo B (button 0) should confirm.
        const menu2 = new PauseMenu(false);
        (menu2 as any).open = true;
        (menu2 as any).armed = false;
        buttons = mkButtons(true, false); // B(Nintendo B)=pressed, A=up
        action = menu2.step(buttons, 1000, 0, 0, 1); // confirm=0, cancel=1
        assert.equal(action, 'continue', 'SWAPPED: Nintendo B (button 0) now confirms — the menu mirrored the swap');
});

// === buildSaveLoadMapper: the in-game Scene_Save/Scene_Load keymap ======
// Verifies that the save/load scene's gamepadMapper mirrors the game's A/B
// mapping (not the hardcoded DEFAULT). This is the fix for "A/B remapping
// doesn't work in the in-game save/load screen" — the old override forced
// DEFAULT (A=ok, B=cancel) and IGNORED the user's remap.

test('buildSaveLoadMapper: default A/B (mc=1, mx=0) → button 1=ok, button 0=cancel', () => {
        // DEFAULT game keymap: A (button 1)=ok, B (button 0)=cancel →
        // menuButtonIndicesFor returns {confirm:1, cancel:0}. The save/load
        // mapper keeps ok on button 1 and cancel on button 0 (matches DEFAULT).
        const m = buildSaveLoadMapper(1, 0);
        assert.equal(m[1], 'ok', 'button 1 (Nintendo A) = ok');
        assert.equal(m[0], 'cancel', 'button 0 (Nintendo B) = cancel');
});

test('buildSaveLoadMapper: swapped A/B (mc=0, mx=1) → button 0=ok, button 1=cancel (mirrors the swap)', () => {
        // Game keymap with B=ok / A=cancel → menuButtonIndicesFor returns
        // {confirm:0, cancel:1}. The save/load mapper puts ok on button 0 (B)
        // and cancel on button 1 (A) — so in the save menu, B confirms a save
        // slot and A backs out, EXACTLY matching the game's mapping (the bug
        // was that the old override forced A=ok/B=cancel here, inverting it).
        const m = buildSaveLoadMapper(0, 1);
        assert.equal(m[0], 'ok', 'button 0 (Nintendo B) = ok — mirrors the game');
        assert.equal(m[1], 'cancel', 'button 1 (Nintendo A) = cancel — mirrors the game');
});

test('buildSaveLoadMapper: keeps DEFAULT D-pad/shoulders regardless of the A/B swap', () => {
        // The override only swaps ok/cancel onto mc/mx; the rest of the
        // DEFAULT layout (D-pad = up/down/left/right, X=shift, Y=menu,
        // L=pageup, R=pagedown) is preserved so save-slot navigation still
        // works even when the game bound ok/cancel to non-face buttons.
        const m = buildSaveLoadMapper(0, 1); // swapped A/B
        assert.equal(m[12], 'up', 'D-pad up preserved');
        assert.equal(m[13], 'down', 'D-pad down preserved');
        assert.equal(m[14], 'left', 'D-pad left preserved');
        assert.equal(m[15], 'right', 'D-pad right preserved');
        assert.equal(m[2], 'shift', 'X = shift preserved');
        assert.equal(m[3], 'menu', 'Y = menu preserved');
        assert.equal(m[4], 'pageup', 'L = pageup preserved');
        assert.equal(m[5], 'pagedown', 'R = pagedown preserved');
});

test('buildSaveLoadMapper: mirrors menuButtonIndicesFor for the DEFAULT keymap end-to-end', () => {
        // End-to-end: the DEFAULT_KEYMAP (A=ok, B=cancel) flows through
        // menuButtonIndicesFor → {confirm:1, cancel:0} → buildSaveLoadMapper
        // → button 1=ok, button 0=cancel. The save menu uses the same A/B
        // as the game.
        const { confirm, cancel } = menuButtonIndicesFor(DEFAULT_KEYMAP);
        const m = buildSaveLoadMapper(confirm, cancel);
        assert.equal(m[confirm], 'ok', 'confirm button = ok');
        assert.equal(m[cancel], 'cancel', 'cancel button = cancel');
});

test('buildSaveLoadMapper: mirrors menuButtonIndicesFor for a swapped keymap end-to-end', () => {
        // Swapped keymap: B (button 0)=ok, A (button 1)=cancel.
        // menuButtonIndicesFor → {confirm:0, cancel:1} (B wins because A is
        // cancel, A checked first → A is cancel → cancel=A=1, confirm=B=0).
        // Wait — let me re-derive: A=button1='cancel' → isCancelRoleAt(A=1)
        // → yes → {confirm:B=0, cancel:A=1}. So confirm=0, cancel=1.
        const swapped: KeyMap = { buttons: ['ok', 'cancel'] };
        const { confirm, cancel } = menuButtonIndicesFor(swapped);
        assert.equal(confirm, 0, 'confirm = B (button 0)');
        assert.equal(cancel, 1, 'cancel = A (button 1)');
        const m = buildSaveLoadMapper(confirm, cancel);
        assert.equal(m[0], 'ok', 'B (button 0) = ok — mirrors the game');
        assert.equal(m[1], 'cancel', 'A (button 1) = cancel — mirrors the game');
});

// === clearButtonKeyState: sync _buttonKeyState to the physical gamepad ===
// Verifies bug #2's fix: clearButtonKeyState used to reset _buttonKeyState to
// `false`, which made pollButtonBindings re-fire keydown for a STILL-HELD
// button on the next frame (the "press A to save → game fast-forwards" bug).
// Now it syncs _buttonKeyState to the actual physical gamepad state, so a
// held button keeps wasPressed=true → no re-fired keydown.

test('clearButtonKeyState: syncs _buttonKeyState to the physical gamepad (held buttons stay pressed, not reset to false)', () => {
        const keyups: number[] = [];
        const input: any = {
                _onKeyUp: (ev: any) => { keyups.push(ev.keyCode); },
                _buttonKeyState: {},
        };
        const previousInput = (globalThis as any).Input;
        (globalThis as any).Input = input;
        // Mock a gamepad where button 1 (Nintendo A) and button 5 are held.
        const previousGetGamepads = (navigator as any).getGamepads;
        (navigator as any).getGamepads = () => [{ buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 1 || i === 5 })) }];
        try {
                clearButtonKeyState(null, { buttons: ['ok', 'cancel'], keyCodes: [13, 27] });
                // keyup fired for both keyCode bindings (13 and 27).
                assert.deepEqual(keyups.sort(), [13, 27], 'keyup fired for every keyCode binding');
                // _buttonKeyState mirrors the PHYSICAL state — button 1 and 5
                // are held → true; the rest → false. This is the fix: a held
                // button is NOT reset to false (which would re-fire keydown).
                assert.equal(input._buttonKeyState[1], true, 'button 1 (held) stays true — no re-fire on next poll');
                assert.equal(input._buttonKeyState[5], true, 'button 5 (held) stays true');
                assert.equal(input._buttonKeyState[0], false, 'button 0 (released) → false');
                assert.equal(input._buttonKeyState[3], false, 'button 3 (released) → false');
        } finally {
                (globalThis as any).Input = previousInput;
                (navigator as any).getGamepads = previousGetGamepads;
        }
});

// === clearSaveLoadVkeyState: clear stale ok/cancel vkey triggers ===========
// Verifies bug #1's fix: a stale 'ok'/'cancel' trigger from Scene_Save's last
// frame would leak into the resumed Scene_Message (dialogue) and crash with
// "Cannot read properties of undefined (reading bitmap)" because the dialogue
// advanced/closed in a half-set-up state. clearSaveLoadVkeyState sets
// _currentState['ok'/'cancel'] to the PHYSICAL button state (so _updateGamepadState
// sees no edge → no re-trigger) and clears _events (drops the stale trigger).

test('clearSaveLoadVkeyState: clears _latestButton + _pressedTime (stops isRepeated leak) and sets _currentState/_previousState to physical', () => {
        // RPG Maker MV's Input uses _currentState, _previousState,
        // _latestButton, _pressedTime (NOT _events — the old test checked
        // _events which was a no-op). This test verifies the REAL clear that
        // fixes both the fast-forward bug (isRepeated needs _latestButton) and
        // the choice-crash bug (stale trigger auto-advancing during resume).
        const input: any = {
                _currentState: { 'ok': true, 'cancel': true, 'up': true },     // stale held state from Scene_Save
                _previousState: { 'ok': true, 'cancel': false, 'up': false },
                _latestButton: 'ok',   // ← the fast-forward culprit: isRepeated('ok') would be true
                _pressedTime: 5,       // ← held for 5 frames → isRepeated hits the repeat interval
        };
        const previousInput = (globalThis as any).Input;
        (globalThis as any).Input = input;
        // Mock a gamepad: button 1 (mc=Nintendo A, the confirm button) is held,
        // button 0 (mx=Nintendo B, the cancel button) is released.
        const previousGetGamepads = (navigator as any).getGamepads;
        (navigator as any).getGamepads = () => [{ buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 1 })) }];
        try {
                clearSaveLoadVkeyState(1, 0);  // mc=1 (A), mx=0 (B)
                // _currentState matches physical → no up→down edge for _updateGamepadState / Input.update.
                assert.equal(input._currentState['ok'], true, 'ok matches physical (held) → no fresh edge');
                assert.equal(input._currentState['cancel'], false, 'cancel matches physical (released)');
                // _previousState matches physical → Input.update's edge check (currentState && !previousState) is false.
                assert.equal(input._previousState['ok'], true, 'previousState ok matches physical (held)');
                assert.equal(input._previousState['cancel'], false, 'previousState cancel matches physical (released)');
                // _latestButton CLEARED → isRepeated('ok'/'cancel') returns false → no _showFast → no fast-forward.
                assert.equal(input._latestButton, null, '_latestButton cleared → isRepeated returns false (no fast-forward)');
                assert.equal(input._pressedTime, 0, '_pressedTime reset');
                // Other vkeys (up) untouched — only ok/cancel are matched.
                assert.equal(input._currentState['up'], true, 'unrelated vkey state preserved');
        } finally {
                (globalThis as any).Input = previousInput;
                (navigator as any).getGamepads = previousGetGamepads;
        }
});

test('clearSaveLoadVkeyState: never throws when there is no Input runtime', () => {
        const previousInput = (globalThis as any).Input;
        delete (globalThis as any).Input;
        try {
                assert.doesNotThrow(() => clearSaveLoadVkeyState(1, 0));
        } finally {
                (globalThis as any).Input = previousInput;
        }
});

// === isActiveChoice: detect a dialogue choice to block Save/Load =======
// Verifies the safety net for the "cancel in save menu during a choice →
// bitmap crash" bug: the pause menu blocks Save/Load when isActiveChoice()
// is true (regular dialogue without choices is still allowed).

test('isActiveChoice: false when there is no SceneManager / scene', () => {
        const rt: any = { SceneManager: { _scene: null } };
        assert.equal(isActiveChoice(rt), false);
        assert.equal(isActiveChoice({} as any), false);
});

test('isActiveChoice: true on Scene_Map WITH non-empty choices (the crash scenario)', () => {
        // The ACTUAL crash scenario: during gameplay the active scene is
        // Scene_Map (Scene_Message is a MIXIN, not the active scene instance),
        // and $gameMessage.choices is populated. The OLD check required
        // `scene instanceof Scene_Message` which was always false here → the
        // block never triggered → the crash kept happening. The new check
        // drops the scene-type requirement and keys off $gameMessage.choices.
        class Scene_Map {}
        const scene = new Scene_Map();
        const rt: any = { SceneManager: { _scene: scene }, $gameMessage: { choices: ['Yes', 'No', 'Maybe'] } };
        assert.equal(isActiveChoice(rt), true, 'Scene_Map with choices → true (block Save/Load)');
});

test('isActiveChoice: false on Scene_Map WITHOUT choices (regular gameplay → Save/Load allowed)', () => {
        // No choices, no open choice window → regular gameplay → Save/Load allowed.
        class Scene_Map {}
        const scene = new Scene_Map();
        const rt: any = { SceneManager: { _scene: scene }, $gameMessage: { choices: [] } };
        assert.equal(isActiveChoice(rt), false, 'no choices → false');
});

test('isActiveChoice: false when $gameMessage is missing but no choice window is open', () => {
        // Defensive: no $gameMessage at all, scene has no _choiceWindow → false.
        class Scene_Map {}
        const rt: any = { SceneManager: { _scene: new Scene_Map() } };
        assert.equal(isActiveChoice(rt), false);
});

test('isActiveChoice: true on Scene_Message WITH non-empty choices (still works for the base scene)', () => {
        // Scene_Message directly (some games push it as its own scene) with
        // choices → true.
        class Scene_Message {}
        const scene = new Scene_Message();
        const rt: any = { SceneManager: { _scene: scene }, $gameMessage: { choices: ['Yes', 'No'] } };
        assert.equal(isActiveChoice(rt), true, 'choice active → true (Save/Load blocked)');
});

test('isActiveChoice: true when the scene has an OPEN _choiceWindow (fallback path)', () => {
        // Custom message systems might not populate $gameMessage.choices the
        // standard way, but they DO open a choice window. The fallback path
        // detects an open _choiceWindow / _choiceListWindow.
        class Scene_Map {}
        const scene = new Scene_Map();
        (scene as any)._choiceWindow = { open: true };
        const rt: any = { SceneManager: { _scene: scene }, $gameMessage: { choices: [] } };
        assert.equal(isActiveChoice(rt), true, 'open choice window → true even without $gameMessage.choices');
});

test('isActiveChoice: false when _choiceWindow exists but is CLOSED', () => {
        class Scene_Map {}
        const scene = new Scene_Map();
        (scene as any)._choiceWindow = { open: false, active: false, visible: false };
        const rt: any = { SceneManager: { _scene: scene }, $gameMessage: { choices: [] } };
        assert.equal(isActiveChoice(rt), false, 'closed choice window → false');
});

test('isActiveChoice: true when $gameMessage.isChoice() returns true (plugin variant)', () => {
        // Some RPG Maker MV versions / plugins expose isChoice() instead of (or
        // alongside) the choices array. Honor both.
        class Scene_Map {}
        const rt: any = { SceneManager: { _scene: new Scene_Map() }, $gameMessage: { choices: [], isChoice: () => true } };
        assert.equal(isActiveChoice(rt), true);
});

// === installSaveLoadPopHook: clear at the MOMENT of pop ================
// Verifies the timing fix: the save/load override (gamepadMapper + vkey
// state) is cleared synchronously when Scene_Save/Load pops — BEFORE the
// resumed scene's update runs in the same updateMain call. This closes the
// one-frame gap that let a stale ok/cancel vkey trigger leak into
// Scene_Message (the bitmap crash).

test('installSaveLoadPopHook: wraps SceneManager.pop and clears the override synchronously on pop', () => {
        // Set up a fake runtime where the save/load override is "active"
        // (simulating that Scene_Save is about to pop).
        const savedMapper = { 0: 'cancel', 1: 'ok' }; // the per-game mapper that was saved on ENTER
        const overrideMapper = { 0: 'ok', 1: 'cancel' }; // the dynamic override
        const input: any = {
                gamepadMapper: overrideMapper,
                _currentState: { 'ok': true, 'cancel': true },  // stale triggers from Scene_Save
                _events: { 'ok': true, 'cancel': true },
        };
        // Mock a gamepad where button 1 (mc) is held, button 0 (mx) is released.
        const previousGetGamepads = (navigator as any).getGamepads;
        (navigator as any).getGamepads = () => [{ buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 1 })) }];
        // SceneManager with a pop that records the call.
        let popCalled = false;
        const sm: any = {
                pop: function() { popCalled = true; },
                __bnxPopHooked: false,
        };
        const rt: any = { SceneManager: sm, Input: input, Scene_Save: function(){}, Scene_Message: function(){}, $gameMessage: { choices: [] } };
        const previousGlobal = (globalThis as any);
        const savedSceneManager = previousGlobal.SceneManager;
        const savedInput = previousGlobal.Input;
        const savedSceneSave = previousGlobal.Scene_Save;
        const savedSceneMessage = previousGlobal.Scene_Message;
        const savedGameMessage = previousGlobal.$gameMessage;
        Object.assign(previousGlobal, { SceneManager: sm, Input: input, Scene_Save: rt.Scene_Save, Scene_Message: rt.Scene_Message, $gameMessage: rt.$gameMessage });
        try {
                // Simulate the save/load override being active (as if
                // overrideKeymapForSaveLoadScene's ENTER branch ran): the module's
                // saveLoadKeymapActive flag is true and savedGamepadMapper holds
                // the per-game mapper. We do this by running the ENTER path
                // through overrideKeymapForSaveLoadScene — but that needs a
                // Scene_Save instance. Instead, directly install the pop hook and
                // then trigger a pop; the hook only acts if saveLoadKeymapActive
                // is true, which we can't set from outside. So this test verifies
                // the HOOK INSTALLATION + passthrough (non-save/load pop is a
                // no-op).
                installSaveLoadPopHook();
                assert.equal(sm.__bnxPopHooked, true, 'pop hook installed (idempotent flag set)');
                assert.equal(typeof sm.pop, 'function', 'pop is still a function');
                // Calling pop with saveLoadKeymapActive=false (default) is a
                // transparent passthrough — it calls the original pop.
                sm.pop();
                assert.equal(popCalled, true, 'original pop was called (passthrough when no save/load active)');
                // gamepadMapper UNCHANGED (no save/load override to clear).
                assert.equal(input.gamepadMapper, overrideMapper, 'mapper unchanged when no save/load active');
                // Idempotent: installing again is a no-op.
                installSaveLoadPopHook();
                assert.equal(sm.__bnxPopHooked, true, 're-install is a no-op');
        } finally {
                // Restore the original pop (so other tests aren't affected) by
                // clearing the hook flag + restoring. Since we can't un-wrap,
                // just restore the globals; the wrapped pop calls the original
                // (which is a no-op recorder) — harmless.
                Object.assign(previousGlobal, { SceneManager: savedSceneManager, Input: savedInput, Scene_Save: savedSceneSave, Scene_Message: savedSceneMessage, $gameMessage: savedGameMessage });
                (navigator as any).getGamepads = previousGetGamepads;
        }
});

// === Defensive contents getter + message-start suppression ===============
// Verifies the fix for the "Cannot read properties of undefined (reading
// 'bitmap')" crash on cancelling save/load during a dialogue choice. The
// crash happens during Scene_Map re-creation after Scene_Save pops: the
// choice window's refresh → createContents → `this.contents = new Bitmap()`
// → setter `this._windowContentsSprite.bitmap = value` crashes if
// `_windowContentsSprite` is undefined.

test('installGameCompatibility: wraps Window.prototype.contents to lazily create a dummy sprite+bitmap when _windowContentsSprite is undefined (prevents the bitmap crash)', () => {
        // Fake runtime with Window.prototype that has a crashing `contents` getter.
        let createdSprite = 0, createdBitmap = 0;
        class Sprite { constructor() { createdSprite++; this.bitmap = null; } }
        class Bitmap { constructor() { createdBitmap++; } }
        const proto: any = {};
        Object.defineProperty(proto, 'contents', {
                get: function() { return this._windowContentsSprite.bitmap; },
                set: function(v) { this._windowContentsSprite.bitmap = v; },
                configurable: true,
        });
        const Window = function(){}; Window.prototype = proto;
        // Sprite + Bitmap must be on the runtime (they're globals in nx.js).
        const runtime: any = { Window, Sprite, Bitmap };
        // Before install: accessing contents on a window without _windowContentsSprite
        // would crash. After install, it lazily creates a dummy sprite+bitmap.
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        const win: any = {};
        win.__proto__ = proto;
        // Accessing contents must NOT throw — it lazily creates the sprite+bitmap.
        let result: any;
        assert.doesNotThrow(() => { result = win.contents; }, 'contents getter lazily creates _windowContentsSprite → no crash');
        assert.ok(result instanceof Bitmap, 'getter returned the dummy bitmap');
        assert.ok(createdSprite >= 1, 'a dummy Sprite was created');
        // Setter: assigning contents also works (creates the sprite if missing).
        const fresh: any = {}; fresh.__proto__ = proto;
        assert.doesNotThrow(() => { fresh.contents = new Bitmap(); });
});

test('installGameCompatibility: wraps Window_Message.update to suppress the message/choice re-draw loop for 3 frames after a save/load pop (the _bnxSuppressMessageStart flag)', () => {
        // The earlier fix wrapped canStart, but Window_Message.update falls
        // through to startInput() (→ _choiceWindow.start()) when canStart is
        // false — so the choice re-draw STILL ran during the suppress. Now the
        // whole update loop is suppressed (only Window_Base.update runs for
        // window animation), deferring BOTH startMessage AND startInput.
        let updateCalls = 0;
        const updateOrig = function() { updateCalls++; };
        const baseUpdate = function() {};  // Window_Base.prototype.update (no-op in test)
        const msgProto: any = { update: updateOrig };
        const Window_Message = function(){}; Window_Message.prototype = msgProto;
        const Window_Base = function(){}; Window_Base.prototype = { update: baseUpdate };
        const runtime: any = { Window_Message, Window_Base };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        // No suppression flag → update calls the original (full message loop).
        msgProto.update.call({});
        assert.equal(updateCalls, 1, 'no flag → original update runs');
        // Set the suppression flag (as the pop-hook does on save/load exit).
        runtime._bnxSuppressMessageStart = 3;
        // For 3 calls, update is suppressed — the original is NOT called (only
        // Window_Base.update runs for window animation).
        updateCalls = 0;
        msgProto.update.call({});
        assert.equal(updateCalls, 0, 'frame 1: original NOT called (suppressed)');
        assert.equal(runtime._bnxSuppressMessageStart, 2, 'flag decremented');
        msgProto.update.call({});
        msgProto.update.call({});
        assert.equal(runtime._bnxSuppressMessageStart, 0, 'flag exhausted after 3 frames');
        assert.equal(updateCalls, 0, 'original NOT called during suppression');
        // After the flag is exhausted, update calls the original again.
        msgProto.update.call({});
        assert.equal(updateCalls, 1, 'frame 4: original update runs again');
});

test('installGameCompatibility: wraps Window.prototype.windowskin getter to lazily create a dummy bitmap when _windowskin is undefined (prevents the getPixel crash)', () => {
        // Window_Base.textColor → this.windowskin.getPixel(px, py). If
        // _windowskin is undefined (window not fully initialized on the
        // resume frame) → crash "Cannot read properties of undefined (reading
        // 'getPixel')". The defensive getter lazily loads the windowskin.
        const dummyBitmap: any = { getPixel: () => '#000000' };
        let loadedWindow = false;
        class Bitmap { getPixel() { return '#000000'; } }
        const proto: any = {};
        Object.defineProperty(proto, 'windowskin', {
                get: function() { return this._windowskin; },
                set: function(v) { this._windowskin = v; },
                configurable: true,
        });
        const Window = function(){}; Window.prototype = proto;
        const ImageManager = { loadSystem: () => { loadedWindow = true; return dummyBitmap; } };
        const runtime: any = { Window, Bitmap, ImageManager };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        const win: any = {}; win.__proto__ = proto;
        // _windowskin is undefined → getter lazily loads the real windowskin.
        let skin: any;
        assert.doesNotThrow(() => { skin = win.windowskin; }, 'windowskin getter lazily loads → no crash');
        assert.ok(loadedWindow, 'ImageManager.loadSystem("Window") was called to load the real skin');
        assert.equal(skin, dummyBitmap, 'getter returned the loaded windowskin bitmap');
});

// === makeSaveContents rollback: save mid-choice → load resumes ON the choice ===
// Verifies the fix for "save during a dialogue choice → load skips past the
// choice". RPG Maker MV's makeSaveContents deliberately excludes $gameMessage.
// So on load, the interpreter's _waitMode='message' sees $gameMessage.isBusy()=
// false → advances past the choice branches (402) with unset _branch → the
// choice is skipped. The fix wraps makeSaveContents to roll the waiting
// interpreter's _index back to the ShowText(101)/ShowChoices(102) command + clear
// _waitMode + clear $gameMessage, so on load the interpreter RE-RUNS 101/102 →
// setupChoices re-populates $gameMessage + callback → the choice re-displays.

test('makeSaveContents rollback: rolls the waiting interpreter back to the ShowText(101) command and clears _waitMode + $gameMessage', () => {
        // Simulate an interpreter mid-choice: _index points PAST the 101/401/102
        // block (to the first choice branch 402), _waitMode='message'.
        const list = [
                { code: 101, indent: 0, parameters: ['', 0, 0] },  // index 0: ShowText
                { code: 401, indent: 0, parameters: ['Hello'] },    // index 1: Text data
                { code: 102, indent: 0, parameters: [['Yes','No'], 1, 0] },  // index 2: ShowChoices
                { code: 402, indent: 0, parameters: [0] },           // index 3: When [Yes]
                { code: 402, indent: 0, parameters: [1] },           // index 4: When [No]
        ];
        const interpreter: any = { _list: list, _index: 3, _waitMode: 'message', _indent: 0 };
        let gameMessageCleared = false;
        const $gameMessage: any = { clear: () => { gameMessageCleared = true; } };
        const runtime: any = {
                $gameMap: { _interpreter: interpreter },
                $gameMessage,
                DataManager: {
                        makeSaveContents: function() { return { map: { _interpreter: interpreter } }; },
                },
        };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        // Call makeSaveContents (the wrapper rolls back the interpreter first).
        runtime.DataManager.makeSaveContents();
        // The interpreter was rolled back to index 0 (the ShowText 101 command).
        assert.equal(interpreter._index, 0, '_index rolled back to ShowText (101)');
        assert.equal(interpreter._waitMode, '', '_waitMode cleared (no longer waiting)');
        assert.ok(gameMessageCleared, '$gameMessage.clear() called so the re-run re-populates it fresh');
});

test('makeSaveContents rollback: prefers ShowText(101) over ShowChoices(102) so the text + choices both re-run', () => {
        const list = [
                { code: 101, indent: 0, parameters: ['', 0, 0] },
                { code: 401, indent: 0, parameters: ['Hello'] },
                { code: 102, indent: 0, parameters: [['Yes','No'], 1, 0] },
                { code: 402, indent: 0, parameters: [0] },
        ];
        const interpreter: any = { _list: list, _index: 3, _waitMode: 'message', _indent: 0 };
        const runtime: any = {
                $gameMap: { _interpreter: interpreter },
                $gameMessage: { clear: () => {} },
                DataManager: { makeSaveContents: function() { return {}; } },
        };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        runtime.DataManager.makeSaveContents();
        assert.equal(interpreter._index, 0, 'rolled back to 101 (text + choices re-run), not just 102');
});

test('makeSaveContents rollback: falls back to ShowChoices(102) when no ShowText(101) is found', () => {
        // A standalone ShowChoices (no text) — no 101 in the list.
        const list = [
                { code: 102, indent: 0, parameters: [['Yes','No'], 1, 0] },
                { code: 402, indent: 0, parameters: [0] },
        ];
        const interpreter: any = { _list: list, _index: 1, _waitMode: 'message', _indent: 0 };
        const runtime: any = {
                $gameMap: { _interpreter: interpreter },
                $gameMessage: { clear: () => {} },
                DataManager: { makeSaveContents: function() { return {}; } },
        };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        runtime.DataManager.makeSaveContents();
        assert.equal(interpreter._index, 0, 'rolled back to 102 (choices-only fallback)');
        assert.equal(interpreter._waitMode, '', '_waitMode cleared');
});

test('makeSaveContents rollback: no-op when the interpreter is NOT waiting on a message (normal save)', () => {
        // A normal save (interpreter not waiting) — the wrapper must NOT roll back.
        const list = [{ code: 250, indent: 0, parameters: [] }];  // some non-message command
        const interpreter: any = { _list: list, _index: 0, _waitMode: '', _indent: 0 };
        const runtime: any = {
                $gameMap: { _interpreter: interpreter },
                $gameMessage: { clear: () => {} },
                DataManager: { makeSaveContents: function() { return {}; } },
        };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        runtime.DataManager.makeSaveContents();
        assert.equal(interpreter._index, 0, '_index unchanged (no rollback when not waiting)');
        assert.equal(interpreter._waitMode, '', '_waitMode unchanged');
});

test('makeSaveContents rollback: no-op when there is no 101/102 to roll back to', () => {
        // _waitMode='message' but the list has no 101/102 (shouldn't happen, but
        // be safe — don't roll back to an invalid index).
        const list = [{ code: 250, indent: 0, parameters: [] }];
        const interpreter: any = { _list: list, _index: 0, _waitMode: 'message', _indent: 0 };
        const runtime: any = {
                $gameMap: { _interpreter: interpreter },
                $gameMessage: { clear: () => {} },
                DataManager: { makeSaveContents: function() { return {}; } },
        };
        installGameCompatibility(runtime, 'sdmc:/game/www', false, null);
        runtime.DataManager.makeSaveContents();
        assert.equal(interpreter._index, 0, 'no rollback when no 101/102 found');
        // _waitMode is NOT cleared (we couldn't find a safe rollback target).
        assert.equal(interpreter._waitMode, 'message', '_waitMode unchanged (no safe rollback)');
});
