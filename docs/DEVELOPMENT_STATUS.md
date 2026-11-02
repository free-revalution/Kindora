# Development status

**The honest version.** This document exists because the README is the place
people land, and a README that overstates what works is worse than no README at
all. Everything below is stated with the evidence that supports it.

- Last reviewed against `main` at commit `0060838`.
- Test counts are a **static inventory of the test cases declared in the source
  tree** — counted, not inferred. They are *not* a claim that the suite was
  run and passed at this commit; the CI badge in the README is the record of
  actual runs.

---

## How to read the states

| State | Meaning |
| --- | --- |
| **Implemented** | The code exists and is covered by automated tests. |
| **Implemented, unvalidated** | The code exists and the tests pass in a mocked or socket-level harness, but **no one has exercised it in the real thing** — a real LLM provider, a real Tauri window, two real machines. |
| **Not implemented** | The code does not exist, or is a stub that throws. |

---

## Test inventory

### TypeScript — Vitest

| Package | Test files | Test cases |
| --- | ---: | ---: |
| `@kindora/agent` | 14 | 126 |
| `@kindora/transport` | 8 | 115 |
| `@kindora/desktop` | 13 | 115 |
| `@kindora/protocol` | 8 | 103 |
| `@kindora/matching` | 7 | 60 |
| `@kindora/storage` | 4 | 29 |
| `@kindora/llm` | 2 | 19 |
| **Total** | **56** | **567** |

Counted from the `it(` declarations in `*.test.ts` / `*.test.tsx` across
`apps/desktop/src` and `packages/*/src`. Run them with `pnpm test`.

### Rust — cargo

| Suite | Test cases | What it exercises |
| --- | ---: | --- |
| `cargo test --lib` | 3 | Error-to-display-string contracts (`apps/desktop/src-tauri/src/lan.rs`) |
| `cargo test --test lan_e2e` | 18 | The real `LanState` over **real UDP + TCP sockets** |
| `cargo test --test lan_protocol_e2e` | 13 | The KSA 0.1 envelope contract over a real socket |
| **Total** | **34** | |

The two integration suites need `-- --test-threads=1`: parallel execution is
unreliable against the macOS and Linux kernel UDP buffer pools.

### What the tests do **not** cover

- **No test has ever called a live LLM provider.** Every provider test mocks
  `fetch`. Real request schemas, auth headers, rate-limit responses and error
  shapes are unverified against any real API.
- **No test drives the real Tauri window.** The LAN transport is tested at the
  Rust socket layer and through a JavaScript IPC shim
  (`apps/desktop/src/lib/lan-connect-service.ts`), but not through React
  against a live Tauri webview.
- **No two-machine test.** The LAN suite runs both ends of a conversation inside
  one process over the loopback interface.

---

## Feature status

### Implemented

| Capability | Evidence |
| --- | --- |
| Agent profile — create, edit, persist | `packages/agent/src/profile.ts`, `packages/storage/src/profile-store.ts`, `apps/desktop/src/views/CreateAgentForm.tsx` |
| LLM provider adapters — OpenAI-compatible, Anthropic, Ollama, MiniMax | `apps/desktop/src/lib/llm-service.ts:251-280` (`PROVIDER_PRESETS`), `packages/llm/src/providers/` |
| API keys in the OS secret store | `apps/desktop/src-tauri/src/secrets.rs`, `keyring` 3 with `apple-native` / `windows-native` / `sync-secret-service` (`apps/desktop/src-tauri/Cargo.toml:34`), wired as `secret_set` / `secret_get` / `secret_delete` / `secret_list` (`apps/desktop/src-tauri/src/lib.rs:121-139`) |
| KSA 0.1 envelope — validation, replay guard, rate limiter, sensitive-field guard | `packages/protocol/src/{validation,replay-protection,rate-limiter,sensitive-field-guard}.ts` |
| LAN transport — UDP broadcast discovery on port 52419, then TCP | `apps/desktop/src-tauri/src/lan.rs:36` (`DISCOVERY_PORT = 52419`), `apps/desktop/src-tauri/src/lan.rs` (host/join), `packages/transport/src/lan-transport.ts` |
| Loopback transport | `packages/transport/src/loopback-transport.ts` |
| Match report — 5 fields | `packages/protocol/src/index.ts:152-167` (`MatchAnalysis`: `compatibilitySignal`, `commonGround`, `recommendedTopics`, `potentialFriction`, `explanation`), produced by `packages/agent/src/analyze-match.ts` |
| Consent — accept / reject / disconnect / block | `packages/matching/src/consent-orchestrator.ts`, `packages/storage/src/blocked-agents-store.ts` |
| Icebreaker — propose, use, edit, regenerate, skip | `packages/agent/src/generate-icebreaker.ts`, `packages/matching/src/orchestrator.ts`, `apps/desktop/src/lib/connect-service.ts` |
| Chat + "Ask My Agent" draft helper | `packages/matching/src/chat-orchestrator.ts`, `packages/matching/src/chat-assist-orchestrator.ts` |
| Prompt-injection sanitiser with credential-pattern stripping | `packages/protocol/src/prompt-injection-guard.ts` |
| English + 简体中文 UI | `apps/desktop/src/i18n/locale.ts:36` (`Locale = 'en' \| 'zh'`), `apps/desktop/src/i18n/dictionaries/{en,zh}.ts` (252 keys each), picker in `apps/desktop/src/views/Settings.tsx` |
| The AI never auto-sends | `packages/matching/src/` — every outbound message is gated behind an explicit user action in `apps/desktop/src/views/` |

### Implemented, unvalidated

| Capability | What is missing |
| --- | --- |
| The desktop app in a real window | A complete two-machine session has not been driven by hand. The app builds and launches. |
| Every LLM-dependent feature | No live provider call. See `packages/llm/src/__tests__/` — `fetch` is mocked throughout. |
| LAN pairing through the GUI | Verified at the Rust socket layer and via a JS IPC shim, not through React against a real Tauri window. |
| API-key persistence in the OS keychain | The `keyring` path is implemented and unit-testable, but the end-to-end write into the macOS login keychain has not been confirmed on a real dev build. |

### Not implemented

| Capability | Evidence |
| --- | --- |
| WebRTC / cross-network pairing | `packages/transport/src/webrtc-transport.ts:40-45` — `connect()` throws. **Same-LAN only.** |
| SQLite persistence | The plugin is registered (`apps/desktop/src-tauri/src/lib.rs:151`, `tauri_plugin_sql`), but **no TypeScript code calls it** — the only mention in the packages is a comment (`packages/storage/src/index.ts:11`). All state is in `localStorage`. |
| Chat history persistence | No store for messages exists; the chat orchestrator keeps them in memory for the session only. |
| Private-key encryption at rest | `packages/agent/src/identity.ts:61,67` exports the PKCS8 key as base64 and `packages/storage/src/profile-store.ts:20` stores it in plaintext. |
| QR-code pairing | `packages/transport/src/qr-payload.ts` has the payload helpers; there is no UI for them. |
| Block-list management screen | `packages/storage/src/blocked-agents-store.ts` persists the list; there is no view that displays or edits it. |
| Releases / installers | No git tags, no published releases, no bundled installer. |
| DHT / rendezvous / relay / TURN | Not started. |

---

## Screens

`apps/desktop/src/App.tsx:28-59` defines eleven view states. The user-facing
screens are:

Welcome · Create/Edit agent · Home · Settings · Connect · Match · Consent ·
Icebreaker · Chat

(LAN and Loopback are two modes *inside* Connect, not separate screens.)

---

## Known technical limitations

These are current, real, and worth knowing before you rely on the software.

1. **LAN traffic is not encrypted.** The TCP channel has no TLS. Anything on the
   same local network can read the exchanged data. The transport source says so
   itself: `packages/transport/src/lan-transport.ts:24` — *"production must add
   TLS or a WebRTC DataChannel layer."*
2. **The agent's private key is plaintext** in `localStorage` (see above).
3. **A peer is authenticated by a 6-character pairing code**, not by a verified
   cryptographic identity.
4. **The prompt-injection defence is heuristic.** It strips credential-like
   patterns and clearly delimits remote content as untrusted; it is not a proof.
5. **Browser dev mode stores the API key in `localStorage`** (AES-GCM encrypted)
   rather than in the OS keychain, because there is no native runtime. The
   shipped desktop app uses the keychain. See `apps/desktop/src/lib/llm-service.ts:29-31`.
6. **No external security audit has been performed**, and no release has been
   published. Treat Kindora as research-grade software.

---

## How to check these claims yourself

```bash
# Test inventory
grep -roE "\bit\(" apps/desktop/src packages/*/src | wc -l
grep -rn "#\[tokio::test" apps/desktop/src-tauri/tests/ | wc -l

# The specific "not implemented" claims
grep -n "not implemented" packages/transport/src/webrtc-transport.ts
grep -rn "sqlite" apps/desktop/src packages/*/src
grep -rn "qr" apps/desktop/src/views

# The port
grep -n "DISCOVERY_PORT" apps/desktop/src-tauri/src/lan.rs
```

If a claim here disagrees with the code, **the code wins** — please open an
issue or a PR to correct this document.
