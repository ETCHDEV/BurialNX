# Sleep / wake detection

BurialNX runs inside [nx.js](https://github.com/TooTallNate/nx.js), a V8 +
libnx runtime. On Switch homebrew (Atmosphere), when the console enters
Sleep Mode the applet is suspended and the EGL/Skia GPU surface nx.js holds
goes stale — after wake, the next heavy GPU present (a game launch's
font‑atlas + texture uploads) crashes with `0x95D` (LibnxBinder BadValue,
stale binder fence on `eglSwapBuffers`). So a wake must be detected and the
process chain‑reloaded into a fresh one (fresh GPU surface) **before** any
heavy GPU work. See [`src/sleep-recovery.ts`](../src/sleep-recovery.ts) for
the save → marker → teardown → chain‑reload flow.

This document covers **how the wake itself is detected** — the part that
broke in commit `55409eb` ("game restarted mid‑load").

## The bug

Commit `55409eb` detected wakes with a single heuristic: a **>1 s wall‑clock
gap** between consecutive `frame()` calls (rAF does not fire during sleep, so
a big gap means the process was suspended). Phases `loading` and
`forwarder‑building` were guarded, but the game's **own** boot was not:

- After `launch()` sets `S.phase = 'game'`, the game's `Scene_Boot` reads the
  database JSON synchronously, then `goto(Scene_Map)` runs `Game_Map.setup`
  which reads the first map's data + images **synchronously** — routinely
  >1 s on a slow SD card.
- During that load `SceneManager._scene` is already `Scene_Map`, so
  `isLiveGameRunning()` returns `true`, and the gap was misread as a real
  wake → `handleWake(true)` → save + teardown + chain‑reload. **The game
  "restarted" mid‑load** — exactly the reported bug.

A wall‑clock gap cannot distinguish "real sleep" from "synchronous load
stall" — only the **applet focus state** can.

## The fix: two‑layer detector

[`src/sleep-detect.ts`](../src/sleep-detect.ts) replaces the single heuristic
with a two‑layer detector polled at the top of every `frame()`.

### Layer 1 — native applet hook (deterministic, preferred)

A tiny patch to nx.js's native core registers a libnx `AppletHook` for
`AppletHookType_OnFocusState` (see
[`patches/nxjs-applet-sleep.patch`](../patches/nxjs-applet-sleep.patch) against
`TooTallNate/nx.js` `source/applet.cc`). When the console sleeps the applet
goes `OutOfFocus`; on wake it returns `InFocus`. The hook callback fires
inside `appletMainLoop()`'s message processing on wake — **before** the loop
iteration returns to JS — and sets a native flag. JS polls it every frame:

```js
// src/sleep-detect.ts
if (Switch.appletConsumeSleepWake()) { /* real wake — zero false positives */ }
```

A synchronous load stall **never** changes the applet focus state, so this
signal has **zero false positives** — it fires only for a real sleep→wake.

> Why a hook and not a poll of `appletGetFocusState()`? The main loop is
> **blocked** while the applet is suspended, so the `OutOfFocus` state is
> never observed from a JS‑side poll (the loop doesn't run during sleep), and
> on wake only the `InFocus` message is processed — a before/after poll sees
> `InFocus` both times. The hook captures the transition regardless, because
> libnx invokes it while processing the wake message inside `appletMainLoop`.

### Layer 2 — steady‑frame heuristic (fallback for the stock runtime)

When the patched runtime is **not** present (stock `@nx.js/nro`), the
detector falls back to a conservative heuristic that eliminates the
false‑positive without needing the native signal:

| constant | value | meaning |
|---|---|---|
| `STEADY_GAP_MS` | 200 | a frame with a gap below this is "steady" |
| `HICCUP_GAP_MS` | 600 | a gap in `[STEADY_GAP_MS, HICCUP_GAP_MS)` is a load/hiccup → **disarm** |
| `WAKE_GAP_MS` | 1000 | a gap ≥ this **while armed** is treated as a wake |
| `STEADY_FRAMES_TO_ARM` | 60 | consecutive steady frames required to **arm** (~1 s @ 60 fps) |

The detector only fires on a `>WAKE_GAP_MS` gap when it is **armed**, and it
only arms after `STEADY_FRAMES_TO_ARM` consecutive steady frames in an
armable phase (`game`/`notice`/`library`/… — **not** `loading` or
`forwarder‑building`). Any hiccup or larger gap **disarms** and resets the
steady run.

**Why this fixes the bug:** the game's boot / first map load / map transfers
produce gappy or blocked frames, so the detector stays **disarmed** during
them — a `>1 s` load stall is correctly **ignored**. Only once the game is
running smoothly (steady frames) does the detector arm, and a real sleep
(which produces a `>1 s` gap during armed steady play) is caught. The narrow
edge case — a real sleep within the first ~1 s of steady gameplay — is
accepted for the stock runtime and fully covered by layer 1 when the patched
runtime is present.

### Behaviour parity with `55409eb`

The phase guards from `55409eb` are preserved: a wake during a game‑phase
**non‑`Scene_Map`** scene (`Scene_Title` / `Scene_Boot` / `Scene_Load` /
`Scene_Save` — light‑rendering scenes that do synchronous SD reads) is still
**ignored** (reloading there would lose the player's position‑to‑title for no
benefit). Real gameplay (`Scene_Map`) and the non‑game UI phases still
trigger the reload. The only change is **detection**, not the recovery flow.

## Building with the native patch

The `.nro` build (`npm run build`) only needs Node + esbuild + `@nx.js/nro`
— it bundles the **prebuilt** nx.js runtime shipped in `@nx.js/nro`. The
native patch requires **recompiling** that runtime with devkitPro/libnx,
which this sandbox cannot do (no devkitPro, no Docker). The fix is therefore
delivered as:

1. **`patches/nxjs-applet-sleep.patch`** — the native patch, kept in BurialNX.
2. **`tools/build-nxjs-runtime.sh`** — rebuilds the patched runtime inside a
   devkitPro environment and installs it into `node_modules/@nx.js/nro/nxjs.nro`.
3. **`src/sleep-detect.ts`** — auto‑detects the native function at runtime and
   uses it when present, falling back to the heuristic otherwise.

To build a fully‑deterministic `.nro` (with the native signal):

```bash
# Inside a devkitPro/libnx container (devkitpro/devkita64 has everything):
docker run --rm -it -v "$PWD":/work -w /work devkitpro/devkita64 \
    bash tools/build-nxjs-runtime.sh

# Then build the NROs as usual — they now bundle the patched runtime:
npm run build            # → burialnx.nro
npm run build -- --debug # → burialnx-debug.nro
```

A ready‑made container recipe is in [`Dockerfile.nxjs-runtime`](../Dockerfile.nxjs-runtime).

### Verifying which layer is active

The debug build logs a one‑time line at the first frame probe:

```
_wake: native appletConsumeSleepWake available (deterministic detection active)
```

or, on the stock runtime:

```
_wake: native appletConsumeSleepWake unavailable — using steady-frame heuristic fallback
```

The release build honours whichever layer the bundled runtime exposes — no
code change is needed when switching between stock and patched runtimes.
