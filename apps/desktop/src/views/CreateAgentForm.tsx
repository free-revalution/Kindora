/**
 * Create / Edit Agent form.
 *
 * 开发手册.md § 6.2 — Nickname, Bio, Interests, Current Activities,
 *                      Social Intent (multi), Conversation Style (multi).
 */

import { useState, type FormEvent } from 'react';
import {
  CONVERSATION_STYLES,
  DEFAULT_SOCIAL_BOUNDARIES,
  SOCIAL_INTENTS,
  type ConversationStyle,
  type SocialBoundaries,
  type SocialIntent,
  type SocialProfile,
} from '@kindora/protocol';
import { isProfileValid, validateProfile } from '@kindora/agent';

const SUGGESTED_INTERESTS = [
  'AI',
  'Programming',
  'Open Source',
  'Gaming',
  'FPV',
  'Indie Hacking',
  'Music',
  'Reading',
  'Climbing',
];

export interface CreateAgentFormProps {
  initialProfile?: SocialProfile;
  submitLabel: string;
  onSubmit: (profile: SocialProfile) => Promise<void>;
  onCancel?: () => void;
}

export function CreateAgentForm({
  initialProfile,
  submitLabel,
  onSubmit,
  onCancel,
}: CreateAgentFormProps) {
  const [nickname, setNickname] = useState(initialProfile?.nickname ?? '');
  const [bio, setBio] = useState(initialProfile?.bio ?? '');
  const [interests, setInterests] = useState<string[]>(initialProfile?.interests ?? []);
  const [interestInput, setInterestInput] = useState('');
  const [currentActivities, setCurrentActivities] = useState<string[]>(
    initialProfile?.currentActivities ?? [],
  );
  const [activityInput, setActivityInput] = useState('');
  const [socialIntent, setSocialIntent] = useState<SocialIntent[]>(
    initialProfile?.socialIntent ?? [],
  );
  const [conversationStyle, setConversationStyle] = useState<ConversationStyle[]>(
    initialProfile?.conversationStyle ?? [],
  );
  const [boundaries] = useState<SocialBoundaries>(
    initialProfile?.boundaries ?? { ...DEFAULT_SOCIAL_BOUNDARIES },
  );
  const [submitting, setSubmitting] = useState(false);

  const profile: SocialProfile = {
    nickname,
    bio,
    interests,
    currentActivities,
    socialIntent,
    conversationStyle,
    boundaries,
  };
  const errors = validateProfile(profile);
  const errorByField = new Map(errors.map((e) => [e.field, e.message]));
  const canSubmit = isProfileValid(profile) && !submitting;

  function addInterest(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (interests.includes(trimmed)) return;
    if (interests.length >= 12) return;
    setInterests([...interests, trimmed]);
    setInterestInput('');
  }

  function removeInterest(value: string) {
    setInterests(interests.filter((i) => i !== value));
  }

  function addActivity(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (currentActivities.includes(trimmed)) return;
    if (currentActivities.length >= 12) return;
    setCurrentActivities([...currentActivities, trimmed]);
    setActivityInput('');
  }

  function removeActivity(value: string) {
    setCurrentActivities(currentActivities.filter((a) => a !== value));
  }

  function toggleIntent(intent: SocialIntent) {
    setSocialIntent(
      socialIntent.includes(intent)
        ? socialIntent.filter((i) => i !== intent)
        : [...socialIntent, intent],
    );
  }

  function toggleStyle(style: ConversationStyle) {
    setConversationStyle(
      conversationStyle.includes(style)
        ? conversationStyle.filter((s) => s !== style)
        : [...conversationStyle, style],
    );
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(profile);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-10"
    >
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">
          {submitLabel === 'Save' ? 'Edit your agent' : 'Create your agent'}
        </h1>
        <p className="text-kindora-600 dark:text-kindora-300 mt-2 text-sm">
          This profile is stored locally and only the public parts are ever shared with another
          agent.
        </p>
      </header>

      <Field label="Nickname" error={errorByField.get('nickname')}>
        <input
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={32}
          className="kindora-input"
          placeholder="Jason"
          autoFocus
        />
      </Field>

      <Field label="Bio" error={errorByField.get('bio')}>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={280}
          rows={3}
          className="kindora-input resize-y"
          placeholder="Software engineer interested in AI agents."
        />
      </Field>

      <Field label="Interests" hint="Up to 12" error={errorByField.get('interests')}>
        <div className="flex flex-wrap gap-2">
          {interests.map((i) => (
            <Chip key={i} onRemove={() => removeInterest(i)}>
              {i}
            </Chip>
          ))}
          {interests.length === 0 && (
            <span className="text-kindora-500 dark:text-kindora-400 text-sm">
              Pick a few from below or type your own.
            </span>
          )}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={interestInput}
            onChange={(e) => setInterestInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addInterest(interestInput);
              }
            }}
            className="kindora-input flex-1"
            placeholder="Add an interest and press Enter"
          />
          <button
            type="button"
            className="kindora-button-ghost"
            onClick={() => addInterest(interestInput)}
          >
            Add
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTED_INTERESTS.filter((s) => !interests.includes(s)).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => addInterest(s)}
              className="border-kindora-300 text-kindora-600 hover:border-kindora-500 hover:text-kindora-800 dark:border-kindora-600 dark:text-kindora-200 dark:hover:border-kindora-400 rounded-full border border-dashed px-3 py-1 text-xs"
            >
              + {s}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Current activities"
        hint="Up to 12 — only shared if your boundaries allow it"
        error={errorByField.get('currentActivities')}
      >
        <div className="flex flex-wrap gap-2">
          {currentActivities.map((a) => (
            <Chip key={a} onRemove={() => removeActivity(a)}>
              {a}
            </Chip>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={activityInput}
            onChange={(e) => setActivityInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addActivity(activityInput);
              }
            }}
            className="kindora-input flex-1"
            placeholder="Building an AI Social Agent project."
          />
          <button
            type="button"
            className="kindora-button-ghost"
            onClick={() => addActivity(activityInput)}
          >
            Add
          </button>
        </div>
      </Field>

      <Field
        label="Social intent"
        hint="Pick what you're looking for. Pick at least one."
        error={errorByField.get('socialIntent')}
      >
        <div className="flex flex-col gap-2">
          {SOCIAL_INTENTS.map((intent) => (
            <Checkbox
              key={intent}
              checked={socialIntent.includes(intent)}
              onChange={() => toggleIntent(intent)}
              label={intentLabel(intent)}
            />
          ))}
        </div>
      </Field>

      <Field
        label="Conversation style"
        hint="Pick at least one."
        error={errorByField.get('conversationStyle')}
      >
        <div className="flex flex-wrap gap-2">
          {CONVERSATION_STYLES.map((style) => (
            <Toggle
              key={style}
              active={conversationStyle.includes(style)}
              onClick={() => toggleStyle(style)}
            >
              {capitalize(style)}
            </Toggle>
          ))}
        </div>
      </Field>

      <div className="border-kindora-100 dark:border-kindora-800 flex items-center justify-between border-t pt-6">
        {onCancel ? (
          <button
            type="button"
            className="kindora-button-ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
        ) : (
          <span />
        )}
        <button type="submit" className="kindora-button px-8" disabled={!canSubmit}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function intentLabel(intent: SocialIntent): string {
  switch (intent) {
    case 'similar_interests':
      return 'Meet people with similar interests';
    case 'project_partner':
      return 'Find project partners';
    case 'gaming_partner':
      return 'Find gaming partners';
    case 'learning_partner':
      return 'Find learning partners';
    case 'technical_discussion':
      return 'Discuss technical topics';
    case 'long_term_friendship':
      return 'Make long-term friends';
    case 'activity_partner':
      return 'Find activity partners';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <label className="text-sm font-medium">{label}</label>
        {hint && (
          <span className="text-kindora-500 dark:text-kindora-400 ml-2 text-xs">{hint}</span>
        )}
      </div>
      {children}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}

function Chip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <span className="kindora-chip">
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${typeof children === 'string' ? children : ''}`}
        className="kindora-chip-x"
      >
        ×
      </button>
    </span>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="hover:bg-kindora-50 dark:hover:bg-kindora-800 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2">
      <input type="checkbox" checked={checked} onChange={onChange} className="kindora-checkbox" />
      <span className="text-sm">{label}</span>
    </label>
  );
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active ? 'kindora-toggle kindora-toggle-active' : 'kindora-toggle kindora-toggle-idle'
      }
    >
      {children}
    </button>
  );
}
