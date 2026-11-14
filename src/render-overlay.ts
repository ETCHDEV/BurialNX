import { S } from './state';
import { roundedRectPath } from './canvas-utils';
import { menuButtonIndicesFor, faceButtonLetter } from './keymap';
import { mergedKeymap } from './keymap-editor';
import { messageRenderLabel, MESSAGE_RENDER_MODES } from './partial-render';

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
                another: 'Another...', experimental: 'Experimental...',
                more: 'More...', back: 'Back',
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
        // Panel sized to the largest page (Experimental pages have 8 items each; page 2
        // has up to 10 in debug; page 1 has 6).
        const maxItems = 10;
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
        // Indicator X: aligned to the longest label on this page (including the "> " selection
        // prefix), so every bar/tag starts at the same x — no label overlaps its indicator.
        const labelFor: Record<string, string> = {
                mouseSpeed: 'Mouse speed', frameSkip: 'Frame skip', messageRender: 'Message render',
                skipFadeBlur: 'Skip fade blur', skipFadeFill: 'Skip fade fill',
                windowLayerSkip: 'WindowLayer skip', windowBitmapReuse: 'Window Bitmap reuse',
                textureGcIdle: 'Texture GC idle', dirtyRenderSkip: 'Dirty render-skip',
                presentCache: 'Present cache', canvasNodeSkip: 'CanvasNode skip',
                smoothingOff: 'Smoothing off', skipPresent: 'Skip present',
                eventUpdateSkip: 'Event update skip', spriteRenderSkip: 'Sprite render skip',
        };
        let maxLabelW = 0;
        for (let i = 0; i < items.length; i++) {
                const key = items[i] as string;
                const label = labelFor[key] || labels[key] || key;
                // Measure with the "> " prefix (the widest case when selected).
                const w = S.ctx.measureText('> ' + label).width;
                if (w > maxLabelW) maxLabelW = w;
        }
        const indicatorX = panelX + padding + Math.ceil(maxLabelW) + 16;
        const indicatorW = 180;
        for (let i = 0; i < items.length; i++) {
                const isSel = i === S.menu.selected;
                const y = itemsAreaStart + itemsOffset + (i + 1) * itemH;
                S.ctx.fillStyle = isSel ? '#3fb950' : '#c9cdd6';
                const prefix = isSel ? '> ' : '  ';
                if (items[i] === 'mouseSpeed') {
                        S.ctx.fillText(prefix + 'Mouse speed', panelX + padding, y);
                        const barX = indicatorX;
                        const barY = y - 16;
                        const barW = indicatorW;
                        const barH = 14;
                        const filled = Math.round((barW * S.mouseSpeed) / 10);
                        S.ctx.fillStyle = '#3a3f4b';
                        S.ctx.fillRect(barX, barY, barW, barH);
                        S.ctx.fillStyle = '#39d0d8';
                        S.ctx.fillRect(barX, barY, filled, barH);
                        S.ctx.strokeStyle = '#565f8d';
                        S.ctx.lineWidth = 1;
                        S.ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
                        S.ctx.fillStyle = isSel ? '#3fb950' : '#c9cdd6';
                        S.ctx.fillText(`${S.mouseSpeed}/10`, barX + barW + 12, y);
                } else if (items[i] === 'frameSkip') {
                        S.ctx.fillText(prefix + 'Frame skip', panelX + padding, y);
                        const barX = indicatorX;
                        const barY = y - 16;
                        const barW = indicatorW;
                        const barH = 14;
                        const filled = Math.round((barW * S.frameSkip) / 10);
                        S.ctx.fillStyle = '#3a3f4b';
                        S.ctx.fillRect(barX, barY, barW, barH);
                        S.ctx.fillStyle = '#39d0d8';
                        S.ctx.fillRect(barX, barY, filled, barH);
                        S.ctx.strokeStyle = '#565f8d';
                        S.ctx.lineWidth = 1;
                        S.ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
                        S.ctx.fillStyle = isSel ? '#3fb950' : '#c9cdd6';
                        S.ctx.fillText(`${S.frameSkip}/10`, barX + barW + 12, y);
                } else if (items[i] === 'messageRender') {
                        S.ctx.fillText(prefix + 'Message render', panelX + padding, y);
                        const tagX = indicatorX;
                        const tagY = y - 16;
                        const tagW = indicatorW;
                        const tagH = 14;
                        const modeColors: Record<string, string> = { full: '#9aa0b4', 'blink-skip': '#39d0d8' };
                        const idx = MESSAGE_RENDER_MODES.indexOf(S.messageRender);
                        const filled = Math.round((tagW * (idx + 1)) / MESSAGE_RENDER_MODES.length);
                        S.ctx.fillStyle = '#3a3f4b';
                        S.ctx.fillRect(tagX, tagY, tagW, tagH);
                        S.ctx.fillStyle = modeColors[S.messageRender] || '#39d0d8';
                        S.ctx.fillRect(tagX, tagY, filled, tagH);
                        S.ctx.strokeStyle = '#565f8d';
                        S.ctx.lineWidth = 1;
                        S.ctx.strokeRect(tagX + 0.5, tagY + 0.5, tagW - 1, tagH - 1);
                        S.ctx.fillStyle = isSel ? '#3fb950' : '#c9cdd6';
                        S.ctx.fillText(messageRenderLabel(S.messageRender), tagX + tagW + 12, y);
                } else if (items[i] === 'skipFadeBlur' || items[i] === 'skipFadeFill'
                        || items[i] === 'windowLayerSkip' || items[i] === 'windowBitmapReuse'
                        || items[i] === 'textureGcIdle' || items[i] === 'dirtyRenderSkip'
                        || items[i] === 'presentCache' || items[i] === 'canvasNodeSkip'
                        || items[i] === 'smoothingOff' || items[i] === 'skipPresent'
                        || items[i] === 'eventUpdateSkip' || items[i] === 'spriteRenderSkip') {
                        // On/off toggle (A or Left/Right flips; persisted per-game by the frame loop).
                        // See docs/doc/fps-optimizations.md for the patch each one controls.
                        const label = labelFor[items[i] as string] || (items[i] as string);
                        const on = !!(S as any)[items[i] as string];
                        S.ctx.fillText(prefix + label, panelX + padding, y);
                        const tagX = indicatorX;
                        const tagY = y - 16;
                        const tagW = indicatorW;
                        const tagH = 14;
                        // Track background (empty when off; the border shows the track).
                        S.ctx.fillStyle = '#3a3f4b';
                        S.ctx.fillRect(tagX, tagY, tagW, tagH);
                        // ON → fully fill the track green; OFF → leave it empty (no partial fill).
                        if (on) {
                                S.ctx.fillStyle = '#3fb950';
                                S.ctx.fillRect(tagX, tagY, tagW, tagH);
                        }
                        S.ctx.strokeStyle = '#565f8d';
                        S.ctx.lineWidth = 1;
                        S.ctx.strokeRect(tagX + 0.5, tagY + 0.5, tagW - 1, tagH - 1);
                        // Label centered on the track, colored to contrast with the fill.
                        S.ctx.fillStyle = on ? '#0d1117' : (isSel ? '#3fb950' : '#c9cdd6');
                        S.ctx.textAlign = 'center';
                        S.ctx.fillText(on ? 'on' : 'off', tagX + tagW / 2, y);
                        S.ctx.textAlign = 'left';
                } else {
                        S.ctx.fillText(prefix + labels[items[i]], panelX + padding, y);
                }
        }
        // Hint on the Experimental pages (page 3 / 4): tap Minus to close the menu back to
        // the game without navigating to page 1. Gray, right-aligned, bottom-right corner.
        if (S.menu.page === 3 || S.menu.page === 4) {
                S.ctx.fillStyle = '#6e7681';
                S.ctx.font = '14px sans-serif';
                S.ctx.textAlign = 'right'; S.ctx.textBaseline = 'alphabetic';
                S.ctx.fillText("tap '-' to fast close menu", panelX + panelW - padding, panelY + panelH - 6);
                S.ctx.textAlign = 'left';
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
