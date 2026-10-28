// === Scene diagnostics (debug-only) ==================================
// Extracted from main.ts. Tracks the currently-observed scene and reports
// scene status + image-cache state every 8 s when __DEBUG__ is on. The
// module owns the four diagnostic `let`s so `teardownGame` can call
// `resetDiagnostics()` to drop the scene references they would otherwise
// pin in memory after a game quits.

declare const __DEBUG__: boolean;

export type LogFn = (line: string) => void;
export type SnapshotRuntimeLogFn = () => void;

let observedScene: any;
let sceneSince = 0;
let lastSceneReport = 0;
let snapshotScene: any = Symbol('no diagnostic snapshot yet');

/** Drop the diagnostic scene references. Called by `teardownGame()` so the
 *  last observed scene (and its whole sprite/bitmap graph) is no longer
 *  pinned in memory by this module's closures. */
export function resetDiagnostics(): void {
	observedScene = undefined;
	snapshotScene = Symbol('no diagnostic snapshot yet');
}

/** Per-frame scene diagnostics. Only runs work when __DEBUG__ is on. Logs
 *  scene transitions immediately and reports a status line (with the
 *  image-cache contents) every 8 s. `runtime` is the game's global scope
 *  (globalThis), `fps` is the current frames-per-second counter, and
 *  `log` / `snapshotRuntimeLog` are the loader's logging helpers. */
export function diagnoseScene(now: number, runtime: any, fps: number, log: LogFn, snapshotRuntimeLog: SnapshotRuntimeLogFn) {
	if (!__DEBUG__) return;
	const manager = runtime.SceneManager, scene = manager?._scene;
	if (scene !== observedScene) {
		observedScene = scene; sceneSince = lastSceneReport = now;
		log(`Scene: ${scene?.constructor?.name || 'none'}`);
	}
	if (now - lastSceneReport < 8000) return;
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
	log(`Scene status: ${scene?.constructor?.name || 'none'}, next=${manager?._nextScene?.constructor?.name || 'none'}, started=${!!manager?._sceneStarted}, stopped=${!!manager?._stopped}, seconds=${Math.round((now - sceneSince) / 1000)}, fps=${fps.toFixed(1)}, map=${runtime.$gameMap?.mapId?.() ?? '?'}, mapData=${!!runtime.$dataMap}, error=${runtime.DataManager?._errorUrl || 'none'}, images=${waiting.join(',') || 'none'}`);
}
