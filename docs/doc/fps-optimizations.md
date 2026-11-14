# FPS Optimizations — Reference & Revert Guide

This document describes every FPS optimization patch applied to BurialNX, what it does, where it lives, the measured effect, and exactly how to revert it if it breaks a specific game.

All patches are **runtime-only** — they modify the game's runtime objects (PIXI, SceneManager, Window, WindowLayer) after the game scripts load. **No game asset or script file is modified.**

## Per-game storage

The experimental toggles are stored **per game**, on each game's entry in
`sdmc:/switch/burialnx/library.json` under an `experimental` object, e.g.:

```json
{
  "id": "g1a2b3c", "name": "My Game", "root": "sdmc:/games/mygame",
  "sharedSaves": false,
  "experimental": {
    "skipFadeBlur": true,
    "dirtyRenderSkip": true,
    "windowBitmapReuse": true
  }
}
```

This mirrors how per-game language and keymap are already stored, so:

- Each game keeps its own experimental set. Settings you turn on for one game
  don't leak into another.
- The toggles are applied to the live state when a game is selected
  (`loadEntryIntoState` in `src/selection.ts` reads `entry.experimental` and
  writes the eight `S.*` flags).
- Flipping a toggle in the pause menu (Another → Experimental → item, A or
  Left/Right) writes the new set back to that game's library entry via
  `setExperimentalSettings` (`src/selection.ts`). No separate JSON file.
- Defaults: all eight toggles **off**. A game with no `experimental` field
  (e.g. one added before this feature) behaves exactly as stock RPG Maker MV.

---

## Patch index

Every patch in the table below is **runtime-toggleable** from the pause menu
(hold Minus → "Another..." → "Experimental..."), **per-game** (stored on the
game's `library.json` entry under `experimental`, so each game keeps its own
set), and takes effect immediately (no restart). **All default OFF** — you opt
each one in per game. Turn any one on if that game's FPS needs it; turn it off
if a game looks worse with it on. The two patches marked "always on" (B, F)
are per-call micro-optimizations with no behavioral difference — toggling them
would add a flag-check on the hot path, which defeats their purpose, so they
stay on.

| ID | Name | File | Effect | Toggle item | Risk | Revert |
|----|------|------|--------|-------------|------|--------|
| B | Canvas2D Proxy → explicit wrapper | `browser-host.ts` | Removes per-call Proxy-trap overhead on every Canvas2D draw | (always on) | Low | Easy |
| C | Cached `present()` destination | `browser-host.ts` | Caches viewport rect; clears only letterbox bands | Present cache | Low | Easy |
| — | CanvasNode width/height skip | `browser-host.ts` | Skips resize-clear when size unchanged | CanvasNode skip | Low | Easy |
| F | Zero-allocation button scan | `frame-loop.ts` | `anyPressed()` instead of `Array.from().some()` | (always on) | Low | Easy |
| WL | WindowLayer skip when no windows | `game-compat.ts` | Skips temp-canvas dance when no visible windows | WindowLayer skip | Low | Easy |
| WR | Window `_refreshFrame`/`_refreshCursor` Bitmap reuse | `game-compat.ts` | Reuses Bitmap instead of allocating new canvas | Window Bitmap reuse | Low | Easy |
| E | textureGC maxIdle 1→600 | `game-compat.ts` | Keeps textures hot (no-op on CanvasRenderer) | Texture GC idle | Low | Easy |
| G | Frame-skip cap + dirty-flag render-skip | `game-compat.ts` | Caps accumulator; skips render on static scenes | Dirty render-skip | Medium | Medium |
| FS | Frame skip slider (0-10) | `game-compat.ts` etc. | User-adjustable extra throttle | Frame skip (slider) | Low | Easy |
| MR | Message-render mode (full / blink-skip) | `game-compat.ts` etc. | Skip the message-only blink frames | Message render (cycler) | Low | Easy |
| T1 | Skip the blur in `snapForBackground` (transition fade) | `game-compat.ts` | Drops the 18 full-screen blend passes per scene transition | Skip fade blur | Low | Easy |
| T2 | ScreenSprite: hide the 100× fillRect at alpha 0 | `game-compat.ts` | Skips ~4 giant `fillRect` calls/frame when no fade is active | Skip fade fill | Low | Easy |

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

A partial-redraw approach was attempted three times and reverted every time
(see git history). It was re-tried as the `partial` and `hybrid` modes of the
Message render setting and **removed again** because both glitched on hardware.
Only `full` and `blink-skip` ship now; the blink-skip mode achieves a similar
~+27 FPS win far more safely (it does zero work on skip frames rather than a
partial redraw). The full history and the reasons each attempt failed are
preserved below for anyone who wants to retry.

**Approach:** Cache a background snapshot (render scene with `_windowLayer.visible = false`, copy canvas to an OffscreenCanvas). When only the message/choice window is active (background stable), restore the snapshot via `drawImage` and render only the window layer on top — skipping the expensive tilemap + sprite traversal.

**Why it failed:**
1. **First attempt:** `drawImage(snapshot, 0, 0)` threw "Image or Canvas expected" — the game canvas is a BurialNX `CanvasNode` wrapper, not a native nx.js canvas, and `nx_get_canvas` didn't recognize it. Fixed by unwrapping via `surface()`.
2. **Second attempt:** Windows rendered at position (0,0) and menus stopped updating. Root cause: `WindowLayer.renderCanvas` uses a temp canvas with `clip()` and offset, and bypassing the full `CanvasRenderer.render` setup (which resets `setTransform`/`globalAlpha`/`globalCompositeOperation` and does `clearBeforeRender`) left the context in a state where window positions were wrong.
3. **Third attempt (with full context setup + try/catch fallback + dirty-rect restore):** Still glitched on hardware — the cached background went stale on some plugin-driven window/scene transitions the dirty detection didn't cover, producing visible tearing and ghosting. Reverted in favor of blink-skip, which is simpler and glitch-free.

**Status:** Reverted. The dirty-flag render-skip (patch G) plus blink-skip (patch MR) achieve the same FPS goal more safely — on a static scene patch G skips render entirely (0ms), and during a stable-message blink-skip does 0 work on N-1 of N frames.

**If you want to retry partial redraw:** The key insight is that `WindowLayer.renderCanvas` expects the renderer context to be in the exact state that `CanvasRenderer.render` leaves it (after `setTransform(1,0,0,1,0,0)`, `globalAlpha = 1`, `globalCompositeOperation = 'source-over'`, and `clearBeforeRender`). Any partial path must replicate this setup exactly, AND must handle the fact that `WindowLayer.renderCanvas` internally swaps `renderer.context` to its temp canvas and back. The cleanest approach may be to call the original `renderScene` but temporarily hide the tilemap + spriteset (set `scene._spriteset.visible = false`), rather than bypassing `renderScene` entirely. You must also invalidate the cache on EVERY scene/window/child-count change, not just the ones the current dirty list tracks — plugin-driven transitions were the failure mode.

---

## T1 — Skip the blur in `snapForBackground` (transition fade)

**File:** `src/game-compat.ts`, `installGameCompatibility` → `SceneManager.snapForBackground` + `Bitmap.prototype.blur`

**What it does:** On every map transfer, `Scene_Map.terminate()` calls `SceneManager.snapForBackground()` to capture the outgoing frame as the dimmed background behind `Scene_Menu` / `Scene_Save` / `Scene_Load`. Stock does `this._backgroundBitmap = this.snap(); this._backgroundBitmap.blur();` — a full off-screen render of the scene + drawImage, AND `Bitmap.prototype.blur()` (a 2-pass box blur). Each blur pass does: 1 edge-padded temp-canvas copy + 9 full-screen `drawImage` blends with `globalCompositeOperation = 'lighter'` → **18 full-screen blend passes per transition**. At 1600×1000 (the resolution the target game sets via Community_Basic) that is ~29 million pixel ops done SYNCHRONOUSLY in the `terminate()` frame — the single biggest reason a scene-to-scene fade "lags".

The patch:
- `SceneManager.snapForBackground` → keeps the snapshot, drops the `blur()` call. The background is the captured frame, just unblurred (a tiny cosmetic change — the menu/save/load background is a crisp snapshot instead of a soft-blurred one).
- `Bitmap.prototype.blur` → fast-pathed to a no-op, so any plugin that calls `bitmap.blur()` directly also stops paying the cost. The method is kept present (not deleted) so `typeof bitmap.blur === 'function'` checks still pass.

**Measured effect:** Removes the heaviest single-frame cost in a scene transition — the fade frame stops stuttering.

**Risk:** Low. The blur is purely cosmetic (a darkened background behind a menu). Gameplay is unaffected. If a game uses `Bitmap.blur()` for an in-game visual effect (very rare — it is not used anywhere in `rpg_core`/`rpg_managers`/`rpg_sprites`/`rpg_objects`/`rpg_windows`), that effect becomes a crisp image instead of a blurred one.

**Revert:** In `game-compat.ts`, remove the two blocks guarded by `__bnxNoBlurSnap` and `__bnxBlurSkip`. Stock `snapForBackground` and `blur` run unmodified.

---

## T2 — ScreenSprite: hide the 100× fillRect at alpha 0

**File:** `src/game-compat.ts`, `installGameCompatibility` → `ScreenSprite.prototype.opacity` setter

**What it does:** `ScreenSprite` (rpg_core.js) draws the full-screen fade via a `PIXI.Graphics` rectangle of `(-5W, -5H, 10W, 10H)` — a rect **100× the screen area** — and `CanvasGraphicsRenderer.render` re-issues `context.fillRect(-5W,-5H,10W,10H)` for it EVERY frame, even when the sprite's alpha is 0 (no fade is active). Each `Scene_Map` has several ScreenSprites (`_flashSprite`, `_fadeSprite`, `_blackScreen`, plus `_screenFlashSprite` on the battle side), so that is ~4× a giant `fillRect` per frame for nothing. At 1600×1000 the stock rect is 16 million pixels × 4 = ~64M wasted pixel-fills per second at 60 fps.

The patch redefines the `opacity` setter on `ScreenSprite.prototype` so that when `alpha == 0` the underlying `_graphics` is marked `visible = false` → PIXI skips rendering invisible containers entirely. When `alpha > 0` (the fade is actually animating) `_graphics.visible` is set back to `true` and the fade renders normally.

**Measured effect:** Eliminates ~4 giant no-op `fillRect` calls per frame when no fade / flash is active (the common case — most frames are NOT mid-fade). Per-frame saving scales with resolution (biggest gain on this game's 1600×1000).

**Risk:** Low. The fade and flash still render correctly (alpha > 0 → visible). The only difference is that at exactly alpha 0 the graphics is skipped — which is the correct optimization (drawing a fully-transparent rect is a no-op visually).

**Revert:** In `game-compat.ts`, remove the block guarded by `__bnxAlphaSkip`. The stock `opacity` setter (which only sets `this.alpha`) runs unmodified.

---

## A2 — Smoothing off (nearest downscale for present)

**File:** `src/browser-host.ts`, `present()`; toggle `S.smoothingOff`

**What it does:** `present()` downscales the 1600×1000 game canvas to the 1280×720 screen via `screenContext.drawImage`. Stock uses Skia's bilinear sampling (`imageSmoothingEnabled = true`, quality low). This patch sets `imageSmoothingEnabled = false` around the draw so Skia uses nearest-neighbor instead, then restores the previous value so HUD / pause-menu draws are unaffected.

**Effect:** Nearest is cheaper than bilinear at downscale; small FPS gain, slightly pixelier image. No layout change.

**Risk:** None — purely a sampling-mode toggle for one draw call.

**Revert:** Remove the `prevSmooth` / `imageSmoothingEnabled` lines around the `drawImage` in `browser-host.ts` `present()`.

---

## A3 — Skip present when render was skip'ed

**File:** `src/frame-loop.ts`; toggle `S.skipPresent`; internal `S.lastFrameRendered` (set by the patch-G `updateMain`)

**What it does:** On frames where the game render was skip'ed (dirty-flag / blink-skip → `S.lastFrameRendered = false`) AND no overlay is active (pause menu closed, FPS counter off, mouse cursor hidden), `present()` is skipped entirely. The screen already shows the previous frame (game canvas unchanged), so re-running `drawImage` + the letterbox `fillRect` is pure waste.

**Effect:** Removes one GPU-texture `drawImage` (1600×1000 → 1280×720) plus up to 4 letterbox `fillRect`s per skipped frame. Biggest win on stable scenes (dialogue, idle map), where patch G / blink-skip skip most frames.

**Risk:** Low. The overlay guard (`overlayActive`) ensures the screen is redrawn whenever the pause menu / FPS counter / mouse cursor needs it. If the screen appears to "freeze" while an overlay is up, the guard is wrong — but the guard covers all three overlay sources.

**Revert:** Remove the `overlayActive` / `if (!(S.skipPresent && ...))` wrapper around `S.host?.present()` in `frame-loop.ts`. Stock calls `present()` every frame.

---

## B1 — Event update skip (static events)

**File:** `src/game-compat.ts`; toggle `S.eventUpdateSkip`

**What it does:** `Game_Map.updateEvents` runs `event.update()` on every event every frame. `Game_Event.update` = `Game_Character.update` (physics) + `checkEventTriggerAuto` (auto-trigger conditions) + `updateParallel` (interpreter). For a fully-static event (not moving, not jumping, trigger ≠ 3/auto, no running parallel interpreter, not already starting), all three are no-ops — but they still cost a function call + branch per event per frame. On a 137-event map (e.g. wwwNEET) that is 137 no-op updates per frame.

The patch skips `update()` entirely for those static events. Auto-trigger events (trigger === 3) still update every frame because their conditions (switches / variables) can change at any time. Events with a running parallel interpreter still update. Events that are moving / jumping / starting still update.

**Effect:** Cuts ~80% of the per-frame `updateEvents` cost on a map with many decorative / static events. This is the update-phase bottleneck, not the render phase — so it stacks with the render-skip patches (G, blink-skip).

**Risk:** Low. The skip conditions are conservative: any event that could change state still updates. The only risk is a plugin that mutates event state from outside `update()` (e.g. a `Game_Event.prototype.customMethod` that the game calls directly) — but such a plugin would also need the event to update to apply its effect, and the event would still update if it is moving / auto / parallel / starting. If an event appears "stuck", turn this toggle off.

**Revert:** Remove the block guarded by `__bnxEventSkip` in `game-compat.ts`. Stock `Game_Event.update` runs unmodified.

---

## D1 — Sprite render skip (invisible sprites)

**File:** `src/game-compat.ts`; toggle `S.spriteRenderSkip`

**What it does:** `PIXI.Container.renderCanvas` already skips children that are `!visible` or `worldAlpha <= 0`, but `Sprite._renderCanvas` itself does not re-check — so a sprite reached via a custom render path (a plugin that calls `_renderCanvas` directly, or a sprite whose `worldAlpha` dropped to 0 after the parent check) still walks the full `CanvasSpriteRenderer.render` path (matrix math, blend-mode set, `drawImage`). This patch adds an early-return at the top of `Sprite._renderCanvas` for `!visible || !renderable || worldAlpha <= 0`.

**Effect:** Small — PIXI's Container check already handles the common case. This only catches the edge cases. ~1-3 FPS on scenes with many hidden sprites.

**Risk:** None. The early-return matches exactly what PIXI would do anyway (skip invisible sprites); it just does it one level earlier.

**Revert:** Remove the block guarded by `__bnxSpriteSkip` in `game-compat.ts`.

---

## Per-game FPS-counter overlay

**File:** `src/game-library.ts` (`LibraryEntry.fps`), `src/selection.ts` (`setGameFps`, applied in `loadEntryIntoState`), `src/frame-loop.ts` (persist on toggle)

**What it does:** The pause-menu "FPS: on/off" toggle is now **per-game** — stored on the library entry as `fps?: boolean`, applied to `S.menu.fps` when a game is loaded, and persisted back when toggled. Each game remembers whether it wants the FPS counter visible.

**Default:** off. A game with no saved `fps` field behaves as stock (counter off until toggled).

**Revert:** Remove the `fps` field from `LibraryEntry`, its parse in `parseLibrary`, `setGameFps` in `selection.ts`, the `S.menu.fps = !!entry.fps` line in `loadEntryIntoState`, and the `action === 'fps'` persist block in `frame-loop.ts`.

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
