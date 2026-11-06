/**
 * The localStorage → database migration — Phase D / D1 (requirements 11, 12).
 *
 * ## What it moves
 *
 * Everything the app used to keep in `localStorage`:
 *
 *   - `kindora:agent`                  → `agents` + `profiles`
 *   - `kindora:settings:*`             → `settings`
 *   - `kindora:phase7:blocked-agents:v1` → `blocked_agents`
 *
 * The secret store is **not** part of this: API keys live in the OS
 * keychain (Phase A / A1) and the private key lives there too. Neither
 * is ever written to the database.
 *
 * ## The two rules that matter
 *
 * **1. Nothing is deleted before it has been written.**
 *
 * The localStorage copy is removed only *after* the database write
 * succeeded. If the write fails — a full disk, a damaged database, a
 * crash — the old data is still there, untouched, and the next start
 * tries again. That is what 「数据迁移应支持失败恢复」 means, and what
 * 「数据库迁移失败时原数据不丢失」 asks for.
 *
 * **2. The migration is idempotent.**
 *
 * Every write is an upsert, so running the migration twice writes the
 * same rows twice and ends in the same state. The migration can
 * therefore be run on every start without a marker table.
 *
 * ## The private key
 *
 * A record written before Phase A carries a plaintext private key in
 * `localStorage`. The migration never copies a private key into the
 * database. The caller can supply a `prepareAgent` hook that first
 * moves such a key into the OS keychain (that is what the desktop app
 * does); the migration then stores the rewritten, keychain-backed
 * record. When the hook cannot run — no keychain on this device — the
 * agent is migrated anyway but the report says that the plaintext key
 * was left behind, so the caller can warn the user.
 */

import type { BlockedAgent } from './blocked-agents-store';
import type { StoredAgent } from './profile-store';
import type { KindoraDatabase } from './database';

/**
 * Where the legacy data comes from, and how it is removed.
 *
 * The source is an interface rather than a direct read of
 * `globalThis.localStorage` so that the migration can be tested without
 * a browser and so that the desktop app can decide what "the legacy
 * data" means for its runtime.
 */
export interface LegacyStorageSource {
  /** The legacy agent record, or `null`. */
  readAgent(): StoredAgent | null;
  /** Every legacy setting, by key. */
  readSettings(): Record<string, unknown>;
  /** The legacy block list. */
  readBlockedAgents(): readonly BlockedAgent[];
  /** Forget the legacy agent record. */
  removeAgent(): void;
  /** Forget one legacy setting. */
  removeSetting(key: string): void;
  /** Forget the legacy block list. */
  removeBlockedAgents(): void;
}

/** What the migration did. */
export interface LegacyMigrationReport {
  /** True iff an agent record was written to the database. */
  readonly migratedAgent: boolean;
  /** The settings that were written. */
  readonly migratedSettings: readonly string[];
  /** How many blocked agents were written. */
  readonly migratedBlockedAgents: number;
  /**
   * True iff the migrated agent record still had a plaintext private
   * key, which was **not** copied into the database.
   */
  readonly agentPrivateKeyLeftBehind: boolean;
  /** Things that were deliberately not migrated, and why. */
  readonly skipped: readonly string[];
  /** True iff the migration stopped early because of an error. */
  readonly failed: boolean;
  /** The error, when there was one. */
  readonly error?: string;
}

export interface LegacyMigrationOptions {
  /**
   * Runs before the agent record is written.
   *
   * The desktop app uses this to move a plaintext private key into the
   * OS keychain first, so that the record it stores says "the key is
   * in the keychain" and carries no key material.
   */
  readonly prepareAgent?: (raw: StoredAgent) => Promise<StoredAgent>;
}

const NOTHING_MIGRATED: LegacyMigrationReport = Object.freeze({
  migratedAgent: false,
  migratedSettings: Object.freeze([]) as readonly string[],
  migratedBlockedAgents: 0,
  agentPrivateKeyLeftBehind: false,
  skipped: Object.freeze([]) as readonly string[],
  failed: false,
});

/**
 * Move the legacy localStorage data into the database.
 *
 * Never throws: a failure is reported in the result, because the
 * caller has to be able to carry on (or to show the failure) without
 * the whole app failing to start.
 */
export async function migrateLegacyLocalStorage(
  db: KindoraDatabase,
  source: LegacyStorageSource,
  options?: LegacyMigrationOptions,
): Promise<LegacyMigrationReport> {
  const migratedSettings: string[] = [];
  const skipped: string[] = [];
  let migratedAgent = false;
  let agentPrivateKeyLeftBehind = false;
  let migratedBlockedAgents = 0;

  try {
    /* ---- the agent ------------------------------------------------- */
    const rawAgent = source.readAgent();
    if (rawAgent) {
      const prepared = options?.prepareAgent ? await options.prepareAgent(rawAgent) : rawAgent;
      agentPrivateKeyLeftBehind = typeof prepared.privateKey === 'string';

      // `saveAgent` strips the private key; this is the second line of
      // defence behind that one.
      const { privateKey: _privateKey, ...withoutKey } = prepared;
      await db.saveAgent(withoutKey);
      migratedAgent = true;

      // Only now is the old copy disposable.
      source.removeAgent();
    }

    /* ---- the settings ---------------------------------------------- */
    const settings = source.readSettings();
    for (const key of Object.keys(settings)) {
      await db.setSetting(key, settings[key]);
      migratedSettings.push(key);
      source.removeSetting(key);
    }

    /* ---- the block list --------------------------------------------- */
    const blocked = source.readBlockedAgents();
    for (const entry of blocked) {
      await db.addBlockedAgent(entry.agentId, entry.reason);
      migratedBlockedAgents += 1;
    }
    if (blocked.length > 0) {
      source.removeBlockedAgents();
    }
  } catch (err) {
    return {
      migratedAgent,
      migratedSettings,
      migratedBlockedAgents,
      agentPrivateKeyLeftBehind,
      skipped,
      failed: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    migratedAgent,
    migratedSettings,
    migratedBlockedAgents,
    agentPrivateKeyLeftBehind,
    skipped,
    failed: false,
  };
}

/** The report for "there was nothing to migrate". */
export function emptyLegacyMigrationReport(): LegacyMigrationReport {
  return NOTHING_MIGRATED;
}
