// host_silent fixture — binds host port and silently accepts "ready"
// datagrams but never sends a lan_announce. Used to verify the joiner
// exits via its own internal timeout (T2).
// Exit code 0 once peer closes or after 5s of silence.

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
    let _peer_port: u16 = match args[2].parse() {
        Ok(p) => p,
        Err(_) => return ExitCode::from(2),
    };

    let local_addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, local_port));
    let socket = match UdpSocket::bind(local_addr) {
        Ok(s) => s,
        Err(_) => return ExitCode::from(3),
    };
    let _ = socket.set_read_timeout(Some(Duration::from_secs(15)));

    let mut buf = [0u8; 4096];
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok(_) => {
                // consume but never reply
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                // After 15s, exit normally so the test harness can finish.
                return ExitCode::SUCCESS;
            }
            Err(_) => return ExitCode::from(4),
        }
    }
    ExitCode::SUCCESS
}