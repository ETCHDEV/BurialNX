import { assetPath, type Reader } from './library';

/**
 * TCOAAL stores some files under a short hash of their normal path. Plain
 * files are tried first so an unpacked mod can replace an individual asset.
 */
export async function gameAssetNames(path: string): Promise<string[]> {
	const safe = assetPath(path);
	if (!safe) throw new Error('Unsafe asset path');
	return namesForSafePath(safe);
}

// The caller already decoded and checked this path. Do not decode it twice:
// a legitimate filename may itself contain a percent sign.
async function namesForSafePath(safe: string): Promise<string[]> {
	const withoutExtension = safe.replace(/\.[^/.]+$/, '');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(safe));
	const hash = Array.from(new Uint8Array(digest).slice(0, 8), (n) => n.toString(16).padStart(2, '0')).join('');
	const parts = safe.split('/');
	const filename = parts.pop()!;
	parts.push(`${filename.startsWith('!') ? '!' : ''}${hash}${filename.toUpperCase().includes('[BUST]') ? '[BUST]' : ''}`);
	return [...new Set([safe, withoutExtension, parts.join('/')])];
}

/** Decode the game's small file header in memory; never modify the SD file. */
export function unpackGameAsset(buffer: ArrayBuffer, path: string): ArrayBuffer {
	const input = new Uint8Array(buffer);
	if (input.length < 7 || String.fromCharCode(...input.subarray(0, 6)) !== 'TCOAAL') return buffer;
	const output = input.slice(7);
	const limit = Math.min(input[6] || output.length, output.length);
	let key = 0;
	for (const c of path.split('/').pop()!.toUpperCase()) key = ((key << 1) ^ c.charCodeAt(0)) & 255;
	key = (key + 1) & 255;
	for (let i = 0; i < limit; i++) {
		const encoded = output[i];
		output[i] = encoded ^ key;
		key = ((key << 1) ^ encoded) & 255;
	}
	return output.buffer;
}

/** Small bounded cache for repeated images and map data, not large audio. */
export function gameAssets(game: string, mod: string | null, disk: Reader, budget = 16 * 1024 * 1024): Reader {
	const memory = new Map<string, ArrayBuffer>();
	const pending = new Map<string, { request: Promise<ArrayBuffer | null>; shared: boolean }>();
	let size = 0;
	const roots = [mod, game].filter((root): root is string => !!root).map((root) => root.replace(/\/+$/, ''));
	async function resolve(safe: string): Promise<ArrayBuffer | null> {
		// Hashing is comparatively expensive; only do it when plain files miss.
		for (const root of roots) {
			const candidates = [...new Set([safe, safe.replace(/\.[^/.]+$/, '')])];
			for (let i = 0; i < candidates.length; i++) {
				const name = candidates[i];
				const bytes = await disk.read(`${root}/${name}`);
				if (bytes !== null) {
					const result = unpackGameAsset(bytes, name);
					if (/^(data|img)\//i.test(safe) && result.byteLength > 0 && result.byteLength <= Math.min(budget, 2 * 1024 * 1024)) {
						const previous = memory.get(safe);
						if (previous) { size -= previous.byteLength; memory.delete(safe); }
						while ((size + result.byteLength > budget || memory.size >= 512) && memory.size) {
							const oldest = memory.keys().next().value!;
							size -= memory.get(oldest)!.byteLength; memory.delete(oldest);
						}
						memory.set(safe, result.slice(0)); size += result.byteLength;
					}
					return result;
				}
				if (i === candidates.length - 1) {
					const hashed = (await namesForSafePath(safe)).at(-1)!;
					if (!candidates.includes(hashed)) candidates.push(hashed);
				}
			}
		}
		return null;
	}
	return { async read(path) {
		const safe = assetPath(path);
		if (!safe) throw new Error('Unsafe asset path');
		const cached = memory.get(safe);
		if (cached) { memory.delete(safe); memory.set(safe, cached); return cached.slice(0); }
		// Share simultaneous image/data reads. Each waiter gets its own copy so
		// native decoders and game code can safely transfer or mutate buffers.
		if (!/^(data|img)\//i.test(safe)) return resolve(safe);
		const existing = pending.get(safe);
		if (existing) { existing.shared = true; const bytes = await existing.request; return bytes ? bytes.slice(0) : null; }
		const entry = { request: resolve(safe), shared: false };
		pending.set(safe, entry);
		try { const bytes = await entry.request; return bytes && entry.shared ? bytes.slice(0) : bytes; }
		finally { if (pending.get(safe) === entry) pending.delete(safe); }
	} };
}
