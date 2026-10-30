// Message-render mode toggle for the pause menu.
//
// RPG Maker MV renders through PIXI v4, whose CanvasRenderer re-walks the
// ENTIRE scene graph every frame even when only one tiny part of the screen
// changes. The existing dirty-flag render-skip (patch G in
// docs/doc/fps-optimizations.md) skips render on a *truly* static scene, but
// the moment a message window is "busy" it forces `dirty = true` (so the
// cursor blink keeps updating) and the full-scene render runs every frame —
// the "only the message flickers, everything else static, but FPS ~20"
// symptom.
//
// The blink-skip mode (see the SceneManager.updateMain wrapper in
// game-compat.ts) fixes that: on frames where the ONLY change is a STABLE
// message window (cursor blink, finished typewriter line — content NOT
// changing), it skips `renderScene()` entirely except every Nth frame. The
// canvas already holds the correct pixels, and the periodic render refreshes
// the cursor blink toggle. Typewriter frames (content IS changing) are never
// skipped, so text still appears smoothly.
//
// This module only holds the mode type, the ordered list, the labels, and the
// cycler used by the pause-menu item (pause → "Another…" → "Message render",
// Left/Right). The actual per-frame logic lives in game-compat.ts.

/** How the renderer handles frames where the ONLY visible change is the
 *  message/choice window (cursor blink / finished typewriter / choice highlight). */
export type MessageRenderMode = 'full' | 'blink-skip';

/** Ordered list of modes — used by the pause menu to cycle Left/Right. */
export const MESSAGE_RENDER_MODES: readonly MessageRenderMode[] = ['full', 'blink-skip'];

/** Human-readable label for each mode, shown in the pause menu. */
export function messageRenderLabel(mode: MessageRenderMode): string {
	switch (mode) {
		case 'full': return 'full';
		case 'blink-skip': return 'blink-skip';
	}
}

/** Cycle a mode by `delta` (-1 / +1), wrapping around. Returns the new mode. */
export function cycleMessageRender(mode: MessageRenderMode, delta: number): MessageRenderMode {
	const n = MESSAGE_RENDER_MODES.length;
	const idx = MESSAGE_RENDER_MODES.indexOf(mode);
	if (idx < 0) return 'blink-skip';
	const next = (idx + (delta > 0 ? 1 : -1) + n) % n;
	return MESSAGE_RENDER_MODES[next];
}
