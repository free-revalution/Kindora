// Experiment A — Joiner binary.
//
// Verifies a single UDP exchange between two independent Rust
// processes on the same machine. This binary is **only** used by
// `scripts/run_unicast_test.sh` and does NOT participate in the
// production LAN transport.
//
// Wire protocol (restricted key=value, NOT JSON):
//   kind=<kind>
//   agent_id=<uuid-v4>
//   protocol_version=<pv>
//
// Lifecycle:
//   1. Parse CLI args: <local_udp_port> <peer_udp_port>.
//   2. Bind UDP socket on local_udp_port.
//   3. Send "ready" datagram to host's UDP port.
//   4. Wait up to TIMEOUT_S for `lan_announce` from host.
//   5. Validate kind + agent_id (UUID v4) + protocol_version.
//   6. Send `lan_invite_ack` to host.
//   7. Print exact "OK" line on stdout; exit 0.
//   8. Any failure: print to stderr; exit non-zero.
//
// Exit codes (single source of truth):
//   0   = success.
//   2   = usage / arg parse error.
//   3   = bind or set_read_timeout failure.
//   4   = send "ready" failure.
//   5   = parse / validate / recv `lan_announce` failure.
//   6   = serialize / send `lan_invite_ack` failure.
//   7   = recv timeout (announce).

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
    let mut got_announce = false;
    while Instant::now() < deadline && !got_announce {
        match socket.recv_from(&mut buf) {
            Ok((n, src)) => {
                let text = std::str::from_utf8(&buf[..n]).unwrap_or("");
                match parse_message(text) {
                    Ok(m) if m.kind == "lan_announce" && m.protocol_version == PROTOCOL_VERSION && is_uuid_v4(&m.agent_id) => {
                        host_ip = match src {
                            SocketAddr::V4(a) => *a.ip(),
                            SocketAddr::V6(_) => {
                                eprintln!("[joiner] FAIL: IPv6 source not supported");
                                return ExitCode::from(5);
                            }
                        };
                        eprintln!("[joiner] valid lan_announce agent_id={} from {}", m.agent_id, src);
                        got_announce = true;
                    }
                    Ok(m) => {
                        eprintln!(
                            "[joiner] FAIL: bad announce kind={:?} agent_id={:?} pv={:?}",
                            m.kind, m.agent_id, m.protocol_version
                        );
                        return ExitCode::from(5);
                    }
                    Err(e) => {
                        eprintln!("[joiner] FAIL: parse announce: {}", e);
                        return ExitCode::from(5);
                    }
                }
            }
            // macOS reports EAGAIN as WouldBlock (errno 35); Linux as TimedOut.
            // Both indicate "try again"; respect the deadline loop.
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                continue;
            }
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

    // Stage 3: send `lan_invite_ack` to host.
    let ack = build_message("lan_invite_ack", JOINER_AGENT_ID, PROTOCOL_VERSION);
    let ack_dst = SocketAddr::V4(SocketAddrV4::new(host_ip, peer_port));
    if let Err(e) = socket.send_to(ack.as_bytes(), ack_dst) {
        eprintln!("[joiner] FAIL: send ack: {}", e);
        return ExitCode::from(6);
    }
    eprintln!("[joiner] sent lan_invite_ack to {}", ack_dst);

    println!("OK");
    eprintln!("[joiner] DONE");
    ExitCode::SUCCESS
}

// ---- Wire protocol (key=value, NOT JSON) ----

struct Message {
    kind: String,
    agent_id: String,
    protocol_version: String,
}

fn build_message(kind: &str, agent_id: &str, protocol_version: &str) -> String {
    assert!(
        kind.chars().all(is_valid_value_char),
        "kind contains invalid char: {:?}",
        kind
    );
    assert!(
        agent_id.chars().all(is_valid_value_char),
        "agent_id contains invalid char: {:?}",
        agent_id
    );
    assert!(
        protocol_version.chars().all(is_valid_value_char),
        "protocol_version contains invalid char: {:?}",
        protocol_version
    );
    format!(
        "kind={}\nagent_id={}\nprotocol_version={}",
        kind, agent_id, protocol_version
    )
}

fn parse_message(input: &str) -> Result<Message, String> {
    if input.is_empty() {
        return Err("empty".into());
    }
    if input.len() > 4096 {
        return Err("too_long".into());
    }
    if !input.is_ascii() {
        return Err("non_ascii".into());
    }
    for b in input.bytes() {
        if b == b'\r' {
            return Err("cr_forbidden".into());
        }
        if b == b'\\' {
            return Err("escape_forbidden".into());
        }
        if b == b'"' {
            return Err("quote_forbidden".into());
        }
        if b == b'\t' {
            return Err("tab_forbidden".into());
        }
        if b == 0 {
            return Err("null_forbidden".into());
        }
        if b < 0x20 && b != b'\n' {
            return Err("control_char_forbidden".into());
        }
    }
    if input.ends_with('\n') {
        return Err("trailing_newline".into());
    }

    let lines: Vec<&str> = input.split('\n').collect();
    if lines.len() != 3 {
        return Err(format!("wrong_line_count:{}", lines.len()));
    }

    let expected = ["kind", "agent_id", "protocol_version"];
    let mut kind: Option<String> = None;
    let mut agent_id: Option<String> = None;
    let mut protocol_version: Option<String> = None;

    for (i, line) in lines.iter().enumerate() {
        let eq = match line.find('=') {
            Some(p) => p,
            None => return Err("missing_equals".into()),
        };
        let key = &line[..eq];
        let value = &line[eq + 1..];

        if key != expected[i] {
            return Err(format!("wrong_field_order:{}:{}", i, key));
        }
        if key.is_empty() || !key.chars().all(is_valid_key_char) {
            return Err("bad_key_char".into());
        }
        if value.is_empty() {
            return Err("value_empty".into());
        }
        if !value.chars().all(is_valid_value_char) {
            return Err("bad_value_char".into());
        }

        match i {
            0 => kind = Some(value.to_string()),
            1 => agent_id = Some(value.to_string()),
            2 => protocol_version = Some(value.to_string()),
            _ => unreachable!(),
        }
    }

    let kind = kind.ok_or_else(|| "missing_kind".to_string())?;
    let agent_id = agent_id.ok_or_else(|| "missing_agent_id".to_string())?;
    let protocol_version = protocol_version.ok_or_else(|| "missing_protocol_version".to_string())?;

    if kind != "lan_announce" && kind != "lan_invite_ack" {
        return Err(format!("kind_not_literal:{}", kind));
    }
    if !is_uuid_v4(&agent_id) {
        return Err(format!("agent_id_not_uuid_v4:{}", agent_id));
    }
    if protocol_version != "0.1" {
        return Err(format!("protocol_version_not_literal:{}", protocol_version));
    }

    Ok(Message {
        kind,
        agent_id,
        protocol_version,
    })
}

fn is_valid_key_char(c: char) -> bool {
    // Keys in this experiment are exactly "kind", "agent_id", "protocol_version".
    // Allow ASCII alphanumeric plus '_' (for snake_case keys), '.', '-'.
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'
}

fn is_valid_value_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'
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