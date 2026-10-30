import { S } from './state';
import { log } from './log';
import { setLoadingProgress, resetLoading } from './loading-screen';
import { beginGameSession } from './game-session';
import { gameAssets } from './game-assets';
import type { Reader } from './library';
import { scriptPlan, startGame } from './runtime-plan';
import { createBrowserHost } from './browser-host';
import {
        installGameCompatibility, languageTable, prepareGameScript, registerFonts,
        scanLanguageFiles, parseLanguagePack, withLanguageImages, registerLanguageFont,
        type LanguagePack, type LanguageEntry, type LanguageScanFs,
} from './game-compat';
import { installNodeCompat, type SwitchFs } from './node-compat';
import { needsPngFix } from './indexed-png';
import { ensureGameSaveFolder, installSdSaves, importSteamSaves } from './saves';
import { installMapPrefetch, MapPrefetcher } from './map-prefetch';
import { markPlayed, type LibraryAccess } from './game-library';
import { pollStickBindings, clearButtonKeyState } from './stick-bindings';
import { isSaveLoadKeymapActive, installSaveLoadPopHook } from './save-load-keymap';
import { fail, failRequest } from './error-handling';
import { getGameLanguage, validSaveLocation } from './selection';
import { mergedKeymap } from './keymap-editor';
import { hud } from './render-overlay';
import { installSleepAutoload } from './sleep-recovery';

declare const __DEBUG__: boolean;

/** Async game launch pipeline: snapshot realm, load assets + scripts, install host/compat/hooks, start game. */
export async function launch() {
        S.phase = 'loading';
        S.gameStopped = false;
        S.exitBehavior = S.forwarderTargetId ? 'shutdown' : 'restart';
        log(`_exit: game launch (${S.forwarderTargetId ? 'forwarder' : 'library'}) — exit behavior: ${S.exitBehavior}`);
        resetLoading(S.currentEntry?.name || 'BurialNX', 'Preparing game…');
        try {
                beginGameSession();
                if (!S.selectedGame) throw new Error('No game selected');
                setLoadingProgress(0.04, 'Reading game index…', S.selectedGame);
                const rawAssets = gameAssets(S.selectedGame, S.selectedMod || null, { async read(path) {
                        const bytes = await (Switch as any).readFile(path);
                        if (__DEBUG__ && bytes && /\/data\//i.test(path)) log(`Read game data: ${path} (${bytes.byteLength} bytes)`);
                        return bytes;
                } });
                const assets = { async read(path: string) {
                        const result = await rawAssets.read(path);
                        if (result === null) log(`Asset missing: ${path}`);
                        return result;
                } };
                const index = await assets.read('index.html');
                if (!index) throw new Error('Game index.html is missing');
                const scripts = scriptPlan(new TextDecoder().decode(index));
                log(`Game: ${S.selectedGame}; mod: ${S.selectedMod || 'none'}; shared saves: ${S.sharedSaves}`);
                setLoadingProgress(0.12, 'Loading fonts and language…');
                const [, , pngFix] = await Promise.all([languageTable(assets), registerFonts(assets, S.runtime), needsPngFix(log)]);
                let language = await languageTable(assets);
                let languagePack: LanguagePack | null = null;
                let imageReader: Reader = assets;
                S.activeLanguageCode = '';
                S.languageEntries = [];
                try {
                        const scanFs = (Switch as unknown as LanguageScanFs) ?? null;
                        S.languageEntries = scanLanguageFiles(scanFs, S.selectedGame);
                        if (S.languageEntries.length > 0) {
                                const savedRaw = getGameLanguage(S.selectedGame);
                                let chosen: LanguageEntry | null = null;
                                if (savedRaw === undefined) chosen = S.languageEntries[0];
                                else if (savedRaw !== '') chosen = S.languageEntries.find((e) => e.code === savedRaw) ?? null;
                                if (chosen) {
                                        log(`Languages: ${S.languageEntries.map((e) => e.code).join(', ')}; loading ${chosen.code}`);
                                        let cldBytes: ArrayBuffer | null = null;
                                        if (chosen.path) cldBytes = await assets.read(chosen.path);
                                        else try { cldBytes = await (Switch as any).readFile(chosen.absPath); } catch { /* unreadable */ }
                                        if (cldBytes) {
                                                languagePack = parseLanguagePack(cldBytes, chosen.path || chosen.absPath);
                                                S.activeLanguageCode = chosen.code;
                                                language = languagePack.table;
                                                if (languagePack.langName) chosen.name = languagePack.langName;
                                                try { imageReader = withLanguageImages(assets, languagePack); } catch { imageReader = assets; }
                                        }
                                } else if (savedRaw === '') {
                                        log(`Languages: ${S.languageEntries.map((e) => e.code).join(', ')}; using English (user preference)`);
                                }
                        }
                } catch (langError) {
                        log(`Language .cld loading failed (using English): ${langError instanceof Error ? langError.message : String(langError)}`);
                        languagePack = null;
                        S.activeLanguageCode = '';
                        imageReader = assets;
                }
                setLoadingProgress(0.20, 'Preparing runtime host…');
                S.host = createBrowserHost(imageReader, prepareGameScript, log, pngFix, S.directScreen, failRequest);
                try { installNodeCompat(S.runtime, (Switch as unknown as SwitchFs) ?? null, { gameRoot: S.selectedGame, log: __DEBUG__ ? log : undefined }); }
                catch (compatError) { log(`node-compat install failed: ${compatError instanceof Error ? compatError.message : String(compatError)}`); }
                const total = scripts.length;
                for (let i = 0; i < total; i++) {
                        const path = scripts[i];
                        log(`Loading ${path}`);
                        setLoadingProgress(0.20 + 0.70 * (i + 1) / total, `Loading scripts ${i + 1}/${total}…`, path);
                        await S.host.loadScript(path);
                }
                setLoadingProgress(0.92, 'Settling runtime…');
                await S.host.settled();
                setLoadingProgress(0.95, 'Installing compatibility…');
                installGameCompatibility(S.runtime, S.selectedGame, S.sharedSaves, language, pngFix, mergedKeymap());
                if (languagePack) {
                        try { await registerLanguageFont(S.runtime, languagePack); }
                        catch (fontError) { log(`Language font install failed: ${fontError instanceof Error ? fontError.message : String(fontError)}`); }
                }
                if (S.runtime.Input?._updateGamepadState && !(S.runtime.Input as any).__bnxStickWrap) {
                        const originalUpdateGamepad = S.runtime.Input._updateGamepadState;
                        (S.runtime.Input as any).__bnxStickWrap = true;
                        S.runtime.Input._updateGamepadState = function() {
                                originalUpdateGamepad.apply(this, arguments);
                                if (isSaveLoadKeymapActive()) return;
                                try { pollStickBindings(S.currentEntry, S.globalKeymap); } catch { /* best-effort */ }
                        };
                }
                S.mapPrefetch = new MapPrefetcher(assets, log);
                installMapPrefetch(S.runtime, S.mapPrefetch, log);
                if (!S.saveLocation) throw new Error('No save location selected');
                if (S.saveLocation.kind === 'sd' || S.saveLocation.kind === 'game') {
                        if (!validSaveLocation(S.saveLocation, S.selectedGame, S.selectedMod || null)) throw new Error('Invalid save folder');
                        if (S.saveLocation.kind === 'game') ensureGameSaveFolder(Switch as any, S.saveLocation.folder, S.selectedGame, S.selectedMod || null);
                        installSdSaves(S.runtime, Switch as any, S.saveLocation.folder);
                }
                if (S.importRequested) { const count = importSteamSaves(S.runtime, Switch as any, S.selectedGame, S.saveLocation); log(`Imported ${count} Steam save slots`); }
                setLoadingProgress(0.98, 'Starting game…');
                if (S.runtime.Graphics?.render) {
                        const render = S.runtime.Graphics.render;
                        S.runtime.Graphics.render = function() { const result = render.apply(this, arguments); hud(); return result; };
                }
                if (S.runtime.Graphics?._createRenderer) {
                        const create = S.runtime.Graphics._createRenderer;
                        S.runtime.Graphics._createRenderer = function() {
                                const result = create.apply(this, arguments);
                                const renderer = this._renderer, pixi = S.runtime.PIXI;
                                const saturation = pixi?.BLEND_MODES?.SATURATION;
                                if (renderer?.type === pixi?.RENDERER_TYPE?.CANVAS && renderer.blendModes?.[saturation] === 'saturate') renderer.blendModes[saturation] = 'saturation';
                                this._maxSkip = S.host?.direct() ? 0 : 1;
                                return result;
                        };
                }
                if (S.runtime.SceneManager?.updateMain) {
                        installSaveLoadPopHook();
                        const update = S.runtime.SceneManager.updateMain;
                        S.runtime.SceneManager.updateMain = function() {
                                if (S.gameStopped || (S.phase === 'notice' && S.exitNoticeArmed)) { this.requestUpdate(); return; }
                                if (S.menu.blocksInput) {
                                        this._accumulator = 0;
                                        if (this._getTimeInMsWithoutMobileSafari) this._currentTime = this._getTimeInMsWithoutMobileSafari();
                                        S.runtime.Input?.clear?.(); this.requestUpdate(); return;
                                }
                                return update.apply(this, arguments);
                        };
                        const catchException = S.runtime.SceneManager.catchException;
                        S.runtime.SceneManager.catchException = function(error: unknown) {
                                fail(error);
                                return catchException.call(this, error);
                        };
                }
                S.phase = 'game';
                const startup = startGame(S.runtime);
                log(`Game started: ${startup}`);
                if (S.sleepAutoloadPending) {
                        try { installSleepAutoload(); }
                        catch (error) { log(`_sleep: installSleepAutoload threw: ${error instanceof Error ? error.message : String(error)}`); }
                }
                if (S.currentEntry) {
                        try { S.library = markPlayed((Switch as any) as unknown as LibraryAccess, S.library, S.currentEntry.id); } catch { /* non-fatal */ }
                }
        } catch (error) { fail(error); }
}
