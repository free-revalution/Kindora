/**
 * IcebreakerView — Phase 8 screen.
 *
 * Per 开发手册.md § 28–29, after both sides accept, the local agent
 * proposes up to 3 conversation starters ("icebreakers"). The user
 * picks one, edits it, regenerates, or skips — the AI NEVER auto-sends.
 *
 * UI flow:
 *   - On mount, the live wrapper kicks off `generateIcebreaker()`.
 *   - Up to 3 topics render. Each row has [Use] and [Edit] buttons.
 *     In edit mode the topic becomes a controlled textarea; the user
 *     can confirm the edit (→ still Use-able) or cancel it.
 *   - Global [Regenerate] runs another `generateIcebreaker()` round.
 *   - [Skip] closes the screen without using a starter. The chat
 *     (Phase 9) is unlocked either way.
 *
 * The view is purely presentational — no LLM, no transport. The
 * `LiveIcebreakerView` wrapper below wires the LLM call.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  GenerateIcebreakerInput,
  GenerateIcebreakerResult,
} from '@kindora/agent';
import { ICEBREAKER_TOPIC_CAP } from '@kindora/agent';

export type IcebreakerPhase =
  | 'idle'
  | 'generating'
  | 'ready'
  | 'regenerating'
  | 'error';

export interface IcebreakerViewProps {
  /** Peer display name for the title block. */
  readonly peerDisplayName: string;
  /** Local agent display name. */
  readonly selfDisplayName: string;
  /** Current phase — controls the loading / ready / error UI. */
  readonly phase: IcebreakerPhase;
  /** Up to 3 icebreaker topics from the LLM. */
  readonly topics: readonly string[];
  /** True iff the topic list came back empty because of a boundary block. */
  readonly boundaryBlocked: boolean;
  /** Degradation note — surfaced when generation had to fall back. */
  readonly degradationNote: string | null;
  /** Error message when `phase === 'error'`. */
  readonly error: string | undefined;
  /** Called when the user picks a topic and confirms Use. */
  readonly onUse: (chosen: string) => void;
  /** Called when the user clicks Regenerate. */
  readonly onRegenerate: () => void;
  /** Called when the user clicks Skip. */
  readonly onSkip: () => void;
  /** Called when the user clicks Disconnect / Close. */
  readonly onDisconnect: () => void;
}

export function IcebreakerView({
  peerDisplayName,
  selfDisplayName,
  phase,
  topics,
  boundaryBlocked,
  degradationNote,
  error,
  onUse,
  onRegenerate,
  onSkip,
  onDisconnect,
}: IcebreakerViewProps) {
  const isLoading = phase === 'generating' || phase === 'regenerating';

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            Pick a starter
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {peerDisplayName}
          </h1>
          <p className="text-kindora-500 dark:text-kindora-400 mt-1 text-sm">
            You: {selfDisplayName}
          </p>
        </div>
        <button type="button" className="kindora-button-ghost" onClick={onDisconnect}>
          Close
        </button>
      </header>

      <section className="kindora-card flex flex-col gap-2">
        <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          How icebreakers work
        </h2>
        <p className="text-sm leading-relaxed">
          Your agent suggests up to {ICEBREAKER_TOPIC_CAP} conversation starters based
          on both profiles. Pick one to send, edit it, ask for new ones, or skip
          straight to chat. Nothing is sent automatically — the choice is yours.
        </p>
      </section>

      {phase === 'error' && (
        <section
          className="kindora-card flex flex-col gap-2 border border-rose-300 dark:border-rose-700"
          data-testid="icebreaker-error"
        >
          <h2 className="text-rose-600 dark:text-rose-400 text-xs uppercase tracking-wide">
            Generation failed
          </h2>
          <p className="text-sm leading-relaxed">{error ?? 'Unknown error.'}</p>
          <button type="button" className="kindora-button-ghost self-start" onClick={onRegenerate}>
            Try again
          </button>
        </section>
      )}

      {boundaryBlocked && (
        <section
          className="kindora-card flex flex-col gap-2 border border-rose-300 dark:border-rose-700"
          data-testid="icebreaker-blocked"
        >
          <h2 className="text-rose-600 dark:text-rose-400 text-xs uppercase tracking-wide">
            Icebreaker disabled
          </h2>
          <p className="text-sm leading-relaxed">
            Both profiles disallow agent-assisted conversation starters. You can still
            enter the chat and write your own message.
          </p>
        </section>
      )}

      {degradationNote && !boundaryBlocked && phase === 'ready' && topics.length === 0 && (
        <section
          className="kindora-card flex flex-col gap-2 border border-amber-300 dark:border-amber-700"
          data-testid="icebreaker-degraded"
        >
          <h2 className="text-amber-600 dark:text-amber-400 text-xs uppercase tracking-wide">
            Couldn’t generate starters
          </h2>
          <p className="text-sm leading-relaxed">{degradationNote}</p>
          <button type="button" className="kindora-button-ghost self-start" onClick={onRegenerate}>
            Try again
          </button>
        </section>
      )}

      <IcebreakerTopicList
        topics={topics}
        isLoading={isLoading}
        onUse={onUse}
        phase={phase}
      />

      <ActionBar
        phase={phase}
        topicsEmpty={topics.length === 0}
        onRegenerate={onRegenerate}
        onSkip={onSkip}
        isLoading={isLoading}
      />
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Topic list + per-row state                                          */
/* ------------------------------------------------------------------ */

function IcebreakerTopicList({
  topics,
  isLoading,
  onUse,
  phase,
}: {
  topics: readonly string[];
  isLoading: boolean;
  onUse: (chosen: string) => void;
  phase: IcebreakerPhase;
}) {
  if (isLoading && topics.length === 0) {
    return (
      <section className="kindora-card flex flex-col gap-3" data-testid="icebreaker-loading">
        <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          Drafting starters
        </h2>
        <p className="text-kindora-500 dark:text-kindora-400 text-sm italic">
          Your agent is thinking about what to say…
        </p>
        <div
          className="border-kindora-200 dark:border-kindora-700 h-2 w-40 animate-pulse rounded-full border"
          aria-hidden
        />
      </section>
    );
  }

  if (topics.length === 0) {
    return (
      <section
        className="kindora-card flex flex-col gap-2"
        data-testid="icebreaker-empty"
      >
        <p className="text-kindora-500 dark:text-kindora-400 text-sm italic">
          No starters yet — click Regenerate to ask your agent again, or Skip to enter
          the chat directly.
        </p>
      </section>
    );
  }

  return (
    <section
      className="flex flex-col gap-3"
      data-testid="icebreaker-topics"
      data-topic-count={topics.length}
    >
      {topics.map((topic, idx) => (
        <IcebreakerTopicRow
          key={`${idx}-${topic}`}
          topic={topic}
          disabled={phase === 'regenerating' || phase === 'generating'}
          onUse={onUse}
        />
      ))}
    </section>
  );
}

function IcebreakerTopicRow({
  topic,
  disabled,
  onUse,
}: {
  topic: string;
  disabled: boolean;
  /** Called with the text the user wants to send (edited or original). */
  onUse: (chosen: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(topic);

  // If the upstream `topic` changes (after Regenerate), reset the draft.
  // We key the row on `${idx}-${topic}` so this only runs when the row
  // identity changes, but defensively sync draft on prop change too.
  useEffect(() => {
    setDraft(topic);
  }, [topic]);

  if (editing) {
    return (
      <article className="kindora-card flex flex-col gap-2" data-testid="icebreaker-row">
        <textarea
          className="border-kindora-200 dark:border-kindora-700 w-full resize-none rounded-md border bg-transparent p-2 text-sm leading-relaxed"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="icebreaker-edit-textarea"
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
            disabled={disabled || draft.trim().length === 0}
            data-testid="icebreaker-use"
          >
            Use edited
          </button>
          <button
            type="button"
            className="kindora-button-ghost"
            onClick={() => {
              setDraft(topic);
              setEditing(false);
            }}
            data-testid="icebreaker-cancel-edit"
          >
            Cancel
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="kindora-card flex flex-col gap-3" data-testid="icebreaker-row">
      <p className="text-sm leading-relaxed">{topic}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="kindora-button"
          onClick={() => onUse(topic)}
          disabled={disabled}
          data-testid="icebreaker-use"
        >
          Use
        </button>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={() => setEditing(true)}
          disabled={disabled}
          data-testid="icebreaker-edit"
        >
          Edit
        </button>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Footer actions — Regenerate + Skip                                  */
/* ------------------------------------------------------------------ */

function ActionBar({
  phase,
  topicsEmpty,
  onRegenerate,
  onSkip,
  isLoading,
}: {
  phase: IcebreakerPhase;
  topicsEmpty: boolean;
  onRegenerate: () => void;
  onSkip: () => void;
  isLoading: boolean;
}) {
  return (
    <section className="kindora-card flex flex-col gap-3" data-testid="icebreaker-actions">
      <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        Or
      </h2>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onRegenerate}
          disabled={isLoading}
          data-testid="icebreaker-regenerate"
        >
          {topicsEmpty ? 'Generate starters' : 'Regenerate'}
        </button>
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onSkip}
          data-testid="icebreaker-skip"
        >
          Skip — enter chat
        </button>
      </div>
      <p className="text-kindora-500 dark:text-kindora-400 text-xs">
        Phase {phase} · AI only suggests — it never sends anything for you.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Live wrapper — drives a single generateIcebreaker() call           */
/* ------------------------------------------------------------------ */

export interface LiveIcebreakerViewProps {
  readonly peerDisplayName: string;
  readonly selfDisplayName: string;
  /** The input the LLM should consume. Built by the parent (has access to profiles). */
  readonly input: GenerateIcebreakerInput;
  /**
   * Called when the user picks a topic. The parent decides what to do
   * with it (in V0.1: open the chat). Receives the final chosen text
   * (post-Edit if the user edited).
   */
  readonly onUse: (chosen: string) => void;
  /** Called when the user clicks Skip. */
  readonly onSkip: () => void;
  /** Called when the user clicks Close / Disconnect. */
  readonly onDisconnect: () => void;
  /**
   * Async LLM runner — owned by the parent so the view stays
   * transport-agnostic and easy to test. Resolves with the LLM result.
   */
  readonly generate: (input: GenerateIcebreakerInput) => Promise<GenerateIcebreakerResult>;
}

export function LiveIcebreakerView({
  peerDisplayName,
  selfDisplayName,
  input,
  onUse,
  onSkip,
  onDisconnect,
  generate,
}: LiveIcebreakerViewProps) {
  const [phase, setPhase] = useState<IcebreakerPhase>('idle');
  const [topics, setTopics] = useState<readonly string[]>([]);
  const [degradationNote, setDegradationNote] = useState<string | null>(null);
  const [boundaryBlocked, setBoundaryBlocked] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const inputRef = useRef(input);
  inputRef.current = input;
  const generateRef = useRef(generate);
  generateRef.current = generate;

  const regenerate = (): void => {
    setError(undefined);
    setPhase((p) => (p === 'idle' ? 'generating' : 'regenerating'));
    generateRef
      .current(inputRef.current)
      .then((result) => {
        setTopics(result.topics);
        setDegradationNote(result.degradationNote);
        setBoundaryBlocked(result.boundaryBlocked);
        setPhase('ready');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      });
  };

  useEffect(() => {
    regenerate();
    // Intentionally empty deps: regenerate is captured via refs so we
    // generate exactly once on mount.
  }, []);

  return (
    <IcebreakerView
      peerDisplayName={peerDisplayName}
      selfDisplayName={selfDisplayName}
      phase={phase}
      topics={topics}
      boundaryBlocked={boundaryBlocked}
      degradationNote={degradationNote}
      error={error}
      onUse={onUse}
      onRegenerate={regenerate}
      onSkip={onSkip}
      onDisconnect={onDisconnect}
    />
  );
}