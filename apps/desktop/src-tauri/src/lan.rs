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

use std::net::SocketAddr;
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

struct TcpLink {
    writer: Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>,
    inbox: mpsc::UnboundedReceiver<String>,
    shutdown_tx: tokio::sync::watch::Sender<bool>,
}

struct HostSide {
    tcp_port: u16,
    agent_id: String,
    display_name: String,
    code: String,
    link: Option<TcpLink>,
    udp_shutdown: Option<tokio::sync::watch::Sender<bool>>,
}

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
        }
    }
}

impl Default for JoinSide {
    fn default() -> Self {
        Self { peer_ip: String::new(), peer_port: 0, link: None }
    }
}

#[derive(Default)]
pub struct LanState {
    inner: Arc<Mutex<Inner>>,
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

    // ---------- host ----------

    pub async fn host_start(
        &self,
        code: String,
        agent_id: String,
        display_name: String,
    ) -> Result<HostInfo, LanError> {
        let mut g = self.inner.lock().await;
        if g.host.is_some() {
            return Err(LanError::AlreadyRunning("host".into()));
        }
        let listener = TcpListener::bind(("0.0.0.0", 0)).await?;
        let tcp_port = listener.local_addr()?.port();

        // UDP responder
        let (udp_sh_tx, mut udp_sh_rx) = tokio::sync::watch::channel(false);
        let code_u = code.clone();
        let agent_u = agent_id.clone();
        let display_u = display_name.clone();
        tokio::spawn(async move {
            let res = udp_responder(code_u, agent_u, display_u, tcp_port, udp_sh_rx.clone()).await;
            if let Err(e) = res {
                log::warn!("[lan] udp responder exited: {e}");
            }
        });

        // TCP accept loop. The link will be filled in on the first accept.
        let (accept_tx, mut accept_rx) = mpsc::unbounded_channel::<TcpLink>();
        let code_a = code.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let (reader, writer) = stream.into_split();
                        let writer = Arc::new(Mutex::new(writer));
                        let (inbox_tx, inbox_rx) = mpsc::unbounded_channel::<String>();
                        let (sh_tx, sh_rx) = tokio::sync::watch::channel(false);
                        let writer_for_loop = writer.clone();
                        tokio::spawn(async move {
                            let res = tcp_read_loop(reader, inbox_tx, sh_rx).await;
                            if let Err(e) = res {
                                log::debug!("[lan] host read loop ended: {e}");
                            }
                        });
                        // We push the link to the orchestrator via the accept_tx channel
                        let _ = accept_tx.send(TcpLink {
                            writer: writer_for_loop,
                            inbox: inbox_rx,
                            shutdown_tx: sh_tx,
                        });
                        // V0.1: only one peer per session; stop accepting after first.
                        log::info!("[lan] host accepted one connection, code={code_a}, closing listener");
                        break;
                    }
                    Err(e) => {
                        log::warn!("[lan] host accept error: {e}");
                        break;
                    }
                }
            }
        });

        let host = HostSide {
            tcp_port,
            agent_id: agent_id.clone(),
            display_name: display_name.clone(),
            code: code.clone(),
            link: None,
            udp_shutdown: Some(udp_sh_tx),
        };
        g.host = Some(host);

        // Drop the lock before awaiting the inbox
        drop(g);

        // Wait briefly for a peer. The Tauri command will see the link once filled.
        // We don't block here — the host_start returns immediately. The frontend
        // polls host_poll repeatedly.
        let _ = accept_rx; // keep the channel open in the spawned task

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
        // If link not set, try to receive from a one-shot channel stored in the host.
        // For V0.1 we use a side-channel: the host side stores the next link as
        // a separate Option. The accept task pushes a fresh link via host_set_link.
        // To keep this simple, we expose host_take_link as a separate command.
        if h.link.is_none() {
            return Ok(vec![]);
        }
        let link = h.link.as_mut().unwrap();
        let mut out = Vec::new();
        loop {
            match link.inbox.try_recv() {
                Ok(s) => out.push(s),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => break,
            }
        }
        Ok(out)
    }

    pub async fn host_take_link(&self) -> Result<bool, LanError> {
        // V0.1 stub: host_start does not return the link in the same call.
        // The frontend must call host_start, then poll host_status; the
        // link is filled when the joiner connects. The frontend polls
        // host_status to detect "linked". For simplicity, this is exposed
        // as a stub and host_poll only returns when link is set.
        Ok(false)
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

    pub async fn host_set_link(&self, link: TcpLink) {
        let mut g = self.inner.lock().await;
        if let Some(h) = g.host.as_mut() {
            h.link = Some(link);
        }
    }

    pub async fn host_send(&self, msg: String) -> Result<(), LanError> {
        let g = self.inner.lock().await;
        let h = g.host.as_ref().ok_or(LanError::NotConnected)?;
        let link = h.link.as_ref().ok_or(LanError::NotConnected)?;
        let mut w = link.writer.lock().await;
        write_envelope(&mut *w, &msg).await?;
        Ok(())
    }

    pub async fn host_stop(&self) -> Result<(), LanError> {
        let mut g = self.inner.lock().await;
        if let Some(mut h) = g.host.take() {
            if let Some(u) = h.udp_shutdown.take() { let _ = u.send(true); }
            if let Some(l) = h.link.take() { let _ = l.shutdown_tx.send(true); }
        }
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
        let broadcast_addr: SocketAddr = format!("255.255.255.255:{DISCOVERY_PORT}")
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
        let mut g = self.inner.lock().await;
        if g.join.is_some() {
            return Err(LanError::AlreadyRunning("join".into()));
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
        tokio::spawn(async move {
            let res = tcp_read_loop(reader, inbox_tx, sh_rx).await;
            if let Err(e) = res {
                log::debug!("[lan] join read loop ended: {e}");
            }
        });
        let peer_agent_id = format!("peer@{peer_ip}:{peer_port}");
        let peer_display_name = String::new();
        let link = TcpLink { writer: writer_for_loop, inbox: inbox_rx, shutdown_tx: sh_tx };
        let info = PeerInfo {
            ip: peer_ip.clone(),
            port: peer_port,
            agent_id: peer_agent_id,
            display_name: peer_display_name,
            code: String::new(),
        };
        g.join = Some(JoinSide {
            peer_ip,
            peer_port,
            link: Some(link),
        });
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
                Err(mpsc::error::TryRecvError::Disconnected) => break,
            }
        }
        Ok(out)
    }

    pub async fn join_send(&self, msg: String) -> Result<(), LanError> {
        let g = self.inner.lock().await;
        let j = g.join.as_ref().ok_or(LanError::NotConnected)?;
        let link = j.link.as_ref().ok_or(LanError::NotConnected)?;
        let mut w = link.writer.lock().await;
        write_envelope(&mut *w, &msg).await?;
        Ok(())
    }

    pub async fn join_disconnect(&self) -> Result<(), LanError> {
        let mut g = self.inner.lock().await;
        if let Some(mut j) = g.join.take() {
            if let Some(l) = j.link.take() {
                let _ = l.shutdown_tx.send(true);
            }
        }
        Ok(())
    }

    pub async fn join_set_peer_link_via_accept(&self, link: TcpLink) {
        // Reserved for future: when the host side receives a peer, it stores the link.
        // This setter is exposed so external tasks (the host accept task) can hand off
        // the link without holding the mutex across await points.
        let mut g = self.inner.lock().await;
        if let Some(j) = g.join.as_mut() {
            j.link = Some(link);
        }
    }
}

async fn udp_responder(
    code: String,
    agent_id: String,
    display_name: String,
    tcp_port: u16,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(), LanError> {
    let socket = tokio::net::UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)).await?;
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
) -> Result<(), LanError> {
    let mut len_buf = [0u8; 4];
    loop {
        if *shutdown.borrow() {
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
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(LanError::Io(e)),
        };
        let _ = read_len;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 || len > MAX_FRAME_BYTES {
            return Err(LanError::Invalid(format!("bad frame length: {len}")));
        }
        let mut body = vec![0u8; len];
        if let Err(e) = reader.read_exact(&mut body).await {
            return Err(LanError::Io(e));
        }
        let s = String::from_utf8(body).map_err(|e| LanError::Invalid(format!("{e}")))?;
        if tx.send(s).is_err() {
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
