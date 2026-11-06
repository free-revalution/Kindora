/**
 * Create / Edit Agent form.
 *
 * 开发手册.md § 6.2 — Nickname, Bio, Interests, Current Activities,
 *                      Social Intent (multi), Conversation Style (multi).
 */

import { useState, type FormEvent } from 'react';
import {
  CONVERSATION_STYLES,
  SOCIAL_INTENTS,
  resolveBoundaries,
  type ConversationStyle,
  type SocialBoundaries,
  type SocialIntent,
  type SocialProfile,
} from '@kindora/protocol';
import { DEFAULT_PROFILE_LIMITS, isProfileValid, validateProfile } from '@kindora/agent';
import {
  CONVERSATION_STYLE_KEYS,
  PROFILE_VALIDATION_KEYS,
  SOCIAL_INTENT_KEYS,
  useTranslate,
  type TranslationKey,
} from '../i18n';

/**
 * Suggestions are translation KEYS, not strings. The label the user sees — and
 * therefore the value stored in `profile.interests` — is resolved through `t`,
 * so a Chinese user gets Chinese suggestions that are meaningful to them.
 */
const SUGGESTED_INTEREST_KEYS: readonly TranslationKey[] = [
  'agent.suggestedInterest.ai',
  'agent.suggestedInterest.programming',
  'agent.suggestedInterest.openSource',
  'agent.suggestedInterest.gaming',
  'agent.suggestedInterest.fpv',
  'agent.suggestedInterest.indieHacking',
  'agent.suggestedInterest.music',
  'agent.suggestedInterest.reading',
  'agent.suggestedInterest.climbing',
];

export interface CreateAgentFormProps {
  initialProfile?: SocialProfile;
  /**
   * Which screen this is. Drives the heading and the submit button label.
   * An explicit variant replaces the old `submitLabel === 'Save'` string
   * comparison, which could not survive being translated.
   */
  variant: 'create' | 'edit';
  onSubmit: (profile: SocialProfile) => Promise<void>;
  onCancel?: () => void;
}

/**
 * One privacy switch.
 *
 * `flag` is the `SocialBoundaries` key it toggles; the two translation
 * keys carry the label and the explanation. The table is the UI's
 * mirror of the protocol's `PROFILE_FIELD_RULES` — the same set of
 * flags, grouped the way a user thinks about them.
 */
interface BoundarySwitch {
  readonly flag: keyof SocialBoundaries;
  readonly labelKey: TranslationKey;
  readonly hintKey: TranslationKey;
}

/** Permissions for the conversation itself. */
const BEHAVIOUR_SWITCHES: readonly BoundarySwitch[] = [
  {
    flag: 'allowAgentConversation',
    labelKey: 'privacy.allowAgentConversation',
    hintKey: 'privacy.allowAgentConversationHint',
  },
  {
    flag: 'allowContactExchange',
    labelKey: 'privacy.allowContactExchange',
    hintKey: 'privacy.allowContactExchangeHint',
  },
  {
    flag: 'allowOfflineMeeting',
    labelKey: 'privacy.allowOfflineMeeting',
    hintKey: 'privacy.allowOfflineMeetingHint',
  },
  {
    flag: 'allowProjectDetails',
    labelKey: 'privacy.allowProjectDetails',
    hintKey: 'privacy.allowProjectDetailsHint',
  },
];

/** Which parts of the profile are visible to the other agent. */
const FIELD_SWITCHES: readonly BoundarySwitch[] = [
  {
    flag: 'allowBio',
    labelKey: 'privacy.allowBio',
    hintKey: 'privacy.allowBioHint',
  },
  {
    flag: 'allowInterests',
    labelKey: 'privacy.allowInterests',
    hintKey: 'privacy.allowInterestsHint',
  },
  {
    flag: 'allowCurrentActivity',
    labelKey: 'privacy.allowCurrentActivity',
    hintKey: 'privacy.allowCurrentActivityHint',
  },
  {
    flag: 'allowAvatar',
    labelKey: 'privacy.allowAvatar',
    hintKey: 'privacy.allowAvatarHint',
  },
  {
    flag: 'allowSocialIntent',
    labelKey: 'privacy.allowSocialIntent',
    hintKey: 'privacy.allowSocialIntentHint',
  },
  {
    flag: 'allowConversationStyle',
    labelKey: 'privacy.allowConversationStyle',
    hintKey: 'privacy.allowConversationStyleHint',
  },
];

export function CreateAgentForm({
  initialProfile,
  variant,
  onSubmit,
  onCancel,
}: CreateAgentFormProps) {
  const t = useTranslate();
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
  // Phase B / B1 — the privacy switches are editable and persisted with
  // the profile. `resolveBoundaries` fills in the flags a record
  // written before Phase B did not carry, so the form always starts
  // from a complete set.
  const [boundaries, setBoundaries] = useState<SocialBoundaries>(
    resolveBoundaries(initialProfile?.boundaries),
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
  // Validation messages come from `@kindora/agent` in English. We localise them
  // from the error's `code` (see PROFILE_VALIDATION_KEYS) and pass the real
  // limit through, so the number shown always matches the limit that actually
  // rejected the input. `message` remains the fallback for any code we have not
  // mapped yet.
  const errorByField = new Map(
    errors.map((e) => [
      e.field,
      t(PROFILE_VALIDATION_KEYS[e.code], { max: validationLimit(e.code) }),
    ]),
  );
  const canSubmit = isProfileValid(profile) && !submitting;

  const suggestedInterests = SUGGESTED_INTEREST_KEYS.map((k) => t(k));

  function addInterest(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (interests.includes(trimmed)) return;
    if (interests.length >= DEFAULT_PROFILE_LIMITS.maxInterests) return;
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
    if (currentActivities.length >= DEFAULT_PROFILE_LIMITS.maxActivities) return;
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

  function toggleBoundary(flag: keyof SocialBoundaries) {
    setBoundaries((current) => ({ ...current, [flag]: current[flag] !== true }));
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
          {t(variant === 'edit' ? 'agent.editTitle' : 'agent.createTitle')}
        </h1>
        <p className="text-kindora-600 dark:text-kindora-300 mt-2 text-sm">{t('agent.body')}</p>
      </header>

      <Field label={t('agent.nickname')} error={errorByField.get('nickname')}>
        <input
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={32}
          className="kindora-input"
          placeholder={t('agent.nicknamePlaceholder')}
          autoFocus
        />
      </Field>

      <Field label={t('agent.bio')} error={errorByField.get('bio')}>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={280}
          rows={3}
          className="kindora-input resize-y"
          placeholder={t('agent.bioPlaceholder')}
        />
      </Field>

      <Field
        label={t('agent.interests')}
        hint={t('agent.interestsHint', { max: DEFAULT_PROFILE_LIMITS.maxInterests })}
        error={errorByField.get('interests')}
      >
        <div className="flex flex-wrap gap-2">
          {interests.map((i) => (
            <Chip
              key={i}
              onRemove={() => removeInterest(i)}
              removeLabel={t('agent.removeItem', { value: i })}
            >
              {i}
            </Chip>
          ))}
          {interests.length === 0 && (
            <span className="text-kindora-500 dark:text-kindora-400 text-sm">
              {t('agent.interestsEmpty')}
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
            placeholder={t('agent.interestsPlaceholder')}
          />
          <button
            type="button"
            className="kindora-button-ghost"
            onClick={() => addInterest(interestInput)}
          >
            {t('common.add')}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {suggestedInterests
            .filter((s) => !interests.includes(s))
            .map((s) => (
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
        label={t('agent.currentActivities')}
        hint={t('agent.currentActivitiesHint', { max: DEFAULT_PROFILE_LIMITS.maxActivities })}
        error={errorByField.get('currentActivities')}
      >
        <div className="flex flex-wrap gap-2">
          {currentActivities.map((a) => (
            <Chip
              key={a}
              onRemove={() => removeActivity(a)}
              removeLabel={t('agent.removeItem', { value: a })}
            >
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
            placeholder={t('agent.currentActivitiesPlaceholder')}
          />
          <button
            type="button"
            className="kindora-button-ghost"
            onClick={() => addActivity(activityInput)}
          >
            {t('common.add')}
          </button>
        </div>
      </Field>

      <Field
        label={t('agent.socialIntent')}
        hint={t('agent.socialIntentHint')}
        error={errorByField.get('socialIntent')}
      >
        <div className="flex flex-col gap-2">
          {SOCIAL_INTENTS.map((intent) => (
            <Checkbox
              key={intent}
              checked={socialIntent.includes(intent)}
              onChange={() => toggleIntent(intent)}
              label={t(SOCIAL_INTENT_KEYS[intent])}
            />
          ))}
        </div>
      </Field>

      <Field
        label={t('agent.conversationStyle')}
        hint={t('agent.conversationStyleHint')}
        error={errorByField.get('conversationStyle')}
      >
        <div className="flex flex-wrap gap-2">
          {CONVERSATION_STYLES.map((style) => (
            <Toggle
              key={style}
              active={conversationStyle.includes(style)}
              onClick={() => toggleStyle(style)}
            >
              {t(CONVERSATION_STYLE_KEYS[style])}
            </Toggle>
          ))}
        </div>
      </Field>

      {/* Phase B / B1 — the privacy switches. They are part of the
          profile, so they are saved with it: an edit to a switch is
          saved when the form is submitted. */}
      <section className="kindora-card flex flex-col gap-5">
        <div>
          <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            {t('privacy.title')}
          </h2>
          <p className="text-kindora-600 dark:text-kindora-300 mt-2 text-sm leading-relaxed">
            {t('privacy.intro')}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('privacy.behaviourTitle')}</h3>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs">
            {t('privacy.behaviourIntro')}
          </p>
          <div className="mt-1 flex flex-col">
            {BEHAVIOUR_SWITCHES.map((s) => (
              <BoundaryRow
                key={s.flag}
                flag={s.flag}
                checked={boundaries[s.flag] === true}
                onChange={() => toggleBoundary(s.flag)}
                label={t(s.labelKey)}
                hint={t(s.hintKey)}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t('privacy.fieldsTitle')}</h3>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs">
            {t('privacy.fieldsIntro')}
          </p>
          <div className="mt-1 flex flex-col">
            {FIELD_SWITCHES.map((s) => (
              <BoundaryRow
                key={s.flag}
                flag={s.flag}
                checked={boundaries[s.flag] === true}
                onChange={() => toggleBoundary(s.flag)}
                label={t(s.labelKey)}
                hint={t(s.hintKey)}
              />
            ))}
          </div>
        </div>
      </section>

      <div className="border-kindora-100 dark:border-kindora-800 flex items-center justify-between border-t pt-6">
        {onCancel ? (
          <button
            type="button"
            className="kindora-button-ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            {t('common.cancel')}
          </button>
        ) : (
          <span />
        )}
        <button type="submit" className="kindora-button px-8" disabled={!canSubmit}>
          {submitting
            ? t('common.saving')
            : t(variant === 'edit' ? 'agent.saveSubmit' : 'agent.createSubmit')}
        </button>
      </div>
    </form>
  );
}

/**
 * The limit each validation code refers to. Kept beside the form rather than
 * parsed out of the English `message` — a wording change must not silently
 * change which number the user is shown.
 */
function validationLimit(code: keyof typeof PROFILE_VALIDATION_KEYS): number {
  switch (code) {
    case 'nickname_too_long':
      return DEFAULT_PROFILE_LIMITS.maxNickname;
    case 'bio_too_long':
      return DEFAULT_PROFILE_LIMITS.maxBio;
    case 'interests_too_many':
      return DEFAULT_PROFILE_LIMITS.maxInterests;
    case 'activities_too_many':
      return DEFAULT_PROFILE_LIMITS.maxActivities;
    case 'social_intent_too_many':
      return DEFAULT_PROFILE_LIMITS.maxIntent;
    case 'conversation_style_too_many':
      return DEFAULT_PROFILE_LIMITS.maxStyle;
    default:
      return 0;
  }
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

function Chip({
  children,
  onRemove,
  removeLabel,
}: {
  children: React.ReactNode;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span className="kindora-chip">
      {children}
      <button type="button" onClick={onRemove} aria-label={removeLabel} className="kindora-chip-x">
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

/**
 * One privacy switch: a checkbox, the field name, and what turning it
 * on actually means.
 *
 * The state badge says "Shared" / "Private" rather than "on" / "off" —
 * the switch is about what leaves the device, not about a feature
 * being enabled.
 */
function BoundaryRow({
  flag,
  checked,
  onChange,
  label,
  hint,
}: {
  flag: keyof SocialBoundaries;
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
}) {
  const t = useTranslate();
  return (
    <label
      className="hover:bg-kindora-50 dark:hover:bg-kindora-800 flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2"
      data-testid={`boundary-row-${flag}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="kindora-checkbox mt-0.5"
        data-testid={`boundary-${flag}`}
      />
      <span className="flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="text-sm">{label}</span>
          <span
            className={
              checked
                ? 'text-xs text-emerald-700 dark:text-emerald-400'
                : 'text-kindora-500 dark:text-kindora-400 text-xs'
            }
          >
            {t(checked ? 'privacy.visible' : 'privacy.hidden')}
          </span>
        </span>
        <span className="text-kindora-500 dark:text-kindora-400 text-xs leading-relaxed">
          {hint}
        </span>
      </span>
    </label>
  );
}
