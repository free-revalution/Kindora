/**
 * Chat history screen — Phase D / D2.
 *
 * The task book asks the user to be able to recover a previous
 * conversation after closing and restarting the app. This screen is
 * that recovery: a list of the conversations that happened on this
 * device, and the transcript of the one that is selected.
 *
 * The view is presentational — it renders what the parent loaded. The
 * loading, the database access and the selection all live in
 * `App.tsx`, next to the other screens.
 */

import type { StoredChatMessage } from '@kindora/storage';
import { useTranslate } from '../i18n';
import type { ChatHistorySession } from '../lib/chat-history';

export interface ChatHistoryViewProps {
  /** The conversations, newest first. */
  readonly sessions: readonly ChatHistorySession[];
  /** The transcript of the selected conversation. */
  readonly transcript: readonly StoredChatMessage[];
  /** The id of the selected conversation, or `null`. */
  readonly selectedSessionId: string | null;
  /** True while the list or the transcript is being loaded. */
  readonly loading: boolean;
  /**
   * True when this runtime has no local database (the browser dev
   * server). The screen says so instead of showing an empty list.
   */
  readonly unavailable: boolean;
  /** The display name of the local agent — used to label sent messages. */
  readonly selfDisplayName: string;
  /** Select a conversation. */
  onSelect(sessionId: string): void;
  /** Leave the screen. */
  onClose(): void;
}

export function ChatHistoryView({
  sessions,
  transcript,
  selectedSessionId,
  loading,
  unavailable,
  selfDisplayName,
  onSelect,
  onClose,
}: ChatHistoryViewProps) {
  const t = useTranslate();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            {t('history.eyebrow')}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t('history.title')}</h1>
        </div>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onClose}
          data-testid="history-close"
        >
          {t('common.back')}
        </button>
      </header>

      {unavailable ? (
        <section className="kindora-card" data-testid="history-unavailable">
          <p className="text-sm leading-relaxed">{t('history.unavailable')}</p>
        </section>
      ) : loading && sessions.length === 0 ? (
        <section className="kindora-card" data-testid="history-loading">
          <p className="text-kindora-500 dark:text-kindora-400 text-sm">{t('history.loading')}</p>
        </section>
      ) : sessions.length === 0 ? (
        <section className="kindora-card" data-testid="history-empty">
          <p className="text-sm leading-relaxed">{t('history.empty')}</p>
        </section>
      ) : (
        <>
          <section className="kindora-card flex flex-col gap-2" data-testid="history-sessions">
            {sessions.map((session) => (
              <button
                key={session.sessionId}
                type="button"
                className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left ${
                  session.sessionId === selectedSessionId
                    ? 'border-kindora-400 bg-kindora-50 dark:bg-kindora-800/60'
                    : 'border-kindora-200 dark:border-kindora-700'
                }`}
                onClick={() => onSelect(session.sessionId)}
                data-testid="history-session"
                data-session-id={session.sessionId}
              >
                <span className="flex flex-col">
                  <span className="text-sm font-medium">
                    {session.peerDisplayName || t('history.unnamedPeer')}
                  </span>
                  <span className="text-kindora-500 dark:text-kindora-400 text-xs">
                    {formatDate(session.startedAt)} ·{' '}
                    {t('history.messageCount', { count: session.messageCount })}
                  </span>
                </span>
                <span className="text-kindora-500 dark:text-kindora-400 text-xs">
                  {session.endedAt ? t('history.ended') : t('history.active')}
                </span>
              </button>
            ))}
          </section>

          <section
            className="kindora-card flex min-h-[30vh] flex-col gap-3"
            data-testid="history-transcript"
            data-message-count={transcript.length}
          >
            {selectedSessionId === null ? (
              <p className="text-kindora-500 dark:text-kindora-400 text-sm italic">
                {t('history.selectPrompt')}
              </p>
            ) : transcript.length === 0 ? (
              <p
                className="text-kindora-500 dark:text-kindora-400 text-sm italic"
                data-testid="history-transcript-empty"
              >
                {t('history.transcriptEmpty')}
              </p>
            ) : (
              transcript.map((message) => (
                <HistoryMessage
                  key={message.messageId}
                  message={message}
                  selfDisplayName={selfDisplayName}
                />
              ))
            )}
          </section>
        </>
      )}
    </main>
  );
}

/**
 * One stored message.
 *
 * The delivery state is shown when it is anything other than "fine":
 * a message that is still `PENDING` or that `FAILED` must not look
 * like a message that went out.
 */
function HistoryMessage({
  message,
  selfDisplayName,
}: {
  message: StoredChatMessage;
  selfDisplayName: string;
}) {
  const t = useTranslate();
  const isSent = message.direction === 'sent';
  const align = isSent ? 'items-end' : 'items-start';
  const bubbleClass = isSent
    ? 'border-kindora-300 bg-kindora-50 dark:border-kindora-600 dark:bg-kindora-800/60'
    : 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/30';

  return (
    <div
      className={`flex flex-col gap-1 ${align}`}
      data-testid="history-message"
      data-status={message.status}
    >
      <p className="text-kindora-500 dark:text-kindora-400 text-xs">
        {isSent ? selfDisplayName : t('history.peer')}
        {message.source === 'agent' ? ` · ${t('history.fromAgent')}` : ''}
      </p>
      <p
        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl border px-3 py-2 text-sm leading-relaxed ${bubbleClass}`}
      >
        {message.text}
      </p>
      {message.status === 'PENDING' && (
        <p
          className="text-kindora-500 dark:text-kindora-400 text-xs italic"
          data-testid="history-status-pending"
        >
          {t('history.statusPending')}
        </p>
      )}
      {message.status === 'FAILED' && (
        <p
          className="text-xs italic text-rose-600 dark:text-rose-400"
          data-testid="history-status-failed"
        >
          {t('history.statusFailed')}
        </p>
      )}
    </div>
  );
}

/** A readable date, or an em dash when the timestamp is unusable. */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  } catch {
    return '—';
  }
}
