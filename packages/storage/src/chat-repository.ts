/**
 * The chat repository — Phase D / D2.
 *
 * ## What this is for
 *
 * The task book (§ 七 D2) says:
 *
 * > 当前已知问题：聊天消息主要保存在运行时内存，应用关闭后无法可靠恢复。
 *
 * and asks for a `ChatRepository` with an explicit persistence strategy
 * around sending, a way to recognise failed messages, history loading,
 * session resume, an explicit source for every message, unique ids and
 * a delivery state per message.
 *
 * ## The persistence strategy around a send
 *
 * ```
 *   recordPending()   →  the message is on disk with status PENDING
 *   session.send()    →  the message goes out
 *   markSent()        →  status SENT
 *        or
 *   markFailed()      →  status FAILED, with the reason
 * ```
 *
 * Writing `PENDING` **before** the send is what makes a crash honest:
 * a message that was written down and then never sent is visible as
 * `PENDING` after a restart instead of silently disappearing. A message
 * that was never written down cannot be distinguished from one that
 * was never composed.
 *
 * ## What `DELIVERED` may mean
 *
 * KSA 0.1 has no delivery receipt: there is no `chat_ack` message type
 * and the peer never confirms that it read anything. So this repository
 * refuses to let an outbound message reach `DELIVERED` without an
 * explicit receipt object — the method's parameter is not optional and
 * cannot be faked by a stray boolean.
 *
 * `recordReceived()` does use `DELIVERED`, and that is honest: a message
 * the peer sent us is *by definition* present on this device. The
 * receipt is the message itself.
 *
 * See docs/修复.md § 七 D2.
 */

import type {
  ChatMessageSource,
  KindoraDatabase,
  StoredChatMessage,
  StoredSessionRecord,
} from './database';

/** The proof that a message really arrived. */
export interface DeliveryReceipt {
  /**
   * The id of the receipt — an envelope id, an ack id, whatever the
   * protocol ends up using. It exists so that a receipt is a value
   * that has to be *produced*, not a flag that can be flipped.
   */
  readonly receiptId: string;
  /** When the receipt was observed (ISO-8601). */
  readonly receivedAt: string;
}

export interface ChatRepositoryOptions {
  /** Where the messages go. */
  readonly database: KindoraDatabase;
  /** Clock seam — defaults to the wall clock. */
  readonly now?: () => string;
  /** Id seam — defaults to `crypto.randomUUID()`. */
  readonly idGenerator?: () => string;
}

/** The input for opening a session. */
export interface OpenSessionInput {
  readonly peerAgentId: string;
  readonly peerDisplayName: string;
  /** An explicit session id. One is generated when this is omitted. */
  readonly sessionId?: string;
}

/** The input for recording a message that is about to be sent. */
export interface RecordOutboundInput {
  readonly sessionId: string;
  readonly senderAgentId: string;
  readonly text: string;
  readonly source: ChatMessageSource;
  /** An explicit message id. One is generated when this is omitted. */
  readonly messageId?: string;
}

/** The input for recording a message the peer sent. */
export interface RecordInboundInput {
  readonly sessionId: string;
  readonly senderAgentId: string;
  readonly text: string;
  readonly source: ChatMessageSource;
  /** The envelope's message id — reused verbatim so that a duplicated
   *  envelope cannot produce a second row. */
  readonly messageId: string;
}

/** A session together with its transcript. */
export interface ResumedSession {
  readonly session: StoredSessionRecord;
  readonly messages: readonly StoredChatMessage[];
}

export class ChatRepository {
  private readonly db: KindoraDatabase;
  private readonly now: () => string;
  private readonly idGenerator: () => string;

  constructor(options: ChatRepositoryOptions) {
    this.db = options.database;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idGenerator =
      options.idGenerator ??
      (() => {
        if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
          return globalThis.crypto.randomUUID();
        }
        return `msg-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      });
  }

  /* ---------------------------------------------------------------- */
  /* Sessions                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Record the start of a chat session.
   *
   * The session row is written before the first message, so a session
   * that produced no message at all is still visible in the history.
   */
  async openSession(input: OpenSessionInput): Promise<StoredSessionRecord> {
    const session: StoredSessionRecord = {
      sessionId: input.sessionId ?? this.idGenerator(),
      peerAgentId: input.peerAgentId,
      peerDisplayName: input.peerDisplayName,
      startedAt: this.now(),
      endedAt: null,
      closeReason: null,
    };
    await this.db.upsertSession(session);
    return session;
  }

  /** Record that a session ended, and why. */
  async closeSession(sessionId: string, closeReason: string): Promise<void> {
    const existing = await this.db.getSession(sessionId);
    if (!existing) return;
    await this.db.upsertSession({
      ...existing,
      endedAt: this.now(),
      closeReason,
    });
  }

  /** Every session, newest first. */
  listSessions(): Promise<readonly StoredSessionRecord[]> {
    return this.db.listSessions();
  }

  /**
   * Load a session and its transcript.
   *
   * With no argument the most recent session is resumed. Returns
   * `null` when there is nothing to resume.
   */
  async resumeSession(sessionId?: string): Promise<ResumedSession | null> {
    const session =
      sessionId === undefined ? await this.db.latestSession() : await this.db.getSession(sessionId);
    if (!session) return null;
    const messages = await this.db.listMessages(session.sessionId);
    return { session, messages };
  }

  /* ---------------------------------------------------------------- */
  /* Messages                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Write a message down **before** it is sent.
   *
   * The row starts with status `PENDING`. If the app dies between this
   * call and the send, the message is still on disk and still visibly
   * unsent.
   */
  async recordPending(input: RecordOutboundInput): Promise<StoredChatMessage> {
    return this.db.appendMessage({
      messageId: input.messageId ?? this.idGenerator(),
      sessionId: input.sessionId,
      seq: 0,
      senderAgentId: input.senderAgentId,
      direction: 'sent',
      source: input.source,
      text: input.text,
      status: 'PENDING',
      createdAt: this.now(),
      sentAt: null,
      deliveredAt: null,
      failedAt: null,
      failureReason: null,
    });
  }

  /** The message went out without an error. */
  async markSent(messageId: string): Promise<void> {
    await this.db.updateMessageStatus(messageId, 'SENT', { at: this.now() });
  }

  /** The message could not be sent. The reason is stored with it. */
  async markFailed(messageId: string, reason: string): Promise<void> {
    await this.db.updateMessageStatus(messageId, 'FAILED', {
      at: this.now(),
      failureReason: reason,
    });
  }

  /**
   * Mark an outbound message as delivered.
   *
   * A receipt is **required**. There is no overload without one and no
   * boolean flag: a caller that wants to claim delivery has to produce
   * a receipt, which the protocol currently cannot do.
   */
  async markDelivered(messageId: string, receipt: DeliveryReceipt): Promise<void> {
    if (!receipt || typeof receipt.receiptId !== 'string' || receipt.receiptId.length === 0) {
      throw new Error(
        'markDelivered needs a delivery receipt: a message may only be marked ' +
          'delivered when there is proof that it arrived.',
      );
    }
    await this.db.updateMessageStatus(messageId, 'DELIVERED', {
      at: receipt.receivedAt,
    });
  }

  /**
   * Record a message the peer sent.
   *
   * The status is `DELIVERED`: the message is on this device, and its
   * arrival *is* the receipt. The envelope's own message id is reused,
   * so a replayed or duplicated envelope cannot add a second row.
   */
  async recordReceived(input: RecordInboundInput): Promise<StoredChatMessage> {
    const now = this.now();
    return this.db.appendMessage({
      messageId: input.messageId,
      sessionId: input.sessionId,
      seq: 0,
      senderAgentId: input.senderAgentId,
      direction: 'received',
      source: input.source,
      text: input.text,
      status: 'DELIVERED',
      createdAt: now,
      sentAt: null,
      deliveredAt: now,
      failedAt: null,
      failureReason: null,
    });
  }

  /** The transcript of a session, in order. */
  async history(sessionId: string): Promise<readonly StoredChatMessage[]> {
    return this.db.listMessages(sessionId);
  }
}
