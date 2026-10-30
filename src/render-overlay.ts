import { S } from './state';
import { roundedRectPath } from './canvas-utils';
import { menuButtonIndicesFor, faceButtonLetter } from './keymap';
import { mergedKeymap } from './keymap-editor';

declare const __DEBUG__: boolean;

/** CONFIRM/CANCEL button letters for the active keymap. */
function menuLetters(): { confirm: string; cancel: string } {
        try {
                const m = menuButtonIndicesFor(mergedKeymap());
                return { confirm: faceButtonLetter(m.confirm), cancel: faceButtonLetter(m.cancel) };
        } catch { return { confirm: 'A', cancel: 'B' }; }
}

/** Heads-up display: pause menu when open, else a compact FPS counter. */
export function hud() {
        if (S.phase !== 'game') return;
        if (S.menu.open) {
                renderPauseMenu();
        } else if (S.menu.fps) {
                S.ctx.save();
                S.ctx.setTransform(1, 0, 0, 1, 0, 0);
                S.ctx.globalAlpha = 1;
                S.ctx.globalCompositeOperation = 'source-over';
                S.ctx.font = '18px sans-serif';
                S.ctx.fillStyle = '#3fb950';
                S.ctx.textAlign = 'left'; S.ctx.textBaseline = 'alphabetic';
                S.ctx.fillText(`${S.fps.toFixed(1)} FPS`, 28, 28);
                S.ctx.restore();
        }
}

/** Compact pause menu (hold Minus); background covers only the items. */
export function renderPauseMenu(): void {
        if (!S.ctx) return;
        function currentLanguageLabel(): string {
                if (!S.activeLanguageCode) return 'English (default)';
                const entry = S.languageEntries.find((e) => e.code === S.activeLanguageCode);
                return entry?.name || S.activeLanguageCode;
        }
        const quitLabel = S.exitBehavior === 'restart' ? 'Return to library' : 'Quit BurialNX';
        const labels: Record<string, string> = {
                continue: 'Resume', save: 'Save', load: 'Load',
                keymap: 'Edit joycon key bindings',
                another: 'Another...', back: 'Back',
                quit: quitLabel,
                saves: 'Choose save location', import: 'Import Steam saves',
                resolution: `Display: ${S.fit ? 'fit' : 'native'}`,
                fps: `FPS: ${S.menu.fps ? 'on' : 'off'}`,
                mod: 'Select mod for next launch',
                direct: `Direct screen: ${S.directNext ? 'on' : 'off'}`,
                snapshot: 'Diagnostic snapshot',
                language: `Language: ${currentLanguageLabel()}`,
        };
        const items = S.menu.currentItems;
        const letters = menuLetters();
        const topBar = `BurialNX  |  Up/Down: select  ${letters.confirm}: choose  ${letters.cancel}: back/close`
                + (S.menu.fps ? `  |  ${S.fps.toFixed(1)} FPS` : '');
        const maxItems = __DEBUG__ ? 9 : 7;
        const itemH = 26;
        const topH = 30;
        const padding = 12;
        const panelH = topH + maxItems * itemH + padding * 2;
        const panelW = Math.min(620, (screen as any).width - 80);
        const panelX = Math.floor(((screen as any).width - panelW) / 2);
        const panelY = Math.floor(((screen as any).height - panelH) / 2);
        const itemsAreaStart = panelY + padding + topH + 4;
        const itemsAreaEnd = panelY + panelH - padding;
        const itemsAreaH = itemsAreaEnd - itemsAreaStart;
        const actualItemsH = items.length * itemH;
        const itemsOffset = Math.max(0, Math.floor((itemsAreaH - actualItemsH) / 2));
        S.ctx.save();
        S.ctx.setTransform(1, 0, 0, 1, 0, 0);
        S.ctx.globalAlpha = 1;
        S.ctx.globalCompositeOperation = 'source-over';
        S.ctx.fillStyle = '#161823';
        roundedRectPath(S.ctx, panelX, panelY, panelW, panelH, 8);
        S.ctx.fill();
        S.ctx.strokeStyle = '#3a3f4b'; S.ctx.lineWidth = 1;
        S.ctx.stroke();
        S.ctx.font = '18px sans-serif';
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.textAlign = 'left'; S.ctx.textBaseline = 'alphabetic';
        S.ctx.fillText(topBar, panelX + padding, panelY + padding + 18);
        S.ctx.fillStyle = '#3a3f4b';
        S.ctx.fillRect(panelX + padding, panelY + padding + topH, panelW - padding * 2, 1);
        S.ctx.font = '22px sans-serif';
        for (let i = 0; i < items.length; i++) {
                const isSel = i === S.menu.selected;
                const y = itemsAreaStart + itemsOffset + (i + 1) * itemH;
                S.ctx.fillStyle = isSel ? '#3fb950' : '#c9cdd6';
                const prefix = isSel ? '> ' : '  ';
                S.ctx.fillText(prefix + labels[items[i]], panelX + padding, y);
        }
        S.ctx.restore();
}

/** Centered quit-confirmation dialog with no background overlay. */
export function renderQuitDialog(): void {
        if (!S.ctx) return;
        S.ctx.save();
        S.ctx.setTransform(1, 0, 0, 1, 0, 0);
        S.ctx.globalAlpha = 1;
        S.ctx.globalCompositeOperation = 'source-over';
        const boxW = 440, boxH = 140;
        const boxX = Math.floor(((screen as any).width - boxW) / 2);
        const boxY = Math.floor(((screen as any).height - boxH) / 2);
        S.ctx.fillStyle = '#1f2229';
        roundedRectPath(S.ctx, boxX, boxY, boxW, boxH, 10);
        S.ctx.fill();
        S.ctx.strokeStyle = '#3a3f4b'; S.ctx.lineWidth = 1;
        S.ctx.stroke();
        S.ctx.font = '24px sans-serif';
        S.ctx.fillStyle = '#f4f3ef';
        S.ctx.textAlign = 'center'; S.ctx.textBaseline = 'alphabetic';
        S.ctx.fillText(S.message || 'Quit BurialNX?', (screen as any).width / 2, boxY + 50);
        S.ctx.font = '18px sans-serif';
        const letters = menuLetters();
        S.ctx.fillStyle = '#3fb950';
        S.ctx.fillText(`${letters.confirm}: Yes`, (screen as any).width / 2 - 70, boxY + 95);
        S.ctx.fillStyle = '#f85149';
        S.ctx.fillText(`${letters.cancel}: No`, (screen as any).width / 2 + 70, boxY + 95);
        S.ctx.textAlign = 'left';
        S.ctx.restore();
}

/** Centered auto-sized success/info popup with a "B: OK" dismiss hint. */
export function renderNoticePopup(msg: string): void {
        if (!S.ctx) return;
        S.ctx.save();
        S.ctx.setTransform(1, 0, 0, 1, 0, 0);
        S.ctx.globalAlpha = 1;
        S.ctx.globalCompositeOperation = 'source-over';
        const maxLineWidth = (screen as any).width - 80;
        S.ctx.font = '22px sans-serif';
        S.ctx.textBaseline = 'alphabetic';
        const words = (msg || '').split(/\s+/).filter(Boolean);
        const lines: string[] = [];
        let line = '';
        const flush = () => { if (line) { lines.push(line); line = ''; } };
        for (const w of words) {
                if (S.ctx.measureText(w).width > maxLineWidth) {
                        if (line) { flush(); }
                        let chunk = '';
                        for (let i = 0; i < w.length; i++) {
                                const ch = w[i];
                                const test = chunk + ch;
                                if (S.ctx.measureText(test).width > maxLineWidth && chunk) {
                                        if (chunk.endsWith('/')) { lines.push(chunk); chunk = ch; }
                                        else { lines.push(chunk); chunk = ch; }
                                } else {
                                        chunk = test;
                                }
                        }
                        if (chunk) { line = chunk; }
                        flush();
                        continue;
                }
                const test = line ? line + ' ' + w : w;
                if (S.ctx.measureText(test).width > maxLineWidth && line) {
                        flush();
                        line = w;
                } else {
                        line = test;
                }
        }
        flush();
        if (!lines.length) lines.push('');
        const padX = 36, padTop = 30, lineH = 28, btnH = 44;
        let maxW = 0;
        for (const l of lines) { const lw = S.ctx.measureText(l).width; if (lw > maxW) maxW = lw; }
        const boxW = Math.max(300, Math.min(maxW + padX * 2, maxLineWidth + padX * 2));
        const boxH = padTop + lines.length * lineH + btnH;
        const boxX = Math.floor(((screen as any).width - boxW) / 2);
        const boxY = Math.floor(((screen as any).height - boxH) / 2);
        S.ctx.fillStyle = '#1f2229';
        roundedRectPath(S.ctx, boxX, boxY, boxW, boxH, 12);
        S.ctx.fill();
        S.ctx.strokeStyle = '#3a3f4b'; S.ctx.lineWidth = 1;
        S.ctx.stroke();
        S.ctx.fillStyle = '#3fb950';
        S.ctx.fillRect(boxX, boxY + 12, 4, boxH - 24);
        S.ctx.fillStyle = '#f4f3ef';
        S.ctx.textAlign = 'center';
        const textTop = boxY + padTop + 18;
        for (let i = 0; i < lines.length; i++) {
                S.ctx.fillText(lines[i], boxX + boxW / 2, textTop + i * lineH);
        }
        const letters = menuLetters();
        S.ctx.font = '18px sans-serif';
        S.ctx.fillStyle = '#3fb950';
        S.ctx.fillText(`${letters.confirm}: OK`, boxX + boxW / 2, boxY + boxH - 16);
        S.ctx.textAlign = 'left';
        S.ctx.restore();
}
