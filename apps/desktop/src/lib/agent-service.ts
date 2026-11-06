/**
 * Profile creation / editing service.
 *
 * Bridges the protocol types, agent identity generation, and storage.
 *
 * ## Phase A / A1 — where the private key lives
 *
 * The private key no longer sits in localStorage:
 *
 *   - **Tauri runtime** — the key is stored in the OS keychain
 *     (`agent.identity.p256`, via the Rust `agent_key_*` commands).
 *     localStorage keeps only a reference: `{ kind: 'keychain', keyId }`.
 *   - **Browser dev** — there is no OS keychain, so the key stays in
 *     localStorage. This is a *visible* downgrade, never a silent one:
 *     the record says `privateKeyStorage.kind === 'dev-localstorage'` and
 *     the Home screen shows a warning banner.
 *
 * The migration from the old layout (private key inside the agent
 * record) is deliberately paranoid. The plaintext copy is removed only
 * after the keychain copy has been written **and** read back and
 * confirmed identical. If any step fails, the plaintext is left exactly
 * where it was and the error is surfaced — the app never deletes the
 * only copy of the private key, and it never regenerates an identity to
 * paper over a failure.
 *
 * ## Phase D / D1 — where the record lives
 *
 * The agent record itself lives in the local business database in the
 * desktop app, and in localStorage in the browser dev server. See
 * `runtime-stores.ts`. When the app starts, whatever an older version
 * left in localStorage is moved into the database first.
 */

import {
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_SOCIAL_BOUNDARIES,
  PROTOCOL_VERSION,
  base64ToBytes,
  deriveKeyId,
  isCryptoAvailable,
  type AgentCapabilities,
  type SocialProfile,
} from '@kindora/protocol';
import {
  buildRuntimeCapabilities,
  createAgentIdentity,
  type RuntimeCapabilities,
} from '@kindora/agent';
import { type ProfileStore, type StoredAgent } from '@kindora/storage';
import {
  AgentKeyError,
  TauriAgentKeychain,
  isAgentKeychainAvailable,
} from './tauri-agent-keychain';
import { assertKeyMatchesPublicKey, movePlaintextKeyToKeychain } from './agent-keychain-migration';
import { ensureLegacyMigration } from './database';
import { runtimeProfileStore } from './runtime-stores';

/**
 * Phase D / D1 — the profile lives in the local business database when
 * the app runs in Tauri, and in localStorage in the browser dev server.
 * See `runtime-stores.ts`.
 */
const _store: ProfileStore = runtimeProfileStore();

export function getProfileStore(): ProfileStore {
  return _store;
}

/**
 * Which runtime the app is running in.
 *
 * `tauri` — the shipped desktop app; an OS keychain is reachable.
 * `browser-dev` — `vite dev` in a plain browser; no OS keychain.
 */
export type AgentRuntimeMode = 'tauri' | 'browser-dev';

export function agentRuntimeMode(): AgentRuntimeMode {
  return isAgentKeychainAvailable() ? 'tauri' : 'browser-dev';
}

/**
 * The capabilities this runtime can honestly advertise (Phase A / A4).
 *
 * `transportEncryption` is `false`: the LAN transport is plaintext TCP
 * and there is no TLS anywhere in V0.1. `webRtc` is `false`: the WebRTC
 * transport is not implemented (Phase G).
 */
export function runtimeCapabilities(hasPrivateKey: boolean): RuntimeCapabilities {
  return {
    cryptoAvailable: isCryptoAvailable(),
    signingReady: hasPrivateKey,
    sessionEncryptionReady: isCryptoAvailable(),
    transportEncryption: false,
    webRtc: false,
  };
}

/**
 * Create a new agent from scratch: identity (UUID + key pair) + profile.
 *
 * In the Tauri runtime the private key goes straight to the OS
 * keychain and never touches localStorage.
 */
export async function createAgent(profile: SocialProfile): Promise<StoredAgent> {
  const identity = await createAgentIdentity();
  const now = new Date().toISOString();

  const base = {
    agentId: identity.agentId,
    protocolVersion: PROTOCOL_VERSION,
    displayName: profile.nickname,
    publicKey: identity.publicKey,
    profile,
    createdAt: now,
    updatedAt: now,
  };

  if (isAgentKeychainAvailable()) {
    const keychain = new TauriAgentKeychain();
    await keychain.store(identity.privateKey);

    // Read the key back before we let go of it: a keychain that silently
    // discards the write would leave the user with no identity at all.
    const readBack = await keychain.load();
    if (readBack !== identity.privateKey) {
      throw new AgentKeyError(
        'corrupt',
        'the OS keychain did not return the key that was just stored',
      );
    }

    const keyId = await deriveKeyId(base64ToBytes(identity.publicKey));
    const capabilities: AgentCapabilities = buildRuntimeCapabilities(runtimeCapabilities(true));
    const agent: StoredAgent = {
      ...base,
      capabilities,
      privateKeyStorage: { kind: 'keychain', keyId },
    };

    await _store.saveAgent(agent);
    // The in-memory copy carries the key so the signer can use it; the
    // persisted copy does not.
    return { ...agent, privateKey: identity.privateKey };
  }

  // Browser-dev fallback. The record says out loud that the key is not
  // in a secure store.
  const capabilities: AgentCapabilities = buildRuntimeCapabilities(runtimeCapabilities(true));
  const agent: StoredAgent = {
    ...base,
    capabilities,
    privateKey: identity.privateKey,
    privateKeyStorage: { kind: 'dev-localstorage' },
  };
  await _store.saveAgent(agent);
  return agent;
}

/**
 * Update only the profile portion of an existing agent.
 */
export async function updateProfile(
  agent: StoredAgent,
  profile: SocialProfile,
): Promise<StoredAgent> {
  const updated: StoredAgent = {
    ...agent,
    displayName: profile.nickname,
    profile,
    updatedAt: new Date().toISOString(),
  };
  await _store.saveAgent(updated);
  return updated;
}

/**
 * Load the local agent, with its private key attached in memory.
 *
 * Throws an `AgentKeyError` when the key cannot be recovered — the app
 * must **not** fall back to a plaintext key or to a fresh identity.
 */
export async function loadAgent(): Promise<StoredAgent | null> {
  // Phase D / D1 — an older version of the app kept the agent record in
  // localStorage. Move it into the local database *before* reading, so
  // the record is found wherever it now lives. The migration is
  // idempotent and only removes the legacy copy once the database write
  // succeeded, so a failed run is retried on the next start.
  await migrateLegacyDataIfNeeded();

  const stored = await _store.loadAgent();
  if (!stored) return null;

  if (stored.privateKeyStorage.kind === 'dev-localstorage') {
    if (isAgentKeychainAvailable() && typeof stored.privateKey === 'string') {
      return migratePrivateKeyToKeychain(stored);
    }
    // Browser-dev: the key is already here.
    return stored;
  }

  const keychain = new TauriAgentKeychain();
  const privateKey = await keychain.load();
  if (!privateKey) {
    throw new AgentKeyError(
      'not_found',
      'this device has an agent record but the OS keychain holds no matching private key',
    );
  }
  await assertKeyMatchesPublicKey(privateKey, stored.publicKey);
  return { ...stored, privateKey };
}

/**
 * Delete the local agent **and** its private key.
 *
 * The keychain entry is removed first: if that fails we abort and keep
 * the record, so the user never ends up with a half-deleted agent.
 */
export async function deleteAgent(): Promise<void> {
  const existing = await _store.loadAgent();
  if (existing?.privateKeyStorage.kind === 'keychain' && isAgentKeychainAvailable()) {
    await new TauriAgentKeychain().delete();
  }
  await _store.deleteAgent();
}

/**
 * Move a legacy plaintext private key into the OS keychain.
 *
 * Order matters, and it is the whole point of this function:
 *
 *   1. write the key to the keychain
 *   2. read it back and compare — byte for byte
 *   3. only then rewrite the record without the plaintext
 *   4. read the record back and confirm it is intact
 *
 * If any step fails the plaintext stays in localStorage and the error is
 * reported. The identity is never regenerated.
 */
async function migratePrivateKeyToKeychain(stored: StoredAgent): Promise<StoredAgent> {
  // The four-step order (write → read back → rewrite → confirm) lives in
  // `agent-keychain-migration.ts`, so the Phase D legacy migration can
  // use the very same code path.
  return movePlaintextKeyToKeychain(stored, {
    persist: (next) => _store.saveAgent(next),
    load: () => _store.loadAgent(),
  });
}

/**
 * Move an older version's localStorage data into the local database.
 *
 * A no-op in the browser dev server, where there is no database and
 * localStorage *is* the store.
 *
 * A failed migration is **not** remembered as done: the next start tries
 * again, and the legacy copy is still there because it is only removed
 * after the database write succeeded.
 */
async function migrateLegacyDataIfNeeded(): Promise<void> {
  const report = await ensureLegacyMigration();
  if (report.failed) {
    console.warn('[kindora] the localStorage → database migration did not complete:', report.error);
  }
}

/**
 * A short, human-readable description of an agent-key failure, for the
 * UI. Never throws.
 */
export function describeAgentKeyError(err: unknown): string {
  if (err instanceof AgentKeyError) {
    switch (err.kind) {
      case 'keychain_locked':
        return 'Your system keychain is locked. Unlock it, then try again.';
      case 'keychain_denied':
        return 'Your system keychain denied access to Kindora’s key. Allow access and try again.';
      case 'keychain_unavailable':
        return 'No system keychain is available on this device, so the private key cannot be stored safely.';
      case 'not_found':
        return 'No private key was found for this agent.';
      case 'corrupt':
        return 'The stored private key could not be read.';
      case 'invalid_key':
        return 'The private key was rejected by the system keychain.';
      default:
        return `The system keychain reported an error: ${err.detail}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the V0.1 default profile. Used by "fill with sample" helpers.
 */
export function sampleProfile(): SocialProfile {
  return {
    nickname: '',
    bio: '',
    interests: [],
    currentActivities: [],
    socialIntent: ['similar_interests'],
    conversationStyle: ['technical'],
    boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
    ...{},
  };
}

/**
 * Re-export the protocol defaults so views don't need a direct import.
 */
export { DEFAULT_AGENT_CAPABILITIES, DEFAULT_SOCIAL_BOUNDARIES };
