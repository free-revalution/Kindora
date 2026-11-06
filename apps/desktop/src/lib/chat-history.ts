/**
 * The chat history — Phase D / D2.
 *
 * The task book (§ 七 D2) asks for the user to be able to recover a
 * previous conversation after closing and restarting the app. The
 * storage layer already keeps every session and every message; this
 * module is the read side the UI uses.
 *
 * ## The browser dev server
 *
 * There is no database there, so there is no history. The functions
 * return an empty list rather than throwing, and the screen says so
 * in plain words instead of showing an empty box.
 */

import { ChatRepository, type StoredChatMessage } from '@kindora/storage';

import { getKindoraDatabase, isDatabaseAvailable } from './database';

/** One past conversation, as the history list shows it. */
export interface ChatHistorySession {
  readonly sessionId: string;
  readonly peerAgentId: string;
  readonly peerDisplayName: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly closeReason: string | null;
  readonly messageCount: number;
  /** The timestamp of the last message, or `null` for an empty chat. */
  readonly lastMessageAt: string | null;
}

/** True when this runtime keeps a chat history at all. */
export function isChatHistoryAvailable(): boolean {
  return isDatabaseAvailable();
}

/**
 * Every past conversation, newest first.
 *
 * The message count is loaded per session. V0.1 keeps a handful of
 * conversations per device, so this is cheap — and it keeps the
 * storage layer free of a `COUNT(*)` query it would otherwise need.
 */
export async function listChatHistory(): Promise<readonly ChatHistorySession[]> {
  if (!isDatabaseAvailable()) return [];
  const repository = new ChatRepository({ database: await getKindoraDatabase() });
  const sessions = await repository.listSessions();

  const out: ChatHistorySession[] = [];
  for (const session of sessions) {
    const messages = await repository.history(session.sessionId);
    out.push({
      sessionId: session.sessionId,
      peerAgentId: session.peerAgentId,
      peerDisplayName: session.peerDisplayName,
      startedAt: session.startedAt,
      // The storage record marks "not ended" as an *absent* column
      // (`endedAt?: string | null`), while this view's contract says
      // "not ended" is `null`. Normalise here, at the boundary, so the
      // screen never has to tell "still running" apart from "unknown".
      endedAt: session.endedAt ?? null,
      closeReason: session.closeReason ?? null,
      messageCount: messages.length,
      lastMessageAt: messages.length > 0 ? messages[messages.length - 1]!.createdAt : null,
    });
  }
  return out;
}

/**
 * The transcript of one conversation, in order.
 *
 * An unknown session id yields an empty transcript rather than an
 * error: a session may have been deleted between listing and opening.
 */
export async function loadChatTranscript(sessionId: string): Promise<readonly StoredChatMessage[]> {
  if (!isDatabaseAvailable()) return [];
  const repository = new ChatRepository({ database: await getKindoraDatabase() });
  return repository.history(sessionId);
}
