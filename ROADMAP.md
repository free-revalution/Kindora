# Roadmap

Kindora is an **experiment**, not a product with a delivery schedule. This file
is a direction, not a promise: unchecked items are genuinely not done, and no
dates are attached because none can be honestly committed to.

Legend:

- `[x]` — implemented **and** covered by automated tests
- `[ ]` — not done
- `[~]` — partially done; the note says exactly what is missing

> **`[x]` does not mean "verified on two real devices."** An automated suite
> runs in one process, on one machine, with a mocked LLM and a mocked secret
> store. The **manual two-device acceptance** is a separate item, still open,
> and it is tracked on its own. The phase-level status, with per-row evidence,
> is in [docs/REMEDIATION_PROGRESS.md](docs/REMEDIATION_PROGRESS.md).

The authoritative, per-feature status (with code evidence for every claim) is
[docs/DEVELOPMENT_STATUS.md](docs/DEVELOPMENT_STATUS.md). If the two ever
disagree, the status document wins.

---

## Phase 1 — V0.1 · Core experience

**Goal:** let a user experience the basic social-discovery flow.

- [x] Personal agent profile — create, edit, persist locally
- [x] Agent-to-agent matching — 5-field match report
- [x] Human consent flow — accept / reject / block / disconnect
- [x] Icebreaker generation — propose, use, edit, regenerate, skip
- [x] Basic chat — human-to-human, plus an "Ask My Agent" draft helper
- [x] Single-machine loopback verification
- [x] KSA 0.1 wire protocol — validation, replay guard, rate limiter
- [x] LAN transport at the socket layer — real UDP discovery + TCP channel
- [x] OS-keychain secret storage for API keys
- [x] English + 简体中文 UI
- [x] **Envelope signatures** — ES256 over an RFC 8785 canonical payload digest,
      bound to one recipient
- [x] **End-to-end encrypted LAN sessions** — ECDH P-256 + HKDF-SHA256 +
      AES-256-GCM, with the header and signature as the AEAD's AAD
- [x] **The agent's identity key in the OS keychain** (not `localStorage`)
- [x] **Pairing by identity fingerprint** — the host's public key, not a random code
- [x] **Privacy boundaries that gate the wire** — per-field consents in the UI,
      enforced by `packages/protocol/src/profile-privacy-filter.ts` _before_ a
      profile is serialised, not after it is sent
- [x] **Consent-gated profile exchange** — the peer's profile is withheld until
      the local user consents (`packages/matching/src/consent-orchestrator.ts`)
- [x] **Block list** — persisted, checked before the profile exchange, with a
      management screen
- [~] Tauri GUI normal startup — the app builds and launches; a complete
  two-machine session has **not** been driven through the GUI by hand
- [ ] LLM configuration verified against a **live** provider — every test mocks
      `fetch`, so real API schemas, auth headers and error shapes are unverified
- [ ] Two-device LAN verification in a real GUI session — verified at the Rust
      socket layer only
- [ ] A **Rust-side signer** — the identity key lives in the keychain but is
      read back into the webview to sign there. A Rust `agent_sign` command
      (with the `p256` crate) is not implemented

---

## Phase 2 — V0.2 · Reliable local-first experience

**Goal:** make daily local use and data management trustworthy.

- [x] SQLite persistence — `tauri-plugin-sql` is registered **and** called; the
      schema and its migration ledger live in
      `packages/storage/src/sql-migrations.ts`
- [x] Chat history persistence — every message is written down `PENDING`
      **before** it goes out, then `SENT` / `FAILED`; a received one is
      `DELIVERED` (KSA 0.1 has no delivery receipt, so an outbound message
      never claims `DELIVERED`)
- [x] Agent profile persistence beyond `localStorage` — the `profiles` /
      `agents` tables, with a one-time migration from the legacy copy
- [x] Secret storage hardened, and "what is at rest where" written down — see
      [SECURITY.md](SECURITY.md). The browser dev-mode fallback is the one
      documented exception
- [x] Block-list management screen — list, unblock, and the block timestamp
- [ ] Polish the pairing UX
- [ ] Stronger error recovery — a locked keychain, a dead peer, a half-saved
      config
- [ ] Desktop end-to-end automation (a real Tauri window in CI)
- [ ] QR-code pairing — payload helpers exist, no UI

---

## Phase 3 — V0.3 · Peer-to-peer connectivity

**Goal:** explore a complete peer-to-peer connection story.

- [ ] WebRTC DataChannel transport — `WebRtcTransport` is a stub today: every
      entry point throws a typed `WEBRTC_NOT_IMPLEMENTED`. The signalling
      contract and the capability cross-check between two peers are fixed, so
      the interface is ready for the DataChannel
- [ ] NAT traversal — STUN/TURN configuration
- [ ] Connection state management across the network boundary
- [ ] Reconnection after a dropped link
- [ ] Network failure handling (timeouts, half-open sockets)
- [ ] Cross-network connection testing
- [ ] Manual signaling (copy/paste SDP) as the first, simplest milestone
- [ ] DHT / rendezvous, relay — later still

---

## Phase 4 — V0.4 · Agent intelligence

**Goal:** improve how well agents understand and explain a potential connection.

- [ ] Matching algorithm improvements — better heuristics on top of the LLM pass
- [ ] A structured interest-tag taxonomy
- [ ] Better match explanations
- [ ] Stronger user social boundaries — finer-grained sharing controls
- [ ] Agent-to-Agent protocol improvements (negotiation, capability discovery)
- [~] Prompt-injection hardening — remote content is now **structured and
  labelled** as untrusted data instead of being concatenated into the
  system prompt, model output is schema-checked, and the sensitive-field
  guard rejects data it cannot verify rather than passing it through. The
  regex sanitiser is the **second** layer, not the only one — and no layer
  is a proof. What is still missing is an independent measure of how well
  this holds against a determined peer
- [ ] Multi-model adaptation beyond the four current provider kinds

---

## Phase 5 — V1.0 · Community-ready release

**Goal:** a stable, maintainable open-source project other people can rely on.

- [ ] Core flow stable across platforms
- [ ] Multi-device connection stability
- [ ] Data security audit
- [ ] Complete user documentation
- [ ] Complete developer documentation
- [ ] Multi-platform build and test matrix (macOS / Windows / Linux)
- [ ] Published installers and a tagged release
- [ ] Formal release process

---

## Deliberately out of scope

Kindora is exploring agent-mediated social discovery. The following are **not**
planned, and contributions in these directions will be declined:

- Ranking algorithms that decide what a user should see
- Paid placement, advertising, or sponsored results
- Data brokerage, profile marketplaces, or selling user data
- Replacing human conversation with agent-authored messages

The project exists to test one hypothesis: **can personal AI agents help people
discover meaningful human connections?** Everything in the phases above serves
that question.
