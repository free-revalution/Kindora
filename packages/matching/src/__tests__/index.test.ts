import { describe, it, expect } from 'vitest';
import { MATCHING_PACKAGE_VERSION } from '../index';

describe('@kindora/matching', () => {
  it('exposes a version constant', () => {
    expect(MATCHING_PACKAGE_VERSION).toBe('0.1.0');
  });
});
