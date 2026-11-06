/**
 * The migration runner — Phase D / D1 (requirements 2, 3, 12, 13).
 *
 * ## What "migration" means here
 *
 * The schema is versioned. `schema_migrations` records which versions
 * have been applied to *this* database file; the migrator applies the
 * ones that are missing, in ascending order, and records each one only
 * after all of its statements have succeeded.
 *
 * ## Why there is no transaction
 *
 * The Tauri SQL plugin pools its connections and exposes no transaction
 * API, so a `BEGIN` on one connection cannot be closed by a `COMMIT` on
 * another. A migration therefore cannot be "rolled back" atomically.
 *
 * The design that replaces the transaction:
 *
 *   1. **Every statement is idempotent** (`CREATE TABLE IF NOT EXISTS`,
 *      `CREATE INDEX IF NOT EXISTS`). Running a migration twice is
 *      harmless.
 *   2. **The version row is written last.** If the app dies half way
 *      through migration 3, version 3 was never recorded, so the next
 *      start runs it again — and because it is idempotent, it succeeds.
 *   3. **The statement that failed is reported.** The error names the
 *      migration, its version and the index of the statement that
 *      failed, so the failure is actionable instead of "database error".
 *
 * That is what "数据迁移应支持失败恢复" means here: a failed migration
 * leaves the *existing* data untouched and the next start finishes the
 * job.
 */

import {
  CREATE_SCHEMA_MIGRATIONS_TABLE,
  MIGRATIONS,
  SCHEMA_VERSION,
  type SqlMigration,
} from './sql-migrations';
import { sqlToNumber, type SqlExecutor } from './sql-executor';

/**
 * The message of an unknown failure.
 *
 * A driver error can be anything — an `Error`, a string, an object — and
 * the message of the failure is the only part worth showing.
 */
function failureDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A failure of the local database.
 *
 * The message is written for a human: the app shows it on screen when
 * the database cannot be opened or is damaged. Never let a raw driver
 * error reach the UI.
 */
export class DatabaseError extends Error {
  /** Extra context — the failing statement, the underlying message, … */
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(detail ? `${message} (${detail})` : message);
    this.name = 'DatabaseError';
    this.detail = detail;
  }
}

/**
 * The database file is not a usable SQLite database.
 *
 * Raised by {@link assertDatabaseHealthy} when SQLite's own integrity
 * check does not come back clean. The data in such a file cannot be
 * trusted, so the app must say so rather than silently starting over.
 */
export class DatabaseCorruptError extends DatabaseError {
  constructor(detail: string) {
    super(
      'The local database is damaged and could not be read. ' +
        'Your data has not been deleted — please back up the database file ' +
        'before restoring it from a backup or reinstalling the app.',
      detail,
    );
    this.name = 'DatabaseCorruptError';
  }
}

/**
 * A migration could not be applied.
 *
 * The migration that failed was **not** recorded, so the next start
 * retries it. Whatever data the earlier migrations wrote is untouched.
 */
export class MigrationFailedError extends DatabaseError {
  /** The version of the migration that failed. */
  readonly version: number;
  /** The name of the migration that failed. */
  readonly migrationName: string;
  /** The zero-based index of the statement that failed. */
  readonly statementIndex: number;

  constructor(input: {
    readonly version: number;
    readonly migrationName: string;
    readonly statementIndex: number;
    readonly cause: unknown;
  }) {
    const cause = failureDetail(input.cause);
    super(
      `Database migration ${input.version} ("${input.migrationName}") failed at statement ` +
        `${input.statementIndex + 1}. The database was left at its previous version and ` +
        `will be retried the next time the app starts.`,
      cause,
    );
    this.name = 'MigrationFailedError';
    this.version = input.version;
    this.migrationName = input.migrationName;
    this.statementIndex = input.statementIndex;
  }
}

/** What a migration run did. */
export interface MigrationOutcome {
  /** The schema version before the run. `0` for a fresh database. */
  readonly from: number;
  /** The schema version after the run. */
  readonly to: number;
  /** The versions that this run applied, in ascending order. */
  readonly applied: readonly number[];
}

/**
 * Run a query, turning a driver failure into a {@link DatabaseError}.
 *
 * Every driver call in this file goes through here (or through the
 * equivalent around a statement), because a raw driver error must never
 * reach the UI — the app shows the message of a `DatabaseError` on a
 * screen of its own.
 */
async function selectRows(
  exec: SqlExecutor,
  sql: string,
  makeError: (detail: string) => DatabaseError,
): Promise<readonly Record<string, unknown>[]> {
  try {
    return await exec.select(sql);
  } catch (err) {
    throw makeError(failureDetail(err));
  }
}

/**
 * Check that the database file is not damaged.
 *
 * `PRAGMA quick_check` is SQLite's own consistency check. It is the
 * fast variant of `integrity_check` — it scans the pages but skips the
 * index verification, which is what an app-startup check wants.
 *
 * A database that cannot even be opened fails earlier, in the plugin's
 * `load` command; the caller reports that separately.
 */
export async function assertDatabaseHealthy(exec: SqlExecutor): Promise<void> {
  const rows = await selectRows(
    exec,
    'PRAGMA quick_check',
    (detail) => new DatabaseCorruptError(detail),
  );

  const row = rows[0];
  if (!row) {
    throw new DatabaseCorruptError('SQLite returned no result for its integrity check.');
  }

  // The column name is "quick_check" on every SQLite we support, but a
  // future version could rename it — fall back to the only value.
  const raw = row['quick_check'] ?? Object.values(row)[0];
  const verdict = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (verdict !== 'ok') {
    throw new DatabaseCorruptError(
      `SQLite reported: ${typeof raw === 'string' ? raw : String(raw)}`,
    );
  }
}

/**
 * The schema version currently recorded in the database.
 *
 * `0` means "no migration has run yet" — a fresh, empty file.
 */
export async function readSchemaVersion(exec: SqlExecutor): Promise<number> {
  const rows = await selectRows(
    exec,
    'SELECT version FROM schema_migrations ORDER BY version DESC',
    (detail) => new DatabaseError('The local database could not be read.', detail),
  );
  const first = rows[0];
  if (!first) return 0;
  const version = sqlToNumber(first['version']);
  return version ?? 0;
}

/** The versions that have already been applied. */
async function readAppliedVersions(exec: SqlExecutor): Promise<Set<number>> {
  const rows = await selectRows(
    exec,
    'SELECT version FROM schema_migrations',
    (detail) => new DatabaseError('The local database could not be read.', detail),
  );
  const applied = new Set<number>();
  for (const row of rows) {
    const version = sqlToNumber(row['version']);
    if (version !== null) applied.add(version);
  }
  return applied;
}

/**
 * Apply every migration that has not run yet.
 *
 * Safe to call on every start: an up-to-date database is left alone.
 *
 * Throws:
 *   - {@link DatabaseError} when the database was written by a newer
 *     build of the app, or when the recorded versions have a gap
 *     (which would mean applying an old migration on top of a new one);
 *   - {@link MigrationFailedError} when a statement fails;
 *   - {@link DatabaseError} when the database cannot be prepared, read
 *     or written at all.
 *
 * **Every failure is a {@link DatabaseError}.** The app shows the
 * message of a `DatabaseError` on a screen of its own; a raw driver
 * error would reach the user as an unhandled exception, so each driver
 * call below is wrapped. The bookkeeping table and the version row are
 * not migration statements — the first one belongs to no migration at
 * all, and the second is written after the migration succeeded — so
 * their failures are reported as a plain `DatabaseError` rather than as
 * a `MigrationFailedError`.
 */
export async function runMigrations(
  exec: SqlExecutor,
  migrations: readonly SqlMigration[] = MIGRATIONS,
): Promise<MigrationOutcome> {
  // The bookkeeping table comes first — the runner cannot know what has
  // run until it exists. It is not part of any migration, so a failure
  // here names no version and no statement.
  try {
    await exec.execute(CREATE_SCHEMA_MIGRATIONS_TABLE);
  } catch (err) {
    throw new DatabaseError(
      'The local database could not be prepared for migration.',
      failureDetail(err),
    );
  }

  // The applied versions are read through the same helper, so a driver
  // failure here is a `DatabaseError` too.
  const applied = await readAppliedVersions(exec);
  const from = applied.size === 0 ? 0 : Math.max(...applied);

  const latest =
    migrations.length === 0 ? SCHEMA_VERSION : migrations[migrations.length - 1]!.version;

  if (from > latest) {
    throw new DatabaseError(
      `The local database was written by a newer version of Kindora ` +
        `(schema v${from}, this build understands v${latest}). ` +
        `Update the app to open it.`,
      `schema version ${from} > ${latest}`,
    );
  }

  // The applied versions have to be a *prefix* of the migration list. A
  // gap means an old migration was never applied while a newer one was,
  // and applying the old one now would be out of order.
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const appliedSorted = [...applied].sort((a, b) => a - b);
  for (let index = 0; index < appliedSorted.length; index += 1) {
    const version = appliedSorted[index]!;
    const expected = ordered[index]?.version;
    if (expected !== undefined && version !== expected) {
      throw new DatabaseError(
        `The local database has an inconsistent migration history ` +
          `(version ${version} is present but ${expected} is not).`,
        `applied: ${appliedSorted.join(', ')}`,
      );
    }
  }

  const newlyApplied: number[] = [];

  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;

    for (let index = 0; index < migration.statements.length; index += 1) {
      const statement = migration.statements[index]!;
      try {
        await exec.execute(statement);
      } catch (err) {
        throw new MigrationFailedError({
          version: migration.version,
          migrationName: migration.name,
          statementIndex: index,
          cause: err,
        });
      }
    }

    // Recorded only after every statement succeeded — see the header.
    try {
      await exec.execute(
        'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, new Date().toISOString()],
      );
    } catch (err) {
      // The migration itself succeeded — only the bookkeeping write
      // failed. The version stays unrecorded, so the next start runs
      // the migration again, and because it is idempotent that is
      // harmless.
      throw new DatabaseError(
        `Database migration ${migration.version} ("${migration.name}") was applied, but its version ` +
          `could not be recorded. The database was left at its previous version and the migration ` +
          `will be retried the next time the app starts.`,
        failureDetail(err),
      );
    }
    newlyApplied.push(migration.version);
  }

  return {
    from,
    to: newlyApplied.length > 0 ? newlyApplied[newlyApplied.length - 1]! : from,
    applied: newlyApplied,
  };
}
