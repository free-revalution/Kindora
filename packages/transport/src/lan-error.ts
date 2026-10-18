/**
 * LanError — typed representation of the Rust `LanError` enum.
 *
 * The Rust side serialises each error variant as its `Display` string
 * (see `apps/desktop/src-tauri/src/lan.rs`'s `impl Serialize for
 * LanError`). When the Tauri command rejects, the JS side receives an
 * `Error` whose `.message` is that string.
 *
 * Phase 16.4: this class lets the TypeScript layer
 *   (a) classify the rejection into a discriminated kind, and
 *   (b) distinguish `peer-closed` from `not-connected` / generic
 *       `io` errors so we can fire an `onClose` event on the
 *       transport without false-positives on local teardown.
 *
 * The mapping is by `Display` string prefix, matching the Rust
 * `#[error("…")]` attributes exactly. Adding a new variant on the
 * Rust side without updating both sides will land in `unknown`.
 */
export type LanErrorKind =
  /** Wrapped `std::io::Error` — `Display = "io error: …"`. */
  | 'io'
  /** Wrapped `serde_json::Error` — `Display = "json error: …"`. */
  | 'json'
  /** `LanError::Invalid(String)` — `Display = "invalid: …"`. */
  | 'invalid'
  /** `LanError::NotConnected` — `Display = "not connected"`. */
  | 'not-connected'
  /** `LanError::AlreadyRunning(String)` — `Display = "already running in mode …"`. */
  | 'already-running'
  /** `LanError::PeerClosed` — `Display = "peer closed"`. Phase 16.3. */
  | 'peer-closed'
  /** Anything else — could be a Tauri runtime error, a transport
   *  failure that did not come from our `LanError`, or a future Rust
   *  variant. */
  | 'unknown';

export class LanError extends Error {
  public readonly kind: LanErrorKind;

  constructor(kind: LanErrorKind, message: string) {
    super(message);
    this.name = 'LanError';
    this.kind = kind;
  }

  /**
   * True iff this error is `LanError::PeerClosed` — i.e. the remote
   * end closed the TCP link (EOF, RST, or any non-shutdown read
   * error). Phase 16.4 callers use this to fire an `onClose` event on
   * the transport; the message arrives via `lan_host_poll` /
   * `lan_join_poll` immediately after the read loop has set the
   * `peer_closed: Arc<AtomicBool>` flag.
   */
  isPeerClosed(): boolean {
    return this.kind === 'peer-closed';
  }

  /**
   * Classify a Tauri IPC rejection (or any thrown value) into a
   * `LanError`. Returns a fresh `LanError` instance; if `err` is
   * already a `LanError`, it is returned unchanged.
   *
   * The classification is purely on `.message` string shape; it does
   * not consult the runtime's error kind. This is intentional — the
   * Tauri 2 IPC serialises our `LanError` to a plain string and the
   * JS-side sees only that string.
   *
   * The lookup is lenient about the source shape: we accept
   * `Error` instances, plain objects with a `message` field, and
   * any other value (which falls through to `unknown`). The
   * Tauri 2 invoke rejection is an `Error`, but defensively reading
   * `.message` from a plain object costs nothing and covers any
   * future Tauri-version change.
   */
  static from(err: unknown): LanError {
    if (err instanceof LanError) return err;
    let message: string;
    if (err instanceof Error) {
      message = err.message;
    } else if (
      typeof err === 'object' &&
      err !== null &&
      'message' in err &&
      typeof (err as { message: unknown }).message === 'string'
    ) {
      message = (err as { message: string }).message;
    } else {
      message = String(err);
    }
    if (message === 'peer closed') return new LanError('peer-closed', message);
    if (message === 'not connected') return new LanError('not-connected', message);
    if (message.startsWith('io error: ')) return new LanError('io', message);
    if (message.startsWith('json error: ')) return new LanError('json', message);
    if (message.startsWith('invalid: ')) return new LanError('invalid', message);
    if (message.startsWith('already running in mode ')) {
      return new LanError('already-running', message);
    }
    return new LanError('unknown', message);
  }
}
