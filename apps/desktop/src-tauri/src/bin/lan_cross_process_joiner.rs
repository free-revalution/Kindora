// Experiment A — Joiner binary.
//
// Verifies a single UDP exchange between two independent Rust
// processes on the same machine. This binary is **only** used by
// `scripts/run_unicast_test.sh` and does NOT participate in the
// production LAN transport.
//
// Lifecycle:
//   1. Parse CLI args: <local_udp_port> <peer_udp_port>
//   2. Bind UDP socket on local_udp_port.
//   3. Send "ready" datagram to host's UDP port.
//   4. Wait up to TIMEOUT_S for `lan_announce` from host.
//   5. Validate kind + agent_id (UUID v4) + protocol_version.
//   6. Send `lan_invite_ack` JSON to host.
//   7. Print exact "OK" line on stdout; exit 0.
//   8. Any failure: print to stderr; exit non-zero.

use std::env;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::process::ExitCode;
use std::time::{Duration, Instant};

const TIMEOUT_S: u64 = 8;
const PROTOCOL_VERSION: &str = "0.1";
const JOINER_AGENT_ID: &str = "aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee";

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!(
            "[joiner] FAIL: usage: {} <local_udp_port> <peer_udp_port>",
            args[0]
        );
        return ExitCode::from(2);
    }
    let local_port: u16 = match args[1].parse() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[joiner] FAIL: invalid local_udp_port: {}", e);
            return ExitCode::from(2);
        }
    };
    let peer_port: u16 = match args[2].parse() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[joiner] FAIL: invalid peer_udp_port: {}", e);
            return ExitCode::from(2);
        }
    };

    let local_addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, local_port));
    let socket = match UdpSocket::bind(local_addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[joiner] FAIL: bind {}: {}", local_addr, e);
            return ExitCode::from(3);
        }
    };
    if let Err(e) = socket.set_read_timeout(Some(Duration::from_secs(TIMEOUT_S))) {
        eprintln!("[joiner] FAIL: set_read_timeout: {}", e);
        return ExitCode::from(3);
    }
    let host_addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, peer_port));

    // Stage 1: send "ready" to host.
    if let Err(e) = socket.send_to(b"ready", host_addr) {
        eprintln!("[joiner] FAIL: send ready: {}", e);
        return ExitCode::from(4);
    }
    eprintln!("[joiner] sent 'ready' to {}", host_addr);

    // Stage 2: wait for `lan_announce` from host.
    let mut buf = [0u8; 4096];
    eprintln!("[joiner] waiting for 'lan_announce' ...");
    let deadline = Instant::now() + Duration::from_secs(TIMEOUT_S);
    let mut host_ip = Ipv4Addr::LOCALHOST;
    let mut host_udp_port = peer_port;
    let mut got_announce = false;
    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((n, src)) => {
                let text = std::str::from_utf8(&buf[..n]).unwrap_or("");
                let v: serde_json::Value = match serde_json::from_str(text) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[joiner] FAIL: parse announce json: {}", e);
                        return ExitCode::from(5);
                    }
                };
                let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
                if kind != "lan_announce" {
                    eprintln!("[joiner] FAIL: bad announce kind: {:?}", kind);
                    return ExitCode::from(5);
                }
                let agent_id = v.get("agent_id").and_then(|a| a.as_str()).unwrap_or("");
                if !is_uuid_v4(agent_id) {
                    eprintln!(
                        "[joiner] FAIL: announce agent_id not UUID v4: {:?}",
                        agent_id
                    );
                    return ExitCode::from(5);
                }
                let pv = v
                    .get("protocol_version")
                    .and_then(|p| p.as_str())
                    .unwrap_or("");
                if pv != PROTOCOL_VERSION {
                    eprintln!(
                        "[joiner] FAIL: announce protocol_version {:?} != {:?}",
                        pv, PROTOCOL_VERSION
                    );
                    return ExitCode::from(5);
                }
                host_ip = match src {
                    SocketAddr::V4(a) => *a.ip(),
                    SocketAddr::V6(_) => {
                        eprintln!("[joiner] FAIL: IPv6 source not supported");
                        return ExitCode::from(5);
                    }
                };
                host_udp_port = peer_port;
                got_announce = true;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => {
                eprintln!("[joiner] FAIL: recv announce: {}", e);
                return ExitCode::from(5);
            }
        }
    }
    if !got_announce {
        eprintln!("[joiner] FAIL: timed out waiting for lan_announce");
        return ExitCode::from(7);
    }
    eprintln!(
        "[joiner] got lan_announce from {}:{}",
        host_ip, host_udp_port
    );

    // Stage 3: send `lan_invite_ack` to host.
    let ack = serde_json::json!({
        "kind": "lan_invite_ack",
        "agent_id": JOINER_AGENT_ID,
        "protocol_version": PROTOCOL_VERSION,
    });
    let ack_bytes = match serde_json::to_vec(&ack) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[joiner] FAIL: serialize ack: {}", e);
            return ExitCode::from(6);
        }
    };
    let ack_dst = SocketAddr::V4(SocketAddrV4::new(host_ip, host_udp_port));
    if let Err(e) = socket.send_to(&ack_bytes, ack_dst) {
        eprintln!("[joiner] FAIL: send ack: {}", e);
        return ExitCode::from(6);
    }
    eprintln!("[joiner] sent lan_invite_ack to {}", ack_dst);

    println!("OK");
    eprintln!("[joiner] DONE");
    ExitCode::SUCCESS
}

fn is_uuid_v4(s: &str) -> bool {
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