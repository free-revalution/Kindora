/**
 * The migration runner — Phase D / D1 (requirements 2, 3, 12, 13).
 *
 * The runner is the piece that has to survive a crash, so the tests
 * are about the *order* of things:
 *
 *   - the bookkeeping table comes first;
 *   - the version is recorded **last**, so a half-applied migration is
 *     retried on the next start;
 *   - a failure names the migration, its version and the statement that
 *     failed, and leaves the recorded version alone.
 *
 * See docs/修复.md § 七 D1.
 */

import { describe, it, expect } from 'vitest';

import {
  assertDatabaseHealthy,
  DatabaseCorruptError,
  DatabaseError,
  MigrationFailedError,
  readSchemaVersion,
  runMigrations,
} from '../sql-migrator';
import {
  CREATE_SCHEMA_MIGRATIONS_TABLE,
  MIGRATIONS,
  SCHEMA_VERSION,
  type SqlMigration,
} from '../sql-migrations';
import type { SqlExecuteResult, SqlExecutor, SqlRow, SqlScalar } from '../sql-executor';

/**
 * A database that remembers what it was asked to do.
 *
 * It is not a SQLite: it stores the *bookkeeping* of the schema
 * versions, which is all the runner reads back.
 */
class FakeSql implements SqlExecutor {
  readonly executed: string[] = [];
  readonly executedWithParams: { sql: string; params: readonly SqlScalar[] }[] = [];
  /** The versions that have been recorded so far. */
  appliedVersions: number[] = [];
  /** When this returns true for a statement, the statement fails. */
  failWhen: ((sql: string) => boolean) | null = null;
  /** When set, every query fails with this error. */
  selectError: Error | null = null;
  /** The verdict of `PRAGMA quick_check`. `null` means "no row". */
  quickCheck: string | null = 'ok';

  async execute(sql: string, params?: readonly SqlScalar[]): Promise<SqlExecuteResult> {
    if (this.failWhen?.(sql)) throw new Error('statement failed');
    this.executed.push(sql);
    this.executedWithParams.push({ sql, params: params ?? [] });
    if (/INSERT OR REPLACE INTO schema_migrations/i.test(sql)) {
      this.appliedVersions.push(Number(params?.[0]));
    }
    return { rowsAffected: 1, lastInsertId: null };
  }

  async select(sql: string): Promise<readonly SqlRow[]> {
    if (this.selectError) throw this.selectError;
    if (/PRAGMA quick_check/i.test(sql)) {
      return this.quickCheck === null ? [] : [{ quick_check: this.quickCheck }];
    }
    if (/SELECT version FROM schema_migrations/i.test(sql)) {
      const versions = sql.includes('ORDER BY version DESC')
        ? [...this.appliedVersions].reverse()
        : this.appliedVersions;
      return versions.map((version) => ({ version }));
    }
    return [];
  }
}

const TWO_MIGRATIONS: readonly SqlMigration[] = [
  { version: 1, name: 'one', statements: ['CREATE TABLE a (x TEXT)'] },
  { version: 2, name: 'two', statements: ['CREATE TABLE b (x TEXT)'] },
];

describe('runMigrations — a fresh database', () => {
  it('creates the bookkeeping table before anything else', async () => {
    const sql = new FakeSql();
    await runMigrations(sql);
    expect(sql.executed[0]).toBe(CREATE_SCHEMA_MIGRATIONS_TABLE);
  });

  it('applies every migration and reports the version it reached', async () => {
    const sql = new FakeSql();
    const outcome = await runMigrations(sql);

    expect(outcome.from).toBe(0);
    expect(outcome.to).toBe(SCHEMA_VERSION);
    expect(outcome.applied).toEqual([SCHEMA_VERSION]);
  });

  it('runs every statement of the migration', async () => {
    const sql = new FakeSql();
    await runMigrations(sql);

    const statements = MIGRATIONS.flatMap((m) => m.statements);
    for (const statement of statements) {
      expect(sql.executed).toContain(statement);
    }
  });

  it('records the version only after every statement succeeded', async () => {
    const sql = new FakeSql();
    await runMigrations(sql);

    const versionIndex = sql.executed.findIndex((s) =>
      /INSERT OR REPLACE INTO schema_migrations/i.test(s),
    );
    const lastStatementIndex = sql.executed.length - 2; // the version insert is the last one
    expect(versionIndex).toBeGreaterThan(lastStatementIndex);
  });

  it('records the version with its name', async () => {
    const sql = new FakeSql();
    await runMigrations(sql);

    const insert = sql.executedWithParams.find((c) =>
      /INSERT OR REPLACE INTO schema_migrations/i.test(c.sql),
    );
    expect(insert?.params[0]).toBe(SCHEMA_VERSION);
    expect(insert?.params[1]).toBe(MIGRATIONS[0]?.name);
    expect(typeof insert?.params[2]).toBe('string');
  });
});

describe('runMigrations — an up-to-date database', () => {
  it('applies nothing and leaves the version alone', async () => {
    const sql = new FakeSql();
    await runMigrations(sql);
    const firstRun = sql.executed.length;

    const outcome = await runMigrations(sql);

    expect(outcome.applied).toEqual([]);
    expect(outcome.from).toBe(SCHEMA_VERSION);
    expect(outcome.to).toBe(SCHEMA_VERSION);
    // Only the bookkeeping table was touched the second time.
    expect(sql.executed.length).toBe(firstRun + 1);
  });
});

describe('runMigrations — a failure', () => {
  it('names the migration, its version and the failing statement', async () => {
    const sql = new FakeSql();
    const failing = MIGRATIONS[0]?.statements[1] ?? '';
    sql.failWhen = (s) => s === failing;

    const error = await runMigrations(sql).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MigrationFailedError);
    const failure = error as MigrationFailedError;
    expect(failure.version).toBe(MIGRATIONS[0]?.version);
    expect(failure.migrationName).toBe(MIGRATIONS[0]?.name);
    expect(failure.statementIndex).toBe(1);
    expect(failure.message).toMatch(/will be retried/i);
  });

  it('does not record the version of the migration that failed', async () => {
    const sql = new FakeSql();
    const failing = MIGRATIONS[0]?.statements[1] ?? '';
    sql.failWhen = (s) => s === failing;

    await runMigrations(sql).catch(() => undefined);

    // Nothing was recorded, so the next start runs the migration again.
    expect(sql.appliedVersions).toEqual([]);
  });

  it('is a DatabaseError, so the app can show it as one', async () => {
    const sql = new FakeSql();
    sql.failWhen = (s) => /CREATE TABLE IF NOT EXISTS/i.test(s);
    const error = await runMigrations(sql).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DatabaseError);
  });

  it('is a DatabaseError when the bookkeeping table cannot be created', async () => {
    const sql = new FakeSql();
    sql.failWhen = (s) => s === CREATE_SCHEMA_MIGRATIONS_TABLE;

    const error = await runMigrations(sql).catch((err: unknown) => err);

    // The bookkeeping table belongs to no migration, so there is no
    // version and no statement index to report — but the app still has
    // to be able to show this as a database failure.
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).not.toBeInstanceOf(MigrationFailedError);
    expect((error as Error).message).toMatch(/could not be prepared/i);
  });

  it('is a DatabaseError when the recorded versions cannot be read', async () => {
    const sql = new FakeSql();
    sql.selectError = new Error('file is not a database');

    const error = await runMigrations(sql).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as Error).message).toMatch(/could not be read/i);
  });

  it('is a DatabaseError when the applied version cannot be recorded', async () => {
    const sql = new FakeSql();
    sql.failWhen = (s) => /INSERT OR REPLACE INTO schema_migrations/i.test(s);

    const error = await runMigrations(sql).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as Error).message).toMatch(/will be retried/i);
    // Nothing was recorded, so the next start runs the migration again.
    expect(sql.appliedVersions).toEqual([]);
  });
});

describe('runMigrations — an unexpected database', () => {
  it('refuses a database written by a newer build', async () => {
    const sql = new FakeSql();
    sql.appliedVersions = [SCHEMA_VERSION + 1];

    await expect(runMigrations(sql)).rejects.toThrow(/newer version/i);
  });

  it('refuses a migration history with a gap', async () => {
    const sql = new FakeSql();
    // Version 2 is recorded but version 1 is not.
    sql.appliedVersions = [2];

    await expect(runMigrations(sql, TWO_MIGRATIONS)).rejects.toThrow(
      /inconsistent migration history/i,
    );
  });

  it('applies the missing migration when the history is a proper prefix', async () => {
    const sql = new FakeSql();
    sql.appliedVersions = [1];

    const outcome = await runMigrations(sql, TWO_MIGRATIONS);

    expect(outcome.applied).toEqual([2]);
    expect(outcome.to).toBe(2);
    expect(sql.executed).toContain('CREATE TABLE b (x TEXT)');
  });
});

describe('assertDatabaseHealthy', () => {
  it('accepts a database whose integrity check says ok', async () => {
    const sql = new FakeSql();
    sql.quickCheck = 'ok';
    await expect(assertDatabaseHealthy(sql)).resolves.toBeUndefined();
  });

  it('reports a damaged database with a message the user can act on', async () => {
    const sql = new FakeSql();
    sql.quickCheck = 'database disk image is malformed';

    const error = await assertDatabaseHealthy(sql).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DatabaseCorruptError);
    expect((error as Error).message).toMatch(/damaged/i);
    expect((error as Error).message).toMatch(/not been deleted/i);
  });

  it('reports a database that cannot even be checked', async () => {
    const sql = new FakeSql();
    sql.selectError = new Error('file is not a database');

    const error = await assertDatabaseHealthy(sql).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DatabaseCorruptError);
  });

  it('reports a database whose integrity check returns no row', async () => {
    const sql = new FakeSql();
    sql.quickCheck = null;

    const error = await assertDatabaseHealthy(sql).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DatabaseCorruptError);
  });
});

describe('readSchemaVersion', () => {
  it('is 0 for a database where no migration has run', async () => {
    const sql = new FakeSql();
    expect(await readSchemaVersion(sql)).toBe(0);
  });

  it('is the highest recorded version', async () => {
    const sql = new FakeSql();
    sql.appliedVersions = [1, 2];
    expect(await readSchemaVersion(sql)).toBe(2);
  });

  it('is a DatabaseError when the database cannot be read', async () => {
    const sql = new FakeSql();
    sql.selectError = new Error('file is not a database');

    const error = await readSchemaVersion(sql).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DatabaseError);
  });
});
