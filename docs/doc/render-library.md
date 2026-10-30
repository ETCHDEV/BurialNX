# `render-library.ts`

Draws the 4×2 library tile grid: cover thumbnails for each game plus three action tiles (Add Game / Keymap Settings / Quit BurialNX) using bundled PNG icons from `romfs:/icons/`. Long game names marquee-scroll inside the bottom strip of their tile.

## File header
> === Library grid renderer ==========================================
> Extracted from main.ts. Draws the 4×2 library tile grid: cover thumbnails
> for each game, plus three action tiles (Add Game / Keymap Settings /
> Quit BurialNX) with the bundled PNG icons from romfs:/icons/. Long game
> names marquee-scroll inside the bottom strip of their tile.
>
> IMPORTANT: nx.js allocates ~2MB per ctx.font assignment. This function
> sets the font EXACTLY ONCE ('20px sans-serif') and never changes it. All
> text (header, tile labels, footer, placeholder '?') uses the same
> font. Visual variety comes from fillStyle (color) only.
>
> Reads from S: ctx, library, libraryCursor, libraryPage, marqueeOffset.
> Does NOT mutate S (except via drawImage, which is a canvas API).

## `renderLibrary` — font setup
> Set the font EXACTLY ONCE for the entire function.

## `renderLibrary` — grid layout
> Grid: 4 columns x 2 rows. Each tile 240x270, cover 240x230 + text 40px.

> Center vertically when only 1 row of tiles

## `renderLibrary` — selection border ordering
> Selection border is drawn AFTER the cover/icon (below) so
> it appears ON TOP of the cover image, not behind it.

## `renderLibrary` — action tiles
> Action tile: draw the bundled PNG icon SHRUNK by
> ~1/3 (to ~160×160 = 2/3 of the cover area width)
> and CENTERED in the cover area (240×230), with the
> text label UNDER it in the bottom 36px text strip
> — still inside the outlined tile border. The icon
> source PNGs are 512×512 square, so we draw at a
> square 160×160 to preserve their aspect ratio (no
> squish). If the icon load hasn't completed or
> failed, draw a placeholder in the cover area so
> the label still reads as a caption.
>   actionIdx 0 = "+ Add Game"      → add.png
>   actionIdx 1 = "Keymap Settings" → settings.png
>   actionIdx 2 = "Quit BurialNX"   → exit.png

## `renderLibrary` — action icon sizing
> Icon size = ~2/3 of the cover area's larger
> dimension (240 width → 160), rounded for clean
> pixel math. Centered horizontally AND vertically
> within the 240×230 cover area.
> The EXIT icon (actionIdx 2, "Quit BurialNX") is
> shrunk FURTHER by 2× (160 → 80) per the user's
> request — the exit/power glyph is visually
> heavier than the +/gear icons, so it needs to
> be smaller to feel balanced next to them.

## `renderLibrary` — action tile label
> Text label UNDER the icon, in the bottom 36px
> strip of the tile (y+234..y+270), still inside
> the outlined tile border.

## `renderLibrary` — mod indicator
> Draw 'M' indicator in top-left corner if mod is present and enabled

## `renderLibrary` — game name / marquee
> Game name — marquee scroll if too long for the tile

> Clip the text to the tile width

> Scroll: append spaces + repeat the name

## `renderLibrary` — final selection border
> Draw the selection border ON TOP of everything (cover image,
> action icon, text) so it's always visible — not hidden behind
> the cover image.

## `renderLibrary` — footer hint
> Footer hint — the A/B labels mirror the active keymap's ok/cancel
> button mapping (see menuButtonIndicesFor in src/keymap.ts).

> Footer hint

## `drawPlaceholderCover`
> Do NOT set ctx.font here — the caller (renderLibrary) already set it
> to '20px sans-serif'. Changing it would allocate a new FontFace.
