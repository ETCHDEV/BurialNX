# `action-icons.ts`

Three PNG icons (add.png, exit.png, settings.png) bundled in `romfs:/icons/`, drawn on the library action tiles. Loaded once at startup; reused for every `renderLibrary` call.

## File header
> === Library action-tile icons (bundled in romfs:/icons/) ===========
> Extracted from main.ts. Three PNG icons shipped inside the NRO's romfs:
> add.png, exit.png, settings.png. They're drawn STRETCHED to fill the
> cover area of the three library action tiles (240×230), with a text
> label under them (still inside the tile border). Loaded once at
> startup (this module's init call); reused for every renderLibrary call.
> If a romfs read fails, the tile falls back to the original centered-text
> rendering.
>
> The module owns the `actionIcons` array and the `actionIconPaths` list.
> `log` is imported from the log module. The init call runs at this
> module's load time (matching the original `loadActionIcons()` call at
> the end of the action-icon section in main.ts).

## `actionIcons` array entries
> add
> settings
> exit

## `loadActionIcons` — PNG signature check
> Basic PNG signature check — these are our own
> bundled files so they should always be valid,
> but be defensive.

## `loadActionIcons` — base64 workaround
> Convert to base64 data URL — same workaround as
> loadCoverImage (avoids the file-fetch+decode
> crash on the native decoder).

## Module init
> Kick off the loads at module init — they're async (Image 'load'
> event fires later), but the read+base64 work happens synchronously
> here so by the time renderLibrary is first called the images are
> either loaded or already marked failed.
