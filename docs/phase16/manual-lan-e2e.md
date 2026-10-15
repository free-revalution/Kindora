# Phase 16 — Real Two-Instance LAN Verification

**Status:** NOT_RUN from automation. **Required:** manual execution by a human
on two physical machines (or two VM instances) on the same LAN.

This document is the reproducible manual test flow + per-scenario acceptance
table. The Claude session that produced it had no GUI driver and no LLM API
key, so it could not run the two Tauri instances itself — it is being
honest about that. The code-review fixes it did make (see
`commit c5da270 + Phase 16 patches` below) close two real bugs found in § V
of the task brief.

---

## § 0 — Pre-flight (one-time)

1. On machine A and machine B, each:
   - Clone the repo: `git clone git@github.com:free-revalution/Kindora.git`.
   - Check out `c5da270` (Phase 15) plus the Phase 16 fix commit (this
     document is shipped in that commit). `git log -1` to confirm.
   - Install Node 20+, pnpm 9+, Rust stable (1.99 recommended; 1.77
     fails on `edition2024` in `apps/desktop/src-tauri`).
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

| § | Scenario | A (host) action | B (joiner) action | Expected (both) |
|---|----------|-----------------|-------------------|-----------------|
| 2.1 | **Wrong pairing code** | (none) | type a wrong 6-char code; click Join | joiner shows "No peer found on the LAN for code \"XXXXXX\". Check that both devices are on the same network and that the host is running." host stays on "Waiting for the other person to enter this code…". No LLM call, no match screen, no false-positive match result. |
| 2.2 | **No host running** | (host app closed) | type a code; click Join | joiner shows the same "No peer found on the LAN for code …" error within ~2.5 s. No LLM call. |
| 2.3 | **UDP discoverable, TCP fails** | start host, then block the host's random TCP port at the firewall (or take the host's IP offline right after UDP announce) | type the code; click Join | joiner gets either a TCP connect timeout (≤ 8 s) or the discover-then-link-failed error. joiner stays on ConnectView; never enters MatchView; LLM not called. host (if reachable) stays on "Waiting for the other person to enter this code…" until timeout. |
| 2.4 | **TCP up, no `hello` from peer** | start host | open `nc -l <random_port_from_logs>` (or any stub) on B's side AFTER link is up; do NOT send any envelope | host's MatchView shows "preparing match…" for ≤ 5 s, then an error banner: "Peer did not send a hello envelope within 5000 ms." No match result. Session returns to "closed". The blocked TCP stub eventually gets disconnected by host. No LLM call. |
| 2.5 | **Malformed `hello`** | start host | use a raw TCP tool (e.g. `nc`) to send a `hello` whose `sender` is a non-UUID, or whose `payload.displayName` is missing | host's MatchView shows the typed error (`HandshakeValidationError` surfaced as a user-readable banner) within ≤ 5 s. No match result. Session closed. No LLM call. |
| 2.6 | **Peer exits during handshake** | start host, both linked, host in MatchView | quit B's app (Cmd+Q / Alt+F4) | host's MatchView shows a transport-disconnect error within ≤ 1 s; session is "closed"; no match result; no zombie `lan_` processes. |
| 2.7 | **Peer exits after match** | both reached MatchView, both see results | B quits the app | A's MatchView shows the peer-disconnect error; A returns to Home cleanly. |
| 2.8 | **LLM API key invalid** | both with an invalid LLM key (e.g. wrong region) | (normal) | both reach MatchView, the orchestrator's local LLM call fails; MatchView shows a typed `analyzeMatch` error (the LLM error message). No false-positive match shown. (Note: per § 23 each side runs its OWN analysis — the orchestrator surfaces a degraded analysis on LLM failure.) |
| 2.9 | **Cancel + re-pair** | start host, get code | start joiner; on ConnectView, click "Cancel" | joiner returns to Home; host sees TCP disconnect, returns to "Waiting for the other person…". Restart the joiner, type the same code, repeat § 1 — must succeed. |

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

| § | Check | Expected |
|---|-------|----------|
| 3.1 | ConnectView mounts once; click Host; observe session state changes | `idle → hosting → tcp-connected → connected`. `connected` fires ONCE. (Phase 16 patch closes the bug where the listener fired on BOTH `tcp-connected` and `connected`.) |
| 3.2 | Watch `MatchOrchestrator` in dev tools | One instance per pairing. Re-renders do NOT spawn a second orchestrator. (Phase 16 patch caches the orchestrator on the bridged handle and the orchestrator itself throws on a second `start()`.) |
| 3.3 | Network panel / app log | Exactly ONE `match_request` outbound, ONE `match_response` inbound, per side. |
| 3.4 | Click "Disconnect" in MatchView | session goes to `closed`; Rust `lan_host_poll` / `lan_join_poll` invocations stop; `setInterval` cleared; no leftover timers in the Chrome devtools "Performance" → "Timers" view. |
| 3.5 | Repeat § 1 three times in a row (Disconnect → Connect → Disconnect → Connect) | Each cycle is clean. No listener / timer accumulation. The host's Rust process exits cleanly on each cycle (`ps aux | grep lan_` should be empty). |
| 3.6 | Kill A's app from the OS while in MatchView | B's MatchView shows peer-disconnect error within ≤ 1 s. B's session is `closed`. B's `lan_join_poll` stops. |

**Mark § 3 as `PASS` if no state / listener / timer / log anomalies.**

---

## § 4 — Logs to capture (per side)

Save these on both machines for the § 1 happy path:

```bash
# On the desktop dev console (or pnpm --filter @kindora/desktop tauri dev)
# grep for these tokens in the renderer console + the Rust stderr:
grep -nE "lan_announce|lan_invite|linked=|tcp-connected|notifyHelloReceived|match_request|match_response|MatchOrchestrator" \
  ~/Library/Logs/kindora/*.log
```

What you should see, in order (simplified):

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

---

## § 5 — Verdict template

Fill this in after running § 1, § 2, § 3:

```
PHASE 16 VERDICT — <your name>, <date>, <host OS / version>, <joiner OS / version>

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
Notes: <paste log excerpts of any failure>
```

Save as `docs/phase16/results-<date>-<initials>.md` and commit.
