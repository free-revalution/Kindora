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
 * See 开发手册.md Phase 9.
 */
import type { KsaMessage } from '@kindora/protocol';
import {
  createBlock,
  createChatMessage,
  createDisconnect,
} from '@kindora/protocol';
import type { PairingSession } from '@kindora/transport';

import {
  type BlockedAgentsLookup,
} from './consent-orchestrator';

export { type BlockedAgentsLookup } from './consent-orchestrator';

/** Default maximum text length — matches `validateChatMessagePayload`. */
export const DEFAULT_CHAT_TEXT_MAX_LENGTH = 2000;

/** What closed the chat. */
export type ChatCloseReason =
  | 'open'
  | 'user-disconnect'
  | 'user-block'
  | 'peer-disconnect'
  | 'peer-block'
  | 'session-closed';

export interface ChatEntry {
  /** Unique id — messageId for received entries, locally-generated for sent. */
  readonly id: string;
  readonly direction: 'sent' | 'received';
  readonly sender: string;
  readonly text: string;
  /** ISO timestamp from the envelope (received) or from the send call (sent). */
  readonly timestamp: string;
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
}

interface InternalState {
  entries: ChatEntry[];
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
   */
  async send(session: PairingSession, text: string): Promise<ChatEntry> {
    if (this.internal.state !== 'open') {
      throw new Error(
        `Cannot send: chat is closed (reason: "${this.internal.closeReason}").`,
      );
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error('Cannot send an empty message.');
    }
    if (trimmed.length > this.maxTextLength) {
      throw new Error(
        `Message is ${trimmed.length} chars; max is ${this.maxTextLength}.`,
      );
    }

    const envelope = createChatMessage(this.selfAgentId, { text: trimmed });
    await session.send(envelope);

    const entry: ChatEntry = {
      id: this.idGenerator(),
      direction: 'sent',
      sender: this.selfAgentId,
      text: trimmed,
      timestamp: envelope.timestamp,
    };
    this.internal.entries.push(entry);
    this.notify();
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
    const entry: ChatEntry = {
      id: msg.messageId,
      direction: 'received',
      sender: msg.sender,
      text: msg.payload.text,
      timestamp: msg.timestamp,
    };
    this.internal.entries.push(entry);
    this.notify();
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