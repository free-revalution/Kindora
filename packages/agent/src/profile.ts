/**
 * Profile validation. Used both client-side (form errors) and as a
 * last-line defence before persisting a profile.
 *
 * See 开发手册.md § 7.
 */

import type { SocialProfile } from '@kindora/protocol';

export interface ProfileValidationError {
  readonly field: keyof SocialProfile | 'general';
  readonly message: string;
}

export interface ProfileLimits {
  readonly maxNickname: number;
  readonly maxBio: number;
  readonly maxInterests: number;
  readonly maxActivities: number;
  readonly maxIntent: number;
  readonly maxStyle: number;
}

export const DEFAULT_PROFILE_LIMITS: ProfileLimits = Object.freeze({
  maxNickname: 32,
  maxBio: 280,
  maxInterests: 12,
  maxActivities: 12,
  maxIntent: 7,
  maxStyle: 5,
});

export function validateProfile(
  profile: SocialProfile,
  limits: ProfileLimits = DEFAULT_PROFILE_LIMITS,
): readonly ProfileValidationError[] {
  const errors: ProfileValidationError[] = [];

  const nickname = profile.nickname?.trim() ?? '';
  if (nickname.length === 0) {
    errors.push({ field: 'nickname', message: 'Nickname is required.' });
  } else if (nickname.length > limits.maxNickname) {
    errors.push({
      field: 'nickname',
      message: `Nickname must be ${limits.maxNickname} characters or fewer.`,
    });
  }

  const bio = profile.bio?.trim() ?? '';
  if (bio.length === 0) {
    errors.push({ field: 'bio', message: 'Bio is required.' });
  } else if (bio.length > limits.maxBio) {
    errors.push({
      field: 'bio',
      message: `Bio must be ${limits.maxBio} characters or fewer.`,
    });
  }

  if (profile.interests.length === 0) {
    errors.push({ field: 'interests', message: 'Add at least one interest.' });
  } else if (profile.interests.length > limits.maxInterests) {
    errors.push({
      field: 'interests',
      message: `At most ${limits.maxInterests} interests.`,
    });
  }

  if (profile.currentActivities.length > limits.maxActivities) {
    errors.push({
      field: 'currentActivities',
      message: `At most ${limits.maxActivities} current activities.`,
    });
  }

  if (profile.socialIntent.length === 0) {
    errors.push({
      field: 'socialIntent',
      message: 'Select at least one social intent.',
    });
  } else if (profile.socialIntent.length > limits.maxIntent) {
    errors.push({
      field: 'socialIntent',
      message: `At most ${limits.maxIntent} social intents.`,
    });
  }

  if (profile.conversationStyle.length === 0) {
    errors.push({
      field: 'conversationStyle',
      message: 'Select at least one conversation style.',
    });
  } else if (profile.conversationStyle.length > limits.maxStyle) {
    errors.push({
      field: 'conversationStyle',
      message: `At most ${limits.maxStyle} conversation styles.`,
    });
  }

  return Object.freeze(errors);
}

export function isProfileValid(
  profile: SocialProfile,
  limits: ProfileLimits = DEFAULT_PROFILE_LIMITS,
): boolean {
  return validateProfile(profile, limits).length === 0;
}
