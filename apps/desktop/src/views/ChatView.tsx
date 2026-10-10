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
 * Phase 10 adds the "Ask My Agent" panel (§ 31). The agent only
 * SUGGESTS — the human reviews before any suggestion is sent. The
 * panel renders suggestions with [Use] / [Edit] / [Regenerate] /
 * [Dismiss]. [Use] fills the composer draft; the user still has to
 * click Send. [Edit] opens an inline textarea. [Regenerate] re-runs
 * the assistant round-trip. [Dismiss] closes the panel.
 *
 * The view is purely presentational — it consumes a `ChatSnapshot`
 * from `ChatOrchestrator` and emits intents. The live wrapper drives
 * the orchestrator.
 */

import { useEffect, useRef, useState } from 'react';
import {
  summariseChatAssist,
  type ChatAssistDisplay,
  type ChatAssistDisplaySuggestion,
  type ChatAssistHandle,
} from '@kindora/matching';
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
  readonly assistant: ChatAssistPanelState;
  onDraftChange(next: string): void;
  onSend(): void;
  onDisconnect(): void;
  onBlock(): void;
  /** When the user clicks Use on a suggestion — fills the composer draft. */
  onUseSuggestion(text: string): void;
  /** Phase 10 — assistant panel callbacks. */
  onAskOpen(): void;
  onAskClose(): void;
  onAskChangeQuery(next: string): void;
  onAskSubmit(): void;
  onAskRegenerate(): void;
  onAskDismissSuggestion(id: string): void;
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
  assistant,
  onDraftChange,
  onSend,
  onDisconnect,
  onBlock,
  onUseSuggestion,
  onAskOpen,
  onAskClose,
  onAskChangeQuery,
  onAskSubmit,
  onAskRegenerate,
  onAskDismissSuggestion,
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

      <ChatAssistPanel
        state={assistant}
        disabled={isClosed}
        onAskOpen={onAskOpen}
        onAskClose={onAskClose}
        onAskChangeQuery={onAskChangeQuery}
        onAskSubmit={onAskSubmit}
        onAskRegenerate={onAskRegenerate}
        onUseSuggestion={onUseSuggestion}
        onAskDismissSuggestion={onAskDismissSuggestion}
      />

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
/* Phase 10 — "Ask My Agent" panel                                     */
/* ------------------------------------------------------------------ */

/**
 * Phase 10 panel state. The live wrapper drives these fields; the
 * presentational view only renders them.
 */
export interface ChatAssistPanelState {
  /** Whether the panel is open at all. Closed = no UI shown. */
  readonly open: boolean;
  /** Whether the LLM round-trip is in flight. */
  readonly busy: boolean;
  /** True iff no chat-assist handle is available (e.g. no LLM). */
  readonly unavailable: boolean;
  /** Reason the assistant is unavailable — shown as a small note. */
  readonly unavailableReason: string | undefined;
  /** Error from the most recent round-trip (parser / network). */
  readonly error: string | undefined;
  /** The user's free-text query. */
  readonly query: string;
  /** Parsed reply — already shaped for display by `summariseChatAssist`. */
  readonly display: ChatAssistDisplay | null;
  /** Set of suggestion ids the user has dismissed. */
  readonly dismissedIds: readonly string[];
}

function ChatAssistPanel({
  state,
  disabled,
  onAskOpen,
  onAskClose,
  onAskChangeQuery,
  onAskSubmit,
  onAskRegenerate,
  onUseSuggestion,
  onAskDismissSuggestion,
}: {
  state: ChatAssistPanelState;
  disabled: boolean;
  onAskOpen(): void;
  onAskClose(): void;
  onAskChangeQuery(next: string): void;
  onAskSubmit(): void;
  onAskRegenerate(): void;
  onUseSuggestion(text: string): void;
  onAskDismissSuggestion(id: string): void;
}) {
  // Closed panel: show a single button.
  if (!state.open) {
    return (
      <section className="kindora-card flex flex-wrap items-center justify-between gap-2" data-testid="chat-assist-closed">
        <p className="text-kindora-500 dark:text-kindora-400 text-sm">
          Stuck? Ask your agent for help.
        </p>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onAskOpen}
          disabled={disabled || state.unavailable}
          data-testid="chat-assist-open"
        >
          Ask My Agent
        </button>
      </section>
    );
  }

  const visibleSuggestions = (state.display?.suggestions ?? []).filter(
    (s) => !state.dismissedIds.includes(s.id),
  );

  const canSubmit = !state.busy && state.query.trim().length > 0;

  return (
    <section className="kindora-card flex flex-col gap-3" data-testid="chat-assist-panel">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            Ask My Agent
          </p>
          <p className="mt-1 text-sm leading-relaxed">
            Suggestions from your agent. The human reviews every one — nothing is sent
            until you click Send yourself.
          </p>
        </div>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onAskClose}
          disabled={state.busy}
          data-testid="chat-assist-close"
        >
          Close
        </button>
      </header>

      {state.unavailable && (
        <p
          className="text-kindora-500 dark:text-kindora-400 text-xs italic"
          data-testid="chat-assist-unavailable"
        >
          {state.unavailableReason ??
            'Assistant is not available right now (no LLM configured).'}
        </p>
      )}

      {!state.unavailable && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onAskSubmit();
          }}
          data-testid="chat-assist-form"
        >
          <label
            htmlFor="chat-assist-query"
            className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide"
          >
            What do you want help with?
          </label>
          <textarea
            id="chat-assist-query"
            className="border-kindora-200 dark:border-kindora-700 min-h-[3.5rem] w-full resize-none rounded-md border bg-transparent p-2 text-sm leading-relaxed disabled:opacity-50"
            rows={2}
            value={state.query}
            onChange={(e) => onAskChangeQuery(e.target.value)}
            placeholder='e.g. "help me reply to their last message" or "what should I ask them next?"'
            disabled={state.busy}
            data-testid="chat-assist-query"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-kindora-500 dark:text-kindora-400 text-xs">
              Phase 10 · AI only suggests — it never sends for you (§ 32).
            </p>
            <button
              type="submit"
              className="kindora-button"
              disabled={!canSubmit}
              data-testid="chat-assist-submit"
            >
              {state.busy ? 'Thinking…' : 'Ask'}
            </button>
          </div>
        </form>
      )}

      {state.error && (
        <section
          className="flex flex-col gap-1 border border-rose-300 dark:border-rose-700 rounded-md p-2"
          data-testid="chat-assist-error"
        >
          <p className="text-rose-600 dark:text-rose-400 text-xs">{state.error}</p>
        </section>
      )}

      {state.busy && visibleSuggestions.length === 0 && (
        <p
          className="text-kindora-500 dark:text-kindora-400 text-sm italic"
          data-testid="chat-assist-loading"
        >
          Your agent is reading the chat…
        </p>
      )}

      {!state.busy && state.display && visibleSuggestions.length === 0 && state.display.suggestions.length === 0 && (
        <p
          className="text-kindora-500 dark:text-kindora-400 text-sm italic"
          data-testid="chat-assist-empty"
        >
          {state.display.summary || 'No suggestions came back.'}
        </p>
      )}

      {visibleSuggestions.length > 0 && (
        <section
          className="flex flex-col gap-3"
          data-testid="chat-assist-suggestions"
          data-suggestion-count={visibleSuggestions.length}
        >
          {state.display?.summary && (
            <p className="text-kindora-500 dark:text-kindora-400 text-xs italic">
              {state.display.summary}
            </p>
          )}
          {visibleSuggestions.map((s) => (
            <ChatAssistSuggestionRow
              key={s.id}
              suggestion={s}
              onUse={onUseSuggestion}
              onDismiss={onAskDismissSuggestion}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="kindora-button-ghost"
              onClick={onAskRegenerate}
              disabled={state.busy || !state.query.trim()}
              data-testid="chat-assist-regenerate"
            >
              Regenerate
            </button>
          </div>
        </section>
      )}
    </section>
  );
}

function ChatAssistSuggestionRow({
  suggestion,
  onUse,
  onDismiss,
}: {
  suggestion: ChatAssistDisplaySuggestion;
  onUse(text: string): void;
  onDismiss(id: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(suggestion.text);

  useEffect(() => {
    setDraft(suggestion.text);
  }, [suggestion.text]);

  if (editing) {
    return (
      <article
        className="kindora-card flex flex-col gap-2"
        data-testid="chat-assist-suggestion"
        data-kind={suggestion.kind}
      >
        <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {suggestion.kindLabel}
        </p>
        <textarea
          className="border-kindora-200 dark:border-kindora-700 w-full resize-none rounded-md border bg-transparent p-2 text-sm leading-relaxed"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="chat-assist-edit-textarea"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="kindora-button"
            onClick={() => {
              const trimmed = draft.trim();
              if (!trimmed) return;
              onUse(trimmed);
              setEditing(false);
            }}
            disabled={draft.trim().length === 0}
            data-testid="chat-assist-use"
          >
            Use edited
          </button>
          <button
            type="button"
            className="kindora-button-ghost"
            onClick={() => {
              setDraft(suggestion.text);
              setEditing(false);
            }}
            data-testid="chat-assist-cancel-edit"
          >
            Cancel
          </button>
        </div>
      </article>
    );
  }

  return (
    <article
      className="kindora-card flex flex-col gap-2"
      data-testid="chat-assist-suggestion"
      data-kind={suggestion.kind}
    >
      <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {suggestion.kindLabel}
      </p>
      <p className="text-sm leading-relaxed">{suggestion.text}</p>
      {suggestion.rationale && (
        <p className="text-kindora-500 dark:text-kindora-400 text-xs italic">
          {suggestion.rationale}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="kindora-button"
          onClick={() => onUse(suggestion.text)}
          data-testid="chat-assist-use"
        >
          Use
        </button>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={() => setEditing(true)}
          data-testid="chat-assist-edit"
        >
          Edit
        </button>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={() => onDismiss(suggestion.id)}
          data-testid="chat-assist-dismiss"
        >
          Dismiss
        </button>
      </div>
    </article>
  );
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
  /**
   * Phase 10 — chat-assist handle (built lazily by the parent). When
   * `null` the assistant panel is rendered as unavailable. When set,
   * the panel uses `handle.ask(query)` to run a single round-trip.
   */
  readonly chatAssist: ChatAssistHandle | null;
  /** Reason the assistant is unavailable (e.g. "No LLM configured."). */
  readonly chatAssistError?: string | undefined;
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
  chatAssist,
  chatAssistError,
}: LiveChatViewProps) {
  const [snapshot, setSnapshot] = useState<ChatSnapshot | undefined>(undefined);
  const [draft, setDraft] = useState(initialDraft ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Phase 10 — assistant panel state.
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistQuery, setAssistQuery] = useState('');
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistError, setAssistError] = useState<string | undefined>(undefined);
  const [assistDisplay, setAssistDisplay] = useState<ChatAssistDisplay | null>(null);
  const [assistDismissed, setAssistDismissed] = useState<readonly string[]>([]);

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
  const chatAssistRef = useRef(chatAssist);
  chatAssistRef.current = chatAssist;

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

  /* ---------- Phase 10 panel handlers ---------- */

  function applySuggestion(text: string): void {
    // Use → fills the composer draft (per § 32 the AI never auto-sends).
    setDraft(text);
  }

  async function runAssist(rawQuery: string): Promise<void> {
    const handle = chatAssistRef.current;
    const query = rawQuery.trim();
    if (!handle || !query) return;
    setAssistBusy(true);
    setAssistError(undefined);
    setAssistDismissed([]);
    try {
      const result = await handle.orchestrator.ask(query);
      const display = summariseChatAssist(result.reply);
      setAssistDisplay(display);
      if (result.degraded && result.degradationNote) {
        setAssistError(result.degradationNote);
      }
      if (result.boundaryBlocked) {
        setAssistError(
          'Both profiles disallow agent conversation — assistant is disabled for this chat.',
        );
      }
    } catch (e: unknown) {
      setAssistError(e instanceof Error ? e.message : String(e));
    } finally {
      setAssistBusy(false);
    }
  }

  function handleAskOpen(): void {
    setAssistOpen(true);
  }
  function handleAskClose(): void {
    setAssistOpen(false);
  }
  function handleAskChangeQuery(next: string): void {
    setAssistQuery(next);
  }
  function handleAskSubmit(): void {
    void runAssist(assistQuery);
  }
  function handleAskRegenerate(): void {
    void runAssist(assistQuery);
  }
  function handleAskDismiss(id: string): void {
    setAssistDismissed((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  const assistant: ChatAssistPanelState = {
    open: assistOpen,
    busy: assistBusy,
    unavailable: chatAssist === null,
    unavailableReason: chatAssist === null ? chatAssistError : undefined,
    error: assistError,
    query: assistQuery,
    display: assistDisplay,
    dismissedIds: assistDismissed,
  };

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
      assistant={assistant}
      onDraftChange={setDraft}
      onSend={handleSend}
      onDisconnect={() => void onDisconnectRef.current()}
      onBlock={() => void onBlockRef.current()}
      onUseSuggestion={applySuggestion}
      onAskOpen={handleAskOpen}
      onAskClose={handleAskClose}
      onAskChangeQuery={handleAskChangeQuery}
      onAskSubmit={handleAskSubmit}
      onAskRegenerate={handleAskRegenerate}
      onAskDismissSuggestion={handleAskDismiss}
    />
  );
}