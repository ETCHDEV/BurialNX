import { S } from './state';
import { log } from './log';
import { setLoadingProgress, resetLoading } from './loading-screen';
import { libraryIdFromRoot, loadLibrary, type LibraryEntry, type LibraryAccess } from './game-library';
import { deriveDefaultCover, coverPathFor } from './cover';
import { invalidateCoverCache } from './cover-cache';
import { buildForwarder, forwarderPathFor } from './forwarder';
import { rememberLibrary, LIBRARY_PAGE_SIZE } from './selection';

declare const __DEBUG__: boolean;

/** Suggest a game name from the picked folder path: .exe basename if found, else folder name. */
export function suggestGameName(root: string): string {
        try {
                const clean = root.replace(/\/+$/, '');
                const parent = /\/www$/i.test(clean) ? clean.slice(0, -4) : clean;
                const dir = parent;
                let entries: string[] | null = null;
                try { entries = (Switch as any).readDirSync?.(`${dir}/`) as string[] | null; } catch { /* unreadable */ }
                if (entries) {
                        for (const name of entries) {
                                if (name && /\.exe$/i.test(name)) {
                                        return name.replace(/\.exe$/i, '');
                                }
                        }
                }
        } catch { /* best-effort */ }
        return root.replace(/\/+$/, '').split('/').pop() || 'Game';
}

/** Finish the add-game flow: create the library entry, auto-detect a cover, return to the grid. */
export function finishAddGame(name: string): void {
        if (!S.addGamePath) { S.waitForRelease = true; S.phase = 'library'; return; }
        const id = libraryIdFromRoot(S.addGamePath);
        const trimmedName = name.trim() || S.addGameDefaultName || (S.addGamePath.split('/').pop() || 'Game');
        let cover: string | null = null;
        try { cover = deriveDefaultCover((Switch as any) as unknown as LibraryAccess & { readDirSync(path: string): string[] | null }, id, S.addGamePath); }
        catch (error) { log(`Cover auto-detect failed: ${String(error)}`); }
        const entry: LibraryEntry = { id, name: trimmedName, root: S.addGamePath, sharedSaves: false, mod: null, ...(cover ? { cover } : { cover: null }) };
        if (rememberLibrary(entry)) { S.library = loadLibrary((Switch as any) as unknown as LibraryAccess); invalidateCoverCache(); }
        const idx = S.library.games.findIndex((g) => g.id === id);
        if (idx >= 0) S.libraryCursor = idx;
        S.libraryPage = Math.floor(S.libraryCursor / LIBRARY_PAGE_SIZE);
        S.addGamePath = '';
        S.addGameDefaultName = '';
        S.addGameSubmitted = false;
        S.addGamePreview = '';
        try { (navigator as any)?.virtualKeyboard?.removeEventListener?.('change', () => {}); } catch { /* best-effort */ }
        try { (navigator as any)?.virtualKeyboard?.removeEventListener?.('submit', () => {}); } catch { /* best-effort */ }
        S.waitForRelease = true; S.phase = 'library';
}

/** Drive buildForwarder() with a progress bar: read base NRO, cover, patch romfs/NACP, write forwarder NRO. */
export async function startForwarderBuild(entry: LibraryEntry) {
        const SwitchAny = (Switch as any);
        if (!SwitchAny?.writeFileSync || !SwitchAny?.readFileSync) {
                S.message = 'Switch filesystem unavailable — cannot build forwarder.'; S.waitForRelease = true; S.phase = 'notice'; return;
        }
        S.waitForRelease = true; S.phase = 'forwarder-building';
        resetLoading(`Forwarder: ${entry.name}`, 'Reading burialnx.nro…');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        try {
                const selfPath = SwitchAny.argv?.[0] as string | undefined;
                if (!selfPath) {
                        S.message = 'Could not determine the burialnx.nro path (Switch.argv[0] is empty).'; S.waitForRelease = true; S.phase = 'notice'; return;
                }
                setLoadingProgress(0.05, 'Reading burialnx.nro…', selfPath);
                const baseNro = SwitchAny.readFileSync(selfPath) as ArrayBuffer | null;
                if (!baseNro || baseNro.byteLength === 0) {
                        S.message = `Could not read ${selfPath}. Make sure burialnx.nro is at that path.`; S.waitForRelease = true; S.phase = 'notice'; return;
                }
                if (__DEBUG__) log(`forwarder: base NRO loaded from ${selfPath}, ${baseNro.byteLength} bytes`);
                setLoadingProgress(0.35, 'Reading game cover…');
                const coverPath = entry.cover || coverPathFor(entry.id);
                const coverExists = coverPath ? !!((Switch as any) as unknown as LibraryAccess).statSync?.(coverPath) : false;
                if (__DEBUG__) log(`forwarder: cover path = ${coverPath || '(none)'}, exists = ${coverExists}`);
                setLoadingProgress(0.50, coverExists ? 'Decoding cover image…' : 'No cover — keeping BurialNX icon…', coverPath || '(none)');
                setLoadingProgress(0.65, 'Patching NACP + main.js + game id…');
                const outputPath = forwarderPathFor(entry.name, entry.id);
                const result = await buildForwarder({
                        game: entry,
                        cover: coverExists ? { path: coverPath } : null,
                        baseNro,
                        outputPath,
                        log,
                });
                setLoadingProgress(1, 'Done.');
                if (result.ok) {
                        const mib = result.bytes ? (result.bytes / 1024 / 1024).toFixed(1) : '?';
                        S.message = `Forwarder built:\n${outputPath}\n(${mib} MiB). Reboot to hbmenu to see it.`;
                        if (__DEBUG__) log(`forwarder build ok: ${outputPath} (${result.bytes} bytes)`);
                } else {
                        S.message = `Forwarder build failed: ${result.error || 'unknown error'}`;
                        if (__DEBUG__) log(`forwarder build failed: ${result.error}`);
                }
                try { if (typeof S.runtime.gc === 'function') S.runtime.gc(); } catch { /* best-effort */ }
                S.waitForRelease = true; S.phase = 'notice';
        } catch (error) {
                const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                log(`startForwarderBuild threw: ${msg}`);
                S.message = `Forwarder build error: ${msg}`;
                try { if (typeof S.runtime.gc === 'function') S.runtime.gc(); } catch { /* best-effort */ }
                S.waitForRelease = true; S.phase = 'notice';
        }
}
