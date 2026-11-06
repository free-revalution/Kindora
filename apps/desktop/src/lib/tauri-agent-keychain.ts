/**
 * TauriAgentKeychain — the OS keychain bridge for the agent's long-term
 * private key (Phase A / A1).
 *
 * The private key lives in exactly one place: the operating system's
 * keychain (macOS Keychain / Windows Credential Manager / Linux Secret
 * Service). The Rust side exposes it through the `agent_key_*` commands;
 * this file is the typed frontend for them.
 *
 * The errors coming back from Rust are structured — `{ kind, message }` —
 * so callers can react to "the keychain is locked" instead of matching
 * on English prose.
 *
 * Known V0.1 limitation: the private key is read back into the webview
 * in order to sign envelopes there. A Rust-side signer (so that the key
 * never leaves Rust) needs `p256` / `ecdsa` in `Cargo.lock` and is
 * tracked as a follow-up. See docs/REMEDIATION_PROGRESS.md.
 */

import { getTauriInvoke, isTauriRuntime, type TauriInvoke } from './tauri-runtime';

export type AgentKeyErrorKind =
  | 'keychain_locked'
  | 'keychain_denied'
  | 'keychain_unavailable'
  | 'not_found'
  | 'corrupt'
  | 'invalid_key'
  | 'keyring'
  | 'unknown';

const AGENT_KEY_ERROR_KINDS: readonly AgentKeyErrorKind[] = [
  'keychain_locked',
  'keychain_denied',
  'keychain_unavailable',
  'not_found',
  'corrupt',
  'invalid_key',
  'keyring',
  'unknown',
];

/** A structured error from the OS keychain. */
export class AgentKeyError extends Error {
  readonly kind: AgentKeyErrorKind;
  readonly detail: string;

  constructor(kind: AgentKeyErrorKind, detail: string) {
    super(`Agent key error (${kind}): ${detail}`);
    this.name = 'AgentKeyError';
    this.kind = kind;
    this.detail = detail;
  }

  /**
   * True when the failure is a transient / environmental condition that
   * the user could plausibly fix (unlock the keychain, grant access).
   */
  get isRecoverable(): boolean {
    return (
      this.kind === 'keychain_locked' ||
      this.kind === 'keychain_denied' ||
      this.kind === 'keychain_unavailable'
    );
  }
}

function toKind(value: unknown): AgentKeyErrorKind {
  if (typeof value === 'string' && (AGENT_KEY_ERROR_KINDS as readonly string[]).includes(value)) {
    return value as AgentKeyErrorKind;
  }
  return 'unknown';
}

/** Normalise whatever `invoke` rejected with into an `AgentKeyError`. */
export function toAgentKeyError(err: unknown): AgentKeyError {
  if (err instanceof AgentKeyError) return err;
  if (err && typeof err === 'object') {
    const candidate = err as { kind?: unknown; message?: unknown };
    if (typeof candidate.kind === 'string' || typeof candidate.message === 'string') {
      return new AgentKeyError(
        toKind(candidate.kind),
        typeof candidate.message === 'string' ? candidate.message : String(err),
      );
    }
  }
  if (typeof err === 'string') return new AgentKeyError('unknown', err);
  if (err instanceof Error) return new AgentKeyError('unknown', err.message);
  return new AgentKeyError('unknown', String(err));
}

/**
 * The agent-key store surface.
 *
 * `load()` returns `null` when the device has no agent key yet — that
 * is the normal state on a fresh device, not an error.
 */
export interface AgentKeychain {
  /** Persist the private key (base64 PKCS#8) in the OS keychain. */
  store(privateKeyPkcs8Base64: string): Promise<void>;
  /** Read the private key back, or `null` if there is none. */
  load(): Promise<string | null>;
  /** True when a key is present. */
  exists(): Promise<boolean>;
  /** Remove the key. Deleting a missing key is a no-op. */
  delete(): Promise<void>;
}

/** The Tauri-backed implementation. */
export class TauriAgentKeychain implements AgentKeychain {
  private readonly tauri: TauriInvoke;

  constructor(tauri?: TauriInvoke) {
    const t = tauri ?? getTauriInvoke();
    if (!t) {
      throw new Error('TauriAgentKeychain: Tauri runtime not available.');
    }
    this.tauri = t;
  }

  async store(privateKeyPkcs8Base64: string): Promise<void> {
    try {
      await this.tauri.invoke('agent_key_store', { value: privateKeyPkcs8Base64 });
    } catch (err) {
      throw toAgentKeyError(err);
    }
  }

  async load(): Promise<string | null> {
    try {
      return await this.tauri.invoke<string | null>('agent_key_get');
    } catch (err) {
      throw toAgentKeyError(err);
    }
  }

  async exists(): Promise<boolean> {
    try {
      return await this.tauri.invoke<boolean>('agent_key_exists');
    } catch (err) {
      throw toAgentKeyError(err);
    }
  }

  async delete(): Promise<void> {
    try {
      await this.tauri.invoke('agent_key_delete');
    } catch (err) {
      throw toAgentKeyError(err);
    }
  }
}

/**
 * True when an OS keychain is reachable.
 *
 * This is the gate for A1: without it the private key would have to be
 * written to localStorage, which is exactly what Phase A removes.
 */
export function isAgentKeychainAvailable(): boolean {
  return isTauriRuntime();
}
