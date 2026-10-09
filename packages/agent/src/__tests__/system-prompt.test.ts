import { describe, it, expect } from 'vitest';
import { MATCH_ANALYST_SYSTEM_PROMPT } from '../system-prompt';

describe('@kindora/agent — system-prompt', () => {
  it('contains the untrusted-input rule (§ 35)', () => {
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/untrusted/i);
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/never (reveal|follow)/i);
  });

  it('contains the no-tools boundary (§ 36)', () => {
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/no tools/i);
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/no filesystem/i);
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/no shell/i);
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/no browser/i);
  });

  it('specifies the JSON output shape', () => {
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/compatibilitySignal/);
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/commonGround/);
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/recommendedTopics/);
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/potentialFriction/);
    expect(MATCH_ANALYST_SYSTEM_PROMPT).toMatch(/explanation/);
  });

  it('never contains API keys or secrets', () => {
    expect(MATCH_ANALYST_SYSTEM_PROMPT).not.toMatch(/sk-[a-z]/i);
    expect(MATCH_ANALYST_SYSTEM_PROMPT).not.toMatch(/api[_-]?key/i);
  });

  it('is non-empty and bounded to a reasonable length', () => {
    expect(MATCH_ANALYST_SYSTEM_PROMPT.length).toBeGreaterThan(200);
    expect(MATCH_ANALYST_SYSTEM_PROMPT.length).toBeLessThan(5000);
  });
});
