// === Keymap page renderers ===========================================
// Extracted from main.ts. Two-phase key remap UI inspired by autorun's
// launcher_input.c:
//   Phase 1 (button grid): 4×4 grid of joycon buttons with their current
//     bindings. User navigates with D-pad, presses A to edit a button.
//   Phase 2 (keyboard+mouse): visual PC keyboard + mouse. User navigates
//     with D-pad, presses A to bind the selected key to the joycon button
//     from phase 1. Press B to go back to phase 1.
//
// IMPORTANT: nx.js allocates ~2MB per ctx.font assignment. Both renderers
// set ctx.font EXACTLY ONCE and never change it. Visual variety comes from
// fillStyle (colors) only.
//
// Reads from S: ctx, keymapTarget, keymapPicking, keymapCursor,
//                keymapPickCursor, editingKeymap, keymapValid, phase,
//                addGamePath, addGameDefaultName, addGamePreview,
//                renamePreview, currentEntry.
// Does NOT mutate S.

import { S } from './state';
import { BUTTON_NAMES, displayToButtonIndex, menuButtonIndicesFor, faceButtonLetter, type VirtualKey } from './keymap';
import { mergedKeymap } from './keymap-editor';
import { KEYMAP_COLORS, KEYBOARD_LAYOUT, KEYCODE_TO_VKEY, getAllPickKeys } from './keymap-layout';
import { KEYMAP_GRID_COLS, KEYMAP_CELL_W, KEYMAP_CELL_H, KEYMAP_KB_SCALE, keymapButtonCellRect, keymapKbOrigin, drawBackButton } from './keymap-geometry';

/** The CONFIRM/CANCEL button letters for the active keymap, so the keymap
 *  editor's hints ("A: bind", "B: back") mirror the game's ok/cancel
 *  mapping — same as every other loader screen. */
function menuLetters(): { confirm: string; cancel: string } {
        try {
                const m = menuButtonIndicesFor(mergedKeymap());
                return { confirm: faceButtonLetter(m.confirm), cancel: faceButtonLetter(m.cancel) };
        } catch { return { confirm: 'A', cancel: 'B' }; }
}

export function renderKeymap() {
        const targetLabel = S.keymapTarget === 'global' ? 'GLOBAL DEFAULT' : (S.keymapTarget ? `PER-GAME: ${S.keymapTarget.name}` : '(none)');
        S.ctx.save();
        S.ctx.setTransform(1, 0, 0, 1, 0, 0);
        S.ctx.globalAlpha = 1;
        S.ctx.fillStyle = '#161823';
        S.ctx.fillRect(0, 0, (screen as any).width, (screen as any).height);
        // Set the font EXACTLY ONCE for the entire function.
        S.ctx.font = '20px sans-serif';
        S.ctx.textBaseline = 'alphabetic';

        if (S.keymapPicking) {
                renderKeyboardPicker(targetLabel);
        } else {
                renderButtonGrid(targetLabel);
        }
        S.ctx.restore();
}

function renderButtonGrid(targetLabel: string) {
        // Header
        S.ctx.fillStyle = '#f4f3ef'; S.ctx.textAlign = 'left';
        S.ctx.fillText('BurialNX — Joycon key bindings', 28, 36);
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.fillText(`Editing: ${targetLabel}`, 28, 60);
        S.ctx.fillText(`D-pad / tap: pick  X: clear  L/R/ZL/ZR: presets  ${menuLetters().cancel} / ← Back: back`, 28, 84);
        // Back button (also a touch target).
        drawBackButton(S.ctx);
        // Grid: 4 columns × 6 rows = 24 entries (16 buttons + 8 stick dirs).
        // Smaller cells to fit 6 rows on screen.
        const cols = KEYMAP_GRID_COLS;
        const totalEntries = 24;
        const stickNames = ['L↑', 'L↓', 'L←', 'L→', 'R↑', 'R↓', 'R←', 'R→'];
        const stickDirs = ['lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight'] as const;
        const cellW = KEYMAP_CELL_W, cellH = KEYMAP_CELL_H;
        for (let i = 0; i < totalEntries; i++) {
                const rect = keymapButtonCellRect(i);
                const x = rect.x, y = rect.y;
                const selected = i === S.keymapCursor;
                const isStick = i >= 16;
                // Get the display label and color.
                let displayLabel: string;
                let color: string;
                if (isStick) {
                        const dir = stickDirs[i - 16];
                        const binding = S.editingKeymap.sticks?.[dir];
                        displayLabel = binding ? binding.label : 'none';
                        color = KEYMAP_COLORS[displayLabel as VirtualKey] || '#6e7681';
                } else {
                        const btnIdx = displayToButtonIndex(i);
                        const key = S.editingKeymap.buttons[btnIdx];
                        displayLabel = S.editingKeymap.labels?.[btnIdx] || key;
                        color = KEYMAP_COLORS[key] || '#6e7681';
                }
                S.ctx.fillStyle = selected ? '#3a3f5c' : '#252840';
                S.ctx.fillRect(x, y, cellW, cellH);
                S.ctx.fillStyle = color;
                S.ctx.fillRect(x, y, 6, cellH);
                S.ctx.strokeStyle = selected ? '#f4f3ef' : '#3a3f5c';
                S.ctx.lineWidth = selected ? 3 : 1;
                S.ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
                S.ctx.fillStyle = '#f4f3ef'; S.ctx.textAlign = 'left';
                const name = isStick ? stickNames[i - 16] : BUTTON_NAMES[displayToButtonIndex(i)];
                S.ctx.fillText(name, x + 16, y + 24);
                S.ctx.fillStyle = color; S.ctx.textAlign = 'center';
                S.ctx.fillText(displayLabel, x + cellW / 2, y + cellH / 2 + 16);
                S.ctx.fillStyle = '#6e7681'; S.ctx.textAlign = 'left';
                S.ctx.fillText(`#${displayToButtonIndex(i)}`, x + 12, y + cellH - 8);
        }
        // Footer
        S.ctx.fillStyle = '#9aa0b4'; S.ctx.textAlign = 'left';
        S.ctx.fillText(`Status: ${S.keymapValid ? 'saved' : 'unsaved'}`, 28, (screen as any).height - 20);
}

function renderKeyboardPicker(targetLabel: string) {
        const isStick = S.keymapCursor >= 16;
        const stickNames = ['L↑', 'L↓', 'L←', 'L→', 'R↑', 'R↓', 'R←', 'R→'];
        const btn = isStick ? stickNames[S.keymapCursor - 16] : BUTTON_NAMES[displayToButtonIndex(S.keymapCursor)];
        const stickDirs = ['lUp', 'lDown', 'lLeft', 'lRight', 'rUp', 'rDown', 'rLeft', 'rRight'] as const;
        let curLabel: string;
        if (isStick) {
                const dir = stickDirs[S.keymapCursor - 16];
                curLabel = S.editingKeymap.sticks?.[dir]?.label || 'none';
        } else {
                const btnIdx = displayToButtonIndex(S.keymapCursor);
                const curKey = S.editingKeymap.buttons[btnIdx];
                curLabel = S.editingKeymap.labels?.[btnIdx] || curKey;
        }
        // Header
        S.ctx.fillStyle = '#f4f3ef'; S.ctx.textAlign = 'left';
        S.ctx.fillText(`Pick a key for: ${btn}`, 28, 36);
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.fillText(`Current: ${curLabel}  |  ${targetLabel}`, 28, 60);
        S.ctx.fillText(`D-pad / tap: navigate & bind  ${menuLetters().cancel} / ← Back: back`, 28, 84);
        // Back button (also a touch target).
        drawBackButton(S.ctx);
        // Keyboard area: centered horizontally AND vertically, scale=55px per key unit.
        // The layout now spans y=0..9.7 (keyboard rows 0..5.3 + a 1.4-unit
        // doubled gap + 2 rows of virtual-key buttons at y=7.7 and y=8.7,
        // each h=1). kbMaxH accounts for the extra rows so the whole grid
        // stays vertically centered instead of being pushed against the top.
        const scale = KEYMAP_KB_SCALE;
        const o = keymapKbOrigin();
        const kbX = o.x, kbY = o.y;
        // Section label for the joystick-action row, drawn in the gap
        // between the keyboard bottom (y=6.3) and vkey row 1 (y=7.7).
        // Left-aligned at x=28 like the top headers (Current:…, D-pad:…)
        // and placed 0.35 units above vkey row 1 so it visually attaches
        // to the section it labels.
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.textAlign = 'left';
        S.ctx.fillText('Joystick action buttons', 28, kbY + 7.35 * scale);
        // Draw all keyboard keys
        for (let i = 0; i < KEYBOARD_LAYOUT.length; i++) {
                const k = KEYBOARD_LAYOUT[i];
                const x = kbX + k.x * scale, y = kbY + k.y * scale;
                const w = k.w * scale - 2, h = k.h * scale - 2;
                // Virtual-key buttons (keyCode=-1) are colored by their
                // OWN label — e.g. the "ok" button gets the green 'ok'
                // color. Regular keyboard keys are colored by their
                // keyCode → vkey mapping (e.g. keyCode 13 → 'ok' → green).
                let vkey: VirtualKey;
                if (k.keyCode === -1) {
                        vkey = k.label as VirtualKey;
                } else {
                        vkey = KEYCODE_TO_VKEY[k.keyCode] || 'none';
                }
                const color = KEYMAP_COLORS[vkey] || '#6e7681';
                const selected = i === S.keymapPickCursor;
                S.ctx.fillStyle = selected ? '#3a3f5c' : '#252840';
                S.ctx.fillRect(x, y, w, h);
                S.ctx.fillStyle = color;
                S.ctx.fillRect(x, y, 4, h);
                S.ctx.strokeStyle = selected ? '#f4f3ef' : '#3a3f5c';
                S.ctx.lineWidth = selected ? 2 : 1;
                S.ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
                S.ctx.fillStyle = '#f4f3ef'; S.ctx.textAlign = 'center';
                S.ctx.fillText(k.label, x + w / 2, y + h / 2 + 7);
        }
        S.ctx.textAlign = 'left';
}

/** Live preview screen while the Switch software keyboard is open. The
 *  inline swkbd does not render the typed text itself, so this field is the
 *  only place the player sees the current name. The text is re-read from the
 *  keyboard EVERY FRAME (vk.value / vk.cursorIndex — nx.js keeps them current
 *  via the native swkbd callbacks), so the preview updates even if a
 *  "change" event is missed; the listeners only keep `renamePreview` warm
 *  for runtimes where the keyboard object is opaque.
 *  The field is anchored directly above the REAL keyboard rectangle
 *  (vk.boundingRect, filled by show() from the applet's touch rectangles),
 *  so it visually reads as "the field this keyboard types into". Without
 *  geometry the field falls back to a fixed top band that no swkbd layout
 *  ever covers. */
export function renderRenameKb() {
        const vk = (navigator as any).virtualKeyboard;
        const isAddGame = S.phase === 'add-game-name';
        const text = typeof vk?.value === 'string' ? vk.value : (isAddGame ? S.addGamePreview : S.renamePreview);
        const caret = Math.max(0, Math.min(text.length, Number(vk?.cursorIndex) || 0));
        const max = Number(vk?.maxLength) || 64;
        const oldName = isAddGame ? S.addGameDefaultName : (S.currentEntry?.name ?? '');
        S.ctx.save();
        S.ctx.setTransform(1, 0, 0, 1, 0, 0);
        S.ctx.globalAlpha = 1;
        S.ctx.fillStyle = '#161823';
        S.ctx.fillRect(0, 0, (screen as any).width, (screen as any).height);
        S.ctx.textAlign = 'left';
        S.ctx.textBaseline = 'alphabetic';
        S.ctx.fillStyle = '#f4f3ef';
        S.ctx.font = '24px sans-serif';
        S.ctx.fillText(isAddGame ? 'BurialNX — name game' : 'BurialNX — rename game', 28, 44);
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.font = '20px sans-serif';
        S.ctx.fillText(isAddGame
                ? `Adding game from: ${S.addGamePath}. Type a name below.`
                : (oldName ? `Renaming "${oldName}". Type below — your text appears in this field as you type.` : 'Type below — your text appears in this field as you type.'), 28, 78);
        // Geometry: the applet reports its touch rectangles in show(), so the
        // height is real hardware data. The keyboard hugs the bottom edge;
        // anchor the input field just above it (counter + hint below the
        // field, hint above the keys). Fallback: fixed band at y=150.
        const kbHeight = Math.max(0, Math.round(Number(vk?.boundingRect?.height) || 0));
        const boxX = 60, boxW = (screen as any).width - 120, boxH = 92;
        const boxY = kbHeight > 0 ? Math.max(150, (screen as any).height - kbHeight - boxH - 86) : 150;
        // Field label.
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.font = '19px sans-serif';
        S.ctx.fillText('Game name', boxX + 4, boxY - 14);
        // The input field itself — big and high contrast.
        S.ctx.fillStyle = '#252840';
        S.ctx.fillRect(boxX, boxY, boxW, boxH);
        S.ctx.strokeStyle = '#565f8d';
        S.ctx.lineWidth = 3;
        S.ctx.strokeRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2);
        S.ctx.save();
        S.ctx.beginPath();
        S.ctx.rect(boxX + 4, boxY + 4, boxW - 8, boxH - 8);
        S.ctx.clip();
        S.ctx.font = '34px sans-serif';
        S.ctx.fillStyle = '#f4f3ef';
        S.ctx.textBaseline = 'middle';
        const inner = boxW - 72;
        // Scroll the text so the caret stays visible in long names.
        let offset = 0;
        while (offset < caret && S.ctx.measureText(text.slice(offset, caret)).width > inner) offset++;
        S.ctx.fillText(text.slice(offset), boxX + 28, boxY + boxH / 2 + 2);
        const caretX = boxX + 28 + S.ctx.measureText(text.slice(offset, caret)).width;
        S.ctx.fillStyle = '#ff6b6b';
        S.ctx.fillRect(caretX, boxY + boxH / 2 - 22, 3, 44);
        S.ctx.restore();
        // Counter and controls, between the field and the keyboard.
        S.ctx.textBaseline = 'alphabetic';
        S.ctx.fillStyle = '#6e7681';
        S.ctx.font = '19px sans-serif';
        S.ctx.textAlign = 'center';
        S.ctx.fillText(`${text.length}/${max} characters`, (screen as any).width / 2, boxY + boxH + 32);
        S.ctx.fillText(`${menuLetters().confirm} saves · ${menuLetters().cancel} cancels · (+) does nothing while typing`, (screen as any).width / 2, boxY + boxH + 60);
        S.ctx.restore();
}
