/**
 * The desktop chat persistence adapter — Phase D / D2.
 *
 * The `ChatOrchestrator` in `@kindora/matching` writes through the
 * `ChatPersistence` **port**; this file is the desktop app's
 * implementation of that port, backed by the `ChatRepository` in
 * `@kindora/storage`.
 *
 * The two packages cannot depend on each other (`@kindora/matching`
 * must not depend on `@kindora/storage`, because that would change
 * `pnpm-lock.yaml` and break CI's `pnpm install --frozen-lockfile`),
 * so the port lives in the matching package and the adapter lives
 * here.
 *
 * ## The session row
 *
 * The repository needs a session before it can write messages into it.
 * The session is opened **lazily**, on the first message, so that
 * merely looking at the app does not create a session row for a
 * conversation that never happened.
 *
 * ## Failures
 *
 * A failure here is reported to the caller and never swallowed by the
 * adapter: the orchestrator decides what to do with it (it logs it and
 * lets the conversation continue).
 */

import type { ChatPersistence, PendingChatMessage, ReceivedChatMessage } from '@kindora/matching';
import { ChatRepository, type KindoraDatabase } from '@kindora/storage';

export interface DesktopChatPersistenceOptions {
  /** The local agent id — the sender of every outbound message. */
  readonly selfAgentId: string;
  /** The peer's agent id. */
  readonly peerAgentId: string;
  /** The peer's display name, as shown in the history. */
  readonly peerDisplayName: string;
  /** An explicit session id. One is generated when this is omitted. */
  readonly sessionId?: string;
  /**
   * Resolves the local database.
   *
   * Called once, lazily. A rejected promise means "no database" — the
   * caller decides whether to run without persistence.
   */
  readonly database: () => Promise<KindoraDatabase>;
  /** Test seam — defaults to `crypto.randomUUID()`. */
  readonly idGenerator?: () => string;
}

function defaultIdGenerator(): string {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `session-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * The desktop implementation of the chat persistence port.
 *
 * Everything it writes goes into the local business database, so the
 * transcript survives a restart.
 */
export class DesktopChatPersistence implements ChatPersistence {
  private readonly options: DesktopChatPersistenceOptions;
  private readonly sessionId: string;
  private repository: ChatRepository | null = null;
  private opening: Promise<ChatRepository> | null = null;

  constructor(options: DesktopChatPersistenceOptions) {
    this.options = options;
    this.sessionId = options.sessionId ?? (options.idGenerator ?? defaultIdGenerator)();
  }

  /** The id of the conversation this adapter writes into. */
  get id(): string {
    return this.sessionId;
  }

  /**
   * Open the session row (once) and return the repository.
   *
   * The first call does the work; every later call reuses the result.
   * A failed open is remembered as a failed promise, so a broken
   * database does not trigger a fresh open on every single message.
   */
  private async ensureRepository(): Promise<ChatRepository> {
    if (this.repository) return this.repository;
    if (!this.opening) {
      this.opening = (async () => {
        const database = await this.options.database();
        const repository = new ChatRepository({ database });
        await repository.openSession({
          sessionId: this.sessionId,
          peerAgentId: this.options.peerAgentId,
          peerDisplayName: this.options.peerDisplayName,
        });
        this.repository = repository;
        return repository;
      })();
    }
    return this.opening;
  }

  async recordPending(message: PendingChatMessage): Promise<void> {
    const repository = await this.ensureRepository();
    await repository.recordPending({
      // The adapter owns the session: it opened the row, so it decides
      // which session the message belongs to. A caller that passes a
      // different id cannot leave an orphan row behind.
      sessionId: this.sessionId,
      senderAgentId: message.senderAgentId,
      text: message.text,
      source: message.source,
      messageId: message.messageId,
    });
  }

  async markSent(messageId: string): Promise<void> {
    const repository = await this.ensureRepository();
    await repository.markSent(messageId);
  }

  async markFailed(messageId: string, reason: string): Promise<void> {
    const repository = await this.ensureRepository();
    await repository.markFailed(messageId, reason);
  }

  async recordReceived(message: ReceivedChatMessage): Promise<void> {
    const repository = await this.ensureRepository();
    await repository.recordReceived({
      sessionId: this.sessionId,
      senderAgentId: message.senderAgentId,
      text: message.text,
      source: message.source,
      messageId: message.messageId,
    });
  }
}
