/**
 * Test setup — installs Node's WebCrypto implementation when the
 * jsdom environment does not provide one.
 *
 * jsdom implements `crypto.getRandomValues` and `crypto.randomUUID`
 * but **not** `crypto.subtle`. Phase A needs `crypto.subtle` for
 * everything that matters: ES256 signing, ECDH key agreement, HKDF
 * and AES-256-GCM. Node ships a spec-complete WebCrypto, so we
 * install it when — and only when — jsdom's stub is in the way.
 *
 * This is a **test-environment** polyfill. The shipped app runs in a
 * real browser / Tauri webview, where `crypto.subtle` is native.
 */
import { webcrypto } from 'node:crypto';

const g = globalThis as { crypto?: Crypto };
if (!g.crypto || !g.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto as unknown as Crypto,
    writable: true,
    configurable: true,
  });
}
