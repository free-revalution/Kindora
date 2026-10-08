import { describe, it, expect } from 'vitest';
import { LLM_PACKAGE_VERSION } from '../index';

describe('@kindora/llm', () => {
  it('exposes a version constant', () => {
    expect(LLM_PACKAGE_VERSION).toBe('0.1.0');
  });
});
