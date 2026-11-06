//! Phase C / C1 + C2 — LAN transport resource limits and abnormal-exit
//! handling.
//!
//! These tests drive the **production** `LanState` over real loopback
//! TCP sockets, but speak the wire protocol by hand so they can send
//! frames a well-behaved peer never would:
//!
//!   1. An oversized frame (length prefix above the limit) is
//!      rejected and the link is dropped — without allocating the body
//!      it claims.
//!   2. An invalid-UTF-8 body is rejected **and** the peer is reported
//!      as gone. This is the defect the task book calls out: the old
//!      code returned from the read loop without touching
//!      `peer_closed`, so the poll path reported a clean local
//!      teardown for a link a misbehaving peer had just dropped.
//!   3. A peer that floods past the message-rate limit is dropped.
//!   4. The host accepts a new peer after the previous one left
//!      (Phase C / C3: the old accept loop exited after the first
//!      connection and dropped the listener, so a second peer could
//!      never connect).
//!
//! Every test needs a UDP port for the discovery responder. They take
//! one port each from the 53200 range (see `BASE_TEST_UDP_PORT`) and
//! run with `-- --test-threads=1` (see CI), the same arrangement as
//! `lan_protocol_e2e.rs`.

use kindora_desktop_lib as kindora_lib;

use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

const LOOPBACK_BROADCAST: &str = "127.0.0.1";
// Distinct from lan_e2e.rs (53000), lan_protocol_e2e.rs (53100) and
// production (52419). Each test takes the next port in the range, so
// two LanState instances can never bind the same UDP socket.
const BASE_TEST_UDP_PORT: u16 = 53200;

static NEXT_TEST_PORT: std::sync::atomic::AtomicU16 =
    std::sync::atomic::AtomicU16::new(BASE_TEST_UDP_PORT);

fn next_test_port() -> u16 {
    NEXT_TEST_PORT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

fn fresh_state() -> kindora_lib::LanState {
    let state = kindora_lib::LanState::new();
    state.set_broadcast_addr(LOOPBACK_BROADCAST.to_string());
    state.set_udp_bind_addr(LOOPBACK_BROADCAST.to_string());
    state.set_udp_port(next_test_port());
    state
}

/// Start a host and return its listening info.
async fn start_host(state: &kindora_lib::LanState) -> kindora_lib::HostInfo {
    state
        .host_start(
            "ABCDEF".to_string(),
            "11111111-1111-4111-8111-111111111111".to_string(),
            "Host".to_string(),
        )
        .await
        .expect("host_start")
}

/// Wait until the host has accepted a connection.
async fn wait_linked(state: &kindora_lib::LanState) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if state.host_linked().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the host never reported a linked peer");
}

/// Poll the host until it reports the link as gone, and return the
/// error it reported.
///
/// This is the observable form of "the read loop noticed the peer is
/// gone": before Phase C / C2 an invalid-UTF-8 body left
/// `peer_closed` unset, so `host_poll` returned `Ok(vec![])` forever
/// and this helper would time out.
///
/// The *variant* matters too — C2 § 5 requires the frontend to receive
/// an explicit reason, so the caller asserts which reason it got.
async fn wait_closed(state: &kindora_lib::LanState) -> kindora_lib::LanError {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match state.host_poll().await {
            Err(e) => return e,
            Ok(_) => {
                if Instant::now() >= deadline {
                    panic!("host_poll never reported the link as closed");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
}

/// Poll the host until it has received a message containing `needle`.
async fn wait_for_message(state: &kindora_lib::LanState, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let messages = state.host_poll().await.unwrap_or_else(|_| Vec::new());
        if messages.iter().any(|m| m.contains(needle)) {
            return;
        }
        if Instant::now() >= deadline {
            panic!("the host never received a message containing {needle}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Write one length-prefixed frame.
async fn write_frame(stream: &mut TcpStream, body: &[u8]) {
    stream
        .write_all(&(body.len() as u32).to_be_bytes())
        .await
        .expect("write length prefix");
    stream.write_all(body).await.expect("write body");
    stream.flush().await.expect("flush");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn oversized_frame_is_rejected_and_drops_the_link() {
    let state = fresh_state();
    let info = start_host(&state).await;

    let mut stream = TcpStream::connect(("127.0.0.1", info.tcp_port))
        .await
        .expect("connect to host");
    wait_linked(&state).await;

    // Announce a frame far above the 1 MiB limit. The read loop must
    // reject it on the length prefix alone — it must not reserve the
    // memory the peer claims.
    let claimed = 32u32 * 1024 * 1024;
    stream
        .write_all(&claimed.to_be_bytes())
        .await
        .expect("write length prefix");
    stream.flush().await.expect("flush");

    let err = wait_closed(&state).await;
    assert!(
        matches!(err, kindora_lib::LanError::LimitExceeded(_)),
        "expected LimitExceeded, got: {err}"
    );
    state.host_stop().await.expect("host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalid_utf8_body_marks_the_peer_closed() {
    let state = fresh_state();
    let info = start_host(&state).await;

    let mut stream = TcpStream::connect(("127.0.0.1", info.tcp_port))
        .await
        .expect("connect to host");
    wait_linked(&state).await;

    // A frame whose body is not valid UTF-8. Phase C / C2: the peer
    // must be reported as gone — with the reason attached — not as a
    // clean local teardown.
    let body: [u8; 3] = [0xff, 0xfe, 0xfd];
    write_frame(&mut stream, &body).await;

    let err = wait_closed(&state).await;
    assert!(
        matches!(err, kindora_lib::LanError::Invalid(_)),
        "expected Invalid, got: {err}"
    );
    state.host_stop().await.expect("host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn flooding_past_the_rate_limit_drops_the_link() {
    let state = fresh_state();
    let info = start_host(&state).await;

    let mut stream = TcpStream::connect(("127.0.0.1", info.tcp_port))
        .await
        .expect("connect to host");
    wait_linked(&state).await;

    // The rate limit is 50 messages per second per connection. Send a
    // burst well past it; the messages are tiny, so they all land in
    // the same one-second window.
    let body = b"{\"n\":1}";
    for _ in 0..200 {
        stream
            .write_all(&(body.len() as u32).to_be_bytes())
            .await
            .expect("write length prefix");
        stream.write_all(body).await.expect("write body");
    }
    stream.flush().await.expect("flush");

    let err = wait_closed(&state).await;
    assert!(
        matches!(err, kindora_lib::LanError::LimitExceeded(_)),
        "expected LimitExceeded, got: {err}"
    );
    state.host_stop().await.expect("host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_accepts_a_new_peer_after_the_first_one_leaves() {
    let state = fresh_state();
    let info = start_host(&state).await;

    // The first peer connects, proves the link works, and leaves.
    {
        let mut first = TcpStream::connect(("127.0.0.1", info.tcp_port))
            .await
            .expect("connect first peer");
        wait_linked(&state).await;
        write_frame(&mut first, b"{\"first\":true}").await;
        wait_for_message(&state, "first").await;
        // The peer goes away.
        drop(first);
    }

    // The host must notice and release the connection slot. A peer
    // that simply left has no specific reason — just `PeerClosed`.
    let err = wait_closed(&state).await;
    assert!(
        matches!(err, kindora_lib::LanError::PeerClosed),
        "expected PeerClosed, got: {err}"
    );
    // The accept loop frees the slot a moment after the read loop
    // returns; give it a beat so the reconnect is not racing it.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The second peer connects. Under the old accept loop — which
    // exited after the first connection and dropped the listener —
    // this connect was impossible.
    let mut second = TcpStream::connect(("127.0.0.1", info.tcp_port))
        .await
        .expect("connect second peer");
    write_frame(&mut second, b"{\"second\":true}").await;
    wait_for_message(&state, "second").await;

    state.host_stop().await.expect("host_stop");
}
