import { describe, it, expect } from 'vitest';
import type { MatchAnalysis, SocialProfile } from '@kindora/protocol';
import { parseMatchAnalysis, extractJsonObject, applyBoundaryOverride } from '../output-parser';

function makeProfile(allowAgent: boolean): SocialProfile {
  return {
    nickname: 'p',
    bio: 'b',
    interests: [],
    currentActivities: [],
    socialIntent: [],
    conversationStyle: [],
    boundaries: {
      allowAgentConversation: allowAgent,
      allowContactExchange: false,
      allowOfflineMeeting: false,
      allowProjectDetails: false,
      allowCurrentActivity: true,
    },
  };
}

const SAMPLE: MatchAnalysis = {
  compatibilitySignal: 'moderate',
  commonGround: ['typescript'],
  recommendedTopics: ['static typing'],
  potentialFriction: [],
  explanation: 'Reasonable overlap.',
};

describe('@kindora/agent — extractJsonObject', () => {
  it('returns the same string when input is pure JSON', () => {
    const json = '{"a":1}';
    expect(extractJsonObject(json)).toBe(json);
  });

  it('strips ```json fences', () => {
    const out = extractJsonObject('```json\n{"a":1}\n```');
    expect(out).toBe('{"a":1}');
  });

  it('strips plain ``` fences', () => {
    const out = extractJsonObject('```\n{"a":1}\n```');
    expect(out).toBe('{"a":1}');
  });

  it('pulls the first {...} span out of surrounding prose', () => {
    const out = extractJsonObject('Here you go:\n{"a":1}\nThanks!');
    expect(out).toBe('{"a":1}');
  });

  it('returns the trimmed text when no JSON object is found', () => {
    const out = extractJsonObject('not json at all');
    expect(out).toBe('not json at all');
  });
});

describe('@kindora/agent — parseMatchAnalysis', () => {
  it('parses a well-formed JSON object', () => {
    const result = parseMatchAnalysis(
      JSON.stringify({
        compatibilitySignal: 'strong',
        commonGround: ['typescript', 'hiking'],
        recommendedTopics: ['oss libs you maintain'],
        potentialFriction: ['different timezones'],
        explanation: 'Solid overlap.',
      }),
    );
    expect(result.degraded).toBe(false);
    expect(result.note).toBeNull();
    expect(result.analysis.compatibilitySignal).toBe('strong');
    expect(result.analysis.commonGround).toEqual(['typescript', 'hiking']);
    expect(result.analysis.recommendedTopics).toEqual(['oss libs you maintain']);
    expect(result.analysis.potentialFriction).toEqual(['different timezones']);
    expect(result.analysis.explanation).toBe('Solid overlap.');
  });

  it('falls back to signal "none" on invalid signal value', () => {
    const result = parseMatchAnalysis(
      JSON.stringify({
        compatibilitySignal: 'amazing',
        commonGround: [],
        recommendedTopics: [],
        potentialFriction: [],
        explanation: '',
      }),
    );
    expect(result.degraded).toBe(true);
    expect(result.note).toMatch(/compatibilitySignal/);
    expect(result.analysis.compatibilitySignal).toBe('none');
  });

  it('returns a "none" analysis on JSON parse failure', () => {
    const result = parseMatchAnalysis('definitely not json');
    expect(result.degraded).toBe(true);
    expect(result.analysis.compatibilitySignal).toBe('none');
    expect(result.analysis.explanation).toMatch(/could not be parsed/i);
  });

  it('returns a "none" analysis on non-object JSON', () => {
    const result = parseMatchAnalysis(JSON.stringify([1, 2, 3]));
    expect(result.degraded).toBe(true);
    expect(result.analysis.compatibilitySignal).toBe('none');
  });

  it('coerces non-string list items and drops empties', () => {
    const result = parseMatchAnalysis(
      JSON.stringify({
        compatibilitySignal: 'moderate',
        commonGround: ['ok', 42, '', '   ', null, 'also ok'],
        recommendedTopics: [],
        potentialFriction: [],
        explanation: '',
      }),
    );
    expect(result.analysis.commonGround).toEqual(['ok', 'also ok']);
  });

  it('caps list length and item length defensively', () => {
    const result = parseMatchAnalysis(
      JSON.stringify({
        compatibilitySignal: 'moderate',
        commonGround: Array.from({ length: 50 }, (_, i) => `i${i}`),
        recommendedTopics: ['x'.repeat(1000)],
        potentialFriction: [],
        explanation: 'y'.repeat(2000),
      }),
    );
    expect(result.analysis.commonGround.length).toBeLessThanOrEqual(8);
    expect((result.analysis.recommendedTopics[0] ?? '').length).toBeLessThanOrEqual(200);
    expect(result.analysis.explanation.length).toBeLessThanOrEqual(600);
  });

  it('strips commonGround and recommendedTopics when signal is none', () => {
    const result = parseMatchAnalysis(
      JSON.stringify({
        compatibilitySignal: 'none',
        commonGround: ['typescript'],
        recommendedTopics: ['oss libs'],
        potentialFriction: [],
        explanation: 'No match.',
      }),
    );
    expect(result.degraded).toBe(true);
    expect(result.analysis.commonGround).toEqual([]);
    expect(result.analysis.recommendedTopics).toEqual([]);
  });

  it('parses content wrapped in ```json fences', () => {
    const result = parseMatchAnalysis(
      '```json\n' +
        JSON.stringify({
          compatibilitySignal: 'weak',
          commonGround: ['coffee'],
          recommendedTopics: ['best roasters'],
          potentialFriction: [],
          explanation: 'A little overlap.',
        }) +
        '\n```',
    );
    expect(result.analysis.compatibilitySignal).toBe('weak');
    expect(result.analysis.commonGround).toEqual(['coffee']);
  });
});

describe('@kindora/agent — applyBoundaryOverride', () => {
  it('passes through when both sides allow agent conversation', () => {
    const out = applyBoundaryOverride(SAMPLE, makeProfile(true), makeProfile(true));
    expect(out).toBe(SAMPLE);
  });

  it('forces signal to none when neither side allows agent conversation', () => {
    const out = applyBoundaryOverride(SAMPLE, makeProfile(false), makeProfile(false));
    expect(out.compatibilitySignal).toBe('none');
    expect(out.commonGround).toEqual([]);
    expect(out.recommendedTopics).toEqual([]);
    expect(out.potentialFriction.length).toBeGreaterThan(0);
  });

  it('is a no-op when signal was already none', () => {
    const noneAnalysis: MatchAnalysis = {
      compatibilitySignal: 'none',
      commonGround: [],
      recommendedTopics: [],
      potentialFriction: [],
      explanation: '',
    };
    const out = applyBoundaryOverride(noneAnalysis, makeProfile(false), makeProfile(false));
    expect(out).toBe(noneAnalysis);
  });
});
