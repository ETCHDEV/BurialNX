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

/** Build a fresh isolated localStorage shim with its own in-memory Map. */
export function createStorageShim(): StorageShim {
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
    } catch {}
    return map;
  };

  const persist = (): void => {
    try {
      const SwitchAny = (globalThis as any).Switch;
      SwitchAny?.mkdirSync?.(STORAGE_DIR);
      const obj: Record<string, string> = {};
      for (const [k, v] of map) obj[k] = v;
      SwitchAny?.writeFileSync?.(STORAGE_PATH, JSON.stringify(obj));
    } catch {}
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

/** Idempotently replace globalThis.localStorage with the SD-backed shim. */
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
    try { (globalThis as any).localStorage = shim; return true; }
    catch { return false; }
  }
}
