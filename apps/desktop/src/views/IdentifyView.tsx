/**
 * IdentifyView — Phase B, the first step of the wire flow.
 *
 * Task book § 五 B2 requires that only a **minimal public card** leaves
 * the device before the human consent step. This screen is where that
 * happens, and it says so: the user can see that the exchange is a
 * card exchange, not a profile exchange.
 *
 * The screen is deliberately short-lived — the card is exchanged, and
 * the app moves on to the consent screen with the peer's card.
 *
 * See docs/修复.md § 五 B2.
 */

import { useEffect, useRef, useState } from 'react';
import type { PeerIntroduction } from '@kindora/matching';
import { useTranslate } from '../i18n';
import { ErrorView } from './MatchView';

export type IdentifyPhase = 'connecting' | 'exchanging' | 'done' | 'error';

export interface IdentifyViewProps {
  /** Current phase of the card exchange. */
  readonly phase: IdentifyPhase;
  /** Error message when `phase === 'error'`. */
  readonly error?: string | undefined;
  /** Called when the user wants to abandon the connection. */
  readonly onDisconnect: () => void;
}

export function IdentifyView({ phase, error, onDisconnect }: IdentifyViewProps) {
  const t = useTranslate();
  if (phase === 'error') {
    return <ErrorView message={error ?? t('match.errorFallback')} onDisconnect={onDisconnect} />;
  }
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 px-6 py-20">
      <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {t('identify.eyebrow')}
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">{t('identify.title')}</h1>
      <p className="text-kindora-500 dark:text-kindora-400 text-sm">{t('identify.progress')}</p>
      <div
        className="border-kindora-200 dark:border-kindora-700 h-2 w-40 animate-pulse rounded-full border"
        aria-hidden
      />
      <p className="text-kindora-600 dark:text-kindora-300 max-w-md text-center text-xs leading-relaxed">
        {t('identify.body')}
      </p>
      <button type="button" className="kindora-button-ghost" onClick={onDisconnect}>
        {t('common.cancel')}
      </button>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Live wrapper — drives a single `runIdentify()` call and updates state */
/* ------------------------------------------------------------------ */

export interface LiveIdentifyViewProps {
  /** Async function that exchanges the public cards. */
  readonly run: () => Promise<PeerIntroduction>;
  /** Called when the user clicks Cancel / Back. */
  readonly onDisconnect: () => void;
  /**
   * Optional callback fired when the card exchange succeeds. The parent
   * uses this to route to the consent screen.
   */
  readonly onDone?: (intro: PeerIntroduction) => void;
}

export function LiveIdentifyView({ run, onDisconnect, onDone }: LiveIdentifyViewProps) {
  const [phase, setPhase] = useState<IdentifyPhase>('connecting');
  const [error, setError] = useState<string | undefined>(undefined);

  // Capture `run` in a ref so the effect runs only on mount. Without
  // this, every render produces a new `run` arrow, re-triggers the
  // effect, and the exchange starts again.
  const runRef = useRef(run);
  runRef.current = run;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let cancelled = false;
    setPhase('exchanging');
    runRef
      .current()
      .then((intro) => {
        if (cancelled) return;
        setPhase('done');
        onDoneRef.current?.(intro);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <IdentifyView phase={phase} error={error} onDisconnect={onDisconnect} />;
}
