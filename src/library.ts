/** Filesystem boundary for a read-only game and an optional read-only mod. */
export interface Reader {
	read(path: string): Promise<ArrayBuffer | null>;
}

/** Only relative paths are accepted; decoding must not turn a path into traversal. */
export function assetPath(value: string): string | null {
	let path: string;
	try { path = decodeURIComponent(value); } catch { return null; }
	// Control characters can forge log lines or escape a sourceURL comment;
	// colons and backslashes can introduce native filesystem schemes/paths.
	if (!path || path.startsWith('/') || /[\\:\u0000-\u001f\u007f\u2028\u2029]/.test(path)) return null;
	const segments = path.split('/');
	if (segments.some((part) => !part || part === '.' || part === '..')) return null;
	return path;
}

/** A loose file in the mod directory takes precedence over the game file. */
export function overlayReader(gameRoot: string, modRoot: string | null, io: Reader): Reader {
	const root = (p: string) => p.replace(/\/+$/, '');
	return {
		async read(value) {
			const path = assetPath(value);
			if (!path) throw new Error('Unsafe asset path');
			if (modRoot) {
				const mod = await io.read(`${root(modRoot)}/${path}`);
				if (mod !== null) return mod;
			}
			return io.read(`${root(gameRoot)}/${path}`);
		},
	};
}
