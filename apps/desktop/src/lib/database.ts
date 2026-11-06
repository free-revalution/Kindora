/**
 * The local business database — Phase D / D1.
 *
 * This module is the desktop app's entry point into the database:
 *
 *   1. open the SQLite file through the Tauri SQL plugin;
 *   2. check that the file is not damaged;
 *   3. apply the migrations that have not run yet;
 *   4. move whatever an older version of the app left in localStorage
 *      into the database.
 *
 * ## The browser dev server
 *
 * There is no Tauri runtime in `vite dev`, so there is no SQLite file
 * and no OS keychain. The dev server keeps using localStorage, which is
 * what {@link isDatabaseAvailable} reports. The two runtimes also have
 * *separate* storage areas — a browser's `localStorage` and the Tauri
 * webview's `localStorage` are different origins — so the dev server
 * and the packaged app never see each other's data.
 *
 * ## Failure
 *
 * Every failure here is a {@link DatabaseError} with a message that can
 * be shown to the user. The app turns it into a dedicated error screen
 * rather than a blank window.
 */

import {
  assertDatabaseHealthy,
  DatabaseError,
  emptyLegacyMigrationReport,
  migrateLegacyLocalStorage,
  normaliseStoredAgent,
  runMigrations,
  SerialExecutor,
  SqliteKindoraDatabase,
  type KindoraDatabase,
  type LegacyMigrationReport,
  type LegacyStorageSource,
  type StoredAgent,
} from '@kindora/storage';

import { isAgentKeychainAvailable } from './tauri-agent-keychain';
import { movePlaintextKeyToKeychain } from './agent-keychain-migration';
import { createTauriSqlExecutor, type TauriSqlExecutor } from './tauri-sql-executor';

/* ------------------------------------------------------------------ */
/* The legacy localStorage keys                                        */
/* ------------------------------------------------------------------ */

/** Where the V0.1 app kept the agent record. */
const LEGACY_AGENT_KEY = 'kindora:agent';
/** Where the V0.1 app kept its store version marker. */
const LEGACY_STORE_VERSION_KEY = 'kindora:store-version';
/** The prefix the V0.1 settings store used. */
const LEGACY_SETTINGS_PREFIX = 'kindora:settings:';
/** Where the V0.1 app kept the block list. */
const LEGACY_BLOCKED_KEY = 'kindora:phase7:blocked-agents:v1';

/* ------------------------------------------------------------------ */
/* Opening                                                             */
/* ------------------------------------------------------------------ */

let _executor: TauriSqlExecutor | null | undefined;
let _database: Promise<KindoraDatabase> | null = null;

/** The SQL executor for this runtime, or `null` in the browser dev server. */
function executor(): TauriSqlExecutor | null {
  if (_executor === undefined) _executor = createTauriSqlExecutor();
  return _executor;
}

/**
 * True when this runtime has a local database.
 *
 * The browser dev server does not: it keeps using localStorage.
 */
export function isDatabaseAvailable(): boolean {
  return executor() !== null;
}

/**
 * The local database.
 *
 * The file is opened once per session; every later call returns the
 * same instance. When opening fails, the cached promise is dropped so
 * that the next call tries again — the user gets a "Try again" button.
 */
export function getKindoraDatabase(): Promise<KindoraDatabase> {
  if (!_database) {
    _database = openDatabase().catch((err: unknown) => {
      _database = null;
      throw err;
    });
  }
  return _database;
}

/**
 * The local database, or `null` when this runtime has none.
 *
 * Use this in code paths that also have to work in the browser dev
 * server; use {@link getKindoraDatabase} where the database is
 * required.
 */
export async function tryGetKindoraDatabase(): Promise<KindoraDatabase | null> {
  if (!isDatabaseAvailable()) return null;
  return getKindoraDatabase();
}

async function openDatabase(): Promise<KindoraDatabase> {
  const exec = executor();
  if (!exec) {
    throw new DatabaseError(
      'The local database is only available in the desktop app. ' +
        'The browser preview keeps using browser storage.',
    );
  }

  await exec.load();

  // Every statement runs one at a time — see `SerialExecutor`.
  const serial = new SerialExecutor(exec);

  await assertDatabaseHealthy(serial);
  const outcome = await runMigrations(serial);

  return new SqliteKindoraDatabase(serial, outcome.to);
}

/* ------------------------------------------------------------------ */
/* The legacy migration                                                */
/* ------------------------------------------------------------------ */

/**
 * Move whatever an older version of the app left in localStorage into
 * the database.
 *
 * Safe to call on every start: every write is an upsert and the legacy
 * copy is only removed once the database write succeeded.
 */
export async function runLegacyMigration(db: KindoraDatabase): Promise<LegacyMigrationReport> {
  return migrateLegacyLocalStorage(db, createLegacySource(), {
    prepareAgent: prepareLegacyAgent,
  });
}

/** The report of a run that had nothing to do. */
const NO_LEGACY_DATA: LegacyMigrationReport = emptyLegacyMigrationReport();

let _legacyMigration: Promise<LegacyMigrationReport> | null = null;

/**
 * Run the legacy migration **once** per session, and let everybody wait
 * for it.
 *
 * The stores read from the database, so they have to wait for the
 * migration: otherwise a locale that used to live in localStorage
 * would be read from an empty database, and the user's choice would
 * look like it had been lost.
 *
 * A failed migration is **not** remembered as done — the next call
 * tries again, and the legacy copy is still there because it is only
 * removed after the database write succeeded.
 */
export function ensureLegacyMigration(): Promise<LegacyMigrationReport> {
  if (!_legacyMigration) {
    _legacyMigration = runLegacyMigrationOnce().catch((err: unknown) => {
      // The database could not be opened at all. Forget the attempt so
      // that a "Try again" can start from scratch.
      _legacyMigration = null;
      throw err;
    });
  }
  return _legacyMigration;
}

async function runLegacyMigrationOnce(): Promise<LegacyMigrationReport> {
  const db = await tryGetKindoraDatabase();
  if (!db) {
    // The browser dev server — localStorage stays the store, so there
    // is nothing to migrate.
    return NO_LEGACY_DATA;
  }
  const report = await runLegacyMigration(db);
  if (report.failed) {
    // Retried on the next call / the next start.
    _legacyMigration = null;
  }
  return report;
}

/** The localStorage reader / cleaner used by the migration. */
function createLegacySource(): LegacyStorageSource {
  return {
    readAgent(): StoredAgent | null {
      const raw = readLocalStorageItem(LEGACY_AGENT_KEY);
      if (raw === null) return null;
      try {
        return normaliseStoredAgent(JSON.parse(raw));
      } catch {
        return null;
      }
    },

    readSettings(): Record<string, unknown> {
      const storage = localStorageOrNull();
      if (!storage) return {};
      const out: Record<string, unknown> = {};
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null || !key.startsWith(LEGACY_SETTINGS_PREFIX)) continue;
        const raw = storage.getItem(key);
        if (raw === null) continue;
        try {
          out[key.slice(LEGACY_SETTINGS_PREFIX.length)] = JSON.parse(raw);
        } catch {
          // A value that is not valid JSON is left where it is; it is
          // not worth failing the whole migration over.
        }
      }
      return out;
    },

    readBlockedAgents() {
      const raw = readLocalStorageItem(LEGACY_BLOCKED_KEY);
      if (raw === null) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as never[]) : [];
      } catch {
        return [];
      }
    },

    removeAgent(): void {
      const storage = localStorageOrNull();
      if (!storage) return;
      storage.removeItem(LEGACY_AGENT_KEY);
      storage.removeItem(LEGACY_STORE_VERSION_KEY);
    },

    removeSetting(key: string): void {
      localStorageOrNull()?.removeItem(LEGACY_SETTINGS_PREFIX + key);
    },

    removeBlockedAgents(): void {
      localStorageOrNull()?.removeItem(LEGACY_BLOCKED_KEY);
    },
  };
}

/**
 * Prepare the legacy agent record for the database.
 *
 * A record written before Phase A carries a plaintext private key. The
 * key is moved into the OS keychain first — and only then is the
 * rewritten record handed to the migration, so the database never sees
 * key material.
 */
async function prepareLegacyAgent(raw: StoredAgent): Promise<StoredAgent> {
  if (raw.privateKeyStorage.kind !== 'dev-localstorage') return raw;
  if (typeof raw.privateKey !== 'string' || raw.privateKey.length === 0) return raw;
  if (!isAgentKeychainAvailable()) return raw;

  return movePlaintextKeyToKeychain(raw, {
    persist: async (next) => {
      localStorageOrNull()?.setItem(LEGACY_AGENT_KEY, JSON.stringify(next));
    },
    load: async () => {
      const stored = readLocalStorageItem(LEGACY_AGENT_KEY);
      if (stored === null) return null;
      try {
        return normaliseStoredAgent(JSON.parse(stored));
      } catch {
        return null;
      }
    },
  });
}

function localStorageOrNull(): Storage | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null;
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readLocalStorageItem(key: string): string | null {
  try {
    return localStorageOrNull()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
