/**
 * A recording SQL executor for the storage tests.
 *
 * It is **not** a SQLite: it does not parse or evaluate SQL. It
 * remembers what it was asked to do and hands back the rows a test
 * prepared. That is enough to pin the *statement contract* — which
 * statement is issued, in which order, with which parameters — while
 * the *semantics* are pinned against the in-memory implementation.
 */

import type { SqlExecuteResult, SqlExecutor, SqlRow, SqlScalar } from '../../sql-executor';

export interface RecordedCall {
  readonly kind: 'execute' | 'select';
  readonly sql: string;
  readonly params: readonly SqlScalar[];
}

export class RecordingSql implements SqlExecutor {
  readonly calls: RecordedCall[] = [];
  private readonly responses: { match: RegExp; rows: readonly SqlRow[] }[] = [];

  /** Answer every query whose text matches `match` with `rows`. */
  respond(match: RegExp, rows: readonly SqlRow[]): this {
    this.responses.push({ match, rows });
    return this;
  }

  async execute(sql: string, params?: readonly SqlScalar[]): Promise<SqlExecuteResult> {
    this.calls.push({ kind: 'execute', sql, params: params ?? [] });
    return { rowsAffected: 1, lastInsertId: null };
  }

  async select(sql: string, params?: readonly SqlScalar[]): Promise<readonly SqlRow[]> {
    this.calls.push({ kind: 'select', sql, params: params ?? [] });
    const hit = this.responses.find((r) => r.match.test(sql));
    return hit ? hit.rows : [];
  }

  /** The statements that were run, in order. */
  get executed(): readonly string[] {
    return this.calls.filter((c) => c.kind === 'execute').map((c) => c.sql);
  }

  /** The queries that were run, in order. */
  get queried(): readonly string[] {
    return this.calls.filter((c) => c.kind === 'select').map((c) => c.sql);
  }

  /** The parameters of the n-th executed statement (0-based). */
  paramsOf(index: number): readonly SqlScalar[] {
    const executed = this.calls.filter((c) => c.kind === 'execute');
    return executed[index]?.params ?? [];
  }
}
