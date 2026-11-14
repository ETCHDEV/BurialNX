# Message-render mode — blink-skip

This document explains the **blink-skip** message-render mode, why it exists,
how it maps to the user's "only the message flickers, everything else is
static, but FPS ~20" symptom, and how to tune it.

This is **runtime-only** — no game asset or script is modified. The mode lives
in the `SceneManager.updateMain` wrapper in `src/game-compat.ts`; the type /
labels / cycler live in `src/partial-render.ts`.

---

## The symptom, and why it happens

RPG Maker MV renders through PIXI v4, whose `CanvasRenderer` re-walks the
**entire scene graph** (tilemap + every character sprite + every window) every
single frame, even when only one tiny part of the screen actually changed. On
the Switch (CPU-bound CanvasRenderer — nx.js has no WebGL for the
OffscreenCanvas path), a full-scene redraw costs roughly the same whether the
screen is moving or perfectly still.

BurialNX's existing dirty-flag render-skip (patch **G** in
`fps-optimizations.md`) already skips `renderScene()` entirely on a *truly*
static scene. But the moment a message window is "busy" it forces
`dirty = true` (so the cursor blink keeps updating), which **disables the
skip** — and the full-scene render runs every frame again. That is exactly the
case the user describes: only the message is animating (a blinking cursor or a
finished typewriter line), everything else is frozen, yet the FPS collapses to
~20 because the tilemap + every sprite is still being redrawn for nothing.

## blink-skip — the fix

A **"Message render"** item in the pause menu (page 2 → "Another…") cycles
between two modes with **Left / Right**. The choice is persisted to
`sdmc:/switch/burialnx/message-render-settings.json` and loaded at startup.

| Mode | What it does | When to use | Risk |
|------|--------------|-------------|------|
| **`full`** | Render every dirty frame (original behavior). | A safe baseline. | None — this is the stock path. |
| **`blink-skip`** *(default)* | On frames where the ONLY change is a STABLE message window (cursor blink, finished typewriter line — content is NOT changing), skip `renderScene()` entirely except every Nth frame. The canvas already holds the correct pixels, and the periodic render refreshes the cursor blink toggle. | Default for all games — the main fix for the "~20 FPS during dialogue" symptom. | Very low. Typewriter frames (content IS changing) are never skipped, so text still appears smoothly. The 250 ms fallback render is a safety net for anything the dirty detection misses. |

### How it handles the four message phases

| Phase | `full` | `blink-skip` |
|-------|-------|--------------|
| Message not showing, screen static | skip (patch G) | skip (patch G) |
| Message not showing, screen moving | full render | full render |
| Typewriter (text appearing) | full render every frame | full render every frame (content is changing → NOT skipped) |
| Cursor blink (text done) | full render every frame | **skip N-1 of N** — render every Nth to refresh the blink |

So `blink-skip` re-enables the render skip that patch G's dirty flag had turned
off during the blink phase, without chopping the typewriter (content-changing
frames are never skipped).

## The Frame skip slider — the single knob

The pause menu's **"Frame skip"** slider (page 2 → "Another…") controls the
blink-skip interval (`N` above):

- **0** = built-in default **6** — the value measured at **+27 FPS** on
  hardware. At 60 fps the blink is sampled every ~100 ms (catches RPG Maker's
  ~3 Hz cursor toggle on every flip); at a render-bound 20 fps it still
  refreshes well under the 250 ms fallback.
- **1..10** = exact skip count. More skip = more FPS, choppier cursor blink.

The slider is the single knob for "how many frames to skip" across every
code path — it also drives the non-message stable-scene skip (patch G) and the
movement skip. So bumping it throttles dialogue blink AND idle-screen blink
AND low-intensity movement at the same time.

## Diagnostics

In debug builds, the existing per-5-second `_fps_diag` log line still applies.
During a dialogue with `messageRender = 'blink-skip'` you should see
`skipped=N` climb rapidly (most blink frames are skipped).

## Revert

To fully revert the message-render feature:

1. `src/game-compat.ts` — replace the `SceneManager.updateMain` replacement
   block (search for `blink-skip mode: skip render on blink-only frames`)
   with the original block from git history (the version that computes a
   single `dirty` flag and has no `messageOnly` / `blinkOnly` /
   `blinkSkipCount` / `blinkInterval` branches). The original also disables
   `frameSkip` whenever `msgBusy` (`!msgBusy` in the frameSkip guard).
2. `src/partial-render.ts` — delete the file (or keep only the mode type /
   labels if the menu item is kept as a no-op).
3. `src/state.ts` — remove the `messageRender`, `messageRenderDelta` fields
   and their initializers, and the `import type { MessageRenderMode } …` line.
4. `src/main.ts` — remove the `message-render-settings.json` load block.
5. `src/menu.ts` — remove `'messageRender'` from the `MenuItem` type, the
   `messageRenderDelta` field, the `itemsPage2` entry, the Left/Right
   handling, and the `action === 'messageRender'` no-op.
6. `src/render-overlay.ts` — remove the `messageRenderLabel` /
   `MESSAGE_RENDER_MODES` import, the `messageRender` rendering branch, and
   restore `maxItems` to `__DEBUG__ ? 11 : 9` if you also re-add the `back`
   item (otherwise the current `__DEBUG__ ? 11 : 9` minus `back` stays).
7. `src/frame-loop.ts` — remove the `cycleMessageRender` import and the
   `messageRenderDelta` handling block.
8. `tests/core.test.ts` — remove the two message-render test blocks and the
   `messageRender` entry from the page-2 assertion, and the import line.

The game's own scripts (`www/js/*`) are never modified, so a revert always
restores 100% original behavior.
