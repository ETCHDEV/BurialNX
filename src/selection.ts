// === Selection helpers ===============================================
// Extracted from main.ts. The "current game selection" mutators — the
// functions that translate a library entry into the S.selectedGame /
// S.sharedSaves / S.selectedMod / S.saveLocation state consumed by
// launch(), and the save-location picker that decides whether to import
// Steam saves before launching.
//
// Also contains:
//   validSaveLocation()  — pure validation against the Switch fs.
//   remember() / rememberLibrary() — persist the selection / a library
//                          entry to settings.json / library.json.
//   getGameLanguage() / setGameLanguage() — per-game language pref
//                          (stored in library.json, not localStorage, so
//                          it works in forwarder NROs with saveData=0).

import { S } from './state';
import { log } from './log';
import { safeGameSaveFolder, safeSaveFolder, hasSteamSaveData } from './saves';
import { libraryIdFromRoot, loadLibrary, upsertGame, toSelection, entryFromSelection, type LibraryEntry, type LibraryAccess } from './game-library';
import { parseSelection, startupSelection, type GameSelection, type SaveLocation } from './settings';
import { invalidateCoverCache } from './cover-cache';
import { LIBRARY_PAGE_SIZE } from './render-library';

// launch() is imported LAZILY (via the function call site, not the
// top-level import) to avoid a circular-init issue: game-launch.ts
// imports getGameLanguage from this module, and this module imports
// launch from game-launch.ts. ES module live bindings handle this fine
// as long as both functions are only CALLED at runtime (which they are).
import { launch } from './game-launch';

const settingsPath = 'sdmc:/switch/burialnx/settings.json';

export function validSaveLocation(location: SaveLocation, root: string, mod: string | null): boolean {
	if (location.kind === 'switch') return true;
	if (location.kind === 'game' && !safeGameSaveFolder(location.folder, root, mod)) return false;
	if (location.kind === 'sd' && !safeSaveFolder(location.folder, root, mod)) return false;
	try {
		const entry = (Switch as any).statSync(location.folder);
		return entry ? (entry.mode & 0o170000) === 0o040000 : location.kind === 'game';
	} catch { return false; }
}

export function remember(selection: GameSelection) {
	if (!S.settingsValid) return false;
	try { (Switch as any).writeFileSync(settingsPath, JSON.stringify(selection, null, 2)); S.saved = selection; return true; }
	catch (error) { log(`Could not save selection: ${String(error)}`); return false; }
}

export function rememberLibrary(entry: LibraryEntry) {
	try { S.library = upsertGame((Switch as any) as unknown as LibraryAccess, S.library, entry); return true; }
	catch (error) { log(`Could not save library entry: ${String(error)}`); return false; }
}

/** Read the per-game language preference from the library entry (NOT localStorage).
 *  Returns: undefined = no preference (auto-select first .cld), '' = English,
 *  'ru' = Russian, etc. Uses the library file on the SD card so it works in
 *  forwarder NROs (which have saveData=0, making localStorage unavailable). */
export function getGameLanguage(gameRoot: string): string | undefined {
	const entry = S.library.games.find((g) => g.root === gameRoot || g.id === libraryIdFromRoot(gameRoot));
	return entry?.language;
}

/** Save the per-game language preference to the library file on the SD card.
 *  Works in both the main app and forwarder NROs (no localStorage needed). */
export function setGameLanguage(gameRoot: string, code: string): void {
	const id = libraryIdFromRoot(gameRoot);
	const entry = S.library.games.find((g) => g.id === id);
	if (entry) {
		const updated: LibraryEntry = { ...entry, language: code };
		if (rememberLibrary(updated)) { S.currentEntry = updated; log(`Language preference saved: ${code || 'English (default)'} for ${id}`); }
	}
}

export function currentSelection(saves: SaveLocation | undefined = S.saveLocation): GameSelection {
	if (!S.selectedGame) throw new Error('No game selected');
	return { root: S.selectedGame, sharedSaves: S.sharedSaves, mod: S.selectedMod || null, ...(saves ? { saves } : {}) };
}

export function loadEntryIntoState(entry: LibraryEntry) {
	S.selectedGame = entry.root;
	S.sharedSaves = entry.sharedSaves;
	// Respect modEnabled: if the mod is disabled, don't apply it at launch.
	const modActive = entry.mod !== undefined && entry.mod !== null && entry.modEnabled !== false;
	S.selectedMod = modActive ? entry.mod : null;
	// Remember the save location from the library entry. Both debug and
	// release builds use the stored saves location so the user is never
	// re-asked after the first launch.
	S.saveLocation = entry.saves;
	if (S.saveLocation && !validSaveLocation(S.saveLocation, entry.root, S.selectedMod || null)) S.saveLocation = undefined;
	S.saved = toSelection(entry);
	S.currentEntry = entry;
}

export function startOrChooseSaves() {
	if (S.saveLocation) void launch();
	else { S.choiceFromMenu = false; S.waitForRelease = true; S.phase = 'save-choice'; }
}

export function chooseSaves(location: SaveLocation) {
	if (!S.selectedGame) return;
	if (!validSaveLocation(location, S.selectedGame, S.selectedMod || null)) {
		S.message = 'Save folder is unavailable or overlaps the mod.'; S.waitForRelease = true; S.phase = 'notice'; return;
	}
	const pendingMod = S.choiceFromMenu && S.saved?.root === S.selectedGame ? S.saved.mod || null : S.selectedMod || null;
	if (!validSaveLocation(location, S.selectedGame, pendingMod)) { S.message = 'Save folder overlaps the selected mod.'; S.waitForRelease = true; S.phase = 'notice'; return; }
	const newSelection = { ...currentSelection(location), mod: pendingMod };
	if (!remember(newSelection)) { log('Could not save settings.json; continuing with library only.'); }
	// Persist the save location into the library entry too.
	if (S.currentEntry) {
		const updated: LibraryEntry = { ...S.currentEntry, mod: pendingMod, saves: location };
		if (!rememberLibrary(updated)) { S.message = 'Could not save library; storage unchanged.'; S.waitForRelease = true; S.phase = 'notice'; return; }
		S.currentEntry = updated;
	}
	if (S.choiceFromMenu) {
		S.message = 'Save location saved. Restart the loader to apply it.'; S.phase = 'notice';
	} else {
		S.saveLocation = location;
		if (location.kind === 'game') { S.importRequested = false; S.waitForRelease = true; void launch(); return; }
		let hasSource = true;
		try { hasSource = hasSteamSaveData(Switch as any, S.selectedGame); }
		catch (error) { log(`Could not check Steam saves: ${String(error)}`); }
		if (hasSource) S.phase = 'import-confirm';
		else { S.importRequested = false; void launch(); }
	}
	S.waitForRelease = true;
}

// Re-export the helpers the startup init block in main.ts still uses.
export { settingsPath, parseSelection, startupSelection, entryFromSelection, loadLibrary, invalidateCoverCache, LIBRARY_PAGE_SIZE };
