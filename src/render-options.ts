// === Game options screen renderer ====================================
// Extracted from main.ts. Compact, scrollable layout. With 14 menu items
// (after adding the forwarder entries) the old fixed-height panel
// overflowed the screen. The new layout:
//   - Title (1 line, 20px, white)
//   - 6 header info lines (18px, grey — combined to save vertical space)
//   - A separator line
//   - A scrollable window of menu items (22px, white/green cursor) that
//     auto-scrolls to keep the cursor visible. ▲/▼ indicators on the
//     right margin show when more items exist above/below.
//
// Reads from S: ctx, currentEntry, gameOptionsCursor, gameOptionsScroll,
//                currentGameLanguages.
// Mutates S: phase (early-returns to 'library' when currentEntry is null),
//            gameOptionsScroll (clamps to keep cursor visible).

import { S } from './state';
import { truncateForDisplay } from './canvas-utils';
import { forwarderExists } from './forwarder';
import type { LibraryAccess } from './game-library';

export function renderGameOptions() {
	if (!S.currentEntry) { S.phase = 'library'; return; }
	if (!S.ctx) return;
	const hasPerGameKeymap = !!S.currentEntry.keymap;
	const hasMod = S.currentEntry.mod !== undefined && S.currentEntry.mod !== null;
	const modOn = hasMod && S.currentEntry.modEnabled !== false;
	const hasForwarder = forwarderExists((Switch as any) as unknown as LibraryAccess, S.currentEntry.name, S.currentEntry.id);
	// --- Header info (combined to 6 lines to save vertical space). ---
	const coverLabel = S.currentEntry.cover ? S.currentEntry.cover.split('/').pop() || S.currentEntry.cover : '(none)';
	const modLabel = hasMod ? `${modOn ? 'ON' : 'OFF'} — ${S.currentEntry.mod!.split('/').pop() || S.currentEntry.mod}` : '(none)';
	const saveLabel = S.currentEntry.saves ? (S.currentEntry.saves.kind === 'switch' ? 'Switch user data' : (S.currentEntry.saves.folder.split('/').pop() || S.currentEntry.saves.folder)) : '(not set)';
	const fwdLabel = hasForwarder ? 'created' : '(none)';
	const headers: string[] = [
		`Game: ${S.currentEntry.name}`,
		`Path: ${truncateForDisplay(S.currentEntry.root, 70)}`,
		`Cover: ${coverLabel}  |  Shared saves: ${S.currentEntry.sharedSaves ? 'yes' : 'no'}`,
		`Mod: ${modLabel}  |  Keymap: ${hasPerGameKeymap ? 'per-game' : 'global'}`,
		`Save: ${saveLabel}  |  Forwarder: ${fwdLabel}`,
	];
	// --- Menu items (14 or 15 depending on language availability). ---
	// The "Language" option is inserted between "Change save folder" and
	// "Create forwarder" only when the game ships at least one .cld pack
	// (which means 2+ total languages counting the embedded English data).
	const hasLanguages = S.currentGameLanguages.length > 0;
	// Determine the current language label for display.
	let langLabel = '(unknown)';
	if (S.currentEntry) {
		const savedRaw = S.currentEntry.language; // from S.library file (SD card)
		if (savedRaw === undefined) {
			// No preference → default to first .cld (Russian) if available
			langLabel = S.currentGameLanguages[0]?.name || S.currentGameLanguages[0]?.code || 'English (default)';
		} else if (savedRaw === '') {
			langLabel = 'English (default)';
		} else {
			const entry2 = S.currentGameLanguages.find((e) => e.code === savedRaw);
			langLabel = entry2?.name || savedRaw;
		}
	}
	const items: string[] = [
		'Play',
		'Pick cover image',
		'Auto-detect cover from .exe/.ico',
		'Edit keymap (this game)',
		hasPerGameKeymap ? 'Reset to global keymap' : '(no per-game keymap to reset)',
		'Rename game',
		hasMod ? 'Change mod folder' : 'Select mod folder',
		modOn ? 'Disable mod' : (hasMod ? 'Enable mod' : '(no mod to toggle)'),
		'Toggle shared saves',
		'Change save folder',
	];
	if (hasLanguages) items.push(`Language: ${langLabel}`);
	items.push(
		hasForwarder ? 'Recreate forwarder NRO' : 'Create forwarder NRO',
		hasForwarder ? 'Delete forwarder NRO' : '(no forwarder to delete)',
		'Delete from library',
		'Back to library (B)',
	);
	// --- Layout constants. ---
	const titleY = 26;
	const headerFont = '18px sans-serif';
	const headerSpacing = 20;
	const headerStartY = 50;
	const itemsStartY = headerStartY + headers.length * headerSpacing + 30; // + separator gap (enough room below the line)
	const itemFont = '22px sans-serif';
	const itemSpacing = 26;
	const bottomMargin = 14;
	const visibleItems = Math.max(1, Math.floor(((screen as any).height - itemsStartY - bottomMargin) / itemSpacing));
	const maxScroll = Math.max(0, items.length - visibleItems);
	// Adjust scroll so the cursor stays visible.
	if (S.gameOptionsCursor < S.gameOptionsScroll) S.gameOptionsScroll = S.gameOptionsCursor;
	else if (S.gameOptionsCursor >= S.gameOptionsScroll + visibleItems) S.gameOptionsScroll = S.gameOptionsCursor - visibleItems + 1;
	S.gameOptionsScroll = Math.max(0, Math.min(S.gameOptionsScroll, maxScroll));
	// --- Draw. ---
	S.ctx.save();
	S.ctx.setTransform(1, 0, 0, 1, 0, 0);
	S.ctx.globalAlpha = 1;
	S.ctx.globalCompositeOperation = 'source-over';
	S.ctx.fillStyle = '#161823';
	S.ctx.fillRect(0, 0, (screen as any).width, (screen as any).height);
	// Title.
	S.ctx.textAlign = 'left'; S.ctx.textBaseline = 'alphabetic';
	S.ctx.font = '20px sans-serif';
	S.ctx.fillStyle = '#f4f3ef';
	S.ctx.fillText('BurialNX — game options', 28, titleY);
	// Header info.
	S.ctx.font = headerFont;
	S.ctx.fillStyle = '#9aa0b4';
	headers.forEach((h, i) => S.ctx.fillText(h, 28, headerStartY + i * headerSpacing, (screen as any).width - 56));
	// Separator.
	const sepY = headerStartY + headers.length * headerSpacing + 6;
	S.ctx.fillStyle = '#3a3f4b';
	S.ctx.fillRect(28, sepY, (screen as any).width - 56, 1);
	// Menu items.
	S.ctx.font = itemFont;
	const maxItemW = (screen as any).width - 80; // leave room for the scroll indicators
	for (let i = 0; i < visibleItems; i++) {
		const idx = S.gameOptionsScroll + i;
		if (idx >= items.length) break;
		const isCursor = idx === S.gameOptionsCursor;
		const y = itemsStartY + i * itemSpacing;
		S.ctx.fillStyle = isCursor ? '#3fb950' : '#c9cdd6';
		const prefix = isCursor ? '> ' : '  ';
		S.ctx.fillText(prefix + items[idx], 28, y, maxItemW);
	}
	// Scroll indicators (right margin).
	S.ctx.font = '16px sans-serif';
	S.ctx.fillStyle = '#6e7681';
	S.ctx.textAlign = 'center';
	if (S.gameOptionsScroll > 0) S.ctx.fillText('▲', (screen as any).width - 30, itemsStartY + 6);
	if (S.gameOptionsScroll < maxScroll) S.ctx.fillText('▼', (screen as any).width - 30, itemsStartY + (visibleItems - 1) * itemSpacing + 6);
	S.ctx.textAlign = 'left';
	S.ctx.restore();
}
