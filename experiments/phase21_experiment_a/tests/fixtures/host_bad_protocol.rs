// host_bad_protocol fixture — accepts "ready", then sends an illegal
// non-key=value payload (e.g. plain text "garbage") as the announce
// message. Used to verify the joiner rejects malformed input (T6).

use std::env;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::process::ExitCode;
use std::time::{Duration, Instant};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        return ExitCode::from(2);
    }
    let local_port: u16 = match args[1].parse() {
        Ok(p) => p,
        Err(_) => return ExitCode::from(2),
    };
    let peer_port: u16 = match args[2].parse() {
        Ok(p) => p,
        Err(_) => return ExitCode::from(2),
    };

    let local_addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, local_port));
    let socket = match UdpSocket::bind(local_addr) {
        Ok(s) => s,
        Err(_) => return ExitCode::from(3),
    };
    let _ = socket.set_read_timeout(Some(Duration::from_secs(8)));

    let mut buf = [0u8; 4096];
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut dst = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, peer_port));
    let mut received = false;
    while Instant::now() < deadline && !received {
        match socket.recv_from(&mut buf) {
            Ok((_, src)) => {
                dst = src;
                received = true;
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(_) => return ExitCode::from(4),
        }
    }
    if !received {
        return ExitCode::from(7);
    }

    // Send deliberately malformed bytes (no '=' anywhere).
    let bad = b"this is not key=value\nagent_id=z\nprotocol_version=0.1";
    let _ = socket.send_to(bad, dst);

    // Wait briefly so peer has time to react, then exit.
    std::thread::sleep(Duration::from_millis(500));
    ExitCode::SUCCESS
}