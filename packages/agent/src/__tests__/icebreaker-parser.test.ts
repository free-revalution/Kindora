import { describe, it, expect } from 'vitest';
import {
  parseIcebreakerTopics,
  coerceIcebreakerTopics,
  MAX_ICEBREAKER_TOPICS,
} from '../output-parser';

describe('@kindora/agent — parseIcebreakerTopics', () => {
  it('parses a well-formed JSON object with exactly 3 topics', () => {
    const raw = JSON.stringify({
      topics: [
        'I noticed we both love TypeScript — what side stuff are you hacking on?',
        'You mentioned reading — any book you’ve been pushing on people lately?',
        'Saturday morning hike sounds fun — where do you usually go?',
      ],
    });
    const out = parseIcebreakerTopics(raw);
    expect(out.degraded).toBe(false);
    expect(out.note).toBeNull();
    expect(out.topics).toHaveLength(3);
    expect(out.topics[0]).toMatch(/TypeScript/);
  });

  it('parses a JSON object with fewer topics (thin profile)', () => {
    const raw = JSON.stringify({
      topics: ['Just say hi and see what happens.'],
    });
    const out = parseIcebreakerTopics(raw);
    expect(out.degraded).toBe(false);
    expect(out.topics).toEqual(['Just say hi and see what happens.']);
  });

  it('caps to MAX_ICEBREAKER_TOPICS when the model returns more', () => {
    const raw = JSON.stringify({
      topics: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    const out = parseIcebreakerTopics(raw);
    expect(out.topics).toHaveLength(MAX_ICEBREAKER_TOPICS);
    expect(out.topics).toEqual(['a', 'b', 'c']);
  });

  it('returns degraded=true and empty list on invalid JSON', () => {
    const out = parseIcebreakerTopics('this is not json at all');
    expect(out.degraded).toBe(true);
    expect(out.topics).toEqual([]);
    expect(out.note).toMatch(/json-parse-failed/);
  });

  it('returns degraded=true on non-object JSON', () => {
    const out = parseIcebreakerTopics(JSON.stringify([1, 2, 3]));
    expect(out.degraded).toBe(true);
    expect(out.topics).toEqual([]);
  });

  it('drops non-string list items and empties', () => {
    const raw = JSON.stringify({
      topics: ['keep me', 42, '', '   ', null, 'also keep'],
    });
    const out = parseIcebreakerTopics(raw);
    expect(out.topics).toEqual(['keep me', 'also keep']);
  });

  it('treats a missing `topics` field as degraded', () => {
    const raw = JSON.stringify({ suggestions: ['a', 'b'] });
    const out = parseIcebreakerTopics(raw);
    expect(out.degraded).toBe(true);
    expect(out.topics).toEqual([]);
    expect(out.note).toMatch(/topics-not-array/);
  });

  it('parses content wrapped in ```json fences', () => {
    const raw =
      '```json\n' +
      JSON.stringify({ topics: ['hi 1', 'hi 2', 'hi 3'] }) +
      '\n```';
    const out = parseIcebreakerTopics(raw);
    expect(out.degraded).toBe(false);
    expect(out.topics).toEqual(['hi 1', 'hi 2', 'hi 3']);
  });
});

describe('@kindora/agent — coerceIcebreakerTopics', () => {
  it('returns [] when value is null or not array', () => {
    expect(coerceIcebreakerTopics(null)).toEqual([]);
    expect(coerceIcebreakerTopics(undefined)).toEqual([]);
    expect(coerceIcebreakerTopics('hi')).toEqual([]);
    expect(coerceIcebreakerTopics({ topics: ['a'] })).toEqual([]);
  });

  it('trims items and caps each item length', () => {
    const long = 'x'.repeat(2000);
    const out = coerceIcebreakerTopics([`   ${long}   `]);
    expect(out).toHaveLength(1);
    expect(out[0]?.length).toBeLessThanOrEqual(200);
  });
});