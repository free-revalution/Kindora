/**
 * ChatOrchestrator — Phase 9.
 *
 * Drives the human-to-human chat on top of an already-connected
 * `PairingSession`, after Phase 7 (ConsentOrchestrator) has resolved
 * with `accepted_both`. Implements the actions from
 * 开发手册.md § 30, Phase 9:
 *
 *   - Send     — wrap text in a `chat_message` envelope + append to history
 *   - Receive  — peer `chat_message` envelopes appear in history
 *   - History  — chronological list of entries (sent + received)
 *   - Disconnect — close the session, no verdict
 *   - Block    — persist peer's id + send `block` + close the session
 *
 * Design constraints:
 *   - The chat orchestrator ONLY cares about `chat_message`,
 *     `block`, and `disconnect` envelopes — the consent and match
 *     phases are over by the time this is constructed.
 *   - Messages from anyone other than `peerAgentId` are dropped
 *     defensively (§ 50).
 *   - Text is length-bounded (default 2000 chars, same as the
 *     protocol validator).
 *   - The orchestrator never rejects — errors are surfaced via the
 *     snapshot's `closeReason` (e.g. 'peer-block', 'peer-disconnect').
 *
 * Per § 30 the default chat is two-party (Human A ↔ Human B). The
 * four-party variant in the manual is explicitly out of scope.
 *
 * ## Phase D / D2 — the transcript is persisted
 *
 * The orchestrator writes every message down through the
 * {@link ChatPersistence} port:
 *
 * ```
 *   recordPending()  →  PENDING on disk
 *   (the message goes out)
 *   markSent()       →  SENT
 *        or
 *   markFailed()     →  FAILED, with the reason
 * ```
 *
 * The port is **optional**: without it the chat behaves exactly as it
 * did before Phase D (in memory only). With it, a message that could
 * not be sent stays visible as `FAILED` instead of vanishing, and the
 * whole conversation survives a restart.
 *
 * See 开发手册.md Phase 9, docs/修复.md § 七 D2.
 */
import type { KsaMessage } from '@kindora/protocol';
import { createBlock, createChatMessage, createDisconnect } from '@kindora/protocol';
import type { PairingSession } from '@kindora/transport';

import { type BlockedAgentsLookup } from './consent-orchestrator';
import {
  type ChatMessageSource,
  type ChatMessageStatus,
  type ChatPersistence,
} from './chat-persistence';

export { type BlockedAgentsLookup } from './consent-orchestrator';
export {
  type ChatMessageSource,
  type ChatMessageStatus,
  type ChatPersistence,
  type PendingChatMessage,
  type ReceivedChatMessage,
} from './chat-persistence';

/** Default maximum text length — matches `validateChatMessagePayload`. */
export const DEFAULT_CHAT_TEXT_MAX_LENGTH = 2000;

/** What closed the chat. */
export type ChatCloseReason =
  'open' | 'user-disconnect' | 'user-block' | 'peer-disconnect' | 'peer-block' | 'session-closed';

export interface ChatEntry {
  /** Unique id — messageId for received entries, locally-generated for sent. */
  readonly id: string;
  readonly direction: 'sent' | 'received';
  readonly sender: string;
  readonly text: string;
  /** ISO timestamp from the envelope (received) or from the send call (sent). */
  readonly timestamp: string;
  /**
   * Phase D / D2 — who composed the message.
   *
   * `human` by default; `agent` when an agent drafted the text and a
   * human pressed Send (per § 32 the agent never sends by itself).
   */
  readonly source?: ChatMessageSource;
  /**
   * Phase D / D2 — the delivery state.
   *
   * A sent message is `PENDING` until the transport accepted it, then
   * `SENT`; a failed send stays in the history as `FAILED`. A received
   * message is `DELIVERED` — it is on this device by definition.
   */
  readonly status?: ChatMessageStatus;
}

export interface ChatSnapshot {
  readonly entries: readonly ChatEntry[];
  readonly state: 'open' | 'closed';
  readonly closeReason: ChatCloseReason;
  readonly peerAgentId: string;
  readonly peerDisplayName: string;
  readonly blockedByLocal: boolean;
  readonly blockedByPeer: boolean;
}

export type ChatListener = (snapshot: ChatSnapshot) => void;

export interface ChatOrchestratorOptions {
  readonly blockList?: BlockedAgentsLookup;
  readonly maxTextLength?: number;
  /**
   * Test seam — default uses `crypto.randomUUID()` so the entry id is
   * unique within the chat. Production callers should leave it unset.
   */
  readonly idGenerator?: () => string;
  /**
   * Phase D / D2 — where the transcript is written.
   *
   * Optional: without it the chat runs in memory only, exactly as it
   * did before Phase D.
   */
  readonly persistence?: ChatPersistence;
  /**
   * Phase D / D2 — the id of the conversation the persisted rows
   * belong to. Required for the persistence to be usable; without a
   * `sessionId` the persisted rows are grouped under an empty id,
   * which the storage layer refuses — so the orchestrator skips
   * persistence entirely when it is missing.
   */
  readonly sessionId?: string;
  /**
   * Phase D / D2 — who composed the messages the **peer** sends.
   *
   * KSA 0.1's wire format carries no author field, so a peer message
   * is attributed to a human by default. The seam exists so that a
   * future protocol that *does* carry the author can say so.
   */
  readonly inboundSource?: ChatMessageSource;
}

/**
 * The in-memory entry. Same shape as {@link ChatEntry}, but the
 * status is mutable: a message is `PENDING` before it goes out and
 * becomes `SENT` or `FAILED` afterwards.
 */
type InternalChatEntry = { -readonly [K in keyof ChatEntry]: ChatEntry[K] };

interface InternalState {
  entries: InternalChatEntry[];
  state: 'open' | 'closed';
  closeReason: ChatCloseReason;
  blockedByLocal: boolean;
  blockedByPeer: boolean;
}

export class ChatOrchestrator {
  private readonly selfAgentId: string;
  private readonly peerAgentId: string;
  private readonly peerDisplayName: string;
  private readonly blockList: BlockedAgentsLookup;
  private readonly maxTextLength: number;
  private readonly idGenerator: () => string;
  private readonly persistence: ChatPersistence | null;
  private readonly sessionId: string;
  private readonly inboundSource: ChatMessageSource;
  private readonly listeners = new Set<ChatListener>();
  private readonly internal: InternalState;

  constructor(input: {
    readonly selfAgentId: string;
    readonly peerAgentId: string;
    readonly peerDisplayName: string;
    readonly options?: ChatOrchestratorOptions;
  }) {
    this.selfAgentId = input.selfAgentId;
    this.peerAgentId = input.peerAgentId;
    this.peerDisplayName = input.peerDisplayName;
    this.blockList = input.options?.blockList ?? NoopBlockList;
    this.maxTextLength = input.options?.maxTextLength ?? DEFAULT_CHAT_TEXT_MAX_LENGTH;
    this.idGenerator =
      input.options?.idGenerator ??
      (() => {
        if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
          return globalThis.crypto.randomUUID();
        }
        // Fallback for environments without crypto.randomUUID.
        return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      });
    // Phase D / D2 — persistence needs a session to write into. A
    // persistence port without a session id would write rows nobody
    // can read back, so it is not used at all in that case.
    this.sessionId = input.options?.sessionId ?? '';
    this.persistence =
      input.options?.persistence && this.sessionId.length > 0 ? input.options.persistence : null;
    this.inboundSource = input.options?.inboundSource ?? 'human';
    this.internal = {
      entries: [],
      state: 'open',
      closeReason: 'open',
      blockedByLocal: false,
      blockedByPeer: false,
    };
  }

  /** Current snapshot (immutable view). */
  snapshot(): ChatSnapshot {
    return {
      entries: Object.freeze([...this.internal.entries]),
      state: this.internal.state,
      closeReason: this.internal.closeReason,
      peerAgentId: this.peerAgentId,
      peerDisplayName: this.peerDisplayName,
      blockedByLocal: this.internal.blockedByLocal,
      blockedByPeer: this.internal.blockedByPeer,
    };
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: ChatListener): () => void {
    this.listeners.add(listener);
    // Fire immediately with the current snapshot so consumers don't
    // need a separate read.
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Begin listening on the session. Resolves when the session closes
   * (any reason). The resolved snapshot has `state === 'closed'` and
   * a populated `closeReason`.
   */
  async start(session: PairingSession): Promise<ChatSnapshot> {
    if (session.current().state !== 'connected') {
      throw new Error(
        `ChatOrchestrator.start requires a connected PairingSession (got "${session.current().state}").`,
      );
    }

    return new Promise<ChatSnapshot>((resolve) => {
      let resolved = false;

      const offMessage = session.onMessage((msg) => {
        if (msg.type === 'chat_message') {
          if (msg.sender === this.peerAgentId) {
            this.appendReceived(msg);
          }
          // Self-echoes (sender === self) are dropped. Same for any
          // other sender — defensive (§ 50).
        } else if (msg.type === 'block' && msg.sender === this.peerAgentId) {
          this.transition('peer-block');
          // Close the local side so the start() promise resolves.
          void session.disconnect('peer-block').catch(() => undefined);
        } else if (msg.type === 'disconnect' && msg.sender === this.peerAgentId) {
          this.transition('peer-disconnect');
          // Close the local side so the start() promise resolves.
          void session.disconnect('peer-disconnect').catch(() => undefined);
        }
      });

      const offState = session.onStateChange((snap) => {
        if (snap.state === 'closed') {
          // If we haven't already classified the close, fall back to
          // a generic session-closed reason. The session snapshot's
          // `closeReason` is whatever the local user (or the peer, via
          // the disconnect envelope) supplied.
          if (this.internal.state === 'open') {
            this.transition('session-closed');
          }
          if (!resolved) {
            resolved = true;
            offMessage();
            offState();
            resolve(this.snapshot());
          }
        }
      });
    });
  }

  /**
   * Send a chat message to the peer. Returns the local `ChatEntry`
   * that was appended to history. Throws if the session isn't open
   * or the text is empty / too long.
   *
   * Phase D / D2: `source` says who composed the message — `human`
   * (the default) or `agent` (an agent drafted it and a human pressed
   * Send). The message is written down as `PENDING` **before** it goes
   * out; a send that fails leaves a `FAILED` entry in the history
   * instead of silently dropping the message.
   */
  async send(
    session: PairingSession,
    text: string,
    source: ChatMessageSource = 'human',
  ): Promise<ChatEntry> {
    if (this.internal.state !== 'open') {
      throw new Error(`Cannot send: chat is closed (reason: "${this.internal.closeReason}").`);
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error('Cannot send an empty message.');
    }
    if (trimmed.length > this.maxTextLength) {
      throw new Error(`Message is ${trimmed.length} chars; max is ${this.maxTextLength}.`);
    }

    const envelope = createChatMessage(this.selfAgentId, { text: trimmed });
    const entry: InternalChatEntry = {
      id: this.idGenerator(),
      direction: 'sent',
      sender: this.selfAgentId,
      text: trimmed,
      timestamp: envelope.timestamp,
      source,
      status: 'PENDING',
    };

    // Phase D / D2 — write it down FIRST. A crash between here and
    // the send leaves a visible `PENDING` row; the other order would
    // lose the message without a trace.
    await this.persistPending(entry);

    this.internal.entries.push(entry);
    this.notify();

    try {
      await session.send(envelope);
    } catch (err) {
      entry.status = 'FAILED';
      this.notify();
      await this.persistFailed(entry, err);
      throw err;
    }

    entry.status = 'SENT';
    this.notify();
    await this.persistSent(entry);
    return entry;
  }

  /**
   * Persist the peer's id to the local block list, send a `block`
   * envelope, and close the session. Idempotent: calling twice is a
   * no-op.
   */
  async block(session: PairingSession, reason?: string): Promise<void> {
    if (this.internal.state !== 'open') return;
    this.internal.blockedByLocal = true;
    try {
      await this.blockList.add(this.peerAgentId, reason ?? 'chat-block');
    } catch {
      // Best-effort — don't let a store failure mask the block.
    }
    try {
      await session.send(createBlock(this.selfAgentId, reason ? { reason } : {}));
    } catch {
      // The session might already be closing; ignore.
    }
    this.transition('user-block');
    await session.disconnect(reason ?? 'user-block');
  }

  /**
   * Close the session without a verdict. Idempotent.
   */
  async disconnect(session: PairingSession, reason?: string): Promise<void> {
    if (this.internal.state !== 'open') return;
    try {
      await session.send(createDisconnect(this.selfAgentId, reason ? { reason } : {}));
    } catch {
      // Ignore — session might be closing for a different reason.
    }
    this.transition('user-disconnect');
    await session.disconnect(reason ?? 'user-disconnect');
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private appendReceived(msg: KsaMessage & { type: 'chat_message' }): void {
    if (this.internal.state !== 'open') return;
    const entry: InternalChatEntry = {
      id: msg.messageId,
      direction: 'received',
      sender: msg.sender,
      text: msg.payload.text,
      timestamp: msg.timestamp,
      source: this.inboundSource,
      // A message the peer sent us is on this device by definition —
      // its arrival is the receipt.
      status: 'DELIVERED',
    };
    this.internal.entries.push(entry);
    this.notify();
    // The write happens after the entry is visible: the user should
    // not wait for the disk to see a message that already arrived.
    void this.persistReceived(entry);
  }

  /* ------------------------------------------------------------------ */
  /* Phase D / D2 — the persistence port                                */
  /* ------------------------------------------------------------------ */

  /**
   * A storage failure must not stop the conversation.
   *
   * Failing to *record* a message is bad, but failing to *send* it
   * because the disk hiccupped is worse. Every persistence error is
   * therefore reported and swallowed — the in-memory history stays
   * correct, and the app logs the problem so it can be reported.
   */
  private reportPersistenceFailure(what: string, err: unknown): void {
    console.error(`Kindora: could not ${what}.`, err);
  }

  private async persistPending(entry: InternalChatEntry): Promise<void> {
    if (!this.persistence) return;
    try {
      await this.persistence.recordPending({
        sessionId: this.sessionId,
        senderAgentId: entry.sender,
        text: entry.text,
        source: entry.source ?? 'human',
        messageId: entry.id,
      });
    } catch (err) {
      this.reportPersistenceFailure('record the outgoing message', err);
    }
  }

  private async persistSent(entry: InternalChatEntry): Promise<void> {
    if (!this.persistence) return;
    try {
      await this.persistence.markSent(entry.id);
    } catch (err) {
      this.reportPersistenceFailure('mark the outgoing message as sent', err);
    }
  }

  private async persistFailed(entry: InternalChatEntry, cause: unknown): Promise<void> {
    if (!this.persistence) return;
    const reason = cause instanceof Error ? cause.message : String(cause);
    try {
      await this.persistence.markFailed(entry.id, reason);
    } catch (err) {
      this.reportPersistenceFailure('mark the outgoing message as failed', err);
    }
  }

  private async persistReceived(entry: InternalChatEntry): Promise<void> {
    if (!this.persistence) return;
    try {
      await this.persistence.recordReceived({
        sessionId: this.sessionId,
        senderAgentId: entry.sender,
        text: entry.text,
        source: entry.source ?? 'human',
        messageId: entry.id,
      });
    } catch (err) {
      this.reportPersistenceFailure('record the incoming message', err);
    }
  }

  private transition(reason: ChatCloseReason): void {
    if (this.internal.state === 'closed') return;
    this.internal.state = 'closed';
    this.internal.closeReason = reason;
    if (reason === 'peer-block') this.internal.blockedByPeer = true;
    if (reason === 'user-block') this.internal.blockedByLocal = true;
    this.notify();
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}

const NoopBlockList: BlockedAgentsLookup = {
  async has() {
    return false;
  },
  async add() {
    /* no-op */
  },
};
