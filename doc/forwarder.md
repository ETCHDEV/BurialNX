# `forwarder.ts`

Per-game forwarder NRO generation for the BurialNX Switch homebrew loader. A forwarder is a self-contained nx.js NRO that, when launched from the Switch homebrew menu (hbmenu), runs the game directly — skipping the library grid. The current "baked-in" approach patches two placeholders (`__FORWARDER_GAME_ID__`, `__FORWARDER_MOD_FORCED__`) in a copy of `burialnx.nro` itself, so no chain-loading or `envSetNextLoad` is involved; the forwarder exits cleanly to hbmenu.

## File header / module overview

> ```
> Per-game forwarder NRO generation. A forwarder is a self-contained nx.js
> NRO that, when launched from the Switch homebrew menu (hbmenu), chain-
> loads the main burialnx.nro with `--game <id>` on its argv so the user
> lands directly in that game — skipping the library grid. This mirrors
> the forwarder pattern used by sphaira (which calls libnx
> `envSetNextLoad`); the nx.js equivalent is
> `new Switch.Application(nroPath).launch('--game', id)`, which nx.js's
> source/ns.cc implements as a call to `envSetNextLoad` followed by an
> exit of the current process.
>
> BUILD FLOW:
>   - At build time, `tools/build.mjs` packages a `forwarder-template.nro`
>     (a FAT self-contained nx.js NRO whose `romfs:/main.js` contains a
>     64-byte GAME_ID placeholder — see forwarder-template/romfs/main.ts)
>     and embeds it into burialnx.nro's own romfs at
>     `romfs:/forwarder-template.nro`.
>   - At runtime, `buildForwarder()` reads that template, patches the
>     GAME_ID placeholder in the romfs (byte-level search + replace so
>     the forwarder is fully self-contained — no sidecar JSON), patches
>     the NACP (title = game name, author = "BurialNX", id = a stable
>     hash of the game id), optionally patches the icon (the game's cover
>     re-encoded to a 256×256 JPEG), re-encodes the NRO, and writes it
>     to `sdmc:/switch/burialnx/<game-id>.nro` — the SAME folder as
>     burialnx.nro itself, so hbmenu finds it in its "burialnx" folder.
>
> This module is pure (no top-level Switch access) so it can be unit-
> tested with a mock filesystem; only `buildForwarder` and
> `encodeCoverToIconJpeg` touch the Switch runtime, through globals.
> ```

## NRO format constants

Section divider (original): `// === NRO format constants (https://switchbrew.org/wiki/NRO) ============`

## NACP field layout

Section divider (original): `// === NACP field layout (https://switchbrew.org/wiki/NACP) ==============``

(Original inline trailing on the language-entry size constant: `const NACP_LANGUAGE_ENTRY_SIZE = 0x300; // name[0x200] + author[0x100]`)

> ```
> Save-data fields (s64 each). Zeroing these prevents the Switch from
> creating save data for the forwarder title, which in turn prevents the
> "cannot delete: save data exists" error when the user removes the
> forwarder from the HOME menu.
> ```

(Original inline trailing on each save-data offset constant:)
- `NACP_STARTUP_USER_ACCOUNT_OFFSET` — `// u8: 0=no profile dialog`
- `NACP_USER_ACCOUNT_SAVE_DATA_SIZE_OFFSET` — `// s64`
- `NACP_USER_ACCOUNT_SAVE_DATA_JOURNAL_SIZE_OFFSET` — `// s64`
- `NACP_BCAT_DELIVERY_CACHE_STORAGE_SIZE_OFFSET` — `// s64`

## Forwarder paths

Section divider (original): `// === Forwarder paths ===================================================`

> ```
> Each forwarder lives in its OWN subfolder under sdmc:/switch/, named
> after the sanitized game name. This matches the hbmenu convention
> (sdmc:/switch/<app-name>/<app-name>.nro) and makes the forwarder
> appear as a top-level entry in hbmenu with the game name as the folder
> name. The forwarder's NACP title is also the game name.
> ```

## `FORWARDER_TEMPLATE_ROMFS_PATH`

> The embedded template NRO path inside burialnx.nro's own romfs.

## `BURIALNX_NRO_PATH`

> ```
> Where the main burialnx.nro is expected to live on the SD card. The
> forwarder's main.js chain-loads this path.
> ```

## `sanitizeGameName`

> ```
> Sanitize a game name for use as a folder/filename. Keeps only
> alphanumeric, dash, and underscore characters — SPACES ARE REPLACED
> WITH UNDERSCORES because the Switch homebrew menu (hbmenu) and the
> NRO launching mechanism can fail to handle paths containing spaces.
> Truncates to 40 chars. If the result is empty, falls back to the game id.
> ```

## `forwarderDirFor`

> ```
> Compute the forwarder .nro directory for a given game. Each game
> gets its own subfolder: sdmc:/switch/<sanitized-name>/
> ```

## `forwarderPathFor`

> Compute the forwarder .nro path on the SD card for a given game.

## Game-id placeholder (module constants `GAME_ID_PLACEHOLDER`, `GAME_ID_PLACEHOLDER_BYTES`)

Section divider (original): `// === Game-id placeholder (patched at runtime into the romfs) ==========`

> ```
> The forwarder template's main.js contains the line:
>   const GAME_ID = "0000000000000000000000000000000000000000000000000000000000000000";
> (exactly 64 '0' characters). At build time, buildForwarder() searches
> the romfs bytes for this 64-byte sequence and overwrites it with the
> game's id (UTF-8, right-padded with spaces to 64 bytes). The main.js
> then does `GAME_ID.trim()` to get the clean id.
>
> 64 zeros is distinctive enough within the romfs data section (which
> contains the ~3 KiB bundled main.js, the ~240 byte nxjs.ini, and the
> ~100 KiB runtime font + source map). We search ONLY within the romfs
> bytes, never the code segment, so the 54 MiB compiled runtime can't
> produce a false match.
> ```

## `patchGameIdInRomfs`

> ```
> Patch the game-id placeholder in a copy of the template's romfs bytes.
> Searches for the 64-'0' placeholder and overwrites it with the game
> id (UTF-8, space-padded to 64 bytes). Returns a new Uint8Array — the
> input is not modified. Throws if the placeholder is not found or
> found more than once (ambiguous).
> ```

(Original single-line step labels inside the function:)
- `// Build the replacement: game id + space padding to 64 bytes.`
- `// The rest is already 0 from Uint8Array initialization; but we need SPACES (0x20), not zeros (0x00), because the JS string literal must remain valid: "g1abc23                " (id + spaces).`
- `// Search for the placeholder in the romfs.`
- `// Copy the romfs and overwrite the placeholder.` (with inline trailing `// creates a copy` on the `new Uint8Array(romfs)` call)

## `patchStringInRomfs`

> ```
> Patch a string placeholder in a romfs blob. Searches for the
> placeholder (as UTF-8 bytes) and overwrites it with the replacement
> (which must be the same byte length). Returns a new Uint8Array — the
> input is not modified. Throws if the placeholder is not found or
> found more than once (ambiguous).
>
> This is the generic version of patchGameIdInRomfs — used for the
> MOD_FORCED placeholder ("MODFORCED_0" → "MODFORCED_1").
> ```

## `findAll`

> ```
> Find all occurrences of `needle` in `haystack`. Returns the byte
> offsets where the needle starts.
> ```

## `forwarderIdFor`

> ```
> A stable, per-game unique application ID for the forwarder NRO. nx.js
> NROs use the application ID for save-data separation and hbmenu dedup.
> We hash the game id into the homebrew title-ID range
> (0x0100000000010000 | hash16) so the same game always gets the same
> forwarder ID, different games get different IDs, and the ID stays in
> the homebrew range. FNV-1a (32-bit, folded to 16).
> ```

## Pure NRO / NACP manipulation

Section divider (original): `// === Pure NRO / NACP manipulation (no Switch access) ==================`

## `decodeNroStructure`

> ```
> Decode an NRO's structure: locate the asset section and the icon,
> nacp and romfs segments within it. Throws on bad magic or sizes.
> ```

## `encodeNro`

> ```
> Build a fresh NRO from a code segment, an icon, a NACP and a romfs.
> The asset header is rebuilt so the icon, NACP and romfs sizes can
> change (which they do: the per-game cover JPEG is variable-length,
> and the romfs grows when we patch the placeholder).
> ```

## `writeNacpTitle`

> ```
> Write the application title into a NACP buffer (all 12 language
> entries, UTF-8, truncated to 0x1ff bytes, null-padded).
> ```

## `writeNacpAuthor`

> Write the author field into a NACP buffer (all 12 entries).

## `writeNacpId`

> ```
> Write the application ID into all the NACP fields that hold one
> (PresenceGroupId, SaveDataOwnerId, AddOnContentBaseId, and the 8
> LocalCommunicationId slots).
> ```

## `writeNacpForwarderDefaults`

> ```
> Zero out the save-data fields in a forwarder NACP. The forwarder is
> just a chain-loader — it doesn't need save data of its own. Setting
> these to 0 prevents the Switch from creating save data for the
> forwarder title, which in turn prevents the "cannot delete: save data
> exists" error when the user removes the forwarder. Also disables the
> profile-selection dialog (startupUserAccount=0) since the forwarder
> doesn't touch user data.
> ```

(Original single-line step labels inside the function:)
- `// Don't show the "select a user" dialog for the forwarder.`
- `// Zero out all save-data sizes (s64 each).`

## Icon re-encoding

Section divider (original): `// === Icon re-encoding ==================================================`

> ```
> The forwarder icon must be a 256×256 JPEG (hbmenu convention). The game
> cover is a PNG on the SD card. nx.js's Image + OffscreenCanvas +
> canvas.convertToBlob() does the decode/resize/encode natively. If any
> step fails, the caller falls back to the template's existing icon.
>
> DEBUGGING: every step is logged with the `icon:` prefix so the debug
> build's log file (sdmc:/switch/burialnx/LOGS/native-host_N.log) shows
> exactly where the icon pipeline failed. The log lines include:
>   - the cover path and byte size
>   - the first 8 bytes of the cover (magic number: PNG = 89 50 4E 47,
>     JPEG = FF D8 FF E0)
>   - whether OffscreenCanvas, URL.createObjectURL, Image are available
>   - the Image load attempt (sdmc path first, blob URL fallback)
>   - the decoded image dimensions
>   - the drawImage call and its parameters
>   - the convertToBlob call and the resulting JPEG size
>   - the full error (with name + message + stack) on any exception
> ```

## `detectImageFormat`

> Detect the image format from the first few bytes of the cover.

## `hexPrefix`

> Format the first N bytes as a hex string for logging.

## `encodeCoverToIconJpeg`

> ```
> Re-encode an arbitrary cover image as a 256×256 JPEG. The cover can
> be specified either as an SD path (preferred — nx.js's Image fetches
> sdmc: paths natively, no blob URL needed) or as raw bytes (a blob URL
> is created as a fallback).
>
> The image is fit (aspect-preserving) onto a black 256×256 canvas,
> matching `tools/icon.mjs`. Returns the JPEG bytes or null.
> ```

### Step labels inside `encodeCoverToIconJpeg`

(Original single-line `//` step labels and inline trailing comments inside the function, preserved verbatim:)

- `// --- Step 1: resolve the cover to a loadable source. ---`
- `// If we have a path, try reading the first bytes to detect the format and log the magic number.`
- `// --- Step 2: check that OffscreenCanvas is available. ---`
- `// --- Step 3: load the Image. Try the SD path first (most reliable — nx.js's Image.src fetches sdmc: natively). Fall back to a blob URL if the path approach fails. ---`
- `try { URL.revokeObjectURL(url); } catch { /* best-effort */ }` (inline trailing)
- `// --- Step 4: draw the image onto the 256×256 canvas (aspect-fit, centered, black background). ---`
- `// --- Step 5: encode the canvas to JPEG via convertToBlob. ---`
- `// Verify the JPEG magic (FF D8 FF).` (with inline trailing `// JPEG magic mismatch! ...` on a log line)

## `loadImageFromUrl`

> ```
> Load an Image from a URL. Logs every state transition. Resolves with
> the loaded Image or null on failure.
> ```

(Original multi-line `//` chain about the safety timeout:)
- `// Safety timeout: 8s (cover decode can be slow for large PNGs on SD).`

## High-level builder / lister / deleter

Section divider (original): `// === High-level builder / lister / deleter ============================`

> ```
> SELF-EXTRACTION APPROACH: burialnx.nro does NOT embed a separate
> forwarder-template.nro (that would double its size to ~108 MiB).
> Instead, when the user builds a forwarder, burialnx.nro reads its OWN
> .nro file from the SD card (via Switch.argv[0]), makes a copy, and
> patches three things in the copy:
>   1. The romfs `main.js` file data is overwritten with the forwarder's
>      chain-load script (which has the game-id placeholder baked in at
>      build time via __FORWARDER_MAIN_JS__).
>   2. The NACP title/author/id fields are patched (title = game name).
>   3. The icon is optionally replaced with the game's cover JPEG.
> The result is a self-contained FAT NRO that, when launched from hbmenu,
> runs the forwarder's main.js (NOT burialnx's main.js) and chain-loads
> burialnx.nro with --game <id>.
>
> This keeps burialnx.nro at ~54 MiB (no embedded template) while each
> forwarder is a self-contained ~54 MiB NRO at
> sdmc:/switch/burialnx/<game-id>.nro — exactly where the user wants it,
> no shared-runtime installation needed, no sdmc:/nx.js/ directory.
> ```

## `__FORWARDER_MAIN_JS__` (build-time injected constant)

> ```
> The forwarder's main.js source, injected at build time by
> tools/build.mjs via esbuild's `define` option. Contains a 64-'0'
> placeholder for the game id that patchGameIdInString() replaces.
> ```

## `findRomfsFile`

> ```
> Find a file by name in a romfs blob. Returns the absolute offset and
> size of the file's DATA within the NRO buffer (i.e. romfsStart +
> 0x200 + fileDataOffset), or null if not found. This is a minimal
> romfs file-table parser — it only scans the file entry table for
> the matching name, without decoding the full romfs tree.
> ```

### RomFS header / file-entry-table layout notes

(Original single-line `//` step labels and multi-line `//` chain inside `findRomfsFile`, preserved verbatim:)

- `// RomFS header (0x50 bytes).`
- `// Scan the file entry table. Each entry:` followed by the multi-line layout spec:
  > ```
  > 0x00: parentDirOffset (u32)
  > 0x04: siblingOffset (u32)
  > 0x08: dataOffset (u64) — relative to dataSectionOffset
  > 0x10: dataSize (u64)
  > 0x18: hashSiblingOffset (u32)
  > 0x1c: nameSize (u32)
  > 0x20: name (nameSize bytes, padded to 4-byte alignment)
  > entry size: 0x20 + align4(nameSize)
  > ```
- `// Advance to the next entry: 0x20 + align4(nameSize).`

## `patchGameIdInString`

> ```
> Patch the game-id placeholder in the forwarder main.js STRING (not
> the romfs bytes). Returns a new string with the 64-'0' placeholder
> replaced by the game id (space-padded to 64 chars). Throws if the
> placeholder is not found or is ambiguous.
> Also patches the MOD_ENABLED placeholder: '0' → '1' if modEnabled.
> ```

(Original single-line step labels inside the function:)
- `// Patch the GAME_ID placeholder (64 zeros).`
- `// Patch the MOD_ENABLED placeholder (const MOD_ENABLED = "0" → "1").`

## `ForwarderBuildOptions.cover` (interface field)

> ```
> Cover image source. Pass `{ path }` to load from an SD path
> (preferred — nx.js's Image fetches sdmc: natively), or
> `{ bytes }` to create a blob URL fallback. Pass null to keep
> the template's existing icon.
> ```

## `ForwarderBuildOptions.baseNro` (interface field)

> ```
> The base NRO bytes (read from burialnx.nro's own file via
> Switch.argv[0]). The forwarder is built by patching a copy
> of this NRO — no separate template is embedded.
> ```

## `ForwarderBuildResult.bytes` (interface field)

> The final byte length of the written NRO.

## `buildForwarder`

> ```
> Build a per-game forwarder NRO from burialnx.nro's own file and write
> it to the SD card.
>
> BAKED-IN APPROACH (no chain-loading):
> The forwarder IS a copy of burialnx.nro with TWO placeholders patched
> in the romfs's main.js:
>   1. __FORWARDER_GAME_ID__ (64 '0' chars) → the game id (padded to 64)
>   2. __FORWARDER_MOD_FORCED__ ("MODFORCED_0") → "MODFORCED_1" if mod is on
> At runtime, burialnx's main.ts checks these constants. If the game id
> is NOT all zeros, this IS a forwarder → set forwarderTargetId and
> auto-launch the game. NO chain-loading, NO envSetNextLoad → clean
> Switch.exit() → hbmenu.
>
> This replaces the old chain-load approach (forwarder-template's
> main.js called app.launch(burialnx.nro, '--game', id) which set
> envSetNextLoad — persistent on some hbloaders, causing re-chain
> loops).
> ```

### Step labels inside `buildForwarder`

(Original single-line `//` step labels and multi-line `//` chains inside the function, preserved verbatim:)

- `// 1. Decode the base NRO's structure (the code segment IS the nx.js runtime — we reuse it unchanged).`
- `// 2. Get the romfs bytes (we'll patch placeholders IN PLACE — no main.js overwrite, no padding, no romfs rebuild).`
- `// 3. Patch the GAME_ID placeholder (64 '0' chars → game id, space-padded to 64). patchGameIdInRomfs searches the entire romfs for the 64-'0' byte sequence and overwrites it. The sequence appears exactly once (in burialnx's main.js, baked by the build-time define).`
- `// 4. Patch the MOD_FORCED placeholder ("MODFORCED_0" → "MODFORCED_1" if the mod is enabled at build time). This forces the mod on at auto-launch, even if the user later disables it in the library.` — followed by the CRITICAL note:
  > ```
  > CRITICAL: the placeholder strings are constructed via
  > String.fromCharCode (NOT as literals) so esbuild does
  > NOT inline them into main.js. If they were literals,
  > there would be TWO matches in the romfs (one from
  > main.ts's __FORWARDER_MOD_FORCED__ define, one from
  > this call) and patchStringInRomfs would throw
  > "ambiguous".
  > ```
  (Original inline trailing on the String.fromCharCode calls: `// "MODFORCED_0"` and `// "MODFORCED_1"`.)
- `// 5. Copy the entire base NRO and apply the patched romfs. This is the 54 MiB that makes each forwarder self-contained.` — followed by `// Overwrite the romfs section with the patched romfs. The romfs size doesn't change (patch-in-place, same byte lengths), so the NRO layout stays valid.`
- `// 6. Patch the NACP: title = game name, author = "BurialNX", application id = stable hash.` — followed by `// Zero out save-data fields so the Switch doesn't create save data for the forwarder title.`
- `// 7. Optionally patch the icon. If the cover can't be encoded, keep the base NRO's existing icon.` — followed by `// The icon is variable-length (JPEG). We need to rebuild the asset section with the new icon size. The NACP and romfs sizes don't change.`
- `// 8. No icon change (or icon encoding failed) — write the patched copy directly. The asset section is unchanged (same icon, same NACP size, same romfs size).`

(Original inline trailing `/* may already exist */` on `try { SwitchAny.mkdirSync?.(dir); } catch { ... }` blocks — appears twice in the function.)

## `forwarderExists`

> ```
> Check whether a forwarder .nro exists on the SD card for the given
> game.
> ```

## `renameForwarder`

> ```
> Rename a forwarder's folder and .nro file when the game is renamed.
> The forwarder path is derived from the sanitized game name, so renaming
> the game changes the path. This function:
> 1. Checks if a forwarder exists at the OLD name's path.
> 2. Creates the NEW name's directory.
> 3. Copies the .nro file from old path to new path.
> 4. Deletes the old .nro, old folder, and any leftover files.
> Returns true if the forwarder was renamed, false if no forwarder existed.
> ```

(Original single-line `//` step labels and inline trailing `/* may already exist */`, `/* best-effort */`, `/* try next */`, `/* not supported */`, `/* unreadable */` comments inside the function, preserved verbatim:)

- `// Check if the old forwarder exists.`
- `// Read the old .nro bytes.`
- `// Create the new directory.` (with inline trailing `/* may already exist */`)
- `// Write the .nro to the new path.`
- `// Delete the old forwarder (file + folder).` (with multiple `/* best-effort */`, `/* try next */`, `/* not supported */`, `/* unreadable */` inline trailing comments on the cleanup calls)

## `deleteForwarder`

> ```
> Delete a forwarder .nro AND its containing folder. Best-effort: a missing
> file/folder is not an error. Returns true if the .nro file was deleted.
> The folder (sdmc:/switch/<sanitized-name>/) is also removed so it doesn't
> leave behind empty dirs or log files after the forwarder is gone.
> Tries rmdirSync, removeSync, and unlinkSync for the directory (nx.js may
> support any of these for directory removal).
> ```

(Original single-line `//` step labels and inline trailing comments inside the function, preserved verbatim:)

- `// Also delete the containing folder (and any leftover files like logs). First remove all files in the folder, then remove the folder itself.`
- `// Try to remove the directory itself. nx.js may expose rmdirSync, removeSync (for dirs), or neither — try all available options.` (with multiple `/* try next */`, `/* may not be supported */`, `/* best-effort */`, `/* not present */`, `/* unreadable */` inline trailing comments on the cleanup calls)
