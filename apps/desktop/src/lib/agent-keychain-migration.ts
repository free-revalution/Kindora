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

import { AgentKeyError, TauriAgentKeychain } from './tauri-agent-keychain';

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

  // 2 — verify.
  const readBack = await keychain.load();
  if (readBack !== privateKey) {
    throw new AgentKeyError(
      'corrupt',
      'the OS keychain did not return the key that was just stored; the local copy was kept',
    );
  }

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
 * Confirm that a private key really belongs to the recorded public key.
 *
 * A mismatch means the keychain holds a key from a different identity —
 * which would silently break every signature. We sign a fixed probe with
 * the private key and verify it with the public key.
 */
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
