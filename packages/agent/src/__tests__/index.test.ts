import { describe, it, expect } from 'vitest';
import {
  AGENT_RUNTIME_VERSION,
  DEFAULT_MAX_AGENT_MESSAGES,
  createAgentConfig,
} from '../index';

describe('@kindora/agent', () => {
  it('exposes a version constant', () => {
    expect(AGENT_RUNTIME_VERSION).toBe('0.1.0');
  });

  it('caps agent-to-agent messages at 6 by default (开发手册.md § 52)', () => {
    expect(DEFAULT_MAX_AGENT_MESSAGES).toBe(6);
  });

  it('builds a frozen, defaulted config', () => {
    const cfg = createAgentConfig();
    expect(cfg.maxAgentMessages).toBe(6);
    expect(cfg.maxMatchTokens).toBe(2000);
    expect(cfg.maxIcebreakerTokens).toBe(500);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('accepts overrides', () => {
    const cfg = createAgentConfig({ maxAgentMessages: 4 });
    expect(cfg.maxAgentMessages).toBe(4);
    expect(cfg.maxMatchTokens).toBe(2000);
  });
});
