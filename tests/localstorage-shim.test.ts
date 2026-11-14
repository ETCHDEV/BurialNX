import test from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorageShim, createStorageShim } from '../src/localstorage-shim';

// Verifies the localStorage shim that replaces nx.js's account-save-data-
// backed localStorage. The shim is the third (and decisive) layer of the
// "no profile dialog" fix: even after startupUserAccount=0 and removing the
// startup `void storage.length`, RPG Maker MV games/plugins can STILL
// reference `localStorage` directly during script eval (before
// installSdSaves overrides StorageManager). Such a reference would re-
// trigger nx.js's lazy profile-picker applet. The shim ensures no
// `localStorage.X` access ever reaches account save data.

/** Snapshot and (later) restore globalThis.localStorage so tests don't
 *  leak the shim into other test files. */
let previousDescriptor: PropertyDescriptor | undefined;
function snapshot() {
  previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  // Make the property configurable so the shim's defineProperty can replace
  // it (Node's Web Storage, when present, may be non-configurable).
  try {
    Object.defineProperty(globalThis, 'localStorage', { ...(previousDescriptor || { value: undefined, writable: true }), configurable: true });
  } catch { /* some runtimes lock it; tests below still exercise createStorageShim */ }
}
function restore() {
  try {
    if (previousDescriptor && ('get' in previousDescriptor || 'set' in previousDescriptor)) {
      Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
    } else if (previousDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', { value: previousDescriptor.value, writable: true, configurable: true });
    } else {
      // No original descriptor — delete the property the shim created.
      delete (globalThis as any).localStorage;
    }
  } catch { /* best-effort cleanup */ }
}

test('createStorageShim: getItem returns null for missing keys, setItem stores and getItem returns the value', () => {
  const shim = createStorageShim();
  assert.equal(shim.getItem('missing'), null);
  shim.setItem('a', '1');
  assert.equal(shim.getItem('a'), '1');
  assert.equal(shim.length, 1);
});

test('createStorageShim: setItem coerces key and value to strings (matches Web Storage spec)', () => {
  const shim = createStorageShim();
  shim.setItem(123 as any, 456 as any);
  assert.equal(shim.getItem('123'), '456');
});

test('createStorageShim: removeItem deletes, clear empties, length tracks size', () => {
  const shim = createStorageShim();
  shim.setItem('a', '1');
  shim.setItem('b', '2');
  assert.equal(shim.length, 2);
  shim.removeItem('a');
  assert.equal(shim.getItem('a'), null);
  assert.equal(shim.length, 1);
  shim.clear();
  assert.equal(shim.length, 0);
  assert.equal(shim.getItem('b'), null);
});

test('createStorageShim: key(i) returns the i-th key or null out of range', () => {
  const shim = createStorageShim();
  shim.setItem('first', 'x');
  shim.setItem('second', 'y');
  const keys = [shim.key(0), shim.key(1)];
  assert.deepEqual(keys.sort(), ['first', 'second']);
  assert.equal(shim.key(2), null);
  assert.equal(shim.key(-1), null);
});

test('createStorageShim: setItem/removeItem/clear/getItem never throw, even without a Switch fs', () => {
  // In the Node test environment there is no Switch fs, so persistence is
  // skipped (best-effort). The in-memory Map must still work and never throw.
  const shim = createStorageShim();
  assert.doesNotThrow(() => { shim.setItem('safe', 'value'); });
  assert.doesNotThrow(() => { shim.getItem('safe'); });
  assert.doesNotThrow(() => { shim.removeItem('safe'); });
  assert.doesNotThrow(() => { shim.clear(); });
});

test('createStorageShim: has the __bnxShim marker so install can detect an existing install', () => {
  const shim = createStorageShim() as any;
  assert.equal(shim.__bnxShim, true);
});

test('installLocalStorageShim: replaces globalThis.localStorage with the shim (no native account-getter)', () => {
  snapshot();
  try {
    // Install a fake "native" localStorage getter that, if accessed, would
    // set a flag — simulating nx.js's lazy profile-picker launch. The shim
    // must prevent any access from reaching that getter.
    let nativeAccessed = false;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { nativeAccessed = true; return null; },
    });
    const ok = installLocalStorageShim();
    assert.equal(ok, true, 'install reports success');
    // Accessing localStorage must return our shim, NOT trigger the native getter.
    const ls = (globalThis as any).localStorage;
    assert.equal(nativeAccessed, false, 'the native account-getter was NOT touched (no profile picker)');
    assert.equal(ls?.__bnxShim, true, 'globalThis.localStorage is our shim');
    ls.setItem('k', 'v');
    assert.equal(ls.getItem('k'), 'v');
    assert.equal(nativeAccessed, false, 'native getter still untouched after setItem/getItem');
  } finally {
    restore();
  }
});

test('installLocalStorageShim: is idempotent — installing twice does not re-run defineProperty', () => {
  snapshot();
  try {
    assert.equal(installLocalStorageShim(), true);
    const first = (globalThis as any).localStorage;
    assert.equal(first?.__bnxShim, true);
    // Second install should be a no-op (early return).
    assert.equal(installLocalStorageShim(), true);
    const second = (globalThis as any).localStorage;
    assert.equal(second, first, 'the exact same shim instance is kept on re-install');
  } finally {
    restore();
  }
});

test('installLocalStorageShim: data persists across re-install in the same process (in-memory cache survives)', () => {
  snapshot();
  try {
    installLocalStorageShim();
    const ls = (globalThis as any).localStorage;
    ls.setItem('persistent-key', 'persistent-value');
    // Re-install (no-op) and confirm the value is still there.
    installLocalStorageShim();
    assert.equal((globalThis as any).localStorage.getItem('persistent-key'), 'persistent-value');
  } finally {
    restore();
  }
});
