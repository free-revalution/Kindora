/**
 * TauriSecretStore — OS keychain-backed SecretStore via the Tauri
 * `secret_*` commands. Used in production (Tauri runtime) to keep
 * API keys out of browser localStorage.
 *
 * The keyspace is the same as `BrowserLocalStorageEncryptedSecretStore`
 * (`llm:<provider>:api-key`) so the desktop UI can swap the
 * implementation at startup without changing key names.
 *
 * V0.1 limitation: the `keyring` crate does not expose a portable
 * list API. The store is forward-only via known keys.
 */

import type { SecretStore } from '@kindora/storage';

interface TauriInvoke {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

function getTauri(): TauriInvoke | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
  const inv = w.__TAURI_INTERNALS__?.invoke;
  if (typeof inv !== 'function') return null;
  return { invoke: <T>(cmd: string, args?: Record<string, unknown>) => inv.call(w.__TAURI_INTERNALS__, cmd, args) as Promise<T> };
}

export const TAURI_SECRET_STORE_VERSION = '0.1.0';

export class TauriSecretStore implements SecretStore {
  private readonly tauri: TauriInvoke;
  readonly version: string = TAURI_SECRET_STORE_VERSION;

  constructor(tauri?: TauriInvoke) {
    const t = tauri ?? getTauri();
    if (!t) {
      throw new Error('TauriSecretStore: Tauri runtime not available.');
    }
    this.tauri = t;
  }

  async get(key: string): Promise<string | null> {
    return this.tauri.invoke<string | null>('secret_get', { key });
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
  return getTauri() !== null;
}
