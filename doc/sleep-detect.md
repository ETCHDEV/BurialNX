# `sleep-detect.ts`

This module detects whether the console has just woken from Sleep Mode, using a two-layer detector: a deterministic native applet hook (when the patched nx.js runtime is present) and a steady-frame-arming heuristic fallback (for the stock runtime). Both layers feed the same `handleWake()` path in `sleep-recovery.ts`. The design specifically avoids the false positive of the previous single-gap heuristic, which misread the game's synchronous boot / first-map-load stall as a sleep and chain-reloaded the NRO mid-launch.

## Module-level rationale — WHY THIS MODULE EXISTS

> The previous wake detector (a single >1 s wall-clock gap between
> consecutive frame() calls, see the old WAKE_GAP_MS block in frame-loop.ts)
> was a HEURISTIC, and it produced a serious false positive: during a game
> launch the game's own Scene_Boot / first-Scene_Map map-data load performs
> SYNCHRONOUS SD-card reads + JSON.parse + image decode that routinely
> exceed 1 s, during which rAF does not fire. The detector misread that
> load stall as a sleep→wake, called handleWake(true), and chain-reloaded
> the NRO — so the game "restarted" mid-load (the reported bug). The phase
> guard ('loading'/'forwarder-building') only covered the loader's own
> launch() reads; it did NOT cover the game's own boot/first-map-load, which
> happens with S.phase === 'game' and SceneManager._scene === Scene_Map
> (isLiveGameRunning() === true) — exactly the case the old guard treated as
> a real wake.
>
> This module replaces that heuristic with a two-layer detector:
>
>   LAYER 1 — NATIVE (deterministic, preferred)
>     The patched nx.js runtime (see patches/nxjs-applet-sleep.patch against
>     TooTallNate/nx.js source/applet.cc) registers an AppletHook for
>     AppletHookType_OnFocusState. When the console enters Sleep Mode the
>     applet goes OutOfFocus; on wake it returns to InFocus. The hook
>     callback fires INSIDE libnx's appletMainLoop() message processing on
>     wake — BEFORE the loop iteration returns to JS — and sets a native
>     flag. JS polls that flag (Switch.appletConsumeSleepWake()) every
>     frame: a true return is a REAL wake, with zero false positives,
>     because a synchronous load stall NEVER changes the applet focus state.
>     Stock nx.js (no patch) does not expose this function; we detect that
>     at runtime and fall back to layer 2.
>
>   LAYER 2 — HEURISTIC (steady-frame arming, fallback for stock runtime)
>     We only treat a >WAKE_GAP_MS gap as a wake when the detector is ARMED,
>     and we only ARM after STEADY_FRAMES_TO_ARM consecutive "steady" frames
>     (gap < STEADY_GAP_MS) in a phase where sleep detection is meaningful.
>     A "hiccup" gap (STEADY_GAP_MS .. HICCUP_GAP_MS) or any larger gap
>     DISARMS and resets the steady run. The effect:
>       • During the game's boot / first map load / map transfers, frames
>         are gappy or blocked → the detector never arms → a >1 s load
>         stall is correctly IGNORED (no false restart). This is the fix.
>       • During steady gameplay the detector arms; a real sleep (which
>         produces a >1 s gap during armed steady play) is caught.
>     The 'loading' / 'forwarder-building' phases never arm (heavy sync
>     eval / NRO write), so a >1 s script-eval gap mid-launch is ignored.
>
> Both layers feed the SAME handleWake() path in sleep-recovery.ts: save the
> live game to a hidden file, teardown, chain-launch a fresh process.

## `isInSaveLoadScene` import note

> Imported so the detector's save/load-scene context check uses the SAME
> instanceof test the wake dispatcher (frame-loop.ts → handleWakeFromSaveLoad)
> uses — the two never disagree on what counts as a save/load scene. There is
> no import cycle: sleep-recovery imports {state, log, game-lifecycle,
> error-handling, forwarder}, none of which import sleep-detect.

## Native bridge section

> Switch.appletConsumeSleepWake() returns true exactly once per real
> sleep→wake transition (the patched runtime's AppletHook sets a flag on the
> InFocus transition and this call reads-and-clears it). Resolved lazily and
> memoized. Uses globalThis.Switch (not the bare `Switch` identifier) so this
> module is safe to import in environments where Switch is not defined (the
> Node test harness bundles several src/ modules transitively).

### `nativeConsumeSleepWake` — one-time log note

> One-time log so a developer can confirm which layer is active.

## Heuristic thresholds section

> STEADY_GAP_MS       — a frame whose gap is below this is "steady" (a normal
>                      vsync-paced frame, or a minor hitch). ~12 vsyncs.
> HICCUP_GAP_MS       — a gap in [STEADY_GAP_MS, HICCUP_GAP_MS) is a "hiccup"
>                      (a sync SD read, a JSON.parse, a GC): DISARM and reset
>                      the steady run. The next steady run must rebuild.
> WAKE_GAP_MS         — a gap >= this WHILE ARMED is treated as a real wake.
>                      Kept at 1000 ms: a real sleep+wake is rarely under
>                      ~1 s total (screen-dim + suspend + screen-on), while a
>                      load stall that reaches this only does so when the
>                      detector is DISARMED (so it is ignored).
> STEADY_FRAMES_TO_ARM — consecutive steady frames required to arm. ~1 s at
>                      60 fps. Long enough that a load stall (which breaks
>                      the run) can't arm the detector, short enough that a
>                      real sleep during the first second of steady gameplay
>                      is only missed in a narrow window (and layer 1 covers
>                      it when the patched runtime is present).

## `SAVELOAD_WAKE_GAP_MS`

> SAVE/LOAD SCENE OVERRIDE threshold. Scene_Save / Scene_Load do a
> synchronous slot-list refresh at scene START (read + LZString decompress +
> JsonEx.parse every slot header) that produces a single multi-second gap —
> 1–4 s for 20 slots on the Switch, depending on save size + SD speed. That
> gap must NOT trigger a wake (it would reload the game every time the user
> opens the save/load menu). A real sleep, however, produces a gap of MANY
> seconds (the console is suspended — wall-clock time literally stops
> between the last pre-sleep frame and the first post-wake frame, plus the
> OS resume + screen-on time). 6 s is safely above any realistic refresh
> gap while still catching any deliberate sleep (the user turns the console
> off then on — the total suspend alone is seconds). Used as a safety net
> for the case where the detector is DISARMED (the user slept within the
> ~1 s re-arming window after the refresh, or the refresh + entry-disarm
> left it disarmed) — the armed heuristic (gap > WAKE_GAP_MS) catches
> quicker sleeps once the scene has settled.

## `ARMABLE_PHASES`

> Phases in which sleep detection is meaningful (the detector may arm).
> 'loading' and 'forwarder-building' are EXCLUDED: they are the heavy-sync
> load phases where >1 s gaps are normal and must never arm the detector.

## `NO_RELOAD_PHASES`

> Phases where a real wake must NEVER trigger a reload (the action would
> corrupt in-progress work). 'forwarder-building' writes a multi-MiB NRO to
> the SD card — interrupting it mid-write leaves a corrupt forwarder.

## `__lastInSaveLoad`

> Tracks the previous frame's save/load-scene state so a transition INTO (or
> OUT of) a save/load scene is detected and the arming is reset — see the
> entry-disarm in detectWakeThisFrame for why the refresh gap must not
> false-trigger.

## `resetWakeArming`

> Reset the steady-frame arming state. Called on any phase transition so a
> fresh phase must re-prove steady frames before the heuristic detector
> arms. The native layer is unaffected (it is deterministic).

## `detectWakeThisFrame`

> Called at the very top of each frame() — BEFORE any other work — with the
> wall-clock "now" (Date.now()). Returns true if a sleep→wake was detected
> THIS frame and the caller should dispatch to handleWake(). Updates the
> steady-frame arming state and S.lastFrameWall.
>
> Detection order:
>   1. NATIVE: Switch.appletConsumeSleepWake() — deterministic, zero false
>      positives. If it returns true AND the phase allows a reload, this is
>      a real wake. (The flag is consumed either way.)
>   2. HEURISTIC: a >WAKE_GAP_MS gap, but ONLY when the detector is armed
>      (>= STEADY_FRAMES_TO_ARM consecutive steady frames in an armable
>      phase). Load/boot stalls happen while disarmed, so they are ignored.
>
> Returns false (no wake) for:
>   - the very first frame (no previous timestamp)
>   - any gap while disarmed (load stall, boot, hiccup)
>   - a native wake during a no-reload phase (consumed and ignored)

### `detectWakeThisFrame` — previous-timestamp bookkeeping note

> Update the previous-timestamp bookkeeping FIRST so the gap is measured
> against the previous frame's wall time (not the freshly-read one).

### `detectWakeThisFrame` — native path throw handler

> Native fn threw (should not happen, but be defensive) — disable
> the native path for the rest of this process so we don't spam
> the log every frame, and fall back to the heuristic.

### `detectWakeThisFrame` — wake during NO_RELOAD_PHASES

> A real wake during an NRO write: the flag is already
> consumed. Do NOT reload — the write must complete. The
> (now-stale) GPU surface risk is accepted; the next launch
> refreshes it.

### `detectWakeThisFrame` — save/load-scene context note

> Save/load-scene context (and transition detection). Read once per
> frame; isInSaveLoadScene is the SAME instanceof check the wake
> dispatcher uses, so the detector and dispatcher never disagree.

### `detectWakeThisFrame` — entry/exit reset rationale

> Reset arming on BOTH entry and exit so the new context must
> re-prove steady frames. The entry reset is the critical one:
> Scene_Save / Scene_Load do a SYNCHRONOUS slot-list refresh
> at scene START (read + LZString decompress + JsonEx.parse
> every slot header) that produces a 1–4 s gap — while the
> detector is still ARMED from the preceding gameplay. Without
> this reset, that refresh gap would false-trigger the wake
> handler EVERY TIME the user opens the save/load menu (the
> reported "chain-reload on Continue" regression).

### `detectWakeThisFrame` — WAKE CHECK ordering rationale

> CRITICAL: this check runs BEFORE the arming update, so S.wakeArmed
> here reflects the PREVIOUS frame's state (steady frames proven
> BEFORE this gap). The original code ran the arming update FIRST,
> which disarmed on the very large sleep gap, then `if (!armed)
> return false` discarded the wake — so on the stock runtime (no
> native appletConsumeSleepWake) a real sleep was NEVER detected,
> in gameplay OR in save/load. Checking BEFORE the disarm fixes it.
>
> Two detection paths:
>   (a) ARMED + gap > WAKE_GAP_MS: a real sleep during proven-steady
>       rendering (gameplay, OR save/load after the refresh settled
>       and re-armed). The standard heuristic, now actually working.
>   (b) SAVE/LOAD scene + gap > SAVELOAD_WAKE_GAP_MS: a real sleep
>       during a save/load menu EVEN IF DISARMED — e.g. the user
>       slept within the ~1 s re-arming window after the refresh,
>       or the entry-reset + refresh left it disarmed. The 6 s
>       threshold is safely above the refresh gap (1–4 s) so it
>       never false-triggers on the refresh, but catches any
>       deliberate sleep (suspend alone is seconds).

### `detectWakeThisFrame` — arming update rationale

> Updates arming state for THIS frame so the NEXT frame's wake check
> sees it. A large gap that wasn't a wake (the wake check above
> already returned for real wakes) is a load/hiccup stall → disarm.

> Loading / forwarder-building / boot — never arm, always reset.

> Steady frame — grow the run, arm once the threshold is reached.

> A hiccup (STEADY_GAP_MS..HICCUP_GAP_MS) or a larger gap that was
> NOT a wake (the wake check above already returned for wakes).
> This is a load/boot/refresh stall signature → disarm so the
> detector re-proves steady frames before treating a gap as a
> wake. This is the false-positive guard for map-load stalls,
> save/load refreshes, etc.

## `nativeSleepWakeAvailable`

> Whether the native applet sleep/wake signal is available in this build.
> Used by diagnostics / the debug menu to show which detection layer is
> active. Returns true once the native function has been positively
> resolved (false before the first probe, and permanently false if the
> stock runtime is in use or the native call threw).

### `nativeSleepWakeAvailable` — force-probe note

> Force a probe so the result is accurate without waiting for a frame.
