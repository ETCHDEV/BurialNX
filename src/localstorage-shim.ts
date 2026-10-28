// localStorage shim — replaces nx.js's account-save-data-backed
// localStorage with an SD-card-backed in-memory shim, so that NO access
// to `localStorage` ever launches the "select a user" profile picker.
//
// ============================================================================
// WHY THIS EXISTS
// ============================================================================
// nx.js implements `localStorage` on top of account save data. The VERY
// FIRST access to the native localStorage (a getter on globalThis) lazily
// calls libnx `accountGetPreselectedUser`. With `startupUserAccount = 0`
// in the NACP (no preselected user), that call falls back to LAUNCHING THE
// PROFILE-PICKER APPLETPLET — the "select a user" dialog.
//
// BurialNX's own code never touches localStorage (settings/library/game
// saves/autosave all go to the SD card via Switch.writeFileSync and
// installSdSaves). But RPG Maker MV games and their plugins routinely
// REFERENCE `localStorage` directly — e.g. a plugin that does
// `var cfg = JSON.parse(localStorage.getItem('pluginConfig') || '{}')` at
// script-eval time, BEFORE installSdSaves() has a chance to override the
// game's StorageManager. Such a reference re-triggers the profile picker
// mid-launch (the dialog the user sees when pressing A on a game tile).
//
// This shim replaces `globalThis.localStorage` with a plain object whose
// getItem/setItem/removeItem/clear/length/key are backed by an in-memory
// Map (one Map per shim instance), lazily hydrated from
// `sdmc:/switch/burialnx/localstorage.json` on first access and written
// back on every mutation. Accessing the shim never touches account save
// data, so the profile picker can never appear from a localStorage access
// — not at startup, not during game launch, not during gameplay.
//
// ============================================================================
// LIFETIME / SCOPE
// ============================================================================
// Installed ONCE at app startup (src/main.ts) and stays for the whole app
// lifetime. The installed shim is a single object with a single Map, so
// all callers (app, game scripts, plugins) share one view — matching the
// original nx.js behavior (localStorage was the app's single user-account
// save data, shared across all games). Game saves themselves are NOT
// affected — they go through StorageManager, which installSdSaves()
// overrides to write `.rpgsave` files in the per-game SD-card folder. This
// shim only catches DIRECT `localStorage.X` access from game/plugin
// scripts.
//
// ============================================================================
// PERSISTENCE
// ============================================================================
// On the very first access (getItem/setItem/length/key), the installed
// shim lazily reads `sdmc:/switch/burialnx/localstorage.json` into its
// Map. Every mutation (setItem/removeItem/clear) writes the whole file.
// RPG Maker MV games almost never write localStorage directly (saves go
// through StorageManager → installSdSaves → SD), so the write frequency
// is low and the synchronous full-file write is not a perf concern.

const STORAGE_PATH = 'sdmc:/switch/burialnx/localstorage.json';
const STORAGE_DIR = 'sdmc:/switch/burialnx';

interface StorageShim {
  __bnxShim: true;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * Build a fresh shim object with its OWN in-memory Map. Each instance is
 * isolated (no shared module-level state), so tests can create shims
 * without interfering with each other or with the installed global shim.
 * The installed global shim (from installLocalStorageShim) is the only
 * one that ever loads/persists to the SD card; standalone instances
 * created here persist too (best-effort) since they share the same
 * STORAGE_PATH — but tests use them in isolation by clearing first.
 */
export function createStorageShim(): StorageShim {
  // Per-instance state (NOT module-level) so instances don't interfere.
  const map = new Map<string, string>();
  let loaded = false;

  const ensureLoaded = (): Map<string, string> => {
    if (loaded) return map;
    loaded = true;
    try {
      const SwitchAny = (globalThis as any).Switch;
      const bytes = SwitchAny?.readFileSync?.(STORAGE_PATH) as ArrayBuffer | null | undefined;
      if (bytes && bytes.byteLength > 0) {
        const text = new TextDecoder().decode(bytes);
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            if (typeof v === 'string') map.set(k, v);
          }
        }
      }
    } catch { /* no persisted state — start empty */ }
    return map;
  };

  const persist = (): void => {
    try {
      const SwitchAny = (globalThis as any).Switch;
      SwitchAny?.mkdirSync?.(STORAGE_DIR);
      const obj: Record<string, string> = {};
      for (const [k, v] of map) obj[k] = v;
      SwitchAny?.writeFileSync?.(STORAGE_PATH, JSON.stringify(obj));
    } catch { /* persistence is best-effort; never throw from the shim */ }
  };

  return {
    __bnxShim: true,
    getItem(key: string): string | null {
      ensureLoaded();
      const k = String(key);
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem(key: string, value: string): void {
      ensureLoaded();
      map.set(String(key), String(value));
      persist();
    },
    removeItem(key: string): void {
      ensureLoaded();
      map.delete(String(key));
      persist();
    },
    clear(): void {
      ensureLoaded();
      map.clear();
      persist();
    },
    get length(): number {
      ensureLoaded();
      return map.size;
    },
    key(index: number): string | null {
      ensureLoaded();
      const i = Math.trunc(index);
      if (i < 0 || i >= map.size) return null;
      return [...map.keys()][i] ?? null;
    },
  };
}

/**
 * Replace `globalThis.localStorage` with the shim. Idempotent — safe to
 * call multiple times. Uses `Object.defineProperty` so it also replaces
 * nx.js's native getter (which is a read-only accessor; defineProperty
 * with configurable: true replaces it cleanly). If defineProperty throws
 * (non-configurable getter on some runtimes), falls back to direct
 * assignment, which still works for subsequent reads.
 *
 * Returns true on success (shim installed or already installed), false
 * if neither defineProperty nor assignment worked (the native getter
 * stays — no worse than not calling this at all).
 */
export function installLocalStorageShim(): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  // Already our shim — nothing to do.
  if (descriptor && 'value' in descriptor && (descriptor.value as any)?.__bnxShim) return true;
  const shim = createStorageShim();
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      value: shim,
      writable: true,
      configurable: true,
    });
    return true;
  } catch {
    // Some runtimes make the native localStorage getter non-configurable.
    // Direct assignment may or may not shadow it; if it does, subsequent
    // reads return the shim. If it doesn't, accesses still hit the native
    // getter — but that's no worse than not having the shim at all.
    try { (globalThis as any).localStorage = shim; return true; }
    catch { return false; }
  }
}
