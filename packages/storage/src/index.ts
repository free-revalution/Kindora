/**
 * @kindora/storage
 *
 * Local-first persistence for profile, conversations, settings, secrets.
 *
 *   - ProfileStore           Phase 1 — agent + profile
 *   - SecretStore            Phase 2 — API keys
 *   - SettingsStore          Phase 2 — non-secret prefs
 *   - BrowserLocalStorage*   Implementations for browser / Tauri webview
 *
 * ## Phase D / D1 — the local business database
 *
 * The V0.1 sketch above (`STORAGE_TABLES` / `StorageBackend`) is a
 * key-value sketch that was never implemented. It is kept because
 * removing an exported symbol is a breaking change, but it is
 * **superseded**: the real schema now lives in `sql-migrations.ts` and
 * the real port in `database.ts`.
 *
 *   - `KindoraDatabase`      the port, in domain terms
 *   - `SqliteKindoraDatabase`  the real one (SQLite, via the Tauri SQL plugin)
 *   - `InMemoryKindoraDatabase` the same semantics without a file
 *   - `runMigrations`        the schema version + migration runner
 *   - `ChatRepository`       the chat transcript, with delivery state
 *   - `migrateLegacyLocalStorage`  the localStorage → database move
 *
 * See 开发手册.md § 12, § 37.
 */

/**
 * The table names sketched for V0.1.
 *
 * @deprecated Superseded by the Phase D schema in `sql-migrations.ts`.
 * The two lists are not the same and this one is not used anywhere.
 */
export const STORAGE_TABLES = [
  'profiles',
  'agents',
  'llm_configs',
  'connections',
  'matches',
  'conversations',
  'messages',
  'permissions',
] as const;

/**
 * @deprecated Superseded by {@link KindoraDatabase}.
 */
export type StorageTable = (typeof STORAGE_TABLES)[number];

/**
 * @deprecated Superseded by {@link KindoraDatabase}. No implementation
 * of this interface exists.
 */
export interface StorageBackend {
  initialize(): Promise<void>;
  read(table: StorageTable, key: string): Promise<unknown | null>;
  write(table: StorageTable, key: string, value: unknown): Promise<void>;
  delete(table: StorageTable, key: string): Promise<void>;
  list(table: StorageTable): Promise<readonly unknown[]>;
}

export const STORAGE_PACKAGE_VERSION = '0.1.0';

export {
  type StoredAgent,
  type ProfileStore,
  type PrivateKeyStorage,
  PROFILE_STORE_VERSION,
} from './profile-store';
export {
  BrowserLocalStorageProfileStore,
  normaliseStoredAgent,
  toPersistedAgent,
} from './browser-store';

export { type SecretStore, SECRET_STORE_VERSION } from './secret-store';
export { InMemorySecretStore } from './in-memory-secret-store';
export { BrowserLocalStorageEncryptedSecretStore } from './encrypted-local-storage-secret-store';

export { type SettingsStore, BrowserLocalStorageSettingsStore } from './settings-store';

export {
  type BlockedAgent,
  type BlockedAgentsStore,
  BrowserLocalStorageBlockedAgentsStore,
  InMemoryBlockedAgentsStore,
  isValidBlockedAgentId,
} from './blocked-agents-store';

/* ------------------------------------------------------------------ */
/* Phase D / D1 — the local business database                          */
/* ------------------------------------------------------------------ */

export {
  boolToSql,
  SerialExecutor,
  sqlToBool,
  sqlToNumber,
  sqlToString,
  sqlToText,
  type SqlExecuteResult,
  type SqlExecutor,
  type SqlRow,
  type SqlScalar,
} from './sql-executor';

export {
  CREATE_SCHEMA_MIGRATIONS_TABLE,
  MIGRATIONS,
  SCHEMA_VERSION,
  type SqlMigration,
} from './sql-migrations';

export {
  assertDatabaseHealthy,
  DatabaseCorruptError,
  DatabaseError,
  MigrationFailedError,
  readSchemaVersion,
  runMigrations,
  type MigrationOutcome,
} from './sql-migrator';

export {
  type ChatMessageDirection,
  type ChatMessageSource,
  type ChatMessageStatus,
  type KindoraDatabase,
  type StoredChatMessage,
  type StoredSessionRecord,
} from './database';

export { SqliteKindoraDatabase } from './sqlite-database';
export { InMemoryKindoraDatabase } from './memory-database';

export {
  DatabaseBlockedAgentsStore,
  DatabaseProfileStore,
  DatabaseSettingsStore,
  type DatabaseProvider,
} from './database-stores';

export {
  ChatRepository,
  type ChatRepositoryOptions,
  type DeliveryReceipt,
  type OpenSessionInput,
  type RecordInboundInput,
  type RecordOutboundInput,
  type ResumedSession,
} from './chat-repository';

export {
  emptyLegacyMigrationReport,
  migrateLegacyLocalStorage,
  type LegacyMigrationOptions,
  type LegacyMigrationReport,
  type LegacyStorageSource,
} from './legacy-migration';
