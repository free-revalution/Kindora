/**
 * Browser-localStorage implementation of ProfileStore.
 *
 * Used for:
 *   - Vite dev (browser-only)
 *   - Tauri webview (acceptable for V0.1; SQLite arrives in Phase 2+)
 *
 * The store key is namespaced under `kindora:` to avoid collisions.
 * All values are JSON-serialized.
 */

import type { ProfileStore, StoredAgent } from './profile-store';
import type { SocialProfile } from '@kindora/protocol';

const AGENT_KEY = 'kindora:agent';
const STORE_VERSION_KEY = 'kindora:store-version';

function getStorage(): Storage {
  // Both `window.localStorage` and Tauri webview expose `localStorage`.
  // jsdom (vitest) provides it as well.
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error('localStorage is not available in this runtime.');
  }
  return globalThis.localStorage;
}

export class BrowserLocalStorageProfileStore implements ProfileStore {
  async loadAgent(): Promise<StoredAgent | null> {
    const raw = getStorage().getItem(AGENT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredAgent;
    } catch {
      return null;
    }
  }

  async saveAgent(agent: StoredAgent): Promise<void> {
    getStorage().setItem(AGENT_KEY, JSON.stringify(agent));
    getStorage().setItem(STORE_VERSION_KEY, '1');
  }

  async deleteAgent(): Promise<void> {
    getStorage().removeItem(AGENT_KEY);
    getStorage().removeItem(STORE_VERSION_KEY);
  }

  async loadProfile(): Promise<SocialProfile | null> {
    const agent = await this.loadAgent();
    return agent?.profile ?? null;
  }

  async saveProfile(profile: SocialProfile): Promise<void> {
    const existing = await this.loadAgent();
    if (!existing) {
      throw new Error('Cannot save profile: no agent exists yet. Call saveAgent first.');
    }
    const next: StoredAgent = {
      ...existing,
      profile,
      updatedAt: new Date().toISOString(),
    };
    await this.saveAgent(next);
  }
}
