import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, PROTOCOL_NAME } from '@kindora/protocol';
import { AGENT_RUNTIME_VERSION } from '@kindora/agent';

describe('apps/desktop — Phase 0 smoke test', () => {
  it('loads protocol constants from workspace package', () => {
    expect(PROTOCOL_NAME).toBe('KSA');
    expect(PROTOCOL_VERSION).toBe('0.1');
  });

  it('loads agent package version from workspace package', () => {
    expect(AGENT_RUNTIME_VERSION).toBe('0.1.0');
  });
});
