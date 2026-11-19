/**
 * DemoView — the Local Demo Mode screen.
 *
 * ## What this is
 *
 * A guided, single-machine tour of Kindora's core loop. It exists so
 * that somebody who has one laptop, no second device and no LLM API
 * key can still see what the product actually does.
 *
 * ## What it renders
 *
 * The **real** screens — `ConsentView`, `MatchView`, `IcebreakerView`
 * and `ChatView` — wired to the deterministic demo engine in
 * `../lib/demo.ts`. Nothing here re-implements a product screen; the
 * demo only supplies data and a click-through order.
 *
 * ## The honesty rule
 *
 * Every screen in the demo carries the simulated-data banner, and the
 * chat screen says out loud that the peer is scripted. The demo must
 * never look like a live session with a real person: the whole point
 * of an early-stage project is that a visitor can tell the difference
 * between what works and what is being shown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatEntry, ChatSnapshot, ConsentOutcome, ConsentState } from '@kindora/matching';
import type { MatchOutcome } from '@kindora/matching';
import { useTranslate } from '../i18n';
import { ConsentView } from './ConsentView';
import { IcebreakerView } from './IcebreakerView';
import { MatchView } from './MatchView';
import { ChatView, type ChatAssistPanelState } from './ChatView';
import {
  buildDemoPeerIntroduction,
  DEMO_PEER_DISPLAY_NAME,
  DEMO_PEER_PROFILE,
  DEMO_SELF_DISPLAY_NAME,
  DEMO_SELF_PROFILE,
  demoPeerReply,
  runDemoIcebreaker,
  runDemoMatch,
} from '../lib/demo';

export interface DemoViewProps {
  /** Leave the demo and go back to the app. */
  readonly onExit: () => void;
}

type DemoStep = 'intro' | 'meet' | 'consent' | 'match' | 'icebreaker' | 'chat';

/**
 * The order the screens appear in. It is the order of the real
 * product flow: meet → consent → match → icebreaker → chat.
 */
const STEP_ORDER: readonly DemoStep[] = ['intro', 'meet', 'consent', 'match', 'icebreaker', 'chat'];

const STEP_LABEL_KEYS = {
  intro: 'demo.step.intro',
  meet: 'demo.step.meet',
  consent: 'demo.step.consent',
  match: 'demo.step.match',
  icebreaker: 'demo.step.icebreaker',
  chat: 'demo.step.chat',
} as const;

export function DemoView({ onExit }: DemoViewProps) {
  const [step, setStep] = useState<DemoStep>('intro');
  const [matchOutcome, setMatchOutcome] = useState<MatchOutcome | undefined>(undefined);
  const [matchError, setMatchError] = useState<string | undefined>(undefined);

  const goTo = useCallback((next: DemoStep) => setStep(next), []);

  // The match report is computed once, when the flow reaches it. The
  // demo engine is deterministic, so this never changes afterwards.
  useEffect(() => {
    if (step !== 'match' || matchOutcome) return;
    let cancelled = false;
    void runDemoMatch()
      .then((run) => {
        if (!cancelled) setMatchOutcome(run.outcome);
      })
      .catch((err: unknown) => {
        if (!cancelled) setMatchError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [step, matchOutcome]);

  const currentIndex = STEP_ORDER.indexOf(step);

  return (
    <div className="flex min-h-screen flex-col">
      <DemoBanner />
      <DemoStepBar current={step} index={currentIndex} />
      <div className="flex-1">
        {step === 'intro' && <DemoIntro onStart={() => goTo('meet')} onExit={onExit} />}
        {step === 'meet' && (
          <DemoMeet
            onContinue={() => goTo('consent')}
            onBack={() => goTo('intro')}
          />
        )}
        {step === 'consent' && (
          <DemoConsent
            onAccepted={() => goTo('match')}
            onBack={() => goTo('meet')}
          />
        )}
        {step === 'match' && (
          <DemoMatch
            outcome={matchOutcome}
            error={matchError}
            onContinue={() => goTo('icebreaker')}
            onBack={() => goTo('consent')}
          />
        )}
        {step === 'icebreaker' && (
          <DemoIcebreaker
            analysis={matchOutcome?.localAnalysis ?? null}
            onContinue={() => goTo('chat')}
            onBack={() => goTo('match')}
          />
        )}
        {step === 'chat' && (
          <DemoChat onBack={() => goTo('icebreaker')} onExit={onExit} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The banner — on every single screen                                 */
/* ------------------------------------------------------------------ */

function DemoBanner() {
  const t = useTranslate();
  return (
    <div className="border-b border-pastel-yellow bg-pastel-yellow px-6 py-2" data-testid="demo-banner">
      <p className="mx-auto w-full max-w-3xl text-xs leading-relaxed text-pastel-yellowInk">
        {t('demo.banner')}
      </p>
    </div>
  );
}

/**
 * The step indicator. It doubles as an honest progress bar: the demo
 * always shows where the visitor is in the flow.
 */
function DemoStepBar({ current, index }: { current: DemoStep; index: number }) {
  const t = useTranslate();
  const steps = STEP_ORDER.filter((s) => s !== 'intro');
  return (
    <nav
      className="border-kindora-100 dark:border-kindora-800 border-b px-6 py-3"
      aria-label={t('demo.stepsLabel')}
    >
      <ol className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2">
        {steps.map((s, i) => {
          const active = s === current;
          const done = index > STEP_ORDER.indexOf(s);
          return (
            <li key={s} className="flex items-center gap-2">
              <span
                className={
                  active
                    ? 'kindora-chip'
                    : done
                      ? 'kindora-chip-plain opacity-70'
                      : 'kindora-chip-plain opacity-40'
                }
              >
                {t(STEP_LABEL_KEYS[s])}
              </span>
              {i < steps.length - 1 && <span className="text-kindora-300 text-xs">·</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1 — the intro                                                  */
/* ------------------------------------------------------------------ */

function DemoIntro({ onStart, onExit }: { onStart: () => void; onExit: () => void }) {
  const t = useTranslate();
  return (
    <main className="kindora-page">
      <header>
        <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {t('demo.eyebrow')}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t('demo.introTitle')}</h1>
        <p className="text-kindora-600 dark:text-kindora-300 mt-3 text-sm leading-relaxed">
          {t('demo.introBody')}
        </p>
      </header>

      <section className="kindora-card flex flex-col gap-3">
        <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {t('demo.whatIsReal')}
        </h2>
        <ul className="space-y-1 text-sm leading-relaxed">
          <li>· {t('demo.realProfiles')}</li>
          <li>· {t('demo.realHeuristics')}</li>
          <li>· {t('demo.realParsing')}</li>
          <li>· {t('demo.realScreens')}</li>
        </ul>
      </section>

      <section className="kindora-warning flex flex-col gap-3">
        <h2 className="text-xs uppercase tracking-wide">{t('demo.whatIsSimulated')}</h2>
        <ul className="space-y-1 text-sm leading-relaxed">
          <li>· {t('demo.simulatedModel')}</li>
          <li>· {t('demo.simulatedPeer')}</li>
          <li>· {t('demo.simulatedNetwork')}</li>
        </ul>
      </section>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="kindora-button px-8 py-3" onClick={onStart}>
          {t('demo.start')}
        </button>
        <button type="button" className="kindora-button-ghost px-8 py-3" onClick={onExit}>
          {t('demo.exit')}
        </button>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2 — the two agents meet                                        */
/* ------------------------------------------------------------------ */

function DemoMeet({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const t = useTranslate();
  return (
    <main className="kindora-page">
      <header>
        <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {t('demo.meetEyebrow')}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t('demo.meetTitle')}</h1>
        <p className="text-kindora-600 dark:text-kindora-300 mt-3 text-sm leading-relaxed">
          {t('demo.meetBody')}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <AgentCard
          role={t('demo.you')}
          displayName={DEMO_SELF_DISPLAY_NAME}
          bio={DEMO_SELF_PROFILE.bio}
          interests={DEMO_SELF_PROFILE.interests}
          activities={DEMO_SELF_PROFILE.currentActivities}
        />
        <AgentCard
          role={t('demo.peer')}
          displayName={DEMO_PEER_DISPLAY_NAME}
          bio={DEMO_PEER_PROFILE.bio}
          interests={DEMO_PEER_PROFILE.interests}
          activities={DEMO_PEER_PROFILE.currentActivities}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="kindora-button px-8 py-3" onClick={onContinue}>
          {t('demo.continue')}
        </button>
        <button type="button" className="kindora-button-ghost px-8 py-3" onClick={onBack}>
          {t('common.back')}
        </button>
      </div>
    </main>
  );
}

function AgentCard({
  role,
  displayName,
  bio,
  interests,
  activities,
}: {
  role: string;
  displayName: string;
  bio: string;
  interests: readonly string[];
  activities: readonly string[];
}) {
  const t = useTranslate();
  return (
    <section className="kindora-card flex flex-col gap-3">
      <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {role}
      </p>
      <h2 className="text-xl font-semibold tracking-tight">{displayName}</h2>
      <p className="text-sm leading-relaxed">{bio}</p>
      <div>
        <h3 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {t('home.interests')}
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {interests.map((i) => (
            <span key={i} className="kindora-chip-plain">
              {i}
            </span>
          ))}
        </div>
      </div>
      <div>
        <h3 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {t('home.currently')}
        </h3>
        <ul className="mt-2 space-y-1 text-sm">
          {activities.map((a) => (
            <li key={a}>· {a}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Step 3 — the human decides                                          */
/* ------------------------------------------------------------------ */

function DemoConsent({ onAccepted, onBack }: { onAccepted: () => void; onBack: () => void }) {
  const t = useTranslate();
  const peer = useMemo(() => buildDemoPeerIntroduction(), []);
  const [state, setState] = useState<ConsentState>('awaiting_decision');
  const [final, setFinal] = useState<ConsentOutcome | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const decide = useCallback((decision: 'accept' | 'reject' | 'block') => {
    if (decision === 'accept') {
      setState('accepted_local');
      // The demo peer "accepts" a moment later. This is scripted and
      // the banner says so — it is not a simulated network round-trip.
      timerRef.current = setTimeout(() => {
        setState('accepted_both');
        setFinal({
          state: 'accepted_both',
          peerDisplayName: DEMO_PEER_DISPLAY_NAME,
          peerAgentId: peer.peerAgentId,
          bothAccepted: true,
          blockedByLocal: false,
          blockedByPeer: false,
          peerAcceptTimedOut: false,
          peerConsentTimeoutMs: 0,
          sessionClosed: false,
        });
      }, 700);
      return;
    }
    const nextState: ConsentState = decision === 'reject' ? 'rejected' : 'blocked';
    setState(nextState);
    setFinal({
      state: nextState,
      peerDisplayName: DEMO_PEER_DISPLAY_NAME,
      peerAgentId: peer.peerAgentId,
      bothAccepted: false,
      blockedByLocal: decision === 'block',
      blockedByPeer: false,
      peerAcceptTimedOut: false,
      peerConsentTimeoutMs: 0,
      sessionClosed: true,
    });
  }, [peer.peerAgentId]);

  const accepted = state === 'accepted_both';

  return (
    <div>
      <ConsentView
        peer={peer}
        state={state}
        onDecide={(decision) => decide(decision)}
        onDisconnect={onBack}
        {...(final ? { finalOutcome: final } : {})}
      />
      <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-2 px-6 pb-8">
        {accepted ? (
          <button type="button" className="kindora-button px-8 py-3" onClick={onAccepted}>
            {t('demo.continueToMatch')}
          </button>
        ) : (
          <button type="button" className="kindora-button-ghost px-8 py-3" onClick={onBack}>
            {t('common.back')}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 4 — the match report                                           */
/* ------------------------------------------------------------------ */

function DemoMatch({
  outcome,
  error,
  onContinue,
  onBack,
}: {
  outcome: MatchOutcome | undefined;
  error: string | undefined;
  onContinue: () => void;
  onBack: () => void;
}) {
  const t = useTranslate();
  return (
    <div>
      <MatchView
        phase={error ? 'error' : outcome ? 'done' : 'analysing'}
        {...(outcome ? { outcome } : {})}
        {...(error ? { error } : {})}
        onDisconnect={onBack}
      />
      <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-2 px-6 pb-8">
        {outcome && (
          <button type="button" className="kindora-button px-8 py-3" onClick={onContinue}>
            {t('demo.continue')}
          </button>
        )}
        <button type="button" className="kindora-button-ghost px-8 py-3" onClick={onBack}>
          {t('common.back')}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 5 — the icebreaker                                             */
/* ------------------------------------------------------------------ */

function DemoIcebreaker({
  analysis,
  onContinue,
  onBack,
}: {
  analysis: MatchOutcome['localAnalysis'] | null;
  onContinue: () => void;
  onBack: () => void;
}) {
  const t = useTranslate();
  const [phase, setPhase] = useState<'generating' | 'ready' | 'error'>('generating');
  const [topics, setTopics] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const generate = useCallback(() => {
    setPhase('generating');
    setError(undefined);
    void runDemoIcebreaker(analysis)
      .then((result) => {
        setTopics(result.topics);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      });
  }, [analysis]);

  useEffect(() => {
    generate();
  }, [generate]);

  return (
    <div>
      <IcebreakerView
        peerDisplayName={DEMO_PEER_DISPLAY_NAME}
        selfDisplayName={DEMO_SELF_DISPLAY_NAME}
        phase={phase}
        topics={topics}
        boundaryBlocked={false}
        degradationNote={null}
        error={error}
        onUse={() => onContinue()}
        onRegenerate={generate}
        onSkip={() => onContinue()}
        onDisconnect={onBack}
      />
      <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-2 px-6 pb-8">
        <button type="button" className="kindora-button px-8 py-3" onClick={onContinue}>
          {t('demo.continueToChat')}
        </button>
        <button type="button" className="kindora-button-ghost px-8 py-3" onClick={onBack}>
          {t('common.back')}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 6 — the chat                                                   */
/* ------------------------------------------------------------------ */

const EMPTY_ASSISTANT: ChatAssistPanelState = {
  open: false,
  busy: false,
  unavailable: true,
  unavailableReason: 'demo',
  error: undefined,
  softNotice: undefined,
  query: '',
  display: null,
  dismissedIds: [],
};

function DemoChat({ onBack, onExit }: { onBack: () => void; onExit: () => void }) {
  const t = useTranslate();
  const [entries, setEntries] = useState<readonly ChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const repliesRef = useRef(0);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) clearTimeout(timer);
    },
    [],
  );

  const snapshot: ChatSnapshot = useMemo(
    () => ({
      entries,
      state: 'open',
      closeReason: 'open',
      peerAgentId: 'demo-agent-rin-0000-0000-000000000002',
      peerDisplayName: DEMO_PEER_DISPLAY_NAME,
      blockedByLocal: false,
      blockedByPeer: false,
    }),
    [entries],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft('');
    setSending(true);
    const id = `demo-sent-${entries.length}`;
    setEntries((prev) => [
      ...prev,
      {
        id,
        direction: 'sent',
        sender: DEMO_SELF_DISPLAY_NAME,
        text,
        timestamp: new Date().toISOString(),
        source: 'human',
        status: 'SENT',
      },
    ]);
    // The scripted reply arrives a moment later.
    const timer = setTimeout(() => {
      const reply = demoPeerReply(repliesRef.current);
      repliesRef.current += 1;
      setEntries((prev) => [
        ...prev,
        {
          id: `demo-received-${prev.length}`,
          direction: 'received',
          sender: DEMO_PEER_DISPLAY_NAME,
          text: reply,
          timestamp: new Date().toISOString(),
          source: 'human',
          status: 'DELIVERED',
        },
      ]);
      setSending(false);
    }, 800);
    timersRef.current.push(timer);
  }, [draft, entries.length]);

  return (
    <div>
      <div className="mx-auto w-full max-w-3xl px-6 pt-4">
        <p className="kindora-warning rounded-xl px-4 py-3 text-xs leading-relaxed">
          {t('demo.chatNotice')}
        </p>
      </div>
      <ChatView
        peerDisplayName={DEMO_PEER_DISPLAY_NAME}
        selfDisplayName={DEMO_SELF_DISPLAY_NAME}
        snapshot={snapshot}
        phase="open"
        draft={draft}
        sending={sending}
        maxTextLength={2000}
        error={undefined}
        assistant={EMPTY_ASSISTANT}
        onDraftChange={setDraft}
        onSend={send}
        onDisconnect={onBack}
        onBlock={onBack}
        onUseSuggestion={() => undefined}
        onAskOpen={() => undefined}
        onAskClose={() => undefined}
        onAskChangeQuery={() => undefined}
        onAskSubmit={() => undefined}
        onAskRegenerate={() => undefined}
        onAskDismissSuggestion={() => undefined}
      />
      <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-2 px-6 pb-8">
        <button type="button" className="kindora-button px-8 py-3" onClick={onExit}>
          {t('demo.finish')}
        </button>
        <button type="button" className="kindora-button-ghost px-8 py-3" onClick={onBack}>
          {t('common.back')}
        </button>
      </div>
    </div>
  );
}
