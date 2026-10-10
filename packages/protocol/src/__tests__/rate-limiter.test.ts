/**
 * Tests for @kindora/protocol/rate-limiter — Phase 11 / § 50.
 *
 * Uses an injected `now()` so we can deterministically advance the
 * wall-clock without relying on real time or fake timers.
 */
import { describe, it, expect } from 'vitest';
import { RateLimiter, rateLimiter } from '../rate-limiter';

/** Helper — builds a clock we can advance by hand. */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('@kindora/protocol — RateLimiter', () => {
  it('starts full so the first burst is allowed', () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 5, refillPerSecond: 5, now: clock.now });
    expect(rl.tokensAvailable()).toBe(5);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
  });

  it('rejects once the bucket is empty', () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 2, refillPerSecond: 2, now: clock.now });
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
    expect(rl.tryConsume()).toBe(false);
  });

  it('refills lazily based on elapsed wall-clock time', () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now });
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
    clock.advance(500);
    // Only half a token has refilled; still can't consume 1 full token.
    expect(rl.tryConsume()).toBe(false);
    clock.advance(500);
    expect(rl.tryConsume()).toBe(true);
  });

  it('caps tokens at capacity even after a long idle', () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 3, refillPerSecond: 10, now: clock.now });
    clock.advance(10_000); // would refill to 100 tokens
    expect(rl.tokensAvailable()).toBe(3);
  });

  it('tryConsume(n) consumes multiple tokens atomically', () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 5, refillPerSecond: 5, now: clock.now });
    expect(rl.tryConsume(3)).toBe(true);
    expect(rl.tokensAvailable()).toBe(2);
    expect(rl.tryConsume(3)).toBe(false);
    expect(rl.tokensAvailable()).toBe(2); // rejected consume does not draw
  });

  it('tryConsume(0) is a no-op success', () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now });
    expect(rl.tryConsume(0)).toBe(true);
    expect(rl.tokensAvailable()).toBe(1);
  });

  it('tryConsume with a negative amount throws', () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now });
    expect(() => rl.tryConsume(-1)).toThrow(/negative/);
  });

  it('rejects capacity <= 0', () => {
    const clock = makeClock();
    expect(() => new RateLimiter({ capacity: 0, refillPerSecond: 1, now: clock.now })).toThrow(
      /capacity/,
    );
    expect(() => new RateLimiter({ capacity: -1, refillPerSecond: 1, now: clock.now })).toThrow(
      /capacity/,
    );
  });

  it('rejects refillPerSecond <= 0', () => {
    const clock = makeClock();
    expect(() => new RateLimiter({ capacity: 1, refillPerSecond: 0, now: clock.now })).toThrow(
      /refill/,
    );
  });

  it('snapshot returns capacity / refillPerSecond / current tokens', () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 4, refillPerSecond: 2, now: clock.now });
    rl.tryConsume(1);
    const snap = rl.snapshot();
    expect(snap.capacity).toBe(4);
    expect(snap.refillPerSecond).toBe(2);
    expect(snap.tokens).toBe(3);
  });

  it('reset returns the bucket to full', () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 4, refillPerSecond: 4, now: clock.now });
    rl.tryConsume();
    rl.tryConsume();
    expect(rl.tokensAvailable()).toBe(2);
    rl.reset();
    expect(rl.tokensAvailable()).toBe(4);
  });

  it('rateLimiter() convenience constructor matches the N-per-second contract', () => {
    const clock = makeClock();
    const rl = rateLimiter(2, { now: clock.now });
    expect(rl.tokensAvailable()).toBe(2);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
  });

  it('does not advance when clock goes backwards', () => {
    const clock = makeClock();
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 100, now: clock.now });
    rl.tryConsume();
    // Manually tick the clock backwards — refill() should bail.
    clock.advance(-10_000);
    expect(rl.tokensAvailable()).toBe(0);
  });
});