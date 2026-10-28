// === Canvas + text utilities ==========================================
// Small pure helpers shared by the loader's render functions. Extracted
// from main.ts to reduce the 4000-line file's surface area.
//
// `roundedRectPath` traces a rounded-rectangle path on the supplied 2D
// context (nx.js's canvas does not expose ctx.roundRect, so we approximate
// it with quadratic curves, matching the WHATWG roundRect proposal).
// `truncateForDisplay` truncates a string to a max length with an ellipsis.

/** Trace a rounded-rectangle path on the supplied 2D context. nx.js's canvas
 *  does not expose ctx.roundRect, so we approximate it with quadratic curves
 *  (matches the Geometry in the WHATWG roundRect proposal). */
export function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
        if (!ctx) return;
        const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.lineTo(x + w - rr, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
        ctx.lineTo(x + w, y + h - rr);
        ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
        ctx.lineTo(x + rr, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
        ctx.lineTo(x, y + rr);
        ctx.quadraticCurveTo(x, y, x + rr, y);
        ctx.closePath();
}

/** Truncate a string to at most `max` characters, appending '…' if it
 *  was shortened. Used by renderGameOptions for long paths. */
export function truncateForDisplay(s: string, max: number): string {
        if (s.length <= max) return s;
        return s.slice(0, max - 1) + '…';
}

/** Draw a simple top-left text panel. Used by the frame loop's picker,
 *  save-choice, import-confirm, and error phases. `screen` is read as a
 *  global (nx.js and the test VM both expose it). */
export function panel(ctx: CanvasRenderingContext2D, lines: string[], full = false) {
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#161823'; ctx.fillRect(0, 0, (screen as any).width, full ? (screen as any).height : Math.min((screen as any).height, 30 + 30 * lines.length));
        ctx.fillStyle = '#f4f3ef'; ctx.font = '22px sans-serif';
        lines.forEach((line, index) => ctx.fillText(line, 28, 34 + index * 30, (screen as any).width - 56));
        ctx.restore();
}
