// Experiment A — Host binary.
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
//   3. Wait up to TIMEOUT_S for the literal "ready" datagram.
//   4. Send `lan_announce` to peer.
//   5. Wait up to TIMEOUT_S for `lan_invite_ack`.
//   6. Validate kind + agent_id (UUID v4) + protocol_version.
//   7. Print exact "OK" line on stdout; exit 0.
//   8. Any failure: print to stderr; exit non-zero.
//
// Exit codes (single source of truth):
//   0   = success.
//   2   = usage / arg parse error.
//   3   = bind or set_read_timeout failure.
//   4   = recv "ready" failure (non-timeout) or wrong payload.
//   5   = serialize / send `lan_announce` failure.
//   6   = parse / validate / recv `lan_invite_ack` failure.
//   7   = recv timeout (ready or ack).

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

    // Stage 1: wait for "ready" — bounded by TIMEOUT_S.
    let mut buf = [0u8; 4096];
    eprintln!("[host] waiting for 'ready' on udp://{} ...", local_addr);
    let ready_deadline = Instant::now() + Duration::from_secs(TIMEOUT_S);
    let mut got_ready = false;
    let mut ready_src = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, peer_port));
    while Instant::now() < ready_deadline && !got_ready {
        match socket.recv_from(&mut buf) {
            Ok((n, src)) => {
                let ready_msg = std::str::from_utf8(&buf[..n]).unwrap_or("");
                if ready_msg.trim() != "ready" {
                    eprintln!("[host] FAIL: expected 'ready', got {:?}", ready_msg);
                    return ExitCode::from(4);
                }
                ready_src = src;
                got_ready = true;
            }
            // macOS reports EAGAIN as WouldBlock; Linux as TimedOut.
            // Both indicate "try again"; respect the deadline loop.
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                continue;
            }
            Err(e) => {
                eprintln!("[host] FAIL: recv ready: {}", e);
                return ExitCode::from(4);
            }
        }
    }
    if !got_ready {
        eprintln!("[host] FAIL: timed out waiting for 'ready'");
        return ExitCode::from(7);
    }
    eprintln!("[host] got 'ready' from {}", ready_src);

    // Stage 2: send `lan_announce` to peer.
    let announce = build_message("lan_announce", HOST_AGENT_ID, PROTOCOL_VERSION);
    let announce_dst = match ready_src {
        SocketAddr::V4(a) => SocketAddr::V4(SocketAddrV4::new(*a.ip(), peer_port)),
        SocketAddr::V6(_) => {
            eprintln!("[host] FAIL: IPv6 source not supported in experiment");
            return ExitCode::from(4);
        }
    };
    if let Err(e) = socket.send_to(announce.as_bytes(), announce_dst) {
        eprintln!("[host] FAIL: send announce: {}", e);
        return ExitCode::from(5);
    }
    eprintln!("[host] sent lan_announce to {}", announce_dst);

    // Stage 3: wait for `lan_invite_ack` — bounded by TIMEOUT_S.
    eprintln!("[host] waiting for 'lan_invite_ack' ...");
    let ack_deadline = Instant::now() + Duration::from_secs(TIMEOUT_S);
    let mut ack_ok = false;
    while Instant::now() < ack_deadline && !ack_ok {
        match socket.recv_from(&mut buf) {
            Ok((m, _)) => {
                let text = std::str::from_utf8(&buf[..m]).unwrap_or("");
                match parse_message(text) {
                    Ok(m) if m.kind == "lan_invite_ack" && m.protocol_version == PROTOCOL_VERSION && is_uuid_v4(&m.agent_id) => {
                        eprintln!("[host] valid lan_invite_ack agent_id={}", m.agent_id);
                        ack_ok = true;
                    }
                    Ok(m) => {
                        eprintln!(
                            "[host] FAIL: bad ack kind={:?} agent_id={:?} pv={:?}",
                            m.kind, m.agent_id, m.protocol_version
                        );
                        return ExitCode::from(6);
                    }
                    Err(e) => {
                        eprintln!("[host] FAIL: parse ack: {}", e);
                        return ExitCode::from(6);
                    }
                }
            }
            // macOS reports EAGAIN as WouldBlock; Linux as TimedOut.
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                continue;
            }
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

// ---- Wire protocol (key=value, NOT JSON) ----

struct Message {
    kind: String,
    agent_id: String,
    protocol_version: String,
}

fn build_message(kind: &str, agent_id: &str, protocol_version: &str) -> String {
    // Asserts guard against construction-time bugs.
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
    // [P1] byte-level constraints
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

    // [P2] strict 3-line split
    let lines: Vec<&str> = input.split('\n').collect();
    if lines.len() != 3 {
        return Err(format!("wrong_line_count:{}", lines.len()));
    }

    // [P3] field-order-aware parsing
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

    // [P4] field-level validation
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

#[cfg(test)]
mod tests {
    use super::*;

    const HOST_UUID: &str = "11111111-2222-4333-8444-555555555555";
    const JOINER_UUID: &str = "aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee";

    fn announce() -> &'static str {
        "kind=lan_announce\nagent_id=11111111-2222-4333-8444-555555555555\nprotocol_version=0.1"
    }

    fn ack() -> &'static str {
        "kind=lan_invite_ack\nagent_id=aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee\nprotocol_version=0.1"
    }

    #[test]
    fn positive_announce() {
        let m = parse_message(announce()).expect("announce should parse");
        assert_eq!(m.kind, "lan_announce");
        assert_eq!(m.agent_id, HOST_UUID);
        assert_eq!(m.protocol_version, "0.1");
    }

    #[test]
    fn positive_ack() {
        let m = parse_message(ack()).expect("ack should parse");
        assert_eq!(m.kind, "lan_invite_ack");
        assert_eq!(m.agent_id, JOINER_UUID);
    }

    #[test]
    fn positive_uuid_v4() {
        assert!(is_uuid_v4(HOST_UUID));
        assert!(is_uuid_v4(JOINER_UUID));
    }

    #[test]
    fn negative_uuid_not_v4() {
        // version digit not 4
        assert!(!is_uuid_v4("11111111-2222-3333-8444-555555555555"));
        // variant nibble not in {8,9,a,b}
        assert!(!is_uuid_v4("11111111-2222-4333-7444-555555555555"));
        // wrong shape
        assert!(!is_uuid_v4("11111111-2222-4333-8444"));
    }

    #[test]
    fn negative_protocol_version() {
        let s = "kind=lan_announce\nagent_id=11111111-2222-4333-8444-555555555555\nprotocol_version=0.2";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn negative_wrong_field_order() {
        let s = "kind=lan_announce\nprotocol_version=0.1\nagent_id=11111111-2222-4333-8444-555555555555";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn negative_missing_equals() {
        let s = "kindlan_announce\nagent_id=11111111-2222-4333-8444-555555555555\nprotocol_version=0.1";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn negative_empty_value() {
        let s = "kind=\nagent_id=11111111-2222-4333-8444-555555555555\nprotocol_version=0.1";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn negative_extra_field() {
        let s = "kind=lan_announce\nagent_id=11111111-2222-4333-8444-555555555555\nprotocol_version=0.1\nfoo=bar";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn negative_duplicate_field() {
        // second 'kind=' line breaks field order (line 3 != "protocol_version")
        let s = "kind=lan_announce\nkind=lan_invite_ack\nprotocol_version=0.1";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn negative_trailing_newline() {
        let s = "kind=lan_announce\nagent_id=11111111-2222-4333-8444-555555555555\nprotocol_version=0.1\n";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn negative_crlf() {
        let s = "kind=lan_announce\r\nagent_id=11111111-2222-4333-8444-555555555555\r\nprotocol_version=0.1";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn negative_non_ascii() {
        let s = "kind=lan_announce\u{00ff}\nagent_id=11111111-2222-4333-8444-555555555555\nprotocol_version=0.1";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn negative_control_char() {
        // U+0001 control char embedded
        let s = "kind=lan_announc\u{0001}e\nagent_id=11111111-2222-4333-8444-555555555555\nprotocol_version=0.1";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn negative_too_long() {
        // 4097 bytes
        let mut s = String::from("kind=lan_announce\nagent_id=11111111-2222-4333-8444-555555555555\nprotocol_version=0.1");
        while s.len() < 4097 {
            s.push('x');
        }
        assert!(parse_message(&s).is_err());
    }

    #[test]
    fn negative_kind_not_literal() {
        let s = "kind=lan_invite\nagent_id=11111111-2222-4333-8444-555555555555\nprotocol_version=0.1";
        assert!(parse_message(s).is_err());
    }

    #[test]
    fn roundtrip_build_then_parse() {
        let msg = build_message("lan_announce", HOST_UUID, PROTOCOL_VERSION);
        let m = parse_message(&msg).expect("roundtrip");
        assert_eq!(m.kind, "lan_announce");
        assert_eq!(m.agent_id, HOST_UUID);
    }
}