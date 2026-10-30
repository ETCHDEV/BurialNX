import { log } from './log';

export interface ActionIcon { image: any; loaded: boolean; failed: boolean; }

export const actionIcons: ActionIcon[] = [
        { image: null, loaded: false, failed: false },
        { image: null, loaded: false, failed: false },
        { image: null, loaded: false, failed: false },
];
const actionIconPaths = ['romfs:/icons/add.png', 'romfs:/icons/settings.png', 'romfs:/icons/exit.png'];

/** Loads the three bundled PNG action icons into `actionIcons`. */
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

loadActionIcons();
