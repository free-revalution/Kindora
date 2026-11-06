import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';

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

/**
 * Phase A — jsdom does not implement `crypto.subtle`.
 *
 * The whole Phase A surface (ES256 signing, ECDH key agreement, HKDF,
 * AES-256-GCM) needs it, and the desktop tests create a real agent
 * identity. Node ships a spec-complete WebCrypto implementation, so we
 * install it when — and only when — jsdom's stub is in the way.
 *
 * This is a **test-environment** polyfill: the shipped app runs in a
 * real browser / Tauri webview, where `crypto.subtle` is native.
 */
const g = globalThis as { crypto?: Crypto };
if (!g.crypto || !g.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto as unknown as Crypto,
    writable: true,
    configurable: true,
  });
}
