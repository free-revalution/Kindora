/**
 * ConsentView — Phase 7 human-consent screen.
 *
 * Renders the 4 user actions from 开发手册.md Phase 7:
 *
 *   - Accept    — agree to enter chat
 *   - Reject    — decline; connection closes
 *   - Disconnect — close without a verdict
 *   - Block     — decline + persist the peer's id to the local block list
 *
 * Sits on top of a `LiveMatchView`'s result: the user sees the match
 * outcome first, then chooses what to do. Until both sides accept, the
 * chat is locked.
 *
 * The view consumes a `decide(decision, note?)` callback the parent
 * supplies (typically wrapping `ConsentOrchestrator.decide`). The view
 * is purely presentational — no transport, no LLM, no I/O.
 */

import { useEffect, useRef, useState } from 'react';
import type { MatchOutcome } from '@kindora/matching';
import type { ConsentDecision, ConsentOutcome, ConsentState } from '@kindora/matching';
import { summariseAnalysis } from '@kindora/matching';

export interface ConsentViewProps {
  /** Match outcome from Phase 6 — needed to render the analysis header. */
  readonly outcome: MatchOutcome;
  /** Current consent state. The view disables buttons once terminal. */
  readonly state: ConsentState;
  /** Called when the user clicks Accept / Reject / Block. */
  readonly onDecide: (decision: ConsentDecision, note?: string) => Promise<void> | void;
  /** Called when the user clicks Disconnect. */
  readonly onDisconnect: () => void;
  /**
   * Optional pre-resolved consent outcome. When set, the view shows
   * the final state banner (Accepted / Rejected / Blocked) instead of
   * the live buttons. Use this from a `LiveConsentView` wrapper.
   */
  readonly finalOutcome?: ConsentOutcome;
}

export function ConsentView({
  outcome,
  state,
  onDecide,
  onDisconnect,
  finalOutcome,
}: ConsentViewProps) {
  const local = summariseAnalysis(outcome.localAnalysis);
  // "Terminal" means we hide the action buttons. This happens when:
  //   - A final outcome is set (state-machine finished), OR
  //   - The state itself is terminal (rejected / blocked / accepted_both)
  //     even before the outcome object is wired through.
  const stateIsTerminal =
    state === 'rejected' || state === 'blocked' || state === 'accepted_both';
  const terminal = finalOutcome !== undefined || stateIsTerminal;
  const isBlocked = finalOutcome?.state === 'blocked' || state === 'blocked';
  const isRejected = finalOutcome?.state === 'rejected' || state === 'rejected';
  const isAccepted = finalOutcome?.state === 'accepted_both' || state === 'accepted_both';
  const isTimedOut = finalOutcome?.peerAcceptTimedOut === true;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            {isAccepted
              ? 'Connected with'
              : isBlocked
                ? 'Blocked'
                : isRejected
                  ? 'Connection closed'
                  : 'Match found'}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {outcome.peerDisplayName}
          </h1>
          <p className="text-kindora-500 dark:text-kindora-400 mt-1 font-mono text-xs">
            {outcome.peerAgentId.slice(0, 8)}…
          </p>
        </div>
        <button type="button" className="kindora-button-ghost" onClick={onDisconnect}>
          {isAccepted ? 'Close' : 'Disconnect'}
        </button>
      </header>

      {/* Compatibility signal — quick recap so the user remembers the context. */}
      <section className="kindora-card flex flex-col gap-2">
        <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          Compatibility
        </p>
        <p
          className={`inline-flex w-fit items-center gap-1 rounded-full border px-3 py-1 text-sm ${signalClass(local.signalTone)}`}
        >
          {local.signalLabel}
        </p>
      </section>

      {/* Live status banner */}
      {!terminal && (
        <ConsentStatusBanner state={state} peerName={outcome.peerDisplayName} />
      )}

      {isTimedOut && (
        <section className="kindora-card flex flex-col gap-2">
          <h2 className="text-rose-600 dark:text-rose-400 text-xs uppercase tracking-wide">
            Peer didn’t respond
          </h2>
          <p className="text-sm leading-relaxed">
            You accepted, but {outcome.peerDisplayName} didn’t reply in time. You can close
            this session and try again later.
          </p>
        </section>
      )}

      {isAccepted && (
        <section className="kindora-card flex flex-col gap-2">
          <h2 className="text-emerald-600 dark:text-emerald-400 text-xs uppercase tracking-wide">
            Conversation unlocked
          </h2>
          <p className="text-sm leading-relaxed">
            Both you and {outcome.peerDisplayName} accepted. The chat is open. (Chat lands in
            Phase 9 — for now, this confirms the wire flow works end-to-end.)
          </p>
        </section>
      )}

      {isBlocked && (
        <section className="kindora-card flex flex-col gap-2">
          <h2 className="text-rose-600 dark:text-rose-400 text-xs uppercase tracking-wide">
            {finalOutcome?.blockedByLocal ? 'Blocked' : 'You were blocked'}
          </h2>
          <p className="text-sm leading-relaxed">
            {finalOutcome?.blockedByLocal
              ? `${outcome.peerDisplayName} can no longer reach you. Future pairing requests from this agent are refused.`
              : `${outcome.peerDisplayName} blocked you. Their id has been added to your local block list so you don’t try to reconnect.`}
          </p>
        </section>
      )}

      {/* Action area — live buttons when nothing's decided yet. */}
      {!terminal && (
        <ConsentActions
          state={state}
          onAccept={() => onDecide('accept')}
          onReject={() => onDecide('reject')}
          onBlock={() => onDecide('block')}
        />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function ConsentStatusBanner({ state, peerName }: { state: ConsentState; peerName: string }) {
  let headline: string;
  let body: string;
  let toneClass: string;
  switch (state) {
    case 'awaiting_decision':
      headline = 'Your turn';
      body = `Decide whether to open a conversation with ${peerName}. Both of you must accept before chat is unlocked.`;
      toneClass = 'border-kindora-200 dark:border-kindora-700';
      break;
    case 'accepted_local':
      headline = 'Waiting for them';
      body = `You accepted. Waiting for ${peerName} to accept too.`;
      toneClass = 'border-amber-300 dark:border-amber-700';
      break;
    case 'accepted_peer':
      headline = 'They accepted';
      body = `${peerName} accepted. Click Accept to unlock the conversation.`;
      toneClass = 'border-amber-300 dark:border-amber-700';
      break;
    case 'accepted_both':
      headline = 'Both accepted';
      body = 'Conversation unlocked.';
      toneClass = 'border-emerald-300 dark:border-emerald-700';
      break;
    case 'rejected':
      headline = 'Connection rejected';
      body = 'The match was declined.';
      toneClass = 'border-rose-300 dark:border-rose-700';
      break;
    case 'blocked':
      headline = 'Blocked';
      body = 'Future pairing requests from this agent are refused.';
      toneClass = 'border-rose-300 dark:border-rose-700';
      break;
  }
  return (
    <section
      className={`kindora-card flex flex-col gap-2 border ${toneClass}`}
      data-testid="consent-status"
    >
      <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {headline}
      </h2>
      <p className="text-sm leading-relaxed">{body}</p>
    </section>
  );
}

function ConsentActions({
  state,
  onAccept,
  onReject,
  onBlock,
}: {
  state: ConsentState;
  onAccept: () => void;
  onReject: () => void;
  onBlock: () => void;
}) {
  // Buttons stay enabled until a terminal state is reached. The
  // "accept" button is highlighted positively; reject/block are
  // styled to look destructive.
  const disabled = state === 'accepted_both' || state === 'rejected' || state === 'blocked';
  return (
    <section className="kindora-card flex flex-col gap-3">
      <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        What do you want to do?
      </h2>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="kindora-button"
          onClick={onAccept}
          disabled={disabled}
          data-testid="consent-accept"
        >
          Accept
        </button>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onReject}
          disabled={disabled}
          data-testid="consent-reject"
        >
          Reject
        </button>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onBlock}
          disabled={disabled}
          data-testid="consent-block"
        >
          Block
        </button>
      </div>
      <p className="text-kindora-500 dark:text-kindora-400 text-xs">
        Block stores the peer’s id locally so they can’t pair with you again. Reject closes
        this connection only.
      </p>
    </section>
  );
}

function signalClass(tone: 'positive' | 'neutral' | 'cautious'): string {
  if (tone === 'positive') {
    return 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-100';
  }
  if (tone === 'cautious') {
    return 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-900/40 dark:text-rose-100';
  }
  return 'border-kindora-200 bg-kindora-50 text-kindora-800 dark:border-kindora-700 dark:bg-kindora-800/40 dark:text-kindora-100';
}

/* ------------------------------------------------------------------ */
/* Live wrapper — drives a single `runConsent()` call and updates state */
/* ------------------------------------------------------------------ */

export interface LiveConsentViewProps {
  /** The match outcome from Phase 6. */
  readonly outcome: MatchOutcome;
  /** Async function that starts the consent orchestrator. */
  readonly start: () => Promise<ConsentOutcome>;
  /** Async function called when the user clicks Accept / Reject / Block. */
  readonly decide: (decision: ConsentDecision, note?: string) => Promise<void>;
  /** Called when the user clicks Disconnect / Close. */
  readonly onDisconnect: () => void;
  /**
   * Optional callback fired when the consent reaches a terminal state
   * (accepted_both / rejected / blocked). The parent uses this to
   * route to the chat (Phase 9) or back to home.
   */
  readonly onFinal?: (outcome: ConsentOutcome) => void;
}

export function LiveConsentView({
  outcome,
  start,
  decide,
  onDisconnect,
  onFinal,
}: LiveConsentViewProps) {
  const [state, setState] = useState<ConsentState>('awaiting_decision');
  const [final, setFinal] = useState<ConsentOutcome | undefined>(undefined);

  // Capture props in refs so the effect only runs once on mount.
  const startRef = useRef(start);
  startRef.current = start;
  const decideRef = useRef(decide);
  decideRef.current = decide;
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    let cancelled = false;
    startRef
      .current()
      .then(async (outcome) => {
        if (cancelled) return;
        setState(outcome.state);
        setFinal(outcome);
        if (outcome.state !== 'awaiting_decision' && outcome.state !== 'accepted_local' && outcome.state !== 'accepted_peer') {
          onFinalRef.current?.(outcome);
        }
      })
      .catch(() => {
        // start() never rejects — see ConsentOrchestrator.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDecide(decision: ConsentDecision, note?: string): Promise<void> {
    // Optimistic local state update so the UI feels responsive; the
    // orchestrator's `decide()` will confirm.
    if (decision === 'accept') setState((s) => (s === 'accepted_peer' ? 'accepted_both' : 'accepted_local'));
    if (decision === 'reject') setState('rejected');
    if (decision === 'block') setState('blocked');
    await decideRef.current(decision, note);
  }

  return (
    <ConsentView
      outcome={outcome}
      state={state}
      onDecide={handleDecide}
      onDisconnect={onDisconnect}
      {...(final ? { finalOutcome: final } : {})}
    />
  );
}
