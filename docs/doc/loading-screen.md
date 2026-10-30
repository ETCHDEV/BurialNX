# `loading-screen.ts`

Owns the loading-screen state (label, subtext, progress, title) and the three accessors used by `launch()` and the forwarder builder to drive the centered progress bar. The bar replaces the old top-left text panel.

## File header
> === Loading progress bar ============================================
> Extracted from main.ts. Owns the loading-screen state (label, subtext,
> progress, title) and the three accessors used by launch() and the
> forwarder builder to drive the centered progress bar. The bar replaces
> the old top-left text panel ("BurialNX / Opening game…") and is also
> reused while building a forwarder NRO.
>
>  - loadingLabel: short human line under the bar ("Loading scripts 3/47…")
>  - loadingProgress: 0..1 (clamped). NaN/Infinity is treated as 0.
>  - loadingTitle: title shown above the bar (defaults to "BurialNX")
>  - loadingSubtext: optional small grey line under the label (e.g. the
>    path of the script currently being loaded).

## `setLoadingProgress`
> Update the loading screen state. The frame loop picks these up and
>  renders the bar on the next vsync. `progress` is clamped to [0,1].

## `resetLoading`
> Reset the loading screen to its initial state for a new operation.

## `renderLoading`
> Draw the centered loading screen. Renders over whatever the game/host
>  had on screen so the user sees a clean transition into the launch.

## `renderLoading` — subtext truncation
> Truncate the subtext to fit within ~80% of the screen width.

## `renderLoading` — debug lines
> Debug lines, if any, in the top-left corner so devs still get
> diagnostics without losing the new bar UI.
