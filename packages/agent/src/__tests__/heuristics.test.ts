import { describe, it, expect } from 'vitest';
import type { SocialProfile } from '@kindora/protocol';
import { computeHeuristics, renderHeuristics } from '../heuristics';

function makeProfile(overrides: Partial<SocialProfile> = {}): SocialProfile {
  return {
    nickname: 'tester',
    bio: 'a person',
    interests: [],
    currentActivities: [],
    socialIntent: [],
    conversationStyle: [],
    boundaries: {
      allowAgentConversation: true,
      allowContactExchange: false,
      allowOfflineMeeting: false,
      allowProjectDetails: false,
      allowCurrentActivity: true,
    },
    ...overrides,
  };
}

describe('@kindora/agent — computeHeuristics', () => {
  it('returns zero overlap for disjoint interests', () => {
    const h = computeHeuristics(
      makeProfile({ interests: ['typescript', 'hiking'] }),
      makeProfile({ interests: ['painting', 'cooking'] }),
    );
    expect(h.interestScore).toBe(0);
    expect(h.sharedInterests).toEqual([]);
  });

  it('returns 1.0 for identical interest sets', () => {
    const h = computeHeuristics(
      makeProfile({ interests: ['typescript', 'hiking'] }),
      makeProfile({ interests: ['hiking', 'typescript'] }),
    );
    expect(h.interestScore).toBe(1);
    expect([...h.sharedInterests].sort()).toEqual(['hiking', 'typescript']);
  });

  it('is case-insensitive and trims tokens', () => {
    const h = computeHeuristics(
      makeProfile({ interests: [' TypeScript ', 'HIKING'] }),
      makeProfile({ interests: ['typescript', 'hiking'] }),
    );
    expect([...h.sharedInterests].sort()).toEqual(['hiking', 'typescript']);
  });

  it('flags a blocking issue when both sides disable agent conversation', () => {
    const h = computeHeuristics(
      makeProfile({ boundaries: { ...makeProfile().boundaries, allowAgentConversation: false } }),
      makeProfile({ boundaries: { ...makeProfile().boundaries, allowAgentConversation: false } }),
    );
    expect(h.blockingIssues.length).toBeGreaterThan(0);
    expect(h.blockingIssues[0]).toMatch(/agent conversation/i);
  });

  it('does not block when at least one side allows agent conversation', () => {
    const h = computeHeuristics(
      makeProfile({ boundaries: { ...makeProfile().boundaries, allowAgentConversation: true } }),
      makeProfile({ boundaries: { ...makeProfile().boundaries, allowAgentConversation: false } }),
    );
    expect(h.blockingIssues).toEqual([]);
  });

  it('penalises gaming_partner vs long_term_friendship pair', () => {
    const h = computeHeuristics(
      makeProfile({ socialIntent: ['gaming_partner'] }),
      makeProfile({ socialIntent: ['long_term_friendship'] }),
    );
    expect(h.intentScore).toBe(0.2);
  });

  it('rewards identical intents with score 1.0', () => {
    const h = computeHeuristics(
      makeProfile({ socialIntent: ['learning_partner'] }),
      makeProfile({ socialIntent: ['learning_partner'] }),
    );
    expect(h.intentScore).toBe(1);
  });

  it('produces a composite score in [0, 1]', () => {
    const h = computeHeuristics(
      makeProfile({
        interests: ['typescript', 'hiking'],
        currentActivities: ['reading'],
        socialIntent: ['learning_partner'],
      }),
      makeProfile({
        interests: ['typescript'],
        currentActivities: ['reading'],
        socialIntent: ['learning_partner'],
      }),
    );
    expect(h.compositeScore).toBeGreaterThan(0);
    expect(h.compositeScore).toBeLessThanOrEqual(1);
  });

  it('sharedActivities lists the overlap verbatim (lower-cased)', () => {
    const h = computeHeuristics(
      makeProfile({ currentActivities: ['Hiking', 'Reading'] }),
      makeProfile({ currentActivities: ['hiking', 'Painting'] }),
    );
    expect(h.sharedActivities).toEqual(['hiking']);
  });
});

describe('@kindora/agent — renderHeuristics', () => {
  it('renders a deterministic multi-line block', () => {
    const h = computeHeuristics(
      makeProfile({ interests: ['typescript'], socialIntent: ['learning_partner'] }),
      makeProfile({ interests: ['typescript'], socialIntent: ['learning_partner'] }),
    );
    const out = renderHeuristics(h);
    expect(out).toMatch(/interest overlap/);
    expect(out).toMatch(/intent alignment/);
    expect(out).toMatch(/composite score/);
    expect(out).toContain('typescript');
  });

  it('includes blocking issues when present', () => {
    const h = computeHeuristics(
      makeProfile({ boundaries: { ...makeProfile().boundaries, allowAgentConversation: false } }),
      makeProfile({ boundaries: { ...makeProfile().boundaries, allowAgentConversation: false } }),
    );
    const out = renderHeuristics(h);
    expect(out).toMatch(/blocking issues/);
    expect(out).toMatch(/agent conversation/i);
  });
});
