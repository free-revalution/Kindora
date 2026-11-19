import { describe, it, expect } from 'vitest';
import {
  INTEREST_CATEGORY_ORDER,
  INTEREST_TAXONOMY,
  canonicalInterestSet,
  displayLabelsForSharedInterests,
  normaliseInterestToken,
  interestsInCategory,
} from '../interest-taxonomy';

describe('@kindora/agent — interest taxonomy', () => {
  it('maps known aliases to a stable canonical id', () => {
    expect(normaliseInterestToken('AI')).toBe('ai');
    expect(normaliseInterestToken('人工智能')).toBe('ai');
    expect(normaliseInterestToken('machine learning')).toBe('ai');
    expect(normaliseInterestToken('TypeScript')).toBe('programming');
    expect(normaliseInterestToken('开源')).toBe('open_source');
  });

  it('leaves unknown free-text interests as lower-cased tokens', () => {
    expect(normaliseInterestToken('  Pottery ')).toBe('pottery');
  });

  it('collapses alias variants into one set entry', () => {
    const set = canonicalInterestSet(['AI', '人工智能', 'ml', 'hiking']);
    expect([...set].sort()).toEqual(['ai', 'hiking']);
  });

  it('covers every category listed in INTEREST_CATEGORY_ORDER', () => {
    for (const cat of INTEREST_CATEGORY_ORDER) {
      expect(interestsInCategory(cat).length).toBeGreaterThan(0);
    }
  });

  it('keeps taxonomy ids unique', () => {
    const ids = INTEREST_TAXONOMY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prefers the caller wording when labelling shared interests', () => {
    expect(displayLabelsForSharedInterests(['人工智能', '徒步'], ['ai', 'hiking'])).toEqual([
      '人工智能',
      '徒步',
    ]);
  });
});
