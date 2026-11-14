declare const __DEBUG__: boolean;

export type LogFn = (line: string) => void;
export type SnapshotRuntimeLogFn = () => void;

let observedScene: any;
let sceneSince = 0;
let lastSceneReport = 0;
let snapshotScene: any = Symbol('no diagnostic snapshot yet');

/** Drop diagnostic scene references so teardownGame can free the sprite graph. */
export function resetDiagnostics(): void {
        observedScene = undefined;
        snapshotScene = Symbol('no diagnostic snapshot yet');
}

/** Per-frame scene diagnostics — only runs work when __DEBUG__ is on. */
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
