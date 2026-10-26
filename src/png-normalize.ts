/**
 * Minimal DEFLATE (RFC 1951) inflater and PNG normalizer.
 *
 * nx.js's native Image decoder crashes on 16-bit RGBA PNGs (bitDepth=16,
 * colorType=6), which is the format Windows uses for high-resolution
 * .exe icon resources. Since there's no built-in zlib on Switch, we
 * implement just enough of DEFLATE to decompress IDAT, unfilter the
 * scanlines, and re-encode as an 8-bit RGBA PNG that nx.js CAN decode.
 *
 * The inflater handles all three block types: stored (BTYPE=00), fixed
 * Huffman (BTYPE=01), and dynamic Huffman (BTYPE=10). It is deliberately
 * compact — correctness over speed — since it only runs once per cover
 * extraction, not per frame.
 */

// === Bit reader (LSB-first, per RFC 1951) ===============================
class BitReader {
        private data: Uint8Array;
        private bytePos = 0;
        private bitBuf = 0;
        private bitCnt = 0;
        constructor(data: Uint8Array) { this.data = data; }
        readBits(n: number): number {
                while (this.bitCnt < n) {
                        if (this.bytePos >= this.data.length) throw new Error('DEFLATE: unexpected end of stream');
                        this.bitBuf |= this.data[this.bytePos++] << this.bitCnt;
                        this.bitCnt += 8;
                }
                const val = this.bitBuf & ((1 << n) - 1);
                this.bitBuf >>>= n;
                this.bitCnt -= n;
                return val;
        }
        alignToByte(): void { this.bitBuf >>>= this.bitCnt; this.bitCnt = 0; }
        readByte(): number { this.alignToByte(); if (this.bytePos >= this.data.length) throw new Error('DEFLATE: end of stream'); return this.data[this.bytePos++]; }
}

// === Canonical Huffman table builder ====================================
// RFC 1951 section 3.2.2: codes are assigned in order of increasing length,
// and within the same length, in the order the symbols appear.
// The key in the lookup Map is (length << 16) | code_value, where code_value
// is the canonical Huffman code (MSB-first). The decoder builds `code`
// the same way (shift left + OR new bit), so the values match directly.
interface HuffmanTable { lookup: Map<number, number>; maxLen: number; }
function buildHuffman(lengths: number[]): HuffmanTable {
        const maxLen = Math.max(0, ...lengths);
        const blCount = new Array(maxLen + 1).fill(0);
        for (const len of lengths) if (len > 0) blCount[len]++;
        let code = 0;
        const nextCode = new Array(maxLen + 1).fill(0);
        for (let bits = 1; bits <= maxLen; bits++) { code = (code + blCount[bits - 1]) << 1; nextCode[bits] = code; }
        const lookup = new Map<number, number>();
        for (let sym = 0; sym < lengths.length; sym++) {
                const len = lengths[sym];
                if (len > 0) { lookup.set((len << 16) | nextCode[len], sym); nextCode[len]++; }
        }
        return { lookup, maxLen };
}
function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
        let code = 0;
        for (let len = 1; len <= table.maxLen; len++) {
                code = (code << 1) | reader.readBits(1);
                const key = (len << 16) | code;
                const sym = table.lookup.get(key);
                if (sym !== undefined) return sym;
        }
        throw new Error('DEFLATE: invalid Huffman code');
}

// === Fixed Huffman tables (RFC 1951 section 3.2.6) ======================
// Fixed Huffman lengths are constant data (small arrays, cheap).
const FIXED_LIT_LENGTHS = (() => {
        const a = new Array(288);
        for (let i = 0; i < 144; i++) a[i] = 8;
        for (let i = 144; i < 256; i++) a[i] = 9;
        for (let i = 256; i < 280; i++) a[i] = 7;
        for (let i = 280; i < 288; i++) a[i] = 8;
        return a;
})();
const FIXED_DIST_LENGTHS = new Array(30).fill(5);
// Fixed Huffman TABLES are created lazily (not at module scope) to save
// startup memory. They allocate Maps with 288 and 30 entries each.
let _fixedLitTable: HuffmanTable | null = null;
let _fixedDistTable: HuffmanTable | null = null;
function getFixedLitTable(): HuffmanTable { if (!_fixedLitTable) _fixedLitTable = buildHuffman(FIXED_LIT_LENGTHS); return _fixedLitTable; }
function getFixedDistTable(): HuffmanTable { if (!_fixedDistTable) _fixedDistTable = buildHuffman(FIXED_DIST_LENGTHS); return _fixedDistTable; }

// === Length and distance code tables (RFC 1951 section 3.2.5) ==========
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// === Main inflate function ==============================================
export function inflate(data: Uint8Array): Uint8Array {
        const reader = new BitReader(data);
        const out: number[] = [];
        let done = false;
        while (!done) {
                const bfinal = reader.readBits(1);
                const btype = reader.readBits(2);
                if (btype === 0) {
                        // Stored block
                        reader.alignToByte();
                        const len = reader.readByte() | (reader.readByte() << 8);
                        reader.readByte(); reader.readByte(); // NLEN (ignored)
                        for (let i = 0; i < len; i++) out.push(reader.readByte());
                } else if (btype === 1) {
                        // Fixed Huffman
                        decodeBlock(reader, getFixedLitTable(), getFixedDistTable(), out);
                } else if (btype === 2) {
                        // Dynamic Huffman
                        const hlit = reader.readBits(5) + 257;
                        const hdist = reader.readBits(5) + 1;
                        const hclen = reader.readBits(4) + 4;
                        const codeLenOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
                        const clLengths = new Array(19).fill(0);
                        for (let i = 0; i < hclen; i++) clLengths[codeLenOrder[i]] = reader.readBits(3);
                        const clTable = buildHuffman(clLengths);
                        const litDistLengths: number[] = [];
                        while (litDistLengths.length < hlit + hdist) {
                                const sym = decodeSymbol(reader, clTable);
                                if (sym < 16) litDistLengths.push(sym);
                                else if (sym === 16) { const rep = 3 + reader.readBits(2); const prev = litDistLengths[litDistLengths.length - 1] || 0; for (let i = 0; i < rep; i++) litDistLengths.push(prev); }
                                else if (sym === 17) { const rep = 3 + reader.readBits(3); for (let i = 0; i < rep; i++) litDistLengths.push(0); }
                                else if (sym === 18) { const rep = 11 + reader.readBits(7); for (let i = 0; i < rep; i++) litDistLengths.push(0); }
                        }
                        const litTable = buildHuffman(litDistLengths.slice(0, hlit));
                        const distTable = buildHuffman(litDistLengths.slice(hlit));
                        decodeBlock(reader, litTable, distTable, out);
                } else throw new Error('DEFLATE: invalid BTYPE 3');
                done = bfinal === 1;
        }
        return new Uint8Array(out);
}

function decodeBlock(reader: BitReader, litTable: HuffmanTable, distTable: HuffmanTable, out: number[]): void {
        while (true) {
                const sym = decodeSymbol(reader, litTable);
                if (sym < 256) { out.push(sym); continue; }
                if (sym === 256) return; // end of block
                const lenIdx = sym - 257;
                if (lenIdx >= LENGTH_BASE.length) throw new Error(`DEFLATE: invalid length symbol ${sym}`);
                const length = LENGTH_BASE[lenIdx] + reader.readBits(LENGTH_EXTRA[lenIdx]);
                const distSym = decodeSymbol(reader, distTable);
                if (distSym >= DIST_BASE.length) throw new Error(`DEFLATE: invalid distance symbol ${distSym}`);
                const dist = DIST_BASE[distSym] + reader.readBits(DIST_EXTRA[distSym]);
                const start = out.length - dist;
                for (let i = 0; i < length; i++) out.push(out[start + i]);
        }
}

// === PNG filter unfiltering (RFC 2083 section 4.2) ======================
// Each scanline starts with a filter byte (0=None, 1=Sub, 2=Up, 3=Average,
// 4=Paeth). bpp = bytes per pixel (e.g., 4 for 8-bit RGBA, 8 for 16-bit RGBA).
export function unfilterScanlines(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
        const rowLen = width * bpp;
        const out = new Uint8Array(height * rowLen);
        let src = 0, dst = 0;
        const prev = new Uint8Array(rowLen); // previous row (unfiltered)
        for (let y = 0; y < height; y++) {
                const filter = data[src++]; src--;
                // Actually read the filter byte properly:
                const f = data[src++];
                for (let x = 0; x < rowLen; x++) {
                        const cur = data[src++];
                        const left = x >= bpp ? out[dst + x - bpp] : 0;
                        const up = prev[x] || 0;
                        let val: number;
                        if (f === 0) val = cur;
                        else if (f === 1) val = (cur + left) & 0xff;
                        else if (f === 2) val = (cur + up) & 0xff;
                        else if (f === 3) val = (cur + Math.floor((left + up) / 2)) & 0xff;
                        else if (f === 4) {
                                const a = left, b = up, c = x >= bpp ? prev[x - bpp] : 0;
                                const p = a + b - c;
                                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                                let paeth: number;
                                if (pa <= pb && pa <= pc) paeth = a;
                                else if (pb <= pc) paeth = b;
                                else paeth = c;
                                val = (cur + paeth) & 0xff;
                        } else val = cur;
                        out[dst + x] = val;
                }
                prev.set(out.subarray(dst, dst + rowLen));
                dst += rowLen;
        }
        return out;
}

// === PNG normalizer: convert any PNG to 8-bit RGBA =====================
// Parses the PNG chunks, inflates the IDAT, unfilter scanlines, converts
// to 8-bit RGBA, and re-encodes as a standard 8-bit RGBA PNG that nx.js's
// native Image decoder can handle. Returns null if the PNG is malformed or
// uses unsupported features (e.g., interlacing).
export function normalizePngTo8bitRgba(pngBytes: ArrayBuffer): ArrayBuffer | null {
        const u8 = new Uint8Array(pngBytes);
        if (u8.length < 8) return null;
        // Verify PNG signature
        const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) return null;
        // Walk chunks to find IHDR and IDAT
        let offset = 8;
        let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
        const idatChunks: Uint8Array[] = [];
        let palette: Uint8Array | null = null;
        let trns: Uint8Array | null = null;
        while (offset < u8.length) {
                if (offset + 8 > u8.length) return null;
                const view = new DataView(pngBytes, offset, 8);
                const len = view.getUint32(0, false); // big-endian
                const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
                if (offset + 8 + len + 4 > u8.length) return null;
                const data = u8.subarray(offset + 8, offset + 8 + len);
                if (type === 'IHDR') {
                        if (len < 13) return null;
                        const ihdrView = new DataView(pngBytes, offset + 8, 13);
                        width = ihdrView.getUint32(0, false);
                        height = ihdrView.getUint32(4, false);
                        bitDepth = data[8];
                        colorType = data[9];
                        interlace = data[12];
                } else if (type === 'IDAT') {
                        idatChunks.push(data);
                } else if (type === 'PLTE') {
                        palette = data;
                } else if (type === 'tRNS') {
                        trns = data;
                } else if (type === 'IEND') break;
                offset += 8 + len + 4;
        }
        if (interlace !== 0) return null; // interlaced PNGs not supported
        if (bitDepth === 8 && colorType === 6) return pngBytes; // already 8-bit RGBA
        if (bitDepth === 8 && colorType === 2) return pngBytes; // already 8-bit RGB
        // Concatenate IDAT chunks and inflate
        let idatLen = 0;
        for (const c of idatChunks) idatLen += c.length;
        const idat = new Uint8Array(idatLen);
        let p = 0;
        for (const c of idatChunks) { idat.set(c, p); p += c.length; }
        if (idat.length < 2) return null;
        // Skip zlib header (2 bytes: CMF, FLG) and Adler-32 (4 bytes at end)
        let zlibHeader = 2;
        if ((idat[0] & 0x0f) !== 8) return null; // CM must be 8 (deflate)
        if (idat.length < 6) return null;
        const deflateData = idat.subarray(zlibHeader, idat.length - 4);
        let raw: Uint8Array;
        try { raw = inflate(deflateData); } catch (e) { return null; }
        // Compute bytes per pixel
        const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
        if (!channels) return null;
        const bytesPerSample = bitDepth === 16 ? 2 : 1;
        const bpp = channels * bytesPerSample;
        if (raw.length < height * (1 + width * bpp)) return null;
        // Unfilter scanlines
        let pixels: Uint8Array;
        try { pixels = unfilterScanlines(raw, width, height, bpp); } catch (e) { return null; }
        // Convert to 8-bit RGBA
        const outRow = width * 4;
        const outPixels = new Uint8Array(height * outRow);
        if (bitDepth === 8) {
                if (colorType === 2) {
                        // RGB → RGBA
                        for (let y = 0; y < height; y++) {
                                const srcOff = y * width * 3, dstOff = y * outRow;
                                for (let x = 0; x < width; x++) {
                                        outPixels[dstOff + x * 4] = pixels[srcOff + x * 3];
                                        outPixels[dstOff + x * 4 + 1] = pixels[srcOff + x * 3 + 1];
                                        outPixels[dstOff + x * 4 + 2] = pixels[srcOff + x * 3 + 2];
                                        outPixels[dstOff + x * 4 + 3] = 0xff;
                                }
                        }
                } else if (colorType === 6) {
                        // Already 8-bit RGBA — but we only get here if not returned above
                        outPixels.set(pixels);
                } else if (colorType === 4) {
                        // Grayscale + alpha → RGBA
                        for (let y = 0; y < height; y++) {
                                const srcOff = y * width * 2, dstOff = y * outRow;
                                for (let x = 0; x < width; x++) {
                                        const g = pixels[srcOff + x * 2];
                                        outPixels[dstOff + x * 4] = g;
                                        outPixels[dstOff + x * 4 + 1] = g;
                                        outPixels[dstOff + x * 4 + 2] = g;
                                        outPixels[dstOff + x * 4 + 3] = pixels[srcOff + x * 2 + 1];
                                }
                        }
                } else if (colorType === 0) {
                        // Grayscale → RGBA
                        for (let y = 0; y < height; y++) {
                                const srcOff = y * width, dstOff = y * outRow;
                                for (let x = 0; x < width; x++) {
                                        const g = pixels[srcOff + x];
                                        outPixels[dstOff + x * 4] = g;
                                        outPixels[dstOff + x * 4 + 1] = g;
                                        outPixels[dstOff + x * 4 + 2] = g;
                                        outPixels[dstOff + x * 4 + 3] = 0xff;
                                }
                        }
                } else if (colorType === 3 && palette) {
                        // Indexed → RGBA
                        for (let y = 0; y < height; y++) {
                                const srcOff = y * width, dstOff = y * outRow;
                                for (let x = 0; x < width; x++) {
                                        const idx = pixels[srcOff + x];
                                        outPixels[dstOff + x * 4] = palette[idx * 3];
                                        outPixels[dstOff + x * 4 + 1] = palette[idx * 3 + 1];
                                        outPixels[dstOff + x * 4 + 2] = palette[idx * 3 + 2];
                                        outPixels[dstOff + x * 4 + 3] = (trns && idx < trns.length) ? trns[idx] : 0xff;
                                }
                        }
                }
        } else if (bitDepth === 16) {
                // 16-bit → 8-bit (take high byte, big-endian)
                if (colorType === 2) {
                        // RGB
                        for (let y = 0; y < height; y++) {
                                const srcOff = y * width * 6, dstOff = y * outRow;
                                for (let x = 0; x < width; x++) {
                                        outPixels[dstOff + x * 4] = pixels[srcOff + x * 6];
                                        outPixels[dstOff + x * 4 + 1] = pixels[srcOff + x * 6 + 2];
                                        outPixels[dstOff + x * 4 + 2] = pixels[srcOff + x * 6 + 4];
                                        outPixels[dstOff + x * 4 + 3] = 0xff;
                                }
                        }
                } else if (colorType === 6) {
                        // RGBA
                        for (let y = 0; y < height; y++) {
                                const srcOff = y * width * 8, dstOff = y * outRow;
                                for (let x = 0; x < width; x++) {
                                        outPixels[dstOff + x * 4] = pixels[srcOff + x * 8];
                                        outPixels[dstOff + x * 4 + 1] = pixels[srcOff + x * 8 + 2];
                                        outPixels[dstOff + x * 4 + 2] = pixels[srcOff + x * 8 + 4];
                                        outPixels[dstOff + x * 4 + 3] = pixels[srcOff + x * 8 + 6];
                                }
                        }
                } else if (colorType === 0) {
                        // Grayscale
                        for (let y = 0; y < height; y++) {
                                const srcOff = y * width * 2, dstOff = y * outRow;
                                for (let x = 0; x < width; x++) {
                                        const g = pixels[srcOff + x * 2];
                                        outPixels[dstOff + x * 4] = g;
                                        outPixels[dstOff + x * 4 + 1] = g;
                                        outPixels[dstOff + x * 4 + 2] = g;
                                        outPixels[dstOff + x * 4 + 3] = 0xff;
                                }
                        }
                } else if (colorType === 4) {
                        // Grayscale + alpha
                        for (let y = 0; y < height; y++) {
                                const srcOff = y * width * 4, dstOff = y * outRow;
                                for (let x = 0; x < width; x++) {
                                        const g = pixels[srcOff + x * 4];
                                        outPixels[dstOff + x * 4] = g;
                                        outPixels[dstOff + x * 4 + 1] = g;
                                        outPixels[dstOff + x * 4 + 2] = g;
                                        outPixels[dstOff + x * 4 + 3] = pixels[srcOff + x * 4 + 2];
                                }
                        }
                }
        }
        // Re-encode as 8-bit RGBA PNG using the icon-extract encoder
        return encodeRgbaPng(width, height, outPixels);
}

// === 8-bit RGBA PNG encoder (raw DEFLATE, no compression) ==============
// Same algorithm as icon-extract.ts's encodePng but simplified for
// 8-bit RGBA input only. All 32-bit fields are big-endian per PNG spec.
// CRC32 table created lazily (256 entries = 1KB Uint32Array)
let _crc32Table: Uint32Array | null = null;
function getCrc32Table(): Uint32Array {
        if (!_crc32Table) {
                const t = new Uint32Array(256);
                for (let n = 0; n < 256; n++) {
                        let c = n;
                        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
                        t[n] = c;
                }
                _crc32Table = t;
        }
        return _crc32Table;
}
function crc32(bytes: Uint8Array): number { let c = 0xffffffff; const t = getCrc32Table(); for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function encodeRgbaPng(width: number, height: number, pixels: Uint8Array): ArrayBuffer {
        const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const outRow = width * 4;
        // IHDR
        const ihdr = new Uint8Array(13);
        const ihdrView = new DataView(ihdr.buffer);
        ihdrView.setUint32(0, width, false); // big-endian
        ihdrView.setUint32(4, height, false);
        ihdr[8] = 8; // bitDepth
        ihdr[9] = 6; // colorType = RGBA
        ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
        // Raw DEFLATE: filter byte (0=None) + pixel data per row
        const rawDeflate = new Uint8Array(height * (1 + outRow));
        for (let y = 0; y < height; y++) {
                rawDeflate[y * (1 + outRow)] = 0;
                rawDeflate.set(pixels.subarray(y * outRow, (y + 1) * outRow), y * (1 + outRow) + 1);
        }
        // zlib stream: 2-byte header + raw DEFLATE blocks + 4-byte Adler-32
        const maxBlock = 65535;
        const numBlocks = Math.max(1, Math.ceil(rawDeflate.length / maxBlock));
        const zlibLen = 2 + numBlocks * 5 + rawDeflate.length + 4;
        const zlibStream = new Uint8Array(zlibLen);
        let p = 0;
        zlibStream[p++] = 0x78; zlibStream[p++] = 0x01; // zlib header
        for (let b = 0; b < numBlocks; b++) {
                const start = b * maxBlock, end = Math.min(start + maxBlock, rawDeflate.length);
                const isFinal = end === rawDeflate.length;
                zlibStream[p++] = isFinal ? 1 : 0; // BFINAL + BTYPE=00
                const len = end - start;
                zlibStream[p++] = len & 0xff; zlibStream[p++] = (len >> 8) & 0xff; // LEN (LE)
                const nlen = len ^ 0xffff;
                zlibStream[p++] = nlen & 0xff; zlibStream[p++] = (nlen >> 8) & 0xff; // NLEN (LE)
                zlibStream.set(rawDeflate.subarray(start, end), p);
                p += len;
        }
        // Adler-32 (big-endian)
        let a = 1, b = 0;
        for (let i = 0; i < rawDeflate.length; i++) { a = (a + rawDeflate[i]) % 65521; b = (b + a) % 65521; }
        const adler = ((b << 16) | a) >>> 0;
        const adlerView = new DataView(zlibStream.buffer, p);
        adlerView.setUint32(0, adler, false); // big-endian
        // Assemble PNG chunks
        const chunks = [
                { type: [0x49, 0x48, 0x44, 0x52], data: ihdr }, // IHDR
                { type: [0x49, 0x44, 0x41, 0x54], data: zlibStream }, // IDAT
                { type: [0x49, 0x45, 0x4e, 0x44], data: new Uint8Array(0) }, // IEND
        ];
        let total = 8;
        for (const c of chunks) total += 8 + c.data.length + 4;
        const out = new Uint8Array(total);
        out.set(PNG_SIG, 0);
        let q = 8;
        for (const c of chunks) {
                const lenView = new DataView(out.buffer, q, 4);
                lenView.setUint32(0, c.data.length, false); // big-endian
                out[q + 4] = c.type[0]; out[q + 5] = c.type[1]; out[q + 6] = c.type[2]; out[q + 7] = c.type[3];
                out.set(c.data, q + 8);
                const crcBytes = new Uint8Array(4 + c.data.length);
                crcBytes[0] = c.type[0]; crcBytes[1] = c.type[1]; crcBytes[2] = c.type[2]; crcBytes[3] = c.type[3];
                crcBytes.set(c.data, 4);
                const crcView = new DataView(out.buffer, q + 8 + c.data.length, 4);
                crcView.setUint32(0, crc32(crcBytes), false); // big-endian
                q += 8 + c.data.length + 4;
        }
        return out.buffer;
}
