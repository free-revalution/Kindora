/**
 * The database schema — Phase D / D1.
 *
 * ## The entities
 *
 * The task book (§ 七 D1) suggests `agents`, `profiles`, `settings`,
 * `blocked_agents`, `sessions`, `messages` and `database_migrations`,
 * and explicitly says:
 *
 * > 具体字段必须根据当前数据模型确定，不要机械照搬。
 *
 * So the table *names* follow the suggestion, but the *columns* were
 * derived from what the app actually stores today:
 *
 * | table            | holds                                                          |
 * |------------------|----------------------------------------------------------------|
 * | `agents`         | identity + capability metadata of the local agent              |
 * | `profiles`       | the social profile, including the Phase B privacy gates        |
 * | `settings`       | non-secret user preferences (model, base URL, locale, …)       |
 * | `blocked_agents` | the local block list                                           |
 * | `sessions`       | one row per chat session                                       |
 * | `messages`       | the chat transcript, with delivery state                       |
 * | `schema_migrations` | which migrations have run                                  |
 *
 * ## Three deliberate design decisions
 *
 * **1. No `FOREIGN KEY` constraints.**
 * SQLite does not enforce foreign keys unless `PRAGMA foreign_keys =
 * ON` is set on *every* connection, and the Tauri SQL plugin hands out
 * connections from a pool — a pragma set on one connection says
 * nothing about the next one. A foreign key that is silently not
 * enforced is worse than no foreign key at all, so the referential
 * integrity is enforced in the repository layer instead, and the
 * statements that need it are written so that a dangling row cannot
 * survive on its own.
 *
 * **2. Arrays and the boundary flags are stored as JSON text.**
 * `interests`, `currentActivities`, `socialIntent`,
 * `conversationStyle` and `boundaries` are all small, always read and
 * always written as a whole. Splitting them into child tables would
 * buy nothing and would make every schema change a migration.
 * `boundaries_json` is the Phase B privacy state — it is stored with
 * the profile precisely so that the gates travel with it.
 *
 * **3. The private key is not in this schema.**
 * The agent's private key belongs in the OS keychain (Phase A / A1).
 * `private_key_storage_json` records *where* the key lives — never the
 * key itself. The repository strips any `privateKey` field before it
 * reaches a statement, so a caller cannot leak it by accident.
 *
 * ## Migrations are append-only
 *
 * A migration is never edited after it has shipped: its `version` is
 * its identity. A new change is a new migration with a higher version.
 * Every statement is written so that running it twice is harmless
 * (`IF NOT EXISTS`), because the plugin cannot give us a transaction
 * that spans two statements — see `SerialExecutor`.
 */

/** One migration: a version, a name and the statements that apply it. */
export interface SqlMigration {
  /** The version this migration brings the schema to. Starts at 1. */
  readonly version: number;
  /** A short human-readable description, recorded in the schema table. */
  readonly name: string;
  /** The statements that make up the migration, in order. */
  readonly statements: readonly string[];
}

/**
 * The schema version this build of Kindora expects.
 *
 * A database whose recorded version is **higher** than this was written
 * by a newer build of the app; the migrator refuses to touch it rather
 * than downgrading somebody's data.
 */
export const SCHEMA_VERSION = 1;

/**
 * Every migration, in ascending version order.
 *
 * The migrator applies the ones that have not run yet. It never
 * re-applies one that has.
 */
export const MIGRATIONS: readonly SqlMigration[] = Object.freeze([
  {
    version: 1,
    name: 'initial-kindora-schema',
    statements: Object.freeze([
      // ---- identity ------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS agents (
         agent_id                 TEXT    PRIMARY KEY,
         display_name             TEXT    NOT NULL,
         public_key               TEXT    NOT NULL,
         protocol_version         TEXT    NOT NULL,
         capabilities_json        TEXT    NOT NULL,
         private_key_storage_json TEXT    NOT NULL,
         is_local                 INTEGER NOT NULL DEFAULT 0,
         created_at               TEXT    NOT NULL,
         updated_at               TEXT    NOT NULL
       )`,
      // At most one local agent. A partial unique index is the only way
      // to say "one row with is_local = 1" in SQLite.
      `CREATE UNIQUE INDEX IF NOT EXISTS agents_single_local
         ON agents (is_local) WHERE is_local = 1`,

      // ---- profile (incl. the Phase B privacy gates) ----------------------
      `CREATE TABLE IF NOT EXISTS profiles (
         agent_id                TEXT PRIMARY KEY,
         nickname                TEXT NOT NULL,
         avatar                  TEXT,
         bio                     TEXT NOT NULL,
         interests_json          TEXT NOT NULL,
         current_activities_json TEXT NOT NULL,
         social_intent_json      TEXT NOT NULL,
         conversation_style_json TEXT NOT NULL,
         boundaries_json         TEXT NOT NULL,
         updated_at              TEXT NOT NULL
       )`,

      // ---- non-secret preferences ----------------------------------------
      `CREATE TABLE IF NOT EXISTS settings (
         key        TEXT PRIMARY KEY,
         value      TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,

      // ---- block list ------------------------------------------------------
      `CREATE TABLE IF NOT EXISTS blocked_agents (
         agent_id   TEXT PRIMARY KEY,
         blocked_at TEXT NOT NULL,
         reason     TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS blocked_agents_order
         ON blocked_agents (blocked_at DESC)`,

      // ---- chat sessions ---------------------------------------------------
      `CREATE TABLE IF NOT EXISTS sessions (
         session_id        TEXT PRIMARY KEY,
         peer_agent_id     TEXT NOT NULL,
         peer_display_name TEXT NOT NULL,
         started_at        TEXT NOT NULL,
         ended_at          TEXT,
         close_reason      TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS sessions_started_at
         ON sessions (started_at DESC)`,

      // ---- chat messages ---------------------------------------------------
      // `message_id` is the primary key, so the same message can never be
      // stored twice (D2 requirement 7). `seq` is the per-session order.
      `CREATE TABLE IF NOT EXISTS messages (
         message_id      TEXT    PRIMARY KEY,
         session_id      TEXT    NOT NULL,
         seq             INTEGER NOT NULL,
         sender_agent_id TEXT    NOT NULL,
         direction       TEXT    NOT NULL,
         source          TEXT    NOT NULL,
         text            TEXT    NOT NULL,
         status          TEXT    NOT NULL,
         created_at      TEXT    NOT NULL,
         sent_at         TEXT,
         delivered_at    TEXT,
         failed_at       TEXT,
         failure_reason  TEXT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS messages_session_seq
         ON messages (session_id, seq)`,
      `CREATE INDEX IF NOT EXISTS messages_session_idx
         ON messages (session_id, seq)`,
    ]),
  },
]);

/**
 * The statement that creates the migration bookkeeping table.
 *
 * It is deliberately *not* part of {@link MIGRATIONS}: the migrator
 * needs the table before it can know which migrations have run.
 */
export const CREATE_SCHEMA_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;
