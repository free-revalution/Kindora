// LAN transport module — UDP discovery + TCP message channel for
// two Kindora desktop clients on the same LAN.
//
// Wire protocol (V0.1):
//   - Discovery: UDP broadcast on 52419, payload JSON
//       { kind: "lan_discover", magic, code, protocol_version }   (joiner -> hosts)
//       { kind: "lan_announce", magic, code, agent_id, display_name, tcp_port, protocol_version }   (host -> joiner)
//   - TCP: length-prefixed JSON. 4 bytes big-endian length, then UTF-8 JSON body.
//
// The host binds a TCP listener and a UDP discovery responder.
// The joiner broadcasts a discover datagram, collects announces, then
// opens a TCP connection to the chosen peer.
//
// Cross-platform: tokio handles bind/connect on macOS / Linux / Windows.
//
// ---------------------------------------------------------------------------
// V0.1 link-handoff invariant
// ---------------------------------------------------------------------------
// The host's TCP listener runs in a spawned task. When a peer connects,
// the listener produces a TcpLink (writer + inbox + shutdown) and must
// hand it to HostSide. We use a `oneshot`-like direct setter on
// LanState — the listener task clones the Arc<Mutex<Inner>> and calls
// `set_host_link` after each accept. This avoids the broken pattern
// of a local accept_tx/accept_rx that drops the receiver on return.
// ---------------------------------------------------------------------------

use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
// `tokio::sync::Mutex` is imported below under the name `Mutex`, so the
// std mutex (used for the small, synchronous limit-reason slot) needs
// its own alias.
use std::sync::Mutex as StdMutex;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};

const DISCOVERY_PORT: u16 = 52419;
const DISCOVERY_MAGIC: &str = "kindora/discover/v1";
const ANNOUNCE_MAGIC: &str = "kindora/announce/v1";
const PROTOCOL_VERSION: &str = "0.1";

// ---------------------------------------------------------------------------
// Phase C / C1 — resource limits
// ---------------------------------------------------------------------------
// Every bound the LAN transport enforces lives in this one block, so
// the limits can be reviewed together instead of being scattered over
// the read loop, the accept loop and the poll paths.

/// Largest single frame we accept off the wire.
///
/// Was 16 MiB. A KSA envelope carries a profile, two public keys and
/// a chat message — comfortably under 64 KiB — so 1 MiB keeps an
/// order of magnitude of headroom while cutting the worst-case
/// allocation by 16×.
const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Largest number of messages that may sit in the inbox at once.
///
/// The inbox used to be an *unbounded* channel: a peer that flooded
/// us, or a JS layer that stopped polling, could grow the queue
/// without limit until the process died.
const MAX_QUEUED_MESSAGES: usize = 256;

/// Largest total size of the messages sitting in the inbox.
///
/// The count limit alone still allows 256 × 1 MiB = 256 MiB parked
/// in memory, so the bytes are bounded separately.
const MAX_QUEUED_BYTES: usize = 4 * 1024 * 1024;

/// How long the read loop waits for room in the inbox before it gives
/// up on the peer.
///
/// This is the backpressure window: while the inbox is full the read
/// loop stops reading, the TCP receive window closes, and the OS
/// throttles the sender. A peer that keeps the inbox full for longer
/// than this is dropped rather than allowed to pin memory forever.
const INBOX_BACKPRESSURE_TIMEOUT_MS: u64 = 5_000;

/// Messages per second allowed on a single connection.
const MAX_MESSAGES_PER_SECOND: u32 = 50;

/// Simultaneous TCP peers a single host serves.
///
/// V0.1 pairing is single-peer, so the effective value is 1. It is
/// written as a number rather than left implied by the accept loop's
/// structure so the invariant is explicit and testable — and so a
/// future multi-peer host has one place to change.
const MAX_CONNECTIONS: usize = 1;

#[derive(Debug, thiserror::Error)]
pub enum LanError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid: {0}")]
    Invalid(String),
    #[error("not connected")]
    NotConnected,
    #[error("already running in mode {0}")]
    AlreadyRunning(String),
    /// The TCP peer closed the link or otherwise disconnected
    /// mid-stream. Distinct from `NotConnected` (which means local
    /// never started or already fully tore down) so a single
    /// `PeerClosed` event represents exactly one remote-side drop.
    ///
    /// Phase 16.3 § 5.1: previously, peer-side closes (RST, half-close
    /// EOF, read errors) were silently swallowed by `tcp_read_loop` —
    /// `host_poll`/`join_poll` would just return an empty inbox, and
    /// `host_send`/`join_send` would not fail until the OS buffer
    /// was full. The `peer_closed` atomic on `TcpLink` now lets the
    /// polling and sending paths surface this error immediately
    /// without depending on the OS to notice first.
    #[error("peer closed")]
    PeerClosed,
    /// The peer exceeded one of the transport's resource limits —
    /// frame size, message rate, or inbox capacity.
    ///
    /// Phase C / C1: the link is dropped and the reason is surfaced to
    /// the UI, so a peer that floods us looks like "this peer was
    /// rejected for exceeding the limit" rather than an unexplained
    /// network failure.
    ///
    /// The TypeScript classifier keys off the `Display` prefix
    /// `peer exceeded limit: ` — see `LAN_ERROR_LIMIT_EXCEEDED_PREFIX`
    /// in `packages/transport/src/lan-error.ts`, which pins the same
    /// string. Both sides must change together.
    #[error("peer exceeded limit: {0}")]
    LimitExceeded(String),
}

impl serde::Serialize for LanError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum DiscoveryMessage {
    #[serde(rename = "lan_discover")]
    Discover {
        magic: String,
        code: String,
        protocol_version: String,
    },
    #[serde(rename = "lan_announce")]
    Announce {
        magic: String,
        code: String,
        agent_id: String,
        display_name: String,
        tcp_port: u16,
        protocol_version: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub ip: String,
    pub port: u16,
    pub agent_id: String,
    pub display_name: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostInfo {
    pub tcp_port: u16,
    pub agent_id: String,
    pub display_name: String,
    pub code: String,
}

/// A message parked in the inbox, together with the byte-budget
/// permit it holds.
///
/// Phase C / C1: the permit is released when the message is dropped —
/// i.e. when the poll path drains it — so the byte budget tracks what
/// is *actually queued* rather than what was ever received.
struct QueuedMessage {
    body: String,
    _budget: tokio::sync::OwnedSemaphorePermit,
}

/// TcpLink = the live TCP connection. Cloning `writer` is cheap (Arc);
/// the inbox is an mpsc receiver; shutdown_tx signals the read loop to
/// stop and close the underlying socket.
///
/// Phase 16.3 § 5.1: `peer_closed` is an `Arc<AtomicBool>` shared
/// between the `tcp_read_loop` task and the polling/sending paths.
/// The read loop sets it on EOF / non-shutdown read errors; the poll
/// and send paths read it to surface `Err(LanError::PeerClosed)` even
/// before the OS buffer has noticed the disconnect. Local shutdown
/// (the watch channel) deliberately does NOT set this flag — the
/// poll path's "Inbox Disconnected + peer_closed=false" branch
/// therefore means "clean local teardown", not "remote failure".
struct TcpLink {
    writer: Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>,
    /// Bounded inbox (Phase C / C1). Was `mpsc::UnboundedReceiver`.
    inbox: mpsc::Receiver<QueuedMessage>,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    peer_closed: Arc<AtomicBool>,
    /// Phase C / C2: why the read loop stopped, when the reason was
    /// more specific than "the peer went away". `None` means "the
    /// peer simply disconnected" (or the link is still live).
    ///
    /// The reason is written by the read loop *before* it returns, and
    /// the return is what flips `peer_closed` — so a poller that sees
    /// the closed flag is guaranteed to also see the reason. That
    /// ordering is what keeps the Rust, TypeScript and UI layers in
    /// agreement (C2 acceptance criterion).
    close_reason: Arc<StdMutex<Option<CloseReason>>>,
}

/// Phase C / C2: why a link ended abnormally.
///
/// `PeerClosed` on its own says "the link is over" but not *why*, and
/// C2 § 5 asks for an explicit reason at the frontend. These two
/// variants carry the specific cause:
///
///   * `LimitExceeded` — the peer broke a resource limit (frame
///     size, message rate, inbox backpressure).
///   * `Invalid` — the peer sent a frame we could not decode (e.g.
///     invalid UTF-8).
#[derive(Debug, Clone)]
enum CloseReason {
    LimitExceeded(String),
    Invalid(String),
}

impl CloseReason {
    fn to_error(&self) -> LanError {
        match self {
            CloseReason::LimitExceeded(detail) => LanError::LimitExceeded(detail.clone()),
            CloseReason::Invalid(detail) => LanError::Invalid(detail.clone()),
        }
    }
}

/// Record why a link ended abnormally.
///
/// A plain function (not a method with an `await` inside) so the
/// `std::sync::MutexGuard` can never be held across an await point —
/// `clippy::await_holding_lock` stays quiet by construction.
fn record_close_reason(slot: &Arc<StdMutex<Option<CloseReason>>>, reason: CloseReason) {
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(reason);
    }
}

/// Read the recorded close reason, if any.
fn read_close_reason(slot: &Arc<StdMutex<Option<CloseReason>>>) -> Option<CloseReason> {
    match slot.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => None,
    }
}

/// The error to surface once the peer is gone.
///
/// The specific reason when the read loop stopped because the peer did
/// something wrong (broke a limit, sent garbage), and `PeerClosed`
/// otherwise. Both mean "the link is over"; only the first tells the
/// UI *why*, which is what C2 § 5 ("前端能够收到明确的断开原因")
/// asks for.
fn closed_error(slot: &Arc<StdMutex<Option<CloseReason>>>) -> LanError {
    match read_close_reason(slot) {
        Some(reason) => reason.to_error(),
        None => LanError::PeerClosed,
    }
}

impl TcpLink {
    /// Read the next decoded JSON body, returning `None` on EOF or shutdown.
    #[allow(dead_code)]
    async fn next(&mut self) -> Option<String> {
        self.inbox.recv().await.map(|m| m.body)
    }

    fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    /// True once the read loop has flagged that the TCP peer closed
    /// the stream. Polling and sending paths consult this to surface
    /// `Err(LanError::PeerClosed)` even before the OS buffer is full.
    /// Idempotent — once set, every subsequent poll/send returns
    /// `PeerClosed` until the link is fully torn down.
    fn was_peer_closed(&self) -> bool {
        self.peer_closed.load(std::sync::atomic::Ordering::Acquire)
    }

    /// Mark the link as closed by a remote-side disconnect. Multiple
    /// call sites use this (read loop on EOF/Err, send path on
    /// `BrokenPipe`/`ConnectionReset`); the underlying atomic store
    /// collapses them to a single observable state, satisfying the
    /// "same connection reports drop only once" requirement.
    #[allow(dead_code)]
    fn mark_closed(&self) {
        self.peer_closed
            .store(true, std::sync::atomic::Ordering::Release);
    }

    /// Phase C / C2: the error to surface once the peer is gone.
    ///
    /// Delegates to the free `closed_error` function so the mapping
    /// can be unit-tested without a live socket.
    fn closed_error(&self) -> LanError {
        closed_error(&self.close_reason)
    }
}

/// Phase C / C3: every field of `HostSide` has the same default the
/// manual `Default` impl used to spell out, so the derive replaces it
/// without changing a single value.
#[derive(Default)]
struct HostSide {
    /// Identifies this particular host start.
    ///
    /// `host_start` reserves the slot before it awaits any bind, so a
    /// concurrent `host_stop` can take the reservation away again. The
    /// epoch lets the start detect that and unwind instead of
    /// resurrecting a host the user just stopped.
    epoch: u64,
    tcp_port: u16,
    agent_id: String,
    display_name: String,
    code: String,
    link: Option<TcpLink>,
    udp_shutdown: Option<tokio::sync::watch::Sender<bool>>,
    /// Resolves once the UDP responder has exited and released its
    /// socket.
    ///
    /// The discovery port is fixed, so the next `host_start` cannot
    /// bind it until the previous responder has actually dropped the
    /// socket. `host_stop` waits on this so a stop→start sequence
    /// cannot lose the bind to a half-finished teardown.
    udp_done: Option<tokio::sync::oneshot::Receiver<()>>,
    /// Signalled when the accept loop has handed off (or failed) so
    /// host_stop can wait for it to exit instead of racing the lock.
    accept_task_done: Option<tokio::sync::oneshot::Sender<()>>,
}

#[allow(dead_code)]
#[derive(Default)]
struct JoinSide {
    peer_ip: String,
    peer_port: u16,
    link: Option<TcpLink>,
}

#[allow(dead_code)]
fn _ensure_joinside_used() {
    let _ = JoinSide::default();
}

#[derive(Default, Clone)]
pub struct LanState {
    inner: Arc<Mutex<Inner>>,
    /// Override the broadcast address used by `join_discover`. Defaults
    /// to `255.255.255.255`. Tests set this to the loopback broadcast
    /// (`127.0.0.1`) on platforms where the loopback interface does
    /// not have a real broadcast address (e.g. macOS).
    broadcast_addr: Arc<std::sync::Mutex<Option<String>>>,
    /// Override the host's UDP bind address. Defaults to `0.0.0.0`
    /// (all interfaces). Tests bind to `127.0.0.1` to avoid macOS
    /// routing ambiguity.
    udp_bind_addr: Arc<std::sync::Mutex<Option<String>>>,

    /// Override the UDP discovery port. Defaults to 52419. Tests
    /// set this so multiple LanState instances can coexist on the
    /// same machine without binding conflicts.
    udp_port: Arc<std::sync::Mutex<Option<u16>>>,
}

#[derive(Default)]
struct Inner {
    host: Option<HostSide>,
    join: Option<JoinSide>,
    /// Monotonic counter identifying each host start. The reservation
    /// carries the epoch it was created with so a start can tell
    /// whether its slot is still the one it reserved.
    host_epoch: u64,
}

impl LanState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Override the broadcast address used by `join_discover`. Mostly
    /// for tests; production code uses the default `255.255.255.255`.
    /// Synchronous because `broadcast_addr` is a `std::sync::Mutex`,
    /// not a tokio one — this is a one-shot configuration knob.
    pub fn set_broadcast_addr(&self, addr: String) {
        let mut g = self
            .broadcast_addr
            .lock()
            .expect("broadcast_addr mutex poisoned");
        *g = Some(addr);
    }

    fn current_broadcast_addr(&self) -> String {
        let g = self
            .broadcast_addr
            .lock()
            .expect("broadcast_addr mutex poisoned");
        g.clone().unwrap_or_else(|| "255.255.255.255".to_string())
    }

    /// Override the host's UDP bind address. Mostly for tests.
    /// Synchronous because `udp_bind_addr` is a `std::sync::Mutex`.
    pub fn set_udp_bind_addr(&self, addr: String) {
        let mut g = self
            .udp_bind_addr
            .lock()
            .expect("udp_bind_addr mutex poisoned");
        *g = Some(addr);
    }

    fn current_udp_bind_addr(&self) -> String {
        let g = self
            .udp_bind_addr
            .lock()
            .expect("udp_bind_addr mutex poisoned");
        g.clone().unwrap_or_else(|| "0.0.0.0".to_string())
    }

    /// Override the UDP discovery port. Mostly for tests.
    pub fn set_udp_port(&self, port: u16) {
        let mut g = self.udp_port.lock().expect("udp_port mutex poisoned");
        *g = Some(port);
    }

    fn current_udp_port(&self) -> u16 {
        let g = self.udp_port.lock().expect("udp_port mutex poisoned");
        g.unwrap_or(DISCOVERY_PORT)
    }

    /// Internal handle for the spawned accept loop to push the live link
    /// into the host side. Acquires the lock briefly; never held across
    /// an `await` (so it cannot deadlock with `host_poll` / `host_send`).
    /// Private to the module because `TcpLink` is private.
    async fn set_host_link(&self, link: TcpLink) {
        let mut g = self.inner.lock().await;
        if let Some(h) = g.host.as_mut() {
            // Phase C / C3: replacing the link must release the old
            // one. `shutdown()` tells the old read loop to stop, and
            // dropping the old `TcpLink` closes its writer half — so a
            // reconnect does not leave the previous peer holding a
            // socket and a read loop forever.
            if let Some(old) = h.link.replace(link) {
                old.shutdown();
            }
        }
    }

    /// Tell the host accept loop to stop. Called from `host_stop`.
    pub async fn signal_host_shutdown(&self) {
        let g = self.inner.lock().await;
        if let Some(h) = g.host.as_ref() {
            if let Some(tx) = h.accept_task_done.as_ref() {
                // The accept task awaits this — we just need to drop the
                // receiver side of the oneshot to abort the task. Since
                // we don't have a `cancel` channel here, the simplest
                // approach: the accept task has a `tokio::select!` on the
                // oneshot and a `tokio::time::sleep` of nothing — it
                // wakes on socket activity. We pass a separate shutdown
                // channel via host_stop; for now this is a no-op.
                let _ = tx;
            }
        }
    }

    // ---------- host ----------

    pub async fn host_start(
        &self,
        code: String,
        agent_id: String,
        display_name: String,
    ) -> Result<HostInfo, LanError> {
        // ---- 1. Reserve the host slot ----
        //
        // The binds below are awaited, so the state lock cannot be held
        // across them. A bare "is a host already running?" check is
        // therefore NOT atomic: two concurrent `host_start` calls both
        // passed it, both spawned a UDP responder on the same fixed
        // discovery port (the loser lost the bind with EADDRINUSE) and
        // the loser was only rejected afterwards with `AlreadyRunning`.
        // Reserving the slot first makes check-and-set atomic, so the
        // loser returns before it touches the network at all.
        //
        // The shutdown channels are created up front and stored in the
        // reservation, so a `host_stop` that lands while we are still
        // binding can still stop the responder we are about to spawn.
        let (udp_sh_tx, udp_sh_rx) = tokio::sync::watch::channel(false);
        let (udp_done_tx, udp_done_rx) = tokio::sync::oneshot::channel::<()>();
        let epoch = {
            let mut g = self.inner.lock().await;
            if g.host.is_some() {
                return Err(LanError::AlreadyRunning("host".into()));
            }
            g.host_epoch = g.host_epoch.wrapping_add(1);
            let epoch = g.host_epoch;
            g.host = Some(HostSide {
                epoch,
                tcp_port: 0,
                agent_id: agent_id.clone(),
                display_name: display_name.clone(),
                code: code.clone(),
                link: None,
                udp_shutdown: Some(udp_sh_tx.clone()),
                udp_done: Some(udp_done_rx),
                accept_task_done: None,
            });
            epoch
        };

        // ---- 2. Bind the TCP listener ----
        let listener = match TcpListener::bind(("0.0.0.0", 0)).await {
            Ok(l) => l,
            Err(e) => {
                self.release_host_reservation(epoch).await;
                return Err(LanError::Io(e));
            }
        };
        let tcp_port = match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(e) => {
                self.release_host_reservation(epoch).await;
                return Err(LanError::Io(e));
            }
        };

        // ---- 3. Bind the UDP discovery socket ----
        //
        // The bind happens HERE, not inside the spawned responder task.
        // It has to be observable: with the bind inside the task, a
        // port clash (a previous host that had not finished tearing
        // down) produced a host that *looked* fine while its responder
        // had already died in the background — the pairing code was on
        // screen and no peer could ever discover it.
        let bind_u = self.current_udp_bind_addr();
        let port_u = self.current_udp_port();
        let udp_bind: SocketAddr = match format!("{bind_u}:{port_u}").parse() {
            Ok(a) => a,
            Err(e) => {
                self.release_host_reservation(epoch).await;
                return Err(LanError::Invalid(format!("{e}")));
            }
        };
        let udp_socket = match tokio::net::UdpSocket::bind(udp_bind).await {
            Ok(s) => s,
            Err(e) => {
                self.release_host_reservation(epoch).await;
                return Err(LanError::Io(e));
            }
        };

        // ---- 4. Spawn the UDP responder ----
        let code_u = code.clone();
        let agent_u = agent_id.clone();
        let display_u = display_name.clone();
        tokio::spawn(async move {
            let res =
                udp_responder(udp_socket, code_u, agent_u, display_u, tcp_port, udp_sh_rx).await;
            if let Err(e) = res {
                log::warn!("[lan] udp responder exited: {e}");
            }
            // The discovery port is only free once this task drops the
            // socket. Tell `host_stop` that it has been released so a
            // following `host_start` can rebind it.
            let _ = udp_done_tx.send(());
        });

        // ---- 5. Spawn the accept loop ----
        //
        // Clones the Arc<Mutex<Inner>> so the spawned task can push the
        // link into HostSide without going through a local mpsc channel
        // (which was the V0.1 bug: accept_rx was dropped at end of
        // host_start, so the link was never received).
        let (accept_done_tx, accept_done_rx) = tokio::sync::oneshot::channel::<()>();
        let state_for_accept = self.clone();
        let code_a = code.clone();
        let accept_handle = tokio::spawn(async move {
            accept_loop(state_for_accept, listener, code_a, accept_done_rx).await;
        });
        // The accept_handle itself isn't stored — host_stop is the only
        // thing that needs to wait for the loop to exit, and that's
        // handled via the listener being dropped on host_stop.

        // ---- 6. Fill the reservation in ----
        //
        // If a concurrent `host_stop` already took the reservation, our
        // host is no longer wanted. Unwind instead of resurrecting a
        // host the user just stopped.
        {
            let mut g = self.inner.lock().await;
            let ours = g.host.as_ref().map(|h| h.epoch) == Some(epoch);
            if !ours {
                // Stop the responder and the accept loop we just
                // spawned — nobody else knows about them, and the
                // accept loop holds the TCP listener open.
                let _ = udp_sh_tx.send(true);
                let _ = accept_done_tx.send(());
                return Err(LanError::Invalid(
                    "host was stopped while it was starting".into(),
                ));
            }
            if let Some(h) = g.host.as_mut() {
                h.tcp_port = tcp_port;
                h.accept_task_done = Some(accept_done_tx);
            }
        }

        // Keep the JoinHandle alive in a fire-and-forget way — the
        // accept loop only returns when host_stop closes the listener
        // or fires `accept_done_rx`. (Phase C / C3: it no longer
        // returns after the first accept; the single-peer invariant is
        // enforced by the connection cap instead.)
        // The runtime will reap it on completion.
        drop(accept_handle);

        Ok(HostInfo {
            tcp_port,
            agent_id,
            display_name,
            code,
        })
    }

    /// Drop the host reservation, but only if it is still the one this
    /// start created.
    ///
    /// Used on the failure paths of `host_start`: if a concurrent
    /// `host_stop` already took the slot, releasing it here would
    /// delete somebody else's host.
    async fn release_host_reservation(&self, epoch: u64) {
        let mut g = self.inner.lock().await;
        if g.host.as_ref().map(|h| h.epoch) == Some(epoch) {
            g.host = None;
        }
    }

    pub async fn host_poll(&self) -> Result<Vec<String>, LanError> {
        let mut g = self.inner.lock().await;
        let Some(h) = g.host.as_mut() else {
            return Err(LanError::NotConnected);
        };
        let Some(link) = h.link.as_mut() else {
            return Ok(vec![]);
        };
        let mut out = Vec::new();
        // Drain whatever's already in the inbox without awaiting —
        // poll semantics must not block. If the read loop has more in
        // flight, the next poll cycle picks it up.
        //
        // Phase 16.3 § 5.1: in addition to draining the inbox, we
        // surface `Err(PeerClosed)` when the read loop has flagged a
        // remote-side drop. Without this, the JS layer would never
        // learn about a peer-side disconnect until the next send
        // happened to fill the OS buffer (or never at all on idle).
        loop {
            match link.inbox.try_recv() {
                Ok(m) => out.push(m.body),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    if link.was_peer_closed() {
                        return Err(link.closed_error());
                    }
                    // In production this branch is unreachable after
                    // `host_stop`, because `host_stop` removes the
                    // host side before any further `host_poll` runs.
                    // The guard is here to keep the contract clean.
                    break;
                }
            }
        }
        Ok(out)
    }

    pub async fn host_status(&self) -> Result<Option<HostInfo>, LanError> {
        let g = self.inner.lock().await;
        Ok(g.host.as_ref().map(|h| HostInfo {
            tcp_port: h.tcp_port,
            agent_id: h.agent_id.clone(),
            display_name: h.display_name.clone(),
            code: h.code.clone(),
        }))
    }

    pub async fn host_linked(&self) -> bool {
        let g = self.inner.lock().await;
        g.host.as_ref().and_then(|h| h.link.as_ref()).is_some()
    }

    pub async fn host_send(&self, msg: String) -> Result<(), LanError> {
        let g = self.inner.lock().await;
        let h = g.host.as_ref().ok_or(LanError::NotConnected)?;
        let link = h.link.as_ref().ok_or(LanError::NotConnected)?;
        // Phase 16.3 § 5.1: fast-fail when the read loop has
        // already observed the peer closing the link. Otherwise, the
        // OS may keep accepting bytes into a half-closed buffer and
        // silently swallow them.
        if link.was_peer_closed() {
            return Err(link.closed_error());
        }
        let mut w = link.writer.lock().await;
        if let Err(e) = write_envelope(&mut w, &msg).await {
            // A write error here typically means the OS already
            // knows the link is gone (BrokenPipe / Reset / Aborted).
            // Record the closed state so the next poll/send also
            // returns PeerClosed, and surface it now so the caller
            // doesn't have to interpret a generic Io error.
            if let LanError::Io(io) = &e {
                if matches!(
                    io.kind(),
                    std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionAborted
                ) {
                    link.mark_closed();
                    return Err(link.closed_error());
                }
            }
            return Err(e);
        }
        Ok(())
    }

    pub async fn host_stop(&self) -> Result<(), LanError> {
        // Take the host side out of the state. After this, all host_*
        // commands return NotConnected.
        let mut h = {
            let mut g = self.inner.lock().await;
            g.host.take()
        };
        if let Some(ref mut host) = h {
            // 1) Signal the UDP responder to stop, then WAIT for it to
            //    release its socket.
            //
            //    The discovery port is fixed, so the next `host_start`
            //    cannot bind it until the old responder has actually
            //    dropped the socket. Signalling without waiting let the
            //    next start race the teardown and lose the bind with
            //    EADDRINUSE — a host that looked started but could
            //    never be discovered by a peer.
            if let Some(u) = host.udp_shutdown.take() {
                let _ = u.send(true);
            }
            if let Some(rx) = host.udp_done.take() {
                // Bounded: the responder exits as soon as it observes
                // the shutdown flag. The timeout only guards against a
                // wedged task — it must never hang the UI.
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), rx).await;
            }
            // 2) Signal the read loop to stop, then drop the writer
            //    to close the TCP socket from our side.
            if let Some(l) = host.link.take() {
                l.shutdown();
            }
            // 3) Tell the accept loop to exit (signal via the oneshot
            //    which it doesn't actually await — but if it hasn't
            //    observed the listener drop yet, this is a no-op).
            //    The accept loop wakes on listener.accept() and on
            //    read activity; dropping the listener is what stops it.
            if let Some(tx) = host.accept_task_done.take() {
                let _ = tx.send(());
            }
        }
        // Drop the host side itself, releasing any remaining resources.
        drop(h);
        Ok(())
    }

    // ---------- join ----------

    pub async fn join_discover(
        &self,
        code: String,
        timeout_ms: u64,
    ) -> Result<Vec<PeerInfo>, LanError> {
        let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await?;
        socket.set_broadcast(true)?;
        let discover = DiscoveryMessage::Discover {
            magic: DISCOVERY_MAGIC.to_string(),
            code: code.clone(),
            protocol_version: PROTOCOL_VERSION.to_string(),
        };
        let body = serde_json::to_vec(&discover)?;
        let broadcast_addr_str = self.current_broadcast_addr();
        let discovery_port = self.current_udp_port();
        let broadcast_addr: SocketAddr =
            format!("{broadcast_addr_str}:{discovery_port}")
                .parse()
                .map_err(|e: std::net::AddrParseError| LanError::Invalid(format!("{e}")))?;
        socket.send_to(&body, broadcast_addr).await?;
        let deadline = std::time::Duration::from_millis(timeout_ms);
        let mut buf = [0u8; 4096];
        let mut out: Vec<PeerInfo> = Vec::new();
        let start = std::time::Instant::now();
        while start.elapsed() < deadline {
            let remain = deadline.saturating_sub(start.elapsed());
            let recv = tokio::time::timeout(remain, socket.recv_from(&mut buf)).await;
            match recv {
                Ok(Ok((n, addr))) => {
                    if let Ok(DiscoveryMessage::Announce {
                        magic,
                        code: c,
                        agent_id,
                        display_name,
                        tcp_port,
                        protocol_version,
                    }) = serde_json::from_slice::<DiscoveryMessage>(&buf[..n])
                    {
                        if magic == ANNOUNCE_MAGIC
                            && c == code
                            && protocol_version == PROTOCOL_VERSION
                        {
                            out.push(PeerInfo {
                                ip: addr.ip().to_string(),
                                port: tcp_port,
                                agent_id,
                                display_name,
                                code: c,
                            });
                        }
                    }
                }
                Ok(Err(e)) => return Err(LanError::Io(e)),
                Err(_) => break, // timeout
            }
        }
        Ok(out)
    }

    pub async fn join_connect(
        &self,
        peer_ip: String,
        peer_port: u16,
    ) -> Result<PeerInfo, LanError> {
        {
            let g = self.inner.lock().await;
            if g.join.is_some() {
                return Err(LanError::AlreadyRunning("join".into()));
            }
        }

        let addr: SocketAddr = format!("{peer_ip}:{peer_port}")
            .parse()
            .map_err(|e: std::net::AddrParseError| LanError::Invalid(format!("{e}")))?;
        let stream = TcpStream::connect(addr).await?;
        let (reader, writer) = stream.into_split();
        let writer = Arc::new(Mutex::new(writer));
        // Phase C / C1: bounded inbox. The byte budget lives in the
        // read loop (one budget per connection); the message-count
        // limit is the channel's own capacity.
        let (inbox_tx, inbox_rx) = mpsc::channel::<QueuedMessage>(MAX_QUEUED_MESSAGES);
        let (sh_tx, sh_rx) = tokio::sync::watch::channel(false);
        let writer_for_loop = writer.clone();
        // Phase 16.3 § 5.1: TCP drop detection. One Arc is shared
        // between the read loop (which sets it on EOF / read error)
        // and the TcpLink itself (which the poll/send paths read).
        let peer_closed = Arc::new(AtomicBool::new(false));
        let peer_closed_for_loop = peer_closed.clone();
        // Phase C / C2: the reason a link ended abnormally, shared
        // between the read loop (writes) and the poll/send paths (read).
        let close_reason: Arc<StdMutex<Option<CloseReason>>> = Arc::new(StdMutex::new(None));
        let close_reason_for_loop = close_reason.clone();
        tokio::spawn(async move {
            let res = tcp_read_loop(
                reader,
                inbox_tx,
                sh_rx,
                peer_closed_for_loop,
                close_reason_for_loop,
            )
            .await;
            if let Err(e) = res {
                log::debug!("[lan] join read loop ended: {e}");
            }
        });
        let peer_agent_id = format!("peer@{peer_ip}:{peer_port}");
        let peer_display_name = String::new();
        let link = TcpLink {
            writer: writer_for_loop,
            inbox: inbox_rx,
            shutdown_tx: sh_tx,
            peer_closed,
            close_reason,
        };
        let info = PeerInfo {
            ip: peer_ip.clone(),
            port: peer_port,
            agent_id: peer_agent_id,
            display_name: peer_display_name,
            code: String::new(),
        };

        {
            let mut g = self.inner.lock().await;
            // Re-check (race-free vs. another join_connect).
            if g.join.is_some() {
                return Err(LanError::AlreadyRunning("join".into()));
            }
            g.join = Some(JoinSide {
                peer_ip,
                peer_port,
                link: Some(link),
            });
        }
        Ok(info)
    }

    pub async fn join_poll(&self) -> Result<Vec<String>, LanError> {
        let mut g = self.inner.lock().await;
        let j = g.join.as_mut().ok_or(LanError::NotConnected)?;
        let link = j.link.as_mut().ok_or(LanError::NotConnected)?;
        let mut out = Vec::new();
        loop {
            match link.inbox.try_recv() {
                Ok(m) => out.push(m.body),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    // Phase 16.3 § 5.1: surface PeerClosed when the
                    // read loop has flagged a remote-side drop. Same
                    // reasoning as `host_poll` above. In production
                    // the "Disconnected + !peer_closed" branch is
                    // unreachable after `join_disconnect` because
                    // that command removes the join side before any
                    // further poll runs.
                    if link.was_peer_closed() {
                        return Err(link.closed_error());
                    }
                    break;
                }
            }
        }
        Ok(out)
    }

    pub async fn join_send(&self, msg: String) -> Result<(), LanError> {
        let g = self.inner.lock().await;
        let j = g.join.as_ref().ok_or(LanError::NotConnected)?;
        let link = j.link.as_ref().ok_or(LanError::NotConnected)?;
        // Phase 16.3 § 5.1: see `host_send` above for the rationale.
        if link.was_peer_closed() {
            return Err(link.closed_error());
        }
        let mut w = link.writer.lock().await;
        if let Err(e) = write_envelope(&mut w, &msg).await {
            if let LanError::Io(io) = &e {
                if matches!(
                    io.kind(),
                    std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionAborted
                ) {
                    link.mark_closed();
                    return Err(link.closed_error());
                }
            }
            return Err(e);
        }
        Ok(())
    }

    pub async fn join_disconnect(&self) -> Result<(), LanError> {
        let mut j = {
            let mut g = self.inner.lock().await;
            g.join.take()
        };
        if let Some(ref mut join) = j {
            if let Some(l) = join.link.take() {
                l.shutdown();
            }
        }
        drop(j);
        Ok(())
    }
}

/// Host accept loop: accepts TCP connections, hands each link to
/// LanState, and keeps listening until the host is stopped.
///
/// Phase C / C3: the loop used to `break` after the first accept
/// ("V0.1 single-peer invariant"), which closed the listener and made
/// every later peer permanently unreachable — a reconnect was
/// impossible even after the first peer left. The single-peer
/// invariant is now enforced by the **connection cap**
/// (`MAX_CONNECTIONS`) instead of by tearing the listener down, so a
/// peer that disconnects frees its slot and a new peer can connect.
///
/// On shutdown, the caller drops the listener and fires
/// `accept_done_rx`, which makes `accept()` return an error and the
/// loop exit.
async fn accept_loop(
    state: LanState,
    listener: TcpListener,
    code: String,
    mut accept_done_rx: tokio::sync::oneshot::Receiver<()>,
) {
    // We don't accept a shutdown signal here — the way to stop this
    // loop is to drop `listener`, which makes `accept()` return
    // `Err(BadFileDescriptor)` on the next call. host_stop drops the
    // TcpListener via the `HostSide` we no longer hold after the
    // handover. To make this fully reliable, we keep a shutdown
    // watch: a `oneshot` that, when it fires, exits the loop. The
    // receiver is awaited by the `select!` below, so it must stay
    // alive until the loop ends.
    // Phase C / C1 + C3: how many connections this host is currently
    // serving. A slot is taken when a connection is accepted and
    // released when its read loop ends, so a peer that disconnects
    // frees its slot and a new peer can connect — that is what makes
    // reconnect possible at all. The old loop exited after the first
    // accept, which closed the listener and made every later peer
    // permanently unreachable.
    let live = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    loop {
        // Race the next accept against the shutdown signal so a stuck
        // OS-level accept() doesn't keep us alive forever.
        let next = tokio::select! {
            biased;
            _ = &mut accept_done_rx => {
                log::debug!("[lan] host accept loop: shutdown signalled");
                break;
            }
            r = listener.accept() => r,
        };
        match next {
            Ok((stream, _addr)) => {
                // Phase C / C1: refuse a connection beyond the cap
                // instead of letting it occupy memory.
                let current = live.load(std::sync::atomic::Ordering::Acquire);
                if current >= MAX_CONNECTIONS {
                    log::warn!(
                        "[lan] host refused a connection: {current} live (cap {MAX_CONNECTIONS})"
                    );
                    drop(stream);
                    continue;
                }
                live.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                let (reader, writer) = stream.into_split();
                let writer = Arc::new(Mutex::new(writer));
                // Phase C / C1: bounded inbox. The byte budget lives
                // in the read loop (one budget per connection); the
                // message-count limit is the channel's own capacity.
                let (inbox_tx, inbox_rx) = mpsc::channel::<QueuedMessage>(MAX_QUEUED_MESSAGES);
                let (sh_tx, sh_rx) = tokio::sync::watch::channel(false);
                let writer_for_loop = writer.clone();
                // Phase 16.3 § 5.1: TCP drop detection. Same shape
                // as `join_connect` — one Arc shared between the
                // read loop and the TcpLink the host side holds.
                let peer_closed = Arc::new(AtomicBool::new(false));
                let peer_closed_for_loop = peer_closed.clone();
                // Phase C / C2: the reason a link ended abnormally (see
                // the join side above for the same wiring).
                let close_reason: Arc<StdMutex<Option<CloseReason>>> =
                    Arc::new(StdMutex::new(None));
                let close_reason_for_loop = close_reason.clone();
                // Phase C / C3: release the connection slot when this
                // peer's read loop ends, so the host can serve a new
                // peer after a disconnect.
                let live_for_loop = live.clone();
                tokio::spawn(async move {
                    let res = tcp_read_loop(
                        reader,
                        inbox_tx,
                        sh_rx,
                        peer_closed_for_loop,
                        close_reason_for_loop,
                    )
                    .await;
                    if let Err(e) = res {
                        log::debug!("[lan] host read loop ended: {e}");
                    }
                    live_for_loop.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                });
                let link = TcpLink {
                    writer: writer_for_loop,
                    inbox: inbox_rx,
                    shutdown_tx: sh_tx,
                    peer_closed,
                    close_reason,
                };
                // Hand the link off to the host side. This is the V0.1
                // bug fix: previously the link went to a local mpsc
                // whose receiver was dropped at end of host_start.
                state.set_host_link(link).await;
                log::info!("[lan] host accepted one connection, code={code}");
            }
            Err(e) => {
                log::warn!("[lan] host accept error: {e}");
                break;
            }
        }
    }
}

/// UDP discovery responder.
///
/// The socket is bound by the caller (`host_start`) and handed in
/// already-bound. Binding here instead would make a port clash
/// invisible to the caller: the host would start, show a pairing code,
/// and only then discover in the background that its responder had
/// died — so no peer could ever find it.
async fn udp_responder(
    socket: tokio::net::UdpSocket,
    code: String,
    agent_id: String,
    display_name: String,
    tcp_port: u16,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(), LanError> {
    let mut buf = [0u8; 4096];
    loop {
        if *shutdown.borrow() {
            break;
        }
        let recv = tokio::select! {
            r = socket.recv_from(&mut buf) => r,
            _ = shutdown.changed() => {
                if *shutdown.borrow() { break; }
                continue;
            }
        };
        let (n, addr) = match recv {
            Ok(x) => x,
            Err(e) => return Err(LanError::Io(e)),
        };
        if let Ok(DiscoveryMessage::Discover {
            magic,
            code: c,
            protocol_version,
        }) = serde_json::from_slice::<DiscoveryMessage>(&buf[..n])
        {
            if magic == DISCOVERY_MAGIC && c == code && protocol_version == PROTOCOL_VERSION {
                let reply = DiscoveryMessage::Announce {
                    magic: ANNOUNCE_MAGIC.to_string(),
                    code: code.clone(),
                    agent_id: agent_id.clone(),
                    display_name: display_name.clone(),
                    tcp_port,
                    protocol_version: PROTOCOL_VERSION.to_string(),
                };
                let body = serde_json::to_vec(&reply)?;
                let _ = socket.send_to(&body, addr).await;
            }
        }
    }
    Ok(())
}

/// Phase C / C2 — RAII marker for "this read loop ended because the
/// peer misbehaved or vanished".
///
/// The Phase 16.3 code set `peer_closed` explicitly on each error
/// path, which meant every *new* exit path had to remember to do it
/// too. Two of them did not: an invalid-UTF-8 body and an oversized
/// frame both returned an error while leaving `peer_closed` false, so
/// the poll path reported a "clean local teardown" for a link that a
/// misbehaving peer had actually just dropped.
///
/// The guard inverts that: it is *armed* by default and disarmed only
/// on the paths that are genuinely a local teardown. Everything else —
/// EOF, read error, bad frame length, invalid UTF-8, backpressure
/// timeout — sets the flag exactly once, when the guard drops.
struct PeerCloseGuard {
    flag: Arc<AtomicBool>,
    armed: bool,
}

impl PeerCloseGuard {
    fn new(flag: Arc<AtomicBool>) -> Self {
        Self { flag, armed: true }
    }

    /// Mark the exit as a *local* teardown: the peer did not drop, we
    /// did. The flag stays false so the poll path can tell the two
    /// apart.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PeerCloseGuard {
    fn drop(&mut self) {
        if self.armed {
            self.flag.store(true, std::sync::atomic::Ordering::Release);
        }
    }
}

/// Phase C / C1 — per-connection message rate limiter.
///
/// A fixed-window counter: one second, `limit` messages. A fixed
/// window is not a perfect rate limiter (a peer can send up to twice
/// the limit across a window boundary) but it is allocation-free, has
/// no background task, and bounds the sustained rate to the limit —
/// which is what the resource guards actually need.
struct RateLimiter {
    window_start: std::time::Instant,
    count: u32,
    limit: u32,
}

impl RateLimiter {
    fn new(limit: u32) -> Self {
        Self {
            window_start: std::time::Instant::now(),
            count: 0,
            limit,
        }
    }

    /// True when the caller is still within the rate limit.
    fn allow(&mut self) -> bool {
        if self.window_start.elapsed() >= std::time::Duration::from_secs(1) {
            self.window_start = std::time::Instant::now();
            self.count = 0;
        }
        if self.count >= self.limit {
            return false;
        }
        self.count += 1;
        true
    }
}

/// Why a message could not be parked in the inbox.
enum EnqueueError {
    /// The inbox was closed by the consumer — a local teardown, not a
    /// peer failure.
    Closed,
    /// The inbox stayed full past the backpressure window: the peer is
    /// flooding us, or the consumer is not draining.
    BackpressureTimeout,
}

/// Park `body` in the inbox, applying backpressure.
///
/// Two independent bounds apply: the message count (the channel's own
/// capacity) and the total queued bytes (a semaphore). Both are
/// enforced by *waiting* rather than dropping, so the read loop stops
/// reading, the TCP receive window closes, and the OS throttles the
/// sender — that is the backpressure. The wait is bounded: a peer that
/// keeps the inbox full for longer than
/// `INBOX_BACKPRESSURE_TIMEOUT_MS` is dropped rather than allowed to
/// pin memory forever.
async fn enqueue_message(
    tx: &mpsc::Sender<QueuedMessage>,
    budget: &Arc<tokio::sync::Semaphore>,
    body: String,
) -> Result<(), EnqueueError> {
    let len = body.len();
    let budget_for_wait = budget.clone();
    let tx_for_wait = tx.clone();
    let wait = async move {
        let permit = budget_for_wait
            .acquire_many_owned(len as u32)
            .await
            .map_err(|_| EnqueueError::Closed)?;
        tx_for_wait
            .send(QueuedMessage {
                body,
                _budget: permit,
            })
            .await
            .map_err(|_| EnqueueError::Closed)
    };
    match tokio::time::timeout(
        std::time::Duration::from_millis(INBOX_BACKPRESSURE_TIMEOUT_MS),
        wait,
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(EnqueueError::BackpressureTimeout),
    }
}

async fn tcp_read_loop(
    mut reader: tokio::net::tcp::OwnedReadHalf,
    tx: mpsc::Sender<QueuedMessage>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    peer_closed: Arc<AtomicBool>,
    close_reason: Arc<StdMutex<Option<CloseReason>>>,
) -> Result<(), LanError> {
    // Phase C / C2: every exit path except an explicit local teardown
    // marks the peer as gone. The guard does it once, on drop, so a
    // future exit path cannot forget to.
    let mut guard = PeerCloseGuard::new(peer_closed);
    // Phase C / C1: the byte budget is per connection.
    let budget = Arc::new(tokio::sync::Semaphore::new(MAX_QUEUED_BYTES));
    let mut limiter = RateLimiter::new(MAX_MESSAGES_PER_SECOND);
    let mut len_buf = [0u8; 4];
    loop {
        if *shutdown.borrow() {
            // Phase 16.3 § 5.1: clean local shutdown — `peer_closed`
            // is NOT set. The inbox sender `tx` is implicitly dropped
            // at function return, which signals `Disconnected` to
            // pollers, but they will see `was_peer_closed() == false`
            // and treat it as a local teardown rather than a remote
            // failure.
            guard.disarm();
            break;
        }
        let read_len = match tokio::select! {
            r = reader.read_exact(&mut len_buf) => r,
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    // Local teardown — same reasoning as above.
                    guard.disarm();
                    break;
                }
                continue;
            }
        } {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                // Peer sent FIN — no more frames are coming.
                // The guard marks the link as remotely closed so the
                // poll/send paths can surface PeerClosed on their next
                // call.
                break;
            }
            Err(e) => {
                // Read error (RST, network down, mid-body EOF as
                // error, …) — same treatment as a graceful close.
                return Err(LanError::Io(e));
            }
        };
        let _ = read_len;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 || len > MAX_FRAME_BYTES {
            // Phase C / C1: the limit is enforced *before* the body is
            // allocated, so an oversized length prefix cannot make us
            // reserve the memory it claims. The guard marks the peer
            // as gone (C2) and the reason reaches the UI.
            //
            // The reason is recorded *before* the return, and the
            // return is what drops the guard (which flips
            // `peer_closed`) — so a poller that observes the closed
            // flag is guaranteed to observe the reason too.
            let detail = format!("frame of {len} bytes exceeds the {MAX_FRAME_BYTES} limit");
            record_close_reason(&close_reason, CloseReason::LimitExceeded(detail.clone()));
            return Err(LanError::LimitExceeded(detail));
        }
        if !limiter.allow() {
            // Phase C / C1: the peer is sending faster than the
            // transport is willing to buffer.
            let detail = format!("more than {MAX_MESSAGES_PER_SECOND} messages per second");
            record_close_reason(&close_reason, CloseReason::LimitExceeded(detail.clone()));
            return Err(LanError::LimitExceeded(detail));
        }
        let mut body = vec![0u8; len];
        if let Err(e) = reader.read_exact(&mut body).await {
            // Mid-body read failure — same flag, no half-state.
            return Err(LanError::Io(e));
        }
        let s = match String::from_utf8(body) {
            Ok(s) => s,
            Err(e) => {
                // Phase C / C2: an invalid-UTF-8 body used to return
                // without touching `peer_closed`, so the link looked
                // like a clean local teardown to the poll path. The
                // guard covers this path now, and the reason travels
                // with it so the UI can say *why* the peer was
                // dropped rather than just "the connection ended".
                let detail = format!("{e}");
                record_close_reason(&close_reason, CloseReason::Invalid(detail.clone()));
                return Err(LanError::Invalid(detail));
            }
        };
        match enqueue_message(&tx, &budget, s).await {
            Ok(()) => {}
            Err(EnqueueError::Closed) => {
                // The inbox was closed by the consumer (e.g. link torn
                // down locally). This is not a peer-side failure.
                guard.disarm();
                break;
            }
            Err(EnqueueError::BackpressureTimeout) => {
                // Phase C / C1: the inbox stayed full past the
                // backpressure window.
                let detail = String::from("inbox stayed full past the backpressure window");
                record_close_reason(&close_reason, CloseReason::LimitExceeded(detail.clone()));
                return Err(LanError::LimitExceeded(detail));
            }
        }
    }
    Ok(())
}

async fn write_envelope(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    body: &str,
) -> Result<(), LanError> {
    let bytes = body.as_bytes();
    let len = bytes.len() as u32;
    writer.write_all(&len.to_be_bytes()).await?;
    writer.write_all(bytes).await?;
    writer.flush().await?;
    Ok(())
}

// Reserved public helper for tests.
#[allow(dead_code)]
pub async fn write_envelope_to_stream(writer: &mut TcpStream, body: &str) -> Result<(), LanError> {
    let bytes = body.as_bytes();
    let len = bytes.len() as u32;
    writer.write_all(&len.to_be_bytes()).await?;
    writer.write_all(bytes).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Phase 16.5 § Task 3: Rust ↔ TypeScript IPC contract tests.
    //!
    //! The TypeScript side classifies Tauri IPC rejections into a
    //! `LanErrorKind` by matching the rejection's `.message` against
    //! the Rust `Display` text for each `LanError` variant. If a
    //! variant's `#[error("…")]` attribute changes, the TS classifier
    //! silently stops recognising it and the variant lands in
    //! `unknown` — which for `PeerClosed` means the `onClose` hook
    //! never fires and the peer-close event is misclassified as a
    //! generic error.
    //!
    //! These tests pin the Display strings. They must be updated
    //! together with `LAN_ERROR_PEER_CLOSED_DISPLAY` /
    //! `LAN_ERROR_NOT_CONNECTED_DISPLAY` in
    //! `packages/transport/src/lan-error.ts`.
    use super::*;

    #[test]
    fn peer_closed_display_matches_ipc_contract() {
        // The exact string the TS classifier matches against.
        // Mirrors `LAN_ERROR_PEER_CLOSED_DISPLAY` in
        // `packages/transport/src/lan-error.ts`.
        assert_eq!(LanError::PeerClosed.to_string(), "peer closed");
    }

    #[test]
    fn not_connected_display_matches_ipc_contract() {
        // The exact string the TS classifier matches against.
        // Mirrors `LAN_ERROR_NOT_CONNECTED_DISPLAY` in
        // `packages/transport/src/lan-error.ts`.
        assert_eq!(LanError::NotConnected.to_string(), "not connected");
    }

    /// Phase 16.5 § Task 3 (Task 1 follow-up): the
    /// `serialize_str(&self.to_string())` impl on `LanError` is the
    /// second half of the IPC contract. If anyone re-implements it
    /// to serialise the variant tag instead of the Display string,
    /// the TS classifier will fail to match. Pin the current
    /// behaviour.
    #[test]
    fn lan_error_serialises_to_display_string() {
        let json = serde_json::to_string(&LanError::PeerClosed).expect("LanError must serialise");
        // The serialised form is a JSON string (because
        // `serialize_str`), not a tagged object. The TS classifier
        // reads it as a plain string and matches against
        // `LAN_ERROR_PEER_CLOSED_DISPLAY`.
        assert_eq!(json, "\"peer closed\"");
    }

    // -----------------------------------------------------------------
    // Phase C / C1 + C2
    // -----------------------------------------------------------------

    /// Phase C / C1: the new `LimitExceeded` variant must reach the
    /// TypeScript classifier with the exact prefix it matches on.
    /// Mirrors `LAN_ERROR_LIMIT_EXCEEDED_PREFIX` in
    /// `packages/transport/src/lan-error.ts`.
    #[test]
    fn limit_exceeded_display_matches_ipc_contract() {
        let text = LanError::LimitExceeded("frame too big".to_string()).to_string();
        assert_eq!(text, "peer exceeded limit: frame too big");
        assert!(text.starts_with("peer exceeded limit: "));
    }

    /// Phase C / C2: the guard is armed by default, so any exit path
    /// that does not disarm it marks the peer as gone. This is the
    /// property the old explicit `peer_closed.store(...)` calls could
    /// not guarantee — two exit paths forgot to set the flag.
    #[test]
    fn peer_close_guard_armed_sets_the_flag() {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let _guard = PeerCloseGuard::new(flag.clone());
            assert!(!flag.load(std::sync::atomic::Ordering::Acquire));
        }
        assert!(flag.load(std::sync::atomic::Ordering::Acquire));
    }

    /// Phase C / C2: a local teardown disarms the guard, so the poll
    /// path can still tell "we stopped" from "the peer dropped".
    #[test]
    fn peer_close_guard_disarmed_leaves_the_flag_alone() {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut guard = PeerCloseGuard::new(flag.clone());
            guard.disarm();
        }
        assert!(!flag.load(std::sync::atomic::Ordering::Acquire));
    }

    /// Phase C / C1: the rate limiter lets exactly `limit` messages
    /// through per window and rejects the next one.
    #[test]
    fn rate_limiter_rejects_past_the_limit() {
        let mut limiter = RateLimiter::new(3);
        assert!(limiter.allow());
        assert!(limiter.allow());
        assert!(limiter.allow());
        assert!(
            !limiter.allow(),
            "the 4th message in a window must be rejected"
        );
    }

    /// Phase C / C1: the window rolls over, so a peer that waits is
    /// not penalised forever.
    #[test]
    fn rate_limiter_resets_after_the_window() {
        let mut limiter = RateLimiter::new(1);
        assert!(limiter.allow());
        assert!(!limiter.allow());
        // Force the window to expire instead of sleeping a real second
        // — the limiter only reads the elapsed time.
        limiter.window_start = std::time::Instant::now() - std::time::Duration::from_secs(2);
        assert!(limiter.allow(), "a new window must reset the counter");
    }

    /// Phase C / C1: the inbox is bounded by message count. Once it
    /// is full, `enqueue_message` waits (backpressure) instead of
    /// growing the queue without limit — and gives up after the
    /// backpressure window rather than pinning memory forever.
    #[tokio::test]
    async fn enqueue_is_bounded_by_message_count() {
        let (tx, mut rx) = mpsc::channel::<QueuedMessage>(2);
        let budget = Arc::new(tokio::sync::Semaphore::new(MAX_QUEUED_BYTES));
        assert!(enqueue_message(&tx, &budget, "a".to_string()).await.is_ok());
        assert!(enqueue_message(&tx, &budget, "b".to_string()).await.is_ok());

        // The third message cannot be parked: the channel is full.
        let started = std::time::Instant::now();
        let result = enqueue_message(&tx, &budget, "c".to_string()).await;
        assert!(matches!(result, Err(EnqueueError::BackpressureTimeout)));
        assert!(
            started.elapsed()
                >= std::time::Duration::from_millis(INBOX_BACKPRESSURE_TIMEOUT_MS - 50),
            "the enqueue must have waited for the whole backpressure window"
        );

        // The two parked messages are still intact and readable.
        assert_eq!(rx.recv().await.map(|m| m.body), Some("a".to_string()));
        assert_eq!(rx.recv().await.map(|m| m.body), Some("b".to_string()));
    }

    /// Phase C / C1: the byte budget bounds the *bytes* parked in the
    /// inbox, not just the message count. Without it, 256 × 1 MiB
    /// messages could sit in memory.
    #[tokio::test]
    async fn enqueue_is_bounded_by_total_bytes() {
        // A budget of 1 KiB and messages of 600 bytes each.
        let (tx, mut rx) = mpsc::channel::<QueuedMessage>(MAX_QUEUED_MESSAGES);
        let budget = Arc::new(tokio::sync::Semaphore::new(1024));
        let body = "x".repeat(600);
        assert!(enqueue_message(&tx, &budget, body.clone()).await.is_ok());

        // 600 + 600 = 1200 > 1024, so the second message has to wait
        // for budget that only appears once the first message is
        // drained.
        let budget_for_wait = budget.clone();
        let tx_for_wait = tx.clone();
        let body_for_wait = body.clone();
        let waiter = tokio::spawn(async move {
            enqueue_message(&tx_for_wait, &budget_for_wait, body_for_wait).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            !waiter.is_finished(),
            "the second message must wait for byte budget"
        );

        // Draining the first message releases its permit.
        let first = rx.recv().await.expect("first message");
        assert_eq!(first.body.len(), 600);
        drop(first);
        let second = waiter.await.expect("waiter task");
        assert!(second.is_ok(), "the second message must go through");
    }

    /// Phase C / C1: the frame limit must stay small enough to bound
    /// the worst-case allocation. The old value was 16 MiB.
    ///
    /// Both bounds compare two compile-time constants, so they are
    /// asserted in a `const` block: a violation is a **build error**,
    /// not a runtime test failure. The test itself is kept so the
    /// invariant stays visible in the test report.
    #[test]
    fn frame_limit_is_bounded() {
        const _: () = {
            assert!(
                MAX_FRAME_BYTES <= 1024 * 1024,
                "the frame limit must not exceed 1 MiB"
            );
            assert!(
                MAX_FRAME_BYTES >= 64 * 1024,
                "legitimate envelopes must still fit"
            );
        };
    }

    /// Phase C / C2: the close reason reaches the poll and send
    /// paths, so the UI can say *why* the link dropped instead of only
    /// *that* it dropped.
    #[test]
    fn close_reason_maps_to_the_matching_error() {
        let slot = Arc::new(StdMutex::new(None));
        // No reason recorded — the peer simply went away.
        assert!(matches!(closed_error(&slot), LanError::PeerClosed));
        record_close_reason(&slot, CloseReason::LimitExceeded("too fast".to_string()));
        assert!(matches!(closed_error(&slot), LanError::LimitExceeded(_)));
        record_close_reason(&slot, CloseReason::Invalid("bad utf-8".to_string()));
        assert!(matches!(closed_error(&slot), LanError::Invalid(_)));
    }

    /// Phase C / C2: the reason is written *before* the read loop
    /// returns, and the return is what drops the guard that flips the
    /// peer-closed flag. So a poller that observes the flag is
    /// guaranteed to observe the reason too — that ordering is what
    /// keeps the Rust, TypeScript and UI layers in agreement.
    #[test]
    fn the_close_reason_is_present_whenever_the_peer_closed_flag_is_set() {
        let flag = Arc::new(AtomicBool::new(false));
        let slot = Arc::new(StdMutex::new(None));
        {
            let _guard = PeerCloseGuard::new(flag.clone());
            // The read loop records the reason *before* it returns,
            // i.e. before the guard drops.
            record_close_reason(&slot, CloseReason::LimitExceeded("too fast".to_string()));
            // `_guard` drops here, setting the flag.
        }
        assert!(flag.load(std::sync::atomic::Ordering::Acquire));
        assert!(read_close_reason(&slot).is_some());
    }
}
