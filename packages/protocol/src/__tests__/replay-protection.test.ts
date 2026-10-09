import { describe, it, expect } from 'vitest';
import { ReplayGuard, ReplayRejected, createDisconnect } from '../index';

const AGENT_ID = '11111111-2222-4333-8444-555555555555';

describe('@kindora/protocol — ReplayGuard', () => {
  it('accepts a fresh envelope', () => {
    const g = new ReplayGuard();
    const e = createDisconnect(AGENT_ID);
    expect(() => g.accept(e)).not.toThrow();
    expect(g.size()).toBe(1);
  });

  it('rejects a duplicate messageId', () => {
    const g = new ReplayGuard();
    const e = createDisconnect(AGENT_ID);
    g.accept(e);
    expect(() => g.accept(e)).toThrow(ReplayRejected);
    try {
      g.accept(e);
    } catch (err) {
      expect((err as ReplayRejected).reason).toBe('duplicate');
    }
  });

  it('rejects a message older than maxAgeMs', () => {
    const g = new ReplayGuard({ maxAgeMs: 1000 });
    const old = createDisconnect(AGENT_ID, {}, { timestamp: new Date(0).toISOString() });
    expect(() => g.accept(old, Date.now())).toThrow(ReplayRejected);
    try {
      g.accept(old, Date.now());
    } catch (err) {
      expect((err as ReplayRejected).reason).toBe('too-old');
    }
  });

  it('rejects a message timestamped far in the future', () => {
    const g = new ReplayGuard({ maxSkewMs: 1000 });
    const future = createDisconnect(
      AGENT_ID,
      {},
      { timestamp: new Date(Date.now() + 60_000).toISOString() },
    );
    expect(() => g.accept(future, Date.now())).toThrow(ReplayRejected);
    try {
      g.accept(future, Date.now());
    } catch (err) {
      expect((err as ReplayRejected).reason).toBe('too-future');
    }
  });

  it('evicts the oldest entries when capacity is exceeded', () => {
    const g = new ReplayGuard({ capacity: 3 });
    const envelopes = Array.from({ length: 5 }, () => createDisconnect(AGENT_ID));
    for (const e of envelopes) g.accept(e);
    expect(g.size()).toBe(3);
    // The first two are evicted, so they should be re-acceptable.
    expect(() => g.accept(envelopes[0]!)).not.toThrow();
    expect(() => g.accept(envelopes[1]!)).not.toThrow();
  });

  it('reset clears all state', () => {
    const g = new ReplayGuard();
    const e = createDisconnect(AGENT_ID);
    g.accept(e);
    g.reset();
    expect(g.size()).toBe(0);
    expect(() => g.accept(e)).not.toThrow();
  });

  it('throws on invalid constructor options', () => {
    expect(() => new ReplayGuard({ maxAgeMs: 0 })).toThrow();
    expect(() => new ReplayGuard({ maxSkewMs: -1 })).toThrow();
    expect(() => new ReplayGuard({ capacity: 0 })).toThrow();
  });

  it('rejects malformed timestamp defensively', () => {
    const g = new ReplayGuard();
    const e = createDisconnect(AGENT_ID, {}, { timestamp: 'bogus' });
    expect(() => g.accept(e)).toThrow(ReplayRejected);
  });
});
