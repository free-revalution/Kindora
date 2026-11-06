# LAN security coverage — H2 ledger

**Task book:** `docs/修复.md` § 十一 Phase H, **H2：建立 LAN 安全测试**
(lines 1049–1077).

**What H2 asks for.** Thirteen security scenarios must each have a
_repeatable automated test_:

|   # | Scenario (task book wording)                   |
| --: | ---------------------------------------------- |
|   1 | 未知设备连接 — an unknown device connects      |
|   2 | 身份伪造 — identity forgery                    |
|   3 | 重放攻击 — replay                              |
|   4 | 消息篡改 — message tampering                   |
|   5 | 非法帧 — malformed frame                       |
|   6 | 超大帧 — oversized frame                       |
|   7 | 高频消息 — message flood                       |
|   8 | 非法 UTF-8 — invalid UTF-8                     |
|   9 | 中途断开 — mid-session disconnect              |
|  10 | 断线重连 — reconnect                           |
|  11 | 黑名单 — block list                            |
|  12 | 隐私字段过滤 — privacy-field filtering         |
|  13 | 未授权资料交换 — unauthorised profile exchange |

**What this document is.** A ledger that says, for each scenario, **which
automated test pins it down** — file, test name, and what the assertion
actually proves — plus the commands to re-run them. It is a _mapping_, not a
new test suite: every case listed below already existed in the tree before
this ledger was written (the Phase A/B/C/D/F remediations produced most of
them). The ledger exists because the task book's acceptance criterion is
"关键安全场景全部有可重复的自动化测试" — and that is only checkable if the
mapping from scenario to test is written down somewhere.

**Status (2026-11-06, the eighteenth batch):** the scenarios below are
`IMPLEMENTED` — every one has a named, repeatable test. Whether those suites
are **green** is tracked separately in
[`REMEDIATION_TEST_REPORT.md`](../REMEDIATION_TEST_REPORT.md) and
[`REMEDIATION_PROGRESS.md`](../REMEDIATION_PROGRESS.md); as of this writing
the five TypeScript suites that carry scenarios 2, 3, 4, 10, 11, 12 and 13
came back green on 2026-11-06, while the four Rust suites that carry
scenarios 1, 5, 6, 7, 8, 9 and 10 were last run green on 2026-11-04 and have
**not** been re-run since the Rust changes. H2 is **not** `VERIFIED`.

---

## The layer model — read this before the table

Kindora's LAN path has three layers, and _which_ layer a test drives decides
what it proves:

```
┌──────────────────────────────────────────────────────────────┐
│ 3. Session layer (TypeScript)                                │
│    PairingSession — fingerprint pinning, ES256 per envelope, │
│    replay guard, ECDH/HKDF/AES-256-GCM session cipher        │
├──────────────────────────────────────────────────────────────┤
│ 2. Protocol layer (TypeScript, @kindora/protocol)            │
│    envelope validation, sensitive-field guard, privacy       │
│    filter, consent state machine, block list                 │
├──────────────────────────────────────────────────────────────┤
│ 1. Transport layer (Rust, apps/desktop/src-tauri/src/lan.rs) │
│    UDP discovery, TCP length-prefixed frames, frame-size /  │
│    rate limits, UTF-8 validation                             │
└──────────────────────────────────────────────────────────────┘
```

**Layer 1 is an unauthenticated byte pipe — by design.** Any process that can
reach the TCP port can open a link; the Rust `LanState` will accept it. That
is _not_ an oversight and the task book does not ask for it to change:
Phase A put authentication in layer 3 (the A3 handshake pins the peer's
public key inside the fingerprint the user was shown, and every envelope is
ES256-signed). So "an unknown device connects" is **rejected at layer 3, not
at layer 1** — and the ledger below says which layer each test drives, so
nobody reads "the host accepted the TCP connection" as "the host accepted
the peer".

---

## Scenario ledger

### 1 — 未知设备连接 (an unknown device connects)

|            |                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `apps/desktop/src-tauri/tests/lan_e2e.rs:480` — `host_refuses_unknown_code_during_discovery`                                                                                                            |
| **Layer**  | 1 (transport)                                                                                                                                                                                           |
| **Proves** | Discovery matches **by code**, not by mere presence: a host started with code `REALCD` does not answer a discover for `FAKECD`. A device that does not know the pairing code cannot even find the host. |
| **Also**   | `lan_e2e.rs:376` `discover_filters_by_code` — the same contract from the joiner's side.                                                                                                                 |

The second half of the scenario — _a peer that reached the socket but is not
who we paired with_ — is covered at layer 3 by scenario 2 below.

### 2 — 身份伪造 (identity forgery)

|            |                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/transport/src/__tests__/pairing-session-a3.test.ts:250` — `rejects a peer whose fingerprint is not the one the user was shown`                                                                                                                                                                                                                       |
| **Layer**  | 3 (session)                                                                                                                                                                                                                                                                                                                                                    |
| **Proves** | The joiner believes the host's fingerprint is `ZZZZZZ`; the host's real fingerprint is different. The session closes with `closeReason === 'peer-fingerprint-mismatch'`, `sessionEncrypted === false`, and the transport is disconnected. **No data was exchanged.** This is the "未知设备" defence: the pairing code is not a secret, the _key_ behind it is. |

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/protocol/src/__tests__/signature.test.ts` — `fails against a different public key`; also `fails when the payload is altered`, `fails when the sender is altered`, `fails when the message type is altered`, `fails when the timestamp or the message id is altered`, `binds the signature to one recipient`, `fails when the signature value is altered`, `rejects a malformed or wrongly-sized signature value`, `rejects a public key blob that is not a key at all` |
| **Layer**  | 2 (protocol)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Proves** | ES256 verification fails for _any_ substitution — a different key, a different sender, a different type, a mutated timestamp, a mutated id, a mutated signature blob, a signature bound to a different recipient. An envelope signed by somebody who is not the peer does not verify.                                                                                                                                                                                            |

|            |                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/transport/src/__tests__/pairing-session-a3.test.ts:264` — `drops an unsigned envelope and tears the session down after three of them`                                               |
| **Layer**  | 3 (session)                                                                                                                                                                                   |
| **Proves** | Three envelopes that bypass the session and go out **unsigned** are dropped; the session closes with `closeReason === 'signature-invalid'` and **not one of them reached a message handler**. |

### 3 — 重放攻击 (replay)

|            |                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/transport/src/__tests__/pairing-replay.test.ts` — `drops a replayed envelope instead of delivering it twice`, `drops an envelope whose timestamp is outside the freshness window`, `drops an envelope whose timestamp is too far in the future`, `still delivers an envelope with a fresh messageId`, `delivers the replay when the guard is switched off` |
| **Layer**  | 3 (session)                                                                                                                                                                                                                                                                                                                                                          |
| **Proves** | The inbound replay guard drops a re-delivered `messageId`, and drops anything outside the freshness window — in either direction of clock skew. The last case is the **control**: with the guard switched off the replay _is_ delivered, so the test is measuring the guard and not the harness.                                                                     |

|            |                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**  | `packages/protocol/src/__tests__/replay-protection.test.ts` — `accepts a fresh envelope`, `rejects a duplicate messageId`, `rejects a message older than maxAgeMs`, `rejects a message timestamped far in the future`, `evicts the oldest entries when capacity is exceeded`, `reset clears all state`, `throws on invalid constructor options`, `rejects malformed timestamp defensively` |
| **Layer**  | 2 (protocol)                                                                                                                                                                                                                                                                                                                                                                               |
| **Proves** | The protocol-layer `ReplayGuard` on its own: duplicate ids, stale timestamps, future timestamps, bounded memory.                                                                                                                                                                                                                                                                           |

|            |                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `apps/desktop/src-tauri/tests/lan_protocol_e2e.rs` — the KSA 0.1 envelope contract over a real socket (validate → serialise → replay-guard → rate-limit) |
| **Layer**  | 1 + 2 (transport, real socket)                                                                                                                           |
| **Proves** | The same guard and rate limiter hold on a **real TCP socket**, not only in-process.                                                                      |

### 4 — 消息篡改 (message tampering)

|            |                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/transport/src/__tests__/session-crypto.test.ts` — `rejects a tampered ciphertext`, `rejects a tampered additional authenticated data`, `rejects a swapped nonce`, `cannot be opened with a different session key`, `refuses to seal an envelope that does not validate`                                                                                                                        |
| **Layer**  | 3 (session cipher)                                                                                                                                                                                                                                                                                                                                                                                       |
| **Proves** | AES-256-GCM catches a mutated ciphertext, mutated AAD, a swapped nonce and a wrong key. The AAD is computed **from the frame alone**, and the header is bound into the tag — so an attacker cannot rewrite the envelope header (protocol, type, sender, message id, timestamp) without breaking the tag. `binds the signature into the authentication tag` closes the same hole for the signature field. |

### 5 — 非法帧 (malformed frame)

|            |                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `apps/desktop/src-tauri/tests/lan_protocol_e2e.rs` — `two_instance_malformed_hello_is_delivered`                                                                              |
| **Layer**  | 1 + 2 (real socket)                                                                                                                                                           |
| **Proves** | A `hello` envelope that does not satisfy the protocol contract does **not** crash the receiver and does **not** advance the handshake — it is surfaced as a rejected message. |

|            |                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/protocol/src/__tests__/validation.test.ts` — the envelope validator's own rejection table                                                                                           |
| **Layer**  | 2 (protocol)                                                                                                                                                                                  |
| **Proves** | Every field-level rule of the KSA 0.1 envelope (protocol, version, type, sender, message id, timestamp, payload shape) rejects a malformed value rather than accepting a partially-valid one. |

### 6 — 超大帧 (oversized frame)

|            |                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `apps/desktop/src-tauri/tests/lan_limits.rs:130` — `oversized_frame_is_rejected_and_drops_the_link`                                                                                                                                                     |
| **Layer**  | 1 (transport, real TCP)                                                                                                                                                                                                                                 |
| **Proves** | A peer that announces a **32 MiB** frame is rejected **on the length prefix alone** — the reader must not reserve the memory the peer claims. The host reports `LanError::LimitExceeded` and drops the link. This is the Phase C / C1 frame-size limit. |

### 7 — 高频消息 (message flood)

|            |                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `apps/desktop/src-tauri/tests/lan_limits.rs:182` — `flooding_past_the_rate_limit_drops_the_link`                                                      |
| **Layer**  | 1 (transport, real TCP)                                                                                                                               |
| **Proves** | 200 tiny frames inside one one-second window exceed the 50 msg/s per-connection limit; the host reports `LanError::LimitExceeded` and drops the link. |

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Where**  | `packages/transport/src/__tests__/wire-rate-limiter.test.ts` — `defaults to 10 outbound and 30 inbound capacity`, `checkOutbound throws once the bucket is exhausted`, `checkInbound returns false when the bucket is empty (no throw)`, `refills both buckets over time`, `records stats correctly`, `reset returns both buckets to full and zeroes counters`                                                                                                                                                                                                                                                                                                           |
| **Where**  | `packages/protocol/src/__tests__/rate-limiter.test.ts` — `starts full so the first burst is allowed`, `rejects once the bucket is empty`, `refills lazily based on elapsed wall-clock time`, `caps tokens at capacity even after a long idle`, `tryConsume(n) consumes multiple tokens atomically`, `tryConsume(0) is a no-op success`, `tryConsume with a negative amount throws`, `rejects capacity <= 0`, `rejects refillPerSecond <= 0`, `snapshot returns capacity / refillPerSecond / current tokens`, `reset returns the bucket to full`, `rateLimiter() convenience constructor matches the N-per-second contract`, `does not advance when clock goes backwards` |
| **Layer**  | 2 (protocol)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Proves** | A token bucket, not a fixed window: capacity, refill rate, atomic multi-token consumption, negative-amount rejection, and — importantly — **the clock cannot be walked backwards** to refill faster.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 8 — 非法 UTF-8 (invalid UTF-8)

|            |                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `apps/desktop/src-tauri/tests/lan_limits.rs:158` — `invalid_utf8_body_marks_the_peer_closed`                                                                                                                                                                                                            |
| **Layer**  | 1 (transport, real TCP)                                                                                                                                                                                                                                                                                 |
| **Proves** | A frame whose body is `[0xff, 0xfe, 0xfd]` is rejected and the peer is reported as **gone with the reason attached** (`LanError::Invalid`) — not as a clean local teardown. That distinction is the Phase C / C2 fix: a protocol violation must not be indistinguishable from the user closing the app. |

### 9 — 中途断开 (mid-session disconnect)

|            |                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `apps/desktop/src-tauri/tests/lan_protocol_e2e.rs` — `two_instance_mid_handshake_disconnect`, `two_instance_post_protocol_disconnect`, `two_instance_cancel_and_repair`, `two_instance_tcp_drop_joiner_perspective`, `two_instance_tcp_drop_host_perspective`, `two_instance_local_cancel_does_not_set_peer_closed` |
| **Layer**  | 1 + 2 (real socket, two `LanState`s)                                                                                                                                                                                                                                                                                |
| **Proves** | A drop **during** the handshake and a drop **after** it are both detected, and both ends reach a consistent state. The last case pins the distinction that matters most: a **local** cancel must **not** set `peer closed`, or the UI would blame the other person for the user's own disconnect.                   |

### 10 — 断线重连 (reconnect)

|            |                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| **Where**  | `apps/desktop/src-tauri/tests/lan_protocol_e2e.rs` — `two_instance_reconnect_after_tcp_drop`            |
| **Layer**  | 1 + 2 (real socket)                                                                                     |
| **Proves** | After a TCP drop, both instances can re-establish the link and carry envelopes again over real sockets. |

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/transport/src/__tests__/pairing-session-c3.test.ts` — `disconnect releases the message handler and the close handler`, `resetForReconnect releases the message handler and the close handler`, `after a reset the old transport can no longer feed the session`, `a reconnect does not stack a second handler on the transport`, `resetForReconnect returns the FSM to idle and forgets the peer`, `the peer id cannot be reused after a reset`, `after a reset the session can host again on a fresh transport`, `resetForReconnect mints a fresh ephemeral key pair`, `the anti-replay guard survives a reset`, `walks the whole C3 § 8 lifecycle` |
| **Layer**  | 3 (session)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Proves** | The Phase C / C3 reconnect contract: handlers are released (no leak, no double-dispatch), the old transport is neutered, the peer identity is forgotten, a **fresh ephemeral key pair** is minted for the new session (the old session key is not reused), and the anti-replay guard survives the reset.                                                                                                                                                                                                                                                                                                                                                       |

|            |                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/transport/src/__tests__/connection-state.test.ts` — `starts idle`, `reports whether a transition actually changed the state`, `notifies subscribers on a change, and only on a change`, `does not replay the current state to a late subscriber`, `unsubscribes cleanly`, `a throwing subscriber does not silence the other subscribers`, `a subscriber may subscribe while a notification is being dispatched` |
| **Layer**  | 3 (session)                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Proves** | The state machine itself: transitions are idempotent, subscribers are notified only on a real change, a late subscriber does not get a spurious replay, and one throwing subscriber cannot silence the others.                                                                                                                                                                                                            |

### 11 — 黑名单 (block list)

|            |                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/matching/src/__tests__/match-orchestrator.test.ts` — `the block-list guard refuses the peer BEFORE any profile is sent`, `refuses a peer that was blocked AFTER the consent but BEFORE the profile exchange`, `the block-list guard runs before the consent check, so nothing is sent either way`, `an unblocked peer still passes the phase-2 guard` |
| **Layer**  | 2 (protocol)                                                                                                                                                                                                                                                                                                                                                    |
| **Proves** | The guard reads the store **directly**, so it cannot be bypassed by skipping the UI — and it runs **before** anything goes out, including before the consent exchange. The last case is the control: the guard is not simply refusing everybody.                                                                                                                |

|            |                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/matching/src/__tests__/consent-orchestrator.test.ts` — `transitions to blocked when local user blocks, persists to block list`, `transitions to blocked when peer blocks, persists their id locally`, `decide() is idempotent — a second click throws` |
| **Where**  | `packages/matching/src/__tests__/integration.test.ts` — `block from one side terminates both sessions and adds to block list`                                                                                                                                    |
| **Where**  | `packages/storage/src/__tests__/blocked-agents-store.test.ts` — the store's own persistence contract                                                                                                                                                             |
| **Where**  | `apps/desktop/src/views/__tests__/privacy-boundaries.test.tsx` — 13 cases over the management screen (list, unblock, block timestamp, the pre-send guard in the UI)                                                                                              |
| **Layer**  | 2 + 3 (protocol, storage, UI)                                                                                                                                                                                                                                    |
| **Proves** | Blocking from either side ends the session and persists the id; the block survives a restart; the management screen actually works.                                                                                                                              |

### 12 — 隐私字段过滤 (privacy-field filtering)

|            |                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/protocol/src/__tests__/profile-privacy-filter.test.ts` — **26 cases**                                                                                                                     |
| **Layer**  | 2 (protocol)                                                                                                                                                                                        |
| **Proves** | Only the fields the user authorised leave the device, per-field; the outbound copy is deep enough that mutating it cannot reach the source; and a withheld field cannot leak through a nested path. |

|            |                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/protocol/src/__tests__/sensitive-field-guard.test.ts` — **30 cases**, including `REFUSES a structure nested deeper than maxDepth instead of skipping it`, `SCANS a string longer than the scan window instead of skipping it`, `finds a credential that straddles a chunk boundary`, `F1 case: a circular structure is refused`, `formatSensitiveFieldError returns a generic message — never the offending value` |
| **Layer**  | 2 (protocol)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Proves** | A credential in a payload is **refused, not passed through** — including the cases a naive filter skips (too deep, too long, circular) and the case where the error message must not echo the secret.                                                                                                                                                                                                                        |

### 13 — 未授权资料交换 (unauthorised profile exchange)

|            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**  | `packages/matching/src/__tests__/match-orchestrator.test.ts` — `nothing but the public card is sent before the consent`, `the profile_exchange carries only the public card`, `exchangeAndMatch refuses without a mutual consent`, `exchangeAndMatch refuses a consent that belongs to a different peer`, `exchangeAndMatch refuses when the peer rejected`, `a forged peer consent cannot widen the local authorisation`, `the match_request carries the authorised profile — withheld fields are removed`, `a revocation between the phases is honoured (the boundaries are read at send time)` |
| **Layer**  | 2 (protocol)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Proves** | The two-phase exchange: **before** consent only the minimal public card crosses the wire; the full profile goes out **only** after both sides have consented; a consent belonging to a _different_ peer is refused; a forged peer consent cannot widen the local authorisation; and a field the user revoked **between** the two phases is still withheld, because the boundaries are read at send time rather than cached at consent time.                                                                                                                                                       |

---

## Reproducing the whole ledger

```bash
# layer 3 + 2 — the TypeScript suites that carry scenarios 2, 3, 4, 10, 11, 12, 13
pnpm -C packages/protocol test      # validation, replay, signature, sensitive-field guard, privacy filter
pnpm -C packages/transport test     # A3 handshake, session cipher, C3 reconnect, rate limiter, WebRTC stub
pnpm -C packages/matching test      # consent state machine, block list, two-phase exchange
pnpm -C packages/storage test       # the block-list store and its persistence
pnpm -C apps/desktop test           # the privacy-boundary UI (13 cases)

# layer 1 — the Rust suites that carry scenarios 1, 5, 6, 7, 8, 9, 10
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test lan_e2e        -- --test-threads=1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test lan_protocol_e2e -- --test-threads=1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test lan_limits      -- --test-threads=1
```

The three integration suites need `-- --test-threads=1`: `lan_protocol_e2e` and
`lan_limits` share one fixed UDP port (53100) and race each other for it
under parallel execution; `lan_e2e` allocates a unique port per `LanState`
but is run single-threaded too so all three suites behave identically. This
matches `.github/workflows/ci.yml` exactly.

The local step-by-step runner is `.cache/verify.sh`; its steps
`01-protocol-test` … `06-desktop-test` cover the TypeScript half, and
`09a`–`09c2` cover the Rust half.

---

## What this ledger does **not** cover

Stated plainly, because the task book asks for the difference between
automated and real-device testing to be explicit (§ 十二 Phase I, item 11).

1. **No two-machine test.** Every test above runs both ends inside one
   process, or over the loopback interface. The Rust integration suites use
   **real UDP and real TCP sockets**, but still both ends in one process.
   H3 (the real two-device GUI walkthrough) is the only thing that closes
   this, and it is **`BLOCKED`** — it needs two physical machines and a
   human. See [`manual-lan-e2e.md`](manual-lan-e2e.md).
2. **No test drives the real Tauri window.** The LAN transport is tested at
   the Rust socket layer and through a JavaScript IPC shim
   (`apps/desktop/src/lib/lan-connect-service.ts`), not through React
   against a live Tauri webview.
3. **No real LLM in the path.** The consent, block-list and profile-exchange
   tests use a stub LLM provider. The _decisions_ are covered; the model's
   behaviour on a hostile profile is not.
4. **Layer 1 has no authentication of its own**, by design — see the layer
   model above. A scenario list that reads "unknown device connects" as a
   transport-layer requirement would be wrong: the transport is a byte pipe,
   and the trust decision happens in layer 3.
5. **The frame-size and rate limits are per connection, not per host.**
   A peer that reconnects often gets a fresh budget. That is the documented
   design (Phase C / C1), not an oversight, but it means the flood test
   proves "one connection cannot flood" — not "one host cannot flood".

---

## Status

| Field                                          | Value                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Task**                                       | H2 — 建立 LAN 安全测试                                                                                                                                                                           |
| **Status**                                     | `IMPLEMENTED`                                                                                                                                                                                    |
| **Ledger written**                             | 2026-11-06 (the nineteenth batch)                                                                                                                                                                |
| **Scenarios with a repeatable automated test** | 13 / 13                                                                                                                                                                                          |
| **New test cases added by this ledger**        | 0 — the ledger maps existing tests; it does not add any                                                                                                                                          |
| **Why not `VERIFIED`**                         | The suites that carry the Rust half have not been re-run since the Rust changes, and H3 (the real two-device walkthrough) is `BLOCKED`. Per the task book, 自动化模拟测试不能代替真实双设备验收. |
| **Tracking**                                   | [`REMEDIATION_PROGRESS.md`](../REMEDIATION_PROGRESS.md) (Phase H), [`REMEDIATION_TEST_REPORT.md`](../REMEDIATION_TEST_REPORT.md) § 8.8.18                                                        |
