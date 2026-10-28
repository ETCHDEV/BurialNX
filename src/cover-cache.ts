// === Cover image cache ==============================================
// Extracted from main.ts. nx.js's native Image decoder crashes (segfault,
// no catchable JS error) on some valid PNGs extracted from .exe resources —
// particularly PNG-embedded Windows icons that use features the native
// libpng build doesn't handle. To work around this, we:
//   1. Read the cover bytes ourselves via Switch.readFile
//   2. Validate the PNG signature + IHDR (bit depth, color type, interlace)
//   3. Convert to a base64 data: URL and set img.src to THAT instead of
//      the sdmc:/ path. The data URL path uses a different native code
//      path in nx.js that decodes from an in-memory buffer, avoiding
//      whatever file-fetch + decode interaction triggers the crash.
//   4. Log the IHDR details so a future crash report tells us exactly
//      which PNG format triggered it.
//
// The module owns the coverCache Map. `log` is imported from the log
// module.

import { log } from './log';

const coverCache = new Map<string, { image: any; loaded: boolean; failed: boolean }>();

export function loadCoverImage(path: string | null | undefined): { image: any; loaded: boolean; failed: boolean } {
	if (!path) return { image: null, loaded: false, failed: true };
	const cached = coverCache.get(path);
	if (cached) return cached;
	const entry = { image: null as any, loaded: false, failed: false };
	coverCache.set(path, entry);
	try {
		const NativeImage = (globalThis as any).Image;
		if (typeof NativeImage !== 'function') { entry.failed = true; return entry; }
		const img = new NativeImage();
		img.addEventListener('load', () => { entry.loaded = true; entry.image = img; });
		img.addEventListener('error', (event: any) => {
			entry.failed = true;
			log(`Cover load failed: ${path}`);
			try { event?.stopPropagation?.(); } catch { /* best-effort */ }
		});
		// Read the PNG bytes ourselves so we can validate and log the
		// IHDR before handing the data to the native decoder. If the
		// file read fails, fall back to a direct path assignment.
		let bytes: ArrayBuffer | null = null;
		try { bytes = (Switch as any).readFileSync(path); } catch (readErr) {
			log(`Cover read failed: ${path}: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
		}
		if (!bytes || bytes.byteLength < 24) {
			entry.failed = true;
			log(`Cover too small or unreadable: ${path} (${bytes ? bytes.byteLength : 0} bytes)`);
			return entry;
		}
		const u8 = new Uint8Array(bytes);
		// Detect the image format from the magic bytes so non-PNG
		// covers (JPEG, WebP, GIF) are decoded correctly. Previously
		// only PNG was accepted — JPEG/WebP files saved with a .png
		// extension failed the PNG signature check and showed a
		// question-mark placeholder.
		let mime: string | null = null;
		if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) mime = 'image/png';
		else if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) mime = 'image/jpeg';
		else if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) mime = 'image/gif';
		else if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) mime = 'image/webp';
		if (!mime) {
			entry.failed = true;
			log(`Cover unknown format: ${path} (first bytes: ${u8[0].toString(16)} ${u8[1].toString(16)} ${u8[2].toString(16)} ${u8[3].toString(16)})`);
			return entry;
		}
		// For PNG, validate the IHDR to avoid native decoder crashes
		// on interlaced or unusual bit depths. Non-PNG formats are
		// passed directly to the native decoder (which handles them).
		if (mime === 'image/png') {
			// IHDR is at offset 8+4+4 = 16 (after signature + length + type).
			const ihdrView = new DataView(bytes, 16, 13);
			const ihdrWidth = ihdrView.getUint32(0, false);
			const ihdrHeight = ihdrView.getUint32(4, false);
			const bitDepth = u8[24];
			const colorType = u8[25];
			const interlace = u8[28];
			log(`Cover PNG: ${path} ${ihdrWidth}x${ihdrHeight} bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace} (${bytes.byteLength} bytes)`);
			// nx.js's native decoder is known to crash on interlaced PNGs
			// and on unusual bit depths (1, 2, 4, 16). Reject those
			// preemptively so the app doesn't crash.
			if (interlace !== 0) {
				entry.failed = true;
				log(`Cover rejected: interlaced PNG not supported (would crash native decoder)`);
				return entry;
			}
			if (bitDepth !== 8) {
				entry.failed = true;
				log(`Cover rejected: bitDepth ${bitDepth} not supported (only 8-bit)`);
				return entry;
			}
			if (colorType !== 2 && colorType !== 6) {
				entry.failed = true;
				log(`Cover rejected: colorType ${colorType} not supported (only 2=RGB, 6=RGBA)`);
				return entry;
			}
		} else {
			log(`Cover ${mime}: ${path} (${bytes.byteLength} bytes)`);
		}
		// Convert to base64 data URL with the detected MIME type.
		// The native decoder takes a different code path for data:
		// URLs (in-memory buffer) vs sdmc:/ paths (file fetch), which
		// avoids the crash. Using the correct MIME type is critical
		// for non-PNG formats (JPEG, WebP, GIF) — the native decoder
		// needs to know the format to decode correctly.
		let binary = '';
		const CHUNK = 8192;
		for (let i = 0; i < u8.length; i += CHUNK) {
			const chunk = u8.subarray(i, Math.min(i + CHUNK, u8.length));
			binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
		}
		const base64 = (typeof btoa === 'function') ? btoa(binary) : '';
		if (base64) {
			img.src = `data:${mime};base64,${base64}`;
		} else {
			// btoa not available — fall back to direct path
			log(`Cover: btoa unavailable, falling back to direct path`);
			img.src = path;
		}
	} catch (error) { entry.failed = true; log(`Cover init failed: ${path}: ${String(error)}`); }
	return entry;
}

export function invalidateCoverCache() {
	// Do NOT call image.close() here — the canvas may still be referencing
	// the native pixel buffer for a queued drawImage. Closing the Image
	// would free the buffer underneath the renderer, which on Switch
	// manifests as a native crash (no catchable JS error). Let the GC
	// reclaim the Image naturally; the new cover loads into a fresh
	// Image object on the next renderLibrary call.
	coverCache.clear();
}
