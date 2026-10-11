// host_ignore_term fixture — never exits voluntarily AND ignores SIGTERM.
// Used to verify that the script's watchdog correctly escalates to SIGKILL
// when an uncooperative child refuses to honour SIGTERM.
//
// This proves the TERM->KILL grace-window path end-to-end. The simpler
// `host_sleep_forever` fixture accepts SIGTERM by default, so its
// rc=143 only proves TERM works — not the upgrade logic.
//
// Implementation note: pure std (no signal-hook crate). We install an
// empty handler for SIGTERM via libc::signal which writes a no-op
// function pointer. SIGKILL/SIGSTOP are unblockable by the kernel and
// cannot be ignored, so the watchdog's KILL will still terminate us.

use std::env;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::process::ExitCode;

extern "C" {
    fn signal(signum: i32, handler: usize) -> usize;
}

const SIG_IGN: usize = 1; // POSIX: SIG_IGN = (void (*)())1 on macOS/Linux
const SIGTERM_NUM: i32 = 15;

#[inline]
fn ignore_sigterm() {
    // SAFETY: signal() is async-signal-safe. We only install SIG_IGN,
    // never SIG_DFL, never a custom handler.
    unsafe {
        signal(SIGTERM_NUM, SIG_IGN);
    }
}

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

    ignore_sigterm();

    let _ = UdpSocket::bind(SocketAddr::V4(SocketAddrV4::new(
        Ipv4Addr::UNSPECIFIED,
        local_port,
    )));
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}