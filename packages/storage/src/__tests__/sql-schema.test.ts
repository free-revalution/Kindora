/**
 * The schema and the statements must agree — Phase D / D1.
 *
 * The schema lives in `sql-migrations.ts`; the statements live in
 * `sqlite-database.ts` and `sql-migrator.ts`. They are written by hand
 * and separately, which is exactly the situation where a column name
 * drifts: the DDL says `blocked_at`, the statement says `blockedOn`,
 * and the app only finds out at runtime.
 *
 * This test reads both and checks that **every column a statement
 * references exists in the schema**. It is a static check — it does
 * not run SQLite — but it catches the whole class of typo, which is
 * the class that the packaged app would otherwise hit for the first
 * time on a user's machine.
 *
 * The statements themselves are exercised by SQLite only in the
 * packaged app; that gap is recorded in
 * `docs/REMEDIATION_TEST_REPORT.md`.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_SOCIAL_BOUNDARIES,
  PROTOCOL_VERSION,
} from '@kindora/protocol';

import { SqliteKindoraDatabase } from '../sqlite-database';
import { runMigrations } from '../sql-migrator';
import { CREATE_SCHEMA_MIGRATIONS_TABLE, MIGRATIONS } from '../sql-migrations';
import type { StoredAgent } from '../profile-store';
import { RecordingSql } from './helpers/recording-sql';

const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const PEER_ID = '11111111-2222-4333-8444-aaaaaaaaaaaa';

/* ------------------------------------------------------------------ */
/* The schema                                                          */
/* ------------------------------------------------------------------ */

/** Words that are part of the SQL language, not column names. */
const SQL_WORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'ORDER',
  'BY',
  'GROUP',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'AS',
  'ON',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'CROSS',
  'NATURAL',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'REPLACE',
  'IGNORE',
  'CREATE',
  'TABLE',
  'IF',
  'EXISTS',
  'INDEX',
  'UNIQUE',
  'PRIMARY',
  'KEY',
  'IS',
  'IN',
  'BETWEEN',
  'LIKE',
  'DISTINCT',
  'ALL',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'ASC',
  'DESC',
  'USING',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'WITH',
  'RECURSIVE',
  'RETURNING',
  'PRAGMA',
  'CHECK',
  'FOREIGN',
  'REFERENCES',
  'CONSTRAINT',
  'DEFAULT',
  'COLLATE',
  'AUTOINCREMENT',
  'WITHOUT',
  'ROWID',
  'TEMP',
  'TEMPORARY',
  'QUICK_CHECK',
]);

/** Function names — they look like column names but are not. */
const SQL_FUNCTIONS = new Set([
  'COALESCE',
  'MAX',
  'MIN',
  'COUNT',
  'SUM',
  'AVG',
  'TOTAL',
  'LENGTH',
  'LOWER',
  'UPPER',
  'IFNULL',
  'NULLIF',
  'ROUND',
  'ABS',
  'DATE',
  'DATETIME',
  'STRFTIME',
  'GROUP_CONCAT',
  'JSON',
  'JSON_EXTRACT',
  'TYPEOF',
  'HEX',
  'QUOTE',
]);

/** The tables of the schema, with their columns. */
function parseSchema(statements: readonly string[]): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const statement of statements) {
    const match = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\)/i.exec(statement);
    if (!match) continue;
    const name = match[1]!;
    const body = match[2]!;
    const columns = new Set<string>();
    for (const part of body.split(',')) {
      const first = part.trim().split(/\s+/)[0];
      if (!first) continue;
      if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(first)) continue;
      columns.add(first);
    }
    tables.set(name, columns);
  }
  return tables;
}

/** The tables a statement touches, and the alias → table map. */
function tablesOf(sql: string): {
  tables: string[];
  aliases: Map<string, string>;
} {
  const tables: string[] = [];
  const aliases = new Map<string, string>();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const table = match[1]!;
    const maybeAlias = match[2];
    tables.push(table);
    if (maybeAlias && !SQL_WORDS.has(maybeAlias.toUpperCase())) {
      aliases.set(maybeAlias.toLowerCase(), table.toLowerCase());
    }
  }
  return { tables, aliases };
}

/**
 * The column references of a statement that the schema does not know.
 *
 * A statement is checked against the tables it touches: a qualified
 * reference (`a.agent_id`) against the table its alias stands for, and
 * a bare reference against the tables the statement reads or writes.
 */
function unknownColumns(sql: string, schema: Map<string, Set<string>>): string[] {
  const problems: string[] = [];
  const { tables, aliases } = tablesOf(sql);
  const tableNames = new Set(tables.map((t) => t.toLowerCase()));

  const known = (column: string): boolean =>
    tables.some((t) => schema.get(t.toLowerCase())?.has(column) === true);

  // 1. Qualified references — `a.agent_id`.
  const withoutQualified = sql.replace(
    /\b(\w+)\.(\w+)\b/g,
    (_match, qualifier: string, column: string) => {
      const table = aliases.get(qualifier.toLowerCase());
      if (!table) return _match;
      const columns = schema.get(table);
      if (!columns) {
        problems.push(`${table}.${column}: the table is not in the schema`);
      } else if (!columns.has(column)) {
        problems.push(`${table}.${column}: the table has no such column`);
      }
      return ' ';
    },
  );

  // 2. Bare references — `agent_id`.
  const bare = withoutQualified.replace(/\s+AS\s+\w+/gi, ' ');
  for (const match of bare.matchAll(/\b(\w+)\b/g)) {
    const word = match[1]!;
    if (/^\d+$/.test(word)) continue;
    if (SQL_WORDS.has(word.toUpperCase())) continue;
    if (SQL_FUNCTIONS.has(word.toUpperCase())) continue;
    if (aliases.has(word.toLowerCase())) continue;
    if (tableNames.has(word.toLowerCase())) continue;
    if (!known(word)) {
      problems.push(`${word}: no such column in ${tables.join(', ') || '(no table)'}`);
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* The statements                                                      */
/* ------------------------------------------------------------------ */

function makeAgent(): StoredAgent {
  return {
    agentId: AGENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    displayName: 'Jason',
    publicKey: 'PUB',
    privateKey: 'PRIVATE-SECRET',
    privateKeyStorage: { kind: 'keychain', keyId: 'key-id-123' },
    profile: {
      nickname: 'Jason',
      bio: 'Software engineer.',
      interests: ['AI'],
      currentActivities: [],
      socialIntent: ['similar_interests'],
      conversationStyle: ['technical'],
      boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
    },
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Every statement the persistence layer issues, collected by running
 * the whole port against a recording executor.
 */
async function collectStatements(): Promise<string[]> {
  const sql = new RecordingSql();
  const db = new SqliteKindoraDatabase(sql, 1);

  await db.saveAgent(makeAgent());
  await db.getAgent();
  await db.deleteAgent();
  await db.getSetting('uiLocale');
  await db.setSetting('uiLocale', 'zh');
  await db.deleteSetting('uiLocale');
  await db.listBlockedAgents();
  await db.isAgentBlocked(PEER_ID);
  await db.addBlockedAgent(PEER_ID, 'spam');
  await db.removeBlockedAgent(PEER_ID);
  await db.clearBlockedAgents();
  await db.upsertSession({
    sessionId: 'session-1',
    peerAgentId: PEER_ID,
    peerDisplayName: 'Bob',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    closeReason: null,
  });
  await db.getSession('session-1');
  await db.listSessions();
  await db.latestSession();
  await db.appendMessage({
    messageId: 'msg-1',
    sessionId: 'session-1',
    seq: 0,
    senderAgentId: AGENT_ID,
    direction: 'sent',
    source: 'human',
    text: 'hello',
    status: 'PENDING',
    createdAt: '2026-01-01T00:00:00.000Z',
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    failureReason: null,
  });
  await db.updateMessageStatus('msg-1', 'SENT', { at: '2026-01-01T01:00:00.000Z' });
  await db.listMessages('session-1');

  // The migration runner has its own statements.
  const migratorSql = new RecordingSql();
  await runMigrations(migratorSql);

  return [...sql.calls.map((c) => c.sql), ...migratorSql.calls.map((c) => c.sql)];
}

/** The statements that read or write rows. */
function isDataStatement(sql: string): boolean {
  return /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql);
}

describe('the schema and the statements agree', () => {
  it('parses every table of the schema', () => {
    const schema = parseSchema([
      CREATE_SCHEMA_MIGRATIONS_TABLE,
      ...MIGRATIONS.flatMap((m) => m.statements),
    ]);

    expect([...schema.keys()].sort()).toEqual([
      'agents',
      'blocked_agents',
      'messages',
      'profiles',
      'schema_migrations',
      'sessions',
      'settings',
    ]);
  });

  it('declares the columns the app relies on', () => {
    const schema = parseSchema([
      CREATE_SCHEMA_MIGRATIONS_TABLE,
      ...MIGRATIONS.flatMap((m) => m.statements),
    ]);

    expect(schema.get('agents')?.has('agent_id')).toBe(true);
    expect(schema.get('agents')?.has('is_local')).toBe(true);
    expect(schema.get('profiles')?.has('boundaries_json')).toBe(true);
    expect(schema.get('settings')?.has('key')).toBe(true);
    expect(schema.get('blocked_agents')?.has('blocked_at')).toBe(true);
    expect(schema.get('sessions')?.has('session_id')).toBe(true);
    expect(schema.get('messages')?.has('message_id')).toBe(true);
    expect(schema.get('messages')?.has('seq')).toBe(true);
    expect(schema.get('messages')?.has('failure_reason')).toBe(true);
  });

  it('never references a column the schema does not have', async () => {
    const schema = parseSchema([
      CREATE_SCHEMA_MIGRATIONS_TABLE,
      ...MIGRATIONS.flatMap((m) => m.statements),
    ]);
    const statements = (await collectStatements()).filter(isDataStatement);

    expect(statements.length).toBeGreaterThan(10);

    const problems: string[] = [];
    for (const statement of statements) {
      for (const problem of unknownColumns(statement, schema)) {
        problems.push(`${problem}\n--- in: ${statement.replace(/\s+/g, ' ').trim()}`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('writes the local agent with a flag the schema understands', async () => {
    const schema = parseSchema([
      CREATE_SCHEMA_MIGRATIONS_TABLE,
      ...MIGRATIONS.flatMap((m) => m.statements),
    ]);
    const statements = (await collectStatements()).filter(isDataStatement);

    const insert = statements.find((s) => /INSERT OR REPLACE INTO agents/i.test(s));
    expect(insert).toBeDefined();
    expect(unknownColumns(insert as string, schema)).toEqual([]);
  });
});
