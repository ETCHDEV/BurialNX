# `cover.ts`

Cover image management for library entries. Covers are stored as regular PNG files under `sdmc:/switch/burialnx/covers/<id>.png`; the library UI loads them once and caches decoded `Image` objects across frames. Provides decode/derive/save helpers used by the add-game and forwarder-builder pipelines.

## File-level header

```
/**
 * Cover image management for library entries. Covers are stored as regular
 * PNG files under `sdmc:/switch/burialnx/covers/<id>.png`. The library UI
 * loads them once and caches decoded Image objects across frames.
 *
 * A cover is derived in this priority order:
 *   1. User-selected image file (.png/.jpg/.ico in any SD folder)
 *   2. Auto-extracted icon from a .exe file in the game's parent folder
 *   3. Auto-extracted icon from a .ico file in the game's parent folder
 *   4. Placeholder (no cover)
 *
 * For .ico and .exe inputs the bytes are decoded to PNG so nx.js's Image
 * decoder can render them without a separate ICO/BMP code path at runtime.
 */
```

## `findCoverCandidates()` — JSDoc

```
/** Scan a game's parent folder for .exe and .ico candidates. Returns the
 *  candidate paths in priority order (exe before ico). */
```

## `findCoverCandidates()` — `www/` parent handling

```
// RPG Maker MV's www/ contains the web assets; the .exe usually lives
// next to it. Look one level up when the selected root is `www`.
```

## `decodeCoverSource()` — JSDoc

```
/** Decode an arbitrary cover source to PNG bytes, or null if unsupported. */
```

## `decodeCoverSourceLogged()` — JSDoc

```
/** Same as decodeCoverSource but logs (via the provided callback) which path
 *  was taken and the resulting PNG size. This is the entry point used by the
 *  loader UI so the debug log shows whether the cover came from a PNG-embedded
 *  .exe icon, a BMP DIB, or failed. */
```

## `deriveDefaultCover()` — JSDoc

```
/** Try to derive a cover from a game folder using .exe then .ico. The first
 *  successful extraction wins. Returns the cover path on success. */
```

## `saveCoverBytes()` — PNG normalization rationale

```
// Normalize PNGs to 8-bit RGBA before saving. Windows .exe icons
// are often 16-bit RGBA PNGs, which crash nx.js's native Image
// decoder. normalizePngTo8bitRgba decodes (inflate + unfilter),
// converts to 8-bit, and re-encodes — so the saved file is
// always a standard 8-bit RGBA PNG that nx.js can display.
```

## `saveUserCover()` — JSDoc

```
/** Save a user-selected cover. Accepts .png/.jpg (copied verbatim) and .ico
 *  (decoded to PNG). Returns the stored cover path on success. */
```

## `saveUserCoverLogged()` — JSDoc

```
/** Like saveUserCover but logs each step via the provided callback so the
 *  loader's debug log shows where cover extraction succeeded or failed. */
```

## `readCover()` — JSDoc

```
/** Read a cover file as bytes, or null if missing/unreadable. */
```
