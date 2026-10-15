//! End-to-end integration test for the LAN transport module.
//!
//! Exercises the production `LanState` end-to-end without mocking:
//!   - real tokio runtime
//!   - real UDP discovery (via a configurable broadcast address;
//!     tests use 127.0.0.1 because the loopback interface on macOS
//!     has no real broadcast address)
//!   - real TCP connection (loopback)
//!   - real length-prefixed JSON framing
//!
//! This complements the `lan-transport.test.ts` TypeScript test, which
//! covers the JS shim and the message-handler state machine. Here we
//! prove that the Rust side actually hands the link to `HostSide`,
//! that `host_linked()` reflects reality, that envelopes flow
//! bidirectionally, and that disconnect cleans up the TCP task and
//! UDP listener.
//!
//! Each test uses a fresh `LanState` so they don't share state.

use kindora_desktop_lib as kindora_lib;

use std::time::Duration;

const LOOPBACK_BROADCAST: &str = "127.0.0.1";
const BASE_TEST_UDP_PORT: u16 = 53000; // distinct from prod 52419

static NEXT_TEST_PORT: std::sync::atomic::AtomicU16 =
    std::sync::atomic::AtomicU16::new(BASE_TEST_UDP_PORT);

fn next_test_port() -> u16 {
    NEXT_TEST_PORT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

fn fresh_state() -> kindora_lib::LanState {
    // `rt-multi-thread` runtime is set by the `#[tokio::test]` macro;
    // the helper exists so every test gets a clean LanState.
    let state = kindora_lib::LanState::new();
    // On the macOS / Linux loopback used by CI, the universal broadcast
    // address 255.255.255.255 is not routable, so the integration test
    // points the joiner at 127.0.0.1 and binds the host's UDP socket
    // to 127.0.0.1 too. Each test gets a unique UDP port so multiple
    // LanState instances can coexist without binding conflicts. The
    // host still accepts a real TCP dial from any interface. This is
    // a documented test-only override — production uses 255.255.255.255
    // and binds 0.0.0.0:52419.
    state.set_broadcast_addr(LOOPBACK_BROADCAST.to_string());
    state.set_udp_bind_addr(LOOPBACK_BROADCAST.to_string());
    state.set_udp_port(next_test_port());
    state
}

/// Drive host_start, then wait for `host_linked` to flip true.
async fn wait_linked(state: &kindora_lib::LanState, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if state.host_linked().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

/// Poll inbox until at least one envelope arrives or timeout.
async fn wait_envelope(
    state: &kindora_lib::LanState,
    role: HostOrJoin,
    timeout: Duration,
) -> Vec<String> {
    let start = std::time::Instant::now();
    let mut all = Vec::new();
    while start.elapsed() < timeout {
        let got = match role {
            HostOrJoin::Host => state.host_poll().await.unwrap_or_default(),
            HostOrJoin::Join => state.join_poll().await.unwrap_or_default(),
        };
        all.extend(got);
        if !all.is_empty() {
            return all;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    all
}

#[derive(Copy, Clone)]
enum HostOrJoin {
    Host,
    Join,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_linked_flips_true_after_joiner_connects() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    let code = "TESTCD".to_string();
    let host_agent = "11111111-2222-4333-8444-555555555555".to_string();
    let host_display = "Host".to_string();

    let info = state
        .host_start(code.clone(), host_agent.clone(), host_display.clone())
        .await
        .expect("host_start");
    assert_eq!(info.code, code);
    assert!(!state.host_linked().await, "should not be linked before peer");

    // Spawn a joiner that discovers and dials.
    let join_state = state.clone();
    let joiner_handle = tokio::spawn(async move {
        let peers = join_state
            .join_discover(code.clone(), 3000)
            .await
            .expect("discover");
        assert!(!peers.is_empty(), "joiner should find at least one host");
        join_state
            .join_connect(peers[0].ip.clone(), peers[0].port)
            .await
            .expect("join_connect");
    });

    let linked = wait_linked(&state, Duration::from_secs(5)).await;
    joiner_handle.await.expect("joiner task");
    assert!(linked, "host_linked() should be true after joiner dials");

    // Cleanup
    state.host_stop().await.expect("host_stop");
    state.join_disconnect().await.expect("join_disconnect");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bidirectional_envelope_exchange() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    let code = "BIDI01".to_string();

    let _info = state
        .host_start(code.clone(), "agent-host".into(), "HostDisplay".into())
        .await
        .expect("host_start");

    // Joiner
    let peers = state.join_discover(code.clone(), 3000).await.expect("discover");
    let peer = peers.first().expect("at least one peer").clone();
    state.join_connect(peer.ip.clone(), peer.port).await.expect("join_connect");

    wait_linked(&state, Duration::from_secs(5)).await;

    // Host sends an envelope.
    let host_msg = r#"{"type":"hello","sender":"agent-host","payload":{"displayName":"HostDisplay"}}"#;
    state.host_send(host_msg.to_string()).await.expect("host_send");

    // Joiner should receive it.
    let got_joiner = wait_envelope(&state, HostOrJoin::Join, Duration::from_secs(2)).await;
    assert!(
        got_joiner.iter().any(|s| s.contains("agent-host")),
        "joiner should receive the host's envelope; got: {:?}",
        got_joiner
    );

    // Joiner sends an envelope.
    let joiner_msg = r#"{"type":"hello","sender":"agent-joiner","payload":{"displayName":"JoinerDisplay"}}"#;
    state.join_send(joiner_msg.to_string()).await.expect("join_send");

    // Host should receive it.
    let got_host = wait_envelope(&state, HostOrJoin::Host, Duration::from_secs(2)).await;
    assert!(
        got_host.iter().any(|s| s.contains("agent-joiner")),
        "host should receive the joiner's envelope; got: {:?}",
        got_host
    );

    state.host_stop().await.expect("host_stop");
    state.join_disconnect().await.expect("join_disconnect");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_linked_becomes_false_after_stop() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    let code = "STOP01".to_string();
    state
        .host_start(code.clone(), "agent-host".into(), "HostDisplay".into())
        .await
        .expect("host_start");

    state.host_stop().await.expect("host_stop");
    assert!(
        !state.host_linked().await,
        "host_linked should be false after host_stop"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_stop_before_peer_works() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    state
        .host_start("PRE00".into(), "agent-host".into(), "HostDisplay".into())
        .await
        .expect("host_start");
    // No peer ever connected. host_stop must still succeed cleanly.
    state.host_stop().await.expect("host_stop with no peer");
    // host_start a second time should now succeed.
    let info2 = state
        .host_start("PRE01".into(), "agent-host".into(), "HostDisplay".into())
        .await
        .expect("host_start after stop");
    assert_eq!(info2.code, "PRE01");
    state.host_stop().await.expect("cleanup host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_double_start_is_rejected() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    state
        .host_start("TWICE".into(), "agent-host".into(), "HostDisplay".into())
        .await
        .expect("first host_start");
    let err = state
        .host_start("TWICE".into(), "agent-host".into(), "HostDisplay".into())
        .await
        .expect_err("second host_start must fail");
    let msg = err.to_string();
    assert!(
        msg.contains("already running"),
        "expected 'already running' error, got: {msg}"
    );
    state.host_stop().await.expect("host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn join_with_no_host_returns_empty() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    let peers = state
        .join_discover("NOPENO".into(), 500)
        .await
        .expect("discover");
    assert!(peers.is_empty(), "no host is running; expect empty list");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discover_filters_by_code() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state_a = fresh_state();
    let state_b = fresh_state();

    // Host A listens for code "CODE-AA".
    state_a
        .host_start("CODEAA".into(), "agent-a".into(), "A".into())
        .await
        .expect("host_a");
    // Host B listens for code "CODE-BB".
    state_b
        .host_start("CODEBB".into(), "agent-b".into(), "B".into())
        .await
        .expect("host_b");

    // Joiner looking for "CODEAA" should only see host A.
    let got_a = state_a
        .join_discover("CODEAA".into(), 1500)
        .await
        .expect("discover A");
    assert_eq!(got_a.len(), 1, "discover for CODEAA should match exactly one host");
    assert_eq!(got_a[0].agent_id, "agent-a");

    // Joiner looking for "CODEBB" should only see host B.
    let got_b = state_b
        .join_discover("CODEBB".into(), 1500)
        .await
        .expect("discover B");
    assert_eq!(got_b.len(), 1, "discover for CODEBB should match exactly one host");
    assert_eq!(got_b[0].agent_id, "agent-b");

    // Joiner looking for an unknown code should see nothing.
    let got_none = state_a
        .join_discover("ZZZZZZ".into(), 800)
        .await
        .expect("discover none");
    assert!(got_none.is_empty(), "discover for unknown code should be empty");

    state_a.host_stop().await.expect("stop a");
    state_b.host_stop().await.expect("stop b");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn multiple_envelopes_preserve_order() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    let code = "ORDER".to_string();
    state
        .host_start(code.clone(), "agent-host".into(), "HostDisplay".into())
        .await
        .expect("host_start");

    let peers = state.join_discover(code.clone(), 3000).await.expect("discover");
    state
        .join_connect(peers[0].ip.clone(), peers[0].port)
        .await
        .expect("join_connect");
    wait_linked(&state, Duration::from_secs(5)).await;

    // Host sends 5 envelopes in order.
    for i in 0..5 {
        let msg = format!(r#"{{"type":"chat","i":{i}}}"#);
        state.host_send(msg).await.expect("host_send");
    }

    // Drain joiner's inbox; expect 5 envelopes in order.
    let mut received: Vec<String> = Vec::new();
    let start = std::time::Instant::now();
    while received.len() < 5 && start.elapsed() < Duration::from_secs(2) {
        let got = state.join_poll().await.unwrap_or_default();
        received.extend(got);
        if received.len() < 5 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    assert_eq!(received.len(), 5, "joiner should receive 5 envelopes");
    for (i, env) in received.iter().enumerate() {
        let expected = format!(r#""i":{i}"#);
        assert!(
            env.contains(&expected),
            "envelope #{i} out of order: expected to contain {expected:?}, got {env:?}"
        );
    }

    state.host_stop().await.expect("host_stop");
    state.join_disconnect().await.expect("join_disconnect");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_refuses_unknown_code_during_discovery() {
    // Discover broadcasts the typed code; hosts with a different code
    // should NOT announce themselves. This verifies the matching is
    // by code, not just by presence.
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    state
        .host_start("REALCD".into(), "agent-real".into(), "Real".into())
        .await
        .expect("host_start");

    let peers = state
        .join_discover("FAKECD".into(), 1000)
        .await
        .expect("discover");
    assert!(
        peers.is_empty(),
        "host with code REALCD must not respond to discover for FAKECD; got: {:?}",
        peers
    );

    state.host_stop().await.expect("host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_poll_returns_empty_when_no_peer() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    state
        .host_start("NOPOLL".into(), "agent-host".into(), "H".into())
        .await
        .expect("host_start");
    // No peer ever connected. host_poll must not error and must not block.
    let got = state.host_poll().await.expect("host_poll");
    assert!(got.is_empty(), "no link → empty poll: got {:?}", got);
    state.host_stop().await.expect("host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_send_without_link_returns_not_connected() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    state
        .host_start("NOLINK".into(), "agent-host".into(), "H".into())
        .await
        .expect("host_start");
    // No link yet — host_send must return NotConnected, not panic.
    let err = state
        .host_send("nope".into())
        .await
        .expect_err("host_send without link must fail");
    let msg = err.to_string();
    assert!(
        msg.contains("not connected"),
        "expected 'not connected' error, got: {msg}"
    );
    state.host_stop().await.expect("host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn join_double_connect_is_rejected() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    state
        .host_start("JOIN1".into(), "agent-host".into(), "H".into())
        .await
        .expect("host_start");
    let peers = state
        .join_discover("JOIN1".into(), 3000)
        .await
        .expect("discover");
    state
        .join_connect(peers[0].ip.clone(), peers[0].port)
        .await
        .expect("first join_connect");
    let err = state
        .join_connect(peers[0].ip.clone(), peers[0].port)
        .await
        .expect_err("second join_connect must fail");
    let msg = err.to_string();
    assert!(
        msg.contains("already running"),
        "expected 'already running' error, got: {msg}"
    );
    state.host_stop().await.expect("host_stop");
    state.join_disconnect().await.expect("join_disconnect");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn join_poll_after_disconnect_returns_error() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    state
        .host_start("JDISC".into(), "agent-host".into(), "H".into())
        .await
        .expect("host_start");
    let peers = state
        .join_discover("JDISC".into(), 3000)
        .await
        .expect("discover");
    state
        .join_connect(peers[0].ip.clone(), peers[0].port)
        .await
        .expect("join_connect");
    state.join_disconnect().await.expect("disconnect");
    let err = state
        .join_poll()
        .await
        .expect_err("join_poll after disconnect must fail");
    assert!(err.to_string().contains("not connected"));
    state.host_stop().await.expect("host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_status_reflects_code() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    let info = state
        .host_start("STAT00".into(), "agent-host".into(), "H".into())
        .await
        .expect("host_start");
    let status = state.host_status().await.expect("host_status").expect("some");
    assert_eq!(status.code, info.code);
    assert_eq!(status.tcp_port, info.tcp_port);
    state.host_stop().await.expect("host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_status_empty_after_stop() {
    let _ = env_logger::builder().is_test(true).try_init();
    let state = fresh_state();
    state
        .host_start("STATO2".into(), "agent-host".into(), "H".into())
        .await
        .expect("host_start");
    state.host_stop().await.expect("host_stop");
    let status = state.host_status().await.expect("host_status");
    assert!(status.is_none(), "host_status should be None after stop");
}
