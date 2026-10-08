import { describe, it, expect } from 'vitest';
import { DEFAULT_PROFILE_LIMITS, isProfileValid, validateProfile } from '../profile';
import {
  DEFAULT_SOCIAL_BOUNDARIES,
  SOCIAL_INTENTS,
  CONVERSATION_STYLES,
  type SocialProfile,
} from '@kindora/protocol';

function makeProfile(overrides: Partial<SocialProfile> = {}): SocialProfile {
  return {
    nickname: 'Jason',
    bio: 'Software engineer interested in AI agents.',
    interests: ['AI', 'Open Source'],
    currentActivities: [],
    socialIntent: ['similar_interests'],
    conversationStyle: ['technical'],
    boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
    ...overrides,
  };
}

describe('@kindora/agent — validateProfile', () => {
  it('accepts a complete, valid profile', () => {
    const errors = validateProfile(makeProfile());
    expect(errors).toEqual([]);
    expect(isProfileValid(makeProfile())).toBe(true);
  });

  it('rejects empty nickname', () => {
    const errors = validateProfile(makeProfile({ nickname: '   ' }));
    expect(errors.some((e) => e.field === 'nickname')).toBe(true);
  });

  it('rejects empty bio', () => {
    const errors = validateProfile(makeProfile({ bio: '' }));
    expect(errors.some((e) => e.field === 'bio')).toBe(true);
  });

  it('rejects empty interests', () => {
    const errors = validateProfile(makeProfile({ interests: [] }));
    expect(errors.some((e) => e.field === 'interests')).toBe(true);
  });

  it('rejects empty socialIntent', () => {
    const errors = validateProfile(makeProfile({ socialIntent: [] }));
    expect(errors.some((e) => e.field === 'socialIntent')).toBe(true);
  });

  it('rejects empty conversationStyle', () => {
    const errors = validateProfile(makeProfile({ conversationStyle: [] }));
    expect(errors.some((e) => e.field === 'conversationStyle')).toBe(true);
  });

  it('flags too many interests', () => {
    const errors = validateProfile(
      makeProfile({ interests: Array(DEFAULT_PROFILE_LIMITS.maxInterests + 1).fill('x') }),
    );
    expect(errors.some((e) => e.field === 'interests')).toBe(true);
  });

  it('freezes the limits object', () => {
    expect(Object.isFrozen(DEFAULT_PROFILE_LIMITS)).toBe(true);
  });

  it('only includes declared social intents and styles in the catalogue', () => {
    // sanity check on the protocol catalogue
    expect(SOCIAL_INTENTS.length).toBe(7);
    expect(CONVERSATION_STYLES.length).toBe(5);
  });
});
