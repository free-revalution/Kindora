// joiner_silent fixture — binds joiner port and silently accepts UDP
// datagrams but never sends "ready". Used to verify the host exits via
// its own internal timeout (T3).
// Exit code 0 once 15s elapse or peer closes.

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
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                return ExitCode::SUCCESS;
            }
            Err(_) => return ExitCode::from(4),
        }
    }
    ExitCode::SUCCESS
}