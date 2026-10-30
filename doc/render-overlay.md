# `render-overlay.ts`

Three modal-style overlay renderers (pause menu, quit dialog, notice popup) that draw centered rounded boxes over the game/library without a full-screen background clear so the underlying screen shows through.

## File header
> === Overlay renderers: pause menu, quit dialog, notice popup =========
> Extracted from main.ts. Three modal-style overlay renderers that draw
> centered rounded boxes over the game/library without a full-screen
> background clear (the underlying screen shows through). All read from
> the shared `S` state object; none mutate it.
>
> renderPauseMenu() reads: ctx, menu, exitBehavior, fit, directNext, fps,
>                   activeLanguageCode, languageEntries.
> renderQuitDialog() reads: ctx, message.
> renderNoticePopup() reads: ctx.

## `menuLetters`
> The CONFIRM/CANCEL button letters ('A'/'B') for the active keymap, so
>  the overlay hints ("A: choose", "B: back", "A: Yes", "B: No", "B: OK")
>  match whichever button the game actually maps to ok/cancel. Computed
>  lazily on each render (cheap — two array lookups + a merge).

## `hud`
> Heads-up display: the pause menu when open, or a compact FPS counter
>  in the top-left when the FPS toggle is on. Called from launch()'s
>  Graphics.render wrapper every game frame, and from the frame loop
>  when the host is not in direct-screen mode.

## `hud` — FPS branch
> FPS counter only (compact, top-left, no background).

## `renderPauseMenu`
> Compact pause menu (hold Minus). The background only covers the
>  menu items, not the full screen — the game is visible around it.

## `renderPauseMenu` — `currentLanguageLabel`
> Human-readable label for the language currently in use (or 'English' default).

## `renderPauseMenu` — quit label
> The last menu item (pause-menu "quit") is labeled from the exit
> behavior flag armed at launch (see the exitBehavior lifecycle):
>   - 'shutdown' (forwarder-launched game): the user wants to LEAVE
>     BurialNX entirely → "Quit BurialNX" (a real exit).
>   - 'restart' (library-launched game): the user came from the
>     library grid → "Return to library" (relaunch burialnx.nro
>     without --game so the grid shows again).

## `renderPauseMenu` — top bar
> Top bar (always visible when menu is open). The A/B hints mirror
> the game's ok/cancel button mapping (see menuLetters()).

## `renderPauseMenu` — fixed panel size
> FIXED panel size — accommodates the larger page (page 2 with
> 8 items in debug, 6 in release). Using a fixed size means
> the opaque panel always covers the same screen area, so
> switching pages doesn't leave ghosting from the old panel.
> The actual items are vertically CENTERED within the panel.

## `renderPauseMenu` — vertical centering
> Center the actual items between the separator line and the
> panel bottom (minus padding). This ensures the items column
> is visually centered in the panel's content area.

## `renderPauseMenu` — opaque panel
> OPAQUE panel background — no full-screen clear needed.
> The game is visible AROUND the panel (outside its area).
> The opaque panel covers any previous content underneath.

## `renderQuitDialog`
> Centered quit-confirmation dialog. NO background overlay — the game
>  is fully visible behind the dialog box.

## `renderQuitDialog` — no overlay
> NO full-screen overlay — the game shows through.
> Compact dialog box (centered, opaque).

## `renderQuitDialog` — title
> The title reflects the armed exit mode (set when the notice was
> armed): "Quit BurialNX?" for a real exit (library grid Quit, or a
> forwarder-launched game), "Return to library?" for a library-
> launched game.

## `renderQuitDialog` — yes/no hints
> The Yes/No hints use the CONFIRM/CANCEL letters so a player who
> swapped A/B for the game gets the same swap here.

## `renderNoticePopup`
> Small centered popup for success/info notices — same visual style as
>  renderQuitDialog (compact, centered, opaque rounded box, no full-screen
>  overlay) but for single-button acknowledgment ("B: OK") instead of a
>  yes/no question. Replaces the old full-screen `panel(...)` notice that
>  hid the library/options screen behind a big dark rectangle.
>
>  The box auto-sizes to the message: long text (e.g. a forwarder path)
>  word-wraps to a 480px max line width and the box grows downward, so a
>  short "Name changed." gets a tidy little box while a long build result
>  still fits without overflowing the screen.
>
>  The underlying screen shows through — the game keeps rendering during a
>  game session, and for the library/game-options the previous frame's
>  content is retained (those screens are static, so the stale frame reads
>  as the real background).

## `renderNoticePopup` — word wrap
> Word-wrap the message so long notices (forwarder paths, multi-
> sentence results) stay on screen. Use most of the screen width.

## `renderNoticePopup` — path splitting
> Split by whitespace, but also break long paths at '/' so a single
> path like sdmc:/switch/The_Coffin_of_Andy_and_Leyley/The_Coffin_of_Andy_and_Leyley.nro
> wraps across multiple lines instead of overflowing.

## `renderNoticePopup` — chunk break
> If the word itself is wider than maxLineWidth, break it at '/'
> or '_' boundaries so long paths wrap nicely.

> Break after '/' so the next chunk starts cleanly.

## `renderNoticePopup` — box geometry
> Box geometry — auto-size to the wrapped text.

## `renderNoticePopup` — box style
> Box (opaque, rounded, subtle border — same palette as renderQuitDialog).

## `renderNoticePopup` — accent bar
> Thin green accent bar on the left edge — a quiet "success/info"
> cue that matches the 'ok' color used throughout the keymap UI.

## `renderNoticePopup` — dismiss hint
> Dismiss hint (centered, green). Use the CONFIRM letter — a
> success/info notice is dismissed by the same button the game
> uses for 'ok' (both confirm and cancel dismiss a non-exit
> notice, but the hint reads more naturally as confirm/OK).
