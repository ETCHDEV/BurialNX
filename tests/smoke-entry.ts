import { gameAssets } from '../src/game-assets';
import { scriptPlan } from '../src/runtime-plan';
import { createBrowserHost } from '../src/browser-host';
import { languageTable, prepareGameScript, installGameCompatibility } from '../src/game-compat';
import { importSteamSaves, installSdSaves } from '../src/saves';
import { installMapPrefetch, MapPrefetcher } from '../src/map-prefetch';

/** Execute startup scripts against an isolated fake screen, never writing game files. */
export async function smoke(read: (path: string) => Promise<ArrayBuffer | null>, report: (line: string) => void, step: () => Promise<void>) {
	const assets = gameAssets('game', null, { read });
	const index = await assets.read('index.html');
	if (!index) throw new Error('No game entry point');
	const paths = scriptPlan(new TextDecoder().decode(index));
	const language = await languageTable(assets);
	// Exercise the indexed-PNG correction used by the tested Switch runtime.
	const host = createBrowserHost(assets, prepareGameScript, report, true);
	for (const path of paths) { report(`Loading ${path}`); await host.loadScript(path); }
	await host.settled();
	installGameCompatibility(globalThis, 'game', false, language);
	const game = globalThis as any;
	const prefetch = new MapPrefetcher({ read(path) { report(`Map warm-up: ${path}`); return assets.read(path); } }, report);
	if (!installMapPrefetch(game, prefetch, report)) throw new Error('Map prefetch hook unavailable');
	const runFrame = async () => {
		await step();
		const manager = game.SceneManager;
		const idle = typeof game.Scene_Map === 'function' && manager?._scene instanceof game.Scene_Map &&
			manager._sceneStarted && !manager._nextScene && !manager._stopped && !!game.$dataMap && !game.$gamePlayer?.isTransferring?.();
		prefetch.tick(performance.now(), !!idle);
	};
	if (typeof (globalThis as any).onload !== 'function') throw new Error('Missing game onload');
	report('Startup scripts and plugins evaluated; game onload is available.');
	// MV normally catches boot errors internally; surface them to this test.
	(globalThis as any).SceneManager.catchException = (error: unknown) => { throw error; };
	(globalThis as any).onload(new Event('load'));
	for (let frame = 0; frame < 180; frame++) await runFrame();
	const manager = (globalThis as any).SceneManager;
	if (manager._stopped) throw new Error('Game stopped during boot');
	const missing = game.DataManager?._databaseFiles?.filter((file: any) => !game[file.name]).map((file: any) => file.name).join(',') || 'none';
	report(`After 180 simulated frames: ${manager._scene?.constructor?.name || 'no scene'}, missing=${missing}, databaseError=${game.DataManager?._errorUrl || 'none'}, imagesReady=${game.ImageManager?.isReady?.()}, font=${manager._scene?.isGameFontLoaded?.()} (fake rendering and audio).`);
	if (typeof manager._scene?.commandNewGame !== 'function') throw new Error('Did not reach the title menu');
	const title = manager._scene, creditsIndex = title._commandWindow?._list?.findIndex((item: any) => item.symbol === 'credits');
	if (creditsIndex >= 0) {
		if (title._commandWindow.isCommandEnabled(creditsIndex)) throw new Error('Credits command should be disabled');
		title._commandWindow.select(creditsIndex);
		title._commandWindow.processOk();
		if (manager._scene !== title || manager._nextScene) throw new Error('Credits selection left the title screen');
		title.commandCredits();
		if (!title._commandWindow.active) throw new Error('Credits handler did not reactivate the title menu');
		report('Credits selection remains safely on the actual title screen.');
	}
	manager._scene.commandNewGame();
	for (let frame = 0; frame < 240; frame++) await runFrame();
	if (manager._stopped) throw new Error('Game stopped starting a new game');
	if (manager._scene?.constructor?.name !== 'Scene_Map' || !manager._sceneStarted) {
		throw new Error(`New game has not started: scene=${manager._scene?.constructor?.name}, ready=${manager._sceneStarted}, mapLoaded=${manager._scene?._mapLoaded}, imageReady=${game.ImageManager?.isReady?.()}, mapError=${game.DataManager?._errorUrl}`);
	}
	report(`After starting a new game: ${manager._scene.constructor.name}, started=${manager._sceneStarted}, map=${game.$gameMap?.mapId?.() ?? 'unknown'} (fake rendering and audio).`);
	for (let frame = 0; frame < 900; frame++) await runFrame();
	if (manager._stopped) throw new Error('Game stopped during the opening sequence');
	if (!game.ImageManager.isReady()) throw new Error('Opening sequence still has unfinished required images');
	// The region plugin must retain its methods after removing the embedded
	// desktop payload. Exercise collision on the actual player, not just boot.
	if (typeof game.$gamePlayer?.getRegionId !== 'function' || typeof game.$gamePlayer?.isEventRegionAllow !== 'function') {
		throw new Error('Region collision plugin was only partially loaded');
	}
	game.$gamePlayer.setThrough(false);
	game.$gamePlayer.isPlayerRegionForbid(game.$gamePlayer.x, game.$gamePlayer.y, 2);
	game.$gamePlayer.isPlayerRegionAllow(game.$gamePlayer.x, game.$gamePlayer.y, 2);
	game.$gamePlayer.canPass(game.$gamePlayer.x, game.$gamePlayer.y, 2);
	report('Player movement collision check completed with the actual region plugin.');
	// Exercise the real game's serializer, index and load/save routines with a
	// simulated SD filesystem. No game or actual save files are touched.
	const files = new Map<string, string>();
	const fs = {
		readFileSync: (path: string) => files.has(path) ? new TextEncoder().encode(files.get(path)!).buffer : null,
		writeFileSync: (path: string, value: string | ArrayBuffer) => { files.set(path, typeof value === 'string' ? value : new TextDecoder().decode(value)); },
		removeSync: (path: string) => { files.delete(path); },
		statSync: (path: string) => files.has(path) ? { mode: 0o100000 } : null,
	};
	const saveIndex = [null, game.DataManager.makeSavefileInfo()];
	files.set('sdmc:/fake-game/save/global.rpgsave', game.LZString.compressToBase64(JSON.stringify(saveIndex)));
	files.set('sdmc:/fake-game/save/file1.rpgsave', game.LZString.compressToBase64(game.JsonEx.stringify(game.DataManager.makeSaveContents())));
	installSdSaves(game, fs, 'sdmc:/fake-saves');
	if (importSteamSaves(game, fs, 'sdmc:/fake-game/www', { kind: 'sd', folder: 'sdmc:/fake-saves' }) !== 1) throw new Error('Steam import did not copy the expected slot');
	if (!game.DataManager.loadGame(1)) throw new Error('Imported save could not be loaded by the game');
	if (!game.DataManager.saveGame(2)) throw new Error('Game could not save to the selected SD folder');
	if (!game.DataManager.loadGame(2)) throw new Error('Game could not reload its SD save');
	report('Actual game save imported, loaded, saved to simulated SD, and reloaded successfully.');
	report(`Opening sequence: scene=${manager._scene?.constructor?.name || 'none'}, map=${game.$gameMap?.mapId?.() ?? 'unknown'} (simulated frames).`);
}
