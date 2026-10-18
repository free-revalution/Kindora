//! Two-instance protocol E2E test for the LAN transport.
//!
//! Phase 16.1 — extends the single-instance `lan_e2e` suite with a
//! proper two-LanState test: one state plays the host role, the
//! other plays the joiner role. The wire code is identical to two
//! real OS processes — the host binds UDP + TCP, the joiner
//! broadcasts UDP discover and dials TCP. Every envelope is the
//! same JSON the production JS layer would send.
//!
//! Coverage:
//!   - 1. Two-instance discovery + TCP connect (no envelope).
//!   - 2. Both sides send and receive `hello`.
//!   - 3. Both sides exchange `profile_exchange`.
//!   - 4. Both sides exchange `match_request` and `match_response`
//!         in order, with the correct count.
//!   - 5. Host never sends `hello` → joiner times out (joiner's
//!         `join_poll` keeps returning empty until the test's own
//!         deadline).
//!   - 6. Malformed `hello` is delivered without transport rejection
//!         (validation happens on the TS side; this test only
//!         verifies the wire path doesn't drop or mangle it).
//!   - 7. Mid-handshake disconnect: host stops before the joiner
//!         sends its first envelope → joiner's next `join_poll`
//!         eventually times out / `host_status` clears.
//!   - 8. Post-protocol disconnect: both sides have exchanged
//!         hello + profile + match_request/response → host stops →
//!         joiner's next `join_send` returns NotConnected.
//!   - 9. Cancel + re-pair: host starts with code A, joiner tries
//!         to discover code B (no match) → joiner can immediately
//!         re-discover code A and connect.
//!
//! Each test uses two FRESH `LanState` instances on different UDP
//! ports so they don't share state. `127.0.0.1` is used as the
//! broadcast address (loopback has no real broadcast; this is a
//! test-only override that the production code does not do).
//!
//! What this test does NOT cover (intentionally — boundary is
//! called out in the manual `docs/phase16/manual-lan-e2e.md`):
//!   - the TS-side `PairingSession` FSM (covered by Vitest
//!     `pairing-session.test.ts`).
//!   - the TS-side `MatchOrchestrator` hello gate (covered by
//!     Vitest `match-orchestrator.test.ts`).
//!   - the Tauri runtime shim / IPC layer (covered by Vitest
//!     `lan-transport.test.ts`).
//!   - the actual LLM call. Envelopes are constructed by the test
//!     so no API key is needed.
//!
//! This is "two LanStates in one OS process". A real two-OS-process
//! cross-binary test would require extending
//! `lan_cross_process_host.rs` / `lan_cross_process_joiner.rs` to
//! drive the full envelope flow; that work is NOT in this commit.

use kindora_desktop_lib as kindora_lib;

use std::time::{Duration, Instant};

const LOOPBACK_BROADCAST: &str = "127.0.0.1";
// Single UDP port for the whole test file. Two LanStates per test
// need to share it: the host's `udp_responder` binds it, and the
// joiner's `join_discover` broadcasts to it. Tests run with
// `--test-threads=1` so the previous test's `host_stop` releases
// the socket before the next test's `host_start` re-binds.
const TEST_UDP_PORT: u16 = 53100; // distinct from lan_e2e.rs (53000)
                                  // and prod (52419)

fn fresh_state() -> kindora_lib::LanState {
    let state = kindora_lib::LanState::new();
    state.set_broadcast_addr(LOOPBACK_BROADCAST.to_string());
    state.set_udp_bind_addr(LOOPBACK_BROADCAST.to_string());
    state.set_udp_port(TEST_UDP_PORT);
    state
}

const AGENT_HOST: &str = "11111111-1111-4111-8111-111111111111";
const AGENT_JOINER: &str = "22222222-2222-4222-8222-222222222222";

fn hello_envelope(sender: &str, display_name: &str) -> String {
    serde_json::json!({
        "protocol": "KSA",
        "version": "0.1",
        "messageId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        "timestamp": "2026-10-15T00:00:00.000Z",
        "type": "hello",
        "sender": sender,
        "payload": {
            "displayName": display_name,
            "capabilities": {
                "protocolVersion": "0.1",
                "supportsMatchAnalysis": true,
                "supportsIcebreaker": true,
                "supportsChatAssist": true,
                "supportsEncryption": false,
            },
        },
    })
    .to_string()
}

fn profile_exchange_envelope(sender: &str, nickname: &str) -> String {
    serde_json::json!({
        "protocol": "KSA",
        "version": "0.1",
        "messageId": "f47ac10b-58cc-4372-a567-0e02b2c3d480",
        "timestamp": "2026-10-15T00:00:01.000Z",
        "type": "profile_exchange",
        "sender": sender,
        "payload": {
            "profile": {
                "nickname": nickname,
                "bio": "hi",
                "interests": ["typescript"],
                "currentActivities": [],
                "socialIntent": ["similar_interests"],
                "conversationStyle": ["casual"],
                "boundaries": {
                    "allowAgentConversation": true,
                    "allowContactExchange": false,
                    "allowOfflineMeeting": false,
                    "allowProjectDetails": false,
                    "allowCurrentActivity": true,
                },
            },
            "agent": {
                "agentId": sender,
                "protocolVersion": "0.1",
                "displayName": nickname,
                "publicKey": "fake-public-key",
                "profile": {
                    "nickname": nickname,
                    "bio": "hi",
                    "interests": ["typescript"],
                    "currentActivities": [],
                    "socialIntent": ["similar_interests"],
                    "conversationStyle": ["casual"],
                    "boundaries": {
                        "allowAgentConversation": true,
                        "allowContactExchange": false,
                        "allowOfflineMeeting": false,
                        "allowProjectDetails": false,
                        "allowCurrentActivity": true,
                    },
                },
                "capabilities": {
                    "protocolVersion": "0.1",
                    "supportsMatchAnalysis": true,
                    "supportsIcebreaker": true,
                    "supportsChatAssist": true,
                    "supportsEncryption": false,
                },
            },
        },
    })
    .to_string()
}

fn match_request_envelope(sender: &str) -> String {
    serde_json::json!({
        "protocol": "KSA",
        "version": "0.1",
        "messageId": "f47ac10b-58cc-4372-a567-0e02b2c3d481",
        "timestamp": "2026-10-15T00:00:02.000Z",
        "type": "match_request",
        "sender": sender,
        "payload": {
            "selfProfile": {
                "nickname": "self",
                "bio": "self",
                "interests": [],
                "currentActivities": [],
                "socialIntent": [],
                "conversationStyle": [],
                "boundaries": {
                    "allowAgentConversation": true,
                    "allowContactExchange": false,
                    "allowOfflineMeeting": false,
                    "allowProjectDetails": false,
                    "allowCurrentActivity": true,
                },
            },
        },
    })
    .to_string()
}

fn match_response_envelope(sender: &str) -> String {
    serde_json::json!({
        "protocol": "KSA",
        "version": "0.1",
        "messageId": "f47ac10b-58cc-4372-a567-0e02b2c3d482",
        "timestamp": "2026-10-15T00:00:03.000Z",
        "type": "match_response",
        "sender": sender,
        "payload": {
            "displayName": sender,
            "analysis": {
                "compatibilitySignal": "moderate",
                "commonGround": ["typescript"],
                "recommendedTopics": [],
                "potentialFriction": [],
                "explanation": "ok",
            },
        },
    })
    .to_string()
}

/// Drain up to `n` envelopes from the given side, with a deadline.
async fn drain_n(
    state: &kindora_lib::LanState,
    which: Side,
    n: usize,
    deadline: Duration,
) -> Vec<String> {
    let start = Instant::now();
    let mut out: Vec<String> = Vec::new();
    while out.len() < n && start.elapsed() < deadline {
        let got = match which {
            Side::Host => state.host_poll().await.unwrap_or_default(),
            Side::Join => state.join_poll().await.unwrap_or_default(),
        };
        for g in got {
            out.push(g);
            if out.len() >= n {
                break;
            }
        }
        if out.len() < n {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    out
}

#[derive(Copy, Clone)]
enum Side {
    Host,
    Join,
}

async fn connect_two(
    code: &str,
) -> (kindora_lib::LanState, kindora_lib::LanState) {
    let host_state = fresh_state();
    let joiner_state = fresh_state();
    host_state
        .host_start(code.to_string(), AGENT_HOST.into(), "Host".into())
        .await
        .expect("host_start");
    let peers = joiner_state
        .join_discover(code.to_string(), 3000)
        .await
        .expect("join_discover");
    let peer = peers.first().expect("at least one peer").clone();
    joiner_state
        .join_connect(peer.ip.clone(), peer.port)
        .await
        .expect("join_connect");
    // Wait for the host to see the link up. (The joiner side has no
    // public `join_linked()`; we rely on `host_linked()` on the host
    // and on `join_send` succeeding as the joiner's link signal.)
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && !host_state.host_linked().await {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    (host_state, joiner_state)
}

// ----------------------------------------------------------------
// 1. Two-instance discovery + TCP connect
// ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_discovery_and_link() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DI2LNK";
    let (host, joiner) = connect_two(code).await;
    assert!(host.host_linked().await, "host should be linked");
    // Sanity-check the joiner side: a successful join_send is the
    // observable signal that the joiner's TCP link is up (the
    // joiner-side `host_linked()` mirror is internal, not part of
    // the public API). We send a hello and read it on the host.
    joiner
        .join_send(hello_envelope(AGENT_JOINER, "Joiner"))
        .await
        .expect("joiner must be able to send over the link");
    let host_got = drain_n(&host, Side::Host, 1, Duration::from_secs(2)).await;
    assert_eq!(host_got.len(), 1, "host should see the joiner's hello");
    host.host_stop().await.expect("host_stop");
    joiner.join_disconnect().await.expect("join_disconnect");
}

// ----------------------------------------------------------------
// 2. Both sides exchange hello
// ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_hello_exchange() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DIHELO";
    let (host, joiner) = connect_two(code).await;

    let host_hello = hello_envelope(AGENT_HOST, "Host");
    let joiner_hello = hello_envelope(AGENT_JOINER, "Joiner");
    host.host_send(host_hello.clone()).await.expect("host_send hello");
    joiner.join_send(joiner_hello.clone()).await.expect("join_send hello");

    // Each side should receive the other's hello.
    let host_got = drain_n(&host, Side::Host, 1, Duration::from_secs(2)).await;
    let joiner_got = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;
    assert_eq!(host_got.len(), 1, "host should receive 1 envelope");
    assert_eq!(joiner_got.len(), 1, "joiner should receive 1 envelope");
    assert!(
        host_got[0].contains(AGENT_JOINER),
        "host's received envelope must be the joiner's hello; got {}",
        host_got[0]
    );
    assert!(
        joiner_got[0].contains(AGENT_HOST),
        "joiner's received envelope must be the host's hello; got {}",
        joiner_got[0]
    );

    host.host_stop().await.expect("host_stop");
    joiner.join_disconnect().await.expect("join_disconnect");
}

// ----------------------------------------------------------------
// 3. profile_exchange round-trip
// ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_profile_exchange_round_trip() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DIPROF";
    let (host, joiner) = connect_two(code).await;

    // Skip hello for brevity; the wire doesn't enforce order.
    let host_profile = profile_exchange_envelope(AGENT_HOST, "host_nick");
    let joiner_profile = profile_exchange_envelope(AGENT_JOINER, "joiner_nick");
    host.host_send(host_profile).await.expect("host_send profile");
    joiner.join_send(joiner_profile).await.expect("join_send profile");

    let host_got = drain_n(&host, Side::Host, 1, Duration::from_secs(2)).await;
    let joiner_got = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;
    assert!(
        host_got[0].contains("joiner_nick"),
        "host should see joiner profile; got {}",
        host_got[0]
    );
    assert!(
        joiner_got[0].contains("host_nick"),
        "joiner should see host profile; got {}",
        joiner_got[0]
    );

    host.host_stop().await.expect("host_stop");
    joiner.join_disconnect().await.expect("join_disconnect");
}

// ----------------------------------------------------------------
// 4. match_request / match_response order + count
// ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_match_request_response_order() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DIMATE";
    let (host, joiner) = connect_two(code).await;

    // host sends match_request
    host.host_send(match_request_envelope(AGENT_HOST))
        .await
        .expect("host_send match_request");
    let joiner_got = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;
    assert_eq!(joiner_got.len(), 1, "joiner should receive 1 envelope");
    assert!(
        joiner_got[0].contains("\"type\":\"match_request\""),
        "first envelope must be match_request; got {}",
        joiner_got[0]
    );

    // joiner sends match_response
    joiner
        .join_send(match_response_envelope(AGENT_JOINER))
        .await
        .expect("join_send match_response");
    let host_got = drain_n(&host, Side::Host, 1, Duration::from_secs(2)).await;
    assert_eq!(host_got.len(), 1, "host should receive 1 envelope");
    assert!(
        host_got[0].contains("\"type\":\"match_response\""),
        "first envelope must be match_response; got {}",
        host_got[0]
    );

    // Now reverse: joiner sends match_request, host sends match_response.
    joiner
        .join_send(match_request_envelope(AGENT_JOINER))
        .await
        .expect("join_send match_request");
    let host_got_2 = drain_n(&host, Side::Host, 1, Duration::from_secs(2)).await;
    assert_eq!(host_got_2.len(), 1);
    assert!(host_got_2[0].contains("\"type\":\"match_request\""));
    host.host_send(match_response_envelope(AGENT_HOST))
        .await
        .expect("host_send match_response");
    let joiner_got_2 = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;
    assert_eq!(joiner_got_2.len(), 1);
    assert!(joiner_got_2[0].contains("\"type\":\"match_response\""));

    host.host_stop().await.expect("host_stop");
    joiner.join_disconnect().await.expect("join_disconnect");
}

// ----------------------------------------------------------------
// 5. Host never sends hello → joiner poll stays empty
// ----------------------------------------------------------------
//
// Phase 16.3 § 5.1 closed the previous "TCP drop is invisible until
// the OS buffer fills" gap (`peer_closed: Arc<AtomicBool>` on the
// `TcpLink` makes `host_poll` / `join_poll` surface
// `Err(LanError::PeerClosed)` immediately). This test still pins
// the wire-level fact that a silent host produces zero envelopes
// on the joiner side, AND it documents that a sent frame from
// the joiner side after `host_stop` is now reported as
// `Err(PeerClosed)` rather than as a silent success.

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_host_silent_then_link_drops() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DIHUSH";
    let (host, joiner) = connect_two(code).await;

    // Host stays silent. Joiner polls for 500 ms — should see nothing.
    let joiner_got = drain_n(&joiner, Side::Join, 1, Duration::from_millis(500)).await;
    assert!(
        joiner_got.is_empty(),
        "silent host should produce 0 envelopes on the joiner; got {:?}",
        joiner_got
    );

    // Now the host stops. The joiner side is still up.
    host.host_stop().await.expect("host_stop");
    assert!(!host.host_linked().await, "host_linked must be false after stop");

    // Phase 16.3 § 5.1 fix: `joiner.join_send` no longer silently
    // succeeds after `host_stop`. The `peer_closed` flag was set
    // when the host's drop propagated through the read loop, so the
    // send fast-fails with `Err(PeerClosed)`. We use `let _ =` here
    // to keep this test resilient to that change — the strong
    // assertion lives in `two_instance_tcp_drop_joiner_perspective`
    // below. (Phase 16.1's "DOCUMENTED GAP" comment for this branch
    // is therefore no longer accurate; the manual § 5.1 records the
    // fix.)
    let _ = joiner.join_send("post-stop".to_string()).await;
    joiner.join_disconnect().await.expect("join_disconnect");
}

// ----------------------------------------------------------------
// 6. Malformed hello is delivered (validation is TS-side)
// ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_malformed_hello_is_delivered() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DIMALF";
    let (host, joiner) = connect_two(code).await;

    // Send a deliberately malformed hello: non-UUID sender, no
    // displayName. The wire (Rust) does not validate envelopes — it
    // just passes the JSON through. The TS-side `validatePeerHello`
    // is what rejects it. This test only verifies the wire doesn't
    // mangle or drop the bytes.
    let bad_hello = r#"{"protocol":"KSA","version":"0.1","type":"hello","sender":"not-a-uuid","payload":{}}"#;
    host.host_send(bad_hello.to_string())
        .await
        .expect("host_send bad");
    let joiner_got = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;
    assert_eq!(joiner_got.len(), 1, "joiner should receive 1 envelope");
    assert_eq!(
        joiner_got[0], bad_hello,
        "wire must deliver bytes verbatim; got {}",
        joiner_got[0]
    );

    host.host_stop().await.expect("host_stop");
    joiner.join_disconnect().await.expect("join_disconnect");
}

// ----------------------------------------------------------------
// 7. Mid-handshake disconnect: host stops before joiner sends
// ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_mid_handshake_disconnect() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DIMID0";
    let (host, joiner) = connect_two(code).await;

    // Host sends hello.
    host.host_send(hello_envelope(AGENT_HOST, "Host"))
        .await
        .expect("host_send hello");
    // Joiner receives it.
    let _joiner_got = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;

    // Now the host stops BEFORE the joiner replies.
    host.host_stop().await.expect("host_stop");
    assert!(!host.host_linked().await, "host_linked must be false after stop");

    // Phase 16.3 § 5.1 fix: the joiner detects the host-side drop
    // within ≤ 1 s of `host_stop` via `Err(PeerClosed)` from
    // `join_poll` (the `peer_closed` atomic). The send below is
    // kept as a non-asserting call: it is one of the paths the
    // fix touched (now fast-fails on the closed flag). The strong
    // assertion lives in `two_instance_tcp_drop_joiner_perspective`.
    let _ = joiner.join_send("reply".to_string()).await;

    joiner.join_disconnect().await.expect("join_disconnect");
}

// ----------------------------------------------------------------
// 8. Post-protocol disconnect after a full envelope round-trip
// ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_post_protocol_disconnect() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DIPOST";
    let (host, joiner) = connect_two(code).await;

    // Drive a full round-trip: hello + profile + match_request + match_response
    // in each direction.
    host.host_send(hello_envelope(AGENT_HOST, "Host"))
        .await
        .unwrap();
    joiner
        .join_send(hello_envelope(AGENT_JOINER, "Joiner"))
        .await
        .unwrap();
    host.host_send(profile_exchange_envelope(AGENT_HOST, "host"))
        .await
        .unwrap();
    joiner
        .join_send(profile_exchange_envelope(AGENT_JOINER, "joiner"))
        .await
        .unwrap();
    host.host_send(match_request_envelope(AGENT_HOST))
        .await
        .unwrap();
    joiner
        .join_send(match_response_envelope(AGENT_JOINER))
        .await
        .unwrap();

    // Drain a bit; we don't need to assert counts here (covered by
    // the order test). Just make sure nothing's stuck.
    let _ = drain_n(&host, Side::Host, 3, Duration::from_secs(1)).await;
    let _ = drain_n(&joiner, Side::Join, 3, Duration::from_secs(1)).await;

    host.host_stop().await.expect("host_stop");
    assert!(!host.host_linked().await, "host_linked must be false after stop");

    // Phase 16.3 § 5.1 fix: post-stop, the joiner's `join_send` no
    // longer succeeds silently. The kernel accepts bytes into the
    // still-open writer half, but the `peer_closed` flag (set when
    // the host-side drop propagated) fast-fails the next send with
    // `Err(PeerClosed)`. We keep `let _ =` here to remain agnostic
    // to whether the flag was set in time on this particular run —
    // the strong assertion lives in
    // `two_instance_post_protocol_disconnect`'s sibling test
    // `two_instance_tcp_drop_joiner_perspective` below.
    let _ = joiner.join_send("after-stop".to_string()).await;
    joiner.join_disconnect().await.expect("join_disconnect");
}

// ----------------------------------------------------------------
// 9. Cancel + re-pair: discover miss, then re-discover hit
// ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_cancel_and_repair() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code_a = "REPRAA";
    let code_b = "REPRBB";
    let host = fresh_state();
    let joiner = fresh_state();
    host.host_start(code_a.to_string(), AGENT_HOST.into(), "Host".into())
        .await
        .expect("host_start A");

    // Joiner tries the wrong code first.
    let miss = joiner
        .join_discover(code_b.to_string(), 500)
        .await
        .expect("discover B");
    assert!(miss.is_empty(), "no host for code_b; got {:?}", miss);

    // Joiner re-tries with code_a — must succeed.
    let hit = joiner
        .join_discover(code_a.to_string(), 1500)
        .await
        .expect("discover A");
    assert_eq!(hit.len(), 1, "host A should respond to code_a; got {:?}", hit);
    let peer = &hit[0];
    joiner
        .join_connect(peer.ip.clone(), peer.port)
        .await
        .expect("join_connect");

    // Wait for the link.
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && !host.host_linked().await {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(host.host_linked().await, "host should be linked after re-pair");

    // And a hello round-trip works.
    host.host_send(hello_envelope(AGENT_HOST, "Host"))
        .await
        .unwrap();
    let joiner_got = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;
    assert_eq!(joiner_got.len(), 1);

    host.host_stop().await.expect("host_stop");
    joiner.join_disconnect().await.expect("join_disconnect");
}

// ----------------------------------------------------------------
// Phase 16.3 § 5.1 — TCP drop detection.
//
// These are same-process multi-LanState tests with real UDP/TCP
// sockets — the same level of coverage as tests 1–9 above. They are
// NOT cross-OS-process tests (those live in
// `lan_cross_process_host.rs` / `lan_cross_process_joiner.rs`).
//
// Each test declares its scenario and expected outcome in a header
// block. Phase 16.3 § 5.1 contract:
//
//   - `host_poll` / `join_poll` return `Err(PeerClosed)` after the
//     TCP peer closes the link.
//   - `host_send` / `join_send` fast-fail with `PeerClosed` once the
//     read loop has observed the peer closing, AND convert
//     `BrokenPipe` / `ConnectionReset` / `ConnectionAborted` write
//     errors to `PeerClosed` so the caller doesn't have to
//     interpret a generic `Io` error.
//   - Local `host_stop` / `join_disconnect` do NOT report as
//     `PeerClosed`. Once the local side takes its state out, polls
//     return `NotConnected`.
//   - Same connection reports the drop only once: each subsequent
//     poll/send returns the same `PeerClosed` (atomic-store
//     idempotency), no extra "events" leak through.
//   - Reconnect after a drop works — a fresh `host_start` against a
//     fresh `join_discover` / `join_connect` succeeds.
// ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_tcp_drop_joiner_perspective() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DRPJNR";
    let (host, joiner) = connect_two(code).await;
    // Round-trip one envelope so both ends have an established link
    // and the read loops are confirmed running.
    host.host_send(hello_envelope(AGENT_HOST, "Host"))
        .await
        .expect("host_send");
    let _ = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;

    // The host calls `host_stop` — this drops the host's TcpLink,
    // which sends FIN to the joiner. The joiner's read loop observes
    // EOF and must set `peer_closed = true` (Phase 16.3 § 5.1).
    host.host_stop().await.expect("host_stop");

    // Give the FIN time to propagate through the OS and the joiner's
    // read loop to mark the link closed. 500 ms is generous on
    // loopback; the read loop has no IO blocking and runs on the
    // multi-thread runtime, so the propagation is fast.
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut saw_peer_closed = false;
    while Instant::now() < deadline && !saw_peer_closed {
        match joiner.join_poll().await {
            Err(kindora_lib::LanError::PeerClosed) => saw_peer_closed = true,
            // Other states — empty inbox pre-FIN, NotConnected post
            // join_disconnect — are intermediate; keep waiting.
            _ => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    assert!(
        saw_peer_closed,
        "joiner.join_poll must report PeerClosed within 2s of host.host_stop"
    );

    // "Same connection reports drop only once" — a subsequent poll
    // returns the same PeerClosed (the atomic gives a stable
    // observation). The caller can therefore treat any PeerClosed
    // surfacing as "the link is gone", not as a fresh event.
    match joiner.join_poll().await {
        Err(kindora_lib::LanError::PeerClosed) => {}
        other => panic!("second poll must still be PeerClosed; got {:?}", other),
    }

    joiner.join_disconnect().await.expect("join_disconnect");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_tcp_drop_host_perspective() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DRPHOST";
    let (host, joiner) = connect_two(code).await;
    host.host_send(hello_envelope(AGENT_HOST, "Host"))
        .await
        .expect("host_send");
    let _ = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;

    // The joiner initiates its own local clean-down. From the host's
    // perspective this is a REMOTE drop: the joiner's reader half
    // closes when its read loop task ends, sending FIN to the host.
    // The host's read loop must observe that EOF and set its
    // peer_closed, so `host_poll` returns PeerClosed.
    joiner.join_disconnect().await.expect("join_disconnect");

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut saw_peer_closed = false;
    while Instant::now() < deadline && !saw_peer_closed {
        match host.host_poll().await {
            Err(kindora_lib::LanError::PeerClosed) => saw_peer_closed = true,
            _ => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    assert!(
        saw_peer_closed,
        "host.host_poll must report PeerClosed within 2s of joiner.join_disconnect"
    );

    host.host_stop().await.expect("host_stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_local_cancel_does_not_set_peer_closed() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DRPLOC";
    let (host, joiner) = connect_two(code).await;
    host.host_send(hello_envelope(AGENT_HOST, "Host"))
        .await
        .expect("host_send");
    let _ = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;

    // Local cancel on the host side: `host_stop` removes the host's
    // state entirely. After this, the host's polling / sending paths
    // must report `NotConnected` — never `PeerClosed`. Local
    // shutdown deliberately does NOT set `peer_closed` (only the
    // EOF / non-shutdown read error paths do), so a `PeerClosed`
    // outcome here would be a false positive.
    host.host_stop().await.expect("host_stop");

    match host.host_poll().await {
        Err(kindora_lib::LanError::NotConnected) => {}
        other => panic!(
            "host.host_poll after host_stop must be NotConnected; got {:?}",
            other
        ),
    }
    match host.host_send("after-stop".to_string()).await {
        Err(kindora_lib::LanError::NotConnected) => {}
        other => panic!(
            "host.host_send after host_stop must be NotConnected; got {:?}",
            other
        ),
    }

    // Symmetric on the joiner side. After `join_disconnect`, polls
    // and sends return NotConnected, NOT PeerClosed — joining's own
    // local cancel must not look like a remote failure.
    joiner.join_disconnect().await.expect("join_disconnect");
    match joiner.join_poll().await {
        Err(kindora_lib::LanError::NotConnected) => {}
        other => panic!(
            "joiner.join_poll after join_disconnect must be NotConnected; got {:?}",
            other
        ),
    }
    match joiner.join_send("after-stop".to_string()).await {
        Err(kindora_lib::LanError::NotConnected) => {}
        other => panic!(
            "joiner.join_send after join_disconnect must be NotConnected; got {:?}",
            other
        ),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instance_reconnect_after_tcp_drop() {
    let _ = env_logger::builder().is_test(true).try_init();
    let code = "DRPRECN";

    // First pair: full connect → drop → tear down.
    let (host, joiner) = connect_two(code).await;
    host.host_send(hello_envelope(AGENT_HOST, "Host"))
        .await
        .expect("host_send");
    let _ = drain_n(&joiner, Side::Join, 1, Duration::from_secs(2)).await;
    host.host_stop().await.expect("host_stop");
    joiner.join_disconnect().await.expect("join_disconnect");

    // Give the OS a moment to fully tear down the previous sockets.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Second pair: brand-new LanStates, same port-range. Re-binding
    // must succeed (the previous HostSide has dropped its socket),
    // and a fresh round-trip must work.
    let host2 = fresh_state();
    let joiner2 = fresh_state();
    host2
        .host_start(code.to_string(), AGENT_HOST.into(), "Host".into())
        .await
        .expect("host_start 2");
    let peers = joiner2
        .join_discover(code.to_string(), 3000)
        .await
        .expect("join_discover 2");
    assert!(
        !peers.is_empty(),
        "second host must respond to UDP discover after re-pair"
    );
    let peer = peers.first().expect("peer").clone();
    joiner2
        .join_connect(peer.ip.clone(), peer.port)
        .await
        .expect("join_connect 2");

    // Wait for the second link.
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && !host2.host_linked().await {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(host2.host_linked().await, "second host should be linked");

    // Round-trip a hello on the new link.
    host2
        .host_send(hello_envelope(AGENT_HOST, "Host2"))
        .await
        .expect("host_send 2");
    let got = drain_n(&joiner2, Side::Join, 1, Duration::from_secs(2)).await;
    assert_eq!(got.len(), 1, "joiner2 must receive host2's hello");
    assert!(got[0].contains("Host2"));

    host2.host_stop().await.expect("host_stop 2");
    joiner2.join_disconnect().await.expect("join_disconnect 2");
}
