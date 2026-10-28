// === Splash + fatal-error helpers ====================================
// Extracted from main.ts. Drawn before any other init so the user sees
// immediate feedback that the loader is alive. If a later step throws
// during module evaluation, fatal() replaces the splash with the error
// so the user is never stuck on a black screen with no diagnostic.
//
// `ctx` is passed in at the call site (main.ts owns the single 2D context).
// `hostLogPath` is imported from the log module so the path stays the
// single source of truth.

import { hostLogPath, log } from './log';

declare const __DEBUG__: boolean;

export function drawSplash(ctx: CanvasRenderingContext2D | null, text: string) {
	if (!ctx) return;
	try {
		ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
		ctx.fillStyle = '#161823'; ctx.fillRect(0, 0, (screen as any).width, (screen as any).height);
		ctx.fillStyle = '#f4f3ef'; ctx.font = '26px sans-serif';
		ctx.fillText('BurialNX', 28, 40);
		ctx.font = '20px sans-serif'; ctx.fillStyle = '#9aa0b4';
		ctx.fillText(text, 28, 80);
		ctx.restore();
	} catch (error) { log(`_splash: drawSplash failed: ${error instanceof Error ? error.message : String(error)}`); }
}

export function fatal(ctx: CanvasRenderingContext2D | null, error: unknown) {
	const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
	try { (Switch as any).appendFileSync?.(hostLogPath, `FATAL: ${detail}\n`); } catch { /* optional */ }
	if (!ctx) { try { (Switch as any).appendFileSync?.(hostLogPath, `FATAL(no-ctx): ${detail}\n`); } catch {} return; }
	try {
		ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
		ctx.fillStyle = '#161823'; ctx.fillRect(0, 0, (screen as any).width, (screen as any).height);
		ctx.fillStyle = '#f4f3ef'; ctx.font = '24px sans-serif';
		ctx.fillText('BurialNX — fatal error', 28, 50);
		ctx.font = '18px sans-serif'; ctx.fillStyle = '#ff6b6b';
		const maxW = (screen as any).width - 56;
		const words = detail.split(/(\s+)/);
		let line = '', y = 90;
		for (const word of words) {
			const test = line + word;
			if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, 28, y); y += 28; line = word.trimStart(); }
			else line = test;
		}
		if (line) { ctx.fillText(line, 28, y); y += 28; }
		if (__DEBUG__) { y += 8; ctx.fillStyle = '#9aa0b4'; ctx.fillText(`Details: ${hostLogPath}`, 28, y); }
		ctx.restore();
	} catch { /* nothing more we can do */ }
}
