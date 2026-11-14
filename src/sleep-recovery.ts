import { S } from './state';
import { log } from './log';
import { teardownGame, quitApp, realExit } from './game-lifecycle';
import { removeBeforeUnloadListener, removeAllSessionListeners } from './error-handling';
import { BURIALNX_NRO_PATH, BURIALNX_DEBUG_NRO_PATH } from './forwarder';

export const SLEEP_SAVE_PATH = 'sdmc:/switch/burialnx/.sleep-autosave.rpgsave';
export const SLEEP_MARKER_PATH = 'sdmc:/switch/burialnx/.sleep-autoload';
export const SLEEP_MARKER_TTL_MS = 120_000;

/** Save the live game's state to the hidden sleep-autosave file. */
export function saveGameForSleep(): boolean {
        const runtime = S.runtime as any;
        const dm = runtime?.DataManager;
        if (!dm || typeof dm.makeSaveContents !== 'function' || !runtime.JsonEx || !runtime.LZString) {
                log('_sleep: DataManager.makeSaveContents / JsonEx / LZString unavailable — cannot autosave');
                return false;
        }
        try {
                try { runtime.$gameSystem?.saveBgm?.(); } catch { /* best-effort */ }
                try { runtime.$gameSystem?.saveBgs?.(); } catch { /* best-effort */ }
                const contents = dm.makeSaveContents();
                const json = runtime.JsonEx.stringify(contents);
                const compressed = runtime.LZString.compressToBase64(json);
                const SwitchAny = Switch as any;
                try { SwitchAny?.mkdirSync?.('sdmc:/switch/burialnx'); } catch { /* already exists */ }
                SwitchAny.writeFileSync(SLEEP_SAVE_PATH, compressed);
                log(`_sleep: autosave written to hidden file (${SLEEP_SAVE_PATH}, ${Math.round(compressed.length / 1024)} KiB)`);
                return true;
        } catch (error) {
                log(`_sleep: saveGame threw: ${error instanceof Error ? error.message : String(error)}`);
                return false;
        }
}

/** Read the hidden sleep-autosave file; returns compressed base64 or null. */
function readSleepSave(): string | null {
        try {
                const raw = (Switch as any).readFileSync(SLEEP_SAVE_PATH);
                if (!raw) return null;
                return new TextDecoder().decode(raw);
        } catch { return null; }
}

/** Delete the hidden sleep-autosave file; best-effort. */
function deleteSleepSave(): void {
        try { (Switch as any).removeSync?.(SLEEP_SAVE_PATH); } catch { /* best-effort */ }
        try { (Switch as any).unlinkSync?.(SLEEP_SAVE_PATH); } catch { /* best-effort */ }
}

/** Capture current BGM/BGS directly from AudioManager for marker replay. */
function captureAudioState(): { bgm: any | null; bgs: any | null } {
        const runtime = S.runtime as any;
        const am = runtime?.AudioManager;
        const result = { bgm: null as any | null, bgs: null as any | null };
        if (!am) return result;
        try {
                if (typeof am.saveBgm === 'function') {
                        const bgm = am.saveBgm();
                        if (bgm && bgm.name) result.bgm = bgm;
                } else if (am._currentBgm && am._currentBgm.name) {
                        result.bgm = { ...am._currentBgm };
                }
        } catch { /* best-effort */ }
        try {
                if (typeof am.saveBgs === 'function') {
                        const bgs = am.saveBgs();
                        if (bgs && bgs.name) result.bgs = bgs;
                } else if (am._currentBgs && am._currentBgs.name) {
                        result.bgs = { ...am._currentBgs };
                }
        } catch { /* best-effort */ }
        return result;
}

/** Write the sleep-autoload marker; records gameId + captured BGM/BGS. */
export function writeSleepMarker(gameId: string, audio: { bgm: any | null; bgs: any | null }): void {
        const payload = JSON.stringify({
                gameId,
                savedAt: Date.now(),
                bgm: audio.bgm,
                bgs: audio.bgs,
        });
        try {
                const SwitchAny = Switch as any;
                try { SwitchAny?.mkdirSync?.('sdmc:/switch/burialnx'); } catch { /* already exists */ }
                SwitchAny.writeFileSync(SLEEP_MARKER_PATH, payload);
                log(`_sleep: marker written (${SLEEP_MARKER_PATH}, gameId=${gameId}, bgm=${audio.bgm?.name || 'none'}, bgs=${audio.bgs?.name || 'none'})`);
        } catch (error) {
                log(`_sleep: marker write failed: ${error instanceof Error ? error.message : String(error)}`);
        }
}

/** Read + delete the marker; returns {gameId, bgm, bgs} if fresh, else null. */
export function consumeSleepMarker(): { gameId: string; bgm: any | null; bgs: any | null } | null {
        const SwitchAny = Switch as any;
        let raw: ArrayBuffer | null = null;
        try { raw = SwitchAny.readFileSync(SLEEP_MARKER_PATH); } catch { raw = null; }
        if (!raw) return null;
        try { (SwitchAny.removeSync || SwitchAny.unlinkSync)?.call(SwitchAny, SLEEP_MARKER_PATH); } catch { /* best-effort */ }
        let parsed: any;
        try { parsed = JSON.parse(new TextDecoder().decode(raw)); }
        catch { log('_sleep: marker present but unparseable — discarding'); return null; }
        if (!parsed || typeof parsed.gameId !== 'string') {
                log('_sleep: marker has invalid shape — discarding');
                return null;
        }
        const age = Date.now() - Number(parsed.savedAt || 0);
        if (!Number.isFinite(age) || age > SLEEP_MARKER_TTL_MS) {
                log(`_sleep: marker stale (age=${age}ms, ttl=${SLEEP_MARKER_TTL_MS}ms) — discarding`);
                return null;
        }
        log(`_sleep: marker fresh (age=${age}ms) — autoload gameId=${parsed.gameId}, bgm=${parsed.bgm?.name || 'none'}, bgs=${parsed.bgs?.name || 'none'}`);
        return { gameId: parsed.gameId, bgm: parsed.bgm ?? null, bgs: parsed.bgs ?? null };
}

/** Chain-launch the SAME NRO the user is running into a fresh process. */
export function chainReloadSelf(): void {
        const SwitchAny = Switch as any;
        let nroPath = BURIALNX_NRO_PATH;
        try {
                const argv = (Switch as any).argv as readonly string[] | undefined;
                if (Array.isArray(argv) && argv.length > 0 && typeof argv[0] === 'string' && /\.nro$/i.test(argv[0])) {
                        nroPath = argv[0];
                }
        } catch { /* argv unavailable — keep default */ }
        log(`_sleep: chainReloadSelf → app.launch(${nroPath})`);
        let app: any;
        try { app = new SwitchAny.Application(nroPath); }
        catch (e1) {
                log(`_sleep: Application(${nroPath}) failed: ${e1 instanceof Error ? e1.message : String(e1)} — trying debug nro`);
                nroPath = BURIALNX_DEBUG_NRO_PATH;
                app = new SwitchAny.Application(nroPath);
        }
        S.allowExit = true;
        app.launch(nroPath);
}

/** Returns true if a live, saveable game (Scene_Map) is currently running. */
export function isLiveGameRunning(): boolean {
        const sm = (S.runtime as any)?.SceneManager;
        const Scene_Map = (S.runtime as any)?.Scene_Map;
        const scene = sm?._scene;
        const inSceneMap = !!(scene && Scene_Map && scene instanceof Scene_Map);
        if (S.phase === 'game') return inSceneMap;
        if (S.phase === 'notice') return inSceneMap;
        return false;
}

/** Returns true if the active scene is the in-game save/load menu. */
export function isInSaveLoadScene(): boolean {
        const runtime = S.runtime as any;
        const sm = runtime?.SceneManager;
        const scene = sm?._scene;
        if (!scene) return false;
        const Scene_Save = runtime?.Scene_Save;
        const Scene_Load = runtime?.Scene_Load;
        if (Scene_Save && scene instanceof Scene_Save) return true;
        if (Scene_Load && scene instanceof Scene_Load) return true;
        return false;
}

/** Returns true if a live, saveable game is in progress underneath the scene. */
export function hasLiveGameUnderneath(): boolean {
        const runtime = S.runtime as any;
        const gm = runtime?.$gameMap;
        if (!gm) return false;
        const mapId = gm._mapId;
        return typeof mapId === 'number' && mapId > 0;
}

/** Wake handler for the TITLE-screen save/load case (no live game underneath). */
export function handleWakeTitleSaveLoadExit(): void {
        log(`_sleep: wake during title save/load (no live game underneath) — exit to library/hbmenu (no save)`);
        try { deleteSleepSave(); } catch { /* best-effort */ }
        S.exitInProgress = true;
        try {
                quitApp();
        } catch (e) {
                log(`_sleep: quitApp threw: ${e instanceof Error ? e.message : String(e)} — fallback to direct Switch.exit()`);
                S.exitInProgress = false;
                try { removeBeforeUnloadListener(); } catch { /* best-effort */ }
                try { removeAllSessionListeners(); } catch { /* best-effort */ }
                try {
                        if (realExit) { S.allowExit = true; realExit(); }
                        else { log('_sleep: realExit unavailable — cannot exit'); }
                } catch (e2) { log(`_sleep: fallback Switch.exit threw: ${e2 instanceof Error ? e2.message : String(e2)}`); }
        }
}

/** Wake dispatcher for a wake detected during a save/load menu. */
export function handleWakeFromSaveLoad(): void {
        if (hasLiveGameUnderneath()) {
                log(`_sleep: wake during in-game save/load (live game underneath, $gameMap._mapId>0) — save underlying state + reload with autoload`);
                handleWake(true);
        } else {
                handleWakeTitleSaveLoadExit();
        }
}

/** The game id to record in the sleep marker. */
export function currentGameIdForSleep(): string | null {
        if (S.forwarderTargetId) return S.forwarderTargetId;
        if (S.currentEntry?.id) return S.currentEntry.id;
        if (S.selectedGame) {
                try {
                        const clean = S.selectedGame.replace(/\/+$/, '').toLowerCase();
                        let hash = 0;
                        for (let i = 0; i < clean.length; i++) hash = ((hash << 5) - hash + clean.charCodeAt(i)) | 0;
                        return `g${(hash >>> 0).toString(36)}`;
                } catch { return null; }
        }
        return null;
}

/** Full wake handler: save → marker → teardown → chain-reload sequence. */
export function handleWake(gameLive: boolean): void {
        log(`_sleep: wake detected (phase=${S.phase}, gameLive=${gameLive}) — reloading`);
        if (gameLive) {
                let audio = { bgm: null as any | null, bgs: null as any | null };
                try { audio = captureAudioState(); }
                catch (e) { log(`_sleep: captureAudioState threw: ${e instanceof Error ? e.message : String(e)}`); }
                let savedSlot = false;
                try { savedSlot = saveGameForSleep(); }
                catch (e) { log(`_sleep: saveGameForSleep threw: ${e instanceof Error ? e.message : String(e)}`); }
                if (savedSlot) {
                        const gameId = currentGameIdForSleep();
                        if (gameId) writeSleepMarker(gameId, audio);
                        else log('_sleep: no game id available — marker skipped (fresh process will not autoload)');
                }
                try { teardownGame(); }
                catch (e) { log(`_sleep: teardown threw: ${e instanceof Error ? e.message : String(e)}`); }
        } else {
                log('_sleep: no live game — skipping autosave, just refreshing GPU surface');
        }
        try { removeBeforeUnloadListener(); } catch { /* best-effort */ }
        try {
                chainReloadSelf();
        } catch (e) {
                log(`_sleep: chainReloadSelf failed: ${e instanceof Error ? e.message : String(e)} — falling back to Switch.exit()`);
                try {
                        const realExit = (Switch as any).exit;
                        if (typeof realExit === 'function') { S.allowExit = true; realExit.call(Switch); }
                } catch { /* best-effort */ }
        }
}

/** Install a one-shot Game_Map.autoplay hook to replay saved BGM/BGS. */
function installSavedAudioReplay(runtime: any): void {
        const Game_Map = runtime.Game_Map;
        const AudioManager = runtime.AudioManager;
        let replayed = false;
        const replaySaved = () => {
                if (replayed) return;
                try {
                        const markerBgm = S.sleepAutoloadBgm;
                        const markerBgs = S.sleepAutoloadBgs;
                        const sys = runtime.$gameSystem;
                        const bgm = markerBgm || sys?._bgm || null;
                        const bgs = markerBgs || sys?._bgs || null;
                        if (bgm && bgm.name && typeof AudioManager?.playBgm === 'function') {
                                AudioManager.playBgm(bgm);
                                replayed = true;
                                log(`_sleep: audio: replayed saved BGM "${bgm.name}" (source=${markerBgm ? 'marker' : 'gameSystem'})`);
                        } else {
                                log(`_sleep: audio: no saved BGM to replay (marker=${markerBgm?.name || 'none'}, gameSystem=${sys?._bgm?.name || 'none'})`);
                                replayed = true;
                        }
                        if (bgs && bgs.name && typeof AudioManager?.playBgs === 'function') {
                                AudioManager.playBgs(bgs);
                        }
                } catch (error) { log(`_sleep: audio: replay threw: ${error instanceof Error ? error.message : String(error)}`); }
        };
        if (Game_Map && typeof Game_Map.prototype?.autoplay === 'function' && !Game_Map.prototype.__bnxSleepAudioWrap) {
                const origAutoplay = Game_Map.prototype.autoplay;
                Game_Map.prototype.__bnxSleepAudioWrap = true;
                Game_Map.prototype.autoplay = function () {
                        const result = origAutoplay.apply(this, arguments as any);
                        replaySaved();
                        try { delete Game_Map.prototype.__bnxSleepAudioWrap; Game_Map.prototype.autoplay = origAutoplay; } catch { /* best-effort */ }
                        return result;
                };
                log('_sleep: audio: Game_Map.autoplay hook installed (one-shot saved-BGM replay)');
        } else {
                log('_sleep: audio: Game_Map.autoplay unavailable — relying on fallback timer only');
        }
        setTimeout(replaySaved, 1500);
}

/** Install the sleep-autoload hook in a freshly-launched game. */
export function installSleepAutoload(): void {
        if (S.sleepAutoloadArmed) return;
        const runtime = S.runtime as any;
        const sm = runtime?.SceneManager;
        if (!sm || typeof sm.goto !== 'function' || typeof runtime.Scene_Boot !== 'function') {
                log('_sleep: autoload: SceneManager.goto or Scene_Boot unavailable — cannot install hook');
                return;
        }
        S.sleepAutoloadArmed = true;
        const origGoto = sm.goto;
        let fired = false;
        log(`_sleep: autoload hook installed — intercepting first post-Boot scene`);
        sm.goto = function (sceneClass?: any) {
                if (!fired) {
                        const currentIsBoot = sm._scene instanceof runtime.Scene_Boot;
                        const targetIsBoot = typeof sceneClass === 'function' && sceneClass === runtime.Scene_Boot;
                        if (currentIsBoot && !targetIsBoot) {
                                fired = true;
                                log(`_sleep: autoload: boot→${sceneClass?.name || '?'} goto intercepted — loading hidden save`);
                                try {
                                        const dm = runtime.DataManager;
                                        if (!dm || typeof dm.createGameObjects !== 'function' || typeof dm.extractSaveContents !== 'function') {
                                                log('_sleep: autoload: DataManager.createGameObjects/extractSaveContents unavailable — falling back to original scene');
                                                sm.goto = origGoto;
                                                return origGoto.apply(this, arguments as any);
                                        }
                                        const compressed = readSleepSave();
                                        if (!compressed) {
                                                log('_sleep: autoload: hidden save file missing — falling back to original scene');
                                                sm.goto = origGoto;
                                                return origGoto.apply(this, arguments as any);
                                        }
                                        const json = runtime.LZString.decompressFromBase64(compressed);
                                        if (!json) {
                                                log('_sleep: autoload: hidden save decompress failed — falling back to original scene');
                                                sm.goto = origGoto;
                                                return origGoto.apply(this, arguments as any);
                                        }
                                        const contents = runtime.JsonEx.parse(json);
                                        dm.createGameObjects();
                                        dm.extractSaveContents(contents);
                                        log('_sleep: autoload: hidden save loaded (createGameObjects + extractSaveContents)');
                                        deleteSleepSave();
                                        try {
                                                const gp = runtime.$gamePlayer;
                                                if (gp && typeof gp.requestMapReload === 'function') {
                                                        gp.requestMapReload.call(gp);
                                                        log('_sleep: autoload: requestMapReload() called');
                                                } else {
                                                        log('_sleep: autoload: $gamePlayer.requestMapReload unavailable — map setup may be incomplete');
                                                }
                                        } catch (e) { log(`_sleep: autoload: requestMapReload threw: ${e instanceof Error ? e.message : String(e)}`); }
                                        try { installSavedAudioReplay(runtime); }
                                        catch (e) { log(`_sleep: audio: installSavedAudioReplay threw: ${e instanceof Error ? e.message : String(e)}`); }
                                        log('_sleep: autoload: goto(Scene_Map)');
                                        sm.goto = origGoto;
                                        try { sm._nextScene = null; } catch { /* best-effort */ }
                                        return sm.goto(runtime.Scene_Map);
                                } catch (error) {
                                        log(`_sleep: autoload: load threw: ${error instanceof Error ? error.message : String(error)} — falling back to original scene`);
                                        sm.goto = origGoto;
                                        return origGoto.apply(this, arguments as any);
                                }
                        }
                }
                return origGoto.apply(this, arguments as any);
        };
}
