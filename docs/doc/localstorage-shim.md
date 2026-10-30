# `localstorage-shim.ts`

`localstorage-shim.ts` replaces nx.js's account-save-data-backed `localStorage` with an SD-card-backed in-memory shim, so that no access to `localStorage` ever launches the "select a user" profile-picker applet. It exposes `createStorageShim()` (builds a fresh isolated shim with its own in-memory `Map`) and `installLocalStorageShim()` (idempotently installs a shim onto `globalThis.localStorage`).

## File-level header — WHY THIS EXISTS
> localStorage shim — replaces nx.js's account-save-data-backed
> localStorage with an SD-card-backed in-memory shim, so that NO access
> to `localStorage` ever launches the "select a user" profile picker.
>
> ============================================================================
> WHY THIS EXISTS
> ============================================================================
> nx.js implements `localStorage` on top of account save data. The VERY
> FIRST access to the native localStorage (a getter on globalThis) lazily
> calls libnx `accountGetPreselectedUser`. With `startupUserAccount = 0`
> in the NACP (no preselected user), that call falls back to LAUNCHING THE
> PROFILE-PICKER APPLETPLET — the "select a user" dialog.
>
> BurialNX's own code never touches localStorage (settings/library/game
> saves/autosave all go to the SD card via Switch.writeFileSync and
> installSdSaves). But RPG Maker MV games and their plugins routinely
> REFERENCE `localStorage` directly — e.g. a plugin that does
> `var cfg = JSON.parse(localStorage.getItem('pluginConfig') || '{}')` at
> script-eval time, BEFORE installSdSaves() has a chance to override the
> game's StorageManager. Such a reference re-triggers the profile picker
> mid-launch (the dialog the user sees when pressing A on a game tile).
>
> This shim replaces `globalThis.localStorage` with a plain object whose
> getItem/setItem/removeItem/clear/length/key are backed by an in-memory
> Map (one Map per shim instance), lazily hydrated from
> `sdmc:/switch/burialnx/localstorage.json` on first access and written
> back on every mutation. Accessing the shim never touches account save
> data, so the profile picker can never appear from a localStorage access
> — not at startup, not during game launch, not during gameplay.

## File-level header — LIFETIME / SCOPE
> ============================================================================
> LIFETIME / SCOPE
> ============================================================================
> Installed ONCE at app startup (src/main.ts) and stays for the whole app
> lifetime. The installed shim is a single object with a single Map, so
> all callers (app, game scripts, plugins) share one view — matching the
> original nx.js behavior (localStorage was the app's single user-account
> save data, shared across all games). Game saves themselves are NOT
> affected — they go through StorageManager, which installSdSaves()
> overrides to write `.rpgsave` files in the per-game SD-card folder. This
> shim only catches DIRECT `localStorage.X` access from game/plugin
> scripts.

## File-level header — PERSISTENCE
> ============================================================================
> PERSISTENCE
> ============================================================================
> On the very first access (getItem/setItem/length/key), the installed
> shim lazily reads `sdmc:/switch/burialnx/localstorage.json` into its
> Map. Every mutation (setItem/removeItem/clear) writes the whole file.
> RPG Maker MV games almost never write localStorage directly (saves go
> through StorageManager → installSdSaves → SD), so the write frequency
> is low and the synchronous full-file write is not a perf concern.

## `createStorageShim`
> Build a fresh shim object with its OWN in-memory Map. Each instance is
> isolated (no shared module-level state), so tests can create shims
> without interfering with each other or with the installed global shim.
> The installed global shim (from installLocalStorageShim) is the only
> one that ever loads/persists to the SD card; standalone instances
> created here persist too (best-effort) since they share the same
> STORAGE_PATH — but tests use them in isolation by clearing first.

### `createStorageShim` — per-instance state
> Per-instance state (NOT module-level) so instances don't interfere.

### `createStorageShim.ensureLoaded` — trailing catch
> no persisted state — start empty

### `createStorageShim.persist` — trailing catch
> persistence is best-effort; never throw from the shim

## `installLocalStorageShim`
> Replace `globalThis.localStorage` with the shim. Idempotent — safe to
> call multiple times. Uses `Object.defineProperty` so it also replaces
> nx.js's native getter (which is a read-only accessor; defineProperty
> with configurable: true replaces it cleanly). If defineProperty throws
> (non-configurable getter on some runtimes), falls back to direct
> assignment, which still works for subsequent reads.
>
> Returns true on success (shim installed or already installed), false
> if neither defineProperty nor assignment worked (the native getter
> stays — no worse than not calling this at all).

### `installLocalStorageShim` — defineProperty fallback rationale
> Some runtimes make the native localStorage getter non-configurable.
> Direct assignment may or may not shadow it; if it does, subsequent
> reads return the shim. If it doesn't, accesses still hit the native
> getter — but that's no worse than not having the shim at all.
