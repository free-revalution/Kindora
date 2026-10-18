# Phase 16 — Real Two-Instance LAN Verification

**Status (Phase 16.3):**

| Layer | Outcome |
|-------|---------|
| Two-LanState protocol test (`cargo test --test lan_protocol_e2e`) | **PASS** (13/13 — 9 from Phase 16.1 + 4 new TCP-drop-detection tests for Phase 16.3 § 5.1) |
| Single-LanState regression (`cargo test --test lan_e2e`) | **PASS** (15/15 unchanged) |
| Vitest full workspace | **PASS** (495/495 — was 493/493 in Phase 16.2; +2 from new Task 1 unit-level tests for `startLanHost` failure contract + ConnectView error rendering) |
| `pnpm -r typecheck` | **PASS** (was PASS in Phase 16.2) |
| `pnpm -r build` | **PASS** (was PASS in Phase 16.2) |
| `cargo check --lib` | **PASS** (requires Rust ≥ 1.99 because of `idna_adapter v1.2.2`'s `edition2024`; run via `rustup run stable cargo check --lib`) |
| Real two-OS-process run on two physical machines | **NOT_RUN** (no GUI driver + no LLM API key in the Claude session) — see § 6 manual below |
| Phase 16.3 § 5.1 fixes | landed — `TcpLink.peer_closed: Arc<AtomicBool>`, `tcp_read_loop` sets it on EOF / non-shutdown read errors, `host_poll` / `join_poll` / `host_send` / `join_send` surface `Err(LanError::PeerClosed)`. Local `host_stop` / `join_disconnect` deliberately do NOT set the flag (their report is `NotConnected`) |
| Phase 16.3 § 5.1 fix 2 (call order) | landed — `startLanHost` now binds the transport FIRST and only then drives the session; `session.startHost(transport, { seed: code })` honours the seed. The pre-existing `unhandledRejection` swallow in `ConnectView.test.tsx` is REMOVED (no longer needed and explicitly forbidden by Phase 16.3 constraints) |

**Bottom line:** the wire-level LAN protocol (UDP discover + TCP length-prefixed
JSON envelope flow) plus its out-of-band peer-drop detection is now
provably correct via `lan_protocol_e2e` (real UDP/TCP, no LLM, no GUI,
no LoopbackHub). The above-the-wire layer (TS `PairingSession` FSM,
`MatchOrchestrator`, the React `ConnectView` / `MatchView`) still
needs a human on two physical machines because it requires a GUI
driver and a real LLM API key.

> **Frame format reminder for manual testers (this is the corrected
> expectation per the actual code):** every envelope on the TCP wire is
> **4-byte big-endian length prefix + UTF-8 JSON body**. A raw `nc` that
> pipes bare JSON without the 4-byte length prefix will fail to parse on
> the receiver (the first 4 bytes of the JSON get interpreted as the
> length, then the next N bytes get cut off). Use the helper script in
> § 4.5 to send a properly framed envelope. Do NOT use raw `nc` for
> malformed-hello testing without the length prefix.

---

## § 0 — Pre-flight (one-time)

1. On machine A and machine B, each:
   - Clone the repo: `git clone git@github.com:free-revalution/Kindora.git`.
   - Check out the latest Phase 16.1 commit. `git log -1` to confirm.
   - Install Node 20+, pnpm 9+, Rust stable (1.99+ recommended; 1.77.2
     fails on a transitive dep that requires `edition2024`).
   - Install Tauri CLI prerequisites for the host OS
     (https://tauri.app/start/prerequisites/).
2. From the repo root on each machine, install workspace deps and build
   the Tauri app **in dev mode** (Tauri 2 dev server):
   ```bash
   pnpm install
   pnpm --filter @kindora/desktop build:fast    # builds the renderer
   pnpm --filter @kindora/desktop tauri dev     # starts the desktop app
   ```
   The first `tauri dev` will compile the Rust side (1–3 min) and then
   open the desktop window. **Do this on both machines before continuing.**
3. On each machine, the first launch shows a "no agent" screen. Create an
   agent on each: name A → "Alice", name B → "Bob". Use any local
   passphrase. The agent id is a UUID v4 (visible in Settings → About).
   Confirm the two agent ids are different.
4. On each machine, open Settings → LLM and configure the same provider
   (e.g. MiniMax-M3 with the same key, or your own). The LLM must be
   reachable from both machines. Verify "Test connection" passes.
5. Confirm both machines are on the same LAN subnet (e.g. 192.168.1.x).
   The host binds UDP 52419 and a random TCP port; the joiner broadcasts
   on 255.255.255.255:52419. Routers that block broadcast between APs will
   break this — use a single AP or a wired switch.
6. Open a terminal on each machine. The desktop app logs to its stderr
   (visible via `tauri dev` console, or `~/Library/Logs/kindora/` on
   macOS). Run the same commands in § 4 with both terminals open so you
   can correlate state changes.

> If you do not have a second physical machine, you can use two VMs on
> the same host. macOS: Parallels / UTM / Lima. Linux: KVM / LXC. Each
> VM must have its own MAC and IP, and a bridged or host-only network
> where broadcast reaches the other VM.

---

## § 1 — Happy path (both sides connect, exchange, match)

| # | Step | Machine A (host) | Machine B (joiner) | Expected |
|---|------|------------------|--------------------|----------|
| 1 | Home screen | click "Connect" | click "Connect" | ConnectView shows |
| 2 | Pick transport | choose "LAN" | choose "LAN" | LAN buttons active |
| 3 | Pick role | click "Host" | click "Join" | host shows pairing code; joiner shows input |
| 4 | Type the code | (wait) | type the 6-char code from A; click "Join" | joiner shows "Searching LAN…" |
| 5 | Auto-connect | UDP/TCP handshake on LAN | sees host; dials TCP | both transition to MatchView within ~2 s |
| 6 | MatchView | shows "preparing match…" for ≤ 10 s | same | both sides display the 5 result fields (compatibility signal, common ground, recommended topics, potential friction, explanation) |
| 7 | Cross-check | A's peer display name = "Bob"; peer agent id = B's UUID | B's peer display name = "Alice"; peer agent id = A's UUID | values match; both agents visible |
| 8 | Cleanup | click "Disconnect" in MatchView | click "Disconnect" | both return to Home; no zombie Rust processes (`ps aux | grep lan_`) |

**Verdict:** **NOT_RUN** (no GUI in the Claude session). The wire-level
analogue — the two-LanState test
`two_instance_discovery_and_link` in
`apps/desktop/src-tauri/tests/lan_protocol_e2e.rs` — **PASS**es (13/13
across the whole file).

> **What to look for in the logs.** On each side, the LAN host poll
> (200 ms interval) flips `linked=true` once the TCP link is up. The
> `PairingSession` then transitions `hosting → tcp-connected → connected`
> (Phase 15) and the orchestrator ships a `match_request`. Each side's
> log should show ONE `match_request` outbound and ONE `match_response`
> inbound — not duplicates.

**Mark § 1 as `PASS` only if rows 1–8 all succeed on both machines.**

---

## § 2 — Failure scenarios

For each scenario below, run from a fresh state (close both apps or click
"Disconnect" on both, then return to Home).

> **Wire-format note (corrected from Phase 16 first draft):** every
> envelope on the TCP wire is a **4-byte big-endian length prefix + the
> UTF-8 JSON body**. For scenarios that need to send a malformed or
> non-conformant envelope from the joiner side, use the helper script
> in § 4.5 to construct a properly framed envelope; sending bare JSON
> over `nc` will not work (the receiver will interpret the first 4 bytes
> of the JSON as the length and either truncate or fail to parse).

| § | Scenario | A (host) action | B (joiner) action | Expected (both) | Verdict (Phase 16.3) |
|---|----------|-----------------|-------------------|-----------------|----------------------|
| 2.1 | **Wrong pairing code** | (none) | type a wrong 6-char code; click Join | joiner shows "No peer found on the LAN for code \"XXXXXX\". Check that both devices are on the same network and that the host is running." host stays on "Waiting for the other person to enter this code…". No LLM call, no match screen, no false-positive match result. | **NOT_RUN** (manual). Wire-level analogue: `join_with_no_host_returns_empty` (single-instance, `lan_e2e.rs`) **PASS**es. The two-instance analogue: `join_discover` for an unknown code returns `[]` (covered by `two_instance_cancel_and_repair` first half — **PASS**). |
| 2.2 | **No host running** | (host app closed) | type a code; click Join | joiner shows the same "No peer found on the LAN for code …" error within ~2.5 s. No LLM call. | **NOT_RUN** (manual). Wire-level analogue: same as 2.1. |
| 2.3 | **UDP discoverable, TCP fails** | start host, then block the host's random TCP port at the firewall (or take the host's IP offline right after UDP announce) | type the code; click Join | joiner gets either a TCP connect timeout (≤ 8 s) or the discover-then-link-failed error. joiner stays on ConnectView; never enters MatchView; LLM not called. host (if reachable) stays on "Waiting for the other person to enter this code…" until timeout. | **NOT_RUN** (manual). No automated coverage (LAN test uses loopback; firewall rules can't be exercised in-process). |
| 2.4 | **TCP up, no `hello` from peer** | start host | open a stub TCP listener (use § 4.5 helper) on B's side AFTER link is up; do NOT send any envelope | host's MatchView shows "preparing match…" for ≤ 5 s, then an error banner: "Peer did not send a hello envelope within 5000 ms." No match result. Session returns to "closed". The stub TCP gets disconnected by host. No LLM call. | **NOT_RUN** (manual). Wire-level analogue: `two_instance_host_silent_then_link_drops` — the joiner side does not get any envelopes while the host is silent — **PASS**. The 5-second hello gate is enforced on the TS side (`MatchOrchestrator`, `helloTimeoutMs = 5000`); not re-tested in the two-process suite. |
| 2.5 | **Malformed `hello`** | start host | use § 4.5 helper to send a properly framed `hello` whose `sender` is a non-UUID, or whose `payload.displayName` is missing | host's MatchView shows the typed error (`HandshakeValidationError` surfaced as a user-readable banner) within ≤ 5 s. No match result. Session closed. No LLM call. | **NOT_RUN** (manual). Wire-level analogue: `two_instance_malformed_hello_is_delivered` — the wire passes the bytes through verbatim; validation is the TS-side `validatePeerHello`'s job. **PASS**. |
| 2.6 | **Peer exits during handshake** | start host, both linked, host in MatchView | quit B's app (Cmd+Q / Alt+F4) | host's MatchView shows a transport-disconnect error within ≤ 1 s; session is "closed"; no match result; no zombie `lan_` processes. | **NOT_RUN** (manual). The § 5.1 documented gap is now closed — Phase 16.3 added `peer_closed: Arc<AtomicBool>` on `TcpLink`; the host's next `host_poll` returns `Err(PeerClosed)`. Wire-level analogues: `two_instance_mid_handshake_disconnect` (existing) **PASS** + `two_instance_tcp_drop_joiner_perspective` + `two_instance_tcp_drop_host_perspective` (Phase 16.3) **PASS**. The TS-side `PairingSession` propagates `PeerClosed` via `try/catch` to a `HandshakeClosedError` in `MatchView`. |
| 2.7 | **Peer exits after match** | both reached MatchView, both see results | B quits the app | A's MatchView shows the peer-disconnect error; A returns to Home cleanly. | **NOT_RUN** (manual). Same machinery as 2.6 — `PeerClosed` surfaces within ≤ 1 s. Wire-level analogue: `two_instance_tcp_drop_joiner_perspective` (Phase 16.3) **PASS**. |
| 2.8 | **LLM API key invalid** | both with an invalid LLM key (e.g. wrong region) | (normal) | both reach MatchView; the orchestrator's local LLM call throws; the `MatchView` shows the LLM error message (an `analyzeMatch` error). No false-positive match shown. | **NOT_RUN** (manual). **Observed code path:** `provider.chat` throws → `analyzeMatch` throws → `MatchOrchestrator.start` throws → `MatchView` shows the error in the `error` phase. *Note:* a malformed LLM response (valid HTTP, bad JSON) is a different path — `parseMatchAnalysis` returns a **degraded** result with `compatibilitySignal: 'none'` and a "match analysis unavailable" explanation; the orchestrator does NOT throw, and `MatchView` shows the degraded result rather than an error. (Covered in `packages/matching/src/__tests__/match-orchestrator.test.ts`.) |
| 2.9 | **Cancel + re-pair** | start host, get code | start joiner; on ConnectView, click "Cancel" | joiner returns to Home; host sees TCP disconnect, returns to "Waiting for the other person…". Restart the joiner, type the same code, repeat § 1 — must succeed. | **NOT_RUN** (manual). The § 5.2 fix landed in Phase 16.2: the joiner side now calls `disconnect('cancelled')` on its `LanJoinHandle` when the user cancels, releasing the UDP socket, the TCP writer/reader, and the 200ms poll loop. The new regression test `ConnectView.cancel-during-disconnect` (in `apps/desktop/src/views/__tests__/ConnectView.test.tsx`) **PASS**es; the wire-level analogue `two_instance_cancel_and_repair` **PASS**es. |

> **Important:** in every failure scenario, the UI must NOT show a
> successful match result. A passing failure scenario is one where the
> error message is honest and the session ends in `closed`, not
> `connected`. Verify this by reading the app's log: grep for
> `HandshakeTimeoutError`, `HandshakeValidationError`,
> `HandshakeClosedError`, `PEER_DISCONNECTED`, or `LLM` errors.

**Mark § 2 as `PASS` only if every row surfaces an error AND no row shows a false-positive match.**

---

## § 3 — State / listener / timer hygiene

Open the desktop dev tools (right-click → Inspect) and watch the React
state, the `PairingSession` state, and the browser console across a
single § 1 happy path.

| § | Check | Expected | Verdict (Phase 16.1) |
|---|-------|----------|----------------------|
| 3.1 | ConnectView mounts once; click Host; observe session state changes | `idle → hosting → tcp-connected → connected`. `connected` fires ONCE. (Phase 16 patch closes the bug where the listener fired on BOTH `tcp-connected` and `connected`.) | **NOT_RUN** (manual). Patches landed in `apps/desktop/src/views/ConnectView.tsx` (the `fired` guard in `HostPanel`'s second `useEffect` for both LAN and loopback). |
| 3.2 | Watch `MatchOrchestrator` in dev tools | One instance per pairing. Re-renders do NOT spawn a second orchestrator. (Phase 16 patch caches the orchestrator on the bridged handle and the orchestrator itself throws on a second `start()`.) | **NOT_RUN** (manual). Patches landed: `cachedOrchestrator` in `ConnectView.tsx` + `started: boolean` reentrancy guard in `packages/matching/src/orchestrator.ts`. Reentrancy test in `match-orchestrator.test.ts` **PASS**es. |
| 3.3 | Network panel / app log | Exactly ONE `match_request` outbound, ONE `match_response` inbound, per side. | **NOT_RUN** (manual). Two-process test `two_instance_match_request_response_order` **PASS**es (verified ordering: `match_request` first, then `match_response`, in each direction). |
| 3.4 | Click "Disconnect" in MatchView | session goes to `closed`; Rust `lan_host_poll` / `lan_join_poll` invocations stop; `setInterval` cleared; no leftover timers in the Chrome devtools "Performance" → "Timers" view. | **NOT_RUN** (manual). |
| 3.5 | Repeat § 1 three times in a row (Disconnect → Connect → Disconnect → Connect) | Each cycle is clean. No listener / timer accumulation. The host's Rust process exits cleanly on each cycle (`ps aux | grep lan_` should be empty). | **NOT_RUN** (manual). |
| 3.6 | Kill A's app from the OS while in MatchView | B's MatchView shows peer-disconnect error within ≤ 1 s. B's session is `closed`. B's `lan_join_poll` stops. | **NOT_RUN** (manual). Wire-level covered by `two_instance_tcp_drop_joiner_perspective` and `two_instance_reconnect_after_tcp_drop` (Phase 16.3). UI NOT_RUN — § 4.7 step 6 drives the same scenario on a real GUI. |

**Mark § 3 as `PASS` if no state / listener / timer / log anomalies.**

---

## § 4 — Logs to capture (per side)

### § 4.1 — `tauri dev` console

Save the renderer console + Rust stderr on each machine for the § 1
happy path:

```bash
# On the desktop dev console (or pnpm --filter @kindora/desktop tauri dev)
# grep for these tokens in the renderer console + the Rust stderr:
grep -nE "lan_announce|lan_invite|linked=|tcp-connected|notifyHelloReceived|match_request|match_response|MatchOrchestrator" \
  ~/Library/Logs/kindora/*.log
```

### § 4.2 — Expected order (simplified)

```
[host] lan_announce  agent_id=<A-UUID>  tcp_port=<random>
[joiner] UDP discover received from <A-IP>  code=<CODE>
[joiner] TCP dial <A-IP>:<port>  →  ok
[host]   host_poll  linked=true  peer=<B-IP>
[host]   PairingSession  hosting → tcp-connected
[joiner] PairingSession  joining → tcp-connected
[host]   MatchOrchestrator.start  (one instance)
[joiner] MatchOrchestrator.start  (one instance)
[host]   session.send(hello)  → 1 outbound
[joiner] session.send(hello)  → 1 outbound
[host]   hello received  from=<B-UUID>  notifyHelloReceived  → connected
[joiner] hello received  from=<A-UUID>  notifyHelloReceived  → connected
[host]   session.send(profile_exchange)  + receive peer profile
[joiner] session.send(profile_exchange)  + receive peer profile
[host]   session.send(match_request)  + analyzeMatch (LLM)  + session.send(match_response)
[joiner] session.send(match_request)  + analyzeMatch (LLM)  + session.send(match_response)
[host]   peerAnalysis received  → MatchOutcome
[joiner] peerAnalysis received  → MatchOutcome
```

If you see `match_request` more than once on either side, that's the
reentrancy bug — re-check the Phase 16 patches landed.

### § 4.3 — Reentrancy re-check (DevTools)

In the React dev tools, on the `MatchView` component, find the
`MatchOrchestrator` instance via the bridged handle. Confirm the same
object identity across re-renders: log `bridged.orchestrator === window.__lastOrch`
on a render and verify `true`. If `false`, the cache broke and the
reentrancy guard is the only thing preventing duplicate
`match_request`s.

### § 4.4 — Two-process evidence (already run)

`cargo test --test lan_protocol_e2e -- --test-threads=1` produces the
13-test PASS log in `target/debug/deps/...` (9 from Phase 16.1, 4 from
Phase 16.3 covering TCP-drop detection: `two_instance_tcp_drop_joiner_perspective`,
`two_instance_tcp_drop_host_perspective`,
`two_instance_local_cancel_does_not_set_peer_closed`,
`two_instance_reconnect_after_tcp_drop`). Each test exercises the
real UDP discovery + TCP framing path; the only thing the tests do NOT
cover is the TS-side FSM, the React lifecycle, and the LLM call.

### § 4.5 — Helper: send a properly framed envelope to the host's TCP port

For § 2.4, § 2.5, § 2.7 manual runs, you may want to drive the host's
TCP port directly with a properly framed envelope. Save this as
`scripts/frame_send.py` (or your preferred language):

```python
#!/usr/bin/env python3
"""
Send one or more envelopes to a host's TCP LAN port using the real
Kindora wire format: 4-byte big-endian length + UTF-8 JSON body.
Usage: python frame_send.py <host-ip> <tcp-port> path/to/envelope.json [more.json ...]
"""
import socket, struct, sys, pathlib

if len(sys.argv) < 4:
    sys.exit("usage: frame_send.py <ip> <port> <envelope.json> [envelope.json ...]")

ip, port = sys.argv[1], int(sys.argv[2])
s = socket.create_connection((ip, port))
for path in sys.argv[3:]:
    body = pathlib.Path(path).read_bytes()
    s.sendall(struct.pack(">I", len(body)) + body)
    print(f"sent {len(body)} bytes from {path}")
s.close()
```

For § 2.5 (malformed hello), put a deliberately-broken JSON in
`bad.json` and pass it to the script. The wire delivers it byte-for-byte
to the TS-side `validatePeerHello`, which will reject it (this is the
`two_instance_malformed_hello_is_delivered` test, but driven by you
instead of a second LanState).

For § 2.4 (no hello), open a raw TCP listener with `nc -l <port>` (or
`socat TCP-LISTEN:<port>`) so the host's `join_connect` succeeds but
no envelope ever arrives.

### § 4.6 — LLM key requirement matrix

This matrix tells the manual tester what they can run WITHOUT a
real LLM API key. Phase 16.2 of the brief was explicit: do not
configure a key, do not run the LLM-dependent rows. Anything below
that says "needs LLM" stays NOT_RUN for this phase.

| § | Scenario | Needs LLM? | Phase 16.3 status |
|---|----------|-----------|-------------------|
| § 1 (rows 1-5) | ConnectView renders, host code visible, peer discovery, TCP connect, state transitions to `tcp-connected` / `connected` | NO | NOT_RUN (no GUI driver in the Claude session); wire-level analogue `two_instance_discovery_and_link` **PASS** |
| § 1 (rows 6-7) | MatchOrchestrator runs `analyzeMatch`, MatchView shows the 5 result fields, peer display name + agent id match | YES | NOT_RUN |
| § 1 (row 8) | Disconnect cleans up the session | NO | wire-level: `lan_e2e.host_linked_becomes_false_after_stop` **PASS** |
| § 2.1, § 2.2 | Wrong code / no host (joiner-only flow, no peer involved) | NO | NOT_RUN (needs GUI); wire-level analogues **PASS** (`two_instance_cancel_and_repair` proves the empty-discover path) |
| § 2.3 | UDP discoverable, TCP fails (firewall block) | NO | NOT_RUN (firewall needs OS access) |
| § 2.4 | TCP up, no hello from peer | NO | NOT_RUN (needs GUI); `two_instance_host_silent_then_link_drops` **PASS** |
| § 2.5 | Malformed hello | NO | NOT_RUN (needs GUI); `two_instance_malformed_hello_is_delivered` **PASS** |
| § 2.6 | Peer exits during handshake | NO | wire-level analogue `two_instance_mid_handshake_disconnect` **PASS** (joiner's send still ok; the new `peer_closed` machinery means the next `host_poll` returns `Err(PeerClosed)`); manual UI version NOT_RUN (needs GUI) |
| § 2.7 | Peer exits after match — peer-side drop detection | NO | wire-level analogue `two_instance_tcp_drop_*` **PASS** (4 new tests in `lan_protocol_e2e.rs`); manual UI version NOT_RUN (needs GUI) |
| § 2.8 | LLM API key invalid | YES | NOT_RUN |
| § 2.9 | Cancel + re-pair (Cancel fix verified in Phase 16.2) | NO | new `ConnectView.test.tsx` **PASS** (now 10/10 with the Phase 16.3 transport-failure-contract additions); wire-level analogue `two_instance_cancel_and_repair` **PASS** |
| § 3.1, § 3.2 | State transitions fire once, one orchestrator per pairing | NO | NOT_RUN (DevTools); fix is in code (Phase 16 patch + reentrancy guard); `match-orchestrator.test.ts` reentrancy test **PASS** |
| § 3.3 | Exactly one match_request/response per side | YES (for the response) | NOT_RUN |
| § 3.4, § 3.5 | Disconnect cleanup, three cycles | NO | NOT_RUN (needs GUI) |
| § 3.6 | Hard kill propagates — drop detection end-to-end | NO | wire-level `two_instance_tcp_drop_joiner_perspective` and `two_instance_tcp_drop_host_perspective` **PASS**; UI NOT_RUN |

**Bottom line for a no-LLM manual run (Phase 16.3 § 4.7 below expands
this):** you can drive the full discovery + TCP connect + state-
transition + drop-detection path on two machines WITHOUT configuring
an LLM key. Open both apps, click Host on one and Join on the other,
type the 6-char code, and verify that the state transitions hit
`tcp-connected`. Then close one end and verify the surviving side
flips an error banner within ≤ 1 s (this is the Phase 16.3 § 5.1 drop
detection). You will see the "preparing match…" banner in MatchView;
without an LLM key the `analyzeMatch` call will fail and the banner
will show the error. That is the expected boundary — it confirms the
wire + drop-detection layers are correct and the LLM layer is the only
thing that needs a key.

### § 4.7 — Shortest no-LLM manual flow (Phase 16.3 Task 4)

This is the minimal manual regression a human can run on two physical
machines (or two VMs on one host — see § 0) WITHOUT configuring a
real LLM API key. It validates the Phase 16.3 fixes end-to-end on a
real GUI:

| Step | Machine A (host) | Machine B (joiner) | Pass criterion |
|------|------------------|--------------------|----------------|
| 0 | Open Settings → LLM. Pick provider `"none"` (or any provider without a real key). Save. | Same. | Both apps boot without crashing; LLM banner may say "not configured", that's expected. |
| 1 | Home screen → click **Connect**. | Same. | ConnectView appears. |
| 2 | Mode toggle: pick **LAN**. Transport toggle: pick **Host**. | Mode toggle: pick **LAN**. Transport toggle: pick **Join**. | Host shows the 6-character pairing code; joiner shows the input. |
| 3 | (wait) | Type A's code into the input; click **Join**. | Joiner shows "Searching LAN…" → within ~3 s, both transition to MatchView. The "preparing match…" banner appears. |
| 4 | (none) | Click **Cancel** in ConnectView **BEFORE** A's code is typed. | Joiner returns to Home; A's host stays on "Waiting…"; no Rust zombie process (`ps aux | grep lan_`). This is the § 5.2 fix verified manually. |
| 5 | (none) | Re-open ConnectView, type A's code again, click Join. | Both go to MatchView again. |
| 6 | Once both are in MatchView, on B: Cmd-Q / Alt-F4 (or just kill the process). | (killed) | Within ≤ 1 s, A's MatchView flips to an error banner (`HandshakeClosedError` or `PeerDisconnected`). A's session is `closed`. A's Rust side reports `Err(LanError::PeerClosed)` on `host_poll` (visible in the dev console). This is the Phase 16.3 § 5.1 drop detection verified end-to-end. |
| 7 | Restart A's host from Home → Connect → Host. Get a fresh code. | Restart B. Connect → Join → type the new code. | Both go to MatchView again. This is the § 2.9 reconnect verified manually. |
| 8 | Click **Disconnect** in MatchView. | Click **Disconnect** in MatchView. | Both return to Home. No Rust zombies (`ps aux | grep lan_` returns nothing). |

Record per step:

```
PASS / FAIL / NOT_RUN
```

If any step FAILS, capture the renderer console + Rust stderr from
both machines (`~/Library/Logs/kindora/*.log` on macOS, or the
`tauri dev` console on Linux/Windows). The captures should show:

- Step 3: `lan_announce`, `lan_discover`, `lan_invite` (or the
  equivalent log lines), `linked=true`, `PairingSession hosting →
  tcp-connected`.
- Step 6: A's `host_poll` returns `Err(PeerClosed)` (visible in
  the dev console as the error trace). B's session is gone.
- Step 7: A fresh `lan_announce`, fresh join, fresh link.
- Step 8: `lan_host_stop` / `lan_join_disconnect` issued exactly
  once each.

This flow does NOT exercise the LLM (`analyzeMatch`) at all — the
"preparing match…" banner stays up indefinitely and then times out
into an error. That is expected and intentional: LLM testing is
out of scope for this manual.

---

## § 5 — Known gaps (calibrated against the actual code, Phase 16.3)

### § 5.1 — LAN transport peer-drop detection (FIXED in Phase 16.3)

**Original symptom (Phase 16.1):** `tcp_read_loop` swallowed EOF
silently and returned `Ok(())`; `host_poll` / `join_poll` did
`try_recv` on the inbox and `break` on `Disconnected`, returning
`Ok(vec![])` instead of an error. `host_send` / `join_send` only
failed after the OS TCP buffer filled or RST fired. The TS layer
relied on the next `send` (via `PairingSession`) to discover the
drop and surface a `HandshakeClosedError` to `MatchView` — defense-
in-depth, not a clean signal.

**Fix (Phase 16.3 § 5.1):**

1. `apps/desktop/src-tauri/src/lan.rs`:
   - New error variant `LanError::PeerClosed`.
   - `TcpLink` now carries a `peer_closed: Arc<std::sync::atomic::AtomicBool>`.
   - `tcp_read_loop` accepts the flag as a parameter. On EOF and on
     non-shutdown read errors the flag is set to true (the local-
     shutdown branch via the watch channel does NOT set it). The
     flag is atomic-stored, so multiple call paths collapsing to
     "the link is gone" produce a single observable state.
   - `host_poll` / `join_poll` consult the flag after the inbox
     `try_recv` returns `Disconnected`. If set, the function
     returns `Err(LanError::PeerClosed)`. If unset, the inbox
     closure is treated as a local clean-down (currently only
     reachable by accident; `host_stop` / `join_disconnect` remove
     the state outright so subsequent polls return
     `NotConnected`).
   - `host_send` / `join_send` fast-fail on the flag. If the write
     itself returns `BrokenPipe` / `ConnectionReset` /
     `ConnectionAborted`, the flag is set and the caller sees
     `Err(LanError::PeerClosed)` instead of a generic `Io`.

2. The `peer_closed` flag satisfies all five contract points:

   - **Same connection reports drop only once:** `tcp_read_loop`
     sets the flag via `store(true, Release)`; subsequent polls see
     the same flag and return `PeerClosed` idempotently.
   - **No deadlock or unnecessary blocking:** all paths are
     non-blocking (`try_recv` + a non-locking `load(Acquire)` on
     the flag). The writer-lock is only acquired once we know the
     peer is still alive.
   - **Local cancel is NOT reported as remote failure:** the
     `tcp_read_loop` shutdown branch (driven by the watch channel)
     explicitly does not touch the flag. `host_stop` and
     `join_disconnect` short-circuit the state via `take()`, so the
     next poll on the local side returns `NotConnected`, not
     `PeerClosed`.
   - **Cleanup after drop is fine:** the reader/writer halves and
     the inbox are still owned by the local side; the caller
     decides when to dispose via `host_stop` / `join_disconnect`.
     The `peer_closed` flag is informational — it does not own any
     resource.
   - **Reconnect works:** the drop machinery is purely a
     notification. A subsequent `host_start` (or `join_discover` +
     `join_connect`) on the same `LanState` works unchanged because
     `host_stop` and `join_disconnect` clear the prior state.

**Verification:**

- `apps/desktop/src-tauri/tests/lan_protocol_e2e.rs` — 4 new tests:
  - `two_instance_tcp_drop_joiner_perspective` — host stops →
    joiner's `join_poll` returns `Err(PeerClosed)` within 2 s.
  - `two_instance_tcp_drop_host_perspective` — joiner disconnects
    → host's `host_poll` returns `Err(PeerClosed)` within 2 s.
  - `two_instance_local_cancel_does_not_set_peer_closed` — local
    `host_stop` / `join_disconnect` return `NotConnected`, NOT
    `PeerClosed`.
  - `two_instance_reconnect_after_tcp_drop` — fresh
    `host_start` + `join_discover` + `join_connect` succeed on the
    same port range after a drop.
- The previously documented § 2.6 / § 2.7 / § 3.6 gaps (peer exits
  during handshake / after match / hard kill) now have wire-level
  PASS coverage. Manual GUI confirmation of the same flow is in
  § 4.7 step 6.

**Status:** **FIXED**. The § 2.6 / § 2.7 / § 3.6 manual rows remain
NOT_RUN on a real GUI (no driver in the Claude session), but the
underlying detection is now provable and the wire-level analogue
PASSes.

### § 5.2 — Cancel from ConnectView leaked the LAN handle (FIXED in Phase 16.2)

**Where:** `apps/desktop/src/views/ConnectView.tsx`,
`apps/desktop/src/lib/lan-connect-service.ts`.

**Original symptom (Phase 16.1):** clicking "Cancel" in the joiner
panel (or unmounting `ConnectView` from any path) did NOT explicitly
disconnect the in-flight `LanConnectHandle`. The `JoinSide` (TCP
writer/reader), the UDP socket used for discovery, and the 200ms poll
loop were leaked. A second pairing attempt with the same joiner could
encounter a leaked UDP socket still bound to a port; in practice the
kernel reuses the port and the test passes, but the resource leak is
real. The host side had a similar race: once `setLanHandle(h)` had
been called, the `useEffect` cleanup only set a `cancelled` flag —
it did not call `disconnect` on the already-stored handle.

**Fix (Phase 16.2):** two changes.

1. `lan-connect-service.ts` — `disconnect` is now strictly
   idempotent. A `disconnected: boolean` flag short-circuits a
   second concurrent caller (e.g. unmount cleanup racing with a
   user-triggered disconnect). This is defense-in-depth — both
   `PairingSession.disconnect` and `LanTransport.disconnect` are
   already no-ops on the second call, but the guard makes the
   contract explicit and avoids wasted IPC.
2. `ConnectView.tsx`:
   - `HostPanel` now stashes the in-flight `ConnectHandle` /
     `LanConnectHandle` in `useRef` BEFORE `setLanHandle` (so the
     unmount cleanup can find it even if React hasn't committed the
     state update yet). A new dedicated `useEffect(() => {...}, [])`
     cleanup reads the ref and calls `disconnect('cancelled')` on
     whatever is there.
   - `JoinPanel` tracks `mountedRef`. The async `handleSubmit`
     checks `mountedRef.current` after every `await` and tears down
     the in-flight handle if the user cancelled mid-flight. The
     `setError` / `setBusy` calls are also guarded so a late
     rejection doesn't trigger a setState on an unmounted component.

**Verification:**

- New regression suite:
  `apps/desktop/src/views/__tests__/ConnectView.test.tsx` — 8 tests
  that record Tauri IPC, drive the ConnectView through host/join +
  cancel/unmount, and assert the matching `lan_host_stop` /
  `lan_join_disconnect` IPC was issued exactly once.
- All 8 new tests pass; existing 485 tests still pass (now 493 total).
- Wire-level test `two_instance_cancel_and_repair` still passes
  (covers the discovery + re-connect path).

**Status:** **FIXED**. The § 2.9 manual row can now be marked `PASS`
in a two-machine run, provided the manual tester verifies that
re-pairing after cancel succeeds (a previously flaky path).

### § 5.3 — LLM error path: throw vs. degraded

Two distinct paths in `packages/agent/src/analyze-match.ts`:

1. **`provider.chat` throws** (auth error, network error, 4xx/5xx
   not retried): `analyzeMatch` throws → `MatchOrchestrator.start`
   throws → `MatchView` shows the error banner. **No false-positive
   match shown.**

2. **Provider returns malformed JSON** (200 OK, but body is not the
   expected `MatchAnalysis` shape): `parseMatchAnalysis` returns a
   **degraded** result with `compatibilitySignal: 'none'` and an
   explanation of "match analysis unavailable". `MatchOrchestrator`
   does NOT throw; `MatchView` shows the degraded result in the
   "done" phase.

These are the observed paths. A test that asserts "LLM error
produces no result" must distinguish between (1) and (2). The
existing `match-orchestrator.test.ts` covers (2) with a malformed-
JSON stub; (1) is covered by an LLM-stub that throws. Both
**PASS**.

### § 5.4 — PeerClosed propagation closure (FIXED in Phase 16.4)

**Where:** `packages/transport/src/lan-transport.ts`,
`packages/transport/src/pairing-session.ts`,
`packages/matching/src/orchestrator.ts`,
`apps/desktop/src/views/MatchView.tsx`.

**Original symptom (Phase 16.3):** the Rust side
(`lan_host_poll` / `lan_join_poll`) returned
`Err(LanError::PeerClosed)` correctly when the remote end dropped
the TCP link. But the TS-side `LanTransport.pollOnce()` caught
the error and `console.debug`'d it — the event was lost. An
in-flight `MatchOrchestrator` was therefore stuck in the hello
wait until its own 5 s `helloTimeoutMs` fired, then surfaced a
`HandshakeTimeoutError`. The user saw "handshake timed out" when
the actual cause was a peer drop that arrived 200 ms after
connect. There was no way to distinguish "peer closed" from
"peer never sent a hello".

**Fix (Phase 16.4):** the `Transport` interface gains an
`onClose(handler)` hook. `LanTransport.pollOnce()` now classifies
the caught error with the new `LanError.from(err)` helper
(`packages/transport/src/lan-error.ts`):

- `kind === 'peer-closed'` → fire `onClose` handlers
  (idempotent — `closedByPeer` flag prevents double-fire), stop
  the poll loop, best-effort Rust-side cleanup
  (`lan_host_stop` / `lan_join_disconnect`), force `mode = 'idle'`.
  Local `disconnect()` does NOT fire `onClose` (the close event is
  reserved for remote-side drops).
- other `LanError` kinds → log at debug, let the next tick retry
  (same retry behaviour as before; only the peer-close path is
  new).

`PairingSession` subscribes to `onClose` from `startHost` /
`startJoin` and routes the event through `failHandshake('peer-closed')`.
The FSM transitions to `'closed'` with `closeReason = 'peer-closed'`,
so `MatchOrchestrator` (mid-hello-wait) throws
`HandshakeClosedError` (message: "Peer closed the connection
before hello was received.") instead of timing out.

`LoopbackTransport` mirrors the interface so tests can drive a
peer-side drop with a new `simulatePeerClose()` method. The
`WebRtcTransport` stub gets a no-op `onClose`.

**Distinguishing local cancel from remote drop:**

- Local `disconnect()` (user cancels, or view unmounts) goes
  through `PairingSession.disconnect(reason)`, which
  unsubscribes the close handler BEFORE calling
  `transport.disconnect()`. The transport's `disconnect()`
  clears its close handler set. A late poll tick on the dead
  session cannot fire `onClose` — both ends of the channel are
  severed.
- A real remote drop (FIN / RST from the OS) is observed in
  the Rust read loop, which sets `peer_closed = true` and
  causes the next `host_poll` / `join_poll` to return
  `Err(LanError::PeerClosed)`. The TS catch path is the only
  source of `onClose` firings.

The two paths are independent and `closeReason` in
`PairingSnapshot` is the source of truth for the UI:
`'peer-closed'` for the second, anything else (e.g.
`'user-cancel'`) for the first.

**UI surfacing:** `MatchView` now inspects the thrown error
type. `HandshakeClosedError` whose message matches `/peer
closed/i` shows a dedicated peer-disconnected message ("The
other side closed the connection before the handshake
finished. You can try pairing again."). Generic `Error`s
fall through to the existing "handshake failed" banner.

**Verification (automated):**

- `packages/transport/src/__tests__/lan-error.test.ts` (NEW) — 11
  classification tests covering each `LanErrorKind` and the
  plain-object defensive path.
- `packages/transport/src/__tests__/lan-transport.test.ts` — 6
  new tests under the Tauri-shim block: `host: peer-closed
  from lan_host_poll fires onClose exactly once`, `joiner:
  peer-closed from lan_join_poll fires onClose exactly once`,
  `local disconnect does NOT fire onClose (only peer-side drops
  do)`, `onClose handler is unsubscribed correctly`, `onClose
  handler that throws does not block the dispatch`, and `after
  peer-closed, a fresh LanTransport can start a new host on the
  same LanState`.
- `packages/transport/src/__tests__/pairing-session.test.ts` — 5
  new tests under `peer-close hook (Transport.onClose)`:
  session drives to `closed` with `closeReason: 'peer-closed'`
  from `tcp-connected` and from `hosting`; local disconnect
  clears the close handler (late `simulatePeerClose` ignored);
  idempotency on two `onClose` firings; reconnect on a fresh
  `PairingSession` after a peer-close.
- `packages/matching/src/__tests__/match-orchestrator.test.ts` —
  3 new tests in the `MatchOutcome error paths` block: the
  orchestrator throws `HandshakeClosedError` (message matches
  `/peer closed/i`, NOT `HandshakeTimeoutError`) when the
  transport fires `onClose` mid-wait; the orchestrator does NOT
  classify a peer-close as `HandshakeTimeoutError`; user-
  initiated disconnect still surfaces as
  `HandshakeClosedError` (existing behaviour preserved).
- `apps/desktop/src/views/__tests__/MatchView.test.tsx` — 3
  new tests: `LiveMatchView` shows a peer-disconnected message
  when `run()` rejects with `HandshakeClosedError`; does NOT
  show that message for a generic `Error`; the error view
  renders the message and a back button.
- `apps/desktop/src-tauri/tests/lan_protocol_e2e.rs` — the 3
  `let _ = joiner.join_send(...).await` lines (in
  `two_instance_host_silent_then_link_drops`,
  `two_instance_mid_handshake_disconnect`,
  `two_instance_post_protocol_disconnect`) are replaced with
  explicit `match` blocks that document the four allowed
  return values — `Ok(())`, `Err(PeerClosed)`,
  `Err(NotConnected)`, `Err(Io(_))` — and panic on anything
  else. The strong `PeerClosed` assertion (via `join_poll`)
  remains in `two_instance_tcp_drop_joiner_perspective`.

**Test counts:** 523 vitest tests across 54 files pass; 13
`lan_protocol_e2e` tests pass; 15 `lan_e2e` tests pass;
`cargo check --lib` clean; full `pnpm -r typecheck` clean;
full `pnpm -r build` clean.

**Status:** **FIXED**. The peer-drop path is now closed-loop
end-to-end: Rust → Tauri IPC → `LanTransport` → `PairingSession`
→ `MatchOrchestrator` → `MatchView` shows a dedicated
peer-disconnected message. Reconnecting on the same `LanState`
after a drop works (covered by
`two_instance_reconnect_after_tcp_drop` on the Rust side and the
"fresh LanTransport on the same LanState" vitest case on the TS
side). A live two-machine run is still required to confirm the
GUI behaviour matches — automated test pass does NOT equal GUI
acceptance (per Phase 16.4 brief § 四).

---

## § 6 — Verdict template

Fill this in after running § 1, § 2, § 3 on two physical machines.
Append the wire-level PASS/FAIL summary from `cargo test --test
lan_protocol_e2e` (already known: 13/13 PASS as of Phase 16.3).

```
PHASE 16.3 VERDICT — <your name>, <date>, <host OS / version>, <joiner OS / version>

Wire-level (cargo test --test lan_protocol_e2e): PASS (13/13)
Single-LanState regression (cargo test --test lan_e2e):      PASS (15/15)
Vitest workspace                                         : PASS (495/495)
pnpm -r typecheck                                        : PASS
pnpm -r build                                            : PASS
cargo check --lib (Rust ≥ 1.99, edition2024)              : PASS

§ 1 Happy path                              : PASS / FAIL
§ 2.1 Wrong code                            : PASS / FAIL
§ 2.2 No host running                       : PASS / FAIL
§ 2.3 UDP ok, TCP fails                     : PASS / FAIL
§ 2.4 No hello                              : PASS / FAIL
§ 2.5 Malformed hello                       : PASS / FAIL
§ 2.6 Peer exits during handshake           : PASS / FAIL
§ 2.7 Peer exits after match                : PASS / FAIL
§ 2.8 LLM key invalid                       : PASS / FAIL
§ 2.9 Cancel + re-pair                      : PASS / FAIL
§ 3.1 State transitions fire once           : PASS / FAIL
§ 3.2 One orchestrator per pairing          : PASS / FAIL
§ 3.3 One match_request / response          : PASS / FAIL
§ 3.4 Disconnect cleans up                  : PASS / FAIL
§ 3.5 Three cycles, no accumulation         : PASS / FAIL
§ 3.6 Hard kill propagates                  : PASS / FAIL
§ 4.7 No-LLM shortest manual flow           : PASS / FAIL

Overall: PASS / FAIL / PARTIAL
Notes: <paste log excerpts of any failure; reference § 5 for known gaps>
```

Save as `docs/phase16/results-<date>-<initials>.md` and commit.
