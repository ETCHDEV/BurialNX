import { log } from './log';

const coverCache = new Map<string, { image: any; loaded: boolean; failed: boolean }>();

/** Load a cover image by path, validating PNG IHDR to avoid native decoder crashes. */
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
                if (mime === 'image/png') {
                        const ihdrView = new DataView(bytes, 16, 13);
                        const ihdrWidth = ihdrView.getUint32(0, false);
                        const ihdrHeight = ihdrView.getUint32(4, false);
                        const bitDepth = u8[24];
                        const colorType = u8[25];
                        const interlace = u8[28];
                        log(`Cover PNG: ${path} ${ihdrWidth}x${ihdrHeight} bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace} (${bytes.byteLength} bytes)`);
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
                        log(`Cover: btoa unavailable, falling back to direct path`);
                        img.src = path;
                }
        } catch (error) { entry.failed = true; log(`Cover init failed: ${path}: ${String(error)}`); }
        return entry;
}

/** Clear the cover cache; do not close Images (canvas may still be drawing them). */
export function invalidateCoverCache() {
        coverCache.clear();
}
