# `icon-extract.ts`

Minimal ICO and PE-icon readers used to derive a game cover image from a `.ico` file or an `.exe` embedded icon resource. The goal is to produce bytes that nx.js's `Image` can decode (PNG or JPEG); BMP entries are converted to PNG in memory because nx.js does not expose a BMP decoder.

## File header / module overview

> ```
> Minimal ICO and PE-icon readers used to derive a game cover image from a
> .ico file or an .exe embedded icon resource. The goal is to produce bytes
> that nx.js's Image can decode (PNG or JPEG). BMP entries are converted to
> PNG in memory because nx.js does not expose a BMP decoder.
>
> The readers are intentionally narrow: they only need to handle the icon
> shapes that real-world TCOAAL-style deployments ship (32-bit BGRA BMP icons
> and PNG-embedded modern icons). They reject anything they cannot handle
> rather than guessing, so the library UI can fall back to a placeholder.
> ```

## `PNG_SIGNATURE` (module constant)

> Common to all valid PNGs: the 8-byte signature.

## `extractIcoPng`

> ```
> Pick the highest-resolution PNG entry from an ICO file. PNG-embedded icons
> (modern Windows) can be passed straight to nx.js's Image decoder. If the
> file only contains BMP entries, this returns null and {@link extractIcoBmp}
> should be tried instead.
> ```

## `pickIcoBmp`

> Read the BMP entry with the largest pixel count and deepest color.

## `u32` / `u16` (PNG byte-order helpers)

> ```
> PNG and zlib use big-endian (network byte order) for all 32-bit fields
> (chunk length, chunk type, chunk CRC, IHDR width/height, Adler-32). Only
> DEFLATE's LEN/NLEN within uncompressed blocks are little-endian. The
> previous implementation wrote everything little-endian, producing
> malformed PNGs that the native decoder could not parse — and on Switch,
> attempting to decode such a malformed PNG via Image.src crashed the
> runtime without a catchable JS error.
> ```

(Original inline trailing comments on these helpers: `u32` — `/* big-endian */`; `u16` — `/* little-endian, for DEFLATE LEN/NLEN */`.)

## `encodePng`

> Encode 32-bit BGRA / 24-bit BGR / 8-bit indexed BMP icon data as a PNG.

### 8-bit indexed palette handling

> ```
> BMP palette is BGRA: Blue, Green, Red, reserved.
> The reserved byte is not alpha (alpha comes from the
> AND mask, which we don't read). Use 0xFF for opaque.
> ```

(Original inline channel labels on the palette-write lines: `// R`, `// G`, `// B`, `// A (opaque)`.)

### Minimal PNG / zlib stream assembly

> ```
> Build a minimal PNG: signature, IHDR, IDAT (zlib stream), IEND.
> Use raw DEFLATE blocks (BTYPE=00, no compression) so we do not need
> a zlib implementation. The PNG IDAT chunk is a zlib stream: a 2-byte
> header (0x78 0x01) + raw DEFLATE blocks + 4-byte Adler-32.
> ```

(Original single-line step labels preserved here: `// Build raw DEFLATE blocks: one filter byte (0 = None) per row, then BGRA.`; `// Split into uncompressed blocks of up to 65535 bytes each.`; `// Adler-32 of the raw data.`; `// Assemble PNG chunks.`.)

(Original inline chunk-type labels on the `chunks` array entries: `// IHDR`, `// IDAT`, `// IEND`.)

> CRC is computed over type + data.

## `extractIcoBmp`

> Convert a BMP-style ICO entry (BGRA pixels + optional palette) to PNG.

### DIB layout notes

> ```
> ICO BMP entries are DIBs without the BITMAPFILEHEADER. The BITMAPINFOHEADER
> is at the start of the entry; for 8-bit icons a palette follows.
> ```

> ```
> ICO BMP entries always store a doubled biHeight (color plane + AND
> mask). The actual pixel height is half of that.
> ```

## `extractIco`

> Try PNG first (modern icons) then BMP (classic icons).

## `extractExeIcon`

> ```
> Parse a PE (.exe) resource directory and return the largest embedded icon
> as PNG bytes. Returns null for files without recognizable icon resources.
> ```

### PE / resource-tree walking notes

> DOS header: 'MZ' at offset 0; e_lfanew at offset 0x3c points to PE.

(Original inline trailing: `view.getUint32(peOffset, true) !== 0x00004550` was annotated `// 'PE\0\0'`.)

> Data directories start at offset 96 (PE32) or 112 (PE32+) in the opt header.

> Directory index 2 is the resource directory.

> ```
> Walk the resource tree. Layer 1 = type, layer 2 = id/name, layer 3 = data.
> RT_ICON = 3. RT_ICON entries are typically raw PNG or BMP DIBs.
> ```

> l2 = each icon id; pick the one whose bytes look like a PNG first, then BMP.

> Parse IHDR for width.

### Synthetic ICO wrapper around a bare DIB

> ```
> DIB without ICONDIR/ICONDIRENTRY headers. Synthesize an
> ICO wrapper around it so the existing extractIcoBmp path
> can decode it. Read biWidth/biHeight/biBitCount from the
> BITMAPINFOHEADER (offsets 4, 8, 14 respectively, all
> little-endian per the BMP spec). biHeight is doubled in
> ICO (color plane + AND mask) — halve it for the entry.
> ```

(Original inline trailing on `biHeight` read: `// doubled for ICO`.)

### Synthesized ICONDIR / ICONDIRENTRY byte layout

(Original inline trailing labels on the synthesized wrapper writes, preserved verbatim here:)

> - `synthView.setUint16(0, 0, true);` — `// reserved`
> - `synthView.setUint16(2, 1, true);` — `// type = ICO`
> - `synthView.setUint16(4, 1, true);` — `// count = 1`
> - `synth[6] = actualWidth >= 256 ? 0 : actualWidth;` — `// bWidth (0 = 256)`
> - `synth[7] = actualHeight >= 256 ? 0 : actualHeight;` — `// bHeight`
> - `synth[8] = 0;` — `// bColorCount (0 if >= 8bpp)`
> - `synth[9] = 0;` — `// bReserved`
> - `synthView.setUint16(10, biPlanes, true);` — `// wPlanes (at synth[10..11])`
> - `synthView.setUint16(12, biBitCount, true);` — `// wBitCount (at synth[12..13])`
> - `synthView.setUint32(14, slice.length, true);` — `// dwBytesInRes (at synth[14..17])`
> - `synthView.setUint32(18, 22, true);` — `// dwImageOffset = 6+16 (at synth[18..21])`
> - `synth.set(slice, 22);` — `// DIB data (at synth[22..])`
