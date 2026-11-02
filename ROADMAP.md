# Roadmap

Kindora is an **experiment**, not a product with a delivery schedule. This file
is a direction, not a promise: unchecked items are genuinely not done, and no
dates are attached because none can be honestly committed to.

Legend:

- `[x]` — implemented **and** covered by automated tests
- `[ ]` — not done
- `[~]` — partially done; the note says exactly what is missing

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
- [~] Tauri GUI normal startup — the app builds and launches; a complete
      two-machine session has **not** been driven through the GUI by hand
- [ ] LLM configuration verified against a **live** provider — every test mocks
      `fetch`, so real API schemas, auth headers and error shapes are unverified
- [ ] Two-device LAN verification in a real GUI session — verified at the Rust
      socket layer only
- [ ] Private-key encryption at rest — the PKCS8 key is currently plaintext in
      `localStorage`

---

## Phase 2 — V0.2 · Reliable local-first experience

**Goal:** make daily local use and data management trustworthy.

- [ ] SQLite persistence — the `tauri-plugin-sql` plugin is registered but no
      TypeScript code calls it
- [ ] Chat history persistence — messages are lost on window close
- [ ] Agent profile persistence beyond `localStorage`
- [ ] Harden secret storage and document exactly what is at rest where
- [ ] Block-list management screen — blocking persists, but there is no UI
- [ ] Polish the pairing UX
- [ ] Stronger error recovery — a locked keychain, a dead peer, a half-saved
      config
- [ ] Desktop end-to-end automation (a real Tauri window in CI)
- [ ] QR-code pairing — payload helpers exist, no UI

---

## Phase 3 — V0.3 · Peer-to-peer connectivity

**Goal:** explore a complete peer-to-peer connection story.

- [ ] WebRTC DataChannel transport — `WebRtcTransport` is a stub today
- [ ] NAT traversal — STUN/TURN configuration
- [ ] Connection state management across the network boundary
- [ ] Reconnection after a dropped link
- [ ] Network failure handling (timeouts, half-open sockets)
- [ ] Cross-network connection testing
- [ ] Manual signaling (copy/paste SDP) as the first, simplest milestone
- [ ] DHT / rendezvous, encrypted agent identity, relay — later still

---

## Phase 4 — V0.4 · Agent intelligence

**Goal:** improve how well agents understand and explain a potential connection.

- [ ] Matching algorithm improvements — better heuristics on top of the LLM pass
- [ ] A structured interest-tag taxonomy
- [ ] Better match explanations
- [ ] Stronger user social boundaries — finer-grained sharing controls
- [ ] Agent-to-Agent protocol improvements (negotiation, capability discovery)
- [ ] Prompt-injection hardening — broader than the current credential-stripping
      sanitiser
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
