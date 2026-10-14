// Experiment A — Host binary.
//
// Verifies a single UDP exchange between two independent Rust
// processes on the same machine. This binary is **only** used by
// `scripts/run_unicast_test.sh` and does NOT participate in the
// production LAN transport.
//
// Lifecycle:
//   1. Parse CLI args: <local_udp_port> <peer_udp_port>
//   2. Bind UDP socket on local_udp_port.
//   3. Wait up to TIMEOUT_S for a "ready" datagram from peer.
//   4. Send `lan_announce` JSON to peer's UDP port.
//   5. Wait up to TIMEOUT_S for `lan_invite_ack` from peer.
//   6. Validate kind + agent_id (UUID v4) + protocol_version.
//   7. Print exact "OK" line on stdout; exit 0.
//   8. Any failure: print to stderr; exit non-zero.

use std::env;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::process::ExitCode;
use std::time::{Duration, Instant};

const TIMEOUT_S: u64 = 8;
const PROTOCOL_VERSION: &str = "0.1";
const HOST_AGENT_ID: &str = "11111111-2222-4333-8444-555555555555";

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("[host] FAIL: usage: {} <local_udp_port> <peer_udp_port>", args[0]);
        return ExitCode::from(2);
    }
    let local_port: u16 = match args[1].parse() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[host] FAIL: invalid local_udp_port: {}", e);
            return ExitCode::from(2);
        }
    };
    let peer_port: u16 = match args[2].parse() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[host] FAIL: invalid peer_udp_port: {}", e);
            return ExitCode::from(2);
        }
    };

    let local_addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, local_port));
    let socket = match UdpSocket::bind(local_addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[host] FAIL: bind {}: {}", local_addr, e);
            return ExitCode::from(3);
        }
    };
    if let Err(e) = socket.set_read_timeout(Some(Duration::from_secs(TIMEOUT_S))) {
        eprintln!("[host] FAIL: set_read_timeout: {}", e);
        return ExitCode::from(3);
    }
    let peer_addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, peer_port));

    // Stage 1: wait for "ready" from joiner.
    let mut buf = [0u8; 4096];
    eprintln!("[host] waiting for 'ready' on udp://{} ...", local_addr);
    let (n, src) = match socket.recv_from(&mut buf) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("[host] FAIL: recv ready: {}", e);
            return ExitCode::from(4);
        }
    };
    let ready_msg = std::str::from_utf8(&buf[..n]).unwrap_or("");
    if ready_msg.trim() != "ready" {
        eprintln!("[host] FAIL: expected 'ready', got {:?}", ready_msg);
        return ExitCode::from(4);
    }
    eprintln!("[host] got 'ready' from {}", src);

    // Stage 2: send `lan_announce` to peer.
    let announce = serde_json::json!({
        "kind": "lan_announce",
        "agent_id": HOST_AGENT_ID,
        "protocol_version": PROTOCOL_VERSION,
    });
    let announce_bytes = match serde_json::to_vec(&announce) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[host] FAIL: serialize announce: {}", e);
            return ExitCode::from(5);
        }
    };
    let announce_dst = SocketAddr::V4(SocketAddrV4::new(
        match src {
            SocketAddr::V4(a) => *a.ip(),
            SocketAddr::V6(_) => {
                eprintln!("[host] FAIL: IPv6 source not supported in experiment");
                return ExitCode::from(4);
            }
        },
        peer_port,
    ));
    if let Err(e) = socket.send_to(&announce_bytes, announce_dst) {
        eprintln!("[host] FAIL: send announce: {}", e);
        return ExitCode::from(5);
    }
    eprintln!("[host] sent lan_announce to {}", announce_dst);

    // Stage 3: wait for `lan_invite_ack`.
    eprintln!("[host] waiting for 'lan_invite_ack' ...");
    let deadline = Instant::now() + Duration::from_secs(TIMEOUT_S);
    let mut ack_ok = false;
    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((m, _)) => {
                let text = std::str::from_utf8(&buf[..m]).unwrap_or("");
                let v: serde_json::Value = match serde_json::from_str(text) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[host] FAIL: parse ack json: {}", e);
                        return ExitCode::from(6);
                    }
                };
                let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
                if kind != "lan_invite_ack" {
                    eprintln!("[host] FAIL: bad ack kind: {:?}", kind);
                    return ExitCode::from(6);
                }
                let agent_id = v.get("agent_id").and_then(|a| a.as_str()).unwrap_or("");
                if !is_uuid_v4(agent_id) {
                    eprintln!("[host] FAIL: ack agent_id not UUID v4: {:?}", agent_id);
                    return ExitCode::from(6);
                }
                let pv = v.get("protocol_version").and_then(|p| p.as_str()).unwrap_or("");
                if pv != PROTOCOL_VERSION {
                    eprintln!(
                        "[host] FAIL: ack protocol_version {:?} != {:?}",
                        pv, PROTOCOL_VERSION
                    );
                    return ExitCode::from(6);
                }
                ack_ok = true;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => {
                eprintln!("[host] FAIL: recv ack: {}", e);
                return ExitCode::from(6);
            }
        }
    }
    if !ack_ok {
        eprintln!("[host] FAIL: timed out waiting for lan_invite_ack");
        return ExitCode::from(7);
    }

    println!("OK");
    eprintln!("[host] DONE");
    ExitCode::SUCCESS
}

fn is_uuid_v4(s: &str) -> bool {
    // 8-4-4-4-12 hex; version digit (3rd group) must be '4';
    // variant nibble (4th group start) must be 8/9/a/b.
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    if parts[0].len() != 8 || parts[1].len() != 4 || parts[2].len() != 4
        || parts[3].len() != 4 || parts[4].len() != 12
    {
        return false;
    }
    let all_hex = format!("{}{}{}{}{}", parts[0], parts[1], parts[2], parts[3], parts[4]);
    if !all_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let version = parts[2].chars().next().unwrap_or(' ');
    if version != '4' {
        return false;
    }
    let variant = parts[3].chars().next().unwrap_or(' ');
    matches!(variant, '8' | '9' | 'a' | 'b')
}