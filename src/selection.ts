import { S } from './state';
import { log } from './log';
import { safeGameSaveFolder, safeSaveFolder, hasSteamSaveData } from './saves';
import { libraryIdFromRoot, loadLibrary, upsertGame, toSelection, entryFromSelection, type LibraryEntry, type LibraryAccess, type ExperimentalSettings } from './game-library';
import { parseSelection, startupSelection, type GameSelection, type SaveLocation } from './settings';
import { invalidateCoverCache } from './cover-cache';
import { LIBRARY_PAGE_SIZE } from './render-library';

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

/** Read the per-game language preference from the library entry. */
export function getGameLanguage(gameRoot: string): string | undefined {
        const entry = S.library.games.find((g) => g.root === gameRoot || g.id === libraryIdFromRoot(gameRoot));
        return entry?.language;
}

/** Save the per-game language preference to the library file on the SD card. */
export function setGameLanguage(gameRoot: string, code: string): void {
        const id = libraryIdFromRoot(gameRoot);
        const entry = S.library.games.find((g) => g.id === id);
        if (entry) {
                const updated: LibraryEntry = { ...entry, language: code };
                if (rememberLibrary(updated)) { S.currentEntry = updated; log(`Language preference saved: ${code || 'English (default)'} for ${id}`); }
        }
}

/** Read the per-game experimental-toggle set from the library entry. Returns an empty
 *  object (all off) if the game has no saved experimental settings. */
export function getExperimentalSettings(gameRoot: string): ExperimentalSettings {
        const entry = S.library.games.find((g) => g.root === gameRoot || g.id === libraryIdFromRoot(gameRoot));
        return entry?.experimental ?? {};
}

/** Write the per-game experimental-toggle set to the library file on the SD card. The
 *  whole set is replaced (no merge) — the caller passes the new desired state. */
export function setExperimentalSettings(gameRoot: string, exp: ExperimentalSettings): void {
        const id = libraryIdFromRoot(gameRoot);
        const entry = S.library.games.find((g) => g.id === id);
        if (entry) {
                const updated: LibraryEntry = { ...entry, experimental: exp };
                if (rememberLibrary(updated)) { S.currentEntry = updated; log(`Experimental settings saved for ${id}`); }
        }
}

export function currentSelection(saves: SaveLocation | undefined = S.saveLocation): GameSelection {
        if (!S.selectedGame) throw new Error('No game selected');
        return { root: S.selectedGame, sharedSaves: S.sharedSaves, mod: S.selectedMod || null, ...(saves ? { saves } : {}) };
}

export function loadEntryIntoState(entry: LibraryEntry) {
        S.selectedGame = entry.root;
        S.sharedSaves = entry.sharedSaves;
        const modActive = entry.mod !== undefined && entry.mod !== null && entry.modEnabled !== false;
        S.selectedMod = modActive ? entry.mod : null;
        S.saveLocation = entry.saves;
        if (S.saveLocation && !validSaveLocation(S.saveLocation, entry.root, S.selectedMod || null)) S.saveLocation = undefined;
        S.saved = toSelection(entry);
        S.currentEntry = entry;
        // Apply this game's saved per-game experimental FPS toggles to the live S flags.
        // (Defaults: all off when the entry has no saved experimental set.)
        const exp = entry.experimental ?? {};
        S.skipFadeBlur = !!exp.skipFadeBlur;
        S.skipFadeFill = !!exp.skipFadeFill;
        S.windowLayerSkip = !!exp.windowLayerSkip;
        S.windowBitmapReuse = !!exp.windowBitmapReuse;
        S.textureGcIdle = !!exp.textureGcIdle;
        S.dirtyRenderSkip = !!exp.dirtyRenderSkip;
        S.presentCache = !!exp.presentCache;
        S.canvasNodeSkip = !!exp.canvasNodeSkip;
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

export { settingsPath, parseSelection, startupSelection, entryFromSelection, loadLibrary, invalidateCoverCache, LIBRARY_PAGE_SIZE };
