import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

// Load src/forwarder.ts in isolation (its pure helpers — decode/encode/patch —
// don't depend on the Switch global, so we can test them in a vanilla vm
// context without any homebrew runtime). Inject a test
// __FORWARDER_MAIN_JS__ string that contains the 64-zero placeholder.
const TEST_FORWARDER_MAIN_JS = 'const GAME_ID = "' + '0'.repeat(64) + '";\nconst MOD_ENABLED = "0";\nconsole.log(GAME_ID.trim());\n';
async function loadForwarderModule() {
        const bundle = await build({
                entryPoints: ['src/forwarder.ts'], bundle: true, write: false, format: 'iife', globalName: '__fwd', target: 'es2022',
                define: { __FORWARDER_MAIN_JS__: JSON.stringify(TEST_FORWARDER_MAIN_JS) },
        });
        const context = vm.createContext({ TextEncoder, TextDecoder, console: { ...console } });
        vm.runInContext(`${bundle.outputFiles[0].text}`, context);
        return context.__fwd as typeof import('../src/forwarder');
}

// === Synthetic NRO builder for tests =================================
// We don't ship the real ~54 MiB nx.js runtime in the test, so the tests
// build a tiny fake "NRO" with the same layout: an arbitrary code segment
// (just zeros) + an ASET header + an icon blob + a NACP blob + a romfs blob.
// This is enough to exercise decodeNroStructure / encodeNro / writeNacp*
// because they only care about the byte layout, not what the code segment
// actually does.
const NACP_SIZE = 0x4000;
const ASSET_HEADER_SIZE = 0x38;

function buildSyntheticNro(opts: { codeSize?: number; iconBytes?: Uint8Array; nacp?: Uint8Array; romfsBytes?: Uint8Array } = {}): ArrayBuffer {
        const code = new Uint8Array(opts.codeSize ?? 64);
        const icon = opts.iconBytes ?? new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI
        const nacp = opts.nacp ?? new Uint8Array(NACP_SIZE);
        const romfs = opts.romfsBytes ?? new Uint8Array([0x00, 0x01, 0x02, 0x03]);
        const total = code.byteLength + ASSET_HEADER_SIZE + icon.byteLength + nacp.byteLength + romfs.byteLength;
        const out = new Uint8Array(total);
        // NRO header: write "NRO0" magic at 0x10 and nroSize at 0x18.
        out[0x10] = 0x4e; out[0x11] = 0x52; out[0x12] = 0x4f; out[0x13] = 0x30; // "NRO0"
        const view = new DataView(out.buffer);
        view.setUint32(0x18, code.byteLength, true); // nroSize = code segment length
        // Asset header at code.byteLength.
        const base = code.byteLength;
        out[base + 0] = 0x41; out[base + 1] = 0x53; out[base + 2] = 0x45; out[base + 3] = 0x54; // "ASET"
        view.setUint32(base + 4, 0, true); // version
        let rel = ASSET_HEADER_SIZE;
        view.setUint32(base + 0x08, rel, true); view.setUint32(base + 0x10, icon.byteLength, true); rel += icon.byteLength;
        view.setUint32(base + 0x18, rel, true); view.setUint32(base + 0x20, nacp.byteLength, true); rel += nacp.byteLength;
        view.setUint32(base + 0x28, rel, true); view.setUint32(base + 0x30, romfs.byteLength, true);
        let cursor = base + ASSET_HEADER_SIZE;
        out.set(icon, cursor); cursor += icon.byteLength;
        out.set(nacp, cursor); cursor += nacp.byteLength;
        out.set(romfs, cursor); cursor += romfs.byteLength;
        return out.buffer;
}

test('decodeNroStructure parses magic, asset header and section offsets', async () => {
        const fwd = await loadForwarderModule();
        const buf = buildSyntheticNro({ codeSize: 64, iconBytes: new Uint8Array([1, 2, 3, 4]), romfsBytes: new Uint8Array([9, 9, 9]) });
        const s = fwd.decodeNroStructure(buf);
        assert.equal(s.nroSize, 64);
        assert.equal(s.iconSize, 4);
        assert.equal(s.nacpSize, NACP_SIZE);
        assert.equal(s.romfsSize, 3);
        // The absolute offsets are within the buffer.
        assert.ok(s.iconOffset + s.iconSize <= buf.byteLength);
        assert.ok(s.nacpOffset + s.nacpSize <= buf.byteLength);
        assert.ok(s.romfsOffset + s.romfsSize <= buf.byteLength);
        // The icon bytes match.
        const iconBytes = new Uint8Array(buf, s.iconOffset, s.iconSize);
        assert.deepEqual(Array.from(iconBytes), [1, 2, 3, 4]);
});

test('decodeNroStructure rejects bad magic and out-of-bounds sections', async () => {
        const fwd = await loadForwarderModule();
        // Buffer large enough to pass the size check but with wrong magic.
        const bad = new ArrayBuffer(0x100);
        const bytes = new Uint8Array(bad);
        bytes[0x10] = 0xaa; bytes[0x11] = 0xbb; bytes[0x12] = 0xcc; bytes[0x13] = 0xdd;
        assert.throws(() => fwd.decodeNroStructure(bad), /Bad NRO magic/);
        // A too-small buffer is rejected before the magic check.
        assert.throws(() => fwd.decodeNroStructure(new ArrayBuffer(8)), /NRO too small/);
});

test('writeNacpTitle writes the title into all 12 language entries and truncates long names', async () => {
        const fwd = await loadForwarderModule();
        const nacp = new Uint8Array(NACP_SIZE);
        const longName = 'A'.repeat(600); // longer than the 0x200 - 1 = 511 byte limit
        fwd.writeNacpTitle(nacp, longName);
        const decoded = new TextDecoder().decode(new Uint8Array(nacp.buffer, 0, 0x200)).replace(/\0.*$/, '');
        assert.equal(decoded.length, 511);
        assert.equal(decoded, 'A'.repeat(511));
        // All 12 language entries have the same title.
        for (let i = 1; i < 12; i++) {
                const entry = new TextDecoder().decode(new Uint8Array(nacp.buffer, i * 0x300, 0x200)).replace(/\0.*$/, '');
                assert.equal(entry, 'A'.repeat(511), `language entry ${i} matches`);
        }
});

test('writeNacpAuthor and writeNacpId round-trip', async () => {
        const fwd = await loadForwarderModule();
        const nacp = new Uint8Array(NACP_SIZE);
        fwd.writeNacpAuthor(nacp, 'BurialNX');
        const author = new TextDecoder().decode(new Uint8Array(nacp.buffer, 0x200, 0x100)).replace(/\0.*$/, '');
        assert.equal(author, 'BurialNX');
        fwd.writeNacpId(nacp, 0x010000000001abcdn);
        const view = new DataView(nacp.buffer);
        assert.equal(view.getBigUint64(0x3038, true), 0x010000000001abcdn, 'PresenceGroupId');
        assert.equal(view.getBigUint64(0x3078, true), 0x010000000001abcdn, 'SaveDataOwnerId');
        assert.equal(view.getBigUint64(0x3070, true), 0x010000000001abcdn + 0x1000n, 'AddOnContentBaseId');
        for (let x = 0; x < 8; x++) assert.equal(view.getBigUint64(0x30b0 + x * 8, true), 0x010000000001abcdn, `LocalCommunicationId[${x}]`);
});

test('writeNacpForwarderDefaults zeroes save data and disables profile selection', async () => {
        const fwd = await loadForwarderModule();
        // Start with a NACP that has non-zero save data (like burialnx's 16 MiB).
        const nacp = new Uint8Array(NACP_SIZE);
        const view = new DataView(nacp.buffer);
        view.setBigUint64(0x3080, 16777216n, true); // userAccountSaveDataSize = 16 MiB
        view.setBigUint64(0x3088, 16777216n, true); // journalSize
        view.setBigUint64(0x3090, 16777216n, true); // bcatSize
        view.setUint8(0x3025, 1); // startupUserAccount = 1 (show dialog)
        // Apply the forwarder defaults.
        fwd.writeNacpForwarderDefaults(nacp);
        // All save data fields are zero.
        assert.equal(view.getBigUint64(0x3080, true), 0n, 'userAccountSaveDataSize zeroed');
        assert.equal(view.getBigUint64(0x3088, true), 0n, 'journalSize zeroed');
        assert.equal(view.getBigUint64(0x3090, true), 0n, 'bcatSize zeroed');
        // Profile selection is disabled.
        assert.equal(view.getUint8(0x3025), 0, 'startupUserAccount disabled');
});

test('forwarderIdFor is stable, unique per id, and stays in the homebrew title-id range', async () => {
        const fwd = await loadForwarderModule();
        const a = fwd.forwarderIdFor('g1abc23');
        const a2 = fwd.forwarderIdFor('g1abc23');
        const b = fwd.forwarderIdFor('g2def45');
        assert.equal(a, a2, 'stable for the same id');
        assert.notEqual(a, b, 'different for different ids');
        // The forwarder ID base is 0x0100000000010000 | hash16.
        const base = 0x0100000000010000n;
        assert.ok(a >= base && a < base + 0x10000n, 'within the homebrew range');
        assert.ok(b >= base && b < base + 0x10000n, 'within the homebrew range');
});

test('encodeNro produces a valid NRO that decodeNroStructure can parse back', async () => {
        const fwd = await loadForwarderModule();
        // Use a code segment that already contains a valid NRO header
        // (magic + nroSize). buildSyntheticNro builds one; we extract its
        // code segment and re-encode with a custom icon and NACP.
        const template = buildSyntheticNro({ codeSize: 100, iconBytes: new Uint8Array(0), romfsBytes: new Uint8Array(0) });
        const templateStruct = fwd.decodeNroStructure(template);
        const code = new Uint8Array(template, 0, templateStruct.nroSize);
        const icon = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        const nacp = new Uint8Array(NACP_SIZE);
        fwd.writeNacpTitle(nacp, 'Round Trip');
        fwd.writeNacpAuthor(nacp, 'Tester');
        const romfs = new Uint8Array([5, 6, 7, 8, 9]);
        const encoded = fwd.encodeNro(code, icon, nacp, romfs);
        // Validate the encoded NRO header: magic bytes spell "NRO0" and
        // nroSize (at offset 0x18) equals the code segment length.
        const headerBytes = new Uint8Array(encoded.buffer, 0x10, 4);
        assert.equal(new TextDecoder().decode(headerBytes), 'NRO0', 'NRO0 magic');
        const header = new DataView(encoded.buffer);
        assert.equal(header.getUint32(0x18, true), code.byteLength, 'nroSize');
        // Decode and verify the structure matches what we put in.
        const s = fwd.decodeNroStructure(encoded.buffer);
        assert.equal(s.iconSize, icon.byteLength);
        assert.equal(s.nacpSize, NACP_SIZE);
        assert.equal(s.romfsSize, romfs.byteLength);
        // The icon bytes match.
        const iconBack = new Uint8Array(encoded.buffer, s.iconOffset, s.iconSize);
        assert.deepEqual(Array.from(iconBack), [0xde, 0xad, 0xbe, 0xef]);
        // The NACP title survived the round trip.
        const titleBack = new TextDecoder().decode(new Uint8Array(encoded.buffer, s.nacpOffset, 0x200)).replace(/\0.*$/, '');
        assert.equal(titleBack, 'Round Trip');
        // The romfs bytes match.
        const romfsBack = new Uint8Array(encoded.buffer, s.romfsOffset, s.romfsSize);
        assert.deepEqual(Array.from(romfsBack), [5, 6, 7, 8, 9]);
});

test('encodeNro with a different icon size rebuilds the asset header correctly', async () => {
        const fwd = await loadForwarderModule();
        // The code segment must be a valid NRO header (magic + nroSize) so
        // decodeNroStructure can re-parse the output. buildSyntheticNro
        // produces one with codeSize=64; we then call encodeNro with a
        // different icon to verify the asset header is rebuilt.
        const template = buildSyntheticNro({ codeSize: 64, iconBytes: new Uint8Array([1]) });
        const struct = fwd.decodeNroStructure(template);
        const code = new Uint8Array(template, 0, struct.nroSize);
        const smallIcon = new Uint8Array([1]);
        const bigIcon = new Uint8Array(new Array(1024).fill(0xaa));
        const nacp = new Uint8Array(NACP_SIZE);
        const romfs = new Uint8Array([0]);
        // Build with a small icon, then re-encode with a big icon — the
        // asset header must be rebuilt with the new icon section size.
        const first = fwd.encodeNro(code, smallIcon, nacp, romfs);
        const second = fwd.encodeNro(code, bigIcon, nacp, romfs);
        assert.notEqual(first.byteLength, second.byteLength, 'sizes differ');
        const s = fwd.decodeNroStructure(second.buffer);
        assert.equal(s.iconSize, bigIcon.byteLength);
        assert.equal(s.nacpSize, NACP_SIZE);
        assert.equal(s.romfsSize, romfs.byteLength);
        // The icon bytes match the big icon.
        const iconBack = new Uint8Array(second.buffer, s.iconOffset, s.iconSize);
        assert.equal(iconBack[0], 0xaa);
        assert.equal(iconBack[1023], 0xaa);
});

test('decode then re-encode then decode produces the same section offsets', async () => {
        const fwd = await loadForwarderModule();
        const original = buildSyntheticNro({ iconBytes: new Uint8Array(8).fill(0x42) });
        const s1 = fwd.decodeNroStructure(original);
        const code = new Uint8Array(original, 0, s1.nroSize);
        const icon = new Uint8Array(original, s1.iconOffset, s1.iconSize);
        const nacp = new Uint8Array(original, s1.nacpOffset, s1.nacpSize);
        const romfs = new Uint8Array(original, s1.romfsOffset, s1.romfsSize);
        const rebuilt = fwd.encodeNro(code, icon, nacp, romfs);
        const s2 = fwd.decodeNroStructure(rebuilt.buffer);
        assert.equal(s2.iconSize, s1.iconSize);
        assert.equal(s2.nacpSize, s1.nacpSize);
        assert.equal(s2.romfsSize, s1.romfsSize);
        assert.deepEqual(Array.from(new Uint8Array(rebuilt.buffer, s2.iconOffset, s2.iconSize)), Array.from(icon));
        assert.deepEqual(Array.from(new Uint8Array(rebuilt.buffer, s2.romfsOffset, s2.romfsSize)), Array.from(romfs));
});

test('forwarderPathFor produces the expected SD path (subfolder per game)', async () => {
        const fwd = await loadForwarderModule();
        assert.equal(fwd.forwarderPathFor('My Game', 'g1abc23'), 'sdmc:/switch/My Game/My Game.nro');
        // Special characters are stripped from the folder name.
        assert.equal(fwd.forwarderPathFor('Game: Rebirth!', 'g2def45'), 'sdmc:/switch/Game Rebirth/Game Rebirth.nro');
        // Empty name falls back to the game id.
        assert.equal(fwd.forwarderPathFor('', 'g3ghi78'), 'sdmc:/switch/g3ghi78/g3ghi78.nro');
});

test('patchGameIdInRomfs replaces the 64-zero placeholder with the game id', async () => {
        const fwd = await loadForwarderModule();
        // Build a romfs that contains the exact placeholder the forwarder
        // template's main.js uses: 64 '0' characters.
        const placeholder = new TextEncoder().encode('0'.repeat(64));
        const prefix = new TextEncoder().encode('const GAME_ID = "');
        const suffix = new TextEncoder().encode('";\n');
        const romfs = new Uint8Array(prefix.length + placeholder.length + suffix.length);
        romfs.set(prefix, 0);
        romfs.set(placeholder, prefix.length);
        romfs.set(suffix, prefix.length + placeholder.length);
        // Patch the game id.
        const patched = fwd.patchGameIdInRomfs(romfs, 'g1abc23');
        // The original romfs is not modified.
        assert.deepEqual(Array.from(romfs.subarray(prefix.length, prefix.length + 64)), Array.from(placeholder), 'original unchanged');
        // The patched romfs has the game id at the placeholder offset.
        const id = new TextDecoder().decode(patched.subarray(prefix.length, prefix.length + 64));
        assert.equal(id, 'g1abc23' + ' '.repeat(64 - 7), 'game id is space-padded to 64');
        // The full patched content is what we expect.
        const full = new TextDecoder().decode(patched);
        assert.equal(full, 'const GAME_ID = "' + 'g1abc23' + ' '.repeat(64 - 7) + '";\n');
});

test('patchGameIdInRomfs throws if the placeholder is missing or ambiguous', async () => {
        const fwd = await loadForwarderModule();
        // No placeholder -> throws.
        const empty = new Uint8Array(64);
        assert.throws(() => fwd.patchGameIdInRomfs(empty, 'g1'), /placeholder not found/);
        // Two placeholders (separated by a non-zero byte so they don't
        // overlap) -> throws (ambiguous).
        const placeholder = new TextEncoder().encode('0'.repeat(64));
        const two = new Uint8Array(placeholder.length * 2 + 1);
        two.set(placeholder, 0);
        two[placeholder.length] = 0xff; // separator
        two.set(placeholder, placeholder.length + 1);
        assert.throws(() => fwd.patchGameIdInRomfs(two, 'g1'), /found 2 times/);
        // Empty game id -> throws.
        assert.throws(() => fwd.patchGameIdInRomfs(placeholder, ''), /game id is empty/);
        // Game id longer than 64 chars -> throws.
        const longId = 'g'.repeat(65);
        assert.throws(() => fwd.patchGameIdInRomfs(placeholder, longId), /too long/);
});

test('patchGameIdInRomfs handles a 64-char game id (no padding)', async () => {
        const fwd = await loadForwarderModule();
        const placeholder = new TextEncoder().encode('0'.repeat(64));
        const maxId = 'g'.repeat(64);
        const patched = fwd.patchGameIdInRomfs(placeholder, maxId);
        const id = new TextDecoder().decode(patched.subarray(0, 64));
        assert.equal(id, maxId, '64-char id fills the placeholder exactly');
});

// === patchGameIdInString (string-level patch for the self-extraction approach) ===

test('patchGameIdInString replaces the 64-zero placeholder with the game id', async () => {
        const fwd = await loadForwarderModule();
        const source = 'const GAME_ID = "' + '0'.repeat(64) + '";\nconsole.log(GAME_ID);\n';
        const patched = fwd.patchGameIdInString(source, 'g1abc23', false);
        // The placeholder is replaced; the rest is unchanged.
        assert.ok(!patched.includes('0'.repeat(64)), 'placeholder gone');
        assert.ok(patched.includes('g1abc23'), 'game id present');
        assert.ok(patched.includes('console.log(GAME_ID)'), 'rest of source preserved');
        // The game id is space-padded to 64 chars.
        const match = patched.match(/GAME_ID = "([^"]*)"/);
        assert.ok(match, 'GAME_ID assignment found');
        assert.equal(match![1].length, 64, 'replacement is 64 chars');
        assert.equal(match![1].trim(), 'g1abc23', 'trimmed value is the game id');
});

test('patchGameIdInString throws on missing or duplicate placeholder', async () => {
        const fwd = await loadForwarderModule();
        // No placeholder.
        assert.throws(() => fwd.patchGameIdInString('console.log("hello");', 'g1', false), /placeholder not found/);
        // Two placeholders.
        const two = '"' + '0'.repeat(64) + '" + "' + '0'.repeat(64) + '"';
        assert.throws(() => fwd.patchGameIdInString(two, 'g1', false), /found more than once/);
        // Empty game id.
        assert.throws(() => fwd.patchGameIdInString(TEST_FORWARDER_MAIN_JS, '', false), /game id is empty/);
        // Oversized game id.
        assert.throws(() => fwd.patchGameIdInString(TEST_FORWARDER_MAIN_JS, 'g'.repeat(65), false), /too long/);
});

// === findRomfsFile (minimal romfs file-table parser) ===
// Build a synthetic romfs with one file named "main.js" and verify
// findRomfsFile locates it. The romfs format is documented at
// https://switchbrew.org/wiki/RomFS.

function buildSyntheticRomfs(files: { name: string; data: Uint8Array }[]): Uint8Array {
        const FILE_ENTRY_SIZE = 0x20; // base, plus name (aligned to 4)
        const DATA_SECTION_OFFSET = 0x200;
        // Build file entries.
        const nameBytes = files.map(f => new TextEncoder().encode(f.name));
        const entrySizes = nameBytes.map(nb => FILE_ENTRY_SIZE + ((nb.length + 3) & ~3));
        const fileEntryTableLength = entrySizes.reduce((a, b) => a + b, 0);
        // Data section: each file's data padded to 0x10 alignment.
        const dataPadded = files.map(f => {
                const pad = (0x10 - (f.data.length % 0x10)) % 0x10;
                return { data: f.data, padded: f.data.length + pad, pad };
        });
        const dataSectionLength = dataPadded.reduce((a, b) => a + b.padded, 0);
        // Layout: header (0x50) + padding to 0x200 + data section + file entry table.
        const total = DATA_SECTION_OFFSET + dataSectionLength + fileEntryTableLength;
        const out = new Uint8Array(total);
        const view = new DataView(out.buffer);
        // Header.
        view.setBigUint64(0x00, 0x50n, true); // headerSize
        view.setBigUint64(0x08, 0n, true); // dirHashBucketOffset
        view.setBigUint64(0x10, 0n, true); // dirHashBucketLength
        view.setBigUint64(0x18, 0n, true); // dirEntryOffset
        view.setBigUint64(0x20, 0n, true); // dirEntryLength
        view.setBigUint64(0x28, 0n, true); // fileHashBucketOffset
        view.setBigUint64(0x30, 0n, true); // fileHashBucketLength
        view.setBigUint64(0x38, BigInt(DATA_SECTION_OFFSET + dataSectionLength), true); // fileEntryOffset
        view.setBigUint64(0x40, BigInt(fileEntryTableLength), true); // fileEntryLength
        view.setBigUint64(0x48, BigInt(DATA_SECTION_OFFSET), true); // dataOffset
        // Data section: write each file's data.
        let dataOff = 0;
        const dataOffsets: number[] = [];
        for (const dp of dataPadded) {
                dataOffsets.push(dataOff);
                out.set(dp.data, DATA_SECTION_OFFSET + dataOff);
                dataOff += dp.padded;
        }
        // File entry table.
        let entryAddr = DATA_SECTION_OFFSET + dataSectionLength;
        for (let i = 0; i < files.length; i++) {
                view.setUint32(entryAddr + 0x00, 0, true); // parentDirOffset
                view.setUint32(entryAddr + 0x04, 0xffffffff, true); // siblingOffset (none)
                view.setBigUint64(entryAddr + 0x08, BigInt(dataOffsets[i]), true); // dataOffset
                view.setBigUint64(entryAddr + 0x10, BigInt(files[i].data.length), true); // dataSize
                view.setUint32(entryAddr + 0x18, 0xffffffff, true); // hashSiblingOffset
                view.setUint32(entryAddr + 0x1c, nameBytes[i].length, true); // nameSize
                out.set(nameBytes[i], entryAddr + 0x20);
                entryAddr += entrySizes[i];
        }
        return out;
}

test('findRomfsFile locates main.js in a synthetic romfs', async () => {
        const fwd = await loadForwarderModule();
        const mainJsContent = 'console.log("hello from main.js");\n';
        const romfs = buildSyntheticRomfs([
                { name: 'nxjs.ini', data: new TextEncoder().encode('[v8]\nheap_limit=64MiB\n') },
                { name: 'main.js', data: new TextEncoder().encode(mainJsContent) },
                { name: 'font.ttf', data: new Uint8Array([0x00, 0x01, 0x02, 0x03]) },
        ]);
        const result = fwd.findRomfsFile(romfs, 'main.js');
        assert.ok(result, 'main.js found');
        assert.equal(result!.size, mainJsContent.length, 'main.js size matches');
        // Read back the data at the found offset.
        const data = new TextDecoder().decode(romfs.subarray(result!.offset, result!.offset + result!.size));
        assert.equal(data, mainJsContent);
});

test('findRomfsFile returns null for a missing file', async () => {
        const fwd = await loadForwarderModule();
        const romfs = buildSyntheticRomfs([{ name: 'main.js', data: new Uint8Array([1, 2, 3]) }]);
        assert.equal(fwd.findRomfsFile(romfs, 'missing.txt'), null);
});

test('findRomfsFile handles empty romfs gracefully', async () => {
        const fwd = await loadForwarderModule();
        assert.equal(fwd.findRomfsFile(new Uint8Array(0), 'main.js'), null);
        assert.equal(fwd.findRomfsFile(new Uint8Array(0x10), 'main.js'), null);
});

test('forwarderExists reports presence via the LibraryAccess interface', async () => {
        const fwd = await loadForwarderModule();
        const files = new Map<string, { mode: number }>([
                ['sdmc:/switch/My Game/My Game.nro', { mode: 0o100000 }],
        ]);
        const fs = {
                statSync: (p: string) => files.has(p) ? files.get(p)! : null,
                readFileSync: () => null,
                writeFileSync: () => {},
                mkdirSync: () => {},
        };
        assert.equal(fwd.forwarderExists(fs as any, 'My Game', 'g1'), true);
        assert.equal(fwd.forwarderExists(fs as any, 'Other Game', 'g2'), false);
});
