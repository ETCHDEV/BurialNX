// === Game launch =====================================================
// Extracted from main.ts. The async launch() pipeline: snapshot the
// realm, read game assets + scripts, install the browser host + Node
// compat + game compatibility, install the Input._updateGamepadState
// wrapper that drives pollStickBindings, install the save-location
// storage, optionally import Steam saves, install the Graphics.render
// + SceneManager.updateMain wrappers, and start the game's own scenes.
//
// Reads/writes the shared `S` state extensively (host, mapPrefetch,
// languageEntries, activeLanguageCode, phase, exitBehavior, gameStopped,
// library, etc.). The wrappers installed here close over `S` and read
// gameStopped / phase / exitNoticeArmed / lastFrame / menu / fail at
// call time — they're the reason main.ts still owns those state fields
// even though launch() lives in this module.

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

declare const __DEBUG__: boolean;

export async function launch() {
        S.phase = 'loading';
        S.gameStopped = false; // reset for new game launch
        // Arm this session's exit behavior (see the exitBehavior lifecycle):
        // a game launched FROM THE LIBRARY returns to the library on exit
        // ('restart' — quitApp chain-loads burialnx and the grid shows in a
        // fresh process); a game launched via a FORWARDER (baked-in or legacy
        // argv — forwarderTargetId is set at boot for those) fully closes
        // BurialNX on exit ('shutdown'). Set at the point of no return, so a
        // canceled save-choice or options screen never arms the restart
        // without a game actually loading. Every app load boots with
        // 'shutdown' and only this line can change it.
        S.exitBehavior = S.forwarderTargetId ? 'shutdown' : 'restart';
        log(`_exit: game launch (${S.forwarderTargetId ? 'forwarder' : 'library'}) — exit behavior: ${S.exitBehavior}`);
        // Reset the progress bar for a fresh launch. The title is the game's
        // display name when known (so the bar shows "The Coffin of Andy and
        // Leyley" instead of just "BurialNX"), falling back to the loader name.
        resetLoading(S.currentEntry?.name || 'BurialNX', 'Preparing game…');
        try {
                // Snapshot the global scope before anything game-related is installed:
                // every global the game, its fonts, its timers or its host add on top
                // of this point is undone by teardownGame() when the user quits the
                // app, so no game data survives into the next cold boot.
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
                // Load the language table. Start with the DEFAULT English data
                // (always works — it's embedded in data/), then try to UPGRADE
                // to a .cld pack (Russian) if one exists. ALL .cld operations
                // are wrapped in try/catch so they NEVER crash the launch —
                // if anything fails, the game falls back to English. This is
                // critical for forwarder NROs which have saveData=0 (no
                // localStorage) and may have different runtime constraints.
                //
                // CRITICAL: the .cld file is ~25 MB. It is read and parsed ONLY
                // ONCE (for the chosen language). resolveLanguageName is NOT
                // called separately (it would read+parse the same 25 MB file a
                // second time, causing an OOM crash on the first forwarder
                // launch). Instead, the display name is taken from the parsed
                // pack's langName field.
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
                                // Use the .cld code as the display name for now (e.g. 'ru').
                                // The real name (e.g. 'Русский') is resolved from the parsed
                                // pack below — NO separate file read needed.
                                // Pick the language: saved preference > first .cld (Russian).
                                const savedRaw = getGameLanguage(S.selectedGame);
                                let chosen: LanguageEntry | null = null;
                                if (savedRaw === undefined) chosen = S.languageEntries[0];
                                else if (savedRaw !== '') chosen = S.languageEntries.find((e) => e.code === savedRaw) ?? null;
                                // savedRaw === '' → explicit English: chosen stays null.
                                if (chosen) {
                                        log(`Languages: ${S.languageEntries.map((e) => e.code).join(', ')}; loading ${chosen.code}`);
                                        // Read the .cld file ONCE (not twice — resolveLanguageName
                                        // is skipped to avoid an OOM crash on the first launch).
                                        let cldBytes: ArrayBuffer | null = null;
                                        if (chosen.path) cldBytes = await assets.read(chosen.path);
                                        else try { cldBytes = await (Switch as any).readFile(chosen.absPath); } catch { /* unreadable */ }
                                        if (cldBytes) {
                                                languagePack = parseLanguagePack(cldBytes, chosen.path || chosen.absPath);
                                                S.activeLanguageCode = chosen.code;
                                                language = languagePack.table;
                                                // Update the chosen entry's display name from the
                                                // parsed pack (free — no extra file read).
                                                if (languagePack.langName) chosen.name = languagePack.langName;
                                                // Wrap assets with translated images (best-effort).
                                                try { imageReader = withLanguageImages(assets, languagePack); } catch { imageReader = assets; }
                                        }
                                } else if (savedRaw === '') {
                                        log(`Languages: ${S.languageEntries.map((e) => e.code).join(', ')}; using English (user preference)`);
                                }
                        }
                } catch (langError) {
                        // Language scanning/loading failed — fall back to English.
                        // The `language` variable still holds the English table.
                        log(`Language .cld loading failed (using English): ${langError instanceof Error ? langError.message : String(langError)}`);
                        languagePack = null;
                        S.activeLanguageCode = '';
                        imageReader = assets;
                }
                setLoadingProgress(0.20, 'Preparing runtime host…');
                S.host = createBrowserHost(imageReader, prepareGameScript, log, pngFix, S.directScreen, failRequest);
                // Install Node.js / NW.js compatibility globals (require, process,
                // Buffer, module, exports, global, __dirname, __filename, nw) BEFORE
                // any game script loads. RPG Maker MV games packaged for NW.js call
                // these the moment a plugin or a patched title window runs — without
                // them the launch dies with `ReferenceError: require is not defined`.
                // `require('fs')` is wired to nx.js's synchronous SD-card I/O via
                // the `Switch` global, with a per-game writable overlay so the game's
                // own files stay pristine. This runs after beginGameSession(), so the
                // installed globals are tracked and cleaned up by teardownGame().
                try { installNodeCompat(S.runtime, (Switch as unknown as SwitchFs) ?? null, { gameRoot: S.selectedGame, log: __DEBUG__ ? log : undefined }); }
                catch (compatError) { log(`node-compat install failed: ${compatError instanceof Error ? compatError.message : String(compatError)}`); }
                // Script loading dominates the launch time for RPG Maker MV
                // games (often 40+ scripts, several hundred KiB each). Reserve
                // the 0.20..0.90 range for it and update per-script.
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
                // Register the language pack's embedded font (e.g. bitter-pro-regular
                // from ru.cld) and override Window_Base/Yanfly/Graphics font selection
                // so the game draws text in the localized font instead of GameFont.
                // Must run AFTER scripts load (so Window_Base, Yanfly, Graphics exist)
                // and AFTER installGameCompatibility (which may reference the font hooks).
                if (languagePack) {
                        try { await registerLanguageFont(S.runtime, languagePack); }
                        catch (fontError) { log(`Language font install failed: ${fontError instanceof Error ? fontError.message : String(fontError)}`); }
                }
                // Wrap Input._updateGamepadState so pollStickBindings runs
                // AFTER it — this is the CRITICAL timing fix for vkey stick
                // bindings (keyCode 0 → vkey name like 'ok', 'cancel').
                //
                // MV's Input.update calls _updateGamepadState() FIRST, which
                // reads face buttons + left-stick axes and sets
                // _currentState[vkeyName] via edge detection (true on press,
                // false on release). THEN it iterates _currentState to detect
                // triggered/held/released for the frame.
                //
                // If pollStickBindings ran BEFORE _updateGamepadState (as it
                // did when called from the frame loop), a stick-driven vkey
                // (e.g. R↓→ok → _currentState['ok'] = true) would be
                // OVERRIDDEN by _updateGamepadState setting
                // _currentState['ok'] = false (button A not pressed → release
                // edge). The stick binding would be silently dropped.
                //
                // By wrapping _updateGamepadState to call pollStickBindings
                // AFTER the original, our stick bindings are the FINAL write
                // to _currentState before Input.update's iteration — so
                // _updateGamepadState's edge-detected false can't clobber
                // our true. Combined with the vkey fix (keyCode 0 → label as
                // string key), this makes right-stick→vkey bindings actually
                // fire in-game.
                if (S.runtime.Input?._updateGamepadState && !(S.runtime.Input as any).__bnxStickWrap) {
                        const originalUpdateGamepad = S.runtime.Input._updateGamepadState;
                        (S.runtime.Input as any).__bnxStickWrap = true;
                        S.runtime.Input._updateGamepadState = function() {
                                originalUpdateGamepad.apply(this, arguments);
                                // SKIP stick-keyCode injection while the save/load scene is
                                // active — see save-load-keymap.ts for the full rationale.
                                // The short version: a stick direction bound to a keyCode
                                // (e.g. L-stick down → 'S') would fire _onKeyDown every
                                // frame during Scene_Save, leaving stale _currentState
                                // that Scene_Map reads as held after the menu closes (the
                                // "B in save menu → game fast-forwards" bug, but for sticks).
                                // overrideKeymapForSaveLoadScene() also clears state on
                                // enter/exit as a belt-and-braces guard.
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
                        // Install the SceneManager.pop hook ONCE, before the game's
                        // updateMain runs. The pop hook clears the save/load override
                        // (gamepadMapper + vkey state) AT THE MOMENT Scene_Save/Load
                        // pops — synchronously, before the resumed scene's update runs
                        // in the same updateMain call. This closes the one-frame timing
                        // gap that let a stale ok/cancel vkey trigger leak from
                        // Scene_Save into the resumed Scene_Message (the "cancel in
                        // save menu → bitmap crash" bug). See installSaveLoadPopHook
                        // in src/save-load-keymap.ts for the full rationale.
                        installSaveLoadPopHook();
                        const update = S.runtime.SceneManager.updateMain;
                        S.runtime.SceneManager.updateMain = function() {
                                // When returning to library, skip the game's update entirely.
                                // The game's rAF callback still fires but does nothing,
                                // preventing crashes from accessing stopped/undefined state.
                                // Also skip during the Plus(+) quit-confirmation notice
                                // so the game doesn't render over the dialog panel.
                                if (S.gameStopped || (S.phase === 'notice' && S.exitNoticeArmed)) { this.requestUpdate(); return; }
                                const now = performance.now();
                                if (S.lastFrame && now - S.lastFrame > 2000) {
                                        this._accumulator = 0;
                                        if (this._getTimeInMsWithoutMobileSafari) this._currentTime = this._getTimeInMsWithoutMobileSafari();
                                        S.runtime.Input?.clear?.(); S.runtime.TouchInput?.clear?.();
                                }
                                S.lastFrame = now;
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
                // Record last-played timestamp.
                if (S.currentEntry) {
                        try { S.library = markPlayed((Switch as any) as unknown as LibraryAccess, S.library, S.currentEntry.id); } catch { /* non-fatal */ }
                }
        } catch (error) { fail(error); }
}
