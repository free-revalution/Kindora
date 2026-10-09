/**
 * Anti-replay protection (§ 54).
 *
 *   "至少检查 messageId + timestamp。拒绝过期消息。"
 *
 * `ReplayGuard` is a stateful, in-memory deduper:
 *
 *   - `accept(envelope)` records a fresh envelope's messageId and
 *     returns ok. If the messageId is already known OR the timestamp
 *     is outside the allowed clock window, it rejects.
 *
 *   - The set is bounded (LRU-ish via a FIFO cap) so it cannot grow
 *     without bound over a long-lived connection.
 *
 *   - Pure JS — no timers, no async, no I/O. The caller drives the
 *     clock by passing `nowMs` in `accept()`.
 *
 * See 开发手册.md § 54.
 */
import type { KsaMessage } from './envelope';

export interface ReplayGuardOptions {
  /**
   * Maximum age of an accepted message, in milliseconds.
   * Default: 5 minutes.
   */
  readonly maxAgeMs?: number;
  /**
   * Maximum clock skew tolerated for messages stamped in the future.
   * Default: 30 seconds.
   */
  readonly maxSkewMs?: number;
  /**
   * Cap on the number of messageIds remembered. When the cap is hit,
   * the oldest entries are evicted FIFO.
   * Default: 1024.
   */
  readonly capacity?: number;
}

export class ReplayRejected extends Error {
  constructor(
    public readonly reason: 'duplicate' | 'too-old' | 'too-future',
    public readonly messageId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReplayRejected';
  }
}

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SKEW_MS = 30 * 1000;
const DEFAULT_CAPACITY = 1024;

interface SeenEntry {
  readonly messageId: string;
  readonly timestampMs: number;
}

export class ReplayGuard {
  private readonly maxAgeMs: number;
  private readonly maxSkewMs: number;
  private readonly capacity: number;
  /** Newest at the end, oldest at the front — so we can shift() to evict. */
  private readonly seen: SeenEntry[] = [];
  private readonly seenIndex = new Set<string>();

  constructor(options: ReplayGuardOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (this.maxAgeMs <= 0) throw new Error('maxAgeMs must be positive');
    if (this.maxSkewMs < 0) throw new Error('maxSkewMs must be non-negative');
    if (this.capacity <= 0) throw new Error('capacity must be positive');
  }

  /** Number of unique messageIds currently remembered. */
  size(): number {
    return this.seen.length;
  }

  /**
   * Validate an envelope against the replay window and dedup set.
   * Throws `ReplayRejected` on failure; returns silently on success.
   */
  accept(envelope: KsaMessage, nowMs: number = Date.now()): void {
    const ts = Date.parse(envelope.timestamp);
    if (Number.isNaN(ts)) {
      // Should be caught earlier by validation.ts, but defend anyway.
      throw new ReplayRejected(
        'too-old',
        envelope.messageId,
        `Cannot parse timestamp: ${envelope.timestamp}`,
      );
    }

    if (this.seenIndex.has(envelope.messageId)) {
      throw new ReplayRejected(
        'duplicate',
        envelope.messageId,
        `Duplicate messageId: ${envelope.messageId}`,
      );
    }

    const age = nowMs - ts;
    if (age > this.maxAgeMs) {
      throw new ReplayRejected(
        'too-old',
        envelope.messageId,
        `Message timestamp is older than maxAgeMs (${age}ms > ${this.maxAgeMs}ms).`,
      );
    }
    if (-age > this.maxSkewMs) {
      throw new ReplayRejected(
        'too-future',
        envelope.messageId,
        `Message timestamp is in the future beyond maxSkewMs (${-age}ms > ${this.maxSkewMs}ms).`,
      );
    }

    this.seenIndex.add(envelope.messageId);
    this.seen.push({ messageId: envelope.messageId, timestampMs: ts });
    while (this.seen.length > this.capacity) {
      const evicted = this.seen.shift();
      if (evicted) this.seenIndex.delete(evicted.messageId);
    }
  }

  /** Forget all remembered messageIds (e.g. on connection reset). */
  reset(): void {
    this.seen.length = 0;
    this.seenIndex.clear();
  }
}
