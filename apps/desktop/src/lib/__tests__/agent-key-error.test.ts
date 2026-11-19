import { describe, it, expect } from 'vitest';
import { AgentKeyError } from '../tauri-agent-keychain';
import { classifyAgentKeyError, describeAgentKeyError } from '../agent-service';

describe('classifyAgentKeyError', () => {
  it('marks locked / denied / unavailable as recoverable', () => {
    expect(classifyAgentKeyError(new AgentKeyError('keychain_locked', 'locked')).recoverable).toBe(
      true,
    );
    expect(classifyAgentKeyError(new AgentKeyError('keychain_denied', 'denied')).recoverable).toBe(
      true,
    );
    expect(
      classifyAgentKeyError(new AgentKeyError('keychain_unavailable', 'gone')).recoverable,
    ).toBe(true);
  });

  it('marks missing / corrupt keys as not recoverable by unlock', () => {
    expect(classifyAgentKeyError(new AgentKeyError('not_found', 'missing')).recoverable).toBe(
      false,
    );
    expect(classifyAgentKeyError(new AgentKeyError('corrupt', 'bad')).recoverable).toBe(false);
  });

  it('preserves the structured kind for the error screen', () => {
    const failure = classifyAgentKeyError(new AgentKeyError('keychain_locked', 'os locked'));
    expect(failure.kind).toBe('keychain_locked');
    expect(failure.message).toMatch(/locked/i);
  });

  it('falls back for plain Errors', () => {
    const failure = classifyAgentKeyError(new Error('boom'));
    expect(failure.kind).toBe('unknown');
    expect(failure.message).toBe('boom');
    expect(failure.recoverable).toBe(false);
  });

  it('keeps describeAgentKeyError as the message field', () => {
    const err = new AgentKeyError('keychain_denied', 'no');
    expect(describeAgentKeyError(err)).toBe(classifyAgentKeyError(err).message);
  });
});
