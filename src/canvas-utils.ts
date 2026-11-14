/** Trace a rounded-rectangle path using quadratic curves. */
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

/** Truncate a string to `max` chars, appending '…' if shortened. */
export function truncateForDisplay(s: string, max: number): string {
        if (s.length <= max) return s;
        return s.slice(0, max - 1) + '…';
}

/** Draw a simple top-left text panel for picker/error phases. */
export function panel(ctx: CanvasRenderingContext2D, lines: string[], full = false) {
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#161823'; ctx.fillRect(0, 0, (screen as any).width, full ? (screen as any).height : Math.min((screen as any).height, 30 + 30 * lines.length));
        ctx.fillStyle = '#f4f3ef'; ctx.font = '22px sans-serif';
        lines.forEach((line, index) => ctx.fillText(line, 28, 34 + index * 30, (screen as any).width - 56));
        ctx.restore();
}
