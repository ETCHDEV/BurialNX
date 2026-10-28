// === Library action-tile icons (bundled in romfs:/icons/) ===========
// Extracted from main.ts. Three PNG icons shipped inside the NRO's romfs:
// add.png, exit.png, settings.png. They're drawn STRETCHED to fill the
// cover area of the three library action tiles (240×230), with a text
// label under them (still inside the tile border). Loaded once at
// startup (this module's init call); reused for every renderLibrary call.
// If a romfs read fails, the tile falls back to the original centered-text
// rendering.
//
// The module owns the `actionIcons` array and the `actionIconPaths` list.
// `log` is imported from the log module. The init call runs at this
// module's load time (matching the original `loadActionIcons()` call at
// the end of the action-icon section in main.ts).

import { log } from './log';

export interface ActionIcon { image: any; loaded: boolean; failed: boolean; }

export const actionIcons: ActionIcon[] = [
	{ image: null, loaded: false, failed: false }, // add
	{ image: null, loaded: false, failed: false }, // settings
	{ image: null, loaded: false, failed: false }, // exit
];
const actionIconPaths = ['romfs:/icons/add.png', 'romfs:/icons/settings.png', 'romfs:/icons/exit.png'];

export function loadActionIcons(): void {
	const NativeImage = (globalThis as any).Image;
	if (typeof NativeImage !== 'function') return;
	for (let i = 0; i < actionIconPaths.length; i++) {
		const path = actionIconPaths[i];
		const entry = actionIcons[i];
		if (entry.loaded || entry.failed) continue;
		try {
			const bytes = (Switch as any).readFileSync(path);
			if (!bytes || bytes.byteLength < 24) { entry.failed = true; continue; }
			const u8 = new Uint8Array(bytes);
			// Basic PNG signature check — these are our own
			// bundled files so they should always be valid,
			// but be defensive.
			if (u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) {
				entry.failed = true;
				log(`Action icon not a PNG: ${path}`);
				continue;
			}
			const img = new NativeImage();
			img.addEventListener('load', () => { entry.loaded = true; entry.image = img; });
			img.addEventListener('error', (event: any) => {
				entry.failed = true;
				log(`Action icon load failed: ${path}`);
				try { event?.stopPropagation?.(); } catch { /* best-effort */ }
			});
			// Convert to base64 data URL — same workaround as
			// loadCoverImage (avoids the file-fetch+decode
			// crash on the native decoder).
			let binary = '';
			const CHUNK = 8192;
			for (let j = 0; j < u8.length; j += CHUNK) {
				const chunk = u8.subarray(j, Math.min(j + CHUNK, u8.length));
				binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
			}
			const base64 = (typeof btoa === 'function') ? btoa(binary) : '';
			if (base64) img.src = `data:image/png;base64,${base64}`;
			else { img.src = path; log(`Action icon: btoa unavailable, falling back to direct path`); }
		} catch (error) {
			entry.failed = true;
			log(`Action icon init failed: ${path}: ${String(error)}`);
		}
	}
}

// Kick off the loads at module init — they're async (Image 'load'
// event fires later), but the read+base64 work happens synchronously
// here so by the time renderLibrary is first called the images are
// either loaded or already marked failed.
loadActionIcons();
