/**
 * Secure secret storage abstraction.
 *
 * 开发手册.md § 12 — the canonical interface.
 *
 * Production (Tauri runtime) uses the OS keychain via the Rust `keyring`
 * crate. Browser dev uses an in-memory or AES-GCM encrypted localStorage
 * implementation.
 */

export interface SecretStore {
  /** Persist a secret under `key`. Overwrites if it exists. */
  set(key: string, value: string): Promise<void>;
  /** Read a secret. Returns null if missing. */
  get(key: string): Promise<string | null>;
  /** Remove a secret. No-op if missing. */
  delete(key: string): Promise<void>;
}

export const SECRET_STORE_VERSION = '0.1.0';
