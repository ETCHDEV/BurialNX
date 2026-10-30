/** Keymap page renderers: button grid, keyboard picker, and rename-keyboard preview. */
import { S } from './state';
import { BUTTON_NAMES, displayToButtonIndex, menuButtonIndicesFor, faceButtonLetter, type VirtualKey } from './keymap';
import { mergedKeymap } from './keymap-editor';
import { KEYMAP_COLORS, KEYBOARD_LAYOUT, KEYCODE_TO_VKEY, getAllPickKeys } from './keymap-layout';
import { KEYMAP_GRID_COLS, KEYMAP_CELL_W, KEYMAP_CELL_H, KEYMAP_KB_SCALE, keymapButtonCellRect, keymapKbOrigin, drawBackButton } from './keymap-geometry';

/** Confirm/cancel letters for the active keymap (mirrors the game's ok/cancel mapping). */
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
        S.ctx.fillStyle = '#f4f3ef'; S.ctx.textAlign = 'left';
        S.ctx.fillText('BurialNX — Joycon key bindings', 28, 36);
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.fillText(`Editing: ${targetLabel}`, 28, 60);
        S.ctx.fillText(`D-pad / tap: pick  X: clear  L/R/ZL/ZR: presets  ${menuLetters().cancel} / ← Back: back`, 28, 84);
        drawBackButton(S.ctx);
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
        S.ctx.fillStyle = '#f4f3ef'; S.ctx.textAlign = 'left';
        S.ctx.fillText(`Pick a key for: ${btn}`, 28, 36);
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.fillText(`Current: ${curLabel}  |  ${targetLabel}`, 28, 60);
        S.ctx.fillText(`D-pad / tap: navigate & bind  ${menuLetters().cancel} / ← Back: back`, 28, 84);
        drawBackButton(S.ctx);
        const scale = KEYMAP_KB_SCALE;
        const o = keymapKbOrigin();
        const kbX = o.x, kbY = o.y;
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.textAlign = 'left';
        S.ctx.fillText('Joystick action buttons', 28, kbY + 7.35 * scale);
        for (let i = 0; i < KEYBOARD_LAYOUT.length; i++) {
                const k = KEYBOARD_LAYOUT[i];
                const x = kbX + k.x * scale, y = kbY + k.y * scale;
                const w = k.w * scale - 2, h = k.h * scale - 2;
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

/** Live preview screen while the Switch software keyboard is open. */
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
        const kbHeight = Math.max(0, Math.round(Number(vk?.boundingRect?.height) || 0));
        const boxX = 60, boxW = (screen as any).width - 120, boxH = 92;
        const boxY = kbHeight > 0 ? Math.max(150, (screen as any).height - kbHeight - boxH - 86) : 150;
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.font = '19px sans-serif';
        S.ctx.fillText('Game name', boxX + 4, boxY - 14);
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
        let offset = 0;
        while (offset < caret && S.ctx.measureText(text.slice(offset, caret)).width > inner) offset++;
        S.ctx.fillText(text.slice(offset), boxX + 28, boxY + boxH / 2 + 2);
        const caretX = boxX + 28 + S.ctx.measureText(text.slice(offset, caret)).width;
        S.ctx.fillStyle = '#ff6b6b';
        S.ctx.fillRect(caretX, boxY + boxH / 2 - 22, 3, 44);
        S.ctx.restore();
        S.ctx.textBaseline = 'alphabetic';
        S.ctx.fillStyle = '#6e7681';
        S.ctx.font = '19px sans-serif';
        S.ctx.textAlign = 'center';
        S.ctx.fillText(`${text.length}/${max} characters`, (screen as any).width / 2, boxY + boxH + 32);
        S.ctx.fillText(`${menuLetters().confirm} saves · ${menuLetters().cancel} cancels · (+) does nothing while typing`, (screen as any).width / 2, boxY + boxH + 60);
        S.ctx.restore();
}
