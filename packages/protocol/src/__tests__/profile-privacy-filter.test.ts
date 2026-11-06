/**
 * Phase B / B2 — the profile privacy filter.
 *
 * Task book § 五 B2:
 *   > Profile 发送前必须根据授权范围进行字段过滤。
 *   > 未授权字段不得出现在序列化结果中。
 *   > 不允许先发送完整资料，再依靠对方遵守隐私约定。
 *
 * These tests cover the four jobs the task book assigns to
 * `packages/protocol/src/profile-privacy-filter.ts`:
 *
 *   1. 字段授权判断      — `isFieldAllowed` / `isFieldAllowedInPublicCard`
 *   2. Profile 最小化    — `buildPublicCard`
 *   3. 敏感字段过滤      — `filterProfileForOutbound` / `redactedFields`
 *   4. 发送前的数据校验  — `assertProfileWithinBoundaries`
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_SOCIAL_BOUNDARIES, type SocialBoundaries, type SocialProfile } from '../index';
import {
  PROFILE_FIELD_RULES,
  ProfilePrivacyError,
  assertProfileWithinBoundaries,
  buildPublicCard,
  filterProfileForOutbound,
  isFieldAllowed,
  isFieldAllowedInPublicCard,
  redactedFields,
  resolveBoundaries,
} from '../profile-privacy-filter';

function buildProfile(overrides: Partial<SocialProfile> = {}): SocialProfile {
  return {
    nickname: 'Alice',
    bio: 'ALICE-BIO',
    interests: ['typescript', 'reading'],
    currentActivities: ['side project'],
    socialIntent: ['similar_interests'],
    conversationStyle: ['casual'],
    boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
    ...overrides,
  };
}

/** Boundaries with every field-level gate switched on. */
const ALL_FIELDS_ALLOWED: SocialBoundaries = {
  allowAgentConversation: true,
  allowContactExchange: true,
  allowOfflineMeeting: true,
  allowProjectDetails: true,
  allowCurrentActivity: true,
  allowBio: true,
  allowInterests: true,
  allowAvatar: true,
  allowSocialIntent: true,
  allowConversationStyle: true,
};

/** Boundaries with every field-level gate switched off. */
const NO_FIELDS_ALLOWED: SocialBoundaries = {
  allowAgentConversation: true,
  allowContactExchange: false,
  allowOfflineMeeting: false,
  allowProjectDetails: false,
  allowCurrentActivity: false,
  allowBio: false,
  allowInterests: false,
  allowAvatar: false,
  allowSocialIntent: false,
  allowConversationStyle: false,
};

describe('@kindora/protocol — profile privacy filter (Phase B / B2)', () => {
  describe('resolveBoundaries', () => {
    it('fills in every missing flag from the defaults', () => {
      const resolved = resolveBoundaries({
        allowAgentConversation: false,
        allowContactExchange: true,
      });
      expect(resolved.allowAgentConversation).toBe(false);
      expect(resolved.allowContactExchange).toBe(true);
      // Everything else falls back to the default.
      expect(resolved.allowOfflineMeeting).toBe(DEFAULT_SOCIAL_BOUNDARIES.allowOfflineMeeting);
      expect(resolved.allowProjectDetails).toBe(DEFAULT_SOCIAL_BOUNDARIES.allowProjectDetails);
      expect(resolved.allowCurrentActivity).toBe(DEFAULT_SOCIAL_BOUNDARIES.allowCurrentActivity);
      expect(resolved.allowBio).toBe(DEFAULT_SOCIAL_BOUNDARIES.allowBio);
      expect(resolved.allowInterests).toBe(DEFAULT_SOCIAL_BOUNDARIES.allowInterests);
      expect(resolved.allowAvatar).toBe(DEFAULT_SOCIAL_BOUNDARIES.allowAvatar);
      expect(resolved.allowSocialIntent).toBe(DEFAULT_SOCIAL_BOUNDARIES.allowSocialIntent);
      expect(resolved.allowConversationStyle).toBe(
        DEFAULT_SOCIAL_BOUNDARIES.allowConversationStyle,
      );
    });

    it('returns the defaults for undefined / null / empty input', () => {
      expect(resolveBoundaries()).toEqual(DEFAULT_SOCIAL_BOUNDARIES);
      expect(resolveBoundaries(null)).toEqual(DEFAULT_SOCIAL_BOUNDARIES);
      expect(resolveBoundaries({})).toEqual(DEFAULT_SOCIAL_BOUNDARIES);
    });

    it('the defaults are the minimal-necessary set (B1 requirement 7)', () => {
      // 「默认值采用最小必要授权原则」 — the user's ruling for this
      // phase was 「兴趣开，其余关」: interests on, everything else off
      // except the behavioural permissions the product needs.
      expect(DEFAULT_SOCIAL_BOUNDARIES.allowInterests).toBe(true);
      expect(DEFAULT_SOCIAL_BOUNDARIES.allowBio).toBe(false);
      expect(DEFAULT_SOCIAL_BOUNDARIES.allowAvatar).toBe(false);
      expect(DEFAULT_SOCIAL_BOUNDARIES.allowCurrentActivity).toBe(false);
      expect(DEFAULT_SOCIAL_BOUNDARIES.allowContactExchange).toBe(false);
      expect(DEFAULT_SOCIAL_BOUNDARIES.allowOfflineMeeting).toBe(false);
      expect(DEFAULT_SOCIAL_BOUNDARIES.allowProjectDetails).toBe(false);
    });
  });

  describe('the authorisation rule table', () => {
    it('every rule maps a field to an existing boundary flag', () => {
      for (const rule of PROFILE_FIELD_RULES) {
        expect(typeof rule.boundaryFlag).toBe('string');
        expect(rule.boundaryFlag in DEFAULT_SOCIAL_BOUNDARIES).toBe(true);
      }
    });

    it('covers every field the filter can gate', () => {
      const fields = PROFILE_FIELD_RULES.map((r) => r.field).sort();
      expect(fields).toEqual(
        [
          'avatar',
          'bio',
          'conversationStyle',
          'currentActivities',
          'interests',
          'socialIntent',
        ].sort(),
      );
    });
  });

  describe('isFieldAllowed / isFieldAllowedInPublicCard', () => {
    it('reads the flag the rule points at', () => {
      expect(isFieldAllowed('bio', ALL_FIELDS_ALLOWED)).toBe(true);
      expect(isFieldAllowed('bio', NO_FIELDS_ALLOWED)).toBe(false);
      expect(isFieldAllowed('interests', NO_FIELDS_ALLOWED)).toBe(false);
      expect(isFieldAllowed('interests', ALL_FIELDS_ALLOWED)).toBe(true);
    });

    it('the "current activities" field is gated by allowCurrentActivity', () => {
      const b: SocialBoundaries = {
        ...NO_FIELDS_ALLOWED,
        allowCurrentActivity: true,
      };
      expect(isFieldAllowed('currentActivities', b)).toBe(true);
    });

    it('never allows a "what the user is doing" field in the public card', () => {
      for (const field of ['bio', 'interests', 'currentActivities', 'avatar'] as const) {
        expect(isFieldAllowedInPublicCard(field, ALL_FIELDS_ALLOWED)).toBe(false);
      }
    });

    it('allows the "what the user is looking for" fields in the card when authorised', () => {
      expect(isFieldAllowedInPublicCard('socialIntent', ALL_FIELDS_ALLOWED)).toBe(true);
      expect(isFieldAllowedInPublicCard('conversationStyle', ALL_FIELDS_ALLOWED)).toBe(true);
      expect(isFieldAllowedInPublicCard('socialIntent', NO_FIELDS_ALLOWED)).toBe(false);
      expect(isFieldAllowedInPublicCard('conversationStyle', NO_FIELDS_ALLOWED)).toBe(false);
    });
  });

  describe('buildPublicCard — the pre-consent disclosure', () => {
    it('contains only the nickname, the social intent and the conversation style', () => {
      const card = buildPublicCard(buildProfile(), ALL_FIELDS_ALLOWED);
      expect(card.nickname).toBe('Alice');
      expect(card.socialIntent).toEqual(['similar_interests']);
      expect(card.conversationStyle).toEqual(['casual']);
      // The "what the user is doing" fields never appear.
      expect(card.bio).toBe('');
      expect(card.interests).toEqual([]);
      expect(card.currentActivities).toEqual([]);
      expect(card.avatar).toBeUndefined();
    });

    it('empties the intent / style when they are not authorised', () => {
      const card = buildPublicCard(buildProfile(), NO_FIELDS_ALLOWED);
      expect(card.socialIntent).toEqual([]);
      expect(card.conversationStyle).toEqual([]);
      expect(card.nickname).toBe('Alice');
    });

    it('does not mutate the source profile', () => {
      const profile = buildProfile({ avatar: 'data:image/png;base64,AAAA' });
      const before = JSON.stringify(profile);
      buildPublicCard(profile, ALL_FIELDS_ALLOWED);
      expect(JSON.stringify(profile)).toBe(before);
    });

    it('falls back to the profile own boundaries when none are passed', () => {
      const profile = buildProfile({
        boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES, allowBio: false, allowInterests: false },
      });
      const card = buildPublicCard(profile);
      expect(card.bio).toBe('');
      expect(card.interests).toEqual([]);
    });
  });

  describe('filterProfileForOutbound — the post-consent disclosure', () => {
    it('keeps every authorised field', () => {
      const profile = buildProfile({ avatar: 'data:image/png;base64,AAAA' });
      const out = filterProfileForOutbound(profile, ALL_FIELDS_ALLOWED);
      expect(out.nickname).toBe('Alice');
      expect(out.bio).toBe('ALICE-BIO');
      expect(out.interests).toEqual(['typescript', 'reading']);
      expect(out.currentActivities).toEqual(['side project']);
      expect(out.socialIntent).toEqual(['similar_interests']);
      expect(out.conversationStyle).toEqual(['casual']);
      expect(out.avatar).toBe('data:image/png;base64,AAAA');
    });

    it('empties every unauthorised field', () => {
      const profile = buildProfile({ avatar: 'data:image/png;base64,AAAA' });
      const out = filterProfileForOutbound(profile, NO_FIELDS_ALLOWED);
      expect(out.bio).toBe('');
      expect(out.interests).toEqual([]);
      expect(out.currentActivities).toEqual([]);
      expect(out.socialIntent).toEqual([]);
      expect(out.conversationStyle).toEqual([]);
      // The avatar key is omitted entirely — an unauthorised field must
      // not appear in the serialised result at all.
      expect('avatar' in out).toBe(false);
    });

    it('gates each field independently', () => {
      const b: SocialBoundaries = {
        ...DEFAULT_SOCIAL_BOUNDARIES,
        allowBio: true,
        allowInterests: false,
        allowCurrentActivity: false,
        allowAvatar: false,
        allowSocialIntent: true,
        allowConversationStyle: false,
      };
      const out = filterProfileForOutbound(buildProfile(), b);
      expect(out.bio).toBe('ALICE-BIO');
      expect(out.interests).toEqual([]);
      expect(out.currentActivities).toEqual([]);
      expect(out.socialIntent).toEqual(['similar_interests']);
      expect(out.conversationStyle).toEqual([]);
    });

    it('carries the resolved boundaries on the outbound copy', () => {
      const out = filterProfileForOutbound(buildProfile(), { allowBio: true });
      expect(out.boundaries).toEqual(resolveBoundaries({ allowBio: true }));
    });

    it('does not mutate the source profile', () => {
      const profile = buildProfile();
      const before = JSON.stringify(profile);
      filterProfileForOutbound(profile, NO_FIELDS_ALLOWED);
      expect(JSON.stringify(profile)).toBe(before);
    });

    it('the outbound copy is a deep-enough copy that mutating it cannot reach the source', () => {
      const profile = buildProfile();
      const out = filterProfileForOutbound(profile, ALL_FIELDS_ALLOWED);
      out.interests.push('mutated');
      expect(profile.interests).toEqual(['typescript', 'reading']);
    });
  });

  describe('redactedFields', () => {
    it('lists the fields that would be stripped', () => {
      const profile = buildProfile({ avatar: 'data:image/png;base64,AAAA' });
      const redacted = redactedFields(profile, NO_FIELDS_ALLOWED);
      expect(redacted.sort()).toEqual(
        [
          'avatar',
          'bio',
          'conversationStyle',
          'currentActivities',
          'interests',
          'socialIntent',
        ].sort(),
      );
    });

    it('lists nothing when everything is authorised', () => {
      const profile = buildProfile({ avatar: 'data:image/png;base64,AAAA' });
      expect(redactedFields(profile, ALL_FIELDS_ALLOWED)).toEqual([]);
    });

    it('does not list an empty field that was withheld', () => {
      // An empty field carries no information, so redacting it is not
      // a leak — and reporting it would be noise.
      const profile = buildProfile({ bio: '   ' });
      expect(redactedFields(profile, NO_FIELDS_ALLOWED)).not.toContain('bio');
    });
  });

  describe('assertProfileWithinBoundaries — the pre-send check', () => {
    it('passes for a filtered profile', () => {
      const profile = buildProfile({ avatar: 'data:image/png;base64,AAAA' });
      const out = filterProfileForOutbound(profile, ALL_FIELDS_ALLOWED);
      expect(() => assertProfileWithinBoundaries(out, ALL_FIELDS_ALLOWED)).not.toThrow();
    });

    it('throws when an unauthorised field still carries data', () => {
      const profile = buildProfile({ avatar: 'data:image/png;base64,AAAA' });
      expect(() => assertProfileWithinBoundaries(profile, NO_FIELDS_ALLOWED)).toThrow(
        ProfilePrivacyError,
      );
    });

    it('names the offending fields and the label', () => {
      const profile = buildProfile();
      try {
        assertProfileWithinBoundaries(profile, NO_FIELDS_ALLOWED, 'match_request.selfProfile');
        throw new Error('expected the assertion to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ProfilePrivacyError);
        const e = err as ProfilePrivacyError;
        expect(e.label).toBe('match_request.selfProfile');
        expect(e.fields).toContain('bio');
        expect(e.fields).toContain('interests');
        expect(e.message).toContain('match_request.selfProfile');
      }
    });

    it('a filtered profile always passes — the filter and the assertion agree', () => {
      const profile = buildProfile({ avatar: 'data:image/png;base64,AAAA' });
      for (const b of [ALL_FIELDS_ALLOWED, NO_FIELDS_ALLOWED]) {
        const out = filterProfileForOutbound(profile, b);
        expect(() => assertProfileWithinBoundaries(out, b)).not.toThrow();
      }
    });
  });
});
