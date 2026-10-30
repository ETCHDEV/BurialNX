// Pure NACP patching for the MAIN burialnx.nro (not the forwarder).
//
// The forwarder uses writeNacpForwarderDefaults() from src/forwarder.ts
// (zero save data + startupUserAccount=0). The MAIN app used to keep
// startupUserAccount=1 so the OS profile picker mounted user save data
// and nx.js localStorage worked. That forced a "select a user" dialog
// on EVERY launch of burialnx.nro from hbmenu.
//
// Saves now live in per-game SD-card folders (installSdSaves overrides
// RPG Maker MV's StorageManager), so the main app no longer needs user-
// account save data either. patchNacpDefaults() applies the same
// startupUserAccount=0 the forwarder uses, plus keeps the saveDataSize
// / journalSize / bcatSize fields consistent (the @nx.js/patch-nacp
// package leaves the journal at its 1.5 MiB template default, which
// caused Switch error 2016-0910 when it mismatched the 32 KiB save
// data size — see the long comment in tools/build.mjs).
//
// This module is pure (no fs, no esbuild) so it can be unit-tested in
// isolation. build.mjs imports it and applies it to the freshly-built
// NRO buffer in place.

// NACP field offsets (see https://switchbrew.org/wiki/NACP).
export const NACP_STARTUP_USER_ACCOUNT_OFFSET = 0x3025; // u8: 0=no profile dialog
export const NACP_USER_ACCOUNT_SAVE_DATA_SIZE_OFFSET = 0x3080; // s64
export const NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET = 0x3088; // s64
export const NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET = 0x3090; // s64

// The save-data size the app declares in package.json (nacp.userAccountSaveDataSize).
// Kept at 32 KiB for backward compatibility with any existing user-account
// save data created by older builds; with startupUserAccount=0 the OS never
// mounts it, so this value is effectively metadata only.
export const NACP_USER_ACCOUNT_SAVE_DATA_SIZE = 32768n;

/**
 * Locate the absolute byte offset of the NACP section inside an NRO buffer.
 *
 * The NRO header stores the total NRO size at 0x18 (u32 LE). The asset
 * section (ASET) begins immediately after the NRO at `nroSize`. The ASET
 * header stores the NACP section's offset relative to the asset base at
 * 0x18 (u32 LE). The absolute NACP offset is therefore
 * `nroSize + nacpRel`.
 *
 * Mirrors the inline computation previously in tools/build.mjs so the
 * same logic is testable.
 *
 * @param {Buffer|Uint8Array} nroBuf - the full NRO file bytes.
 * @returns {number} the absolute byte offset of the NACP section.
 * @throws if the buffer is too small to contain an NRO + ASET header.
 */
export function nacpOffsetInNro(nroBuf) {
  if (!(nroBuf instanceof Buffer) && !(nroBuf instanceof Uint8Array)) {
    throw new TypeError('nacpOffsetInNro: expected Buffer or Uint8Array');
  }
  if (nroBuf.length < 0x20 + 0x38) throw new Error('NRO buffer too small for NRO + ASET headers');
  const nroSize = nroBuf.readUInt32LE(0x18);
  if (nroSize === 0 || nroSize > nroBuf.length) throw new Error(`Bad NRO size: ${nroSize}`);
  const assetBase = nroSize;
  const nacpRel = nroBuf.readUInt32LE(assetBase + 0x18);
  return assetBase + nacpRel;
}

/**
 * Patch the MAIN burialnx.nro's NACP in place:
 *   - startupUserAccount (0x3025) = 0  → no "select a user" dialog
 *   - userAccountSaveDataJournalSize (0x3088) = saveDataSize (consistent)
 *   - bcatDeliveryCacheStorageSize (0x3090) = 0 (unused)
 *
 * The saveDataSize at 0x3080 is left untouched (it comes from
 * package.json via @nx.js/patch-nacp and is already 32768).
 *
 * @param {Buffer} nroBuf - the full NRO file bytes (mutated in place).
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false] - when true, do not return the
 *   human-readable log line (callers that print their own message can
 *   silence this).
 * @returns {string|undefined} a log line describing the patch, unless
 *   `opts.silent` is true.
 */
export function patchNacpDefaults(nroBuf, opts = {}) {
  if (!(nroBuf instanceof Buffer) && !(nroBuf instanceof Uint8Array)) {
    throw new TypeError('patchNacpDefaults: expected Buffer or Uint8Array');
  }
  const nacpAbs = nacpOffsetInNro(nroBuf);
  // startupUserAccount = 0 → skip the OS profile-selection dialog.
  nroBuf.writeUint8(0, nacpAbs + NACP_STARTUP_USER_ACCOUNT_OFFSET);
  // Match the save-data size declared in package.json (32768). The
  // @nx.js/patch-nacp step leaves the journal at 1.5 MiB which mismatches
  // and triggers Switch error 2016-0910; set them equal here.
  nroBuf.writeBigUInt64LE(NACP_USER_ACCOUNT_SAVE_DATA_SIZE, nacpAbs + NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET);
  // bcat delivery cache is unused; zero it.
  nroBuf.writeBigUInt64LE(0n, nacpAbs + NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET);
  if (opts.silent) return undefined;
  return `Patched NACP: startupUserAccount=0 (no profile dialog), saveDataSize=${NACP_USER_ACCOUNT_SAVE_DATA_SIZE}, journalSize=${NACP_USER_ACCOUNT_SAVE_DATA_SIZE}, bcatSize=0 (saves live in per-game SD-card folders, no user-account save data needed)`;
}
