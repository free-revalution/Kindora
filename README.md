# Kindora

> **Your AI finds the connection. You make the friendship.**

Kindora is an open-source personal AI social agent client that helps people discover meaningful human connections through agent-to-agent matching.

Your AI understands you. Other people's AI understands them. The agents find common ground. Humans make the connection.

---

## Status

**V0.1 — Experimental. Source only: no releases, no installers.**

Goal: validate that AI Agent–mediated social interaction can help two strangers
start a real conversation.

**Read [Features](#features) before assuming anything works.** In particular:
the desktop app has never yet been driven through a complete two-machine session
by hand, and no test has called a live LLM provider.

---

## Features

### Implemented and covered by tests

- Personal AI Social Agent — create, edit, persist
- User-owned LLM (BYO API key) — OpenAI-compatible, Anthropic, Ollama, MiniMax
- API keys stored in the **OS-native secret store** (macOS Keychain / Windows Credential Manager / Linux Secret Service)
- KSA 0.1 wire protocol — schema validation, replay guard, rate limiting, sensitive-field guard
- **LAN transport** — UDP broadcast discovery on port 52419, then a TCP channel (28 Rust integration tests over real sockets)
- Loopback transport for in-process development and tests
- Agent-to-Agent matching — 5-field match report (compatibility signal, common ground, recommended topics, potential friction, explanation)
- Human consent flow — accept / reject / disconnect / block, with a persisted block list
- Icebreaker generation — propose, use, edit, regenerate, skip
- Human-to-human chat, plus an "Ask My Agent" panel that only fills your draft
- Prompt-injection sanitiser with credential-pattern stripping
- Human-in-the-loop throughout — **the AI never auto-sends**

### Experimental — implemented, not yet verified end-to-end

- **The desktop app itself.** Builds and runs; no one has yet completed a full two-machine session by hand.
- **All LLM-dependent features.** Every test mocks `fetch`. **No test has ever called a live provider** — real API schemas, auth headers, and error shapes are unverified.
- **LAN pairing through the GUI.** Verified at the Rust socket layer and via a JS IPC shim, not through React against a real Tauri window.

### Not implemented

- **WebRTC / cross-network pairing** — `WebRtcTransport` is a stub; `connect()` throws. **Same-LAN only.**
- **SQLite persistence** — the Rust plugin is registered but **no TypeScript code calls it**. All state is in `localStorage`.
- **Chat history persistence** — lost on window close.
- **Private-key encryption at rest** — the agent's PKCS8 key is currently plaintext in webview `localStorage`.
- QR-code pairing — payload helpers exist, no UI.
- Block-list management screen — blocking works and persists, but there is no screen to view it.
- Releases / installers — **none yet.** Build from source.

See [docs/community/REPOSITORY_GROWTH_AUDIT.md](docs/community/REPOSITORY_GROWTH_AUDIT.md) § 4 for the full classification with code evidence.

---

## Repository Layout

```text
Kindora/
├── apps/
│   └── desktop/
│       ├── src/                  React UI (8 screens) + Tauri services
│       └── src-tauri/            Rust: LAN transport + OS keychain
│           ├── src/lan.rs        UDP 52419 discovery, TCP link, lan_* commands
│           ├── src/secrets.rs    keyring → OS keychain, secret_* commands
│           └── tests/            lan_e2e (15) + lan_protocol_e2e (13)
├── packages/
│   ├── protocol/         KSA 0.1 envelope, validation, replay guard, rate limiter
│   ├── agent/            Ed25519 identity, match analysis, icebreaker generation
│   ├── llm/              Provider adapters (openai-compatible, anthropic, ollama)
│   ├── matching/         match / consent / icebreaker / chat orchestrators
│   ├── storage/          profile, settings, secrets, block list (localStorage)
│   └── transport/        LAN (real) · Loopback · WebRTC (stub) · PairingSession FSM
├── docs/                 PRODUCT / ARCHITECTURE / PROTOCOL / ROADMAP / community
├── experiments/          Phase 2.1 cross-process UDP harness (standalone crate)
├── 开发手册.md            Authoritative product + dev spec (zh)
└── README.md             This file (en)
```

---

## Quick Start

### Prerequisites

| Tool                  | Version                                                                                              | Notes                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Node.js               | ≥ 20                                                                                                 | from `package.json` `engines`                                                                  |
| pnpm                  | 10                                                                                                   | `packageManager: pnpm@10.32.1`                                                                 |
| Rust                  | **stable**                                                                                           | `rust-toolchain.toml` pins this per-directory. **1.77.2 will not work** — see troubleshooting. |
| Linux system packages | `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `patchelf`, `build-essential`, `libssl-dev` | macOS: Xcode CLT. Windows: WebView2 + MSVC.                                                    |

### Install

```bash
git clone https://github.com/free-revalution/Kindora.git
cd Kindora

# Install Rust (one-time, if you do not have it)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

pnpm install
```

`rust-toolchain.toml` at the repository root pins the Rust toolchain to
`stable`, so `cargo` picks the right version automatically inside this
directory. No manual `PATH` juggling is needed.

### Run the desktop app

```bash
pnpm -C apps/desktop tauri:dev
```

> **Note.** `pnpm dev` at the repository root starts **only a Vite dev server**
> on `127.0.0.1:1420` — it does **not** launch the desktop app. Use
> `pnpm -C apps/desktop tauri:dev`.

### Test

```bash
# TypeScript — Vitest workspace
pnpm test
pnpm typecheck
pnpm lint

# Rust — run from the Tauri crate
cd apps/desktop/src-tauri
cargo test --lib                            # 3 unit tests
cargo test --test lan_e2e -- --test-threads=1            # 15
cargo test --test lan_protocol_e2e -- --test-threads=1   # 13
```

The two Rust integration suites bind **real UDP and TCP sockets**.
`--test-threads=1` is required — parallel execution is unreliable against the
macOS and Linux kernel UDP buffer pools.

### Troubleshooting

| Symptom                                                        | Cause                                      | Fix                                                                   |
| -------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `error: feature 'edition2024' is required`                     | Default Rust toolchain is too old (1.77.2) | `rustup default stable` — or rely on the repo's `rust-toolchain.toml` |
| `cargo run could not determine which binary to run`            | Resolved by `default-run` in `Cargo.toml`  | `cargo run --bin kindora-desktop` as a fallback                       |
| `failed to run custom build command for 'openssl-sys'` (Linux) | Missing OpenSSL headers                    | `sudo apt install libssl-dev`                                         |
| `webkit2gtk` not found (Linux)                                 | Missing system packages                    | Install the Linux prerequisites row above                             |
| A web page at `localhost:1420` instead of a window             | `pnpm dev` was used                        | Use `pnpm -C apps/desktop tauri:dev`                                  |

See [开发手册.md](开发手册.md) for the full product and development specification.

---

## Contributing

Issues, documentation fixes, and pull requests are welcome — especially from
people who want to be the first users.

- [CONTRIBUTING.md](CONTRIBUTING.md) — principles, dev setup, PR guidance
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
- [SECURITY.md](SECURITY.md) — threat model and private vulnerability reporting
- [docs/ROADMAP.md](docs/ROADMAP.md) — what is planned, and what is deliberately out of scope

This is an early-stage, single-maintainer project: a well-explained bug report is
as valuable as a patch.

---

## License

[MIT](LICENSE) © 2026 Kindora Contributors

The Chinese product and development specification is in
[开发手册.md](开发手册.md).
