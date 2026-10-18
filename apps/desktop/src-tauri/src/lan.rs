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

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};

const DISCOVERY_PORT: u16 = 52419;
const DISCOVERY_MAGIC: &str = "kindora/discover/v1";
const ANNOUNCE_MAGIC: &str = "kindora/announce/v1";
const PROTOCOL_VERSION: &str = "0.1";
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

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
    inbox: mpsc::UnboundedReceiver<String>,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    peer_closed: Arc<AtomicBool>,
}

impl TcpLink {
    /// Read the next decoded JSON body, returning `None` on EOF or shutdown.
    #[allow(dead_code)]
    async fn next(&mut self) -> Option<String> {
        self.inbox.recv().await
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
        self.peer_closed.store(true, std::sync::atomic::Ordering::Release);
    }
}

struct HostSide {
    tcp_port: u16,
    agent_id: String,
    display_name: String,
    code: String,
    link: Option<TcpLink>,
    udp_shutdown: Option<tokio::sync::watch::Sender<bool>>,
    /// Signalled when the accept loop has handed off (or failed) so
    /// host_stop can wait for it to exit instead of racing the lock.
    accept_task_done: Option<tokio::sync::oneshot::Sender<()>>,
}

#[allow(dead_code)]
struct JoinSide {
    peer_ip: String,
    peer_port: u16,
    link: Option<TcpLink>,
}

impl Default for HostSide {
    fn default() -> Self {
        Self {
            tcp_port: 0,
            agent_id: String::new(),
            display_name: String::new(),
            code: String::new(),
            link: None,
            udp_shutdown: None,
            accept_task_done: None,
        }
    }
}

impl Default for JoinSide {
    fn default() -> Self {
        Self { peer_ip: String::new(), peer_port: 0, link: None }
    }
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
        let mut g = self.broadcast_addr.lock().expect("broadcast_addr mutex poisoned");
        *g = Some(addr);
    }

    fn current_broadcast_addr(&self) -> String {
        let g = self.broadcast_addr.lock().expect("broadcast_addr mutex poisoned");
        g.clone().unwrap_or_else(|| "255.255.255.255".to_string())
    }

    /// Override the host's UDP bind address. Mostly for tests.
    /// Synchronous because `udp_bind_addr` is a `std::sync::Mutex`.
    pub fn set_udp_bind_addr(&self, addr: String) {
        let mut g = self.udp_bind_addr.lock().expect("udp_bind_addr mutex poisoned");
        *g = Some(addr);
    }

    fn current_udp_bind_addr(&self) -> String {
        let g = self.udp_bind_addr.lock().expect("udp_bind_addr mutex poisoned");
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
            h.link = Some(link);
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
        // Lock-check: refuse double-start.
        {
            let mut g = self.inner.lock().await;
            if g.host.is_some() {
                return Err(LanError::AlreadyRunning("host".into()));
            }
            // Reserve the host slot by inserting a placeholder; we'll
            // fill in tcp_port + link + accept_task_done after we bind.
            // We can't hold the lock across the bind below, so we use
            // a sentinel-free pattern: bind, then insert.
            let _ = &mut *g; // keep the lock until end of scope
        }

        let listener = TcpListener::bind(("0.0.0.0", 0)).await?;
        let tcp_port = listener.local_addr()?.port();

        // UDP responder
        let (udp_sh_tx, udp_sh_rx) = tokio::sync::watch::channel(false);
        let code_u = code.clone();
        let agent_u = agent_id.clone();
        let display_u = display_name.clone();
        let bind_u = self.current_udp_bind_addr();
        let port_u = self.current_udp_port();
        tokio::spawn(async move {
            let res = udp_responder(code_u, agent_u, display_u, tcp_port, bind_u, port_u, udp_sh_rx).await;
            if let Err(e) = res {
                log::warn!("[lan] udp responder exited: {e}");
            }
        });

        // Accept loop. Clones the Arc<Mutex<Inner>> so the spawned task
        // can push the link into HostSide without going through a
        // local mpsc channel (which was the V0.1 bug: accept_rx was
        // dropped at end of host_start, so the link was never received).
        let (accept_done_tx, accept_done_rx) = tokio::sync::oneshot::channel::<()>();
        let state_for_accept = self.clone();
        let code_a = code.clone();
        let accept_handle = tokio::spawn(async move {
            accept_loop(state_for_accept, listener, code_a, accept_done_rx).await;
        });
        // The accept_handle itself isn't stored — host_stop is the only
        // thing that needs to wait for the loop to exit, and that's
        // handled via the listener being dropped on host_stop.

        // Insert the host side. Acquire the lock briefly.
        {
            let mut g = self.inner.lock().await;
            // Re-check inside the lock (race-free vs. another host_start).
            if g.host.is_some() {
                return Err(LanError::AlreadyRunning("host".into()));
            }
            g.host = Some(HostSide {
                tcp_port,
                agent_id: agent_id.clone(),
                display_name: display_name.clone(),
                code: code.clone(),
                link: None,
                udp_shutdown: Some(udp_sh_tx),
                accept_task_done: Some(accept_done_tx),
            });
        }

        // Keep the JoinHandle alive in a fire-and-forget way — the
        // accept loop only returns when host_stop closes the listener
        // or after the first accept (V0.1 single-peer invariant).
        // The runtime will reap it on completion.
        drop(accept_handle);

        Ok(HostInfo {
            tcp_port,
            agent_id,
            display_name,
            code,
        })
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
                Ok(s) => out.push(s),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    if link.was_peer_closed() {
                        return Err(LanError::PeerClosed);
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
            return Err(LanError::PeerClosed);
        }
        let mut w = link.writer.lock().await;
        if let Err(e) = write_envelope(&mut *w, &msg).await {
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
                    return Err(LanError::PeerClosed);
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
            // 1) Signal the UDP responder to stop (drops its socket).
            if let Some(u) = host.udp_shutdown.take() {
                let _ = u.send(true);
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
        let broadcast_addr: SocketAddr = format!("{broadcast_addr_str}:{discovery_port}")
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
        let (inbox_tx, inbox_rx) = mpsc::unbounded_channel::<String>();
        let (sh_tx, sh_rx) = tokio::sync::watch::channel(false);
        let writer_for_loop = writer.clone();
        // Phase 16.3 § 5.1: TCP drop detection. One Arc is shared
        // between the read loop (which sets it on EOF / read error)
        // and the TcpLink itself (which the poll/send paths read).
        let peer_closed = Arc::new(AtomicBool::new(false));
        let peer_closed_for_loop = peer_closed.clone();
        tokio::spawn(async move {
            let res = tcp_read_loop(reader, inbox_tx, sh_rx, peer_closed_for_loop).await;
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
                Ok(s) => out.push(s),
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
                        return Err(LanError::PeerClosed);
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
            return Err(LanError::PeerClosed);
        }
        let mut w = link.writer.lock().await;
        if let Err(e) = write_envelope(&mut *w, &msg).await {
            if let LanError::Io(io) = &e {
                if matches!(
                    io.kind(),
                    std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionAborted
                ) {
                    link.mark_closed();
                    return Err(LanError::PeerClosed);
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

/// Host accept loop: waits for the first TCP connection, hands the
/// link to LanState, then exits (V0.1 single-peer invariant). On
/// shutdown, the caller drops the listener, which makes `accept()` return
/// an error and the loop exits.
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
    // watch: a `oneshot` that, when it fires, exits the loop.
    let _ = &mut accept_done_rx; // currently unused; drop is enough
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
                let (reader, writer) = stream.into_split();
                let writer = Arc::new(Mutex::new(writer));
                let (inbox_tx, inbox_rx) = mpsc::unbounded_channel::<String>();
                let (sh_tx, sh_rx) = tokio::sync::watch::channel(false);
                let writer_for_loop = writer.clone();
                // Phase 16.3 § 5.1: TCP drop detection. Same shape
                // as `join_connect` — one Arc shared between the
                // read loop and the TcpLink the host side holds.
                let peer_closed = Arc::new(AtomicBool::new(false));
                let peer_closed_for_loop = peer_closed.clone();
                tokio::spawn(async move {
                    let res = tcp_read_loop(reader, inbox_tx, sh_rx, peer_closed_for_loop).await;
                    if let Err(e) = res {
                        log::debug!("[lan] host read loop ended: {e}");
                    }
                });
                let link = TcpLink {
                    writer: writer_for_loop,
                    inbox: inbox_rx,
                    shutdown_tx: sh_tx,
                    peer_closed,
                };
                // Hand the link off to the host side. This is the V0.1
                // bug fix: previously the link went to a local mpsc
                // whose receiver was dropped at end of host_start.
                state.set_host_link(link).await;
                log::info!("[lan] host accepted one connection, code={code}, closing listener");
                // V0.1: only one peer per session; stop accepting after first.
                // Drop the listener so any further accept() calls fail.
                break;
            }
            Err(e) => {
                log::warn!("[lan] host accept error: {e}");
                break;
            }
        }
    }
}

async fn udp_responder(
    code: String,
    agent_id: String,
    display_name: String,
    tcp_port: u16,
    bind_addr: String,
    bind_port: u16,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(), LanError> {
    let bind: SocketAddr = format!("{bind_addr}:{bind_port}")
        .parse()
        .map_err(|e: std::net::AddrParseError| LanError::Invalid(format!("{e}")))?;
    let socket = tokio::net::UdpSocket::bind(bind).await?;
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
        if let Ok(msg) = serde_json::from_slice::<DiscoveryMessage>(&buf[..n]) {
            if let DiscoveryMessage::Discover {
                magic,
                code: c,
                protocol_version,
            } = msg
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
    }
    Ok(())
}

async fn tcp_read_loop(
    mut reader: tokio::net::tcp::OwnedReadHalf,
    tx: mpsc::UnboundedSender<String>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    peer_closed: Arc<AtomicBool>,
) -> Result<(), LanError> {
    let mut len_buf = [0u8; 4];
    loop {
        if *shutdown.borrow() {
            // Phase 16.3 § 5.1: clean local shutdown — `peer_closed`
            // is NOT set. The inbox sender `tx` is implicitly dropped
            // at function return, which signals `Disconnected` to
            // pollers, but they will see `was_peer_closed() == false`
            // and treat it as a local teardown rather than a remote
            // failure.
            break;
        }
        let read_len = match tokio::select! {
            r = reader.read_exact(&mut len_buf) => r,
            _ = shutdown.changed() => {
                if *shutdown.borrow() { break; }
                continue;
            }
        } {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                // Peer sent FIN — no more frames are coming.
                // Mark the link as remotely closed so the poll/send
                // paths can surface PeerClosed on their next call.
                peer_closed.store(true, std::sync::atomic::Ordering::Release);
                break;
            }
            Err(e) => {
                // Read error (RST, network down, mid-body EOF as
                // error, …) — same treatment as a graceful close.
                peer_closed.store(true, std::sync::atomic::Ordering::Release);
                return Err(LanError::Io(e));
            }
        };
        let _ = read_len;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 || len > MAX_FRAME_BYTES {
            return Err(LanError::Invalid(format!("bad frame length: {len}")));
        }
        let mut body = vec![0u8; len];
        if let Err(e) = reader.read_exact(&mut body).await {
            // Mid-body read failure — same flag, no half-state.
            peer_closed.store(true, std::sync::atomic::Ordering::Release);
            return Err(LanError::Io(e));
        }
        let s = String::from_utf8(body).map_err(|e| LanError::Invalid(format!("{e}")))?;
        if tx.send(s).is_err() {
            // The inbox was closed by the consumer (e.g. link torn
            // down locally). This is not a peer-side failure.
            break;
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
pub async fn write_envelope_to_stream(
    writer: &mut TcpStream,
    body: &str,
) -> Result<(), LanError> {
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
        let json = serde_json::to_string(&LanError::PeerClosed)
            .expect("LanError must serialise");
        // The serialised form is a JSON string (because
        // `serialize_str`), not a tagged object. The TS classifier
        // reads it as a plain string and matches against
        // `LAN_ERROR_PEER_CLOSED_DISPLAY`.
        assert_eq!(json, "\"peer closed\"");
    }
}
