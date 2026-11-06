/**
 * The in-memory implementation of the persistence port — Phase D / D1.
 *
 * It exists for two reasons:
 *
 *   1. **Tests.** The repositories, the migration runner and the chat
 *      repository can be exercised without a Tauri runtime and without
 *      a database file. Because it mirrors the SQLite implementation
 *      statement for statement, a test that passes here is a test of
 *      the *semantics*, not of a different model.
 *   2. **A safe fallback.** When the local database cannot be opened,
 *      the app can keep working for the current session with this
 *      implementation instead of losing the user's data outright. It
 *      is not a substitute for persistence — nothing is written to
 *      disk — and the app says so when it falls back.
 *
 * The semantics it has to match exactly:
 *
 *   - at most one local agent;
 *   - a profile whose agent is gone is dropped;
 *   - `appendMessage` is idempotent on the message id and assigns the
 *     next per-session sequence number;
 *   - `updateMessageStatus` only writes the timestamp that belongs to
 *     the new state;
 *   - the block list is ordered by `blockedAt` descending and drops
 *     entries whose id is not a UUID.
 */

import { isValidBlockedAgentId, type BlockedAgent } from './blocked-agents-store';
import type { StoredAgent } from './profile-store';
import type {
  ChatMessageStatus,
  KindoraDatabase,
  StoredChatMessage,
  StoredSessionRecord,
} from './database';

export class InMemoryKindoraDatabase implements KindoraDatabase {
  readonly schemaVersion: number;

  private agent: StoredAgent | null = null;
  private readonly profiles = new Map<string, StoredAgent['profile']>();
  private readonly settings = new Map<string, unknown>();
  private readonly blocked = new Map<string, BlockedAgent>();
  private readonly sessions = new Map<string, StoredSessionRecord>();
  private readonly messages = new Map<string, StoredChatMessage>();
  private readonly sessionSeq = new Map<string, number>();

  constructor(schemaVersion = 0) {
    this.schemaVersion = schemaVersion;
  }

  /* ---------------------------------------------------------------- */
  /* The local agent                                                    */
  /* ---------------------------------------------------------------- */

  async getAgent(): Promise<StoredAgent | null> {
    return this.agent ? { ...this.agent } : null;
  }

  async saveAgent(agent: StoredAgent): Promise<void> {
    const { privateKey: _privateKey, ...safe } = agent;
    // The profile first, then the agent — same order as the SQLite
    // implementation, so a crash between the two leaves the same
    // consistent state in both.
    this.profiles.set(safe.agentId, safe.profile);
    this.agent = { ...safe };
    // Drop a profile whose agent no longer exists.
    for (const agentId of [...this.profiles.keys()]) {
      if (agentId !== this.agent.agentId) this.profiles.delete(agentId);
    }
  }

  async deleteAgent(): Promise<void> {
    if (this.agent) this.profiles.delete(this.agent.agentId);
    this.agent = null;
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                           */
  /* ---------------------------------------------------------------- */

  async getSetting<T>(key: string): Promise<T | null> {
    const value = this.settings.get(key);
    if (value === undefined) return null;
    // Round-trip through JSON so that a value behaves the same as it
    // would after a restart (the SQLite version stores JSON text).
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return null;
    }
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    this.settings.set(key, value);
  }

  async deleteSetting(key: string): Promise<void> {
    this.settings.delete(key);
  }

  /* ---------------------------------------------------------------- */
  /* The block list                                                     */
  /* ---------------------------------------------------------------- */

  async listBlockedAgents(): Promise<readonly BlockedAgent[]> {
    return [...this.blocked.values()]
      .filter((entry) => isValidBlockedAgentId(entry.agentId))
      .sort((a, b) => b.blockedAt.localeCompare(a.blockedAt));
  }

  async isAgentBlocked(agentId: string): Promise<boolean> {
    return this.blocked.has(agentId);
  }

  async addBlockedAgent(agentId: string, reason?: string): Promise<void> {
    if (!isValidBlockedAgentId(agentId)) {
      throw new Error(`Invalid agent id: ${JSON.stringify(agentId)}`);
    }
    this.blocked.set(agentId, {
      agentId,
      blockedAt: new Date().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async removeBlockedAgent(agentId: string): Promise<void> {
    this.blocked.delete(agentId);
  }

  async clearBlockedAgents(): Promise<void> {
    this.blocked.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Sessions                                                           */
  /* ---------------------------------------------------------------- */

  async upsertSession(session: StoredSessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, { ...session });
  }

  async getSession(sessionId: string): Promise<StoredSessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  async listSessions(): Promise<readonly StoredSessionRecord[]> {
    return [...this.sessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async latestSession(): Promise<StoredSessionRecord | null> {
    const all = await this.listSessions();
    return all[0] ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Messages                                                           */
  /* ---------------------------------------------------------------- */

  async appendMessage(message: StoredChatMessage): Promise<StoredChatMessage> {
    const existing = this.messages.get(message.messageId);
    if (existing) return { ...existing };

    const seq = (this.sessionSeq.get(message.sessionId) ?? 0) + 1;
    this.sessionSeq.set(message.sessionId, seq);
    const stored: StoredChatMessage = { ...message, seq };
    this.messages.set(message.messageId, stored);
    return { ...stored };
  }

  async updateMessageStatus(
    messageId: string,
    status: ChatMessageStatus,
    options?: { readonly failureReason?: string; readonly at?: string },
  ): Promise<void> {
    const existing = this.messages.get(messageId);
    if (!existing) return;
    const at = options?.at ?? new Date().toISOString();
    this.messages.set(messageId, {
      ...existing,
      status,
      sentAt: existing.sentAt ?? (status === 'SENT' ? at : null),
      deliveredAt: existing.deliveredAt ?? (status === 'DELIVERED' ? at : null),
      failedAt: existing.failedAt ?? (status === 'FAILED' ? at : null),
      failureReason:
        existing.failureReason ?? (status === 'FAILED' ? (options?.failureReason ?? null) : null),
    });
  }

  async listMessages(sessionId: string): Promise<readonly StoredChatMessage[]> {
    return [...this.messages.values()]
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq)
      .map((m) => ({ ...m }));
  }
}
