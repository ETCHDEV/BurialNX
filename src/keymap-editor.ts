/** Keymap editor logic: mutators + touch handler for the keymap page. */
import { S } from './state';
import { log } from './log';
import { PRESETS, applyKeyMap, saveKeyMap, setButtonWithLabel, displayToButtonIndex, type KeyMap, type VirtualKey } from './keymap';
import { getAllPickKeys, KEYBOARD_LAYOUT } from './keymap-layout';
import { keymapBackButtonRect, keymapKeyRect, keymapButtonCellRect, pointInRect } from './keymap-geometry';
import { rememberLibrary } from './selection';
import type { LibraryEntry, LibraryAccess } from './game-library';

declare const __DEBUG__: boolean;

/** Build a MERGED KeyMap: per-game overrides per-button/per-direction, global fills gaps. */
export function mergedKeymap(): KeyMap {
        const per = S.currentEntry?.keymap;
        const base = S.globalKeymap;
        if (!per) return base;
        const buttons: VirtualKey[] = [];
        for (let i = 0; i < 16; i++) buttons[i] = per.buttons[i] ?? base.buttons[i];
        const result: KeyMap = { buttons };
        if (per.labels || base.labels) {
                const labels: string[] = [];
                for (let i = 0; i < 16; i++) labels[i] = per.labels?.[i] ?? base.labels?.[i] ?? '';
                result.labels = labels;
        }
        if (per.keyCodes || base.keyCodes) {
                const keyCodes: number[] = [];
                for (let i = 0; i < 16; i++) keyCodes[i] = per.keyCodes?.[i] ?? base.keyCodes?.[i] ?? 0;
                result.keyCodes = keyCodes;
        }
        const perSticks = per.sticks;
        const baseSticks = base.sticks;
        if (perSticks || baseSticks) {
                const sticks: NonNullable<KeyMap['sticks']> = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = perSticks?.[dir] ?? baseSticks?.[dir];
                        if (b) sticks[dir] = { keyCode: b.keyCode, label: b.label, vkey: b.vkey };
                }
                result.sticks = sticks;
        }
        return result;
}

/** Apply one of the 4 L/ZL/R/ZR presets, preserving stick bindings, then save. */
export function applyPreset(index: number) {
        const preset = PRESETS[index];
        if (!preset) return;
        const savedSticks = S.editingKeymap.sticks;
        S.editingKeymap = { buttons: [...preset.map.buttons] };
        if (savedSticks) {
                S.editingKeymap.sticks = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = savedSticks[dir];
                        if (b) S.editingKeymap.sticks[dir] = { keyCode: b.keyCode, label: b.label, vkey: b.vkey };
                }
        }
        saveEditingKeymap();
        if (__DEBUG__) log(`Applied preset: ${preset.name}`);
}

/** Persist the working keymap to the appropriate target and re-apply if a game is running. */
export function saveEditingKeymap() {
        if (S.keymapTarget === 'global') {
                S.keymapValid = saveKeyMap(Switch as unknown as LibraryAccess, S.editingKeymap);
                if (S.keymapValid) {
                        S.globalKeymap = { buttons: [...S.editingKeymap.buttons] };
                        if (S.editingKeymap.labels) S.globalKeymap.labels = [...S.editingKeymap.labels];
                        if (S.editingKeymap.sticks) S.globalKeymap.sticks = S.editingKeymap.sticks;
                }
        } else if (S.keymapTarget) {
                const entry = S.keymapTarget;
                const newKeymap: KeyMap = { buttons: [...S.editingKeymap.buttons] };
                if (S.editingKeymap.labels) newKeymap.labels = [...S.editingKeymap.labels];
                if (S.editingKeymap.sticks) newKeymap.sticks = S.editingKeymap.sticks;
                const updated: LibraryEntry = { ...entry, keymap: newKeymap };
                if (rememberLibrary(updated)) {
                        if (S.currentEntry && S.currentEntry.id === entry.id) S.currentEntry = updated;
                        S.keymapTarget = updated;
                        S.keymapValid = true;
                } else S.keymapValid = false;
        } else {
                S.keymapValid = false;
        }
        if (S.host && S.runtime?.Input) {
                try {
                        applyKeyMap(S.runtime, mergedKeymap());
                        if (__DEBUG__) log('Keymap re-applied to running game');
                } catch (error) { log(`Could not re-apply keymap: ${String(error)}`); }
        }
}

/** Open the keymap editor for 'global' or a specific library entry. */
export function openKeymapEditor(target: 'global' | LibraryEntry) {
        S.keymapTarget = target;
        const source = target === 'global' ? S.globalKeymap : (target.keymap || S.globalKeymap);
        S.editingKeymap = { buttons: [...source.buttons] };
        if (source.labels) S.editingKeymap.labels = [...source.labels];
        if (source.keyCodes) S.editingKeymap.keyCodes = [...source.keyCodes];
        if (source.sticks) {
                S.editingKeymap.sticks = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = source.sticks[dir];
                        if (b) S.editingKeymap.sticks[dir] = { keyCode: b.keyCode, label: b.label, vkey: b.vkey };
                }
        }
        S.keymapCursor = 0;
        S.waitForRelease = true;
        S.phase = 'keymap';
}

/** Route a single touch tap on the keymap page to the same action as the gamepad A button. */
export function handleKeymapTouch(px: number, py: number): void {
        if (pointInRect(px, py, keymapBackButtonRect())) {
                if (S.keymapPicking) {
                        S.keymapPicking = false;
                        S.waitForRelease = true;
                } else {
                        S.waitForRelease = true;
                        S.phase = S.host ? 'game' : 'library';
                        if (S.host) S.menu.dismiss();
                }
                return;
        }
        if (S.keymapPicking) {
                for (let i = 0; i < KEYBOARD_LAYOUT.length; i++) {
                        const r = keymapKeyRect(i);
                        if (r && pointInRect(px, py, r)) {
                                S.keymapPickCursor = i;
                                const def = getAllPickKeys()[i];
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
                                return;
                        }
                }
        } else {
                for (let i = 0; i < 24; i++) {
                        const r = keymapButtonCellRect(i);
                        if (pointInRect(px, py, r)) {
                                S.keymapCursor = i;
                                S.keymapPicking = true;
                                S.keymapPickCursor = 0;
                                S.waitForRelease = true;
                                return;
                        }
                }
        }
}
