// === Keymap editor logic ============================================
// Extracted from main.ts. The keymap editor's mutators + the touch
// handler for the keymap page. Reads/writes the shared `S` state.
//
// mergedKeymap() — pure read of S.currentEntry?.keymap + S.globalKeymap
//                  that returns the per-game-override-merged KeyMap used
//                  by installGameCompatibility and saveEditingKeymap.
// applyPreset(i) — applies one of the 4 L/ZL/R/ZR presets to the working
//                  keymap, preserving stick bindings, then saves.
// saveEditingKeymap() — persists the working keymap to the appropriate
//                  target (global keymap.json or per-game library entry)
//                  and re-applies it to the running game's gamepadMapper
//                  if a game is currently running.
// openKeymapEditor(target) — opens the editor for 'global' or a specific
//                  library entry, copying every field (buttons, labels,
//                  keyCodes, sticks) into the working copy.
// handleKeymapTouch(px, py) — routes a single touch tap on the keymap
//                  page to the same action as the gamepad A button.

import { S } from './state';
import { log } from './log';
import { PRESETS, applyKeyMap, saveKeyMap, setButtonWithLabel, displayToButtonIndex, type KeyMap, type VirtualKey } from './keymap';
import { getAllPickKeys, KEYBOARD_LAYOUT } from './keymap-layout';
import { keymapBackButtonRect, keymapKeyRect, keymapButtonCellRect, pointInRect } from './keymap-geometry';
import { rememberLibrary } from './selection';
import type { LibraryEntry, LibraryAccess } from './game-library';

declare const __DEBUG__: boolean;

/** Build a MERGED KeyMap: the per-game keymap (if any) takes precedence
 *  per-button/per-direction, and the global default fills every gap.
 *  This is the single source of truth for "what keymap is active right
 *  now" — used by installGameCompatibility (to set gamepadMapper at
 *  launch) and by saveEditingKeymap (to re-apply after an edit).
 *
 *  Without this merge, a per-game keymap that only overrides SOME
 *  buttons/directions would silently drop the global bindings for the
 *  rest — the root cause of the "right stick doesn't fire" bug: the
 *  per-game keymap had left-stick bindings but not right-stick ones,
 *  and the global right-stick bindings were ignored. */
export function mergedKeymap(): KeyMap {
        const per = S.currentEntry?.keymap;
        const base = S.globalKeymap;
        if (!per) return base;
        // Buttons: per-game overrides per index, global fills the rest.
        const buttons: VirtualKey[] = [];
        for (let i = 0; i < 16; i++) buttons[i] = per.buttons[i] ?? base.buttons[i];
        const result: KeyMap = { buttons };
        // Labels: merge — per-game label wins, fall back to global.
        if (per.labels || base.labels) {
                const labels: string[] = [];
                for (let i = 0; i < 16; i++) labels[i] = per.labels?.[i] ?? base.labels?.[i] ?? '';
                result.labels = labels;
        }
        // KeyCodes: merge — per-game keyCode wins, fall back to global.
        if (per.keyCodes || base.keyCodes) {
                const keyCodes: number[] = [];
                for (let i = 0; i < 16; i++) keyCodes[i] = per.keyCodes?.[i] ?? base.keyCodes?.[i] ?? 0;
                result.keyCodes = keyCodes;
        }
        // Sticks: merge per direction.
        const perSticks = per.sticks;
        const baseSticks = base.sticks;
        if (perSticks || baseSticks) {
                const sticks: NonNullable<KeyMap['sticks']> = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = perSticks?.[dir] ?? baseSticks?.[dir];
                        if (b) sticks[dir] = { keyCode: b.keyCode, label: b.label };
                }
                result.sticks = sticks;
        }
        return result;
}

export function applyPreset(index: number) {
        const preset = PRESETS[index];
        if (!preset) return;
        // A preset only redefines the 16 face-button → vkey mappings. It does
        // NOT touch analog-stick bindings (presets don't model sticks), so the
        // user's L/R-stick → keyboard-key bindings survive a preset switch.
        // Without preserving sticks here, applying any preset would silently
        // wipe the user's stick bindings (same root cause as the editor
        // display bug — sticks were dropped on every KeyMap copy).
        const savedSticks = S.editingKeymap.sticks;
        S.editingKeymap = { buttons: [...preset.map.buttons] };
        if (savedSticks) {
                S.editingKeymap.sticks = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = savedSticks[dir];
                        if (b) S.editingKeymap.sticks[dir] = { keyCode: b.keyCode, label: b.label };
                }
        }
        saveEditingKeymap();
        if (__DEBUG__) log(`Applied preset: ${preset.name}`);
}

/** Persist the working keymap to the appropriate target. When editing the
 *  global default, this writes keymap.json; when editing a per-game keymap,
 *  this updates the library entry and writes library.json. If a game is
 *  currently running, the change is applied immediately to runtime.Input
 *  so the user can test the new binding without restarting. */
export function saveEditingKeymap() {
        if (S.keymapTarget === 'global') {
                S.keymapValid = saveKeyMap(Switch as unknown as LibraryAccess, S.editingKeymap);
                if (S.keymapValid) {
                        // CRITICAL: copy labels AND sticks, not just buttons.
                        // Without labels, the editor shows 'ok' instead of the
                        // bound key (e.g. '1', 'W'). Without sticks, analog
                        // stick bindings are lost.
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
                        // Re-apply the MERGED keymap (per-game + global) to the
                        // running game's gamepadMapper, so a change to either the
                        // per-game or global keymap takes effect immediately.
                        applyKeyMap(S.runtime, mergedKeymap());
                        if (__DEBUG__) log('Keymap re-applied to running game');
                } catch (error) { log(`Could not re-apply keymap: ${String(error)}`); }
        }
}

/** Open the keymap editor. If a game is running (host is set), default to
 *  editing the active game's per-game keymap when one exists, otherwise the
 *  global default (which the running game is using). Called from the library
 *  tile, the pause-menu "keymap" entry, or the game-options "Edit keymap". */
export function openKeymapEditor(target: 'global' | LibraryEntry) {
        S.keymapTarget = target;
        const source = target === 'global' ? S.globalKeymap : (target.keymap || S.globalKeymap);
        // Copy buttons, labels, keyCodes AND sticks from the source keymap.
        // Missing any one of these caused display bugs:
        //  - no labels  → editor shows the vkey ('ok') instead of the bound
        //    key label ('1', 'W', 'Enter') — the "bindings reset to ok" bug.
        //  - no sticks   → analog-stick bindings (e.g. L-stick ↑ = arrow key)
        //    work at runtime (pollStickBindings reads currentEntry.keymap /
        //    globalKeymap directly) but the editor grid shows 'none' for every
        //    stick direction, so the user thinks nothing is assigned. This
        //    was the root cause of the "stick bindings don't show in settings"
        //    bug.
        S.editingKeymap = { buttons: [...source.buttons] };
        if (source.labels) S.editingKeymap.labels = [...source.labels];
        if (source.keyCodes) S.editingKeymap.keyCodes = [...source.keyCodes];
        if (source.sticks) {
                // Shallow-clone each stick binding so editing the working copy
                // never mutates the saved source map.
                S.editingKeymap.sticks = {};
                for (const dir of ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const) {
                        const b = source.sticks[dir];
                        if (b) S.editingKeymap.sticks[dir] = { keyCode: b.keyCode, label: b.label };
                }
        }
        S.keymapCursor = 0;
        S.waitForRelease = true;
        S.phase = 'keymap';
}

/** Route a single touch tap on the keymap page to the same action as
 *  the gamepad A button: tap a cell/key = move cursor + confirm in one
 *  motion. Tap the "← Back" button (top-right) = same as the B button.
 *  Tapping anywhere else does nothing — the user must hit a real UI
 *  element, which makes the touch zones unambiguous. */
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
                                                S.editingKeymap.sticks[dir] = { keyCode: def.keyCode || 0, label: def.label };
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
