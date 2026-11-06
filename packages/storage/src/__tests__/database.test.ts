/**
 * The persistence port — Phase D / D1.
 *
 * These tests pin the **semantics** of the port. They run against
 * `InMemoryKindoraDatabase`, which is the reference implementation of
 * those semantics; `SqliteKindoraDatabase` has to behave the same way
 * (see `sqlite-database.test.ts` for the SQL side of that contract).
 *
 * The behaviours pinned here are the ones the task book asks for:
 *
 *   - the agent, its settings and its block list survive a restart
 *     (D1 requirement 6 — 「核心业务数据不再依赖浏览器 localStorage」);
 *   - a private key never reaches the database (D1 requirement 7);
 *   - a message is stored once and gets a per-session sequence number
 *     (D2 requirement 7);
 *   - a message cannot claim to be delivered without a `delivered_at`
 *     (D2 requirement 9).
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_SOCIAL_BOUNDARIES,
  PROTOCOL_VERSION,
} from '@kindora/protocol';

import { InMemoryKindoraDatabase } from '../memory-database';
import type { StoredChatMessage } from '../database';
import type { StoredAgent } from '../profile-store';

const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_AGENT_ID = '00000000-0000-4000-8000-000000000002';
const PEER_ID = '11111111-2222-4333-8444-aaaaaaaaaaaa';

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

function makeMessage(overrides: Partial<StoredChatMessage> = {}): StoredChatMessage {
  return {
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
    ...overrides,
  };
}

describe('KindoraDatabase — the local agent', () => {
  it('returns null when no agent was ever saved', async () => {
    const db = new InMemoryKindoraDatabase();
    expect(await db.getAgent()).toBeNull();
  });

  it('round-trips the agent and its profile', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.saveAgent(makeAgent());

    const loaded = await db.getAgent();
    expect(loaded?.agentId).toBe(AGENT_ID);
    expect(loaded?.displayName).toBe('Jason');
    expect(loaded?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(loaded?.publicKey).toBe('PUB');
    expect(loaded?.profile.nickname).toBe('Jason');
    expect(loaded?.profile.interests).toEqual(['AI']);
    expect(loaded?.profile.boundaries).toEqual(DEFAULT_SOCIAL_BOUNDARIES);
  });

  it('never stores the private key (D1 requirement 7)', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.saveAgent(makeAgent({ privateKey: 'PRIVATE-SECRET' }));

    const loaded = await db.getAgent();
    expect(loaded?.privateKey).toBeUndefined();
    expect(JSON.stringify(loaded)).not.toContain('PRIVATE-SECRET');
    // The *location* of the key is kept — only the key material is not.
    expect(loaded?.privateKeyStorage).toEqual({ kind: 'keychain', keyId: 'key-id-123' });
  });

  it('keeps at most one local agent — saving again replaces the first', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.saveAgent(makeAgent());
    await db.saveAgent(makeAgent({ agentId: OTHER_AGENT_ID, displayName: 'Alex' }));

    const loaded = await db.getAgent();
    expect(loaded?.agentId).toBe(OTHER_AGENT_ID);
    expect(loaded?.displayName).toBe('Alex');
  });

  it('deleteAgent removes the agent', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.saveAgent(makeAgent());
    await db.deleteAgent();
    expect(await db.getAgent()).toBeNull();
  });
});

describe('KindoraDatabase — settings', () => {
  it('round-trips a setting', async () => {
    const db = new InMemoryKindoraDatabase();
    expect(await db.getSetting<string>('uiLocale')).toBeNull();

    await db.setSetting('uiLocale', 'zh');
    expect(await db.getSetting<string>('uiLocale')).toBe('zh');
  });

  it('stores a structured value', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.setSetting('model', { id: 'MiniMax-M3', temperature: 0.4 });
    expect(await db.getSetting<{ id: string; temperature: number }>('model')).toEqual({
      id: 'MiniMax-M3',
      temperature: 0.4,
    });
  });

  it('deleteSetting removes the value', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.setSetting('uiLocale', 'zh');
    await db.deleteSetting('uiLocale');
    expect(await db.getSetting('uiLocale')).toBeNull();
  });

  it('treats a value that cannot be serialised as "not set" instead of crashing', async () => {
    const db = new InMemoryKindoraDatabase();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await db.setSetting('broken', circular);
    expect(await db.getSetting('broken')).toBeNull();
  });
});

describe('KindoraDatabase — the block list', () => {
  it('adds, finds, lists and removes a blocked agent', async () => {
    const db = new InMemoryKindoraDatabase();
    expect(await db.isAgentBlocked(PEER_ID)).toBe(false);

    await db.addBlockedAgent(PEER_ID, 'spam');
    expect(await db.isAgentBlocked(PEER_ID)).toBe(true);

    const list = await db.listBlockedAgents();
    expect(list).toHaveLength(1);
    expect(list[0]?.agentId).toBe(PEER_ID);
    expect(list[0]?.reason).toBe('spam');

    await db.removeBlockedAgent(PEER_ID);
    expect(await db.isAgentBlocked(PEER_ID)).toBe(false);
    expect(await db.listBlockedAgents()).toEqual([]);
  });

  it('refuses an agent id that is not a UUID', async () => {
    const db = new InMemoryKindoraDatabase();
    await expect(db.addBlockedAgent('not-a-uuid')).rejects.toThrow(/invalid agent id/i);
    expect(await db.listBlockedAgents()).toEqual([]);
  });

  it('orders the list by blockedAt, newest first', async () => {
    const db = new InMemoryKindoraDatabase();
    const older = '11111111-2222-4333-8444-aaaaaaaaaaaa';
    const newer = '22222222-3333-4444-8555-bbbbbbbbbbbb';

    await db.addBlockedAgent(older);
    // Timers never fire early, so the clock has moved on by the time
    // the second entry is written.
    await new Promise((r) => setTimeout(r, 5));
    await db.addBlockedAgent(newer);

    const list = await db.listBlockedAgents();
    expect(list.map((e) => e.agentId)).toEqual([newer, older]);
  });

  it('clear() empties the whole list', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.addBlockedAgent(PEER_ID);
    await db.addBlockedAgent('22222222-3333-4444-8555-bbbbbbbbbbbb');
    await db.clearBlockedAgents();
    expect(await db.listBlockedAgents()).toEqual([]);
  });
});

describe('KindoraDatabase — sessions', () => {
  const session = {
    sessionId: 'session-1',
    peerAgentId: PEER_ID,
    peerDisplayName: 'Bob',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    closeReason: null,
  };

  it('upserts and reads a session', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.upsertSession(session);

    const loaded = await db.getSession('session-1');
    expect(loaded?.peerAgentId).toBe(PEER_ID);
    expect(loaded?.peerDisplayName).toBe('Bob');
    expect(loaded?.endedAt).toBeNull();
    expect(await db.getSession('nope')).toBeNull();
  });

  it('lists the sessions newest first and reports the latest one', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.upsertSession(session);
    await db.upsertSession({
      ...session,
      sessionId: 'session-2',
      startedAt: '2026-02-01T00:00:00.000Z',
    });

    const list = await db.listSessions();
    expect(list.map((s) => s.sessionId)).toEqual(['session-2', 'session-1']);
    expect((await db.latestSession())?.sessionId).toBe('session-2');
  });

  it('reports no session when there is none', async () => {
    const db = new InMemoryKindoraDatabase();
    expect(await db.latestSession()).toBeNull();
  });
});

describe('KindoraDatabase — messages', () => {
  it('assigns sequence numbers per session, starting at 1', async () => {
    const db = new InMemoryKindoraDatabase();
    const first = await db.appendMessage(makeMessage({ messageId: 'm1' }));
    const second = await db.appendMessage(makeMessage({ messageId: 'm2' }));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('is idempotent on the message id — the same message is stored once', async () => {
    const db = new InMemoryKindoraDatabase();
    const first = await db.appendMessage(makeMessage({ messageId: 'm1' }));
    const again = await db.appendMessage(makeMessage({ messageId: 'm1', text: 'changed' }));

    expect(again.text).toBe('hello');
    expect(again.seq).toBe(first.seq);

    const messages = await db.listMessages('session-1');
    expect(messages).toHaveLength(1);
  });

  it('does not burn a sequence number on a duplicate', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.appendMessage(makeMessage({ messageId: 'm1' }));
    await db.appendMessage(makeMessage({ messageId: 'm1' }));
    const third = await db.appendMessage(makeMessage({ messageId: 'm3' }));
    expect(third.seq).toBe(2);
  });

  it('keeps a separate sequence counter per session', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.appendMessage(makeMessage({ messageId: 'm1' }));
    const other = await db.appendMessage(makeMessage({ messageId: 'm2', sessionId: 'session-2' }));
    expect(other.seq).toBe(1);
  });

  it('lists the messages of one session in order', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.appendMessage(makeMessage({ messageId: 'm1', text: 'first' }));
    await db.appendMessage(makeMessage({ messageId: 'm2', text: 'second' }));
    await db.appendMessage(
      makeMessage({ messageId: 'm3', text: 'other session', sessionId: 's2' }),
    );

    const messages = await db.listMessages('session-1');
    expect(messages.map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('marks a message as sent and writes only the sent timestamp', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.appendMessage(makeMessage());
    await db.updateMessageStatus('msg-1', 'SENT', { at: '2026-01-01T01:00:00.000Z' });

    const [message] = await db.listMessages('session-1');
    expect(message?.status).toBe('SENT');
    expect(message?.sentAt).toBe('2026-01-01T01:00:00.000Z');
    expect(message?.deliveredAt).toBeNull();
    expect(message?.failedAt).toBeNull();
  });

  it('marks a message as failed and keeps the reason', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.appendMessage(makeMessage());
    await db.updateMessageStatus('msg-1', 'FAILED', {
      at: '2026-01-01T01:00:00.000Z',
      failureReason: 'transport closed',
    });

    const [message] = await db.listMessages('session-1');
    expect(message?.status).toBe('FAILED');
    expect(message?.failedAt).toBe('2026-01-01T01:00:00.000Z');
    expect(message?.failureReason).toBe('transport closed');
    expect(message?.sentAt).toBeNull();
  });

  it('marks a message as delivered and writes the delivered timestamp', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.appendMessage(makeMessage({ direction: 'received' }));
    await db.updateMessageStatus('msg-1', 'DELIVERED', { at: '2026-01-01T01:00:00.000Z' });

    const [message] = await db.listMessages('session-1');
    expect(message?.status).toBe('DELIVERED');
    expect(message?.deliveredAt).toBe('2026-01-01T01:00:00.000Z');
    expect(message?.sentAt).toBeNull();
  });

  it('never overwrites a timestamp that is already set', async () => {
    const db = new InMemoryKindoraDatabase();
    await db.appendMessage(makeMessage());
    await db.updateMessageStatus('msg-1', 'SENT', { at: '2026-01-01T01:00:00.000Z' });
    await db.updateMessageStatus('msg-1', 'SENT', { at: '2026-01-02T01:00:00.000Z' });

    const [message] = await db.listMessages('session-1');
    expect(message?.sentAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('ignores a status update for a message that is not stored', async () => {
    const db = new InMemoryKindoraDatabase();
    await expect(db.updateMessageStatus('nope', 'SENT')).resolves.toBeUndefined();
  });
});
