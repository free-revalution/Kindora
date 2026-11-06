/**
 * The SQL port — Phase D / D1.
 *
 * ## Why a port and not a driver
 *
 * The desktop app talks to SQLite through the `tauri-plugin-sql` plugin,
 * which exposes exactly two operations: run a statement, run a query.
 * This file models those two operations as an interface so that:
 *
 *   - the schema, the migrations and the repositories can be unit-tested
 *     without a Tauri runtime and without a real database file;
 *   - the storage package does **not** depend on `@tauri-apps/plugin-sql`
 *     (or on any other npm package) — the Tauri-specific adapter lives
 *     in `apps/desktop/src/lib/tauri-sql-executor.ts` and is injected.
 *
 * ## The parameter rules
 *
 * The plugin binds the values positionally and has no notion of a
 * boolean, so this port is deliberately narrow:
 *
 *   - `?` placeholders only, in binding order (no `$1`, no `:name`);
 *   - `SqlScalar` is `string | number | null` — **no booleans**. A
 *     boolean is stored as `0` / `1`; use {@link boolToSql}.
 *   - `null` binds SQL `NULL`.
 *
 * A number is bound as a float by the plugin, but SQLite's column
 * affinity converts it back to an integer when the column is declared
 * `INTEGER`, so `version INTEGER PRIMARY KEY` really does hold an
 * integer.
 */

/** A value that can be bound to a `?` placeholder. */
export type SqlScalar = string | number | null;

/** One row of a query result. The plugin returns plain JSON objects. */
export type SqlRow = Record<string, unknown>;

/** The result of a statement that does not return rows. */
export interface SqlExecuteResult {
  /** How many rows the statement touched. */
  readonly rowsAffected: number;
  /** The rowid of the row the statement inserted, when it inserted one. */
  readonly lastInsertId: number | null;
}

/**
 * The two operations the persistence layer needs.
 *
 * Implementations must be safe to call concurrently; see
 * {@link SerialExecutor} for the wrapper that guarantees it.
 */
export interface SqlExecutor {
  /** Run a statement that does not return rows. */
  execute(sql: string, params?: readonly SqlScalar[]): Promise<SqlExecuteResult>;
  /** Run a query and return its rows. */
  select(sql: string, params?: readonly SqlScalar[]): Promise<readonly SqlRow[]>;
}

/**
 * SQLite has no boolean type. Booleans are stored as `0` / `1`.
 *
 * The helper exists so that the conversion is visible at every call
 * site instead of being implied by a bare `1`.
 */
export function boolToSql(value: boolean): number {
  return value ? 1 : 0;
}

/** Read a `0` / `1` column back as a boolean. */
export function sqlToBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

/** Read a TEXT column back as a string, or `null` when it is NULL. */
export function sqlToString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** Read a TEXT column back as a string, falling back to `fallback`. */
export function sqlToText(value: unknown, fallback = ''): string {
  return sqlToString(value) ?? fallback;
}

/** Read an INTEGER column back as a number, or `null` when it is NULL. */
export function sqlToNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Serialises every call to the wrapped executor.
 *
 * ## Why this exists
 *
 * The Tauri SQL plugin hands out connections from a **pool**, so two
 * statements issued back to back may run on two different connections.
 * That has two consequences the persistence layer has to live with:
 *
 *   1. **`BEGIN` / `COMMIT` are not usable.** A transaction started on
 *      one connection is not the transaction a later `COMMIT` on another
 *      connection ends. The plugin's JavaScript API does not expose
 *      transactions either. Every write in this package is therefore a
 *      *single* statement, and every migration is written so that
 *      re-running it is harmless.
 *   2. **Two concurrent writers can collide** and get `SQLITE_BUSY`.
 *
 * This wrapper removes both problems for the persistence layer: calls
 * run one at a time, in order, so a write is never interrupted by
 * another write and a read never observes a half-applied migration.
 *
 * It is deliberately simple — a promise chain, not a lock — so that it
 * can be unit-tested without any timing assumptions.
 */
export class SerialExecutor implements SqlExecutor {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly inner: SqlExecutor) {}

  execute(sql: string, params?: readonly SqlScalar[]): Promise<SqlExecuteResult> {
    return this.enqueue(() => this.inner.execute(sql, params));
  }

  select(sql: string, params?: readonly SqlScalar[]): Promise<readonly SqlRow[]> {
    return this.enqueue(() => this.inner.select(sql, params));
  }

  /**
   * Queue `fn` behind every call that was already queued.
   *
   * The chain continues even when a previous call rejected — a failed
   * statement must not wedge the database for the rest of the session.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
