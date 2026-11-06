/**
 * Phase C / C3 — the connection lifecycle, as the UI has to see it.
 *
 * The pairing FSM (`PairingSession`) answers a *protocol* question:
 * "has the handshake finished?". This module answers the different
 * question C3 § 8 asks: "what is the **connection** doing right now?"
 * — 连接中 / 已连接 / 断开 / 重连中 / 失败.
 *
 * The two are deliberately not the same thing, and conflating them is
 * what C3 § 1 warns about:
 *
 *   - `connected` here means the session reached `connected` — the
 *     identity check AND the key agreement are both done. A TCP link
 *     that is up but has not authenticated yet is still `connecting`.
 *   - `disconnected` means the link dropped. It is a **recoverable**
 *     state: the user can ask for a reconnect.
 *   - `failed` means the last attempt (the first one or a reconnect)
 *     did not work. It stays failed until the user tries again.
 *
 * The machine is transport-agnostic on purpose: the desktop LAN
 * service owns one instance per pairing flow and drives it from the
 * session's state changes. Nothing here knows about TCP, UDP, or
 * Tauri.
 */

/**
 * Phase C / C3 — the six states a connection can be in.
 *
 *   - `idle`         — nothing is running.
 *   - `connecting`   — a connection attempt is in flight (bind, dial,
 *                      or the handshake).
 *   - `connected`    — the peer is connected **and** authenticated.
 *   - `disconnected` — the link dropped. A reconnect is possible.
 *   - `reconnecting` — a reconnect attempt is in flight.
 *   - `failed`       — the last attempt did not work.
 */
export type ConnectionState =
  'idle' | 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed';

/** Phase C / C3 — notified whenever the connection state changes. */
export type ConnectionStateHandler = (state: ConnectionState) => void;

/**
 * Phase C / C3 — a tiny, dependency-free state holder.
 *
 * Two rules, and both of them matter:
 *
 *   1. **A transition to the current state is a no-op.** Subscribers
 *      are therefore only notified on a real change, so a view can
 *      treat every notification as "something happened" and does not
 *      have to diff the value itself.
 *   2. **One throwing subscriber must not silence the others.** The
 *      dispatch is wrapped per handler, exactly like the transport's
 *      own message / close dispatch.
 */
export class ConnectionStateMachine {
  private state: ConnectionState = 'idle';
  private readonly handlers = new Set<ConnectionStateHandler>();

  /** The current state. */
  current(): ConnectionState {
    return this.state;
  }

  /**
   * Move to `next`. Returns `true` when the state actually changed.
   *
   * The return value is what lets a caller distinguish "I asked for a
   * state that was already current" from "I caused a transition" —
   * useful in tests and when a caller wants to avoid redundant work.
   */
  set(next: ConnectionState): boolean {
    if (this.state === next) return false;
    this.state = next;
    // Snapshot the set: a handler may subscribe or unsubscribe while
    // we are dispatching.
    for (const handler of Array.from(this.handlers)) {
      try {
        handler(next);
      } catch (err) {
        console.warn('[connection-state] a state handler threw:', err);
      }
    }
    return true;
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   *
   * The handler is **not** called with the current state on subscribe
   * — a late subscriber reads `current()` if it wants the initial
   * value. This keeps the "notification == change" rule intact.
   */
  subscribe(handler: ConnectionStateHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
