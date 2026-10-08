/**
 * Local-first persistence for the user's agent.
 *
 * The store keeps the full `StoredAgent` (which includes the private
 * key) on-device. Only the public view is ever shared with peers.
 *
 * See 开发手册.md § 13, § 39, § 40.
 */

import type { SocialAgent, SocialProfile } from '@kindora/protocol';

/**
 * Locally-stored agent record.
 *
 * `privateKey` is included so that the same device can sign messages
 * across restarts. It must never be transmitted to another agent.
 */
export interface StoredAgent extends Omit<SocialAgent, 'capabilities' | 'profile'> {
  /** Stored locally only; never serialized into wire messages. */
  readonly privateKey: string;

  /** Local-only timestamps. */
  readonly createdAt: string;
  readonly updatedAt: string;

  /** Same shape as SocialAgent but locally mutable. */
  readonly profile: SocialProfile;
  readonly capabilities: SocialAgent['capabilities'];
}

/**
 * Abstract profile store. Implementations include
 *   - BrowserLocalStorageProfileStore (browser / Tauri webview dev)
 *   - SqliteProfileStore (Phase 2+)
 */
export interface ProfileStore {
  /** Returns null if no agent exists yet on this device. */
  loadAgent(): Promise<StoredAgent | null>;

  /** Insert or replace. */
  saveAgent(agent: StoredAgent): Promise<void>;

  /** Wipe local data. */
  deleteAgent(): Promise<void>;

  loadProfile(): Promise<SocialProfile | null>;
  saveProfile(profile: SocialProfile): Promise<void>;
}

export const PROFILE_STORE_VERSION = '0.1.0';
