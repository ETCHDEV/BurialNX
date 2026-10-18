// A synthetic one-pixel PNG: RGB (200, 100, 50), alpha 128.
const testPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAA1BMVEXIZDLxgAUBAAAAAXRSTlOArV5bRgAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=';

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const value of data) {
		crc ^= value;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Correct indexed PNG palettes in memory, only after the runtime probe. */
export function fixIndexedPng(input: ArrayBuffer): ArrayBuffer {
	const bytes = new Uint8Array(input);
	if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) || bytes[25] !== 3) return input;
	const view = new DataView(input);
	let palette = 0, count = 0, alpha = 0, alphaCount = 0;
	for (let cursor = 8; cursor + 12 <= bytes.length;) {
		const length = view.getUint32(cursor);
		if (length > bytes.length - cursor - 12) return input;
		const type = String.fromCharCode(...bytes.subarray(cursor + 4, cursor + 8));
		if (type === 'PLTE') { palette = cursor; count = length; }
		if (type === 'tRNS') { alpha = cursor + 8; alphaCount = length; }
		if (type === 'IDAT') break;
		cursor += length + 12;
	}
	if (!palette || !alpha || !count || count % 3 || count > 768 || alphaCount > count / 3) return input;
	const result = input.slice(0), out = new Uint8Array(result);
	for (let i = 0; i < alphaCount; i++) for (let channel = 0; channel < 3; channel++) {
		const position = palette + 8 + 3 * i + channel;
		out[position] = Math.round(out[position] * out[alpha + i] / 255);
	}
	new DataView(result).setUint32(palette + 8 + count, crc32(out.subarray(palette + 4, palette + 8 + count)));
	return result;
}

/** Test both the defect and correction so newer nx.js versions stay unchanged. */
export async function needsPngFix(log: (line: string) => void): Promise<boolean> {
	const raw = Uint8Array.from(atob(testPng), (char) => char.charCodeAt(0)).buffer;
	async function sample(bytes: ArrayBuffer) {
		const image = new Image(), url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('Image probe timed out')), 2000);
				image.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
				image.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Image probe failed')); }, { once: true });
				image.src = url;
			});
			const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
			ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1, 1); ctx.drawImage(image, 0, 0);
			return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
		} finally { URL.revokeObjectURL(url); }
	}
	const close = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 3);
	try {
		const original = await sample(raw);
		if (close(original, [100, 50, 25])) return false;
		const fixed = await sample(fixIndexedPng(raw));
		const needed = (close(original, [200, 100, 50]) || close(original, [128, 100, 50])) && close(fixed, [100, 50, 25]);
		log(`Indexed PNG probe: ${original} -> ${fixed}; fix=${needed}`);
		return needed;
	} catch (error) { log(`PNG probe unavailable: ${String(error)}`); return false; }
}
