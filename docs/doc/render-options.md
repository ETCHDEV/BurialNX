# `render-options.ts`

Renders the compact, scrollable game options screen — replaces the old fixed-height panel that overflowed after the forwarder entries were added.

## File header
> === Game options screen renderer ====================================
> Extracted from main.ts. Compact, scrollable layout. With 14 menu items
> (after adding the forwarder entries) the old fixed-height panel
> overflowed the screen. The new layout:
>   - Title (1 line, 20px, white)
>   - 6 header info lines (18px, grey — combined to save vertical space)
>   - A separator line
>   - A scrollable window of menu items (22px, white/green cursor) that
>     auto-scrolls to keep the cursor visible. ▲/▼ indicators on the
>     right margin show when more items exist above/below.
>
> Reads from S: ctx, currentEntry, gameOptionsCursor, gameOptionsScroll,
>                currentGameLanguages.
> Mutates S: phase (early-returns to 'library' when currentEntry is null),
>            gameOptionsScroll (clamps to keep cursor visible).

## `renderGameOptions` — header info
> --- Header info (combined to 6 lines to save vertical space). ---

## `renderGameOptions` — menu items
> --- Menu items (14 or 15 depending on language availability). ---
> The "Language" option is inserted between "Change save folder" and
> "Create forwarder" only when the game ships at least one .cld pack
> (which means 2+ total languages counting the embedded English data).

## `renderGameOptions` — language label
> Determine the current language label for display.

> No preference → default to first .cld (Russian) if available

## `renderGameOptions` — layout
> --- Layout constants. ---

## `renderGameOptions` — scroll clamping
> Adjust scroll so the cursor stays visible.

## `renderGameOptions` — draw
> --- Draw. ---
