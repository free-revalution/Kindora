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
 * ## Phase B — the consent comes BEFORE the match
 *
 * Before Phase B this screen sat on top of a `LiveMatchView`'s result:
 * the user saw the compatibility analysis first, then decided. That
 * order meant the peer's **full profile** had already been exchanged —
 * the analysis was computed from it — before the user had agreed to
 * anything.
 *
 * Task book § 五 B2 reverses it:
 *
 *   1. the public cards are exchanged (see `IdentifyView`);
 *   2. the user decides, here, seeing only the peer's **public card**;
 *   3. only after both sides accept are the authorised profiles
 *      exchanged and the analysis run.
 *
 * So this view consumes a `PeerIntroduction`, not a `MatchOutcome`.
 * There is no compatibility signal to show yet — and that is the
 * honest state of the world at this point in the flow.
 *
 * The view is purely presentational — no transport, no LLM, no I/O.
 */

import { useEffect, useRef, useState } from 'react';
import type { PeerIntroduction } from '@kindora/matching';
import type { ConsentDecision, ConsentOutcome, ConsentState } from '@kindora/matching';
import {
  CONVERSATION_STYLE_KEYS,
  SOCIAL_INTENT_SHORT_KEYS,
  useTranslate,
  type TranslationKey,
} from '../i18n';

export interface ConsentViewProps {
  /**
   * The peer's public card — everything we know about them at the
   * moment the user is asked to decide.
   */
  readonly peer: PeerIntroduction;
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
  peer,
  state,
  onDecide,
  onDisconnect,
  finalOutcome,
}: ConsentViewProps) {
  const t = useTranslate();
  // "Terminal" means we hide the action buttons. This happens when:
  //   - A final outcome is set (state-machine finished), OR
  //   - The state itself is terminal (rejected / blocked / accepted_both)
  //     even before the outcome object is wired through.
  const stateIsTerminal = state === 'rejected' || state === 'blocked' || state === 'accepted_both';
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
            {t(
              isAccepted
                ? 'consent.eyebrowAccepted'
                : isBlocked
                  ? 'consent.eyebrowBlocked'
                  : isRejected
                    ? 'consent.eyebrowClosed'
                    : 'consent.eyebrowPeerFound',
            )}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{peer.peerDisplayName}</h1>
          <p className="text-kindora-500 dark:text-kindora-400 mt-1 font-mono text-xs">
            {peer.peerAgentId.slice(0, 8)}…
          </p>
        </div>
        <button type="button" className="kindora-button-ghost" onClick={onDisconnect}>
          {t(isAccepted ? 'consent.close' : 'consent.disconnect')}
        </button>
      </header>

      {/* The peer's public card — the only thing that has been shared
          so far, and the basis of the decision. */}
      <PublicCardSection peer={peer} />

      {/* Live status banner */}
      {!terminal && <ConsentStatusBanner state={state} peerName={peer.peerDisplayName} />}

      {isTimedOut && (
        <section className="kindora-card flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wide text-rose-600 dark:text-rose-400">
            {t('consent.peerNoResponse')}
          </h2>
          <p className="text-sm leading-relaxed">
            {t('consent.peerNoResponseBody', { peer: peer.peerDisplayName })}
          </p>
        </section>
      )}

      {isAccepted && (
        <section className="kindora-card flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
            {t('consent.unlocked')}
          </h2>
          <p className="text-sm leading-relaxed">
            {t('consent.unlockedBody', { peer: peer.peerDisplayName })}
          </p>
        </section>
      )}

      {isBlocked && (
        <section className="kindora-card flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wide text-rose-600 dark:text-rose-400">
            {t(finalOutcome?.blockedByLocal ? 'consent.blockedLocal' : 'consent.blockedByPeer')}
          </h2>
          <p className="text-sm leading-relaxed">
            {t(
              finalOutcome?.blockedByLocal
                ? 'consent.blockedLocalBody'
                : 'consent.blockedByPeerBody',
              { peer: peer.peerDisplayName },
            )}
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
/* Public card section                                                 */
/* ------------------------------------------------------------------ */

/**
 * What the peer has shared so far.
 *
 * Phase B: the card carries the peer's nickname and — only if the peer
 * authorised them — the social intent and the conversation style. The
 * note underneath is the point of the whole screen: the rest of their
 * profile is not here, and will not be shared unless the user agrees.
 */
function PublicCardSection({ peer }: { peer: PeerIntroduction }) {
  const t = useTranslate();
  const card = peer.peerCard;
  if (!card) {
    return (
      <section className="kindora-card flex flex-col gap-2">
        <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {t('consent.publicCard')}
        </p>
        <p className="text-sm leading-relaxed">{t('consent.publicCardEmpty')}</p>
      </section>
    );
  }
  return (
    <section className="kindora-card flex flex-col gap-3" data-testid="consent-public-card">
      <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {t('consent.publicCard')}
      </p>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-kindora-500 dark:text-kindora-400">{t('consent.cardNickname')}</dt>
          <dd className="font-medium">{card.nickname}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-kindora-500 dark:text-kindora-400">{t('consent.cardIntent')}</dt>
          <dd className="text-right">
            {card.socialIntent.length === 0
              ? t('consent.cardHidden')
              : card.socialIntent.map((i) => t(SOCIAL_INTENT_SHORT_KEYS[i])).join(' · ')}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-kindora-500 dark:text-kindora-400">{t('consent.cardStyle')}</dt>
          <dd className="text-right">
            {card.conversationStyle.length === 0
              ? t('consent.cardHidden')
              : card.conversationStyle.map((s) => t(CONVERSATION_STYLE_KEYS[s])).join(' · ')}
          </dd>
        </div>
      </dl>
      <p className="text-kindora-500 dark:text-kindora-400 text-xs leading-relaxed">
        {t('consent.publicCardNote')}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

const CONSENT_BANNER_KEYS: Readonly<
  Record<ConsentState, { headline: TranslationKey; body: TranslationKey }>
> = {
  awaiting_decision: {
    headline: 'consent.bannerAwaitingHeadline',
    body: 'consent.bannerAwaitingBody',
  },
  accepted_local: {
    headline: 'consent.bannerAcceptedLocalHeadline',
    body: 'consent.bannerAcceptedLocalBody',
  },
  accepted_peer: {
    headline: 'consent.bannerAcceptedPeerHeadline',
    body: 'consent.bannerAcceptedPeerBody',
  },
  accepted_both: {
    headline: 'consent.bannerAcceptedBothHeadline',
    body: 'consent.bannerAcceptedBothBody',
  },
  rejected: {
    headline: 'consent.bannerRejectedHeadline',
    body: 'consent.bannerRejectedBody',
  },
  blocked: {
    headline: 'consent.bannerBlockedHeadline',
    body: 'consent.bannerBlockedBody',
  },
};

const CONSENT_TONE_CLASS: Readonly<Record<ConsentState, string>> = {
  awaiting_decision: 'border-kindora-200 dark:border-kindora-700',
  accepted_local: 'border-amber-300 dark:border-amber-700',
  accepted_peer: 'border-amber-300 dark:border-amber-700',
  accepted_both: 'border-emerald-300 dark:border-emerald-700',
  rejected: 'border-rose-300 dark:border-rose-700',
  blocked: 'border-rose-300 dark:border-rose-700',
};

function ConsentStatusBanner({ state, peerName }: { state: ConsentState; peerName: string }) {
  const t = useTranslate();
  const keys = CONSENT_BANNER_KEYS[state];
  return (
    <section
      className={`kindora-card flex flex-col gap-2 border ${CONSENT_TONE_CLASS[state]}`}
      data-testid="consent-status"
    >
      <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {t(keys.headline)}
      </h2>
      <p className="text-sm leading-relaxed">{t(keys.body, { peer: peerName })}</p>
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
  const t = useTranslate();
  const disabled = state === 'accepted_both' || state === 'rejected' || state === 'blocked';
  return (
    <section className="kindora-card flex flex-col gap-3">
      <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {t('consent.whatToDo')}
      </h2>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="kindora-button"
          onClick={onAccept}
          disabled={disabled}
          data-testid="consent-accept"
        >
          {t('consent.accept')}
        </button>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onReject}
          disabled={disabled}
          data-testid="consent-reject"
        >
          {t('consent.reject')}
        </button>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onBlock}
          disabled={disabled}
          data-testid="consent-block"
        >
          {t('consent.block')}
        </button>
      </div>
      <p className="text-kindora-500 dark:text-kindora-400 text-xs">{t('consent.actionsNote')}</p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Live wrapper — drives a single `runConsent()` call and updates state */
/* ------------------------------------------------------------------ */

export interface LiveConsentViewProps {
  /** The peer's public card — the basis of the decision. */
  readonly peer: PeerIntroduction;
  /** Async function that starts the consent orchestrator. */
  readonly start: () => Promise<ConsentOutcome>;
  /** Async function called when the user clicks Accept / Reject / Block. */
  readonly decide: (decision: ConsentDecision, note?: string) => Promise<void>;
  /** Called when the user clicks Disconnect / Close. */
  readonly onDisconnect: () => void;
  /**
   * Optional callback fired when the consent reaches a terminal state
   * (accepted_both / rejected / blocked). The parent uses this to
   * route to the match (Phase 6) or back to home.
   */
  readonly onFinal?: (outcome: ConsentOutcome) => void;
}

export function LiveConsentView({
  peer,
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
        if (
          outcome.state !== 'awaiting_decision' &&
          outcome.state !== 'accepted_local' &&
          outcome.state !== 'accepted_peer'
        ) {
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
    if (decision === 'accept')
      setState((s) => (s === 'accepted_peer' ? 'accepted_both' : 'accepted_local'));
    if (decision === 'reject') setState('rejected');
    if (decision === 'block') setState('blocked');
    await decideRef.current(decision, note);
  }

  return (
    <ConsentView
      peer={peer}
      state={state}
      onDecide={handleDecide}
      onDisconnect={onDisconnect}
      {...(final ? { finalOutcome: final } : {})}
    />
  );
}
