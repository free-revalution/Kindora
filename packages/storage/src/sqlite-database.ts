/**
 * The SQLite implementation of the persistence port — Phase D / D1.
 *
 * ## How the statements are written
 *
 * Every write is a **single statement**, because the Tauri SQL plugin
 * pools its connections and cannot give us a transaction that spans
 * two statements (see `SerialExecutor`). Single-statement writes are
 * atomic on their own, so the port stays correct without transactions.
 *
 * Two ordering rules follow from that:
 *
 *   - **The profile row is written before the agent row.** The agent
 *     row is the "commit point": if the app dies in between, the old
 *     agent still has its old profile and the app loads a consistent
 *     pair. The other order would leave a brand-new agent with no
 *     profile at all.
 *   - **A profile whose agent no longer exists is deleted** after the
 *     agent row is written, so a changed agent id cannot leave a
 *     dangling row behind.
 *
 * ## The private key
 *
 * `saveAgent` removes `privateKey` from the record before it reaches a
 * statement, whatever the record claims about `privateKeyStorage`.
 * The key belongs in the OS keychain; a database is not a key store.
 */

import {
  DEFAULT_AGENT_CAPABILITIES,
  resolveBoundaries,
  type AgentCapabilities,
  type SocialProfile,
} from '@kindora/protocol';

import { sqlToNumber, sqlToString, sqlToText, type SqlExecutor, type SqlRow } from './sql-executor';
import { isValidBlockedAgentId, type BlockedAgent } from './blocked-agents-store';
import type { PrivateKeyStorage, StoredAgent } from './profile-store';
import type {
  ChatMessageDirection,
  ChatMessageSource,
  ChatMessageStatus,
  KindoraDatabase,
  StoredChatMessage,
  StoredSessionRecord,
} from './database';

const LOCAL_AGENT_FLAG = 1;

export class SqliteKindoraDatabase implements KindoraDatabase {
  readonly schemaVersion: number;

  constructor(
    private readonly exec: SqlExecutor,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  /* ---------------------------------------------------------------- */
  /* The local agent                                                    */
  /* ---------------------------------------------------------------- */

  async getAgent(): Promise<StoredAgent | null> {
    const rows = await this.exec.select(
      `SELECT a.agent_id            AS agent_id,
              a.display_name        AS display_name,
              a.public_key          AS public_key,
              a.protocol_version    AS protocol_version,
              a.capabilities_json   AS capabilities_json,
              a.private_key_storage_json AS private_key_storage_json,
              a.created_at          AS created_at,
              a.updated_at          AS updated_at,
              p.nickname            AS nickname,
              p.avatar              AS avatar,
              p.bio                 AS bio,
              p.interests_json      AS interests_json,
              p.current_activities_json AS current_activities_json,
              p.social_intent_json  AS social_intent_json,
              p.conversation_style_json AS conversation_style_json,
              p.boundaries_json     AS boundaries_json
         FROM agents a
         LEFT JOIN profiles p ON p.agent_id = a.agent_id
        WHERE a.is_local = ${LOCAL_AGENT_FLAG}`,
    );
    const row = rows[0];
    if (!row) return null;
    return rowToAgent(row);
  }

  async saveAgent(agent: StoredAgent): Promise<void> {
    // Defence in depth: the private key is removed here, so no caller
    // can leak it into the database by passing a record that carries
    // one.
    const { privateKey: _privateKey, ...safe } = agent;
    const profile = safe.profile;

    // The profile first — see the header note about the commit point.
    await this.exec.execute(
      `INSERT OR REPLACE INTO profiles (
         agent_id, nickname, avatar, bio, interests_json,
         current_activities_json, social_intent_json, conversation_style_json,
         boundaries_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        safe.agentId,
        profile.nickname,
        profile.avatar ?? null,
        profile.bio,
        JSON.stringify(profile.interests),
        JSON.stringify(profile.currentActivities),
        JSON.stringify(profile.socialIntent),
        JSON.stringify(profile.conversationStyle),
        JSON.stringify(profile.boundaries),
        safe.updatedAt,
      ],
    );

    await this.exec.execute(
      `INSERT OR REPLACE INTO agents (
         agent_id, display_name, public_key, protocol_version,
         capabilities_json, private_key_storage_json, is_local,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ${LOCAL_AGENT_FLAG}, ?, ?)`,
      [
        safe.agentId,
        safe.displayName,
        safe.publicKey,
        safe.protocolVersion,
        JSON.stringify(safe.capabilities),
        JSON.stringify(safe.privateKeyStorage),
        safe.createdAt,
        safe.updatedAt,
      ],
    );

    // A profile whose agent is gone (the agent id changed) would
    // otherwise linger forever.
    await this.exec.execute(
      'DELETE FROM profiles WHERE agent_id NOT IN (SELECT agent_id FROM agents)',
    );
  }

  async deleteAgent(): Promise<void> {
    await this.exec.execute(
      'DELETE FROM profiles WHERE agent_id IN (SELECT agent_id FROM agents WHERE is_local = 1)',
    );
    await this.exec.execute('DELETE FROM agents WHERE is_local = 1');
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                           */
  /* ---------------------------------------------------------------- */

  async getSetting<T>(key: string): Promise<T | null> {
    const rows = await this.exec.select('SELECT value FROM settings WHERE key = ?', [key]);
    const row = rows[0];
    if (!row) return null;
    const raw = sqlToString(row['value']);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A value that is not valid JSON is treated as "not set" rather
      // than as a crash — the same rule the localStorage store uses.
      return null;
    }
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    await this.exec.execute(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
      [key, JSON.stringify(value), new Date().toISOString()],
    );
  }

  async deleteSetting(key: string): Promise<void> {
    await this.exec.execute('DELETE FROM settings WHERE key = ?', [key]);
  }

  /* ---------------------------------------------------------------- */
  /* The block list                                                     */
  /* ---------------------------------------------------------------- */

  async listBlockedAgents(): Promise<readonly BlockedAgent[]> {
    const rows = await this.exec.select(
      'SELECT agent_id, blocked_at, reason FROM blocked_agents ORDER BY blocked_at DESC',
    );
    const entries: BlockedAgent[] = [];
    for (const row of rows) {
      const agentId = row['agent_id'];
      const blockedAt = sqlToString(row['blocked_at']);
      if (!isValidBlockedAgentId(agentId) || blockedAt === null) continue;
      const reason = sqlToString(row['reason']);
      entries.push({
        agentId,
        blockedAt,
        ...(reason !== null ? { reason } : {}),
      });
    }
    return entries;
  }

  async isAgentBlocked(agentId: string): Promise<boolean> {
    const rows = await this.exec.select('SELECT agent_id FROM blocked_agents WHERE agent_id = ?', [
      agentId,
    ]);
    return rows.length > 0;
  }

  async addBlockedAgent(agentId: string, reason?: string): Promise<void> {
    if (!isValidBlockedAgentId(agentId)) {
      throw new Error(`Invalid agent id: ${JSON.stringify(agentId)}`);
    }
    await this.exec.execute(
      'INSERT OR REPLACE INTO blocked_agents (agent_id, blocked_at, reason) VALUES (?, ?, ?)',
      [agentId, new Date().toISOString(), reason ?? null],
    );
  }

  async removeBlockedAgent(agentId: string): Promise<void> {
    await this.exec.execute('DELETE FROM blocked_agents WHERE agent_id = ?', [agentId]);
  }

  async clearBlockedAgents(): Promise<void> {
    await this.exec.execute('DELETE FROM blocked_agents');
  }

  /* ---------------------------------------------------------------- */
  /* Sessions                                                           */
  /* ---------------------------------------------------------------- */

  async upsertSession(session: StoredSessionRecord): Promise<void> {
    await this.exec.execute(
      `INSERT OR REPLACE INTO sessions (
         session_id, peer_agent_id, peer_display_name, started_at, ended_at, close_reason
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        session.sessionId,
        session.peerAgentId,
        session.peerDisplayName,
        session.startedAt,
        session.endedAt ?? null,
        session.closeReason ?? null,
      ],
    );
  }

  async getSession(sessionId: string): Promise<StoredSessionRecord | null> {
    const rows = await this.exec.select(
      `SELECT session_id, peer_agent_id, peer_display_name, started_at, ended_at, close_reason
         FROM sessions WHERE session_id = ?`,
      [sessionId],
    );
    const row = rows[0];
    return row ? rowToSession(row) : null;
  }

  async listSessions(): Promise<readonly StoredSessionRecord[]> {
    const rows = await this.exec.select(
      `SELECT session_id, peer_agent_id, peer_display_name, started_at, ended_at, close_reason
         FROM sessions ORDER BY started_at DESC`,
    );
    return rows.map(rowToSession);
  }

  async latestSession(): Promise<StoredSessionRecord | null> {
    const rows = await this.exec.select(
      `SELECT session_id, peer_agent_id, peer_display_name, started_at, ended_at, close_reason
         FROM sessions ORDER BY started_at DESC LIMIT 1`,
    );
    const row = rows[0];
    return row ? rowToSession(row) : null;
  }

  /* ---------------------------------------------------------------- */
  /* Messages                                                           */
  /* ---------------------------------------------------------------- */

  async appendMessage(message: StoredChatMessage): Promise<StoredChatMessage> {
    const seq = await this.nextSeq(message.sessionId);

    // `INSERT OR IGNORE` is what makes the write idempotent: a message
    // id that is already stored is silently skipped, so a duplicated
    // envelope cannot grow the transcript without bound (D2 req. 7).
    await this.exec.execute(
      `INSERT OR IGNORE INTO messages (
         message_id, session_id, seq, sender_agent_id, direction, source, text,
         status, created_at, sent_at, delivered_at, failed_at, failure_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.messageId,
        message.sessionId,
        seq,
        message.senderAgentId,
        message.direction,
        message.source,
        message.text,
        message.status,
        message.createdAt,
        message.sentAt ?? null,
        message.deliveredAt ?? null,
        message.failedAt ?? null,
        message.failureReason ?? null,
      ],
    );

    const stored = await this.getMessage(message.messageId);
    return stored ?? { ...message, seq };
  }

  async updateMessageStatus(
    messageId: string,
    status: ChatMessageStatus,
    options?: { readonly failureReason?: string; readonly at?: string },
  ): Promise<void> {
    const at = options?.at ?? new Date().toISOString();
    // A timestamp is only written for the state it belongs to, so a
    // message can never claim to have been delivered without a
    // `delivered_at`.
    await this.exec.execute(
      `UPDATE messages
          SET status          = ?,
              sent_at         = COALESCE(sent_at, ?),
              delivered_at    = COALESCE(delivered_at, ?),
              failed_at       = COALESCE(failed_at, ?),
              failure_reason  = COALESCE(failure_reason, ?)
        WHERE message_id = ?`,
      [
        status,
        status === 'SENT' ? at : null,
        status === 'DELIVERED' ? at : null,
        status === 'FAILED' ? at : null,
        status === 'FAILED' ? (options?.failureReason ?? null) : null,
        messageId,
      ],
    );
  }

  async listMessages(sessionId: string): Promise<readonly StoredChatMessage[]> {
    const rows = await this.exec.select(
      `SELECT message_id, session_id, seq, sender_agent_id, direction, source, text,
              status, created_at, sent_at, delivered_at, failed_at, failure_reason
         FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      [sessionId],
    );
    return rows.map(rowToMessage);
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                          */
  /* ---------------------------------------------------------------- */

  /** The next per-session sequence number. */
  private async nextSeq(sessionId: string): Promise<number> {
    const rows = await this.exec.select(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE session_id = ?',
      [sessionId],
    );
    const max = sqlToNumber(rows[0]?.['max_seq']) ?? 0;
    return max + 1;
  }

  /** One stored message, by id. */
  private async getMessage(messageId: string): Promise<StoredChatMessage | null> {
    const rows = await this.exec.select(
      `SELECT message_id, session_id, seq, sender_agent_id, direction, source, text,
              status, created_at, sent_at, delivered_at, failed_at, failure_reason
         FROM messages WHERE message_id = ?`,
      [messageId],
    );
    const row = rows[0];
    return row ? rowToMessage(row) : null;
  }
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

function parseJson<T>(raw: unknown, fallback: T): T {
  const text = sqlToString(raw);
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function parseJsonArray(raw: unknown): unknown[] {
  const parsed = parseJson<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

function rowToAgent(row: SqlRow): StoredAgent | null {
  const agentId = sqlToString(row['agent_id']);
  if (!agentId) return null;

  const privateKeyStorage = parseJson<PrivateKeyStorage | null>(
    row['private_key_storage_json'],
    null,
  );

  const avatar = sqlToString(row['avatar']);
  const profile: SocialProfile = {
    nickname: sqlToText(row['nickname']),
    ...(avatar !== null ? { avatar } : {}),
    bio: sqlToText(row['bio']),
    interests: parseJsonArray(row['interests_json']) as SocialProfile['interests'],
    currentActivities: parseJsonArray(
      row['current_activities_json'],
    ) as SocialProfile['currentActivities'],
    socialIntent: parseJsonArray(row['social_intent_json']) as SocialProfile['socialIntent'],
    conversationStyle: parseJsonArray(
      row['conversation_style_json'],
    ) as SocialProfile['conversationStyle'],
    boundaries: resolveBoundaries(
      parseJson<Partial<SocialProfile['boundaries']> | undefined>(
        row['boundaries_json'],
        undefined,
      ),
    ),
  };

  return {
    agentId,
    displayName: sqlToText(row['display_name']),
    publicKey: sqlToText(row['public_key']),
    protocolVersion: sqlToText(row['protocol_version']),
    capabilities: parseJson<AgentCapabilities>(
      row['capabilities_json'],
      DEFAULT_AGENT_CAPABILITIES,
    ),
    privateKeyStorage: privateKeyStorage ?? { kind: 'dev-localstorage' },
    createdAt: sqlToText(row['created_at']),
    updatedAt: sqlToText(row['updated_at']),
    profile,
  };
}

function rowToSession(row: SqlRow): StoredSessionRecord {
  const endedAt = sqlToString(row['ended_at']);
  const closeReason = sqlToString(row['close_reason']);
  return {
    sessionId: sqlToText(row['session_id']),
    peerAgentId: sqlToText(row['peer_agent_id']),
    peerDisplayName: sqlToText(row['peer_display_name']),
    startedAt: sqlToText(row['started_at']),
    endedAt,
    closeReason,
  };
}

function toDirection(raw: unknown): ChatMessageDirection {
  return raw === 'received' ? 'received' : 'sent';
}

function toSource(raw: unknown): ChatMessageSource {
  return raw === 'agent' ? 'agent' : 'human';
}

function toStatus(raw: unknown): ChatMessageStatus {
  switch (raw) {
    case 'PENDING':
    case 'SENT':
    case 'DELIVERED':
    case 'FAILED':
      return raw;
    default:
      return 'PENDING';
  }
}

function rowToMessage(row: SqlRow): StoredChatMessage {
  return {
    messageId: sqlToText(row['message_id']),
    sessionId: sqlToText(row['session_id']),
    seq: sqlToNumber(row['seq']) ?? 0,
    senderAgentId: sqlToText(row['sender_agent_id']),
    direction: toDirection(row['direction']),
    source: toSource(row['source']),
    text: sqlToText(row['text']),
    status: toStatus(row['status']),
    createdAt: sqlToText(row['created_at']),
    sentAt: sqlToString(row['sent_at']),
    deliveredAt: sqlToString(row['delivered_at']),
    failedAt: sqlToString(row['failed_at']),
    failureReason: sqlToString(row['failure_reason']),
  };
}
