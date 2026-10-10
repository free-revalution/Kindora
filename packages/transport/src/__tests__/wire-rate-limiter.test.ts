/**
 * Tests for @kindora/transport/wire-rate-limiter — Phase 11 / § 50.
 *
 * Uses an injected clock so we can deterministically advance time
 * without relying on real-time waits.
 */
import { describe, it, expect } from 'vitest';
import { WireRateLimiter, WireRateLimitExceeded } from '../wire-rate-limiter';

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('@kindora/transport — WireRateLimiter', () => {
  it('defaults to 10 outbound and 30 inbound capacity', () => {
    const clock = makeClock();
    const w = new WireRateLimiter({
      outbound: { now: clock.now },
      inbound: { now: clock.now },
    });
    // Drain both buckets.
    for (let i = 0; i < 10; i++) w.checkOutbound();
    for (let i = 0; i < 30; i++) expect(w.checkInbound()).toBe(true);
    expect(() => w.checkOutbound()).toThrow(WireRateLimitExceeded);
    expect(w.checkInbound()).toBe(false);
  });

  it('checkOutbound throws once the bucket is exhausted', () => {
    const clock = makeClock();
    const w = new WireRateLimiter({
      outbound: { capacity: 2, refillPerSecond: 2, now: clock.now },
      inbound: { capacity: 2, refillPerSecond: 2, now: clock.now },
    });
    w.checkOutbound();
    w.checkOutbound();
    expect(() => w.checkOutbound()).toThrow(WireRateLimitExceeded);
  });

  it('WireRateLimitExceeded carries action and token counts', () => {
    const clock = makeClock();
    const w = new WireRateLimiter({
      outbound: { capacity: 1, refillPerSecond: 1, now: clock.now },
      inbound: { capacity: 1, refillPerSecond: 1, now: clock.now },
    });
    w.checkOutbound();
    try {
      w.checkOutbound();
    } catch (e) {
      const err = e as WireRateLimitExceeded;
      expect(err.action).toBe('send');
      expect(err.tokensRequested).toBe(1);
      expect(err.tokensAvailable).toBe(0);
    }
  });

  it('checkInbound returns false when the bucket is empty (no throw)', () => {
    const clock = makeClock();
    const w = new WireRateLimiter({
      outbound: { capacity: 1, refillPerSecond: 1, now: clock.now },
      inbound: { capacity: 2, refillPerSecond: 2, now: clock.now },
    });
    expect(w.checkInbound()).toBe(true);
    expect(w.checkInbound()).toBe(true);
    expect(w.checkInbound()).toBe(false);
    expect(w.checkInbound()).toBe(false);
  });

  it('refills both buckets over time', () => {
    const clock = makeClock();
    const w = new WireRateLimiter({
      outbound: { capacity: 1, refillPerSecond: 1, now: clock.now },
      inbound: { capacity: 1, refillPerSecond: 1, now: clock.now },
    });
    w.checkOutbound();
    expect(() => w.checkOutbound()).toThrow(WireRateLimitExceeded);
    clock.advance(1_100);
    expect(() => w.checkOutbound()).not.toThrow();
  });

  it('records stats correctly', () => {
    const clock = makeClock();
    const w = new WireRateLimiter({
      outbound: { capacity: 1, refillPerSecond: 1, now: clock.now },
      inbound: { capacity: 2, refillPerSecond: 2, now: clock.now },
    });
    w.checkOutbound(); // allowed
    try {
      w.checkOutbound();
    } catch {
      /* expected */
    }
    w.checkInbound(); // allowed
    w.checkInbound(); // allowed
    w.checkInbound(); // dropped
    w.checkInbound(); // dropped
    const s = w.stats();
    expect(s.outboundAllowed).toBe(1);
    expect(s.outboundRejected).toBe(1);
    expect(s.inboundAllowed).toBe(2);
    expect(s.inboundDropped).toBe(2);
  });

  it('reset returns both buckets to full and zeroes counters', () => {
    const clock = makeClock();
    const w = new WireRateLimiter({
      outbound: { capacity: 1, refillPerSecond: 1, now: clock.now },
      inbound: { capacity: 1, refillPerSecond: 1, now: clock.now },
    });
    w.checkOutbound();
    w.checkInbound();
    w.reset();
    expect(() => w.checkOutbound()).not.toThrow();
    expect(w.checkInbound()).toBe(true);
    expect(w.stats()).toEqual({
      outboundAllowed: 1,
      outboundRejected: 0,
      inboundAllowed: 1,
      inboundDropped: 0,
    });
  });
});