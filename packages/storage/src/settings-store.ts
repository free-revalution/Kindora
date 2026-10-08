/**
 * Settings store for non-secret preferences (model name, baseUrl, etc.).
 *
 * Stored in plain localStorage — no PII, no API keys.
 */

const STORAGE_PREFIX = 'kindora:settings:';

function getStorage(): Storage {
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error('localStorage is not available in this runtime.');
  }
  return globalThis.localStorage;
}

export interface SettingsStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export class BrowserLocalStorageSettingsStore implements SettingsStore {
  async get<T>(key: string): Promise<T | null> {
    const raw = getStorage().getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    getStorage().setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    getStorage().removeItem(STORAGE_PREFIX + key);
  }
}
