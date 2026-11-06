/**
 * Browser-localStorage implementation of ProfileStore.
 *
 * Used for:
 *   - Vite dev (browser-only)
 *   - Tauri webview, for the *non-secret* part of the agent record
 *
 * The store key is namespaced under `kindora:` to avoid collisions.
 * All values are JSON-serialized.
 *
 * Phase A / A1: this store refuses to persist a private key when the
 * record says the key lives in the OS keychain. The browser-dev
 * fallback (`privateKeyStorage.kind === 'dev-localstorage'`) still
 * keeps it in localStorage — that is a deliberate, visible limitation
 * of the dev runtime, not a default.
 */

import type { ProfileStore, PrivateKeyStorage, StoredAgent } from './profile-store';
import { resolveBoundaries, type SocialProfile } from '@kindora/protocol';

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

/**
 * Normalise a record read back from disk.
 *
 * Records written before Phase A have no `privateKeyStorage` field and
 * carry a plaintext `privateKey`. Those are legacy browser-dev
 * records; they are tagged `dev-localstorage` so that the app can
 * migrate them (Tauri runtime) or warn about them (browser dev).
 */
export function normaliseStoredAgent(raw: unknown): StoredAgent | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<StoredAgent> & { privateKeyStorage?: unknown };

  const storage = normalisePrivateKeyStorage(record.privateKeyStorage, record.privateKey);
  if (!storage) return null;

  // A record whose profile is missing or malformed is **not** an agent
  // record. `StoredAgent.profile` is required, and a half-built profile
  // (no nickname, no bio) is not something this layer can invent — so
  // the honest answer is "there is no agent here", not a `StoredAgent`
  // whose `profile` is a lie.
  //
  // This matters because the value read back is **untrusted input**:
  // `localStorage` can be edited by hand, and a database row can be
  // corrupt. Before this check, `normaliseProfile(undefined)` would
  // have produced `{ boundaries: … }` — an object that satisfies the
  // `SocialProfile` type and is missing every field.
  if (!isProfileShape(record.profile)) return null;

  return {
    ...(record as StoredAgent),
    profile: normaliseProfile(record.profile),
    privateKeyStorage: storage,
  };
}

/**
 * The shape `SocialProfile` requires.
 *
 * `boundaries` is deliberately **not** checked here: a record written
 * before Phase B simply does not carry the field-level gates, and
 * `normaliseProfile` fills them in with the documented defaults.
 * Every other field has been required since KSA 0.1, so a record
 * missing one was never a valid record.
 */
function isProfileShape(value: unknown): value is SocialProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<SocialProfile>;
  return (
    typeof profile.nickname === 'string' &&
    typeof profile.bio === 'string' &&
    Array.isArray(profile.interests) &&
    Array.isArray(profile.currentActivities) &&
    Array.isArray(profile.socialIntent) &&
    Array.isArray(profile.conversationStyle)
  );
}

/**
 * Fill in the privacy-boundary flags a record written before Phase B
 * did not carry.
 *
 * The field-level disclosure gates (`allowBio`, `allowInterests`, …)
 * were added to `SocialBoundaries` after the first release, so an
 * older stored record simply does not have them. Normalising them here
 * — at the storage boundary — means every consumer downstream sees a
 * complete set of flags, and a user who has never opened the privacy
 * screen gets the documented defaults rather than `undefined`.
 */
function normaliseProfile(profile: SocialProfile): SocialProfile {
  return { ...profile, boundaries: resolveBoundaries(profile.boundaries) };
}

function normalisePrivateKeyStorage(
  value: unknown,
  legacyPrivateKey: string | undefined,
): PrivateKeyStorage | null {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<PrivateKeyStorage> & { kind?: unknown };
    if (candidate.kind === 'keychain' && typeof candidate.keyId === 'string') {
      return { kind: 'keychain', keyId: candidate.keyId };
    }
    if (candidate.kind === 'dev-localstorage') {
      return { kind: 'dev-localstorage' };
    }
    return null;
  }
  // Pre-Phase-A record: plaintext private key in localStorage.
  if (typeof legacyPrivateKey === 'string' && legacyPrivateKey.length > 0) {
    return { kind: 'dev-localstorage' };
  }
  return null;
}

export class BrowserLocalStorageProfileStore implements ProfileStore {
  async loadAgent(): Promise<StoredAgent | null> {
    const raw = getStorage().getItem(AGENT_KEY);
    if (!raw) return null;
    try {
      return normaliseStoredAgent(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async saveAgent(agent: StoredAgent): Promise<void> {
    getStorage().setItem(AGENT_KEY, JSON.stringify(toPersistedAgent(agent)));
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

/**
 * Strip the private key before writing, when the record says the key
 * lives in the OS keychain.
 *
 * This is the single choke point that keeps the private key out of
 * localStorage, no matter which call site performs the write.
 */
export function toPersistedAgent(agent: StoredAgent): Omit<StoredAgent, 'privateKey'> & {
  privateKey?: string;
} {
  if (agent.privateKeyStorage.kind === 'keychain') {
    const { privateKey: _privateKey, ...rest } = agent;
    return rest;
  }
  return agent;
}
