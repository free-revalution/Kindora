/**
 * MatchView — Phase 6 result screen.
 *
 * Renders the 5 required fields per 开发手册.md § 44:
 *
 *   1. Compatibility Signal
 *   2. Common Ground
 *   3. Recommended Topics
 *   4. Potential Friction
 *   5. Explanation
 *
 * + peer display name + an "analysis is in progress" placeholder for
 * the peer's analysis (which may time out, see Phase 6 spec).
 *
 * The view is a thin consumer of the orchestrator's `MatchOutcome`;
 * all formatting lives in `@kindora/matching/display`. No LLM calls,
 * no transport, no I/O — those live in `connect-service`.
 */

import { useEffect, useRef, useState } from 'react';
import type { MatchOutcome } from '@kindora/matching';
import { summariseAnalysis } from '@kindora/matching';
import { COMPATIBILITY_SIGNAL_KEYS, useTranslate } from '../i18n';

export type MatchPhase = 'connecting' | 'exchanging' | 'analysing' | 'done' | 'error';

export interface MatchViewProps {
  /** Title above the peer block — e.g. "Connected with". */
  title?: string;
  /** Current phase of the match flow. */
  phase: MatchPhase;
  /** Final outcome once `phase === 'done'`. */
  outcome?: MatchOutcome | undefined;
  /** Error message when `phase === 'error'`. */
  error?: string | undefined;
  /** Called when the user wants to abandon the connection. */
  onDisconnect: () => void;
}

export function MatchView({ title, phase, outcome, error, onDisconnect }: MatchViewProps) {
  const t = useTranslate();
  if (phase === 'error') {
    return (
      <ErrorView message={error ?? t('match.errorFallback')} onDisconnect={onDisconnect} />
    );
  }
  if (phase !== 'done' || !outcome) {
    return <ProgressView phase={phase} onDisconnect={onDisconnect} />;
  }

  const local = summariseAnalysis(outcome.localAnalysis);
  const peer = outcome.peerAnalysis ? summariseAnalysis(outcome.peerAnalysis) : null;
  const heading = title ?? t('match.connectedWith');

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            {heading}
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-3xl font-semibold tracking-tight">
            {outcome.peerDisplayName}
          </h1>
          <p className="text-kindora-500 dark:text-kindora-400 mt-1 font-mono text-xs">
            {outcome.peerAgentId.slice(0, 8)}…
          </p>
        </div>
        <button type="button" className="kindora-button-ghost" onClick={onDisconnect}>
          {t('consent.disconnect')}
        </button>
      </header>

      {/* The signal LABEL is localised from the raw protocol value rather than
          taken from `summary.signalLabel`, which is English-only and lives in
          @kindora/matching. `signalTone` (a style hint, not copy) still comes
          from there. */}
      <SignalCard
        label={t('match.yourAgentSays')}
        tone={local.signalTone}
        signal={t(COMPATIBILITY_SIGNAL_KEYS[outcome.localAnalysis.compatibilitySignal])}
      />
      {peer && (
        <SignalCard
          label={t('match.theirAgentSays')}
          tone={peer.signalTone}
          signal={t(COMPATIBILITY_SIGNAL_KEYS[outcome.peerAnalysis!.compatibilitySignal])}
        />
      )}
      {!peer && (
        <p className="text-kindora-500 dark:text-kindora-400 text-sm italic">
          {t('match.peerStillThinking')}
        </p>
      )}

      <Section title={t('match.commonGround')}>
        {local.commonGround.length === 0 ? (
          <p className="text-kindora-500 dark:text-kindora-400 text-sm">
            {t('match.noCommonGround')}
          </p>
        ) : (
          <ChipList items={local.commonGround} />
        )}
      </Section>

      <Section title={t('match.recommendedTopics')}>
        {local.recommendedTopics.length === 0 ? (
          <p className="text-kindora-500 dark:text-kindora-400 text-sm">{t('match.noTopics')}</p>
        ) : (
          <ChipList items={local.recommendedTopics} />
        )}
      </Section>

      <Section title={t('match.potentialFriction')}>
        {local.potentialFriction.length === 0 ? (
          <p className="text-kindora-500 dark:text-kindora-400 text-sm">{t('match.noFriction')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {local.potentialFriction.map((f) => (
              <li key={f}>· {f}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('match.explanation')}>
        <p className="text-sm leading-relaxed">{local.explanation || t('match.noExplanation')}</p>
      </Section>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function SignalCard({
  label,
  signal,
  tone,
}: {
  label: string;
  signal: string;
  tone: 'positive' | 'neutral' | 'cautious';
}) {
  const toneClass =
    tone === 'positive'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-100'
      : tone === 'cautious'
        ? 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-900/40 dark:text-rose-100'
        : 'border-kindora-200 bg-kindora-50 text-kindora-800 dark:border-kindora-700 dark:bg-kindora-800/40 dark:text-kindora-100';
  return (
    <section className="kindora-card flex flex-col gap-2">
      <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {label}
      </p>
      <p className={`inline-flex w-fit items-center gap-1 rounded-full border px-3 py-1 text-sm ${toneClass}`}>
        {signal}
      </p>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="kindora-card flex flex-col gap-3">
      <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ChipList({ items }: { items: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((i) => (
        <span key={i} className="kindora-chip-plain">
          {i}
        </span>
      ))}
    </div>
  );
}

function ProgressView({ phase, onDisconnect }: { phase: MatchPhase; onDisconnect: () => void }) {
  const t = useTranslate();
  const message =
    phase === 'connecting'
      ? t('match.progressConnecting')
      : phase === 'exchanging'
        ? t('match.progressExchanging')
        : phase === 'analysing'
          ? t('match.progressAnalysing')
          : t('match.progressWorking');
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 px-6 py-20">
      <p className="text-kindora-500 dark:text-kindora-400 text-sm">{message}</p>
      <div
        className="border-kindora-200 dark:border-kindora-700 h-2 w-40 animate-pulse rounded-full border"
        aria-hidden
      />
      <button type="button" className="kindora-button-ghost" onClick={onDisconnect}>
        {t('common.cancel')}
      </button>
    </main>
  );
}

function ErrorView({ message, onDisconnect }: { message: string; onDisconnect: () => void }) {
  const t = useTranslate();
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-20">
      <section className="kindora-card flex flex-col gap-3">
        <h2 className="text-rose-600 dark:text-rose-400 text-xs uppercase tracking-wide">
          {t('common.error')}
        </h2>
        <p className="text-sm leading-relaxed">{message}</p>
        <button type="button" className="kindora-button-ghost self-start" onClick={onDisconnect}>
          {t('common.back')}
        </button>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Live wrapper — drives a single `runMatch()` call and updates state  */
/* ------------------------------------------------------------------ */

export interface LiveMatchViewProps {
  /** Async function that runs the orchestrator and resolves with the outcome. */
  readonly run: () => Promise<MatchOutcome>;
  /** Called when the user clicks Disconnect / Cancel / Back. */
  readonly onDisconnect: () => void;
  /**
   * Optional callback fired when the match completes (success or
   * error). The parent uses this to route to the next phase
   * (Phase 7 consent). When omitted, the view stays on the result.
   */
  readonly onDone?: (outcome: MatchOutcome) => void;
}

export function LiveMatchView({ run, onDisconnect, onDone }: LiveMatchViewProps) {
  const [phase, setPhase] = useState<MatchPhase>('connecting');
  const [outcome, setOutcome] = useState<MatchOutcome | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Capture `run` in a ref so the effect runs only on mount. Without
  // this, every render of `LiveMatchView` produces a new `run` arrow,
  // re-triggers the effect, and the "done" state is immediately
  // overwritten with "exchanging" again.
  const runRef = useRef(run);
  runRef.current = run;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let cancelled = false;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    setPhase('exchanging');
    progressTimer = setTimeout(() => {
      progressTimer = null;
      if (!cancelled) setPhase('analysing');
    }, 250);
    const clearProgressTimer = () => {
      if (progressTimer !== null) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
    };
    runRef
      .current()
      .then((o) => {
        if (cancelled) return;
        clearProgressTimer();
        setOutcome(o);
        setPhase('done');
        onDoneRef.current?.(o);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        clearProgressTimer();
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      });
    return () => {
      cancelled = true;
      clearProgressTimer();
    };
  }, []);

  return <MatchView phase={phase} outcome={outcome} error={error} onDisconnect={onDisconnect} />;
}
