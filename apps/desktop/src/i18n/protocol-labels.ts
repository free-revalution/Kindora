/**
 * Protocol value → translation key.
 *
 * Several UI strings are labels for a *protocol enum value* rather than fixed
 * copy: social intents, conversation styles, compatibility signals, chat-assist
 * suggestion kinds, profile-validation failures. These maps are declared as
 * `Record<Union, TranslationKey>`, so:
 *
 *   - a new enum member in `@kindora/protocol` or `@kindora/agent` is a
 *     COMPILE ERROR here, not a screen showing a raw `similar_interests`; and
 *   - the compiler proves every value has a key in every dictionary.
 *
 * That is why these are hand-written rather than built with
 * `` `home.intent.${value}` `` — a template literal type would happily accept
 * any string and give us none of the above.
 */

import type { CompatibilitySignal, ConversationStyle, SocialIntent } from '@kindora/protocol';
import type { ChatAssistKind, ProfileValidationCode } from '@kindora/agent';
import type { LlmUnavailableReason } from '../lib/llm-service';
import type { TranslationKey } from './dictionaries/en';

/** Long, sentence-form labels — the multi-select in the agent form. */
export const SOCIAL_INTENT_KEYS: Readonly<Record<SocialIntent, TranslationKey>> = {
  similar_interests: 'agent.intent.similar_interests',
  project_partner: 'agent.intent.project_partner',
  gaming_partner: 'agent.intent.gaming_partner',
  learning_partner: 'agent.intent.learning_partner',
  technical_discussion: 'agent.intent.technical_discussion',
  long_term_friendship: 'agent.intent.long_term_friendship',
  activity_partner: 'agent.intent.activity_partner',
};

/** Short noun-phrase labels — the "Looking for" summary on Home. */
export const SOCIAL_INTENT_SHORT_KEYS: Readonly<Record<SocialIntent, TranslationKey>> = {
  similar_interests: 'home.intent.similar_interests',
  project_partner: 'home.intent.project_partner',
  gaming_partner: 'home.intent.gaming_partner',
  learning_partner: 'home.intent.learning_partner',
  technical_discussion: 'home.intent.technical_discussion',
  long_term_friendship: 'home.intent.long_term_friendship',
  activity_partner: 'home.intent.activity_partner',
};

export const CONVERSATION_STYLE_KEYS: Readonly<Record<ConversationStyle, TranslationKey>> = {
  casual: 'agent.style.casual',
  deep: 'agent.style.deep',
  technical: 'agent.style.technical',
  funny: 'agent.style.funny',
  quiet: 'agent.style.quiet',
};

export const COMPATIBILITY_SIGNAL_KEYS: Readonly<Record<CompatibilitySignal, TranslationKey>> = {
  strong: 'match.signal.strong',
  moderate: 'match.signal.moderate',
  weak: 'match.signal.weak',
  none: 'match.signal.none',
};

export const CHAT_ASSIST_KIND_KEYS: Readonly<Record<ChatAssistKind, TranslationKey>> = {
  reply: 'chat.assist.kind.reply',
  topic: 'chat.assist.kind.topic',
  explanation: 'chat.assist.kind.explanation',
};

export const PROFILE_VALIDATION_KEYS: Readonly<Record<ProfileValidationCode, TranslationKey>> = {
  nickname_required: 'validation.nickname_required',
  nickname_too_long: 'validation.nickname_too_long',
  bio_required: 'validation.bio_required',
  bio_too_long: 'validation.bio_too_long',
  interests_required: 'validation.interests_required',
  interests_too_many: 'validation.interests_too_many',
  activities_too_many: 'validation.activities_too_many',
  social_intent_required: 'validation.social_intent_required',
  social_intent_too_many: 'validation.social_intent_too_many',
  conversation_style_required: 'validation.conversation_style_required',
  conversation_style_too_many: 'validation.conversation_style_too_many',
};

/**
 * Why the app cannot build an LLM provider → the copy for the Connect
 * screen's "not ready" banner.
 *
 * The three reasons need three different messages. "You never configured an
 * LLM" and "your API key is not in the keychain" look identical from the
 * outside, and a user who has just pressed Save deserves to be told which one
 * they are looking at.
 */
export const LLM_STATUS_KEYS: Readonly<
  Record<LlmUnavailableReason, { title: TranslationKey; body: TranslationKey }>
> = {
  not_configured: {
    title: 'connect.llmNotConfigured',
    body: 'connect.llmNotConfiguredBody',
  },
  missing_api_key: {
    title: 'connect.llmMissingApiKeyTitle',
    body: 'connect.llmMissingApiKeyBody',
  },
  invalid_config: {
    title: 'connect.llmInvalidConfigTitle',
    body: 'connect.llmInvalidConfigBody',
  },
};
