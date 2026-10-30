import { S } from './state';
import { log, snapshotRuntimeLog, hostLogPath } from './log';
import { renderLoading } from './loading-screen';
import { panel } from './canvas-utils';
import { renderLibrary, LIBRARY_COLS, LIBRARY_PAGE_SIZE, LIBRARY_ACTION_TILES } from './render-library';
import { renderGameOptions } from './render-options';
import { renderKeymap, renderRenameKb } from './keymap-render';
import { renderQuitDialog, renderNoticePopup, hud } from './render-overlay';
import { diagnoseScene } from './diagnostics';
import { overrideKeymapForSaveLoadScene, isSaveLoadKeymapActive } from './save-load-keymap';
import { pollButtonBindings } from './stick-bindings';
import { pollMouseInput, renderMouseCursor, hasMouseMovementBinding } from './mouse-input';
import { libraryTileCount, libraryNavigateRow } from './library-nav';
import { loadEntryIntoState, startOrChooseSaves, chooseSaves, remember, rememberLibrary, setGameLanguage, getGameLanguage, validSaveLocation, currentSelection } from './selection';
import { getAllPickKeys, findNearestKey } from './keymap-layout';
import { openKeymapEditor, applyPreset, saveEditingKeymap, handleKeymapTouch, mergedKeymap } from './keymap-editor';
import { menuButtonIndicesFor, faceButtonLetter, displayToButtonIndex } from './keymap';
import { suggestGameName, finishAddGame, startForwarderBuild } from './add-game';
import { saveUserCoverLogged, deriveDefaultCover, coverPathFor } from './cover';
import { invalidateCoverCache } from './cover-cache';
import { forwarderExists, deleteForwarder, forwarderPathFor, renameForwarder } from './forwarder';
import { moveGame, removeGame } from './game-library';
import { scanLanguageFiles, type LanguageScanFs, type LanguageEntry } from './game-compat';
import { gameSaveFolders } from './settings';
import { fail } from './error-handling';
import { quitApp } from './game-lifecycle';
import { launch } from './game-launch';
import { importSteamSaves } from './saves';
import { setButton, setButtonWithLabel, displayToButtonIndex } from './keymap';
import { FolderBrowser } from './folders';
import { handleWake, isLiveGameRunning, isInSaveLoadScene, handleWakeFromSaveLoad } from './sleep-recovery';
import { detectWakeThisFrame } from './sleep-detect';

declare const __DEBUG__: boolean;

const GAME_OPTIONS_BASE_COUNT = 14;

// === FPS optimization (variant F): zero-allocation button scan ============
function anyPressed(buttons: ArrayLike<{ pressed?: boolean }> | null): boolean {
        if (!buttons) return false;
        for (let i = 0, n = buttons.length; i < n; i++) {
                if (buttons[i]?.pressed) return true;
        }
        return false;
}

export function frame(now: number) {
        try {
                if (S.exitInProgress) {
                        requestAnimationFrame(frame);
                        return;
                }
                const woke = detectWakeThisFrame(Date.now());
                if (woke) {
                        if (S.phase === 'game' || S.phase === 'notice') {
                                if (isLiveGameRunning()) {
                                        handleWake(true);
                                        return;
                                }
                                if (isInSaveLoadScene()) {
                                        handleWakeFromSaveLoad();
                                        return;
                                }
                                log(`_wake: wake during game non-Scene_Map (phase=${S.phase}) — ignored (stale-GPU risk accepted, light scene)`);
                        } else {
                                handleWake(false);
                                return;
                        }
                }
                if (!S.frameLoggedFirst) { S.frameLoggedFirst = true; }
                S.marqueeOffset += 2;
                const buttons = (navigator as any).getGamepads?.()?.[0]?.buttons || null;
                const down = (id: number) => !!buttons?.[id]?.pressed;
                const edge = (id: number) => down(id) && !S.previousButtons[id];
                const m = menuButtonIndicesFor(mergedKeymap());
                const mc = m.confirm, mx = m.cancel;
                const lc = faceButtonLetter(mc), lx = faceButtonLetter(mx);
                const edgeC = () => down(mc) && !S.previousButtons[mc];
                const edgeX = () => down(mx) && !S.previousButtons[mx];
                if (S.phase === 'library') {
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease) {
                                const total = libraryTileCount(S.library, LIBRARY_ACTION_TILES);
                                if (edge(14)) S.libraryCursor = (S.libraryCursor + total - 1) % total;
                                if (edge(15)) S.libraryCursor = (S.libraryCursor + 1) % total;
                                if (edge(12)) S.libraryCursor = libraryNavigateRow(S.libraryCursor, total, LIBRARY_COLS, -1);
                                if (edge(13)) S.libraryCursor = libraryNavigateRow(S.libraryCursor, total, LIBRARY_COLS, 1);
                                const pageStart = S.libraryPage * LIBRARY_PAGE_SIZE;
                                if (S.libraryCursor < pageStart) { S.libraryPage = Math.max(0, S.libraryPage - 1); invalidateCoverCache(); }
                                else if (S.libraryCursor >= pageStart + LIBRARY_PAGE_SIZE) { S.libraryPage = Math.min(Math.ceil(total / LIBRARY_PAGE_SIZE) - 1, S.libraryPage + 1); invalidateCoverCache(); }
                                const isAction = S.libraryCursor >= S.library.games.length;
                                const actionIdx = S.libraryCursor - S.library.games.length;
                                const entry = !isAction ? S.library.games[S.libraryCursor] : null;
                                if (edgeC()) {
                                        if (isAction) {
                                                if (actionIdx === 0) { S.browser = new FolderBrowser((Switch as any), 'game', 'sdmc:/switch/burialnx'); S.pickerPurpose = 'add-game'; S.waitForRelease = true; S.phase = 'picker'; }
                                                else if (actionIdx === 1) openKeymapEditor('global');
                                                else if (actionIdx === 2) { quitApp(); }
                                        } else if (entry) {
                                                loadEntryIntoState(entry);
                                                startOrChooseSaves();
                                        }
                                } else if (edge(3) && entry) {
                                        loadEntryIntoState(entry);
                                        S.gameOptionsCursor = 0; S.gameOptionsScroll = 0;
                                        S.currentGameLanguages = scanLanguageFiles((Switch as unknown as LanguageScanFs) ?? null, entry.root);
                                        S.waitForRelease = true; S.phase = 'game-options';
                                } else if (edge(2)) {
                                        S.browser = new FolderBrowser((Switch as any), 'game', 'sdmc:/switch/burialnx'); S.pickerPurpose = 'add-game'; S.waitForRelease = true; S.phase = 'picker';
                                }
                                if (!isAction && entry && (edge(4) || edge(5))) {
                                        const dir = edge(4) ? -1 : 1;
                                        const oldIdx = S.libraryCursor;
                                        S.library = moveGame(Switch as any, S.library, entry.id, dir as -1 | 1);
                                        const newIdx = S.library.games.findIndex((g) => g.id === entry.id);
                                        if (newIdx >= 0) S.libraryCursor = newIdx;
                                        else S.libraryCursor = Math.max(0, oldIdx + dir);
                                        const ps = S.libraryPage * LIBRARY_PAGE_SIZE;
                                        if (S.libraryCursor < ps) S.libraryPage = Math.max(0, S.libraryPage - 1);
                                        else if (S.libraryCursor >= ps + LIBRARY_PAGE_SIZE) S.libraryPage++;
                                        invalidateCoverCache();
                                        try { S.runtime.SoundManager?.playCursor?.(); } catch { /* best-effort */ }
                                }
                        }
                        renderLibrary();
                } else if (S.phase === 'game-options') {
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease) {
                                const optsCount = GAME_OPTIONS_BASE_COUNT + (S.currentGameLanguages.length > 0 ? 1 : 0);
                                if (edge(13)) S.gameOptionsCursor = (S.gameOptionsCursor + 1) % optsCount;
                                if (edge(12)) S.gameOptionsCursor = (S.gameOptionsCursor + optsCount - 1) % optsCount;
                                if (S.currentGameLanguages.length > 0 && S.gameOptionsCursor === 10 && S.currentEntry) {
                                        const codes = S.currentGameLanguages.map((e) => e.code).concat(['']);
                                        const savedRaw = S.currentEntry.language;
                                        const currentCode = savedRaw === undefined ? (S.currentGameLanguages[0]?.code || '') : savedRaw;
                                        const currentIdx = Math.max(0, codes.indexOf(currentCode));
                                        let nextIdx = -1;
                                        if (edge(14)) nextIdx = (currentIdx + codes.length - 1) % codes.length;
                                        if (edge(15)) nextIdx = (currentIdx + 1) % codes.length;
                                        if (nextIdx >= 0) {
                                                const nextCode = codes[nextIdx];
                                                setGameLanguage(S.currentEntry.root, nextCode);
                                                try { S.runtime.SoundManager?.playCursor?.(); } catch { /* best-effort */ }
                                        }
                                }
                                if (edgeX()) { S.waitForRelease = true; S.phase = 'library'; }
                                else if (edgeC()) {
                                        if (S.gameOptionsCursor === 0) {
                                                if (S.currentEntry) { loadEntryIntoState(S.currentEntry); startOrChooseSaves(); }
                                        } else if (S.gameOptionsCursor === 1) {
                                                S.browser = new FolderBrowser((Switch as any), 'image', S.currentEntry?.root?.replace(/\/www$/i, '') || S.currentEntry?.root || 'sdmc:'); S.pickerPurpose = 'cover-image'; S.waitForRelease = true; S.phase = 'picker';
                                        } else if (S.gameOptionsCursor === 2) {
                                                if (S.currentEntry) {
                                                        const cover = deriveDefaultCover(Switch as any, S.currentEntry.id, S.currentEntry.root);
                                                        if (cover) {
                                                                const updated: any = { ...S.currentEntry, cover };
                                                                if (rememberLibrary(updated)) { S.currentEntry = updated; invalidateCoverCache(); S.message = 'Cover auto-detected.'; }
                                                                else S.message = 'Could not save cover.';
                                                                S.waitForRelease = true; S.phase = 'notice';
                                                        } else { S.message = 'No .exe or .ico icon found in the game folder.'; S.waitForRelease = true; S.phase = 'notice'; }
                                                }
                                        } else if (S.gameOptionsCursor === 3) {
                                                if (S.currentEntry) openKeymapEditor(S.currentEntry);
                                        } else if (S.gameOptionsCursor === 4) {
                                                if (S.currentEntry && S.currentEntry.keymap) {
                                                        const updated: any = { ...S.currentEntry };
                                                        delete updated.keymap;
                                                        if (rememberLibrary(updated)) { S.currentEntry = updated; S.message = 'Per-game keymap reset to global default.'; }
                                                        else S.message = 'Could not save setting.';
                                                        S.waitForRelease = true; S.phase = 'notice';
                                                } else {
                                                        S.message = 'No per-game keymap to reset (already using global).';
                                                        S.waitForRelease = true; S.phase = 'notice';
                                                }
                                        } else if (S.gameOptionsCursor === 5) {
                                                if (S.currentEntry) {
                                                        S.gameOptionsCursor = 0;
                                                        S.waitForRelease = true; S.phase = 'rename-choice';
                                                }
                                        } else if (S.gameOptionsCursor === 6) {
                                                if (S.currentEntry) { const modStart = S.currentEntry.mod ? S.currentEntry.mod.replace(/\/[^\/]+$/, '') : (S.currentEntry.root?.replace(/\/www$/i, '') || S.currentEntry.root); S.browser = new FolderBrowser((Switch as any), 'mod', modStart); S.pickerPurpose = 'game-mod'; S.waitForRelease = true; S.phase = 'picker'; }
                                        } else if (S.gameOptionsCursor === 7) {
                                                if (S.currentEntry && S.currentEntry.mod !== undefined && S.currentEntry.mod !== null) {
                                                        const updated: any = { ...S.currentEntry, modEnabled: S.currentEntry.modEnabled === false ? true : false };
                                                        if (rememberLibrary(updated)) { S.currentEntry = updated; S.message = `Mod ${updated.modEnabled === false ? 'disabled' : 'enabled'}.`; }
                                                        else S.message = 'Could not save setting.';
                                                        S.waitForRelease = true; S.phase = 'notice';
                                                } else {
                                                        S.message = 'No mod selected. Use "Select mod folder" first.';
                                                        S.waitForRelease = true; S.phase = 'notice';
                                                }
                                        } else if (S.gameOptionsCursor === 8) {
                                                if (S.currentEntry) {
                                                        const updated: any = { ...S.currentEntry, sharedSaves: !S.currentEntry.sharedSaves };
                                                        if (rememberLibrary(updated)) { S.currentEntry = updated; S.message = `Shared saves: ${updated.sharedSaves ? 'on' : 'off'}.`; }
                                                        else S.message = 'Could not save setting.';
                                                        S.waitForRelease = true; S.phase = 'notice';
                                                }
                                        } else if (S.gameOptionsCursor === 9) {
                                                S.choiceFromMenu = false;
                                                S.waitForRelease = true;
                                                S.phase = 'save-choice';
                                        } else if (S.currentGameLanguages.length > 0 && S.gameOptionsCursor === 10) {
                                                if (S.currentEntry) {
                                                        const codes = S.currentGameLanguages.map((e) => e.code).concat(['']);
                                                        const savedRaw = S.currentEntry.language;
                                                        const currentCode = savedRaw === undefined ? (S.currentGameLanguages[0]?.code || '') : savedRaw;
                                                        const currentIdx = Math.max(0, codes.indexOf(currentCode));
                                                        const nextIdx = (currentIdx + 1) % codes.length;
                                                        const nextCode = codes[nextIdx];
                                                        setGameLanguage(S.currentEntry.root, nextCode);
                                                        try { S.runtime.SoundManager?.playCursor?.(); } catch { /* best-effort */ }
                                                }
                                        } else {
                                                const offset = S.currentGameLanguages.length > 0 ? 1 : 0;
                                                const actionIdx = S.gameOptionsCursor - 10 - offset;
                                                if (actionIdx === 0) {
                                                        if (S.currentEntry) void startForwarderBuild(S.currentEntry);
                                                } else if (actionIdx === 1) {
                                                        if (S.currentEntry) {
                                                                const had = forwarderExists(Switch as any, S.currentEntry.name, S.currentEntry.id);
                                                                const removed = deleteForwarder(Switch as any, S.currentEntry.name, S.currentEntry.id);
                                                                if (had && removed) S.message = `Forwarder deleted:\n${forwarderPathFor(S.currentEntry.name, S.currentEntry.id)}`;
                                                                else if (had && !removed) S.message = 'Forwarder file present but could not be removed.';
                                                                else S.message = 'No forwarder to delete.';
                                                                S.waitForRelease = true; S.phase = 'notice';
                                                        }
                                                } else if (actionIdx === 2) {
                                                        if (S.currentEntry) {
                                                                try { deleteForwarder(Switch as any, S.currentEntry.name, S.currentEntry.id); } catch { /* non-fatal */ }
                                                                S.library = removeGame(Switch as any, S.library, S.currentEntry.id);
                                                                invalidateCoverCache();
                                                                S.currentEntry = null;
                                                                S.message = 'Game removed from library.';
                                                                S.waitForRelease = true; S.phase = 'library';
                                                        }
                                                } else if (actionIdx === 3) {
                                                        S.waitForRelease = true; S.phase = 'library';
                                                }
                                        }
                                }
                        }
                        renderGameOptions();
                } else if (S.phase === 'keymap') {
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease) {
                                if (S.keymapPicking) {
                                        if (edge(12)) S.keymapPickCursor = findNearestKey(S.keymapPickCursor, 0, -1);
                                        if (edge(13)) S.keymapPickCursor = findNearestKey(S.keymapPickCursor, 0, 1);
                                        if (edge(14)) S.keymapPickCursor = findNearestKey(S.keymapPickCursor, -1, 0);
                                        if (edge(15)) S.keymapPickCursor = findNearestKey(S.keymapPickCursor, 1, 0);
                                        if (edgeC()) {
                                                const def = getAllPickKeys()[S.keymapPickCursor];
                                                if (def && def.label) {
                                                        if (S.keymapCursor < 16) {
                                                                S.editingKeymap = setButtonWithLabel(S.editingKeymap, displayToButtonIndex(S.keymapCursor), def.vkey, def.label, def.keyCode);
                                                        } else {
                                                                const stickDirs = ['lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight'] as const;
                                                                const dir = stickDirs[S.keymapCursor - 16];
                                                                if (!S.editingKeymap.sticks) S.editingKeymap.sticks = {};
                                                                S.editingKeymap.sticks[dir] = { keyCode: def.keyCode || 0, label: def.label, vkey: def.vkey };
                                                        }
                                                        saveEditingKeymap();
                                                        S.keymapPicking = false;
                                                        S.waitForRelease = true;
                                                }
                                        }
                                        if (edgeX()) { S.keymapPicking = false; S.waitForRelease = true; }
                                } else {
                                        if (edge(12)) S.keymapCursor = (S.keymapCursor + 20) % 24;
                                        if (edge(13)) S.keymapCursor = (S.keymapCursor + 4) % 24;
                                        if (edge(14)) { const r = S.keymapCursor % 4; S.keymapCursor = r === 0 ? S.keymapCursor + 3 : S.keymapCursor - 1; }
                                        if (edge(15)) { const r = S.keymapCursor % 4; S.keymapCursor = r === 3 ? S.keymapCursor - 3 : S.keymapCursor + 1; }
                                        if (edgeC()) { S.keymapPicking = true; S.keymapPickCursor = 0; S.waitForRelease = true; }
                                        if (edge(3)) {
                                                if (S.keymapCursor < 16) {
                                                        S.editingKeymap = setButton(S.editingKeymap, displayToButtonIndex(S.keymapCursor), 'none');
                                                } else {
                                                        const stickDirs = ['lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight'] as const;
                                                        const dir = stickDirs[S.keymapCursor - 16];
                                                        if (S.editingKeymap.sticks) delete S.editingKeymap.sticks[dir];
                                                }
                                                saveEditingKeymap();
                                        }
                                        if (edgeX()) { S.waitForRelease = true; S.phase = S.host ? 'game' : 'library'; if (S.host) S.menu.dismiss(); }
                                        if (edge(4)) applyPreset(0);
                                        if (edge(5)) applyPreset(1);
                                        if (edge(6)) applyPreset(2);
                                        if (edge(7)) applyPreset(3);
                                }
                        }
                        renderKeymap();
                } else if (S.phase === 'rename-choice') {
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease) {
                                if (edge(13)) S.gameOptionsCursor = (S.gameOptionsCursor + 1) % 2;
                                if (edge(12)) S.gameOptionsCursor = (S.gameOptionsCursor + 2) % 2;
                                if (edgeX()) { S.waitForRelease = true; S.phase = 'game-options'; }
                                else if (edgeC() && S.currentEntry) {
                                        if (S.gameOptionsCursor === 0) {
                                                const vk = (navigator as any)?.virtualKeyboard;
                                                if (vk) {
                                                        vk.okButtonText = 'Save';
                                                        vk.type = 0;
                                                        vk.maxLength = 64;
                                                        vk.value = S.currentEntry.name;
                                                        S.renameSubmitted = false;
                                                        S.renamePreview = S.currentEntry.name;
                                                        const onLiveInput = () => { S.renamePreview = vk.value; };
                                                        const onSubmit = () => {
                                                                S.renameSubmitted = true;
                                                                const text = vk.value || S.currentEntry!.name;
                                                                const oldName = S.currentEntry!.name;
                                                                const updated: any = { ...S.currentEntry!, name: text };
                                                                if (rememberLibrary(updated)) { S.currentEntry = updated; S.message = 'Name changed.'; }
                                                                else S.message = 'Could not save name.';
                                                                try {
                                                                        if (renameForwarder(Switch as any, oldName, text, updated.id)) {
                                                                                S.message += '\n\nForwarder renamed. Recreate it in game options for the Switch Home Menu.';
                                                                        }
                                                                } catch { /* best-effort */ }
                                                                S.waitForRelease = true; S.phase = 'notice';
                                                        };
                                                        const onGeometryChange = () => {
                                                                if (vk.boundingRect.height === 0) {
                                                                        setTimeout(() => {
                                                                                vk.removeEventListener('submit', onSubmit as EventListener);
                                                                                vk.removeEventListener('geometrychange', onGeometryChange as EventListener);
                                                                                vk.removeEventListener('change', onLiveInput as EventListener);
                                                                                vk.removeEventListener('cursormove', onLiveInput as EventListener);
                                                                                if (!S.renameSubmitted) { S.waitForRelease = true; S.phase = 'game-options'; }
                                                                        }, 50);
                                                                }
                                                        };
                                                        vk.addEventListener('submit', onSubmit as EventListener);
                                                        vk.addEventListener('geometrychange', onGeometryChange as EventListener);
                                                        vk.addEventListener('change', onLiveInput as EventListener);
                                                        vk.addEventListener('cursormove', onLiveInput as EventListener);
                                                        vk.show();
                                                        S.phase = 'rename-kb';
                                                } else {
                                                        S.renameBuffer = S.currentEntry.name.slice(0, 64);
                                                        while (S.renameBuffer.length < 8) S.renameBuffer += ' ';
                                                        S.renameCursor = 0;
                                                        S.waitForRelease = true; S.phase = 'rename';
                                                }
                                        } else if (S.gameOptionsCursor === 1) {
                                                const parent = S.currentEntry.root.replace(/\/www$/i, '').replace(/\/+$/, '') || 'sdmc:';
                                                S.browser = new FolderBrowser((Switch as any), 'file', parent);
                                                S.pickerPurpose = 'rename-source';
                                                S.waitForRelease = true; S.phase = 'picker';
                                        }
                                }
                        }
                        if (S.ctx) {
                                S.ctx.save();
                                S.ctx.setTransform(1, 0, 0, 1, 0, 0);
                                S.ctx.fillStyle = '#161823';
                                S.ctx.fillRect(0, 0, (screen as any).width, (screen as any).height);
                                S.ctx.font = '22px sans-serif';
                                S.ctx.fillStyle = '#f4f3ef'; S.ctx.textAlign = 'left'; S.ctx.textBaseline = 'alphabetic';
                                S.ctx.fillText('Rename game — choose source', 28, 50);
                                S.ctx.font = '20px sans-serif';
                                S.ctx.fillStyle = '#9aa0b4';
                                S.ctx.fillText(S.currentEntry?.name || '(unknown)', 28, 78);
                                const items = [
                                        'Type a custom name',
                                        'Use name from folder/file',
                                ];
                                S.ctx.font = '22px sans-serif';
                                for (let i = 0; i < items.length; i++) {
                                        const isCursor = i === S.gameOptionsCursor;
                                        S.ctx.fillStyle = isCursor ? '#3fb950' : '#c9cdd6';
                                        S.ctx.fillText((isCursor ? '▶ ' : '  ') + items[i], 28, 120 + i * 32);
                                }
                                S.ctx.font = '16px sans-serif';
                                S.ctx.fillStyle = '#6e7681';
                                S.ctx.fillText(`Up/Down: select  ${lc}: choose  ${lx}: back`, 28, (screen as any).height - 20);
                                S.ctx.restore();
                        }
                } else if (S.phase === 'rename-kb' || S.phase === 'add-game-name') {
                        renderRenameKb();
                } else if (S.phase === 'rename') {
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease) {
                                if (edge(12)) {
                                        const c = S.renameBuffer.charCodeAt(S.renameCursor) || 32;
                                        const nc = c <= 32 ? 126 : c - 1;
                                        S.renameBuffer = S.renameBuffer.slice(0, S.renameCursor) + String.fromCharCode(nc) + S.renameBuffer.slice(S.renameCursor + 1);
                                }
                                if (edge(13)) {
                                        const c = S.renameBuffer.charCodeAt(S.renameCursor) || 32;
                                        const nc = c >= 126 ? 32 : c + 1;
                                        S.renameBuffer = S.renameBuffer.slice(0, S.renameCursor) + String.fromCharCode(nc) + S.renameBuffer.slice(S.renameCursor + 1);
                                }
                                if (edge(14) && S.renameCursor > 0) S.renameCursor--;
                                if (edge(15) && S.renameCursor < S.renameBuffer.length - 1) S.renameCursor++;
                                if (edgeC()) {
                                        if (S.currentEntry) {
                                                const updated: any = { ...S.currentEntry, name: S.renameBuffer };
                                                if (rememberLibrary(updated)) { S.currentEntry = updated; S.message = 'Name changed.'; }
                                                else S.message = 'Could not save name.';
                                                S.waitForRelease = true; S.phase = 'notice';
                                        }
                                }
                                if (edgeX()) { S.waitForRelease = true; S.phase = 'game-options'; }
                        }
                        panel(S.ctx!, ['BurialNX — rename game', `Up/Down: cycle char  Left/Right: move  ${lc}: save  ${lx}: cancel`, `Name: ${S.renameBuffer}`, `Pos: ${S.renameCursor + 1}/${S.renameBuffer.length}`], true);
                } else if (S.phase === 'picker') {
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease) {
                                const result = S.browser.step(buttons, mc, mx);
                                if (result !== undefined) {
                                        if (S.pickerPurpose === 'game' && result !== null) {
                                                S.selectedGame = result; S.sharedSaves = S.browser.sharedSaves;
                                                const previousMod = S.saved?.root === result ? S.saved.mod || null : null;
                                                S.selectedMod = previousMod;
                                                S.saveLocation = S.saved?.root === result ? S.saved.saves : undefined;
                                                if (S.saveLocation && !validSaveLocation(S.saveLocation, result, previousMod)) S.saveLocation = undefined;
                                                remember(currentSelection());
                                                if (__DEBUG__) { const modStart3 = S.selectedMod ? S.selectedMod.replace(/\/[^\/]+$/, '') : (S.selectedGame?.replace(/\/www$/i, '') || S.selectedGame); S.browser = new FolderBrowser((Switch as any), 'mod', modStart3); S.pickerPurpose = 'startup-mod'; S.waitForRelease = true; }
                                                else startOrChooseSaves();
                                        } else if (S.pickerPurpose === 'add-game' && result !== null) {
                                                S.addGamePath = result;
                                                S.addGameDefaultName = suggestGameName(result);
                                                S.addGamePreview = S.addGameDefaultName;
                                                S.addGameSubmitted = false;
                                                const vk = (navigator as any)?.virtualKeyboard;
                                                if (vk) {
                                                        vk.okButtonText = 'Add';
                                                        vk.type = 0;
                                                        vk.maxLength = 64;
                                                        vk.value = S.addGameDefaultName;
                                                        const onSubmit = () => {
                                                                S.addGameSubmitted = true;
                                                                const text = vk.value || S.addGameDefaultName;
                                                                S.addGamePreview = text;
                                                                finishAddGame(text);
                                                        };
                                                        const onLiveInput = () => { S.addGamePreview = vk.value; };
                                                        vk.addEventListener('change', onLiveInput);
                                                        vk.addEventListener('submit', onSubmit);
                                                        vk.show();
                                                        S.phase = 'add-game-name';
                                                } else {
                                                        finishAddGame(S.addGameDefaultName);
                                                }
                                        } else if (S.pickerPurpose === 'cover-image' && result !== null && S.currentEntry) {
                                                log(`Cover pick: ${result} for game ${S.currentEntry.id}`);
                                                const coverPath = saveUserCoverLogged(Switch as any, S.currentEntry.id, result, log);
                                                try { if (typeof S.runtime.gc === 'function') S.runtime.gc(); } catch { /* gc is best-effort */ }
                                                if (coverPath) {
                                                        const updated: any = { ...S.currentEntry, cover: coverPath };
                                                        if (rememberLibrary(updated)) { S.currentEntry = updated; invalidateCoverCache(); S.message = 'Cover saved.'; }
                                                        else S.message = 'Could not save cover.';
                                                } else S.message = 'Unsupported image or no icon in file. Use PNG, JPG, ICO, or .exe with embedded icon.';
                                                S.waitForRelease = true; S.phase = 'notice';
                                        } else if (S.pickerPurpose === 'startup-mod') {
                                                S.selectedMod = result;
                                                if (S.saveLocation && !validSaveLocation(S.saveLocation, S.selectedGame!, S.selectedMod)) S.saveLocation = undefined;
                                                S.choiceFromMenu = false; S.waitForRelease = true; S.phase = 'save-choice';
                                        } else if (S.pickerPurpose === 'game-mod' && S.currentEntry) {
                                                const updated: any = { ...S.currentEntry, mod: result, modEnabled: true };
                                                if (rememberLibrary(updated)) { S.currentEntry = updated; S.message = `Mod set to: ${result}`; }
                                                else S.message = 'Could not save mod setting.';
                                                S.waitForRelease = true; S.phase = 'notice';
                                        } else if (S.pickerPurpose === 'rename-source' && result !== null && S.currentEntry) {
                                                const clean = result.replace(/\/+$/, '');
                                                const lastSegment = clean.split('/').pop() || S.currentEntry.name;
                                                const name = lastSegment.replace(/\.[^.]+$/, '');
                                                const oldName = S.currentEntry.name;
                                                const updated: any = { ...S.currentEntry, name: name || S.currentEntry.name };
                                                if (rememberLibrary(updated)) { S.currentEntry = updated; S.message = `Name set to: ${name}`; }
                                                else S.message = 'Could not save name.';
                                                try {
                                                        if (renameForwarder(Switch as any, oldName, name, updated.id)) {
                                                                S.message += '\n\nForwarder renamed. Recreate it in game options for the Switch Home Menu.';
                                                        }
                                                } catch { /* best-effort */ }
                                                S.waitForRelease = true; S.phase = 'notice';
                                        }
                                        else if (S.pickerPurpose === 'menu-mod' && S.selectedGame) {
                                                const pendingSaves = S.saved?.root === S.selectedGame ? S.saved.saves : S.saveLocation;
                                                if (pendingSaves && !validSaveLocation(pendingSaves, S.selectedGame, result)) { S.browser.message = 'Mod overlaps or invalidates the save folder.'; }
                                                else {
                                                        const ok = remember({ ...currentSelection(pendingSaves), mod: result });
                                                        S.message = ok ? 'Mod saved. Restart the loader to apply it.' : 'Could not save mod selection; settings unchanged.';
                                                        S.waitForRelease = true; S.phase = 'notice';
                                                }
                                        } else if ((S.pickerPurpose === 'startup-saves' || S.pickerPurpose === 'menu-saves') && result !== null) {
                                                chooseSaves({ kind: 'sd', folder: result });
                                        } else if ((S.pickerPurpose === 'startup-saves' || S.pickerPurpose === 'menu-saves') && result === null) {
                                                S.waitForRelease = true; S.phase = 'save-choice';
                                        } else if (result === null) {
                                                S.waitForRelease = true;
                                                if (S.pickerPurpose === 'add-game') S.phase = 'library';
                                                else S.phase = S.currentEntry ? 'game-options' : 'library';
                                        }
                                }
                        }
                        const first = Math.max(0, Math.min(S.browser.selected - 7, S.browser.entries.length - 12));
                        const hint = S.browser.mode === 'game' ? `${lc}: open  ${lx}: back/cancel  X: select  Y: select (shared saves)` : S.browser.mode === 'mod' ? `${lc}: open  ${lx}: back/cancel  X: select  Y: no mod` : S.browser.mode === 'image' ? `${lc}: pick file  ${lx}: back/cancel` : `${lc}: open  ${lx}: back/cancel  X: select`;
                        const showFiles = S.browser.mode === 'image';
                        const entryLines = S.browser.entries.slice(first, first + 12).map((name: string, index: number) => {
                                const marker = first + index === S.browser.selected ? '> ' : '  ';
                                if (!showFiles) return `${marker}${name}/`;
                                let info: { mode: number } | null = null;
                                try { info = (Switch as any).statSync(`${S.browser.path}/${name}`); } catch { /* unreadable */ }
                                const isFile = info && (info.mode & 0o170000) === 0o100000;
                                const ext = name.toLowerCase().split('.').pop() || '';
                                const tag = isFile ? (ext === 'exe' ? '  [exe→icon]' : '  [image]') : '/';
                                return `${marker}${name}${tag}`;
                        });
                        panel(S.ctx!, [`BurialNX — select ${S.browser.mode} ${showFiles ? 'image' : 'folder'}`, `${S.browser.path}/`,
                                `Up/Down: highlight  ${lc}: open/select  ${lx}: parent  X: select`, hint, S.browser.message,
                                ...entryLines], true);
                } else if (S.phase === 'save-choice') {
                        panel(S.ctx!, ['BurialNX — save location', `${lc}: Switch user save data`, 'X: choose an SD-card folder', 'Y: use the game’s save folder', ...(S.choiceFromMenu ? [`${lx}: cancel`] : ['Select where new saves will be stored.'])], true);
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease && edgeC()) chooseSaves({ kind: 'switch' });
                        else if (!S.waitForRelease && buttons?.[3]?.pressed && !S.previousButtons[3]) { const saveStart = S.saveLocation?.kind === 'sd' ? S.saveLocation.folder : (S.selectedGame?.replace(/\/www$/i, '') || S.selectedGame); S.browser = new FolderBrowser((Switch as any), 'saves', saveStart); S.pickerPurpose = S.choiceFromMenu ? 'menu-saves' : 'startup-saves'; S.waitForRelease = true; S.phase = 'picker'; }
                        else if (!S.waitForRelease && buttons?.[2]?.pressed && !S.previousButtons[2]) { S.waitForRelease = true; S.phase = 'game-save-choice'; }
                        else if (!S.waitForRelease && S.choiceFromMenu && edgeX()) { S.menu.dismiss(); S.phase = 'game'; }
                } else if (S.phase === 'game-save-choice') {
                        const folders = gameSaveFolders(S.selectedGame!);
                        panel(S.ctx!, ['BurialNX — use game-folder saves', 'Saves will be written in the game folder. Back them up first.', `${lc}: ${folders[0]}`, ...(folders[1] ? [`X: ${folders[1]}`] : []), `A missing save folder will be created. ${lx}: back.`], true);
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease && edgeC()) chooseSaves({ kind: 'game', folder: folders[0] });
                        else if (!S.waitForRelease && folders[1] && buttons?.[3]?.pressed && !S.previousButtons[3]) chooseSaves({ kind: 'game', folder: folders[1] });
                        else if (!S.waitForRelease && edgeX()) { S.waitForRelease = true; S.phase = 'save-choice'; }
                } else if (S.phase === 'import-confirm') {
                        panel(S.ctx!, ['BurialNX — Steam saves', `Current destination: ${S.saveLocation && S.saveLocation.kind !== 'switch' ? S.saveLocation.folder : 'Switch user save data'}`, `${lc}: import game-folder Steam saves into this empty location`, `${lx}: skip`, 'Existing saves are never overwritten.'], true);
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease && (edgeC() || edgeX())) {
                                const wantsImport = edgeC();
                                if (S.choiceFromMenu) {
                                        try { S.message = wantsImport ? `Imported ${importSteamSaves(S.runtime, Switch as any, S.selectedGame!, S.saveLocation!)} Steam save slots.` : 'Import cancelled.'; }
                                        catch (error) { S.message = `Import failed: ${String(error)}`; }
                                        S.waitForRelease = true; S.phase = 'notice';
                                } else { S.importRequested = wantsImport; void launch(); }
                        }
                } else if (S.phase === 'notice') {
                        if (S.exitNoticeArmed) {
                                renderQuitDialog();
                        } else {
                                renderNoticePopup(S.message);
                        }
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease && (edgeX() || (!S.exitNoticeArmed && edgeC()))) {
                                S.exitNoticeArmed = false; S.exitArmed = false;
                                if (S.host) { S.menu.dismiss(); S.phase = 'game'; }
                                else { S.phase = S.currentEntry ? 'game-options' : 'library'; S.waitForRelease = true; }
                        } else if (!S.waitForRelease && S.exitNoticeArmed && edgeC()) {
                                S.exitNoticeArmed = false;
                                try { quitApp(); }
                                catch (error) {
                                        log(`quitApp threw: ${error instanceof Error ? error.message : String(error)}`);
                                        S.allowExit = true;
                                        try { (Switch as any).exit?.(); } catch { /* best-effort */ }
                                }
                        }
                } else if (S.phase === 'error') {
                        panel(S.ctx!, ['BurialNX — game could not start', S.message, __DEBUG__ ? `Details: ${(globalThis as any).__hostLogPath || ''}` : 'Try the debug build for details.', S.exitBehavior === 'restart' ? `Press ${lx} to return to the library.` : `Press ${lx} to exit BurialNX.`], true);
                        if (S.waitForRelease && !anyPressed(buttons)) S.waitForRelease = false;
                        else if (!S.waitForRelease && edgeX()) {
                                S.waitForRelease = true;
                                quitApp();
                        }
                } else if (S.phase === 'loading' || S.phase === 'forwarder-building') renderLoading(S.ctx);
                else {
                        diagnoseScene(now, S.runtime, S.fps, log, snapshotRuntimeLog);
                        overrideKeymapForSaveLoadScene(log, S.currentEntry, S.globalKeymap);
                        if (!isSaveLoadKeymapActive()) pollButtonBindings(S.currentEntry, S.globalKeymap);
                        // Virtual mouse cursor: poll joycon→mouse bindings and dispatch synthetic
                        // TouchInput events. Suppressed during save/load scenes (where the gamepadMapper
                        // is overridden to A/B ok/cancel) and while the pause menu blocks game input.
                        try { S.mouseVisible = hasMouseMovementBinding(mergedKeymap()); } catch { S.mouseVisible = false; }
                        if (!isSaveLoadKeymapActive() && !S.menu.blocksInput) pollMouseInput(S.currentEntry, S.globalKeymap);
                        if (now - S.lastMemoryCheck >= 5000) {
                                S.lastMemoryCheck = now;
                                try {
                                        const memory = (Switch as any).memoryUsage?.();
                                        if (memory?.nativeHeapUsed > 1024 * 1024 * 1024 && typeof S.runtime.gc === 'function') S.runtime.gc();
                                } catch { /* memory diagnostics are optional */ }
                        }
                        if (!S.sampleStart) S.sampleStart = now;
                        S.frames++; if (now - S.sampleStart >= 1000) { S.fps = S.frames * 1000 / (now - S.sampleStart); S.sampleStart = now; S.frames = 0; }
                        const minusBound = ((S.currentEntry?.keymap) || S.globalKeymap).buttons[8] !== 'none';
                        const action = S.menu.step(buttons, now, minusBound ? 800 : 0, mc, mx);
                        if (S.mapPrefetch && S.fps >= 50 && !S.menu.blocksInput && typeof S.runtime.Scene_Map === 'function' &&
                                S.runtime.SceneManager?._scene instanceof S.runtime.Scene_Map && S.runtime.SceneManager._sceneStarted &&
                                !S.runtime.SceneManager._nextScene && !S.runtime.SceneManager._stopped && S.runtime.$dataMap && !S.runtime.$gamePlayer?.isTransferring?.()) {
                                S.mapPrefetch.tick(now, true);
                        }
                        if (action === 'load' && S.runtime.SceneManager && S.runtime.Scene_Load) S.runtime.SceneManager.push(S.runtime.Scene_Load);
                        if (action === 'save' && S.runtime.SceneManager && S.runtime.Scene_Save) S.runtime.SceneManager.push(S.runtime.Scene_Save);
                        if (action === 'resolution' && S.host) S.fit = S.host.toggleFit();
                        if (action === 'mod') { const modStart2 = S.selectedMod ? S.selectedMod.replace(/\/[^\/]+$/, '') : (S.selectedGame?.replace(/\/www$/i, '') || S.selectedGame); S.browser = new FolderBrowser((Switch as any), 'mod', modStart2); S.pickerPurpose = 'menu-mod'; S.waitForRelease = true; S.phase = 'picker'; }
                        if (action === 'saves') { S.choiceFromMenu = true; S.waitForRelease = true; S.phase = 'save-choice'; }
                        if (action === 'import') { S.choiceFromMenu = true; S.waitForRelease = true; S.phase = 'import-confirm'; }
                        if (action === 'keymap') {
                                if (S.host && S.currentEntry) {
                                        if (!S.currentEntry.keymap) {
                                                const seededKm: any = { buttons: [...S.globalKeymap.buttons] };
                                                if (S.globalKeymap.labels) seededKm.labels = [...S.globalKeymap.labels];
                                                if (S.globalKeymap.keyCodes) seededKm.keyCodes = [...S.globalKeymap.keyCodes];
                                                if (S.globalKeymap.sticks) {
                                                        seededKm.sticks = {};
                                                        for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                                                                const b = S.globalKeymap.sticks[dir];
                                                                if (b) seededKm.sticks[dir] = { keyCode: b.keyCode, label: b.label, vkey: b.vkey };
                                                        }
                                                }
                                                const seeded: any = { ...S.currentEntry, keymap: seededKm };
                                                if (rememberLibrary(seeded)) S.currentEntry = seeded;
                                        }
                                        openKeymapEditor(S.currentEntry);
                                } else {
                                        openKeymapEditor('global');
                                }
                        }
                        if (action === 'quit') {
                                try { quitApp(); }
                                catch (error) {
                                        log(`quitApp threw: ${error instanceof Error ? error.message : String(error)}`);
                                        S.allowExit = true;
                                        try { (Switch as any).exit?.(); } catch { /* best-effort */ }
                                }
                        }
                        if (action === 'direct' && S.debugSettingsValid) {
                                try { const value = !S.directNext; (Switch as any).writeFileSync('sdmc:/switch/burialnx/debug-settings.json', JSON.stringify({ directScreen: value })); S.directNext = value; log('Direct-screen setting saved; restart required.'); }
                                catch (error) { log(`Could not save direct-screen setting: ${String(error)}`); }
                        }
                        if (action === 'snapshot') { log(`Snapshot: scene=${S.runtime.SceneManager?._scene?.constructor?.name || 'unknown'}, fps=${S.fps.toFixed(1)}`); snapshotRuntimeLog(); }
                        if (S.menu.languageCycle !== 0 && S.selectedGame && S.languageEntries.length > 0) {
                                const codes = S.languageEntries.map((e) => e.code).concat(['']);
                                const savedRaw = getGameLanguage(S.selectedGame);
                                const currentCode = savedRaw === undefined ? (S.languageEntries[0]?.code || '') : savedRaw;
                                const currentIdx = Math.max(0, codes.indexOf(currentCode));
                                const dir = S.menu.languageCycle;
                                const nextIdx = (currentIdx + dir + codes.length) % codes.length;
                                const nextCode = codes[nextIdx];
                                setGameLanguage(S.selectedGame, nextCode);
                                try { S.runtime.SoundManager?.playCursor?.(); } catch { /* best-effort */ }
                                S.activeLanguageCode = nextCode;
                                log(`Language set to ${nextCode || 'English (default)'}; applies on next launch.`);
                        }
                        // Mouse-speed slider (pause menu → Another…): apply Left/Right delta and persist.
                        if (S.menu.mouseSpeedDelta !== 0) {
                                S.mouseSpeed = Math.max(1, Math.min(10, S.mouseSpeed + S.menu.mouseSpeedDelta));
                                try { (Switch as any).writeFileSync('sdmc:/switch/burialnx/mouse-settings.json', JSON.stringify({ speed: S.mouseSpeed })); } catch { /* best-effort */ }
                                try { S.runtime.SoundManager?.playCursor?.(); } catch { /* best-effort */ }
                        }
                        // Frame-skip slider (pause menu → Another…): apply Left/Right delta and persist.
                        // 0 = render every dirty frame; 1..10 = skip N frames between renders on stable scenes.
                        if (S.menu.frameSkipDelta !== 0) {
                                S.frameSkip = Math.max(0, Math.min(10, S.frameSkip + S.menu.frameSkipDelta));
                                try { (Switch as any).writeFileSync('sdmc:/switch/burialnx/frame-skip-settings.json', JSON.stringify({ frameSkip: S.frameSkip })); } catch { /* best-effort */ }
                                try { S.runtime.SoundManager?.playCursor?.(); } catch { /* best-effort */ }
                        }
                        S.host?.present();
                        if (S.menu.blocksInput || !S.host?.direct()) hud();
                        // Draw the virtual mouse cursor on top of the game frame + HUD.
                        // Hidden while the pause menu is open (it uses d-pad navigation).
                        if (S.mouseVisible && !S.menu.blocksInput) renderMouseCursor(S.ctx);
                }
                const plusDown = down(9);
                const plusBlocked = S.phase === 'notice' || S.phase === 'rename-kb' || S.phase === 'add-game-name' || S.phase === 'rename-choice' || S.phase === 'forwarder-building' || S.phase === 'loading';
                if (plusDown && !plusBlocked) {
                        const plusQuitLabel = S.exitBehavior === 'restart' ? 'Return to library?' : 'Quit BurialNX?';
                        const activeKeymap = (S.currentEntry?.keymap) || S.globalKeymap;
                        const plusBound = activeKeymap.buttons[9] !== 'none';
                        if (plusBound) {
                                if (S.plusHoldStart === 0) S.plusHoldStart = now;
                                else if (now - S.plusHoldStart >= 500) {
                                        S.exitArmed = true; S.exitArmedAt = Date.now(); S.exitNoticeArmed = true;
                                        S.message = plusQuitLabel;
                                        S.waitForRelease = true; S.phase = 'notice';
                                        S.plusHoldStart = 0;
                                }
                        } else {
                                if (edge(9)) {
                                        S.exitArmed = true; S.exitArmedAt = Date.now(); S.exitNoticeArmed = true;
                                        S.message = plusQuitLabel;
                                        S.waitForRelease = true; S.phase = 'notice';
                                }
                                S.plusHoldStart = 0;
                        }
                } else {
                        S.plusHoldStart = 0;
                }
                for (let index = 0; index < 16; index++) S.previousButtons[index] = !!buttons?.[index]?.pressed;
        } catch (error) { fail(error); }
        requestAnimationFrame(frame);
}

import { setButton, setButtonWithLabel, displayToButtonIndex } from './keymap';
