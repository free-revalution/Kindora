/**
 * Test setup — patches Node's empty `localStorage` global with an
 * in-memory implementation so the storage package tests can run.
 *
 * In production this file is not loaded; the real `localStorage` from
 * the browser / Tauri webview is used.
 */

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createMemoryStorage(),
    writable: true,
    configurable: true,
  });
} else {
  // Node 22+ exposes a non-functional `localStorage: {}` unless started
  // with --localstorage-file. Replace it with our in-memory impl so
  // tests behave the same as in a browser.
  const ls = globalThis.localStorage as unknown as Storage;
  if (typeof ls.clear !== 'function' || typeof ls.getItem !== 'function') {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      writable: true,
      configurable: true,
    });
  }
}
