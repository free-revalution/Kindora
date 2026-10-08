import '@testing-library/jest-dom/vitest';

/**
 * Polyfill Node's empty `localStorage` global with an in-memory
 * implementation. Node 22+ exposes a non-functional `localStorage: {}`
 * unless started with --localstorage-file. jsdom 25 in vitest 2 has a
 * similar gap. In production this file is not loaded.
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

function needsPolyfill(ls: unknown): boolean {
  if (typeof ls === 'undefined') return true;
  const proto = ls as Storage;
  return typeof proto.clear !== 'function' || typeof proto.getItem !== 'function';
}

if (needsPolyfill(globalThis.localStorage)) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createMemoryStorage(),
    writable: true,
    configurable: true,
  });
}
