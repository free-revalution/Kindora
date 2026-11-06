/**
 * The Tauri SQL adapter — Phase D / D1.
 *
 * ## Why this calls `invoke` directly
 *
 * The `tauri-plugin-sql` Rust crate is already a dependency of the
 * desktop app, it is already registered in `lib.rs`, and the
 * capability file already grants `sql:allow-load`, `sql:allow-execute`
 * and `sql:allow-select`. The only thing missing is the JavaScript
 * wrapper package.
 *
 * The wrapper is a thin layer over exactly the commands this file
 * calls, and its behaviour is fixed by the Rust crate — which
 * `Cargo.lock` pins to `tauri-plugin-sql 2.5.0`:
 *
 * | command             | arguments              | returns                          |
 * |---------------------|------------------------|----------------------------------|
 * | `plugin:sql\|load`   | `{ db }`               | the connection string             |
 * | `plugin:sql\|execute`| `{ db, query, values }`| `[rowsAffected, lastInsertId]`    |
 * | `plugin:sql\|select` | `{ db, query, values }`| an array of row objects           |
 * | `plugin:sql\|close`  | `{ db }`               | `true`                            |
 *
 * Calling the commands directly means **no new npm dependency**, so
 * `pnpm install --frozen-lockfile` in CI keeps working unchanged and
 * the lockfile does not have to be regenerated. The price is that the
 * contract above has to be kept in step with the Rust crate; the pin
 * in `Cargo.lock` is what makes that checkable.
 *
 * ## Where the database file lives
 *
 * The plugin resolves a `sqlite:` connection string against the app's
 * config directory, so `sqlite:kindora.db` becomes
 * `<app config dir>/kindora.db`. The app never has to know the path.
 */

import type { SqlExecuteResult, SqlExecutor, SqlRow, SqlScalar } from '@kindora/storage';
import { DatabaseError } from '@kindora/storage';

import { getTauriInvoke, type TauriInvoke } from './tauri-runtime';

/** The connection string of the local business database. */
export const KINDORA_DB_URL = 'sqlite:kindora.db';

/**
 * The SQL executor backed by the Tauri SQL plugin.
 *
 * Every failure is turned into a {@link DatabaseError} whose message a
 * human can act on — the plugin's own error is a Rust `Display`
 * string, which is not something to put in front of a user.
 */
export class TauriSqlExecutor implements SqlExecutor {
  constructor(
    private readonly tauri: TauriInvoke,
    private readonly db: string = KINDORA_DB_URL,
  ) {}

  /**
   * Open the database.
   *
   * The plugin creates the file if it does not exist yet and keeps the
   * connection pool. Calling it twice with the same URL is harmless.
   */
  async load(): Promise<void> {
    try {
      await this.tauri.invoke('plugin:sql|load', { db: this.db });
    } catch (err) {
      throw new DatabaseError(
        'The local database could not be opened. Your data has not been changed.',
        describeInvokeError(err),
      );
    }
  }

  async execute(sql: string, params: readonly SqlScalar[] = []): Promise<SqlExecuteResult> {
    let raw: unknown;
    try {
      raw = await this.tauri.invoke('plugin:sql|execute', {
        db: this.db,
        query: sql,
        values: [...params],
      });
    } catch (err) {
      throw new DatabaseError(
        'A statement against the local database failed.',
        describeInvokeError(err),
      );
    }

    // The Rust command returns the tuple `(u64, LastInsertId)`, which
    // serde serialises as a two-element array.
    if (Array.isArray(raw)) {
      const rowsAffected = typeof raw[0] === 'number' ? raw[0] : 0;
      const lastInsertId = typeof raw[1] === 'number' ? raw[1] : null;
      return { rowsAffected, lastInsertId };
    }
    return { rowsAffected: 0, lastInsertId: null };
  }

  async select(sql: string, params: readonly SqlScalar[] = []): Promise<readonly SqlRow[]> {
    let raw: unknown;
    try {
      raw = await this.tauri.invoke('plugin:sql|select', {
        db: this.db,
        query: sql,
        values: [...params],
      });
    } catch (err) {
      throw new DatabaseError(
        'A query against the local database failed.',
        describeInvokeError(err),
      );
    }
    return Array.isArray(raw) ? (raw as SqlRow[]) : [];
  }
}

/**
 * Turn whatever `invoke` rejected with into a readable string.
 *
 * Tauri rejects with the error's `Display` output, which arrives as a
 * plain string.
 */
function describeInvokeError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Build an executor for the running app, or `null` when there is no
 * Tauri runtime (the browser dev server).
 */
export function createTauriSqlExecutor(): TauriSqlExecutor | null {
  const invoke = getTauriInvoke();
  if (!invoke) return null;
  return new TauriSqlExecutor(invoke);
}
