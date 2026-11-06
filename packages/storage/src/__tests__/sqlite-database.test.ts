/**
 * The SQLite implementation of the port — Phase D / D1.
 *
 * ## What this test does and does not prove
 *
 * The Tauri SQL plugin runs the statements against a real SQLite file
 * inside the desktop app. A unit test in this repository cannot open
 * that file: there is no SQLite driver in the workspace, and adding one
 * would change `pnpm-lock.yaml`, which CI installs with
 * `--frozen-lockfile`.
 *
 * So this test pins the **SQL contract** instead:
 *
 *   - which statement is issued for which port call,
 *   - in which order,
 *   - with which bound parameters.
 *
 * That is the part that can silently go wrong — a wrong column name, a
 * swapped parameter, a write that happens in the wrong order — and it
 * is exactly the part a hand-written statement is prone to. The
 * *semantics* of the port are pinned by `database.test.ts`, which runs
 * against the reference implementation.
 *
 * The statement text itself is executed by a real SQLite only in the
 * packaged app. That gap is recorded in
 * `docs/REMEDIATION_TEST_REPORT.md`.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_SOCIAL_BOUNDARIES,
  PROTOCOL_VERSION,
} from '@kindora/protocol';

import { SqliteKindoraDatabase } from '../sqlite-database';
import type { SqlRow } from '../sql-executor';
import type { StoredAgent } from '../profile-store';
import { RecordingSql } from './helpers/recording-sql';

const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const PEER_ID = '11111111-2222-4333-8444-aaaaaaaaaaaa';

/* ------------------------------------------------------------------ */
/* A recording executor                                                */
/* ------------------------------------------------------------------ */

/**
 * `RecordingSql` — see `helpers/recording-sql.ts`.
 *
 * It is not a SQLite: it does not parse or evaluate SQL. It only
 * remembers what was asked and hands back the rows a test prepared.
 */

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
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
      currentActivities: ['reading'],
      socialIntent: ['similar_interests'],
      conversationStyle: ['technical'],
      boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
    },
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function agentRow(overrides: Record<string, unknown> = {}): SqlRow {
  return {
    agent_id: AGENT_ID,
    display_name: 'Jason',
    public_key: 'PUB',
    protocol_version: PROTOCOL_VERSION,
    capabilities_json: JSON.stringify(DEFAULT_AGENT_CAPABILITIES),
    private_key_storage_json: JSON.stringify({ kind: 'keychain', keyId: 'key-id-123' }),
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    nickname: 'Jason',
    avatar: null,
    bio: 'Software engineer.',
    interests_json: JSON.stringify(['AI']),
    current_activities_json: JSON.stringify(['reading']),
    social_intent_json: JSON.stringify(['similar_interests']),
    conversation_style_json: JSON.stringify(['technical']),
    boundaries_json: JSON.stringify(DEFAULT_SOCIAL_BOUNDARIES),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* The tests                                                           */
/* ------------------------------------------------------------------ */

describe('SqliteKindoraDatabase — the local agent', () => {
  it('writes the profile before the agent row', async () => {
    // The agent row is the commit point: if the app dies in between,
    // the old agent still has its old profile.
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.saveAgent(makeAgent());

    expect(sql.executed[0]).toMatch(/INSERT OR REPLACE INTO profiles/i);
    expect(sql.executed[1]).toMatch(/INSERT OR REPLACE INTO agents/i);
  });

  it('never binds the private key', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.saveAgent(makeAgent({ privateKey: 'PRIVATE-SECRET' }));

    const bound = sql.calls.flatMap((c) => c.params);
    expect(bound).not.toContain('PRIVATE-SECRET');
    expect(bound.some((p) => typeof p === 'string' && p.includes('PRIVATE-SECRET'))).toBe(false);
    // The *reference* to the keychain entry is stored — only the key
    // material is not.
    expect(bound).toContain(JSON.stringify({ kind: 'keychain', keyId: 'key-id-123' }));
  });

  it('binds the profile columns in the order the statement declares them', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.saveAgent(makeAgent());

    expect(sql.paramsOf(0)).toEqual([
      AGENT_ID,
      'Jason',
      null,
      'Software engineer.',
      JSON.stringify(['AI']),
      JSON.stringify(['reading']),
      JSON.stringify(['similar_interests']),
      JSON.stringify(['technical']),
      JSON.stringify(DEFAULT_SOCIAL_BOUNDARIES),
      '2026-01-02T00:00:00.000Z',
    ]);
  });

  it('binds the agent columns in the order the statement declares them', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.saveAgent(makeAgent());

    expect(sql.paramsOf(1)).toEqual([
      AGENT_ID,
      'Jason',
      'PUB',
      PROTOCOL_VERSION,
      JSON.stringify(DEFAULT_AGENT_CAPABILITIES),
      JSON.stringify({ kind: 'keychain', keyId: 'key-id-123' }),
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    ]);
  });

  it('marks the local agent with the is_local flag', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.saveAgent(makeAgent());

    // The flag is a literal in the statement, not a bound parameter —
    // so the value list has eight placeholders and a literal 1.
    expect(sql.executed[1]).toMatch(/VALUES \(\?, \?, \?, \?, \?, \?, 1, \?, \?\)/i);
    expect(sql.paramsOf(1)).toHaveLength(8);
  });

  it('deletes a profile whose agent is gone', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.saveAgent(makeAgent());

    expect(sql.executed[2]).toMatch(
      /DELETE FROM profiles WHERE agent_id NOT IN \(SELECT agent_id FROM agents\)/i,
    );
  });

  it('reads the local agent with a LEFT JOIN, so a missing profile cannot hide it', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.getAgent();

    const query = sql.queried[0] ?? '';
    expect(query).toMatch(/FROM agents a/i);
    expect(query).toMatch(/LEFT JOIN profiles p/i);
    expect(query).toMatch(/WHERE a\.is_local = 1/i);
  });

  it('maps a row back to an agent record', async () => {
    const sql = new RecordingSql().respond(/FROM agents a/i, [agentRow()]);
    const db = new SqliteKindoraDatabase(sql, 1);

    const agent = await db.getAgent();
    expect(agent?.agentId).toBe(AGENT_ID);
    expect(agent?.displayName).toBe('Jason');
    expect(agent?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(agent?.profile.nickname).toBe('Jason');
    expect(agent?.profile.interests).toEqual(['AI']);
    expect(agent?.profile.boundaries).toEqual(DEFAULT_SOCIAL_BOUNDARIES);
    expect(agent?.privateKeyStorage).toEqual({ kind: 'keychain', keyId: 'key-id-123' });
    // The row has no private key column, so none can come back.
    expect(agent?.privateKey).toBeUndefined();
  });

  it('returns null when there is no local agent', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);
    expect(await db.getAgent()).toBeNull();
  });

  it('deletes the profile and the agent', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.deleteAgent();

    expect(sql.executed[0]).toMatch(/DELETE FROM profiles/i);
    expect(sql.executed[1]).toMatch(/DELETE FROM agents/i);
  });
});

describe('SqliteKindoraDatabase — settings', () => {
  it('reads a setting back as JSON', async () => {
    const sql = new RecordingSql().respond(/FROM settings/i, [{ value: '"zh"' }]);
    const db = new SqliteKindoraDatabase(sql, 1);
    expect(await db.getSetting<string>('uiLocale')).toBe('zh');
  });

  it('treats a value that is not valid JSON as "not set"', async () => {
    const sql = new RecordingSql().respond(/FROM settings/i, [{ value: '{not json' }]);
    const db = new SqliteKindoraDatabase(sql, 1);
    expect(await db.getSetting('uiLocale')).toBeNull();
  });

  it('stores a setting as JSON text', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.setSetting('uiLocale', 'zh');

    expect(sql.executed[0]).toMatch(/INSERT OR REPLACE INTO settings/i);
    expect(sql.paramsOf(0)[0]).toBe('uiLocale');
    expect(sql.paramsOf(0)[1]).toBe('"zh"');
  });

  it('deletes a setting by key', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.deleteSetting('uiLocale');

    expect(sql.executed[0]).toMatch(/DELETE FROM settings WHERE key = \?/i);
    expect(sql.paramsOf(0)).toEqual(['uiLocale']);
  });
});

describe('SqliteKindoraDatabase — the block list', () => {
  it('orders the list by blocked_at, newest first', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.listBlockedAgents();

    expect(sql.queried[0]).toMatch(/ORDER BY blocked_at DESC/i);
  });

  it('drops a row whose agent id is not a UUID', async () => {
    const sql = new RecordingSql().respond(/FROM blocked_agents/i, [
      { agent_id: 'not-a-uuid', blocked_at: '2026-01-01T00:00:00.000Z', reason: null },
      {
        agent_id: PEER_ID,
        blocked_at: '2026-01-02T00:00:00.000Z',
        reason: 'spam',
      },
    ]);
    const db = new SqliteKindoraDatabase(sql, 1);

    const list = await db.listBlockedAgents();
    expect(list).toHaveLength(1);
    expect(list[0]?.agentId).toBe(PEER_ID);
    expect(list[0]?.reason).toBe('spam');
  });

  it('refuses to store an agent id that is not a UUID', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await expect(db.addBlockedAgent('not-a-uuid')).rejects.toThrow(/invalid agent id/i);
    expect(sql.executed).toHaveLength(0);
  });

  it('stores a blocked agent with its reason', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.addBlockedAgent(PEER_ID, 'spam');

    expect(sql.executed[0]).toMatch(/INSERT OR REPLACE INTO blocked_agents/i);
    expect(sql.paramsOf(0)[0]).toBe(PEER_ID);
    expect(sql.paramsOf(0)[2]).toBe('spam');
  });

  it('removes and clears the block list', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.removeBlockedAgent(PEER_ID);
    await db.clearBlockedAgents();

    expect(sql.executed[0]).toMatch(/DELETE FROM blocked_agents WHERE agent_id = \?/i);
    expect(sql.executed[1]).toMatch(/DELETE FROM blocked_agents\s*$/i);
  });
});

describe('SqliteKindoraDatabase — sessions', () => {
  it('upserts a session with all six columns', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.upsertSession({
      sessionId: 'session-1',
      peerAgentId: PEER_ID,
      peerDisplayName: 'Bob',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      closeReason: null,
    });

    expect(sql.executed[0]).toMatch(/INSERT OR REPLACE INTO sessions/i);
    expect(sql.paramsOf(0)).toEqual([
      'session-1',
      PEER_ID,
      'Bob',
      '2026-01-01T00:00:00.000Z',
      null,
      null,
    ]);
  });

  it('orders the sessions by started_at, newest first', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.listSessions();

    expect(sql.queried[0]).toMatch(/ORDER BY started_at DESC/i);
  });

  it('asks for a single session by its id', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.getSession('session-1');

    expect(sql.queried[0]).toMatch(/FROM sessions WHERE session_id = \?/i);
    expect(sql.calls[0]?.params).toEqual(['session-1']);
  });

  it('takes the newest session with LIMIT 1', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.latestSession();

    expect(sql.queried[0]).toMatch(/ORDER BY started_at DESC LIMIT 1/i);
  });
});

describe('SqliteKindoraDatabase — messages', () => {
  const message = {
    messageId: 'msg-1',
    sessionId: 'session-1',
    seq: 0,
    senderAgentId: AGENT_ID,
    direction: 'sent' as const,
    source: 'human' as const,
    text: 'hello',
    status: 'PENDING' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    failureReason: null,
  };

  it('stores a message with INSERT OR IGNORE, so a duplicate id is skipped', async () => {
    const sql = new RecordingSql()
      .respond(/COALESCE\(MAX\(seq\)/i, [{ max_seq: 0 }])
      .respond(/FROM messages WHERE message_id = \?/i, [
        {
          message_id: 'msg-1',
          session_id: 'session-1',
          seq: 1,
          sender_agent_id: AGENT_ID,
          direction: 'sent',
          source: 'human',
          text: 'hello',
          status: 'PENDING',
          created_at: '2026-01-01T00:00:00.000Z',
          sent_at: null,
          delivered_at: null,
          failed_at: null,
          failure_reason: null,
        },
      ]);
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.appendMessage(message);

    expect(sql.executed[0]).toMatch(/INSERT OR IGNORE INTO messages/i);
  });

  it('assigns the next sequence number of the session', async () => {
    const sql = new RecordingSql()
      .respond(/COALESCE\(MAX\(seq\)/i, [{ max_seq: 4 }])
      .respond(/FROM messages WHERE message_id = \?/i, []);
    const db = new SqliteKindoraDatabase(sql, 1);

    const stored = await db.appendMessage(message);

    expect(sql.queried[0]).toMatch(/SELECT COALESCE\(MAX\(seq\), 0\) AS max_seq FROM messages/i);
    expect(sql.paramsOf(0)[2]).toBe(5);
    expect(stored.seq).toBe(5);
  });

  it('binds every message column in the declared order', async () => {
    const sql = new RecordingSql()
      .respond(/COALESCE\(MAX\(seq\)/i, [{ max_seq: 0 }])
      .respond(/FROM messages WHERE message_id = \?/i, []);
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.appendMessage(message);

    expect(sql.paramsOf(0)).toEqual([
      'msg-1',
      'session-1',
      1,
      AGENT_ID,
      'sent',
      'human',
      'hello',
      'PENDING',
      '2026-01-01T00:00:00.000Z',
      null,
      null,
      null,
      null,
    ]);
  });

  it('writes only the timestamp that belongs to the new state', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.updateMessageStatus('msg-1', 'SENT', { at: '2026-01-01T01:00:00.000Z' });

    // status, sent_at, delivered_at, failed_at, failure_reason, id
    expect(sql.paramsOf(0)).toEqual([
      'SENT',
      '2026-01-01T01:00:00.000Z',
      null,
      null,
      null,
      'msg-1',
    ]);
  });

  it('writes the failure reason only for FAILED', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.updateMessageStatus('msg-1', 'FAILED', {
      at: '2026-01-01T01:00:00.000Z',
      failureReason: 'transport closed',
    });

    expect(sql.paramsOf(0)).toEqual([
      'FAILED',
      null,
      null,
      '2026-01-01T01:00:00.000Z',
      'transport closed',
      'msg-1',
    ]);
  });

  it('uses COALESCE, so an existing timestamp is never overwritten', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.updateMessageStatus('msg-1', 'DELIVERED', { at: '2026-01-01T01:00:00.000Z' });

    const statement = sql.executed[0] ?? '';
    expect(statement).toMatch(/sent_at\s*=\s*COALESCE\(sent_at, \?\)/i);
    expect(statement).toMatch(/delivered_at\s*=\s*COALESCE\(delivered_at, \?\)/i);
    expect(statement).toMatch(/failed_at\s*=\s*COALESCE\(failed_at, \?\)/i);
    expect(statement).toMatch(/failure_reason\s*=\s*COALESCE\(failure_reason, \?\)/i);
  });

  it('reads the messages of a session in order', async () => {
    const sql = new RecordingSql();
    const db = new SqliteKindoraDatabase(sql, 1);

    await db.listMessages('session-1');

    expect(sql.queried[0]).toMatch(/FROM messages WHERE session_id = \? ORDER BY seq ASC/i);
    expect(sql.calls[0]?.params).toEqual(['session-1']);
  });

  it('maps a stored row back to a message', async () => {
    // The row is registered for the query `listMessages` actually
    // issues — a fixture registered for the wrong statement would
    // answer "no rows" and the assertions below would pass vacuously.
    const sql = new RecordingSql().respond(/FROM messages WHERE session_id = \?/i, [
      {
        message_id: 'msg-1',
        session_id: 'session-1',
        seq: 3,
        sender_agent_id: AGENT_ID,
        direction: 'received',
        source: 'agent',
        text: 'hi',
        status: 'DELIVERED',
        created_at: '2026-01-01T00:00:00.000Z',
        sent_at: null,
        delivered_at: '2026-01-01T00:00:01.000Z',
        failed_at: null,
        failure_reason: null,
      },
    ]);
    const db = new SqliteKindoraDatabase(sql, 1);

    const stored = await db.listMessages('session-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.seq).toBe(3);
    expect(stored[0]?.direction).toBe('received');
    expect(stored[0]?.source).toBe('agent');
    expect(stored[0]?.status).toBe('DELIVERED');
    expect(stored[0]?.deliveredAt).toBe('2026-01-01T00:00:01.000Z');
  });

  it('falls back to a safe status for a row with an unknown state', async () => {
    const sql = new RecordingSql().respond(/FROM messages WHERE session_id = \?/i, [
      {
        message_id: 'msg-1',
        session_id: 'session-1',
        seq: 1,
        sender_agent_id: AGENT_ID,
        direction: 'sent',
        source: 'human',
        text: 'hi',
        status: 'WHATEVER',
        created_at: '2026-01-01T00:00:00.000Z',
        sent_at: null,
        delivered_at: null,
        failed_at: null,
        failure_reason: null,
      },
    ]);
    const db = new SqliteKindoraDatabase(sql, 1);

    const stored = await db.listMessages('session-1');
    expect(stored[0]?.status).toBe('PENDING');
  });
});
