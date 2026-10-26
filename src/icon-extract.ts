/**
 * Minimal ICO and PE-icon readers used to derive a game cover image from a
 * .ico file or an .exe embedded icon resource. The goal is to produce bytes
 * that nx.js's Image can decode (PNG or JPEG). BMP entries are converted to
 * PNG in memory because nx.js does not expose a BMP decoder.
 *
 * The readers are intentionally narrow: they only need to handle the icon
 * shapes that real-world TCOAAL-style deployments ship (32-bit BGRA BMP icons
 * and PNG-embedded modern icons). They reject anything they cannot handle
 * rather than guessing, so the library UI can fall back to a placeholder.
 */

/** Common to all valid PNGs: the 8-byte signature. */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(bytes: Uint8Array, offset = 0): boolean {
        if (bytes.length < offset + 8) return false;
        for (let i = 0; i < 8; i++) if (bytes[offset + i] !== PNG_SIGNATURE[i]) return false;
        return true;
}

function readU16(view: DataView, offset: number): number { return view.getUint16(offset, true); }
function readU32(view: DataView, offset: number): number { return view.getUint32(offset, true); }

/**
 * Pick the highest-resolution PNG entry from an ICO file. PNG-embedded icons
 * (modern Windows) can be passed straight to nx.js's Image decoder. If the
 * file only contains BMP entries, this returns null and {@link extractIcoBmp}
 * should be tried instead.
 */
export function extractIcoPng(buffer: ArrayBuffer): ArrayBuffer | null {
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 6) return null;
        const view = new DataView(buffer);
        if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return null; // reserved=0, type=1 (icon)
        const count = readU16(view, 4);
        if (count === 0 || count > 256) return null;
        let best: { width: number; bytes: Uint8Array } | null = null;
        for (let i = 0; i < count; i++) {
                const entry = 6 + i * 16;
                if (bytes.length < entry + 16) break;
                const widthField = bytes[entry];
                const width = widthField === 0 ? 256 : widthField;
                const size = readU32(view, entry + 8);
                const offset = readU32(view, entry + 12);
                if (!size || offset + size > bytes.length) continue;
                const slice = bytes.subarray(offset, offset + size);
                if (!isPng(slice)) continue;
                if (!best || width > best.width) best = { width, bytes: slice };
        }
        return best ? best.bytes.slice().buffer : null;
}

interface BmpEntry { width: number; height: number; bitCount: number; bytes: Uint8Array; }

/** Read the BMP entry with the largest pixel count and deepest color. */
function pickIcoBmp(buffer: ArrayBuffer): BmpEntry | null {
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 6) return null;
        const view = new DataView(buffer);
        if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return null;
        const count = readU16(view, 4);
        if (count === 0 || count > 256) return null;
        let best: BmpEntry | null = null;
        for (let i = 0; i < count; i++) {
                const entry = 6 + i * 16;
                if (bytes.length < entry + 16) break;
                const widthField = bytes[entry];
                const width = widthField === 0 ? 256 : widthField;
                const heightField = bytes[entry + 1];
                const height = heightField === 0 ? 256 : heightField;
                const bitCount = readU16(view, entry + 6);
                const size = readU32(view, entry + 8);
                const offset = readU32(view, entry + 12);
                if (!size || offset + size > bytes.length) continue;
                const data = bytes.subarray(offset, offset + size);
                if (isPng(data)) continue; // handled by extractIcoPng
                const score = width * height * bitCount;
                if (!best || score > best.width * best.height * best.bitCount) {
                        best = { width, height, bitCount, bytes: data };
                }
        }
        return best;
}

const CRC32_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
                table[n] = c;
        }
        return table;
})();

function crc32(bytes: Uint8Array): number {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
}

// PNG and zlib use big-endian (network byte order) for all 32-bit fields
// (chunk length, chunk type, chunk CRC, IHDR width/height, Adler-32). Only
// DEFLATE's LEN/NLEN within uncompressed blocks are little-endian. The
// previous implementation wrote everything little-endian, producing
// malformed PNGs that the native decoder could not parse — and on Switch,
// attempting to decode such a malformed PNG via Image.src crashed the
// runtime without a catchable JS error.
function u32(view: DataView, offset: number, value: number) { view.setUint32(offset, value, false); /* big-endian */ }
function u16(view: DataView, offset: number, value: number) { view.setUint16(offset, value, true); /* little-endian, for DEFLATE LEN/NLEN */ }

/** Encode 32-bit BGRA / 24-bit BGR / 8-bit indexed BMP icon data as a PNG. */
function encodePng(width: number, height: number, src: Uint8Array, bitCount: number, palette?: Uint8Array): ArrayBuffer | null {
        const rowBytes = Math.floor((bitCount * width + 31) / 32) * 4;
        if (!src || src.length < rowBytes * height) return null;
        const outRow = width * 4;
        const outPixels = new Uint8Array(outRow * height);
        if (bitCount === 32) {
                for (let y = 0; y < height; y++) {
                        const srcOffset = y * rowBytes, dstOffset = (height - 1 - y) * outRow;
                        for (let x = 0; x < width; x++) {
                                const b = src[srcOffset + x * 4], g = src[srcOffset + x * 4 + 1], r = src[srcOffset + x * 4 + 2], a = src[srcOffset + x * 4 + 3];
                                outPixels[dstOffset + x * 4] = r; outPixels[dstOffset + x * 4 + 1] = g; outPixels[dstOffset + x * 4 + 2] = b; outPixels[dstOffset + x * 4 + 3] = a;
                        }
                }
        } else if (bitCount === 24) {
                for (let y = 0; y < height; y++) {
                        const srcOffset = y * rowBytes, dstOffset = (height - 1 - y) * outRow;
                        for (let x = 0; x < width; x++) {
                                const b = src[srcOffset + x * 3], g = src[srcOffset + x * 3 + 1], r = src[srcOffset + x * 3 + 2];
                                outPixels[dstOffset + x * 4] = r; outPixels[dstOffset + x * 4 + 1] = g; outPixels[dstOffset + x * 4 + 2] = b; outPixels[dstOffset + x * 4 + 3] = 0xff;
                        }
                }
        } else if (bitCount === 8 && palette && palette.length >= 256 * 4) {
                for (let y = 0; y < height; y++) {
                        const srcOffset = y * rowBytes, dstOffset = (height - 1 - y) * outRow;
                        for (let x = 0; x < width; x++) {
                                const index = src[srcOffset + x];
                                // BMP palette is BGRA: Blue, Green, Red, reserved.
                                // The reserved byte is not alpha (alpha comes from the
                                // AND mask, which we don't read). Use 0xFF for opaque.
                                outPixels[dstOffset + x * 4] = palette[index * 4 + 2];   // R
                                outPixels[dstOffset + x * 4 + 1] = palette[index * 4 + 1]; // G
                                outPixels[dstOffset + x * 4 + 2] = palette[index * 4];     // B
                                outPixels[dstOffset + x * 4 + 3] = 0xff;                  // A (opaque)
                        }
                }
        } else return null;

        // Build a minimal PNG: signature, IHDR, IDAT (zlib stream), IEND.
        // Use raw DEFLATE blocks (BTYPE=00, no compression) so we do not need
        // a zlib implementation. The PNG IDAT chunk is a zlib stream: a 2-byte
        // header (0x78 0x01) + raw DEFLATE blocks + 4-byte Adler-32.
        const ihdr = new Uint8Array(13);
        const ihdrView = new DataView(ihdr.buffer);
        u32(ihdrView, 0, width); u32(ihdrView, 4, height); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

        // Build raw DEFLATE blocks: one filter byte (0 = None) per row, then BGRA.
        const rawDeflate = new Uint8Array(height * (1 + outRow));
        for (let y = 0; y < height; y++) {
                rawDeflate[y * (1 + outRow)] = 0;
                rawDeflate.set(outPixels.subarray(y * outRow, (y + 1) * outRow), y * (1 + outRow) + 1);
        }
        // Split into uncompressed blocks of up to 65535 bytes each.
        const maxBlock = 65535;
        const numBlocks = Math.max(1, Math.ceil(rawDeflate.length / maxBlock));
        let totalLen = 2 + numBlocks * 5 + rawDeflate.length + 4;
        const zlibStream = new Uint8Array(totalLen);
        let p = 0;
        zlibStream[p++] = 0x78; zlibStream[p++] = 0x01;
        for (let b = 0; b < numBlocks; b++) {
                const start = b * maxBlock, end = Math.min(start + maxBlock, rawDeflate.length);
                const isFinal = end === rawDeflate.length;
                zlibStream[p++] = isFinal ? 1 : 0;
                const len = end - start, nlen = len ^ 0xffff;
                const view = new DataView(zlibStream.buffer, p);
                u16(view, 0, len); u16(view, 2, nlen);
                p += 4;
                zlibStream.set(rawDeflate.subarray(start, end), p);
                p += len;
        }
        // Adler-32 of the raw data.
        let a = 1, b = 0;
        for (let i = 0; i < rawDeflate.length; i++) { a = (a + rawDeflate[i]) % 65521; b = (b + a) % 65521; }
        const adler = ((b << 16) | a) >>> 0;
        const adlerView = new DataView(zlibStream.buffer, p);
        u32(adlerView, 0, adler);

        // Assemble PNG chunks.
        const chunks: { type: number; data: Uint8Array }[] = [
                { type: 0x49484452, data: ihdr }, // IHDR
                { type: 0x49444154, data: zlibStream }, // IDAT
                { type: 0x49454e44, data: new Uint8Array(0) }, // IEND
        ];
        let total = 8;
        for (const chunk of chunks) total += 8 + chunk.data.length + 4;
        const out = new Uint8Array(total);
        const outView = new DataView(out.buffer);
        out.set(PNG_SIGNATURE, 0);
        let q = 8;
        for (const chunk of chunks) {
                u32(outView, q, chunk.data.length); q += 4;
                const typeView = new DataView(out.buffer, q);
                u32(typeView, 0, chunk.type);
                out.set(chunk.data, q + 4); q += 4 + chunk.data.length;
                // CRC is computed over type + data.
                const crcBytes = new Uint8Array(4 + chunk.data.length);
                const crcView = new DataView(crcBytes.buffer);
                u32(crcView, 0, chunk.type);
                crcBytes.set(chunk.data, 4);
                u32(outView, q, crc32(crcBytes));
                q += 4;
        }
        return out.buffer;
}

/** Convert a BMP-style ICO entry (BGRA pixels + optional palette) to PNG. */
export function extractIcoBmp(buffer: ArrayBuffer): ArrayBuffer | null {
        const entry = pickIcoBmp(buffer);
        if (!entry) return null;
        // ICO BMP entries are DIBs without the BITMAPFILEHEADER. The BITMAPINFOHEADER
        // is at the start of the entry; for 8-bit icons a palette follows.
        const dib = entry.bytes;
        if (dib.length < 40) return null;
        const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
        const headerSize = readU32(view, 0);
        if (headerSize < 40) return null;
        const width = entry.width;
        // ICO BMP entries always store a doubled biHeight (color plane + AND
        // mask). The actual pixel height is half of that.
        const dibHeight = readU32(view, 8);
        if (dibHeight <= 0) return null;
        const height = (dibHeight / 2) | 0;
        if (width <= 0 || height <= 0) return null;
        const planes = readU16(view, 12);
        const bitCount = readU16(view, 14);
        if (planes !== 1) return null;
        const pixelOffset = headerSize + (bitCount === 8 ? 256 * 4 : 0);
        const palette = bitCount === 8 ? dib.subarray(headerSize, headerSize + 256 * 4) : undefined;
        const pixels = dib.subarray(pixelOffset);
        return encodePng(width, height, pixels, bitCount, palette);
}

/** Try PNG first (modern icons) then BMP (classic icons). */
export function extractIco(buffer: ArrayBuffer): ArrayBuffer | null {
        return extractIcoPng(buffer) || extractIcoBmp(buffer);
}

/** Parse a PE (.exe) resource directory and return the largest embedded icon
 *  as PNG bytes. Returns null for files without recognizable icon resources. */
export function extractExeIcon(buffer: ArrayBuffer): ArrayBuffer | null {
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 0x40) return null;
        const view = new DataView(buffer);
        // DOS header: 'MZ' at offset 0; e_lfanew at offset 0x3c points to PE.
        if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
        const peOffset = readU32(view, 0x3c);
        if (peOffset <= 0 || peOffset + 24 > bytes.length) return null;
        if (view.getUint32(peOffset, true) !== 0x00004550) return null; // 'PE\0\0'
        const numSections = readU16(view, peOffset + 6);
        const optHeaderSize = readU16(view, peOffset + 20);
        const optOffset = peOffset + 24;
        if (optHeaderSize < 16 || optOffset + optHeaderSize > bytes.length) return null;
        const magic = readU16(view, optOffset);
        const isPe32Plus = magic === 0x20b;
        // Data directories start at offset 96 (PE32) or 112 (PE32+) in the opt header.
        const dataDirOffset = optOffset + (isPe32Plus ? 112 : 96);
        if (dataDirOffset + 8 > bytes.length) return null;
        // Directory index 2 is the resource directory.
        const rva = readU32(view, dataDirOffset + 2 * 8);
        const size = readU32(view, dataDirOffset + 2 * 8 + 4);
        if (!rva || !size) return null;
        const sectionTable = optOffset + optHeaderSize;
        const sections: { name: string; virtualAddress: number; virtualSize: number; rawOffset: number; rawSize: number }[] = [];
        for (let i = 0; i < numSections; i++) {
                const off = sectionTable + i * 40;
                if (off + 40 > bytes.length) return null;
                const name = String.fromCharCode(...bytes.subarray(off, off + 8)).replace(/\0+$/, '');
                const virtualSize = readU32(view, off + 8);
                const virtualAddress = readU32(view, off + 12);
                const rawSize = readU32(view, off + 16);
                const rawOffset = readU32(view, off + 20);
                sections.push({ name, virtualAddress, virtualSize, rawOffset, rawSize });
        }
        const rsrc = sections.find((s) => s.name === '.rsrc');
        if (!rsrc) return null;
        const rsrcFileOffset = rsrc.rawOffset + (rva - rsrc.virtualAddress);
        if (rsrcFileOffset < 0 || rsrcFileOffset + size > bytes.length) return null;
        // Walk the resource tree. Layer 1 = type, layer 2 = id/name, layer 3 = data.
        // RT_ICON = 3. RT_ICON entries are typically raw PNG or BMP DIBs.
        const readDir = (offset: number): { entries: { id: number; dataOffset: number; isDir: boolean }[] } => {
                if (offset + 16 > bytes.length) return { entries: [] };
                const numName = readU16(view, offset + 12);
                const numId = readU16(view, offset + 14);
                const entries: { id: number; dataOffset: number; isDir: boolean }[] = [];
                for (let i = 0; i < numName + numId; i++) {
                        const e = offset + 16 + i * 8;
                        if (e + 8 > bytes.length) break;
                        const id = readU32(view, e);
                        const data = readU32(view, e + 4);
                        entries.push({ id, dataOffset: data & 0x7fffffff, isDir: (data & 0x80000000) !== 0 });
                }
                return { entries };
        };
        const l1 = readDir(rsrcFileOffset);
        const rtIcon = l1.entries.find((e) => e.id === 3);
        if (!rtIcon || !rtIcon.isDir) return null;
        // l2 = each icon id; pick the one whose bytes look like a PNG first, then BMP.
        const l2 = readDir(rsrcFileOffset + rtIcon.dataOffset);
        let bestPng: { width: number; bytes: Uint8Array } | null = null;
        let bestBmp: { score: number; bytes: Uint8Array } | null = null;
        for (const entry of l2.entries) {
                if (!entry.isDir) continue;
                const l3 = readDir(rsrcFileOffset + entry.dataOffset);
                for (const data of l3.entries) {
                        if (data.isDir) continue;
                        const off = rsrcFileOffset + data.dataOffset;
                        if (off + 8 > bytes.length) continue;
                        const dataRva = readU32(view, off);
                        const dataSize = readU32(view, off + 4);
                        const fileOff = rsrc.rawOffset + (dataRva - rsrc.virtualAddress);
                        if (fileOff < 0 || fileOff + dataSize > bytes.length) continue;
                        const slice = bytes.subarray(fileOff, fileOff + dataSize);
                        if (isPng(slice)) {
                                // Parse IHDR for width.
                                const v = new DataView(slice.buffer, slice.byteOffset, Math.min(slice.length, 24));
                                const width = readU32(v, 16);
                                if (!bestPng || width > bestPng.width) bestPng = { width, bytes: slice };
                        } else if (slice.length >= 40) {
                                // DIB without ICONDIR/ICONDIRENTRY headers. Synthesize an
                                // ICO wrapper around it so the existing extractIcoBmp path
                                // can decode it. Read biWidth/biHeight/biBitCount from the
                                // BITMAPINFOHEADER (offsets 4, 8, 14 respectively, all
                                // little-endian per the BMP spec). biHeight is doubled in
                                // ICO (color plane + AND mask) — halve it for the entry.
                                const dibView = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
                                const biWidth = dibView.getUint32(4, true);
                                const biHeight = dibView.getUint32(8, true); // doubled for ICO
                                const biPlanes = dibView.getUint16(12, true);
                                const biBitCount = dibView.getUint16(14, true);
                                if (!biWidth || !biHeight) continue;
                                const actualWidth = biWidth;
                                const actualHeight = (biHeight / 2) | 0;
                                const synth = new Uint8Array(6 + 16 + slice.length);
                                const synthView = new DataView(synth.buffer);
                                // ICONDIR (6 bytes)
                                synthView.setUint16(0, 0, true);  // reserved
                                synthView.setUint16(2, 1, true);  // type = ICO
                                synthView.setUint16(4, 1, true);  // count = 1
                                // ICONDIRENTRY (16 bytes, starting at synth[6])
                                synth[6] = actualWidth >= 256 ? 0 : actualWidth;  // bWidth (0 = 256)
                                synth[7] = actualHeight >= 256 ? 0 : actualHeight;  // bHeight
                                synth[8] = 0;  // bColorCount (0 if >= 8bpp)
                                synth[9] = 0;  // bReserved
                                synthView.setUint16(10, biPlanes, true);  // wPlanes (at synth[10..11])
                                synthView.setUint16(12, biBitCount, true);  // wBitCount (at synth[12..13])
                                synthView.setUint32(14, slice.length, true);  // dwBytesInRes (at synth[14..17])
                                synthView.setUint32(18, 22, true);  // dwImageOffset = 6+16 (at synth[18..21])
                                // DIB data (at synth[22..])
                                synth.set(slice, 22);
                                const score = actualWidth * actualHeight * biBitCount;
                                if (!bestBmp || score > bestBmp.score) bestBmp = { score, bytes: synth };
                        }
                }
        }
        if (bestPng) return bestPng.bytes.slice().buffer;
        if (bestBmp) return extractIcoBmp(bestBmp.bytes.buffer);
        return null;
}
