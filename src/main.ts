import { FolderBrowser } from './folders';
import { gameAssets } from './game-assets';
import { scriptPlan } from './runtime-plan';
import { createBrowserHost } from './browser-host';
import { installGameCompatibility, languageTable, prepareGameScript, registerFonts } from './game-compat';
import { PauseMenu } from './menu';
import { parseSelection, startupSelection, type GameSelection, type SaveLocation } from './settings';
import { needsPngFix } from './indexed-png';
import { importSteamSaves, installSdSaves, safeSaveFolder } from './saves';

declare const __DEBUG__: boolean;
const ctx = screen.getContext('2d')!;
const menu = new PauseMenu(__DEBUG__);
const debugLines: string[] = [];
let browser = new FolderBrowser(Switch, 'game');
let selectedGame: string | undefined;
let selectedMod: string | null | undefined;
let sharedSaves = false;
let waitForRelease = false;
let phase: 'picker' | 'notice' | 'save-choice' | 'import-confirm' | 'loading' | 'game' | 'error' = 'picker';
let pickerPurpose: 'game' | 'startup-mod' | 'menu-mod' | 'startup-saves' | 'menu-saves' = 'game';
let saveLocation: SaveLocation | undefined;
let choiceFromMenu = false, importRequested = false;
let message = '';
let host: ReturnType<typeof createBrowserHost> | undefined;
let frames = 0, sampleStart = 0, fps = 0;
let lastFrame = 0, lastMemoryCheck = 0;
let fit = true;
const runtime = globalThis as any;
const settingsPath = 'sdmc:/switch/burialnx/settings.json';
const logsPath = 'sdmc:/switch/tcoaal/LOGS';
const hostLogPath = `${logsPath}/native-host.log`;
// Keep all loader-created files outside the selected game directory.
try { (Switch as any).mkdirSync?.('sdmc:/switch/burialnx'); } catch { /* report write failures later */ }
if (__DEBUG__) try { (Switch as any).mkdirSync?.(logsPath); } catch { /* diagnostics are optional */ }
let saved: GameSelection | null = null;
let settingsValid = true;
let previousButtons: boolean[] = [];
const debugSettingsPath = 'sdmc:/switch/burialnx/debug-settings.json';
let directScreen = true, directNext = true, debugSettingsValid = true;
if (__DEBUG__) try {
	const raw = Switch.readFileSync(debugSettingsPath);
	if (raw) {
		const value = JSON.parse(new TextDecoder().decode(raw));
		if (typeof value?.directScreen !== 'boolean') throw new Error('Invalid debug settings');
		directScreen = directNext = value.directScreen;
	}
} catch { debugSettingsValid = false; }
try {
	const data = Switch.readFileSync(settingsPath);
	if (data) {
		saved = parseSelection(new TextDecoder().decode(data));
		const selected = startupSelection(Switch, saved, __DEBUG__);
		if (selected) {
			selectedGame = selected.root;
			sharedSaves = selected.sharedSaves;
			selectedMod = selected.mod || null;
			saveLocation = selected.saves;
			if (saveLocation?.kind === 'sd' && (!safeSaveFolder(saveLocation.folder, selected.root, selected.mod || null) || (Switch.statSync(saveLocation.folder)?.mode! & 0o170000) !== 0o040000)) saveLocation = undefined;
			phase = saveLocation ? 'loading' : 'save-choice';
		}
	}
} catch { settingsValid = false; }
function remember(selection: GameSelection) {
	if (!settingsValid) return false;
	try { Switch.writeFileSync(settingsPath, JSON.stringify(selection, null, 2)); saved = selection; return true; }
	catch (error) { log(`Could not save selection: ${String(error)}`); return false; }
}
function currentSelection(saves = saveLocation): GameSelection {
	if (!selectedGame) throw new Error('No game selected');
	return { root: selectedGame, sharedSaves, mod: selectedMod || null, ...(saves ? { saves } : {}) };
}
function startOrChooseSaves() {
	if (saveLocation) void launch();
	else { choiceFromMenu = false; waitForRelease = true; phase = 'save-choice'; }
}
function chooseSaves(location: SaveLocation) {
	if (!selectedGame) return;
	if (location.kind === 'sd' && !safeSaveFolder(location.folder, selectedGame, selectedMod || null)) {
		browser.message = 'Choose a folder outside the game and mod folders.'; return;
	}
	const pendingMod = choiceFromMenu && saved?.root === selectedGame ? saved.mod || null : selectedMod || null;
	if (location.kind === 'sd' && !safeSaveFolder(location.folder, selectedGame, pendingMod)) { browser.message = 'Save folder overlaps the selected mod.'; return; }
	if (!remember({ ...currentSelection(location), mod: pendingMod })) { message = 'Could not save settings; storage unchanged.'; waitForRelease = true; phase = 'notice'; return; }
	if (choiceFromMenu) {
		message = 'Save location saved. Restart the loader to apply it.'; phase = 'notice';
	} else {
		saveLocation = location; phase = 'import-confirm';
	}
	waitForRelease = true;
}

// nx.js's regular console can draw over the game. Debug messages go to the
// runtime's file logger instead; the release build suppresses routine output.
for (const level of ['debug', 'log', 'info', 'warn', 'error', 'trace'] as const) {
	console[level] = (...values: unknown[]) => { if (__DEBUG__) log(`[${level}] ${values.map(String).join(' ')}`); };
}
function log(line: string) {
	if (!__DEBUG__) return;
	debugLines.push(line);
	if (debugLines.length > 6) debugLines.shift();
	try { Switch.appendFileSync(hostLogPath, `${line}\n`); } catch { /* optional diagnostics */ }
}
// nx.js writes its own log to a fixed path. Copy a snapshot instead of moving
// or truncating that file, which the runtime may still have open.
function snapshotRuntimeLog() {
	if (!__DEBUG__) return;
	try {
		const bytes = Switch.readFileSync('sdmc:/switch/nxjs-debug.log');
		if (bytes) Switch.writeFileSync(`${logsPath}/nxjs-debug-${Date.now()}.log`, bytes);
	} catch { /* native log may not exist */ }
}
function panel(lines: string[], full = false) {
	ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
	ctx.fillStyle = '#161823'; ctx.fillRect(0, 0, screen.width, full ? screen.height : Math.min(screen.height, 30 + 30 * lines.length));
	ctx.fillStyle = '#f4f3ef'; ctx.font = '22px sans-serif';
	lines.forEach((line, index) => ctx.fillText(line, 28, 34 + index * 30, screen.width - 56));
	ctx.restore();
}
function hud() {
	if (phase !== 'game') return;
	if (menu.open) {
		const labels: Record<string, string> = { continue: 'Resume', load: 'Load existing save', saves: 'Choose save location (restart)', import: 'Import Steam saves to current location', resolution: `Display: ${fit ? 'fit' : 'native size'}`, fps: `FPS: ${menu.fps ? 'on' : 'off'}`, mod: 'Select mod for next launch', direct: `Direct screen next start: ${directNext ? 'on' : 'off'}`, snapshot: 'Write diagnostic snapshot' };
		panel(['BurialNX  |  Up/Down: select  A: choose  B: close', `${fps.toFixed(1)} FPS`, ...menu.items.map((item, i) => `${i === menu.selected ? '> ' : '  '}${labels[item]}`)]);
	} else if (menu.fps) panel([`${fps.toFixed(1)} FPS`]);
}
function fail(error: unknown) {
	const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
	log(`FAILURE: ${detail}`);
	snapshotRuntimeLog();
	message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	phase = 'error';
}
async function launch() {
	phase = 'loading';
	try {
		if (!selectedGame) throw new Error('No game selected');
		const rawAssets = gameAssets(selectedGame, selectedMod || null, { read: (path) => Switch.readFile(path) });
		const assets = { async read(path: string) {
			const result = await rawAssets.read(path);
			if (result === null) log(`Asset missing: ${path}`);
			return result;
		} };
		const index = await assets.read('index.html');
		if (!index) throw new Error('Game index.html is missing');
		const scripts = scriptPlan(new TextDecoder().decode(index));
		log(`Game: ${selectedGame}; mod: ${selectedMod || 'none'}; shared saves: ${sharedSaves}`);
		const [language, , pngFix] = await Promise.all([languageTable(assets), registerFonts(assets, runtime), needsPngFix(log)]);
		host = createBrowserHost(assets, prepareGameScript, log, pngFix, directScreen);
		for (const path of scripts) { log(`Loading ${path}`); await host.loadScript(path); }
		await host.settled();
		installGameCompatibility(runtime, selectedGame, sharedSaves, language, pngFix);
		if (!saveLocation) throw new Error('No save location selected');
		if (saveLocation.kind === 'sd') {
			if (!safeSaveFolder(saveLocation.folder, selectedGame, selectedMod || null)) throw new Error('Save folder overlaps game or mod folder');
			installSdSaves(runtime, Switch, saveLocation.folder);
		}
		if (importRequested) { const count = importSteamSaves(runtime, Switch, selectedGame, saveLocation); log(`Imported ${count} Steam save slots`); }
		if (runtime.Graphics?.render) {
			const render = runtime.Graphics.render;
			runtime.Graphics.render = function(...args: unknown[]) { const result = render.apply(this, args); hud(); return result; };
		}
		if (runtime.Graphics?._createRenderer) {
			const create = runtime.Graphics._createRenderer;
			runtime.Graphics._createRenderer = function() {
				const result = create.apply(this, arguments);
				const renderer = this._renderer, pixi = runtime.PIXI;
				const saturation = pixi?.BLEND_MODES?.SATURATION;
				if (renderer?.type === pixi?.RENDERER_TYPE?.CANVAS && renderer.blendModes?.[saturation] === 'saturate') renderer.blendModes[saturation] = 'saturation';
				this._maxSkip = host?.direct() ? 0 : 1;
				return result;
			};
		}
		if (runtime.SceneManager?.updateMain) {
			const update = runtime.SceneManager.updateMain;
			runtime.SceneManager.updateMain = function() {
				const now = performance.now();
				if (lastFrame && now - lastFrame > 2000) {
					this._accumulator = 0;
					if (this._getTimeInMsWithoutMobileSafari) this._currentTime = this._getTimeInMsWithoutMobileSafari();
					runtime.Input?.clear?.(); runtime.TouchInput?.clear?.();
				}
				lastFrame = now;
				if (menu.blocksInput) {
					this._accumulator = 0;
					if (this._getTimeInMsWithoutMobileSafari) this._currentTime = this._getTimeInMsWithoutMobileSafari();
					runtime.Input?.clear?.(); this.requestUpdate(); return;
				}
				return update.apply(this, arguments);
			};
			const catchException = runtime.SceneManager.catchException;
			runtime.SceneManager.catchException = function(error: unknown) {
				fail(error);
				return catchException.call(this, error);
			};
		}
		if (typeof runtime.onload !== 'function') throw new Error('Game did not provide window.onload');
		phase = 'game';
		runtime.onload.call(runtime, new Event('load'));
		log('Game started');
	} catch (error) { fail(error); }
}
globalThis.addEventListener('error', ((event: ErrorEvent) => fail(event.error || event.message)) as EventListener);
globalThis.addEventListener('unhandledrejection', ((event: PromiseRejectionEvent) => fail(event.reason)) as EventListener);

let observedScene: any, sceneSince = 0, lastSceneReport = 0, snapshotScene: any;
function diagnoseScene(now: number) {
	if (!__DEBUG__) return;
	const manager = runtime.SceneManager, scene = manager?._scene;
	if (scene !== observedScene) {
		observedScene = scene; sceneSince = lastSceneReport = now;
		log(`Scene: ${scene?.constructor?.name || 'none'}`);
	}
	if (!scene || now - lastSceneReport < 8000) return;
	lastSceneReport = now;
	if (scene !== snapshotScene) { snapshotScene = scene; snapshotRuntimeLog(); }
	const waiting: string[] = [];
	const items = runtime.ImageManager?._imageCache?._items || {};
	for (const key in items) {
		const bitmap = items[key]?.bitmap;
		if (bitmap && !bitmap.isRequestOnly?.() && !bitmap.isReady?.()) {
			const image = bitmap._image;
			waiting.push(`${key}:${bitmap._loadingState || '?'}:complete=${!!image?.complete}:size=${image?.naturalWidth || 0}x${image?.naturalHeight || 0}:src=${image?.src || '?'}`);
		}
		if (waiting.length === 6) break;
	}
	log(`Scene status: ${scene.constructor?.name}, started=${!!manager._sceneStarted}, seconds=${Math.round((now - sceneSince) / 1000)}, fps=${fps.toFixed(1)}, map=${runtime.$gameMap?.mapId?.() ?? '?'}, mapData=${!!runtime.$dataMap}, error=${runtime.DataManager?._errorUrl || 'none'}, images=${waiting.join(',') || 'none'}`);
}

function frame(now: number) {
	try {
		const buttons = navigator.getGamepads?.()?.[0]?.buttons || null;
		if (phase === 'picker') {
			if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
			else if (!waitForRelease) {
				const result = browser.step(buttons);
				if (result !== undefined) {
					if (pickerPurpose === 'game' && result !== null) {
						selectedGame = result; sharedSaves = browser.sharedSaves;
						const previousMod = saved?.root === result ? saved.mod || null : null;
						selectedMod = previousMod;
						saveLocation = saved?.root === result ? saved.saves : undefined;
						if (saveLocation?.kind === 'sd' && (!safeSaveFolder(saveLocation.folder, result, previousMod) || (Switch.statSync(saveLocation.folder)?.mode! & 0o170000) !== 0o040000)) saveLocation = undefined;
						remember(currentSelection());
						if (__DEBUG__) { browser = new FolderBrowser(Switch, 'mod'); pickerPurpose = 'startup-mod'; waitForRelease = true; }
						else startOrChooseSaves();
					} else if (pickerPurpose === 'startup-mod') { selectedMod = result; if (saveLocation?.kind === 'sd' && !safeSaveFolder(saveLocation.folder, selectedGame!, selectedMod)) saveLocation = undefined; startOrChooseSaves(); }
					else if (pickerPurpose === 'menu-mod' && selectedGame) {
						const pendingSaves = saved?.root === selectedGame ? saved.saves : saveLocation;
						if (result && pendingSaves?.kind === 'sd' && !safeSaveFolder(pendingSaves.folder, selectedGame, result)) { browser.message = 'Mod folder contains the save folder.'; }
						else {
						const ok = remember({ ...currentSelection(pendingSaves), mod: result });
						message = ok ? 'Mod saved. Restart the loader to apply it.' : 'Could not save mod selection; settings unchanged.';
						waitForRelease = true; phase = 'notice'; }
					} else if ((pickerPurpose === 'startup-saves' || pickerPurpose === 'menu-saves') && result !== null) {
						chooseSaves({ kind: 'sd', folder: result });
					} else if ((pickerPurpose === 'startup-saves' || pickerPurpose === 'menu-saves') && result === null) {
						waitForRelease = true; phase = 'save-choice';
					}
				}
			}
			const first = Math.max(0, Math.min(browser.selected - 7, browser.entries.length - 12));
			panel([`BurialNX — select ${browser.mode} folder`, `${browser.path}/`,
				'Up/Down: highlight  A: open  B: parent  X: select', browser.mode === 'game' ? 'Y: select with old shared saves' : browser.mode === 'mod' ? 'Y: no mod' : 'B at SD root: cancel; choose a folder outside the game.', browser.message,
				...browser.entries.slice(first, first + 12).map((name, index) => `${first + index === browser.selected ? '> ' : '  '}${name}/`)], true);
		} else if (phase === 'save-choice') {
			panel(['BurialNX — save location', 'A: Switch user save data', 'X: choose an SD-card folder', ...(choiceFromMenu ? ['B: cancel'] : ['Select where new saves will be stored.'])], true);
			if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
			else if (!waitForRelease && buttons?.[1]?.pressed && !previousButtons[1]) chooseSaves({ kind: 'switch' });
			else if (!waitForRelease && buttons?.[3]?.pressed && !previousButtons[3]) { browser = new FolderBrowser(Switch, 'saves'); pickerPurpose = choiceFromMenu ? 'menu-saves' : 'startup-saves'; waitForRelease = true; phase = 'picker'; }
			else if (!waitForRelease && choiceFromMenu && buttons?.[0]?.pressed && !previousButtons[0]) { menu.dismiss(); phase = 'game'; }
		} else if (phase === 'import-confirm') {
			panel(['BurialNX — Steam saves', `Current destination: ${saveLocation?.kind === 'sd' ? saveLocation.folder : 'Switch user save data'}`, 'A: import game-folder Steam saves into this empty location', 'B: skip', 'Existing saves are never overwritten.'], true);
			if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
			else if (!waitForRelease && ((buttons?.[1]?.pressed && !previousButtons[1]) || (buttons?.[0]?.pressed && !previousButtons[0]))) {
				const wantsImport = !!buttons?.[1]?.pressed;
				if (choiceFromMenu) {
					try { message = wantsImport ? `Imported ${importSteamSaves(runtime, Switch, selectedGame!, saveLocation!)} Steam save slots.` : 'Import cancelled.'; }
					catch (error) { message = `Import failed: ${String(error)}`; }
					waitForRelease = true; phase = 'notice';
				} else { importRequested = wantsImport; void launch(); }
			}
		} else if (phase === 'notice') {
			panel(['BurialNX', message, 'B: return to game'], true);
			if (waitForRelease && !Array.from(buttons || []).some((button) => button.pressed)) waitForRelease = false;
			else if (!waitForRelease && buttons?.[0]?.pressed && !previousButtons[0]) { if (host) { menu.dismiss(); phase = 'game'; } else { phase = 'save-choice'; choiceFromMenu = false; waitForRelease = true; } }
		} else if (phase === 'loading') panel(['BurialNX', 'Opening game…', ...(__DEBUG__ ? debugLines : [])], true);
		else if (phase === 'error') panel(['BurialNX — game could not start', message, __DEBUG__ ? `Details: ${hostLogPath}` : 'Try the debug build for details.'], true);
		else {
			diagnoseScene(now);
			// Native image/canvas allocations live outside V8's normal heap count.
			// Collect only under pressure, not once per frame.
			if (now - lastMemoryCheck >= 5000) {
				lastMemoryCheck = now;
				try {
					const memory = (Switch as any).memoryUsage?.();
					if (memory?.nativeHeapUsed > 1024 * 1024 * 1024 && typeof runtime.gc === 'function') runtime.gc();
				} catch { /* memory diagnostics are optional */ }
			}
			if (!sampleStart) sampleStart = now;
			frames++; if (now - sampleStart >= 1000) { fps = frames * 1000 / (now - sampleStart); sampleStart = now; frames = 0; }
			const action = menu.step(buttons, now);
			if (action === 'load' && runtime.SceneManager && runtime.Scene_Load) runtime.SceneManager.push(runtime.Scene_Load);
			if (action === 'resolution' && host) fit = host.toggleFit();
			if (action === 'mod') { browser = new FolderBrowser(Switch, 'mod'); pickerPurpose = 'menu-mod'; waitForRelease = true; phase = 'picker'; }
			if (action === 'saves') { choiceFromMenu = true; waitForRelease = true; phase = 'save-choice'; }
			if (action === 'import') { choiceFromMenu = true; waitForRelease = true; phase = 'import-confirm'; }
			if (action === 'direct' && debugSettingsValid) {
				try { const value = !directNext; Switch.writeFileSync(debugSettingsPath, JSON.stringify({ directScreen: value })); directNext = value; log('Direct-screen setting saved; restart required.'); }
				catch (error) { log(`Could not save direct-screen setting: ${String(error)}`); }
			}
			if (action === 'snapshot') { log(`Snapshot: scene=${runtime.SceneManager?._scene?.constructor?.name || 'unknown'}, fps=${fps.toFixed(1)}`); snapshotRuntimeLog(); }
			host?.present();
			// An offscreen game frame covers the display when presented, so draw
			// the overlay afterwards. Direct rendering draws it in Graphics.render.
			if (menu.blocksInput || !host?.direct()) hud();
		}
		previousButtons = Array.from({ length: 16 }, (_, index) => !!buttons?.[index]?.pressed);
	} catch (error) { fail(error); }
	requestAnimationFrame(frame);
}
if (__DEBUG__) log(`--- BurialNX debug session ${new Date().toISOString()} ---`);
if (phase === 'loading') void launch();
requestAnimationFrame(frame);
