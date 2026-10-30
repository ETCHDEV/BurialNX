# `png-normalize.ts`

Minimal DEFLATE (RFC 1951) inflater and PNG normalizer. nx.js's native `Image` decoder crashes on 16-bit RGBA PNGs (bitDepth=16, colorType=6) — the format Windows uses for high-resolution `.exe` icon resources. Since there's no built-in zlib on Switch, this module implements just enough of DEFLATE to decompress IDAT, unfilter the scanlines, and re-encode as an 8-bit RGBA PNG that nx.js CAN decode.

## File header / module overview

> ```
> Minimal DEFLATE (RFC 1951) inflater and PNG normalizer.
>
> nx.js's native Image decoder crashes on 16-bit RGBA PNGs (bitDepth=16,
> colorType=6), which is the format Windows uses for high-resolution
> .exe icon resources. Since there's no built-in zlib on Switch, we
> implement just enough of DEFLATE to decompress IDAT, unfilter the
> scanlines, and re-encode as an 8-bit RGBA PNG that nx.js CAN decode.
>
> The inflater handles all three block types: stored (BTYPE=00), fixed
> Huffman (BTYPE=01), and dynamic Huffman (BTYPE=10). It is deliberately
> compact — correctness over speed — since it only runs once per cover
> extraction, not per frame.
> ```

## `BitReader`

Section divider (original): `// === Bit reader (LSB-first, per RFC 1951) ===============================`

## `buildHuffman` / `decodeSymbol`

Section divider (original): `// === Canonical Huffman table builder ====================================`

> ```
> RFC 1951 section 3.2.2: codes are assigned in order of increasing length,
> and within the same length, in the order the symbols appear.
> The key in the lookup Map is (length << 16) | code_value, where code_value
> is the canonical Huffman code (MSB-first). The decoder builds `code`
> the same way (shift left + OR new bit), so the values match directly.
> ```

## Fixed Huffman tables (module constants `FIXED_LIT_LENGTHS`, `FIXED_DIST_LENGTHS`, `_fixedLitTable`, `_fixedDistTable`)

Section divider (original): `// === Fixed Huffman tables (RFC 1951 section 3.2.6) ======================`

> Fixed Huffman lengths are constant data (small arrays, cheap).

> ```
> Fixed Huffman TABLES are created lazily (not at module scope) to save
> startup memory. They allocate Maps with 288 and 30 entries each.
> ```

## `LENGTH_BASE` / `LENGTH_EXTRA` / `DIST_BASE` / `DIST_EXTRA`

Section divider (original): `// === Length and distance code tables (RFC 1951 section 3.2.5) ==========`

## `inflate`

Section divider (original): `// === Main inflate function ==============================================`

### Block-type dispatch labels

(Original single-line `//` step labels inside the main loop, preserved verbatim:)

- BTYPE=0 branch: `// Stored block`
- NLEN handling: `reader.readByte(); reader.readByte();` was annotated `// NLEN (ignored)`
- BTYPE=1 branch: `// Fixed Huffman`
- BTYPE=2 branch: `// Dynamic Huffman`

## `decodeBlock`

(Original inline trailing on the end-of-block return: `if (sym === 256) return; // end of block`.)

## `unfilterScanlines`

Section divider (original): `// === PNG filter unfiltering (RFC 2083 section 4.2) ======================`

> ```
> Each scanline starts with a filter byte (0=None, 1=Sub, 2=Up, 3=Average,
> 4=Paeth). bpp = bytes per pixel (e.g., 4 for 8-bit RGBA, 8 for 16-bit RGBA).
> ```

(Original inline trailing on the `prev` buffer: `const prev = new Uint8Array(rowLen); // previous row (unfiltered)`.)

(Original single-line note before the actual filter-byte read: `// Actually read the filter byte properly:`.)

## `normalizePngTo8bitRgba`

Section divider (original): `// === PNG normalizer: convert any PNG to 8-bit RGBA =====================`

> ```
> Parses the PNG chunks, inflates the IDAT, unfilter scanlines, converts
> to 8-bit RGBA, and re-encodes as a standard 8-bit RGBA PNG that nx.js's
> native Image decoder can handle. Returns null if the PNG is malformed or
> uses unsupported features (e.g., interlacing).
> ```

### Chunk-walking step labels

(Original single-line `//` step labels inside `normalizePngTo8bitRgba`, preserved verbatim:)

- `// Verify PNG signature`
- `// Walk chunks to find IHDR and IDAT`
- `// Concatenate IDAT chunks and inflate`
- `// Skip zlib header (2 bytes: CMF, FLG) and Adler-32 (4 bytes at end)`
- `// Compute bytes per pixel`
- `// Unfilter scanlines`
- `// Convert to 8-bit RGBA`
- `// Re-encode as 8-bit RGBA PNG using the icon-extract encoder`

### Inline annotations

(Original inline trailing comments, preserved verbatim:)

- `const len = view.getUint32(0, false);` — `// big-endian`
- `if (interlace !== 0) return null;` — `// interlaced PNGs not supported`
- `if (bitDepth === 8 && colorType === 6) return pngBytes;` — `// already 8-bit RGBA`
- `if (bitDepth === 8 && colorType === 2) return pngBytes;` — `// already 8-bit RGB`
- `if ((idat[0] & 0x0f) !== 8) return null;` — `// CM must be 8 (deflate)`

### Per-color-type conversion labels

(Original single-line `//` labels above each branch, preserved verbatim:)

- 8-bit branches: `// RGB → RGBA`, `// Already 8-bit RGBA — but we only get here if not returned above`, `// Grayscale + alpha → RGBA`, `// Grayscale → RGBA`, `// Indexed → RGBA`
- 16-bit branches: `// 16-bit → 8-bit (take high byte, big-endian)`, `// RGB`, `// RGBA`, `// Grayscale`, `// Grayscale + alpha`

## `encodeRgbaPng`

Section divider (original): `// === 8-bit RGBA PNG encoder (raw DEFLATE, no compression) ==============`

> ```
> Same algorithm as icon-extract.ts's encodePng but simplified for
> 8-bit RGBA input only. All 32-bit fields are big-endian per PNG spec.
> CRC32 table created lazily (256 entries = 1KB Uint32Array)
> ```

### IHDR / DEFLATE / Adler-32 / chunk-assembly step labels

(Original single-line `//` step labels and inline trailing comments inside `encodeRgbaPng`, preserved verbatim:)

- `// IHDR`
- `ihdr[8] = 8;` — `// bitDepth`
- `ihdr[9] = 6;` — `// colorType = RGBA`
- `// Raw DEFLATE: filter byte (0=None) + pixel data per row`
- `// zlib stream: 2-byte header + raw DEFLATE blocks + 4-byte Adler-32`
- `zlibStream[p++] = 0x78; zlibStream[p++] = 0x01;` — `// zlib header`
- `zlibStream[p++] = isFinal ? 1 : 0;` — `// BFINAL + BTYPE=00`
- `zlibStream[p++] = len & 0xff; zlibStream[p++] = (len >> 8) & 0xff;` — `// LEN (LE)`
- `zlibStream[p++] = nlen & 0xff; zlibStream[p++] = (nlen >> 8) & 0xff;` — `// NLEN (LE)`
- `// Adler-32 (big-endian)`
- `adlerView.setUint32(0, adler, false);` — `// big-endian`
- `// Assemble PNG chunks`
- chunk array entries: `// IHDR`, `// IDAT`, `// IEND`
- `lenView.setUint32(0, c.data.length, false);` — `// big-endian`
- `crcView.setUint32(0, crc32(crcBytes), false);` — `// big-endian`
