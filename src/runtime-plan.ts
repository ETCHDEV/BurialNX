import { assetPath } from './library';

/** Read ordered local script references without loading arbitrary URLs. */
export function scriptPlan(html: string): string[] {
	const text = html.replace(/<!--[\s\S]*?-->/g, '');
	const paths: string[] = [];
	for (const tag of text.matchAll(/<script\b([^>]*)>/gi)) {
		const src = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[1]);
		if (!src) continue;
		const value = (src[1] || src[2] || src[3]).replace(/^\.\//, '');
		const path = assetPath(value);
		if (!path || /[?#]/.test(path)) throw new Error('Unsafe or unsupported game script path');
		paths.push(path);
	}
	if (!paths.some((path) => /(?:^|\/)rpg_core\.js$/i.test(path))) throw new Error('Not a supported RPG Maker MV entry point');
	return paths;
}

/** Start the normal MV entry point, or use its boot scene if no handler exists. */
export function startGame(runtime: any): 'onload' | 'already-started' | 'scene-boot' {
	if (typeof runtime.onload === 'function') {
		runtime.onload.call(runtime, new Event('load'));
		return 'onload';
	}
	const manager = runtime.SceneManager;
	if (manager?._scene || manager?._nextScene) return 'already-started';
	if (typeof manager?.run !== 'function' || typeof runtime.Scene_Boot !== 'function') {
		throw new Error('Game has no load handler or usable Scene_Boot');
	}
	manager.run(runtime.Scene_Boot);
	return 'scene-boot';
}

/** Compute a centered aspect-preserving destination on the Switch screen. */
export function viewport(width: number, height: number, outputWidth: number, outputHeight: number) {
	if (![width, height, outputWidth, outputHeight].every((n) => Number.isFinite(n) && n > 0)) return null;
	const scale = Math.min(outputWidth / width, outputHeight / height);
	const w = width * scale, h = height * scale;
	return { x: (outputWidth - w) / 2, y: (outputHeight - h) / 2, width: w, height: h };
}
