// === Loading progress bar ============================================
// Extracted from main.ts. Owns the loading-screen state (label, subtext,
// progress, title) and the three accessors used by launch() and the
// forwarder builder to drive the centered progress bar. The bar replaces
// the old top-left text panel ("BurialNX / Opening game…") and is also
// reused while building a forwarder NRO.
//
//  - loadingLabel: short human line under the bar ("Loading scripts 3/47…")
//  - loadingProgress: 0..1 (clamped). NaN/Infinity is treated as 0.
//  - loadingTitle: title shown above the bar (defaults to "BurialNX")
//  - loadingSubtext: optional small grey line under the label (e.g. the
//    path of the script currently being loaded).

import { roundedRectPath } from './canvas-utils';
import { debugLines, log } from './log';

declare const __DEBUG__: boolean;

let loadingLabel = '';
let loadingSubtext = '';
let loadingProgress = 0;
let loadingTitle = 'BurialNX';

/** Update the loading screen state. The frame loop picks these up and
 *  renders the bar on the next vsync. `progress` is clamped to [0,1]. */
export function setLoadingProgress(progress: number, label?: string, subtext?: string) {
	if (Number.isFinite(progress)) loadingProgress = Math.max(0, Math.min(1, progress));
	if (label !== undefined) loadingLabel = label;
	if (subtext !== undefined) loadingSubtext = subtext;
}

/** Reset the loading screen to its initial state for a new operation. */
export function resetLoading(title = 'BurialNX', initialLabel = 'Starting…') {
	loadingTitle = title; loadingLabel = initialLabel; loadingSubtext = ''; loadingProgress = 0;
}

/** Draw the centered loading screen. Renders over whatever the game/host
 *  had on screen so the user sees a clean transition into the launch. */
export function renderLoading(ctx: CanvasRenderingContext2D | null) {
	if (!ctx) return;
	try {
		ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
		ctx.fillStyle = '#161823'; ctx.fillRect(0, 0, (screen as any).width, (screen as any).height);
		const cx = (screen as any).width / 2;
		// Title
		ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
		ctx.fillStyle = '#f4f3ef'; ctx.font = '34px sans-serif';
		ctx.fillText(loadingTitle, cx, (screen as any).height / 2 - 80);
		// Label (current stage)
		ctx.fillStyle = '#c9cdd6'; ctx.font = '22px sans-serif';
		ctx.fillText(loadingLabel, cx, (screen as any).height / 2 + 60);
		// Subtext (e.g. script path)
		if (loadingSubtext) {
			ctx.fillStyle = '#6e7681'; ctx.font = '18px sans-serif';
			// Truncate the subtext to fit within ~80% of the screen width.
			const maxW = (screen as any).width * 0.8;
			let text = loadingSubtext;
			if (ctx.measureText(text).width > maxW) {
				let lo = 0, hi = text.length;
				while (lo < hi) {
					const mid = (lo + hi + 1) >> 1;
					if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
				}
				text = text.slice(0, lo) + '…';
			}
			ctx.fillText(text, cx, (screen as any).height / 2 + 88);
		}
		// Progress bar: a rounded-rectangle track + filled portion + %.
		const barW = Math.min(820, (screen as any).width - 160);
		const barH = 26;
		const barX = ((screen as any).width - barW) / 2;
		const barY = (screen as any).height / 2 - 24;
		const radius = Math.max(2, Math.min(barH / 2, 13));
		// Track (outline)
		ctx.lineWidth = 2; ctx.strokeStyle = '#3a3f4b'; ctx.fillStyle = '#1f2229';
		roundedRectPath(ctx, barX, barY, barW, barH, radius);
		ctx.fill(); ctx.stroke();
		// Fill
		const fillW = Math.max(0, Math.min(barW - 4, (barW - 4) * loadingProgress));
		if (fillW > 0) {
			ctx.fillStyle = '#3fb950';
			// Inset by 2px on each side so the track stays visible.
			roundedRectPath(ctx, barX + 2, barY + 2, fillW, barH - 4, Math.max(2, radius - 2));
			ctx.fill();
		}
		// Percentage text, centered inside the bar
		ctx.fillStyle = '#f4f3ef'; ctx.font = '18px sans-serif'; ctx.textBaseline = 'middle';
		const pct = `${Math.round(loadingProgress * 100)}%`;
		ctx.fillText(pct, cx, barY + barH / 2 + 1);
		ctx.textBaseline = 'alphabetic';
		// Debug lines, if any, in the top-left corner so devs still get
		// diagnostics without losing the new bar UI.
		if (__DEBUG__ && debugLines.length) {
			ctx.textAlign = 'left'; ctx.fillStyle = '#6e7681'; ctx.font = '16px sans-serif';
			let y = 24;
			for (const line of debugLines.slice(-12)) { ctx.fillText(line, 20, y); y += 20; }
		}
		ctx.restore();
	} catch (error) { log(`_loading: renderLoading failed: ${error instanceof Error ? error.message : String(error)}`); }
}
