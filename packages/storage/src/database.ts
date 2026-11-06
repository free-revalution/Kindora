/**
 * The persistence port — Phase D / D1.
 *
 * This is the interface the rest of the app talks to. It is
 * deliberately expressed in **domain terms** (an agent, a setting, a
 * blocked agent, a session, a message) rather than in SQL terms, so
 * that:
 *
 *   - the desktop app never writes SQL by hand;
 *   - the schema can change without touching every call site;
 *   - the whole port can be implemented in memory for tests.
 *
 * Two implementations exist:
 *
 *   - `SqliteKindoraDatabase` — the real one, on SQLite (Tauri);
 *   - `InMemoryKindoraDatabase` — the same semantics without a file,
 *     used by the tests and as the safe fallback when the local
 *     database cannot be opened.
 *
 * ## What is *not* in here
 *
 * The agent's **private key**. The port persists the agent's identity
 * metadata and its profile; the key itself belongs in the OS keychain
 * (Phase A / A1) and every implementation strips it before writing.
 */

import type { BlockedAgent } from './blocked-agents-store';
import type { StoredAgent } from './profile-store';

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

/**
 * The delivery state of a stored chat message.
 *
 * The task book (§ 七 D2) suggests these four states and adds:
 *
 * > 实际状态应根据当前协议能力调整，不得将无法确认的状态伪装为 DELIVERED。
 *
 * KSA 0.1 has **no delivery receipt** — there is no `chat_ack` message
 * type and the peer never confirms that it read anything. So:
 *
 *   - `PENDING`   — written locally, not yet handed to the transport;
 *   - `SENT`      — handed to the transport without an error. This is
 *                   the most an outbound message can honestly claim;
 *   - `FAILED`    — the transport rejected it;
 *   - `DELIVERED` — only for a message that is **present on this
 *                   device** (i.e. one the peer sent us: receiving it
 *                   *is* the receipt), or for an outbound message that
 *                   a future receipt message confirmed. Nothing in the
 *                   current product may set it for an outbound message.
 */
export type ChatMessageStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED';

/** Which way a message went. */
export type ChatMessageDirection = 'sent' | 'received';

/**
 * Who wrote the text.
 *
 * D2 requirement 6: 「明确 Agent 消息和人类消息的来源」.
 *
 *   - `human` — the user's own words;
 *   - `agent` — text the local agent produced and the user approved
 *     (for example the icebreaker the user picked with "Use").
 *
 * The source is a property of the **text**, not of the transport:
 * every message on the wire is sent by the local agent on the user's
 * behalf, so the direction says who sent it and the source says who
 * wrote it.
 */
export type ChatMessageSource = 'human' | 'agent';

/** A chat message as it is stored. */
export interface StoredChatMessage {
  /** Unique id. The primary key of the row — a message is stored once. */
  readonly messageId: string;
  /** The session this message belongs to. */
  readonly sessionId: string;
  /** The per-session order. Starts at 1. */
  readonly seq: number;
  /** The agent id that put the message on the wire. */
  readonly senderAgentId: string;
  readonly direction: ChatMessageDirection;
  readonly source: ChatMessageSource;
  readonly text: string;
  readonly status: ChatMessageStatus;
  /** When the message was created locally (ISO-8601). */
  readonly createdAt: string;
  /** When the message was handed to the transport. */
  readonly sentAt?: string | null;
  /** When the message was confirmed present on this device. */
  readonly deliveredAt?: string | null;
  /** When the send failed. */
  readonly failedAt?: string | null;
  /** Why the send failed. Never sent to the peer. */
  readonly failureReason?: string | null;
}

/** A chat session as it is stored. */
export interface StoredSessionRecord {
  /** Unique id of the session. */
  readonly sessionId: string;
  /** The peer's agent id. */
  readonly peerAgentId: string;
  /** The peer's display name, as shown at the time. */
  readonly peerDisplayName: string;
  /** When the session started (ISO-8601). */
  readonly startedAt: string;
  /** When the session ended, if it has. */
  readonly endedAt?: string | null;
  /** Why the session ended, if it has. */
  readonly closeReason?: string | null;
}

/* ------------------------------------------------------------------ */
/* The port                                                            */
/* ------------------------------------------------------------------ */

/**
 * Everything the app persists, in domain terms.
 *
 * The methods are all asynchronous because the real implementation is
 * a database on disk; the in-memory implementation resolves
 * immediately.
 */
export interface KindoraDatabase {
  /** The schema version this database is at. */
  readonly schemaVersion: number;

  /* ---- the local agent ------------------------------------------- */

  /** The local agent, or `null` when there is none on this device. */
  getAgent(): Promise<StoredAgent | null>;
  /** Insert or replace the local agent and its profile. */
  saveAgent(agent: StoredAgent): Promise<void>;
  /** Remove the local agent and its profile. */
  deleteAgent(): Promise<void>;

  /* ---- non-secret settings ---------------------------------------- */

  /** Read a setting. `null` when it was never set. */
  getSetting<T>(key: string): Promise<T | null>;
  /** Write a setting. */
  setSetting<T>(key: string, value: T): Promise<void>;
  /** Remove a setting. */
  deleteSetting(key: string): Promise<void>;

  /* ---- the block list --------------------------------------------- */

  /** The whole block list, newest first. */
  listBlockedAgents(): Promise<readonly BlockedAgent[]>;
  /** True iff the agent id is currently blocked. */
  isAgentBlocked(agentId: string): Promise<boolean>;
  /** Block an agent id. Idempotent — re-blocking updates the entry. */
  addBlockedAgent(agentId: string, reason?: string): Promise<void>;
  /** Unblock an agent id. A no-op when it is not blocked. */
  removeBlockedAgent(agentId: string): Promise<void>;
  /** Empty the block list. */
  clearBlockedAgents(): Promise<void>;

  /* ---- chat sessions ---------------------------------------------- */

  /** Insert or replace a session. */
  upsertSession(session: StoredSessionRecord): Promise<void>;
  /** One session, or `null`. */
  getSession(sessionId: string): Promise<StoredSessionRecord | null>;
  /** Every session, newest first. */
  listSessions(): Promise<readonly StoredSessionRecord[]>;
  /** The most recently started session, or `null`. */
  latestSession(): Promise<StoredSessionRecord | null>;

  /* ---- chat messages ----------------------------------------------- */

  /**
   * Store a message.
   *
   * Idempotent: a message id that is already stored is **not** stored
   * again (D2 requirement 7). The stored row is returned, so the
   * caller sees the sequence number that was actually assigned.
   */
  appendMessage(message: StoredChatMessage): Promise<StoredChatMessage>;
  /**
   * Move a message to a new delivery state.
   *
   * The timestamps are filled in according to the new state, so a
   * message cannot claim to have been delivered without a
   * `delivered_at`.
   */
  updateMessageStatus(
    messageId: string,
    status: ChatMessageStatus,
    options?: { readonly failureReason?: string; readonly at?: string },
  ): Promise<void>;
  /** The messages of a session, in order. */
  listMessages(sessionId: string): Promise<readonly StoredChatMessage[]>;
}
