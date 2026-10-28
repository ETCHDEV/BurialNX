// === Overlay renderers: pause menu, quit dialog, notice popup =========
// Extracted from main.ts. Three modal-style overlay renderers that draw
// centered rounded boxes over the game/library without a full-screen
// background clear (the underlying screen shows through). All read from
// the shared `S` state object; none mutate it.
//
// renderPauseMenu() reads: ctx, menu, exitBehavior, fit, directNext, fps,
//                   activeLanguageCode, languageEntries.
// renderQuitDialog() reads: ctx, message.
// renderNoticePopup() reads: ctx.

import { S } from './state';
import { roundedRectPath } from './canvas-utils';
import { menuButtonIndicesFor, faceButtonLetter } from './keymap';
import { mergedKeymap } from './keymap-editor';

declare const __DEBUG__: boolean;

/** The CONFIRM/CANCEL button letters ('A'/'B') for the active keymap, so
 *  the overlay hints ("A: choose", "B: back", "A: Yes", "B: No", "B: OK")
 *  match whichever button the game actually maps to ok/cancel. Computed
 *  lazily on each render (cheap — two array lookups + a merge). */
function menuLetters(): { confirm: string; cancel: string } {
        try {
                const m = menuButtonIndicesFor(mergedKeymap());
                return { confirm: faceButtonLetter(m.confirm), cancel: faceButtonLetter(m.cancel) };
        } catch { return { confirm: 'A', cancel: 'B' }; }
}

/** Heads-up display: the pause menu when open, or a compact FPS counter
 *  in the top-left when the FPS toggle is on. Called from launch()'s
 *  Graphics.render wrapper every game frame, and from the frame loop
 *  when the host is not in direct-screen mode. */
export function hud() {
        if (S.phase !== 'game') return;
        if (S.menu.open) {
                renderPauseMenu();
        } else if (S.menu.fps) {
                // FPS counter only (compact, top-left, no background).
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

/** Compact pause menu (hold Minus). The background only covers the
 *  menu items, not the full screen — the game is visible around it. */
export function renderPauseMenu(): void {
        if (!S.ctx) return;
        /** Human-readable label for the language currently in use (or 'English' default). */
        function currentLanguageLabel(): string {
                if (!S.activeLanguageCode) return 'English (default)';
                const entry = S.languageEntries.find((e) => e.code === S.activeLanguageCode);
                return entry?.name || S.activeLanguageCode;
        }
        // The last menu item (pause-menu "quit") is labeled from the exit
        // behavior flag armed at launch (see the exitBehavior lifecycle):
        //   - 'shutdown' (forwarder-launched game): the user wants to LEAVE
        //     BurialNX entirely → "Quit BurialNX" (a real exit).
        //   - 'restart' (library-launched game): the user came from the
        //     library grid → "Return to library" (relaunch burialnx.nro
        //     without --game so the grid shows again).
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
        // Top bar (always visible when menu is open). The A/B hints mirror
        // the game's ok/cancel button mapping (see menuLetters()).
        const letters = menuLetters();
        const topBar = `BurialNX  |  Up/Down: select  ${letters.confirm}: choose  ${letters.cancel}: back/close`
                + (S.menu.fps ? `  |  ${S.fps.toFixed(1)} FPS` : '');
        // FIXED panel size — accommodates the larger page (page 2 with
        // 8 items in debug, 6 in release). Using a fixed size means
        // the opaque panel always covers the same screen area, so
        // switching pages doesn't leave ghosting from the old panel.
        // The actual items are vertically CENTERED within the panel.
        const maxItems = __DEBUG__ ? 9 : 7;
        const itemH = 26;
        const topH = 30;
        const padding = 12;
        const panelH = topH + maxItems * itemH + padding * 2;
        const panelW = Math.min(620, (screen as any).width - 80);
        const panelX = Math.floor(((screen as any).width - panelW) / 2);
        const panelY = Math.floor(((screen as any).height - panelH) / 2);
        // Center the actual items between the separator line and the
        // panel bottom (minus padding). This ensures the items column
        // is visually centered in the panel's content area.
        const itemsAreaStart = panelY + padding + topH + 4; // small gap below separator
        const itemsAreaEnd = panelY + panelH - padding;     // panel bottom minus padding
        const itemsAreaH = itemsAreaEnd - itemsAreaStart;
        const actualItemsH = items.length * itemH;
        const itemsOffset = Math.max(0, Math.floor((itemsAreaH - actualItemsH) / 2));
        S.ctx.save();
        S.ctx.setTransform(1, 0, 0, 1, 0, 0);
        S.ctx.globalAlpha = 1;
        S.ctx.globalCompositeOperation = 'source-over';
        // OPAQUE panel background — no full-screen clear needed.
        // The game is visible AROUND the panel (outside its area).
        // The opaque panel covers any previous content underneath.
        S.ctx.fillStyle = '#161823';
        roundedRectPath(S.ctx, panelX, panelY, panelW, panelH, 8);
        S.ctx.fill();
        S.ctx.strokeStyle = '#3a3f4b'; S.ctx.lineWidth = 1;
        S.ctx.stroke();
        // Top bar.
        S.ctx.font = '18px sans-serif';
        S.ctx.fillStyle = '#9aa0b4';
        S.ctx.textAlign = 'left'; S.ctx.textBaseline = 'alphabetic';
        S.ctx.fillText(topBar, panelX + padding, panelY + padding + 18);
        // Separator.
        S.ctx.fillStyle = '#3a3f4b';
        S.ctx.fillRect(panelX + padding, panelY + padding + topH, panelW - padding * 2, 1);
        // Items (vertically centered between separator and panel bottom).
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

/** Centered quit-confirmation dialog. NO background overlay — the game
 *  is fully visible behind the dialog box. */
export function renderQuitDialog(): void {
        if (!S.ctx) return;
        S.ctx.save();
        S.ctx.setTransform(1, 0, 0, 1, 0, 0);
        S.ctx.globalAlpha = 1;
        S.ctx.globalCompositeOperation = 'source-over';
        // NO full-screen overlay — the game shows through.
        // Compact dialog box (centered, opaque).
        const boxW = 440, boxH = 140;
        const boxX = Math.floor(((screen as any).width - boxW) / 2);
        const boxY = Math.floor(((screen as any).height - boxH) / 2);
        S.ctx.fillStyle = '#1f2229';
        roundedRectPath(S.ctx, boxX, boxY, boxW, boxH, 10);
        S.ctx.fill();
        S.ctx.strokeStyle = '#3a3f4b'; S.ctx.lineWidth = 1;
        S.ctx.stroke();
        // Title.
        S.ctx.font = '24px sans-serif';
        S.ctx.fillStyle = '#f4f3ef';
        S.ctx.textAlign = 'center'; S.ctx.textBaseline = 'alphabetic';
        // The title reflects the armed exit mode (set when the notice was
        // armed): "Quit BurialNX?" for a real exit (library grid Quit, or a
        // forwarder-launched game), "Return to library?" for a library-
        // launched game.
        S.ctx.fillText(S.message || 'Quit BurialNX?', (screen as any).width / 2, boxY + 50);
        // Buttons.
        S.ctx.font = '18px sans-serif';
        // The Yes/No hints use the CONFIRM/CANCEL letters so a player who
        // swapped A/B for the game gets the same swap here.
        const letters = menuLetters();
        S.ctx.fillStyle = '#3fb950';
        S.ctx.fillText(`${letters.confirm}: Yes`, (screen as any).width / 2 - 70, boxY + 95);
        S.ctx.fillStyle = '#f85149';
        S.ctx.fillText(`${letters.cancel}: No`, (screen as any).width / 2 + 70, boxY + 95);
        S.ctx.textAlign = 'left';
        S.ctx.restore();
}

/** Small centered popup for success/info notices — same visual style as
 *  renderQuitDialog (compact, centered, opaque rounded box, no full-screen
 *  overlay) but for single-button acknowledgment ("B: OK") instead of a
 *  yes/no question. Replaces the old full-screen `panel(...)` notice that
 *  hid the library/options screen behind a big dark rectangle.
 *
 *  The box auto-sizes to the message: long text (e.g. a forwarder path)
 *  word-wraps to a 480px max line width and the box grows downward, so a
 *  short "Name changed." gets a tidy little box while a long build result
 *  still fits without overflowing the screen.
 *
 *  The underlying screen shows through — the game keeps rendering during a
 *  game session, and for the library/game-options the previous frame's
 *  content is retained (those screens are static, so the stale frame reads
 *  as the real background). */
export function renderNoticePopup(msg: string): void {
        if (!S.ctx) return;
        S.ctx.save();
        S.ctx.setTransform(1, 0, 0, 1, 0, 0);
        S.ctx.globalAlpha = 1;
        S.ctx.globalCompositeOperation = 'source-over';
        // Word-wrap the message so long notices (forwarder paths, multi-
        // sentence results) stay on screen. Use most of the screen width.
        const maxLineWidth = (screen as any).width - 80;
        S.ctx.font = '22px sans-serif';
        S.ctx.textBaseline = 'alphabetic';
        // Split by whitespace, but also break long paths at '/' so a single
        // path like sdmc:/switch/The_Coffin_of_Andy_and_Leyley/The_Coffin_of_Andy_and_Leyley.nro
        // wraps across multiple lines instead of overflowing.
        const words = (msg || '').split(/\s+/).filter(Boolean);
        const lines: string[] = [];
        let line = '';
        const flush = () => { if (line) { lines.push(line); line = ''; } };
        for (const w of words) {
                // If the word itself is wider than maxLineWidth, break it at '/'
                // or '_' boundaries so long paths wrap nicely.
                if (S.ctx.measureText(w).width > maxLineWidth) {
                        if (line) { flush(); }
                        let chunk = '';
                        for (let i = 0; i < w.length; i++) {
                                const ch = w[i];
                                const test = chunk + ch;
                                if (S.ctx.measureText(test).width > maxLineWidth && chunk) {
                                        // Break after '/' so the next chunk starts cleanly.
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
        // Box geometry — auto-size to the wrapped text.
        const padX = 36, padTop = 30, lineH = 28, btnH = 44;
        let maxW = 0;
        for (const l of lines) { const lw = S.ctx.measureText(l).width; if (lw > maxW) maxW = lw; }
        const boxW = Math.max(300, Math.min(maxW + padX * 2, maxLineWidth + padX * 2));
        const boxH = padTop + lines.length * lineH + btnH;
        const boxX = Math.floor(((screen as any).width - boxW) / 2);
        const boxY = Math.floor(((screen as any).height - boxH) / 2);
        // Box (opaque, rounded, subtle border — same palette as renderQuitDialog).
        S.ctx.fillStyle = '#1f2229';
        roundedRectPath(S.ctx, boxX, boxY, boxW, boxH, 12);
        S.ctx.fill();
        S.ctx.strokeStyle = '#3a3f4b'; S.ctx.lineWidth = 1;
        S.ctx.stroke();
        // Thin green accent bar on the left edge — a quiet "success/info"
        // cue that matches the 'ok' color used throughout the keymap UI.
        S.ctx.fillStyle = '#3fb950';
        S.ctx.fillRect(boxX, boxY + 12, 4, boxH - 24);
        // Message lines (centered).
        S.ctx.fillStyle = '#f4f3ef';
        S.ctx.textAlign = 'center';
        const textTop = boxY + padTop + 18;
        for (let i = 0; i < lines.length; i++) {
                S.ctx.fillText(lines[i], boxX + boxW / 2, textTop + i * lineH);
        }
        // Dismiss hint (centered, green). Use the CONFIRM letter — a
        // success/info notice is dismissed by the same button the game
        // uses for 'ok' (both confirm and cancel dismiss a non-exit
        // notice, but the hint reads more naturally as confirm/OK).
        const letters = menuLetters();
        S.ctx.font = '18px sans-serif';
        S.ctx.fillStyle = '#3fb950';
        S.ctx.fillText(`${letters.confirm}: OK`, boxX + boxW / 2, boxY + boxH - 16);
        S.ctx.textAlign = 'left';
        S.ctx.restore();
}
