// host_sleep_forever fixture — never exits voluntarily. Used to verify
// the script's watchdog terminates an uncooperative child (T8).

use std::env;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::process::ExitCode;

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
    let _ = UdpSocket::bind(SocketAddr::V4(SocketAddrV4::new(
        Ipv4Addr::UNSPECIFIED,
        local_port,
    )));
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}