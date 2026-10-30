# `node-compat.ts`

`node-compat.ts` is the Node.js / NW.js compatibility layer for RPG Maker MV games running under nx.js on the Switch. It installs minimal, best-effort shims for the Node/NW.js globals (`require`, `process`, `Buffer`, `module`, `exports`, `global`, `__dirname`, `__filename`, `nw`) that modded or "DLC+Cheats" RPG Maker MV builds expect, plus a Switch-SD-backed `fs` with a per-game writable overlay. It is NOT a full Node runtime — only the surface RPG Maker MV plugins commonly touch is implemented.

## Module-level header
> Node.js / NW.js compatibility layer for RPG Maker MV games.
>
> Many RPG Maker MV games — especially modded or "DLC+Cheats" builds — are
> packaged as NW.js desktop apps and call Node/NW.js globals (`require`,
> `process`, `Buffer`, `module`, `exports`, `global`, `__dirname`,
> `__filename`, `nw`) that nx.js's browser-like realm does not provide.
> Without them the game throws `ReferenceError: require is not defined`
> (or `process is not defined`, …) the first time a plugin or a patched
> title window touches them, killing the launch:
>
>     FAILURE: ReferenceError: require is not defined
>         at Window_TitleCommand.checkAddCommandEnable
>         at Window_TitleCommand.makeCommandList
>
> nw.dll itself is an x86 Windows DLL and cannot run on the Switch's ARM64
> CPU, so the only viable fix is to polyfill the globals NW.js would have
> provided. This module installs minimal, best-effort shims so such games
> boot. It is NOT a full Node runtime: only the surface RPG Maker MV plugins
> commonly touch is implemented.
>
> `fs` is wired to nx.js's synchronous SD-card I/O through the `Switch`
> global, with a per-game writable overlay so game/mod scripts cannot modify
> the game's own files. This is a compatibility shim, not a security sandbox
> (game and mod scripts already run with native privileges — see
> SECURITY.md); the overlay exists to keep the game directory pristine and
> to make read-after-write of the same path behave like NW.js.

## `nextMicrotask` — scheduling fallback
> Schedule a callback on the next microtask, falling back to a 0ms timer if
> nx.js does not expose `queueMicrotask` (it is browser-standard, but the
> loader's own code consistently uses `setTimeout` for the same purpose, so
> the fallback keeps this layer robust without depending on it).

## `resolveFsPath`
> Resolve a (possibly relative, possibly URL-like) fs path against the NW.js
> app root and return an absolute `sdmc:/` path, or `null` if the path is
> unsafe (traversal, unsupported scheme, empty). Backslashes are accepted
> (NW.js games ported from Windows use them) and normalized.

### `resolveFsPath` — file:// / nwjs:// / nw:// URL handling
> file://, nwjs:// or nw:// URLs → the path part is absolute; map it to an
> absolute `sdmc:/` path (the Switch equivalent of a native filesystem URL).

### `resolveFsPath` — relative segment normalization
> Drop '.' segments (valid in relative paths like ./cheats.json); reject
> any '..' segment so a path cannot escape the app root.

## Section: Minimal Buffer
> === Minimal Buffer ====================================================
> RPG Maker MV's Decrypter uses Uint8Array directly, but cheat plugins and a
> few NW.js helpers use Node's `Buffer`. Implement the commonly used surface
> over a Uint8Array so `Buffer.from(str,'base64')`, `buf.toString('hex')`,
> `Buffer.concat`, and the little-endian read/write helpers all work.

## Section: path (pure JS, POSIX semantics)
> === path (pure JS, POSIX semantics) ==================================

## Section: events (minimal EventEmitter)
> === events (minimal EventEmitter) ===================================

### `MiniEventEmitter.emit` — trailing catch
> one listener must not break others

## Section: fs (Switch-backed, with per-game writable overlay)
> === fs (Switch-backed, with per-game writable overlay) ===============
>
> Reads check the overlay first (files the game wrote), then the real SD
> path under the app root. Writes always go to the overlay, so the game's
> own files are never modified. Paths are validated and clamped to the app
> root + overlay subtrees: a crafted `..` path is rejected.

### `makeFs` — `mem` map trailing inline
> in-memory overlay when no switchFs (tests)

### `makeFs.resolve` — path validation rationale
> Resolve a raw user-supplied path to an absolute `sdmc:/` path under the
> app root. Returns null for unsafe/traversal paths. Every fs method runs
> its argument through this first — `Switch.readFileSync` etc. expect
> absolute sdmc paths, not the relative strings RPG Maker plugins pass.

### `makeFs.ensureOverlay` — trailing catch
> may already exist

### `makeFs.stat` — overlay trailing catch
> fall through

### `makeFs.stat` — real-path trailing catch
> missing

### `makeFs.writeFileSync` — mkdir trailing catch
> best-effort

### `makeFs.appendFileSync` — read-prev trailing catch
> new file

### `makeFs.unlinkSync` — remove trailing catch
> ignore

### `makeFs.mkdirSync` — trailing catch
> may exist

## Section: A safe no-op stub module for unknown require() calls
> === A safe no-op stub module for unknown require() calls =============
>
> Returns a callable proxy whose every property access yields itself, so
> `require('anything').foo.bar().baz` never throws — it just no-ops. This
> keeps unfamiliar Node modules from crashing the boot; features that need
> them simply won't do anything useful.

### `stubModule` — self-referential proxy target
> The target returns `proxy` (the Proxy itself) so that calling the stub
> yields the SAME proxy — keeping every chained access (`s().foo().bar`)
> on the proxy instead of falling off onto a raw function. `proxy` is
> assigned immediately after and closed over.

## Section: process / nw shims
> === process / nw shims ===============================================

### `makeProcess` — `mainModule.filename` rationale
> NW.js exposes `process.mainModule.filename` as the path to the app's main
> module (the HTML entry from package.json's `main`). RPG Maker MV's
> StorageManager.localFileDirectoryPath() and several patch plugins
> (Wataridori_AddFileSystem) call `path.dirname(process.mainModule.filename)`
> to find the game's base directory, then resolve sibling folders like
> `save/` or `patch/` relative to it. Point this at `<appRoot>/www/index.html`
> so `dirname()` = `<appRoot>/www` and `../patch/` = `<appRoot>/patch/`,
> matching the on-disk Windows/NW.js layout the game was built for.

### `makeProcess.exit` — trailing catch
> best-effort

### `makeNw` (App.quit) — trailing catch
> best-effort

## Section: require() resolver
> === require() resolver ==============================================

## `installNodeCompat`
> Install the Node/NW.js compatibility globals on `runtime` (globalThis).
> Globals already present (e.g. a native nx.js `require`) are left intact so
> this layer only fills gaps. Installed globals are picked up by the loader's
> session snapshot/restore because this runs after `beginGameSession()`.

### `requireRelative` — base directory probing
> `id` is normalized to a relative path (./ or ../) before reaching here.
> RPG Maker MV scripts live under `www/`, but NW.js sets the CWD to the
> app root (parent of www), so probe BOTH bases to maximize the chance
> of locating a local module regardless of which convention it uses.

### `installNodeCompat` — preserve existing globals
> Only install globals that are NOT already present, so a native nx.js
> `require`/`process` (if any) is preserved.

## Section: helpers
> === helpers ==========================================================

### `simpleHash` — FNV-1a rationale
> A non-cryptographic FNV-1a hash is plenty for a polyfill: RPG Maker
> plugins only use it for cache keys and equality checks, never for
> security. md5/sha* requests all map to this 32-byte hex string.
