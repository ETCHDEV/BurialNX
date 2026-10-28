// === Add-game + forwarder builder entrypoints =========================
// Extracted from main.ts.
//
// suggestGameName(root) — derives a default game name from the picked
//                         folder path (looks for a .exe one level up from
//                         www/, falls back to the folder name).
// finishAddGame(name)   — creates the library entry with the given name,
//                         tries to auto-detect a cover, returns to the
//                         library grid.
// startForwarderBuild(entry) — async pipeline that drives buildForwarder()
//                         with the loading-screen progress bar: reads the
//                         running burialnx.nro as the base, optionally
//                         reads the game cover, patches the romfs + NACP,
//                         writes the per-game forwarder NRO to the SD card.

import { S } from './state';
import { log } from './log';
import { setLoadingProgress, resetLoading } from './loading-screen';
import { libraryIdFromRoot, loadLibrary, type LibraryEntry, type LibraryAccess } from './game-library';
import { deriveDefaultCover, coverPathFor } from './cover';
import { invalidateCoverCache } from './cover-cache';
import { buildForwarder, forwarderPathFor } from './forwarder';
import { rememberLibrary, LIBRARY_PAGE_SIZE } from './selection';

declare const __DEBUG__: boolean;

/** Suggest a game name from the picked folder path. Looks for a .exe
 *  file in the parent folder (RPG Maker MV games usually have one next
 *  to the www/ folder). If found, uses the .exe filename without the
 *  extension. Otherwise, uses the folder name. */
export function suggestGameName(root: string): string {
	try {
		// RPG Maker MV's www/ contains the web assets; the .exe usually
		// lives next to it. Look one level up when the root is www/.
		const clean = root.replace(/\/+$/, '');
		const parent = /\/www$/i.test(clean) ? clean.slice(0, -4) : clean;
		const dir = parent;
		let entries: string[] | null = null;
		try { entries = (Switch as any).readDirSync?.(`${dir}/`) as string[] | null; } catch { /* unreadable */ }
		if (entries) {
			for (const name of entries) {
				if (name && /\.exe$/i.test(name)) {
					// Use the .exe filename without the extension.
					return name.replace(/\.exe$/i, '');
				}
			}
		}
	} catch { /* best-effort */ }
	// Fall back to the folder name.
	return root.replace(/\/+$/, '').split('/').pop() || 'Game';
}

/** Finish the add-game flow: create the library entry with the given
 *  name, try to auto-detect a cover, and return to the library. */
export function finishAddGame(name: string): void {
	if (!S.addGamePath) { S.waitForRelease = true; S.phase = 'library'; return; }
	const id = libraryIdFromRoot(S.addGamePath);
	const trimmedName = name.trim() || S.addGameDefaultName || (S.addGamePath.split('/').pop() || 'Game');
	// Try to derive a cover from the folder.
	let cover: string | null = null;
	try { cover = deriveDefaultCover((Switch as any) as unknown as LibraryAccess & { readDirSync(path: string): string[] | null }, id, S.addGamePath); }
	catch (error) { log(`Cover auto-detect failed: ${String(error)}`); }
	const entry: LibraryEntry = { id, name: trimmedName, root: S.addGamePath, sharedSaves: false, mod: null, ...(cover ? { cover } : { cover: null }) };
	if (rememberLibrary(entry)) { S.library = loadLibrary((Switch as any) as unknown as LibraryAccess); invalidateCoverCache(); }
	// Pre-select the new game.
	const idx = S.library.games.findIndex((g) => g.id === id);
	if (idx >= 0) S.libraryCursor = idx;
	S.libraryPage = Math.floor(S.libraryCursor / LIBRARY_PAGE_SIZE);
	// Clean up.
	S.addGamePath = '';
	S.addGameDefaultName = '';
	S.addGameSubmitted = false;
	S.addGamePreview = '';
	try { (navigator as any)?.virtualKeyboard?.removeEventListener?.('change', () => {}); } catch { /* best-effort */ }
	try { (navigator as any)?.virtualKeyboard?.removeEventListener?.('submit', () => {}); } catch { /* best-effort */ }
	S.waitForRelease = true; S.phase = 'library';
}

/** Drives the buildForwarder() pipeline. Reads the running burialnx.nro
 *  as the base, optionally reads the game cover PNG, patches the romfs +
 *  NACP + game id, writes the per-game forwarder NRO. Updates the loading
 *  progress bar at each stage so the user sees what's happening. The
 *  whole operation runs while phase === 'forwarder-building' so the frame
 *  loop renders the progress bar and B is ignored (we don't want to
 *  interrupt a half-written NRO). */
export async function startForwarderBuild(entry: LibraryEntry) {
	const SwitchAny = (Switch as any);
	if (!SwitchAny?.writeFileSync || !SwitchAny?.readFileSync) {
		S.message = 'Switch filesystem unavailable — cannot build forwarder.'; S.waitForRelease = true; S.phase = 'notice'; return;
	}
	// Defer one tick so the new phase paints before the (sync) SD reads
	// start blocking. The phase renders the progress bar.
	S.waitForRelease = true; S.phase = 'forwarder-building';
	resetLoading(`Forwarder: ${entry.name}`, 'Reading burialnx.nro…');
	// Yield to the next frame so the loading screen paints.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	try {
		// Read burialnx.nro's OWN file (the running app) to use as the
		// forwarder base. Switch.argv[0] is the path hbmenu used to
		// launch us. The forwarder is built by patching a copy of
		// this NRO: overwrite main.js in the romfs with the forwarder's
		// chain-load script, patch the NACP (title = game name), and
		// optionally patch the icon. No embedded template needed —
		// burialnx.nro stays at ~54 MiB.
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
		// Explicitly free the 54 MB baseNro ArrayBuffer and cover Image
		// before showing the notice. Without this, the large buffers may
		// still be in memory when the user clicks exit — the deferred
		// Switch.exit() can crash during native cleanup if too much
		// memory is still allocated. This GC call is the fix for the
		// sporadic "exit crashes after building/deleting a forwarder" bug.
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
