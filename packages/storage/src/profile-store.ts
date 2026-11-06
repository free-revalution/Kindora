/**
 * Local-first persistence for the user's agent.
 *
 * Phase A / A1: the private key is **no longer** part of the record
 * that is written to localStorage. In the Tauri runtime it lives in the
 * OS keychain (`agent.identity.p256`); only a reference to it is
 * stored alongside the agent.
 *
 * See 开发手册.md § 13, § 39, § 40.
 */

import type { SocialAgent, SocialProfile } from '@kindora/protocol';

/**
 * Where the agent's private key is persisted.
 *
 * The type is deliberately closed: a stored agent must say where its
 * private key lives, so that "the key ended up in localStorage" can
 * never happen by accident.
 *
 *   - `keychain`          — the OS keychain (macOS Keychain / Windows
 *                           Credential Manager / Linux Secret Service).
 *                           `keyId` is `base64url(SHA-256(SPKI DER))`
 *                           and lets the app detect a mismatch between
 *                           the stored record and the stored key.
 *   - `dev-localstorage`  — the browser-dev fallback, where no OS
 *                           keychain exists. The key is kept in
 *                           localStorage in plain text and the UI says
 *                           so out loud. It is **not** a secure store
 *                           and must never be the state of a shipped
 *                           desktop build.
 */
export type PrivateKeyStorage =
  { readonly kind: 'keychain'; readonly keyId: string } | { readonly kind: 'dev-localstorage' };

/**
 * Locally-stored agent record.
 *
 * `privateKey` is optional and is only ever populated *in memory* (or
 * in the browser-dev fallback). It must never be transmitted to another
 * agent, and — in the Tauri runtime — it must never be written to
 * localStorage.
 */
export interface StoredAgent extends Omit<SocialAgent, 'capabilities' | 'profile'> {
  /**
   * The private key, base64 PKCS#8.
   *
   * Optional: in the Tauri runtime the persistent copy lives in the OS
   * keychain and this field is only filled in when the agent is loaded
   * into memory.
   */
  readonly privateKey?: string;

  /**
   * Where the private key is persisted. Required, so that every write
   * path has to make a deliberate choice.
   */
  readonly privateKeyStorage: PrivateKeyStorage;

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
