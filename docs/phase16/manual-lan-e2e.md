# Phase 16 — Real Two-Instance LAN Verification

**Status (Phase 16.1 calibration):**

| Layer | Outcome |
|-------|---------|
| Two-LanState protocol test (`cargo test --test lan_protocol_e2e`) | **PASS** (9/9 — `connect_two` over real UDP/TCP, real JSON envelopes, no LLM, no GUI, no LoopbackHub) |
| Single-LanState regression (`cargo test --test lan_e2e`) | **PASS** (15/15 unchanged) |
| Real two-OS-process run on two physical machines | **NOT_RUN** (no GUI driver + no LLM API key in the Claude session) — see § 6 manual below |
| Code-review fixes from Phase 16 | landed in commit `353f2d2` (ConnectView double-fire, LAN bridged handle orchestrator caching) |
| Defense-in-depth reentrancy guard | landed in `packages/matching/src/orchestrator.ts` (Phase 16) |

**Bottom line:** the wire-level LAN protocol (UDP discover + TCP length-prefixed
JSON envelope flow) is now provably correct via the new
`apps/desktop/src-tauri/tests/lan_protocol_e2e.rs` suite. The
above-the-wire layer (TS `PairingSession` FSM, `MatchOrchestrator`, the React
`ConnectView` / `MatchView`) still needs a human on two physical machines
because it requires a GUI driver and a real LLM API key.

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
`apps/desktop/src-tauri/tests/lan_protocol_e2e.rs` — **PASS**es (9/9
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

| § | Scenario | A (host) action | B (joiner) action | Expected (both) | Verdict (Phase 16.1) |
|---|----------|-----------------|-------------------|-----------------|----------------------|
| 2.1 | **Wrong pairing code** | (none) | type a wrong 6-char code; click Join | joiner shows "No peer found on the LAN for code \"XXXXXX\". Check that both devices are on the same network and that the host is running." host stays on "Waiting for the other person to enter this code…". No LLM call, no match screen, no false-positive match result. | **NOT_RUN** (manual). Wire-level analogue: `join_with_no_host_returns_empty` (single-instance, `lan_e2e.rs`) **PASS**es. The two-instance analogue: `join_discover` for an unknown code returns `[]` (covered by `two_instance_cancel_and_repair` first half — **PASS**). |
| 2.2 | **No host running** | (host app closed) | type a code; click Join | joiner shows the same "No peer found on the LAN for code …" error within ~2.5 s. No LLM call. | **NOT_RUN** (manual). Wire-level analogue: same as 2.1. |
| 2.3 | **UDP discoverable, TCP fails** | start host, then block the host's random TCP port at the firewall (or take the host's IP offline right after UDP announce) | type the code; click Join | joiner gets either a TCP connect timeout (≤ 8 s) or the discover-then-link-failed error. joiner stays on ConnectView; never enters MatchView; LLM not called. host (if reachable) stays on "Waiting for the other person to enter this code…" until timeout. | **NOT_RUN** (manual). No automated coverage (LAN test uses loopback; firewall rules can't be exercised in-process). |
| 2.4 | **TCP up, no `hello` from peer** | start host | open a stub TCP listener (use § 4.5 helper) on B's side AFTER link is up; do NOT send any envelope | host's MatchView shows "preparing match…" for ≤ 5 s, then an error banner: "Peer did not send a hello envelope within 5000 ms." No match result. Session returns to "closed". The stub TCP gets disconnected by host. No LLM call. | **NOT_RUN** (manual). Wire-level analogue: `two_instance_host_silent_then_link_drops` — the joiner side does not get any envelopes while the host is silent — **PASS**. The 5-second hello gate is enforced on the TS side (`MatchOrchestrator`, `helloTimeoutMs = 5000`); not re-tested in the two-process suite. |
| 2.5 | **Malformed `hello`** | start host | use § 4.5 helper to send a properly framed `hello` whose `sender` is a non-UUID, or whose `payload.displayName` is missing | host's MatchView shows the typed error (`HandshakeValidationError` surfaced as a user-readable banner) within ≤ 5 s. No match result. Session closed. No LLM call. | **NOT_RUN** (manual). Wire-level analogue: `two_instance_malformed_hello_is_delivered` — the wire passes the bytes through verbatim; validation is the TS-side `validatePeerHello`'s job. **PASS**. |
| 2.6 | **Peer exits during handshake** | start host, both linked, host in MatchView | quit B's app (Cmd+Q / Alt+F4) | host's MatchView shows a transport-disconnect error within ≤ 1 s; session is "closed"; no match result; no zombie `lan_` processes. | **NOT_RUN** (manual). **Documented gap** (see § 5.1): the Rust LAN transport has no out-of-band peer-drop detection. The host only finds out on its NEXT `host_send` attempt (or `host_poll` returns `Disconnected` from the closed inbox). On the TS side, `PairingSession` propagates this and the orchestrator surfaces a typed `HandshakeClosedError` to `MatchView`. The two-process test `two_instance_mid_handshake_disconnect` **PASS**es the wire-level fact (joiner's `join_send` after `host_stop` is a no-op on the kernel level; only the host-side `host_linked` flips false). |
| 2.7 | **Peer exits after match** | both reached MatchView, both see results | B quits the app | A's MatchView shows the peer-disconnect error; A returns to Home cleanly. | **NOT_RUN** (manual). Same gap as 2.6. |
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
| 3.6 | Kill A's app from the OS while in MatchView | B's MatchView shows peer-disconnect error within ≤ 1 s. B's session is `closed`. B's `lan_join_poll` stops. | **NOT_RUN** (manual). Documented gap: see § 5.1. |

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
9-test PASS log in `target/debug/deps/...`. Each test exercises the
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

| § | Scenario | Needs LLM? | Phase 16.2 status |
|---|----------|-----------|-------------------|
| § 1 (rows 1-5) | ConnectView renders, host code visible, peer discovery, TCP connect, state transitions to `tcp-connected` / `connected` | NO | NOT_RUN (no GUI driver in the Claude session); wire-level analogue `two_instance_discovery_and_link` **PASS** |
| § 1 (rows 6-7) | MatchOrchestrator runs `analyzeMatch`, MatchView shows the 5 result fields, peer display name + agent id match | YES | NOT_RUN |
| § 1 (row 8) | Disconnect cleans up the session | NO | wire-level: `lan_e2e.host_linked_becomes_false_after_stop` **PASS** |
| § 2.1, § 2.2, § 2.9 | Wrong code / no host / cancel + re-pair (Cancel fix verified in Phase 16.2) | NO | new `ConnectView.test.tsx` **PASS** (8/8); wire-level analogues **PASS** |
| § 2.3 | UDP discoverable, TCP fails (firewall block) | NO | NOT_RUN (firewall needs OS access) |
| § 2.4 | TCP up, no hello from peer | NO | NOT_RUN (needs GUI); `two_instance_host_silent_then_link_drops` **PASS** |
| § 2.5 | Malformed hello | NO | NOT_RUN (needs GUI); `two_instance_malformed_hello_is_delivered` **PASS** |
| § 2.6, § 2.7 | Peer exits during/after handshake | NO | NOT_RUN (needs GUI); wire-level analogues **PASS** |
| § 2.8 | LLM API key invalid | YES | NOT_RUN |
| § 3.1, § 3.2 | State transitions fire once, one orchestrator per pairing | NO | NOT_RUN (DevTools); fix is in code (Phase 16 patch + reentrancy guard); `match-orchestrator.test.ts` reentrancy test **PASS** |
| § 3.3 | Exactly one match_request/response per side | YES (for the response) | NOT_RUN |
| § 3.4, § 3.5, § 3.6 | Disconnect cleanup, three cycles, hard kill | NO | NOT_RUN (needs GUI) |

**Bottom line for a no-LLM manual run:** you can drive the full
discovery + TCP connect + state-transition path on two machines
WITHOUT configuring an LLM key. To do that, open both apps, click
Host on one and Join on the other, type the 6-char code, and verify
that the state transitions hit `tcp-connected` (which means
PairingSession + transport are both happy). You will see the
"preparing match…" banner in MatchView; without an LLM key the
`analyzeMatch` call will fail and the banner will show the error.
That is the expected boundary — it confirms the wire layer is
correct and the LLM layer is the only thing that needs a key.

---

## § 5 — Known gaps (calibrated against the actual code, Phase 16.1)

### § 5.1 — LAN transport has no out-of-band peer-drop detection

**Where:** `apps/desktop/src-tauri/src/lan.rs`,
`LanTransport.pollOnce` swallows errors silently, and the
`tcp_read_loop` only signals EOF via the inbox — `host_poll` /
`join_poll` call `try_recv` and `break` on `Disconnected`, returning
`Ok([])` rather than an error.

**Symptom:** if the peer process is killed (or the host process is
killed on the joiner's side), the surviving side's `host_send` /
`join_send` keeps succeeding until the TCP buffer fills or the OS
sends RST. The session only finds out about the drop on its NEXT
send attempt.

**Workaround in the TS layer:** `PairingSession` wraps each send in
a try/catch and surfaces the transport error to the orchestrator as
`HandshakeClosedError` (or similar). The `MatchOrchestrator` then
rejects the session and `MatchView` shows the disconnect banner.
This is what the § 2.6 / § 2.7 / § 3.6 manual runs exercise; it's
defense-in-depth, not a clean signal.

**Fix candidate (not in this commit):** have the read loop set a
`link_broken: AtomicBool` on the `TcpLink`, and have `host_poll` /
`join_poll` return `Err(LanError::PeerClosed)` when the flag is set.
Then the TS layer can short-circuit on the next poll and surface
the disconnect immediately.

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

---

## § 6 — Verdict template

Fill this in after running § 1, § 2, § 3 on two physical machines.
Append the wire-level PASS/FAIL summary from `cargo test --test
lan_protocol_e2e` (already known: 9/9 PASS as of Phase 16.1).

```
PHASE 16.1 VERDICT — <your name>, <date>, <host OS / version>, <joiner OS / version>

Wire-level (cargo test --test lan_protocol_e2e): PASS (9/9)
Single-LanState regression (cargo test --test lan_e2e):      PASS (15/15)

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

Overall: PASS / FAIL / PARTIAL
Notes: <paste log excerpts of any failure; reference § 5 for known gaps>
```

Save as `docs/phase16/results-<date>-<initials>.md` and commit.
