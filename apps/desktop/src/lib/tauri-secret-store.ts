/**
 * TauriSecretStore — OS keychain-backed SecretStore via the Tauri
 * `secret_*` commands. Used in production (Tauri runtime) to keep
 * API keys out of browser localStorage.
 *
 * The keyspace is the same as `BrowserLocalStorageEncryptedSecretStore`
 * (`llm:<provider>:api-key`) so the desktop UI can swap the
 * implementation at startup without changing key names.
 *
 * P0-2A / MB-1: `secret_get` is not on the WebView command surface.
 * Use `exists` for presence checks; LLM calls read keys only in Rust.
 */

import type { SecretStore } from '@kindora/storage';
import { getTauriInvoke, type TauriInvoke } from './tauri-runtime';

export const TAURI_SECRET_STORE_VERSION = '0.1.0';

export class TauriSecretStore implements SecretStore {
  private readonly tauri: TauriInvoke;
  readonly version: string = TAURI_SECRET_STORE_VERSION;

  constructor(tauri?: TauriInvoke) {
    const t = tauri ?? getTauriInvoke();
    if (!t) {
      throw new Error('TauriSecretStore: Tauri runtime not available.');
    }
    this.tauri = t;
  }

  async get(_key: string): Promise<string | null> {
    throw new Error('secret_get removed; use secret_exists / llm_*');
  }

  async exists(key: string): Promise<boolean> {
    return this.tauri.invoke<boolean>('secret_exists', { key });
  }

  async set(key: string, value: string): Promise<void> {
    await this.tauri.invoke('secret_set', { key, value });
  }

  async delete(key: string): Promise<void> {
    await this.tauri.invoke('secret_delete', { key });
  }
}

/** True when the Tauri runtime exposes the secret commands. */
export function isTauriSecretStoreAvailable(): boolean {
  return getTauriInvoke() !== null;
}