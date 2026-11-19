/**
 * Moving a plaintext private key into the OS keychain — Phase A / A1.
 *
 * This module holds the *core* of the keychain migration so that two
 * callers can use it:
 *
 *   - `agent-service.ts`, when the app loads an agent whose record
 *     still carries a plaintext key;
 *   - the Phase D legacy migration, which has to move the key out of
 *     localStorage **before** the record is copied into the database
 *     (a private key must never be written to SQLite — D1 requirement
 *     10).
 *
 * ## The order is the whole point
 *
 *   1. write the key to the keychain;
 *   2. read it back and compare it byte for byte;
 *   3. only then rewrite the record without the plaintext;
 *   4. read the record back and confirm it is intact.
 *
 * If any step fails the plaintext stays exactly where it was and the
 * error is surfaced. The app never deletes the only copy of a private
 * key, and it never regenerates an identity to paper over a failure.
 */

import {
  base64ToBytes,
  deriveKeyId,
  importPrivateKey,
  importPublicKey,
  signEs256,
  verifyEs256,
} from '@kindora/protocol';
import type { StoredAgent } from '@kindora/storage';

import {
  AgentKeyError,
  TauriAgentKeychain,
  isAgentKeychainAvailable,
} from './tauri-agent-keychain';
import { getTauriInvoke } from './tauri-runtime';

/** How the caller reads and writes the record the key belongs to. */
export interface AgentRecordIo {
  /** Write the record back. */
  persist(next: StoredAgent): Promise<void>;
  /** Read the record back. */
  load(): Promise<StoredAgent | null>;
}

/**
 * Move the plaintext private key of `stored` into the OS keychain and
 * return the rewritten record.
 *
 * The record is **not** written back by this function — the caller
 * decides where the record lives (the localStorage store, or the
 * database) and supplies the {@link AgentRecordIo} for it.
 */
export async function movePlaintextKeyToKeychain(
  stored: StoredAgent,
  io: AgentRecordIo,
): Promise<StoredAgent> {
  const privateKey = stored.privateKey;
  if (!privateKey) {
    throw new AgentKeyError(
      'not_found',
      'the agent record claims a keychain-backed key but no key is stored on this device',
    );
  }

  const keychain = new TauriAgentKeychain();

  // 1 — write.
  await keychain.store(privateKey);

  // 2 — verify (native path: no plaintext read-back).
  if (!(await keychain.exists())) {
    throw new AgentKeyError(
      'corrupt',
      'the OS keychain did not retain the key that was just stored; the local copy was kept',
    );
  }
  await assertNativeKeyMatchesPublicKey(stored.publicKey);

  const keyId = await deriveKeyId(base64ToBytes(stored.publicKey));
  const { privateKey: _plaintext, ...withoutPlaintext } = stored;
  const migrated: StoredAgent = {
    ...withoutPlaintext,
    privateKeyStorage: { kind: 'keychain', keyId },
    updatedAt: new Date().toISOString(),
  };

  // 3 — rewrite. This is the step that removes the plaintext.
  await io.persist(migrated);

  // 4 — confirm the record is intact.
  const verified = await io.load();
  if (!verified || verified.privateKeyStorage.kind !== 'keychain' || verified.privateKey) {
    // Put the original record back so the user keeps their key.
    await io.persist(stored);
    throw new AgentKeyError(
      'corrupt',
      'the agent record could not be rewritten without its private key; the local copy was kept',
    );
  }

  return { ...verified, privateKey };
}

/**
 * Verify the OS keychain key matches the recorded public key via Rust
 * `agent_key_matches_public_key` (fixed probe; D4 — no WebView `agent_sign`).
 */
export async function assertNativeKeyMatchesPublicKey(
  publicKeySpkiBase64: string,
): Promise<void> {
  if (!isAgentKeychainAvailable()) {
    throw new AgentKeyError('keychain_unavailable', 'Tauri runtime required for native key check');
  }
  const tauri = getTauriInvoke();
  if (!tauri) {
    throw new AgentKeyError('keychain_unavailable', 'Tauri invoke unavailable');
  }
  const keychain = new TauriAgentKeychain();
  if (!(await keychain.exists())) {
    throw new AgentKeyError('not_found', 'no agent key in the OS keychain');
  }
  let ok: boolean;
  try {
    ok = await tauri.invoke<boolean>('agent_key_matches_public_key', {
      publicKeyB64: publicKeySpkiBase64,
    });
  } catch (err) {
    throw new AgentKeyError(
      'corrupt',
      `native key match failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!ok) {
    throw new AgentKeyError(
      'corrupt',
      'the private key in the OS keychain does not match the recorded public key',
    );
  }
}

export async function assertKeyMatchesPublicKey(
  privateKeyPkcs8Base64: string,
  publicKeySpkiBase64: string,
): Promise<void> {
  let matches: boolean;
  try {
    const privateKey = await importPrivateKey(base64ToBytes(privateKeyPkcs8Base64));
    const publicKey = await importPublicKey(base64ToBytes(publicKeySpkiBase64));
    const probe = new TextEncoder().encode('kindora:key-match-probe:v1');
    const signature = await signEs256(privateKey, probe);
    matches = await verifyEs256(publicKey, probe, signature);
  } catch (err) {
    throw new AgentKeyError(
      'corrupt',
      `the stored private key could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!matches) {
    throw new AgentKeyError(
      'corrupt',
      'the private key in the OS keychain does not match the recorded public key',
    );
  }
}
