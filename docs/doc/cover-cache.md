# `cover-cache.ts`

Extracted from `main.ts`, this module owns the `coverCache` `Map` and provides `loadCoverImage` / `invalidateCoverCache`. The loader works around a native `nx.js` PNG-decoder crash (segfault, no catchable JS error) by reading cover bytes itself, validating the PNG signature + IHDR (bit depth, color type, interlace), then handing the data to the native decoder via a base64 `data:` URL instead of the `sdmc:/` path.

## File-level header

```
=== Cover image cache ==============================================
Extracted from main.ts. nx.js's native Image decoder crashes (segfault,
no catchable JS error) on some valid PNGs extracted from .exe resources —
particularly PNG-embedded Windows icons that use features the native
libpng build doesn't handle. To work around this, we:
  1. Read the cover bytes ourselves via Switch.readFile
  2. Validate the PNG signature + IHDR (bit depth, color type, interlace)
  3. Convert to a base64 data: URL and set img.src to THAT instead of
     the sdmc:/ path. The data URL path uses a different native code
     path in nx.js that decodes from an in-memory buffer, avoiding
     whatever file-fetch + decode interaction triggers the crash.
  4. Log the IHDR details so a future crash report tells us exactly
     which PNG format triggered it.

The module owns the coverCache Map. `log` is imported from the log
module.
```

## `loadCoverImage()` — read bytes ourselves (validate + log IHDR)

```
// Read the PNG bytes ourselves so we can validate and log the
// IHDR before handing the data to the native decoder. If the
// file read fails, fall back to a direct path assignment.
```

## `loadCoverImage()` — detect image format from magic bytes

```
// Detect the image format from the magic bytes so non-PNG
// covers (JPEG, WebP, GIF) are decoded correctly. Previously
// only PNG was accepted — JPEG/WebP files saved with a .png
// extension failed the PNG signature check and showed a
// question-mark placeholder.
```

## `loadCoverImage()` — PNG IHDR validation rationale

```
// For PNG, validate the IHDR to avoid native decoder crashes
// on interlaced or unusual bit depths. Non-PNG formats are
// passed directly to the native decoder (which handles them).
```

## `loadCoverImage()` — IHDR offset

```
// IHDR is at offset 8+4+4 = 16 (after signature + length + type).
```

## `loadCoverImage()` — reject interlaced / odd bit-depth / odd color-type

```
// nx.js's native decoder is known to crash on interlaced PNGs
// and on unusual bit depths (1, 2, 4, 16). Reject those
// preemptively so the app doesn't crash.
```

## `loadCoverImage()` — base64 data URL rationale

```
// Convert to base64 data URL with the detected MIME type.
// The native decoder takes a different code path for data:
// URLs (in-memory buffer) vs sdmc:/ paths (file fetch), which
// avoids the crash. Using the correct MIME type is critical
// for non-PNG formats (JPEG, WebP, GIF) — the native decoder
// needs to know the format to decode correctly.
```

## `loadCoverImage()` — btoa fallback

```
// btoa not available — fall back to direct path
```

## `invalidateCoverCache()` — do NOT close Images

```
// Do NOT call image.close() here — the canvas may still be referencing
// the native pixel buffer for a queued drawImage. Closing the Image
// would free the buffer underneath the renderer, which on Switch
// manifests as a native crash (no catchable JS error). Let the GC
// reclaim the Image naturally; the new cover loads into a fresh
// Image object on the next renderLibrary call.
```
