/**
 * Encrypted localStorage SecretStore.
 *
 * AES-GCM with a key derived from a fixed app secret via SHA-256.
 * Each value is stored as `base64(iv):base64(ciphertext)` under
 * `kindora:secret:<key>`.
 *
 * This is the browser-dev fallback for Phase 2. In Tauri runtime the
 * production app MUST use the OS keychain via the Rust `keyring` crate
 * — see `tauri-secret-store.ts`.
 *
 * NOT for production: a fixed app secret protects against casual disk
 * inspection, not against an attacker who controls the device.
 */

import type { SecretStore } from './secret-store';

const STORAGE_PREFIX = 'kindora:secret:';
const APP_SECRET = 'kindora:v0.1.0:dev-only:encrypted-local-storage';
const APP_SECRET_SALT = 'kindora:v0.1.0:salt';

function getCrypto(): Crypto {
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    throw new Error('Web Crypto API unavailable; cannot encrypt secrets.');
  }
  return globalThis.crypto;
}

function getStorage(): Storage {
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error('localStorage is not available in this runtime.');
  }
  return globalThis.localStorage;
}

let _keyPromise: Promise<CryptoKey> | null = null;

function getKey(): Promise<CryptoKey> {
  if (_keyPromise) return _keyPromise;
  _keyPromise = (async () => {
    const crypto = getCrypto();
    const enc = new TextEncoder();
    const raw = await crypto.subtle.digest('SHA-256', enc.encode(APP_SECRET_SALT + APP_SECRET));
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  })();
  return _keyPromise;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa is available in browsers, jsdom, Node 16+, and Tauri webview.
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class BrowserLocalStorageEncryptedSecretStore implements SecretStore {
  async set(key: string, value: string): Promise<void> {
    const crypto = getCrypto();
    const aesKey = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      aesKey,
      new TextEncoder().encode(value),
    );
    const encoded = `${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
    getStorage().setItem(STORAGE_PREFIX + key, encoded);
  }

  async get(key: string): Promise<string | null> {
    const encoded = getStorage().getItem(STORAGE_PREFIX + key);
    if (!encoded) return null;
    const [ivB64, ctB64] = encoded.split(':');
    if (!ivB64 || !ctB64) return null;
    try {
      const aesKey = await getKey();
      const plaintext = await getCrypto().subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(ivB64) as BufferSource },
        aesKey,
        fromBase64(ctB64) as BufferSource,
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      // Corrupt or tampered — return null rather than throw.
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    getStorage().removeItem(STORAGE_PREFIX + key);
  }
}
