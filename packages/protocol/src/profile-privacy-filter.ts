/**
 * Profile privacy filter — Phase B (task book § 五 B2).
 *
 * The task book requires:
 *
 *   > 建议新增独立模块 `packages/protocol/src/profile-privacy-filter.ts`
 *   > 负责：字段授权判断 / Profile 最小化 / 敏感字段过滤 / 发送前的数据校验
 *
 * and, as a hard requirement:
 *
 *   > Profile 发送前必须根据授权范围进行字段过滤。
 *   > 未授权字段不得出现在序列化结果中。
 *   > 不允许先发送完整资料，再依靠对方遵守隐私约定。
 *
 * ## The invariant this module exists to guarantee
 *
 * **A peer's message can never widen the local user's authorisation.**
 *
 * Every function here reads the **local** `SocialBoundaries` and the
 * **local** profile. Nothing in this module ever consults a peer's
 * boundaries or a peer's consent envelope to decide what the local
 * user is allowed to send. That is why the filter is applied to the
 * *outgoing* copy of the profile and never to the incoming one: the
 * incoming copy is already whatever the peer chose to send us, and
 * re-filtering it with our own boundaries would be a category error
 * (it would silently rewrite the peer's message rather than our own
 * disclosure).
 *
 * ## Two disclosure stages
 *
 * Phase B reorders the wire flow (task book § 五 B2):
 *
 *   1. `buildPublicCard` — the **minimal public card** that is sent
 *      *before* the human consent step. It contains the nickname and
 *      (only if authorised) the social intent and conversation style —
 *      enough for the consent screen to be a real decision, and
 *      nothing else.
 *   2. `filterProfileForOutbound` — the **authorised profile** that is
 *      sent *after* both sides have accepted. Every field the user did
 *      not authorise is removed here, before serialisation.
 *
 * ## Why the fields are emptied rather than deleted
 *
 * `SocialProfile.bio` is a required `string` and `socialIntent` /
 * `conversationStyle` are required arrays. The wire validator is
 * relaxed (see `validation.ts`) so that a *redacted* profile is a legal
 * profile: `bio` may be empty, and the two arrays may be empty. An
 * unauthorised field therefore carries **no data** — the information is
 * gone, which is what requirement 4 is about.
 *
 * See docs/修复.md § 五 B2, docs/REMEDIATION_PROGRESS.md
 * 「Phase B 的复核（2026-11-05）」.
 */
import { DEFAULT_SOCIAL_BOUNDARIES, type SocialBoundaries, type SocialProfile } from './index';

/**
 * The profile fields whose disclosure the user can authorise
 * individually.
 *
 * `nickname` is deliberately absent: it is the agent's identity (it is
 * already in the `hello` envelope) and it is structurally required by
 * the protocol — there is no meaningful "anonymous" profile.
 */
export type ProfileField =
  'avatar' | 'bio' | 'interests' | 'currentActivities' | 'socialIntent' | 'conversationStyle';

/**
 * The authorisation rule for every field.
 *
 * Task book § 五 B2 requirement 9: 「对每个资料字段建立授权规则」.
 * This table is the single place where a field is mapped to the
 * boundary flag that gates it — the filter, the UI and the tests all
 * read it, so a new field cannot be added without deciding how it is
 * authorised.
 */
export interface ProfileFieldRule {
  /** The field this rule governs. */
  readonly field: ProfileField;
  /** The `SocialBoundaries` flag that decides whether it may be sent. */
  readonly boundaryFlag: keyof SocialBoundaries;
  /** True when the field may never appear in the pre-consent card. */
  readonly neverInPublicCard: boolean;
}

export const PROFILE_FIELD_RULES: readonly ProfileFieldRule[] = Object.freeze([
  { field: 'avatar', boundaryFlag: 'allowAvatar', neverInPublicCard: true },
  { field: 'bio', boundaryFlag: 'allowBio', neverInPublicCard: true },
  { field: 'interests', boundaryFlag: 'allowInterests', neverInPublicCard: true },
  { field: 'currentActivities', boundaryFlag: 'allowCurrentActivity', neverInPublicCard: true },
  { field: 'socialIntent', boundaryFlag: 'allowSocialIntent', neverInPublicCard: false },
  { field: 'conversationStyle', boundaryFlag: 'allowConversationStyle', neverInPublicCard: false },
]);

/**
 * Thrown when a profile that is about to go on the wire still carries a
 * field the user did not authorise.
 *
 * This is a **programmer error**, not a user error: the filter is
 * supposed to have removed the field already. The assertion exists so
 * that a future change to the filter cannot silently start leaking.
 */
export class ProfilePrivacyError extends Error {
  readonly label: string;
  readonly fields: readonly ProfileField[];

  constructor(label: string, fields: readonly ProfileField[]) {
    super(
      `Profile privacy check failed for ${label}: unauthorised field(s) still present: ${fields.join(', ')}.`,
    );
    this.name = 'ProfilePrivacyError';
    this.label = label;
    this.fields = Object.freeze([...fields]);
  }
}

/**
 * Fill in the boundary flags that a peer (or an older stored record)
 * may not carry.
 *
 * The field-level flags are optional in `SocialBoundaries` because they
 * were added after KSA 0.1 shipped — the same forward-compatibility
 * rule the capability flags follow (see `validation.ts`). A missing
 * flag falls back to the default, which is the conservative one for
 * `bio` / `avatar` / `currentActivities` and the permissive one for
 * `interests` / `socialIntent` / `conversationStyle`.
 *
 * This is the **only** place a partially-specified boundaries object is
 * turned into a complete one; everything downstream may assume all
 * ten flags are present.
 */
export function resolveBoundaries(raw?: Partial<SocialBoundaries> | null): SocialBoundaries {
  const d = DEFAULT_SOCIAL_BOUNDARIES;
  return {
    allowAgentConversation: raw?.allowAgentConversation ?? d.allowAgentConversation,
    allowContactExchange: raw?.allowContactExchange ?? d.allowContactExchange,
    allowOfflineMeeting: raw?.allowOfflineMeeting ?? d.allowOfflineMeeting,
    allowProjectDetails: raw?.allowProjectDetails ?? d.allowProjectDetails,
    allowCurrentActivity: raw?.allowCurrentActivity ?? d.allowCurrentActivity,
    allowBio: raw?.allowBio ?? d.allowBio,
    allowInterests: raw?.allowInterests ?? d.allowInterests,
    allowAvatar: raw?.allowAvatar ?? d.allowAvatar,
    allowSocialIntent: raw?.allowSocialIntent ?? d.allowSocialIntent,
    allowConversationStyle: raw?.allowConversationStyle ?? d.allowConversationStyle,
  };
}

/**
 * True iff the user has authorised the given field's disclosure.
 */
export function isFieldAllowed(field: ProfileField, boundaries: SocialBoundaries): boolean {
  const rule = PROFILE_FIELD_RULES.find((r) => r.field === field);
  if (!rule) return false;
  return boundaries[rule.boundaryFlag] === true;
}

/**
 * True iff the field may appear in the pre-consent public card.
 *
 * The card exists so that the consent screen can be a real decision.
 * It therefore carries the fields that describe *what the user is
 * looking for* — never the fields that describe *what the user is
 * doing* (bio / interests / activities / avatar), because those are
 * exactly the ones the user has to consent to before they leave the
 * device.
 */
export function isFieldAllowedInPublicCard(
  field: ProfileField,
  boundaries: SocialBoundaries,
): boolean {
  const rule = PROFILE_FIELD_RULES.find((r) => r.field === field);
  if (!rule) return false;
  if (rule.neverInPublicCard) return false;
  return isFieldAllowed(field, boundaries);
}

/**
 * The minimal public card — the only profile data that may leave the
 * device *before* the human consent step.
 *
 * Contains: the nickname (identity — already disclosed by `hello`),
 * the social intent and the conversation style, each only when the
 * user has authorised it.
 *
 * Never contains: `bio`, `interests`, `currentActivities`, `avatar`.
 */
export function buildPublicCard(
  profile: SocialProfile,
  boundaries?: Partial<SocialBoundaries> | null,
): SocialProfile {
  const b = resolveBoundaries(boundaries ?? profile.boundaries);
  return {
    nickname: profile.nickname,
    bio: '',
    interests: [],
    currentActivities: [],
    socialIntent: isFieldAllowedInPublicCard('socialIntent', b) ? [...profile.socialIntent] : [],
    conversationStyle: isFieldAllowedInPublicCard('conversationStyle', b)
      ? [...profile.conversationStyle]
      : [],
    boundaries: b,
  };
}

/**
 * The authorised profile — what may leave the device *after* the
 * human consent step.
 *
 * Every field the user did not authorise is emptied (or omitted, for
 * the optional `avatar`) here, before the envelope is built.
 */
export function filterProfileForOutbound(
  profile: SocialProfile,
  boundaries?: Partial<SocialBoundaries> | null,
): SocialProfile {
  const b = resolveBoundaries(boundaries ?? profile.boundaries);
  const card = {
    nickname: profile.nickname,
    bio: isFieldAllowed('bio', b) ? profile.bio : '',
    interests: isFieldAllowed('interests', b) ? [...profile.interests] : [],
    currentActivities: isFieldAllowed('currentActivities', b) ? [...profile.currentActivities] : [],
    socialIntent: isFieldAllowed('socialIntent', b) ? [...profile.socialIntent] : [],
    conversationStyle: isFieldAllowed('conversationStyle', b) ? [...profile.conversationStyle] : [],
    boundaries: b,
  };
  // `avatar` is optional on the wire — when it is not authorised the
  // key is omitted entirely rather than sent as an empty string, so
  // that "未授权字段不得出现在序列化结果中" holds literally.
  return isFieldAllowed('avatar', b) && profile.avatar !== undefined
    ? { ...card, avatar: profile.avatar }
    : card;
}

/**
 * The fields that `filterProfileForOutbound` would strip from this
 * profile. Used by the UI ("these are not being shared") and by the
 * tests that assert the redaction set.
 */
export function redactedFields(
  profile: SocialProfile,
  boundaries?: Partial<SocialBoundaries> | null,
): ProfileField[] {
  const b = resolveBoundaries(boundaries ?? profile.boundaries);
  const out: ProfileField[] = [];
  if (!isFieldAllowed('avatar', b) && profile.avatar !== undefined) out.push('avatar');
  if (!isFieldAllowed('bio', b) && profile.bio.trim() !== '') out.push('bio');
  if (!isFieldAllowed('interests', b) && profile.interests.length > 0) out.push('interests');
  if (!isFieldAllowed('currentActivities', b) && profile.currentActivities.length > 0) {
    out.push('currentActivities');
  }
  if (!isFieldAllowed('socialIntent', b) && profile.socialIntent.length > 0) {
    out.push('socialIntent');
  }
  if (!isFieldAllowed('conversationStyle', b) && profile.conversationStyle.length > 0) {
    out.push('conversationStyle');
  }
  return out;
}

/**
 * Pre-send validation: assert that the profile really does respect the
 * user's authorisation.
 *
 * Throws `ProfilePrivacyError` when an unauthorised field still carries
 * data. This is the last line of defence before an envelope is built —
 * it turns "someone forgot to filter" from a silent privacy leak into
 * a loud failure.
 */
export function assertProfileWithinBoundaries(
  profile: SocialProfile,
  boundaries?: Partial<SocialBoundaries> | null,
  label = 'profile',
): void {
  const problems = redactedFields(profile, boundaries);
  if (problems.length > 0) {
    throw new ProfilePrivacyError(label, problems);
  }
}
