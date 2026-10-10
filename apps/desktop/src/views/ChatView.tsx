/**
 * ChatView — Phase 9 human-to-human chat screen.
 *
 * Per 开发手册.md § 30, Phase 9 — the default chat is two-party
 * (Human A ↕ Human B). The view supports:
 *
 *   - Send       — local textarea + Send button
 *   - Receive    — peer `chat_message` envelopes appear in history
 *   - History    — chronological list of entries (sent + received)
 *   - Disconnect — close the session, no verdict
 *   - Block      — persist peer's id + close the session
 *
 * Per § 32: AI does not auto-send. The view never inserts anything
 * into history on the user's behalf — every entry in history comes
 * from a real envelope (sent by the local user via Send, or received
 * from the peer via the wire).
 *
 * The view is purely presentational — it consumes a `ChatSnapshot`
 * from `ChatOrchestrator` and emits intents. The live wrapper drives
 * the orchestrator.
 */

import { useEffect, useRef, useState } from 'react';
import type { ChatSnapshot } from '@kindora/matching';

export type ChatPhase = 'loading' | 'open' | 'closed';

export interface ChatViewProps {
  readonly peerDisplayName: string;
  readonly selfDisplayName: string;
  readonly snapshot: ChatSnapshot;
  readonly phase: ChatPhase;
  readonly draft: string;
  readonly sending: boolean;
  readonly maxTextLength: number;
  readonly error: string | undefined;
  onDraftChange(next: string): void;
  onSend(): void;
  onDisconnect(): void;
  onBlock(): void;
}

export function ChatView({
  peerDisplayName,
  selfDisplayName,
  snapshot,
  phase,
  draft,
  sending,
  maxTextLength,
  error,
  onDraftChange,
  onSend,
  onDisconnect,
  onBlock,
}: ChatViewProps) {
  const isClosed = snapshot.state === 'closed';
  const trimmed = draft.trim();
  const canSend =
    phase === 'open' && !isClosed && !sending && trimmed.length > 0 && trimmed.length <= maxTextLength;
  const textTooLong = trimmed.length > maxTextLength;

  return (
    <main className="mx-auto flex h-full min-h-screen w-full max-w-2xl flex-col gap-4 px-6 py-6">
      <header className="flex items-start justify-between" data-testid="chat-header">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            Chat with
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {peerDisplayName}
          </h1>
          <p className="text-kindora-500 dark:text-kindora-400 mt-1 text-sm">
            You: {selfDisplayName}
          </p>
        </div>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onDisconnect}
          data-testid="chat-close"
        >
          {isClosed ? 'Back' : 'Disconnect'}
        </button>
      </header>

      {snapshot.blockedByLocal && (
        <section
          className="kindora-card flex flex-col gap-2 border border-rose-300 dark:border-rose-700"
          data-testid="chat-blocked-local"
        >
          <h2 className="text-rose-600 dark:text-rose-400 text-xs uppercase tracking-wide">
            Blocked
          </h2>
          <p className="text-sm leading-relaxed">
            You blocked {peerDisplayName}. Their id is on your local block list; future
            pairing requests will be refused automatically.
          </p>
        </section>
      )}

      {snapshot.blockedByPeer && (
        <section
          className="kindora-card flex flex-col gap-2 border border-rose-300 dark:border-rose-700"
          data-testid="chat-blocked-peer"
        >
          <h2 className="text-rose-600 dark:text-rose-400 text-xs uppercase tracking-wide">
            You were blocked
          </h2>
          <p className="text-sm leading-relaxed">
            {peerDisplayName} blocked you. Their id has been added to your local block
            list so you don’t try to reconnect.
          </p>
        </section>
      )}

      {isClosed && snapshot.closeReason === 'peer-disconnect' && (
        <section className="kindora-card flex flex-col gap-2" data-testid="chat-peer-left">
          <p className="text-sm leading-relaxed">
            {peerDisplayName} closed the conversation.
          </p>
        </section>
      )}

      <section
        className="kindora-card flex min-h-[40vh] flex-col gap-3"
        data-testid="chat-history"
        data-entry-count={snapshot.entries.length}
      >
        {snapshot.entries.length === 0 && (
          <p
            className="text-kindora-500 dark:text-kindora-400 text-sm italic"
            data-testid="chat-history-empty"
          >
            {phase === 'open'
              ? 'No messages yet — say hi.'
              : 'No messages exchanged.'}
          </p>
        )}
        {snapshot.entries.map((entry) => (
          <ChatBubble
            key={entry.id}
            direction={entry.direction}
            text={entry.text}
            timestamp={entry.timestamp}
            peerDisplayName={peerDisplayName}
          />
        ))}
      </section>

      {error && (
        <section
          className="kindora-card flex flex-col gap-2 border border-rose-300 dark:border-rose-700"
          data-testid="chat-error"
        >
          <p className="text-rose-600 dark:text-rose-400 text-sm">{error}</p>
        </section>
      )}

      <form
        className="kindora-card flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) onSend();
        }}
        data-testid="chat-composer"
      >
        <label
          htmlFor="chat-input"
          className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide"
        >
          Message
        </label>
        <textarea
          id="chat-input"
          className="border-kindora-200 dark:border-kindora-700 min-h-[5rem] w-full resize-none rounded-md border bg-transparent p-2 text-sm leading-relaxed disabled:opacity-50"
          rows={3}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder={
            isClosed ? 'Chat is closed.' : `Message ${peerDisplayName}…`
          }
          disabled={isClosed || sending}
          maxLength={maxTextLength * 2 /* allow typing past, validate below */}
          data-testid="chat-input"
        />
        <div className="flex items-center justify-between gap-2">
          <p
            className={`text-xs ${
              textTooLong
                ? 'text-rose-600 dark:text-rose-400'
                : 'text-kindora-500 dark:text-kindora-400'
            }`}
            data-testid="chat-counter"
          >
            {trimmed.length} / {maxTextLength}
          </p>
          <button
            type="submit"
            className="kindora-button"
            disabled={!canSend}
            data-testid="chat-send"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>

      <footer className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onBlock}
          disabled={isClosed || snapshot.blockedByLocal}
          data-testid="chat-block"
        >
          {snapshot.blockedByLocal ? 'Already blocked' : 'Block'}
        </button>
        <p className="text-kindora-500 dark:text-kindora-400 text-xs">
          AI never sends — every entry here came from a real human.
        </p>
      </footer>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Chat bubble — one entry in the history                              */
/* ------------------------------------------------------------------ */

function ChatBubble({
  direction,
  text,
  timestamp,
  peerDisplayName,
}: {
  direction: 'sent' | 'received';
  text: string;
  timestamp: string;
  peerDisplayName: string;
}) {
  const isSent = direction === 'sent';
  const align = isSent ? 'items-end' : 'items-start';
  const label = isSent ? 'You' : peerDisplayName;
  const bubbleClass = isSent
    ? 'border-kindora-300 bg-kindora-50 dark:border-kindora-600 dark:bg-kindora-800/60'
    : 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/30';
  return (
    <div
      className={`flex flex-col gap-1 ${align}`}
      data-testid="chat-bubble"
      data-direction={direction}
    >
      <p className="text-kindora-500 dark:text-kindora-400 text-xs">
        {label} · {formatTime(timestamp)}
      </p>
      <p
        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl border px-3 py-2 text-sm leading-relaxed ${bubbleClass}`}
      >
        {text}
      </p>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Live wrapper — drives a single ChatOrchestrator                     */
/* ------------------------------------------------------------------ */

export interface LiveChatViewProps {
  readonly peerDisplayName: string;
  readonly selfDisplayName: string;
  /**
   * Async function that starts the chat orchestrator. Resolves when
   * the chat session closes for any reason.
   */
  readonly run: () => Promise<ChatSnapshot>;
  /** Initial draft — typically the chosen icebreaker message. */
  readonly initialDraft?: string;
  /** Max text length — forwarded to the input. */
  readonly maxTextLength: number;
  /**
   * Subscribes to orchestrator updates. Called immediately with the
   * current snapshot, then again whenever an entry is appended or
   * the session closes. Returns an unsubscribe function.
   */
  readonly subscribe?: (listener: (snap: ChatSnapshot) => void) => () => void;
  /**
   * Called when the user submits a non-empty message. The parent is
   * responsible for routing it through the orchestrator's send().
   */
  readonly onSend: (text: string) => Promise<void> | void;
  /** Called when the user clicks Disconnect. */
  readonly onDisconnect: () => Promise<void> | void;
  /** Called when the user clicks Block. */
  readonly onBlock: () => Promise<void> | void;
}

export function LiveChatView({
  peerDisplayName,
  selfDisplayName,
  run,
  initialDraft,
  maxTextLength,
  subscribe,
  onSend,
  onDisconnect,
  onBlock,
}: LiveChatViewProps) {
  const [snapshot, setSnapshot] = useState<ChatSnapshot | undefined>(undefined);
  const [draft, setDraft] = useState(initialDraft ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const runRef = useRef(run);
  runRef.current = run;
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;
  const onBlockRef = useRef(onBlock);
  onBlockRef.current = onBlock;

  useEffect(() => {
    let cancelled = false;
    // Subscribe first so we don't miss the initial snapshot or any
    // updates that arrive between start() and our first setSnapshot.
    const off = subscribeRef.current
      ? subscribeRef.current((s) => {
          if (!cancelled) setSnapshot(s);
        })
      : undefined;
    runRef
      .current()
      .then((snap) => {
        if (cancelled) return;
        setSnapshot(snap);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  if (!snapshot) {
    return (
      <main
        className="text-kindora-500 flex h-full min-h-screen items-center justify-center text-sm"
        data-testid="chat-loading"
      >
        Opening chat…
      </main>
    );
  }

  async function handleSend(): Promise<void> {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setError(undefined);
    try {
      await onSendRef.current(text);
      // After a successful send, optimistically clear the draft.
      // The actual entry arrives via the snapshot subscription and
      // re-renders the history.
      setDraft('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <ChatView
      peerDisplayName={peerDisplayName}
      selfDisplayName={selfDisplayName}
      snapshot={snapshot}
      phase={snapshot.state === 'closed' ? 'closed' : 'open'}
      draft={draft}
      sending={sending}
      maxTextLength={maxTextLength}
      error={error}
      onDraftChange={setDraft}
      onSend={handleSend}
      onDisconnect={() => void onDisconnectRef.current()}
      onBlock={() => void onBlockRef.current()}
    />
  );
}