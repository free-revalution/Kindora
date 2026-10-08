/**
 * In-memory SecretStore.
 *
 * Useful for tests and as a fallback when no persistent store is
 * available (e.g. first-run browser dev before Web Crypto finishes
 * initialising). Secrets are lost when the page is reloaded.
 */

import type { SecretStore } from './secret-store';

export class InMemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
