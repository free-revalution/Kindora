/**
 * Token-bucket rate limiter — Phase 11 / § 50 (Error Handling — "Rate Limit").
 *
 * Generic primitive used by:
 *   - PairingSession.send / onMessage (wire traffic shaping)
 *   - LLM call gates (per-session or global)
 *
 * The bucket holds at most `capacity` tokens. `tryConsume(n)` removes
 * `n` tokens and returns `true` if it succeeded, `false` if the bucket
 * didn't have enough. Tokens refill continuously at `refillPerSecond`
 * tokens/sec, up to `capacity`. The bucket starts full so the first
 * burst isn't artificially delayed.
 *
 * This implementation is intentionally simple — it does not use
 * timers; the refill is computed lazily on every `tryConsume` /
 * `tokensAvailable` call from `lastRefillTimestampMs`. That keeps the
 * limiter pure (no background tasks, no Jest fake-timer headaches)
 * while still producing accurate, monotonically-advancing behaviour.
 *
 * See 开发手册.md § 50, § 11, Phase 11.
 */

export interface RateLimiterOptions {
  /** Maximum tokens the bucket can hold. */
  readonly capacity: number;
  /** Tokens added per second of wall-clock time. */
  readonly refillPerSecond: number;
  /** Override the clock — defaults to `Date.now`. Tests inject a fake. */
  readonly now?: () => number;
}

export interface RateLimiterSnapshot {
  /** Tokens currently in the bucket, after the lazy refill. */
  readonly tokens: number;
  /** The capacity (max) — handy for diagnostics. */
  readonly capacity: number;
  /** Refill rate — handy for diagnostics. */
  readonly refillPerSecond: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(opts: RateLimiterOptions) {
    if (opts.capacity <= 0) throw new Error('RateLimiter: capacity must be > 0');
    if (opts.refillPerSecond <= 0) {
      throw new Error('RateLimiter: refillPerSecond must be > 0');
    }
    this.capacity = opts.capacity;
    this.refillPerSecond = opts.refillPerSecond;
    this.now = opts.now ?? (() => Date.now());
    this.tokens = opts.capacity;
    this.lastRefillMs = this.now();
  }

  /**
   * Try to consume `n` tokens (default 1). Returns true on success,
   * false if the bucket has fewer tokens. Never throws — a rate-limited
   * call is a normal outcome, not an error.
   */
  tryConsume(n: number = 1): boolean {
    if (n < 0) throw new Error('RateLimiter: cannot consume a negative amount');
    if (n === 0) return true;
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** Tokens currently in the bucket (after the lazy refill). */
  tokensAvailable(): number {
    this.refill();
    return this.tokens;
  }

  /** Diagnostic snapshot. */
  snapshot(): RateLimiterSnapshot {
    this.refill();
    return Object.freeze({
      tokens: this.tokens,
      capacity: this.capacity,
      refillPerSecond: this.refillPerSecond,
    });
  }

  /**
   * Force the bucket back to full. Used by tests; production code
   * should let the limiter drain naturally.
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillMs = this.now();
  }

  /** Refill based on elapsed wall-clock time. Caps at `capacity`. */
  private refill(): void {
    const nowMs = this.now();
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    const refilled = (elapsedMs / 1000) * this.refillPerSecond;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefillMs = nowMs;
  }
}

/**
 * Convenience constructor for the common case: "no more than N
 * events per second". Equivalent to `new RateLimiter({ capacity: N,
 * refillPerSecond: N })`.
 */
export function rateLimiter(eventsPerSecond: number, opts: Omit<RateLimiterOptions, 'capacity' | 'refillPerSecond'> = {}): RateLimiter {
  return new RateLimiter({
    capacity: eventsPerSecond,
    refillPerSecond: eventsPerSecond,
    ...opts,
  });
}