/**
 * WireRateLimiter — Phase 11 / § 50.
 *
 * Token-bucket gate around `PairingSession.send()` (outbound) and the
 * inbound message stream (per sender). When the bucket is empty, the
 * gate drops / rejects:
 *
 *   - `send()` → throws `WireRateLimitExceeded`. Callers (orchestrators)
 *     already wrap sends in try/catch so a burst doesn't crash the UI.
 *   - inbound → silently drops. The peer keeps trying; we keep the
 *     session alive. A real flood would still be observable via the
 *     `dropped` counter.
 *
 * The limiter starts full so the first legitimate exchanges aren't
 * artificially delayed.
 *
 * Defaults: 10 outbound envelopes/sec (burst), 30 inbound per
 * sender/sec. These match a normal chat cadence (1 message every 2-3
 * seconds during a fast back-and-forth, plus the bootstrap envelope
 * burst at connection time).
 *
 * See 开发手册.md § 50, Phase 11.
 */
import { RateLimiter, type RateLimiterOptions } from '@kindora/protocol';

export class WireRateLimitExceeded extends Error {
  constructor(
    public readonly action: 'send',
    public readonly tokensRequested: number,
    public readonly tokensAvailable: number,
  ) {
    super(
      `WireRateLimiter: tried to ${action} ${tokensRequested} tokens but only ${tokensAvailable} were available.`,
    );
    this.name = 'WireRateLimitExceeded';
  }
}

export interface WireRateLimiterOptions {
  /** Outbound (send) configuration. Default: capacity 10, refill 10/sec. */
  readonly outbound?: Omit<RateLimiterOptions, 'capacity' | 'refillPerSecond'> & {
    readonly capacity?: number;
    readonly refillPerSecond?: number;
  };
  /** Inbound configuration. Default: capacity 30, refill 30/sec. */
  readonly inbound?: Omit<RateLimiterOptions, 'capacity' | 'refillPerSecond'> & {
    readonly capacity?: number;
    readonly refillPerSecond?: number;
  };
}

export interface WireRateLimiterStats {
  readonly outboundAllowed: number;
  readonly outboundRejected: number;
  readonly inboundAllowed: number;
  readonly inboundDropped: number;
}

export class WireRateLimiter {
  private readonly outbound: RateLimiter;
  private readonly inbound: RateLimiter;
  private outboundAllowed = 0;
  private outboundRejected = 0;
  private inboundAllowed = 0;
  private inboundDropped = 0;

  constructor(opts: WireRateLimiterOptions = {}) {
    this.outbound = new RateLimiter({
      capacity: opts.outbound?.capacity ?? 10,
      refillPerSecond: opts.outbound?.refillPerSecond ?? 10,
      now: opts.outbound?.now,
    });
    this.inbound = new RateLimiter({
      capacity: opts.inbound?.capacity ?? 30,
      refillPerSecond: opts.inbound?.refillPerSecond ?? 30,
      now: opts.inbound?.now,
    });
  }

  /**
   * Reserve one outbound token. Throws `WireRateLimitExceeded` when
   * the bucket is empty.
   */
  checkOutbound(): void {
    if (this.outbound.tryConsume(1)) {
      this.outboundAllowed += 1;
      return;
    }
    this.outboundRejected += 1;
    throw new WireRateLimitExceeded('send', 1, this.outbound.tokensAvailable());
  }

  /**
   * Decide whether to accept an inbound envelope. Returns true if the
   * message should be forwarded, false if it should be silently dropped.
   */
  checkInbound(): boolean {
    if (this.inbound.tryConsume(1)) {
      this.inboundAllowed += 1;
      return true;
    }
    this.inboundDropped += 1;
    return false;
  }

  /** Diagnostic stats. */
  stats(): WireRateLimiterStats {
    return Object.freeze({
      outboundAllowed: this.outboundAllowed,
      outboundRejected: this.outboundRejected,
      inboundAllowed: this.inboundAllowed,
      inboundDropped: this.inboundDropped,
    });
  }

  /** Reset both buckets to full — used by tests. */
  reset(): void {
    this.outbound.reset();
    this.inbound.reset();
    this.outboundAllowed = 0;
    this.outboundRejected = 0;
    this.inboundAllowed = 0;
    this.inboundDropped = 0;
  }
}