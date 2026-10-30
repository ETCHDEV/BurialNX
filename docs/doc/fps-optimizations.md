# FPS Optimizations — Reference & Revert Guide

This document describes every FPS optimization patch applied to BurialNX, what it does, where it lives, the measured effect, and exactly how to revert it if it breaks a specific game.

All patches are **runtime-only** — they modify the game's runtime objects (PIXI, SceneManager, Window, WindowLayer) after the game scripts load. **No game asset or script file is modified.**

---

## Patch index

| ID | Name | File | Effect | Risk | Revert difficulty |
|----|------|------|--------|------|-------------------|
| B | Canvas2D Proxy → explicit wrapper | `browser-host.ts` | Removes per-call Proxy-trap overhead on every Canvas2D draw | Low | Easy |
| C | Cached `present()` destination | `browser-host.ts` | Caches viewport rect; clears only letterbox bands | Low | Easy |
| — | CanvasNode width/height skip | `browser-host.ts` | Skips resize-clear when size unchanged | Low | Easy |
| F | Zero-allocation button scan | `frame-loop.ts` | `anyPressed()` instead of `Array.from().some()` | Low | Easy |
| WL | WindowLayer skip when no windows | `game-compat.ts` | Skips temp-canvas dance when no visible windows | Low | Easy |
| WR | Window `_refreshFrame`/`_refreshCursor` Bitmap reuse | `game-compat.ts` | Reuses Bitmap instead of allocating new canvas | Low | Easy |
| E | textureGC maxIdle 1→600 | `game-compat.ts` | Keeps textures hot (no-op on CanvasRenderer) | Low | Easy |
| G | Frame-skip cap + dirty-flag render-skip | `game-compat.ts` | Caps accumulator; skips render on static scenes | Medium | Medium |
| FS | Frame skip slider (0-10) | `menu.ts`, `state.ts`, `render-overlay.ts`, `main.ts`, `frame-loop.ts`, `game-compat.ts` | User-adjustable extra throttle | Low | Easy |

---

## B — Canvas2D explicit wrapper (no Proxy)

**File:** `src/browser-host.ts`, `CanvasNode.getContext('2d')`

**What it does:** The 2D context was wrapped in `new Proxy(target, {get, set})` whose traps fired on every property access (`fillStyle`, `globalAlpha`, `drawImage`, …). V8 heavily deoptimizes hot Proxy-trap paths. The replacement pre-binds every native method once at creation and defines explicit property accessors for ~26 known properties, so reads/writes go straight to the native context. Interception is kept only on `fillStyle` / `save` / `restore` / `fillRect` / `drawImage` / `createPattern` + the drawing set (`clearRect`, `strokeRect`, `fillText`, `strokeText`, `putImageData`, `fill`, `stroke`).

**Measured effect:** Removes the largest source of per-draw-call V8 overhead (PIXI touches dozens of context properties per sprite per frame).

**Risk:** Low. Behavior-preserving — the same interception surface is maintained, just without the Proxy.

**Revert:** Restore the original `new Proxy(target, { get(object, key) {...}, set(object, key, value){...} })` block. Look for the comment `=== FPS optimization (variant B): explicit wrapper instead of Proxy ==` and replace the plain-object wrapper with the original Proxy version (available in git history).

---

## C — Cached `present()` destination

**File:** `src/browser-host.ts`, `createBrowserHost` → `present()`

**What it does:** The destination viewport rect (game canvas → screen) is recomputed only when an input changes (game resize, fit toggle, screen change). On steady frames the cached rect is reused. The full-screen `fillRect(0,0,1280,720)` clear is replaced with clearing only the thin black letterbox bands the game's `drawImage` doesn't cover (or skipped entirely when the game rect fills the screen).

**Measured effect:** Removes a full-screen clear + viewport math per frame.

**Risk:** Low. If a game uses a custom resolution that changes every frame (unusual), the cache would just miss every frame (no correctness issue).

**Revert:** Restore the original `present()` body:
```js
present() {
    if (!gameCanvas || gameCanvas.direct) return;
    const width = fitScreen ? screen.width : Math.min(screen.width, gameCanvas.width);
    const height = fitScreen ? screen.height : Math.min(screen.height, gameCanvas.height);
    const target = viewport(gameCanvas.width, gameCanvas.height, width, height);
    if (!target) return;
    target.x += (screen.width - width) / 2; target.y += (screen.height - height) / 2;
    screenContext.fillStyle = '#000'; screenContext.fillRect(0, 0, screen.width, screen.height);
    screenContext.drawImage(gameCanvas.surface(), 0, 0, gameCanvas.width, gameCanvas.height, target.x, target.y, target.width, target.height);
},
```
Also remove the `presentCache` object near the top of `createBrowserHost`.

---

## CanvasNode width/height skip

**File:** `src/browser-host.ts`, `CanvasNode` class, `width`/`height` setters

**What it does:** Setting `canvas.width = X` (even to the same value) clears the canvas surface per the HTML spec — expensive on a 1600×1000 GPU surface. The setters now `return` early when the value equals the current width/height.

**Risk:** Low. Standard canvas behavior is to clear on any width assignment; this only skips the clear when the size is identical. Games that rely on "assign same size to clear" (very rare — they'd use `clearRect`) would still clear via explicit calls.

**Revert:** Restore the original one-liner setters:
```js
set width(value: number) { if (this.preserveSize && value === this.w) return; this.w = value; this.revision++; if (this.canvas && !this.direct) this.canvas.width = value; }
set height(value: number) { if (this.preserveSize && value === this.h) return; this.h = value; this.revision++; if (this.canvas && !this.direct) this.canvas.height = value; }
```

---

## F — Zero-allocation button scan

**File:** `src/frame-loop.ts`

**What it does:** Replaces 12 `Array.from(buttons || []).some((button => button.pressed)` call sites (one per phase, on the hot `waitForRelease` path) with a single helper `anyPressed(buttons)` using a plain indexed loop — no array allocation, no closure allocation.

**Risk:** None. Pure performance, identical behavior.

**Revert:** Replace `!anyPressed(buttons)` with `!Array.from(buttons || []).some((button) => button.pressed)` (12 sites), and remove the `anyPressed` function near the top of the file.

---

## WL — WindowLayer skip when no visible windows

**File:** `src/game-compat.ts`, `WindowLayer.prototype.renderCanvas` wrapper

**What it does:** `WindowLayer.renderCanvas` (rpg_core.js:7045) creates a temp canvas, does `clearRect(0, 0, Graphics.width, Graphics.height)`, clips, renders windows, then `drawImage(tempCanvas, 0, 0)` back — ~3.2M pixel ops per WindowLayer per frame. This wrapper counts visible windows first; if none, it renders only non-window children directly and skips the temp-canvas dance entirely.

**Measured effect:** On a map with no open menus (common), saves ~6-10M pixel ops/frame (2-3 WindowLayers × 3.2M).

**Risk:** Low. If a game uses a WindowLayer subclass that overrides `renderCanvas` or relies on the temp canvas always existing, this could skip needed work. The original path is taken whenever any window is visible.

**Revert:** Restore the original wrapper:
```js
const layer = runtime.WindowLayer?.prototype;
if (layer?.renderCanvas) {
    const render = layer.renderCanvas;
    layer.renderCanvas = function() {
        const canvas = this._tempCanvas;
        if (canvas) canvas.preserveSize = true;
        try { return render.apply(this, arguments); }
        finally { if (canvas) canvas.preserveSize = false; }
    };
}
```

---

## WR — Window `_refreshFrame` / `_refreshCursor` Bitmap reuse

**File:** `src/game-compat.ts`, `WinProto._refreshFrame` / `_refreshCursor`

**What it does:** RPG Maker MV's `Window._refreshFrame` and `_refreshCursor` create a `new Bitmap(w, h)` on EVERY call (→ new OffscreenCanvas → new Skia GPU surface, ~6.4MB for 1600×1000). These are called by `_refreshAllParts` whenever the window resizes, windowskin loads, or cursorRect changes — on a busy map this creates 3-5 new canvases per second. The patch reuses the sprite's existing Bitmap when the dimensions haven't changed (`clearRect` in place), only allocating a new Bitmap when the size actually changes.

**Measured effect:** Eliminates the canvas-churn that was growing `canvases` counter 239→339 over 30 seconds and collapsing FPS 60→18.

**Risk:** Low. The bitmap is cleared before `blt()` redraws the frame/cursor — identical visible result. Only risk: a plugin that expects `_windowFrameSprite.bitmap` to be a fresh instance on each refresh (very unusual).

**Revert:** Restore the original `_refreshFrame` and `_refreshCursor` from rpg_core.js (lines 6696-6757). Remove the `WinProto.__bnxFrameReuse` guard block entirely.

---

## E — textureGC maxIdle 1→600

**File:** `src/game-compat.ts`, `graphics._createRenderer` hook

**What it does:** RPG Maker MV sets `renderer.textureGC.maxIdle = 1` (rpg_core.js:2598), freeing any texture unused for a single frame. The patch raises this to 600 (10 seconds at 60 fps). **This is a no-op on CanvasRenderer** (which has no `textureGC`) — it only applies if WebGL is ever enabled. Harmless on Canvas, beneficial on WebGL.

**Risk:** None on CanvasRenderer. On WebGL it would increase texture memory usage by ~10 seconds worth of textures (acceptable — keeps recently-used textures hot).

**Revert:** Remove the `graphics._createRenderer` wrapper block (search for `__bnxRendererTune`).

---

## G — Frame-skip cap + dirty-flag render-skip

**File:** `src/game-compat.ts`, `SceneManager.updateMain` replacement

**This is the most impactful and most complex patch. Read carefully.**

### What it does

Replaces `SceneManager.updateMain` with a version that:

1. **Caps the fixed-timestep accumulator** to 2 update steps per rAF tick (original allows up to 15). Prevents "spiral of death" where a slow frame stacks 15 updates, making the next frame slower.

2. **Dirty-flag render-skip:** Instead of calling `renderScene()` every frame, it tracks whether anything actually changed:
   - Player position (`$gamePlayer._realX/_realY`)
   - Map scroll (`$gameMap._displayX/_displayY`)
   - Message busy / content index (`$gameMessage.isBusy()`, `_messageWindow._index`, `_textState.index`, `_waitCount`)
   - Choice cursor index
   - Timer working
   - Animations / balloons (`$gameTemp._animationQueue/_balloonQueue`)
   - Scene transition / children count change

   If nothing is dirty, `renderScene()` is skipped entirely (the last painted canvas is reused). A 250ms fallback render keeps cursor blink / auto-tile animations live.

3. **Frame skip (FS slider):** When `S.frameSkip > 0`, additionally skips N dirty frames between renders on stable scenes.

### Measured effect

This is THE patch that raised FPS from ~17 to ~37 on static scenes. Without it, PIXI redraws the entire scene graph every frame (~30ms of drawImage work).

### Risk — MEDIUM

- **Time-based effects may slow down:** If a game relies on real-time rendering for animations not covered by dirty sources (e.g. a custom plugin that animates a sprite via direct canvas manipulation without changing `worldAlpha`/`visible`), those animations would freeze until the 250ms fallback fires (4 FPS). The fallback ensures they stay visible, just choppy.
- **Message typing / choice cursor:** Tracked via `msgIndex`/`choiceIndex` so dialogue and choices always render correctly.
- **If a game uses a custom scene** without `_messageWindow` or with a different window structure, dirty detection may miss some sources → falls back to the 250ms render (still correct, just lower FPS for that scene).

### Revert

To fully revert patch G:

1. Remove the entire `SceneManager.updateMain` replacement block in `game-compat.ts` (search for `Frame-skip cap + dirty-flag render-skip`).
2. The original `updateMain` (from rpg_managers.js:1970) runs unmodified — it calls `renderScene()` every frame.

To keep the frame-skip cap but disable dirty-flag:
- In the replacement `updateMain`, change the render decision to always `this.renderScene()` (remove the `dirty` check). Keep the accumulator cap.

To keep dirty-flag but disable the accumulator cap:
- Change `MAX_UPDATES_PER_FRAME` from 2 to a large number (e.g. 15) — effectively the original behavior.

---

## FS — Frame skip slider (0-10)

**Files:** `src/menu.ts`, `src/state.ts`, `src/render-overlay.ts`, `src/main.ts`, `src/frame-loop.ts`, `src/game-compat.ts`

**What it does:** Adds a "Frame skip" slider to the pause menu → "Another…" page (between "Mouse speed" and "Select mod"). Left/Right adjusts 0-10. Value is persisted to `sdmc:/switch/burialnx/frame-skip-settings.json` and loaded at startup.

**How it interacts with patch G:** When `frameSkip > 0`, on a stable scene (no movement/dialogue/animation), the patch skips N dirty frames between renders. `0` = render every dirty frame (default).

**Risk:** None on its own — it only affects patch G's behavior. If patch G is reverted, the slider has no effect.

**Revert:** To remove the slider entirely:
1. `menu.ts` — remove `'frameSkip'` from `MenuItem` type, `frameSkipDelta` field, the `itemsPage2` entries, the Left/Right handling, and the `action === 'frameSkip'` no-op.
2. `state.ts` — remove `frameSkip` field and its initializer.
3. `render-overlay.ts` — remove the `frameSkip` slider rendering block and restore `maxItems` to original (8/10).
4. `main.ts` — remove the `frame-skip-settings.json` load block.
5. `frame-loop.ts` — remove the `frameSkipDelta` handling block.
6. `tests/core.test.ts` — restore the original `currentItems` assertion (remove `'frameSkip'` from the expected array).

---

## Partial redraw — NOT APPLIED (experimental, reverted)

A partial-redraw approach was attempted twice and reverted both times:

**Approach:** Cache a background snapshot (render scene with `_windowLayer.visible = false`, copy canvas to an OffscreenCanvas). When only the message/choice window is active (background stable), restore the snapshot via `drawImage` and render only the window layer on top — skipping the expensive tilemap + sprite traversal.

**Why it failed:**
1. **First attempt:** `drawImage(snapshot, 0, 0)` threw "Image or Canvas expected" — the game canvas is a BurialNX `CanvasNode` wrapper, not a native nx.js canvas, and `nx_get_canvas` didn't recognize it. Fixed by unwrapping via `surface()`.
2. **Second attempt:** Windows rendered at position (0,0) and menus stopped updating. Root cause: `WindowLayer.renderCanvas` uses a temp canvas with `clip()` and offset, and bypassing the full `CanvasRenderer.render` setup (which resets `setTransform`/`globalAlpha`/`globalCompositeOperation` and does `clearBeforeRender`) left the context in a state where window positions were wrong.
3. **Third attempt (with full context setup + try/catch fallback):** Still didn't produce the expected FPS improvement and showed no `partial` counter growth — the dirty detection for message/choice activity wasn't triggering partial mode reliably.

**Status:** Reverted. The dirty-flag render-skip (patch G) achieves a similar effect more safely — on a static scene it skips render entirely (0ms), which is even cheaper than partial redraw (which still does 1 drawImage + window layer render).

**If you want to retry partial redraw:** The key insight is that `WindowLayer.renderCanvas` expects the renderer context to be in the exact state that `CanvasRenderer.render` leaves it (after `setTransform(1,0,0,1,0,0)`, `globalAlpha = 1`, `globalCompositeOperation = 'source-over'`, and `clearBeforeRender`). Any partial path must replicate this setup exactly, AND must handle the fact that `WindowLayer.renderCanvas` internally swaps `renderer.context` to its temp canvas and back. The cleanest approach may be to call the original `renderScene` but temporarily hide the tilemap + spriteset (set `scene._spriteset.visible = false`), rather than bypassing `renderScene` entirely.

---

## Quick revert: disable ALL optimizations

If any optimization breaks a game and you need a clean baseline immediately:

1. **B, C, CanvasNode skip:** In `browser-host.ts`, restore the original Proxy wrapper and `present()` body (from git history or the code snippets above).
2. **F:** In `frame-loop.ts`, replace `anyPressed(buttons)` with `Array.from(buttons || []).some((button) => button.pressed)` (12 sites).
3. **WL, WR, E, G:** In `game-compat.ts`, remove every block guarded by `__bnx*` flags (search for `__bnxOptimized`, `__bnxFrameReuse`, `__bnxRendererTune`, `__bnxFrameskipWrap`). The game's original methods run unmodified.
4. **FS:** Remove the "Frame skip" menu item (see FS revert above). The slider becomes inert if patch G is gone.

The game's own scripts (`www/js/*`) are never modified, so a revert always restores 100% original behavior.

---

## Diagnostics

In debug builds, every 5 seconds the frame loop logs to `sdmc:/switch/burialnx/LOGS/native-host.log`:
```
_fps_diag: XX.X FPS | scene=Scene_Map | msg=on | frameSkip=0 | skipped=N | capped=M
```
- `skipped=N` — how many frames were not rendered (dirty-flag skip working)
- `capped=M` — how many frames hit the 2-update accumulator cap (spiral-of-death prevention working)

If `skipped` is growing during static gameplay, patch G is active and helping. If `capped` is growing, the game was hitting the spiral and patch G is preventing it.
