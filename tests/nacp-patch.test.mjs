import { test } from 'node:test';
import assert from 'node:assert/strict';

// Verifies the MAIN-app NACP patching done by tools/build.mjs via
// tools/nacp-patch.mjs. The crucial assertion is startupUserAccount=0
// (no "select a user" profile dialog at launch), which is the whole
// point of this change: every launch drops the user straight into the
// library grid with no OS profile picker, because saves live in per-game
// SD-card folders and the app never needs user-account save data.

import {
  patchNacpDefaults,
  nacpOffsetInNro,
  NACP_STARTUP_USER_ACCOUNT_OFFSET,
  NACP_USER_ACCOUNT_SAVE_DATA_SIZE_OFFSET,
  NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET,
  NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET,
  NACP_USER_ACCOUNT_SAVE_DATA_SIZE,
} from '../tools/nacp-patch.mjs';

/** Build a minimal fake NRO buffer with a valid NRO header, an ASET
 *  asset header, and a NACP section of exactly NACP_SIZE bytes (0x4000).
 *  The NACP starts pre-patched with "bad" values (journal mismatched to
 *  save-data, bcat non-zero, startupUserAccount=1) so the test can prove
 *  patchNacpDefaults corrects every field. */
function fakeNro({ nacpSize = 0x4000, nroSize = 0x1000, preNacp = {} } = {}) {
  // Layout: [nroSize bytes of NRO][ASET header 0x38][icon 0][nacp][romfs 0]
  const assetBase = nroSize;
  const nacpRel = 0x38; // NACP immediately follows the ASET header
  const total = assetBase + 0x38 + nacpSize;
  const buf = Buffer.alloc(total, 0);
  // NRO header: magic "NRO0" at 0x10, size at 0x18.
  buf.write('NRO0', 0x10, 'ascii');
  buf.writeUInt32LE(nroSize, 0x18);
  // ASET header: magic at assetBase, nacpRel at assetBase+0x18, nacpSize at +0x20.
  buf.write('ASET', assetBase, 'ascii');
  buf.writeUInt32LE(0, assetBase + 0x4); // version
  buf.writeUInt32LE(0, assetBase + 0x8); // icon rel (0 = none)
  buf.writeUInt32LE(0, assetBase + 0x10); // icon size
  buf.writeUInt32LE(nacpRel, assetBase + 0x18); // nacp rel
  buf.writeUInt32LE(nacpSize, assetBase + 0x20); // nacp size
  buf.writeUInt32LE(0, assetBase + 0x28); // romfs rel
  buf.writeUInt32LE(0, assetBase + 0x30); // romfs size
  const nacpAbs = assetBase + nacpRel;
  // Pre-patch the NACP with values the build step must correct.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (preNacp.startupUserAccount !== undefined) view.setUint8(nacpAbs + NACP_STARTUP_USER_ACCOUNT_OFFSET, preNacp.startupUserAccount);
  if (preNacp.saveDataSize !== undefined) view.setBigUint64(nacpAbs + NACP_USER_ACCOUNT_SAVE_DATA_SIZE_OFFSET, preNacp.saveDataSize, true);
  if (preNacp.journalSize !== undefined) view.setBigUint64(nacpAbs + NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET, preNacp.journalSize, true);
  if (preNacp.bcatSize !== undefined) view.setBigUint64(nacpAbs + NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET, preNacp.bcatSize, true);
  return buf;
}

test('nacpOffsetInNro resolves the absolute NACP byte offset from the NRO+ASET headers', () => {
  const buf = fakeNro({ nroSize: 0x1000, nacpSize: 0x4000 });
  const nacpAbs = nacpOffsetInNro(buf);
  // assetBase (0x1000) + nacpRel (0x38).
  assert.equal(nacpAbs, 0x1038);
});

test('nacpOffsetInNro rejects buffers that are too small', () => {
  assert.throws(() => nacpOffsetInNro(Buffer.alloc(8)), /too small/i);
});

test('nacpOffsetInNro rejects non-buffer inputs', () => {
  assert.throws(() => nacpOffsetInNro('not a buffer'), /expected Buffer or Uint8Array/i);
  assert.throws(() => nacpOffsetInNro(null), /expected Buffer or Uint8Array/i);
});

test('patchNacpDefaults sets startupUserAccount=0 (no profile dialog)', () => {
  // Start with the dialog-ON state (the @nx.js template default).
  const buf = fakeNro({ preNacp: { startupUserAccount: 1 } });
  patchNacpDefaults(buf);
  const nacpAbs = nacpOffsetInNro(buf);
  assert.equal(buf.readUint8(nacpAbs + NACP_STARTUP_USER_ACCOUNT_OFFSET), 0, 'startupUserAccount disabled — no OS profile dialog at launch');
});

test('patchNacpDefaults makes journalSize match saveDataSize to prevent 2016-0910', () => {
  // Start with the inconsistent state the @nx.js/patch-nacp step leaves
  // behind: saveDataSize=32768 (from package.json) but journalSize=1.5 MiB
  // (the NACP template default). That mismatch triggered Switch error
  // 2016-0910 before this patching existed.
  const buf = fakeNro({ preNacp: {
    saveDataSize: 32768n,
    journalSize: 0x180000n, // 1.5 MiB — the bad template default
  } });
  patchNacpDefaults(buf);
  const nacpAbs = nacpOffsetInNro(buf);
  // saveDataSize is left untouched (already correct from package.json).
  assert.equal(buf.readBigUInt64LE(nacpAbs + NACP_USER_ACCOUNT_SAVE_DATA_SIZE_OFFSET), NACP_USER_ACCOUNT_SAVE_DATA_SIZE, 'saveDataSize comes from package.json and is left intact');
  // journalSize is corrected to match saveDataSize.
  assert.equal(buf.readBigUInt64LE(nacpAbs + NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET), NACP_USER_ACCOUNT_SAVE_DATA_SIZE, 'journalSize matches saveDataSize (consistent — prevents 2016-0910)');
});

test('patchNacpDefaults zeroes bcatDeliveryCacheStorageSize (unused)', () => {
  const buf = fakeNro({ preNacp: { bcatSize: 0x1000n } });
  patchNacpDefaults(buf);
  const nacpAbs = nacpOffsetInNro(buf);
  assert.equal(buf.readBigUInt64LE(nacpAbs + NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET), 0n, 'bcat size zeroed');
});

test('patchNacpDefaults returns a descriptive log line by default and is silent when asked', () => {
  const buf = fakeNro();
  const line = patchNacpDefaults(buf);
  assert.equal(typeof line, 'string');
  assert.match(line, /startupUserAccount=0/);
  assert.match(line, /no profile dialog/);
  // Silent mode returns undefined and still patches in place.
  const buf2 = fakeNro({ preNacp: { startupUserAccount: 1 } });
  const ret = patchNacpDefaults(buf2, { silent: true });
  assert.equal(ret, undefined);
  const nacpAbs = nacpOffsetInNro(buf2);
  assert.equal(buf2.readUint8(nacpAbs + NACP_STARTUP_USER_ACCOUNT_OFFSET), 0, 'silent patch still writes startupUserAccount=0');
});

test('patchNacpDefaults is idempotent (applying it twice is a no-op after the first)', () => {
  const buf = fakeNro({ preNacp: { startupUserAccount: 1, journalSize: 0x180000n, bcatSize: 0x1000n } });
  patchNacpDefaults(buf);
  const snapshot = Buffer.from(buf); // copy
  patchNacpDefaults(buf);
  // The buffer should be byte-identical after the second pass.
  assert.deepEqual(buf, snapshot, 'second patch does not change anything');
});

test('patchNacpDefaults matches the same offsets the forwarder uses (writeNacpForwarderDefaults)', () => {
  // The forwarder (src/forwarder.ts writeNacpForwarderDefaults) and the
  // main app (this module) must agree on the NACP layout so a forwarder
  // built from a copy of burialnx.nro ends up with consistent fields.
  // The forwarder zeros startupUserAccount too; the main app does the same.
  assert.equal(NACP_STARTUP_USER_ACCOUNT_OFFSET, 0x3025);
  assert.equal(NACP_USER_ACCOUNT_SAVE_DATA_SIZE_OFFSET, 0x3080);
  assert.equal(NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET, 0x3088);
  assert.equal(NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET, 0x3090);
});
