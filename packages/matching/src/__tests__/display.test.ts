import { describe, it, expect } from 'vitest';
import type { MatchAnalysis } from '@kindora/protocol';
import {
  compatibilityLabel,
  formatExplanation,
  formatList,
  summariseAnalysis,
} from '../display';

function analysis(overrides: Partial<MatchAnalysis> = {}): MatchAnalysis {
  return {
    compatibilitySignal: 'moderate',
    commonGround: [],
    recommendedTopics: [],
    potentialFriction: [],
    explanation: '',
    ...overrides,
  };
}

describe('@kindora/matching — display', () => {
  it('compatibilityLabel maps all 4 signals', () => {
    expect(compatibilityLabel('strong')).toEqual({ label: 'Strong match', tone: 'positive' });
    expect(compatibilityLabel('moderate')).toEqual({ label: 'Moderate match', tone: 'neutral' });
    expect(compatibilityLabel('weak')).toEqual({ label: 'Weak match', tone: 'neutral' });
    expect(compatibilityLabel('none')).toEqual({ label: 'No match', tone: 'cautious' });
  });

  it('formatList joins with the middle-dot separator', () => {
    expect(formatList(['a', 'b', 'c'])).toBe('a · b · c');
    expect(formatList([], '—')).toBe('—');
    expect(formatList([])).toBe('—');
  });

  it('formatExplanation trims whitespace and caps with ellipsis', () => {
    expect(formatExplanation('   hello   world   ')).toBe('hello world');
    const long = 'x'.repeat(500);
    const out = formatExplanation(long, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('formatExplanation returns empty string for empty input (no fallback)', () => {
    expect(formatExplanation('')).toBe('');
    expect(formatExplanation('   ')).toBe('');
  });

  it('summariseAnalysis returns the 5 required fields in a stable shape', () => {
    const a: MatchAnalysis = analysis({
      compatibilitySignal: 'strong',
      commonGround: ['rust', 'climbing'],
      recommendedTopics: ['borrowing patterns'],
      potentialFriction: ['timezones'],
      explanation: 'overlap on systems programming',
    });
    const s = summariseAnalysis(a);
    expect(s.signalLabel).toBe('Strong match');
    expect(s.signalTone).toBe('positive');
    expect(s.commonGround).toEqual(['rust', 'climbing']);
    expect(s.recommendedTopics).toEqual(['borrowing patterns']);
    expect(s.potentialFriction).toEqual(['timezones']);
    expect(s.explanation).toBe('overlap on systems programming');
  });

  it('summariseAnalysis tolerates an empty analysis (all fields populated, no crash)', () => {
    const s = summariseAnalysis(analysis());
    expect(s.signalLabel).toBe('Moderate match');
    expect(s.signalTone).toBe('neutral');
    expect(s.commonGround).toEqual([]);
    expect(s.recommendedTopics).toEqual([]);
    expect(s.potentialFriction).toEqual([]);
    expect(s.explanation).toBe('');
  });
});
