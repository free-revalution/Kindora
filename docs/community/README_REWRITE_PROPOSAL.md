# README Rewrite Proposal — Kindora

**Date:** 2026-10-23
**Companion to:** [REPOSITORY_GROWTH_AUDIT.md](REPOSITORY_GROWTH_AUDIT.md)
**Status:** PROPOSAL ONLY — `README.md` has **not** been modified.

## How to read this document

- **§ 1–§ 4** state the governing rules and the blocker ordering.
- **§ 5** contains a complete, copy-ready draft of the proposed `README.md`.
  Every factual claim in it carries a `<!-- audit: ... -->` provenance comment
  naming the file, line, or test that justifies it.
- **§ 6–§ 8** cover prerequisites, the community file set, and the initial
  contribution tasks.

Nothing here should be merged before the P0 items in the audit land. A README
that documents a command which fails is worse than the current one, because the
current one at least looks plausible.

---

## 1. The one rule

> **Every claim in public documentation must map to either a passing test or an
> explicit "not yet implemented" label. Nothing should be inferrable — only
> stated.**

The current README fails this rule in both directions at once: it under-claims
(`"Features (V0.1 target)"` for eight working screens) and over-claims
(`"SQLite + profile persistence"`, `"WebRTC / LAN transport"`).

### 1.1 The facts the README must reflect

All `[VERIFIED]` during the audit:

| Fact                                                                | Consequence for the README                   |
| ------------------------------------------------------------------- | -------------------------------------------- |
| `tauri:dev` exits 101 (`default-run` missing)                       | Quick Start is **withheld** until P0-1       |
| `Cargo.lock` is gitignored                                          | Quick Start carries a reproducibility caveat |
| No `rust-toolchain.toml`; default toolchain cannot compile the tree | Prerequisites pin `rustup default stable`    |
| `tauri-plugin-sql` registered, **zero** TS callers                  | Must **not** say "SQLite persistence"        |
| `WebRtcTransport.connect/send/onMessage` throw                      | Must **not** say "WebRTC transport"          |
| API key → OS keychain **is** implemented                            | Can say this, with the code pointer          |
| Private key is **plaintext** in localStorage                        | Must disclose                                |
| No tags, no Releases, no binaries                                   | Must say "source only, no installer"         |
| LAN is real and well-tested                                         | The one strong "this works" claim            |
| No test ever calls a real LLM                                       | The AI features must be labelled unverified  |

### 1.2 Phrasing rules

| Do                                                                                   | Don't                           |
| ------------------------------------------------------------------------------------ | ------------------------------- |
| "The Rust LAN layer passes 28 integration tests"                                     | "LAN transport is fully tested" |
| "Agent-to-Agent matching is implemented; **no test has called a live LLM provider**" | "Agent-to-Agent Matching ✅"    |
| "Runs on the same LAN only. WebRTC is a stub."                                       | "WebRTC / LAN transport"        |
| "API keys are stored in the OS keychain"                                             | "Privacy First 🔒"              |
| "0 releases. Build from source."                                                     | omit                            |

**Never** add a badge whose status is not real. No CI badge until the workflow
runs green on a public runner `[P2-7]`. No download button until a Release
exists.

---

## 2. Sequencing

The rewrite has two stages. Merging the README before the P0 fixes would
publish a second broken quickstart.

```
Stage 1 (P0)  fix Cargo.toml + Cargo.lock + rust-toolchain.toml + CoC
              → then merge the § 5 draft with a WORKING quickstart
Stage 2 (P1)  after the § 4.7 no-LLM manual flow has been run and recorded
              → promote "Experimental" rows to "Verified" with a date
```

---

## 3. Proposed `README.md` — full draft

> Copy-ready. Strip the `<!-- audit: -->` comments before merging, or keep them
> — they are the mechanism by which the next person updates the README safely.

````markdown
# Kindora

> **Your AI finds the connection. You make the friendship.**

Kindora is an open-source desktop client for personal AI social agents. Your
agent represents you to another person's agent; both agents find the common
ground; **humans** decide whether to talk.

**Status: V0.1 experimental. Source only — no releases, no installer.**
See [Current status](#current-status) for exactly what does and does not work
today.

---

## Contents

- [What Kindora is](#what-kindora-is)
- [How it works](#how-it-works)
- [Why Kindora](#why-kindora)
- [Current status](#current-status)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Security and privacy](#security-and-privacy)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

---

## What Kindora is

Kindora is **not** a dating app, an AI companion, or a general AI chat client.

It is a **personal agent you author once**, then put in a room with someone
else's agent. The two agents exchange bounded, schema-validated messages. Each
runs its own analysis. You both see the result and you both decide.

The AI never sends anything on your behalf. There is no feed, no likes, no
ranking, no score you cannot see and delete.

### The core loop

```
You → Create your agent (nickname, interests, intent, boundaries)
   → Connect to someone else's agent
   → Agent A ↔ Agent B   bounded exchange, both analyse
   → You both see the match report
   → Both consent
   → AI proposes icebreakers; you pick or skip
   → Human A ↔ Human B chat
   → AI assists only when asked
```

---

## How it works

<!-- audit: views/ — CreateAgentForm, ConnectView, MatchView, ConsentView,
     IcebreakerView, ChatView all exist with tests -->

1. **Create your agent.** Nickname, bio, interests, current activities, social
   intent, conversation style, and explicit social boundaries.
2. **Pair.** Two transports:
   - **LAN** — UDP broadcast discovery on port 52419, then a TCP channel.
   - **Loopback** — in-process, for development and tests.
   - Both require a 6-character pairing code typed on the joining device.
3. **Agents meet.** A bounded exchange of `hello` and `profile_exchange`
   envelopes, followed by a local analysis producing five fields:
   _compatibility signal, common ground, recommended topics, potential friction,
   explanation._
4. **You decide.** Accept, reject, disconnect, or block. Chat stays locked until
   both sides accept.
5. **Break the ice.** Your agent proposes up to three conversation starters. You
   use, edit, regenerate, or skip. **The AI never auto-sends.**
6. **Talk.** Human-to-human chat, with an "Ask My Agent" panel that only ever
   fills your draft. You always press Send.

---

## Why Kindora

Most AI social features run the model _at_ people — ranking them, scoring them,
generating a profile from their data. Kindora runs it **between** two consenting
people who each control their own agent.

|                      | Kindora                            | Dating apps         | General agent frameworks |
| -------------------- | ---------------------------------- | ------------------- | ------------------------ |
| Who holds the data   | You, on your device                | The platform        | Wherever you deploy it   |
| Who speaks for you   | You — the agent proposes, you send | The app             | You configure it         |
| Ranking / scores     | None                               | Compatibility score | N/A                      |
| Lock-in              | MIT, no server                     | Closed              | Varies                   |
| Agent↔agent protocol | Open (KSA 0.1, documented)         | N/A                 | Bring your own           |

The trade-off is honest: **there is no discovery layer.** You exchange a code
with someone you already know how to reach. That is the V0.1 scope.

---

## Current status

Updated 2026-10-23. Please read this section before assuming anything works.

### Verified

Real tests pass against real sockets and real processes.

| Capability                                                                                               | Evidence                                                    |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| KSA 0.1 protocol: 10 message types, schema validation, replay guard, rate limiter, sensitive-field guard | `packages/protocol`, Vitest                                 |
| LAN transport — UDP discovery + TCP link, end-to-end                                                     | 15 `lan_e2e` + 13 `lan_protocol_e2e` Rust integration tests |
| Loopback transport, pairing codes, session state machine                                                 | `packages/transport`, Vitest                                |
| OS keychain storage for API keys                                                                         | `keyring` crate; `tauri-secret-store.test.ts`               |
| Prompt-injection sanitiser with credential-pattern stripping                                             | `packages/protocol`                                         |
| All eight UI screens                                                                                     | `apps/desktop/src/views`, Vitest + Testing Library          |
| Full workspace: 541 Vitest, 31 Rust, typecheck, build, lint                                              | CI + local                                                  |

### Experimental — implemented, not yet verified end-to-end

| Capability                                             | The gap                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **The desktop app itself**                             | `tauri dev` is being fixed (see [Quick start](#quick-start)). No one has yet run the GUI to completion.                                 |
| **All LLM features** — match, icebreaker, Ask My Agent | Every test mocks `fetch`. **No test has ever called a live provider.** Real API schemas, auth headers, and error shapes are unverified. |
| **LAN pairing through the GUI**                        | Verified at the Rust socket layer and via a JS IPC shim, not through React + a real Tauri window.                                       |
| **Consent / icebreaker / chat through the GUI**        | Exercised in jsdom only.                                                                                                                |

### Not implemented

| Capability                        | Status                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------- |
| WebRTC / cross-network pairing    | **Stub.** `connect()` throws. Same-LAN only.                                     |
| Manual signaling (SDP copy-paste) | Not started                                                                      |
| SQLite persistence                | Rust plugin registered; **no TypeScript calls it.** All state is `localStorage`. |
| Chat history persistence          | Lost on window close                                                             |
| Private-key encryption at rest    | Plaintext PKCS8 in webview `localStorage`                                        |
| QR-code pairing                   | Payload helpers exist; no UI                                                     |
| Block-list management screen      | Blocking works and persists; no screen to view it                                |
| Releases / installers             | None                                                                             |

### What this means

The automated test suite is strong. It proves the protocol, the LAN socket
layer, and the state machines are correct **under simulation**. It does not prove
two people on two machines have completed a session. That step has not happened
yet.

---

## Quick start

### Prerequisites

| Tool              | Version                                                                                              | Notes                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Node.js           | ≥ 20                                                                                                 | `"engines": { "node": ">=20" }`             |
| pnpm              | 10                                                                                                   | `packageManager: pnpm@10.32.1`              |
| Rust              | **stable** (1.77.2 will **not** work)                                                                | `rustup default stable`                     |
| Linux system deps | `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `patchelf`, `build-essential`, `libssl-dev` | macOS: Xcode CLT. Windows: WebView2 + MSVC. |

<!-- audit: rust 1.77.2 fails — idna_adapter v1.2.2 requires edition2024 -->

### Install

```bash
git clone https://github.com/free-revalution/Kindora.git
cd Kindora
rustup default stable          # REQUIRED — see note above
pnpm install
```

### Run

```bash
pnpm -C apps/desktop tauri:dev
```

> **Note.** `pnpm dev` at the repo root starts **only a Vite dev server** — it
> does not launch the desktop app. Use `pnpm -C apps/desktop tauri:dev`.

### Test

```bash
pnpm test                # Vitest workspace (541 tests)
pnpm typecheck
pnpm lint
pnpm build

cd apps/desktop/src-tauri
cargo test --lib                          # 3 unit tests
cargo test --test lan_e2e -- --test-threads=1            # 15
cargo test --test lan_protocol_e2e -- --test-threads=1   # 13
```

The two Rust integration suites bind real UDP and TCP sockets.
`--test-threads=1` is required — parallel execution is unreliable on the macOS
and Linux kernel UDP buffer pools.

### Troubleshooting

| Symptom                                                         | Cause                | Fix                                  |
| --------------------------------------------------------------- | -------------------- | ------------------------------------ |
| `error: feature 'edition2024' is required`                      | Default Rust too old | `rustup default stable`              |
| `cargo run could not determine which binary to run`             | Known issue          | `cargo run --bin kindora-desktop`    |
| `failed to run custom build command for 'openssl-sys'` on Linux | Missing headers      | `sudo apt install libssl-dev`        |
| `webkit2gtk` not found                                          | Missing system deps  | Install the Linux row above          |
| Blank window, console shows Vite at 1420                        | `pnpm dev` was used  | Use `pnpm -C apps/desktop tauri:dev` |

---

## Configuration

### LLM provider

Settings → LLM. Four presets:

| Provider          | Default base URL              | Key required |
| ----------------- | ----------------------------- | ------------ |
| OpenAI-compatible | `https://api.openai.com/v1`   | yes          |
| Anthropic         | `https://api.anthropic.com`   | yes          |
| Ollama (local)    | `http://localhost:11434`      | no           |
| MiniMax           | `https://api.minimaxi.com/v1` | yes          |

Bring your own key. Any OpenAI-compatible endpoint works.

### API key handling

- Stored in the **OS-native secret store** — macOS Keychain, Windows Credential
  Manager, Linux Secret Service — via the `keyring` crate.
- Selected automatically when running in Tauri; falls back to an
  AES-GCM-encrypted `localStorage` store under `pnpm dev`.
- Never written to settings, logs, profiles, or any wire envelope.

### Running without an LLM

Choose provider `none` / leave unconfigured. The app boots, and you can still
exercise pairing, the consent screen, and the LAN state machine. The match
screen will time out — expected.

<!-- audit: docs/phase16/manual-lan-e2e.md § 4.7 — the intended no-LLM flow -->

---

## Architecture

```
┌──────────────────────── apps/desktop (React) ─────────────────────────┐
│  Welcome → Create → Home → Settings                                  │
│                    ↓                                                 │
│  Connect → Match → Consent → Icebreaker → Chat                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ Tauri IPC (invoke)
┌──────────────────────────────▼──────────────────────────────────────┐
│              packages/ (TypeScript, platform-free)                  │
│                                                                       │
│  protocol   KSA 0.1 · validation · replay guard · rate limit          │
│  transport  LanTransport · Loopback · PairingSession FSM              │
│  agent      identity · analyseMatch · generateIcebreaker              │
│  matching   match · consent · icebreaker · chat orchestrators         │
│  llm        openai-compatible · anthropic · ollama                    │
│  storage    profile · settings · secrets · block list                │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ Tauri IPC
┌──────────────────────────────▼──────────────────────────────────────┐
│           apps/desktop/src-tauri (Rust)                              │
│                                                                       │
│  lan.rs      UDP 52419 discovery · TCP link · lan_* commands          │
│  secrets.rs  keyring → OS keychain · secret_* commands                │
└───────────────────────────────────────────────────────────────────────┘
```

| Package     | Responsibility                                                                                |
| ----------- | --------------------------------------------------------------------------------------------- |
| `protocol`  | KSA 0.1 envelope, 10 message types, validation, replay protection, prompt-injection sanitiser |
| `transport` | `LanTransport`, `LoopbackTransport`, `WebRtcTransport` (stub), `PairingSession`               |
| `agent`     | Ed25519 identity, LLM match analysis, icebreaker generation, context assembly                 |
| `matching`  | Orchestrators for match → consent → icebreaker → chat                                         |
| `llm`       | Provider adapters                                                                             |
| `storage`   | Profile, settings, secrets, block list                                                        |

### LAN wire protocol

1. Host binds UDP **52419** and broadcasts an announcement carrying the pairing
   code.
2. Joiner sends a discovery packet with the code.
3. Host replies with its LAN address and a **randomly chosen TCP port**.
4. TCP handshake: `ready` → `lan_announce` → `lan_invite_ack`.
5. From then on, newline-delimited JSON envelopes flow over that TCP socket.

Failures are typed: `PeerClosed`, `NotConnected`, and friends are classified in
TypeScript by `LanError` and matched against string constants asserted by a Rust
test, so the two sides cannot drift.

<!-- audit: apps/desktop/src-tauri/src/lan.rs:36; lan-error.ts -->

---

## Security and privacy

Only claims below are backed by code or tests.

### Verified

- **API keys → OS keychain.** `keyring` crate; automatic runtime selection.
  Tests assert the key never lands in `localStorage` or settings.
- **Remote agent content is treated as data, never as instructions.** The
  system prompt marks peer content untrusted; peer text passes through a
  sanitiser that strips credential patterns (`sk-`, `sk-ant-`, `ghp_`, `Bearer`,
  PEM, `AKIA`).
- **Every inbound envelope is schema-validated, replay-guarded, and
  rate-limited.**
- **No tool use.** A peer agent cannot invoke shell, browser, MCP, or
  filesystem tools.
- **CSP is set.** `default-src 'self'` with an explicit provider allowlist, so
  injected content cannot exfiltrate to arbitrary hosts.
- **No `console.*` in production code.**
- **The AI never auto-sends.** Every message requires a human click.

### Known weaknesses

Stated plainly, because they are real:

- **Your agent's private key is stored as plaintext PKCS8 in webview
  `localStorage`.** It is not in the keychain. On a compromised machine, it is
  readable.
- **The transport is unencrypted.** LAN traffic is plaintext TCP. Only safe on a
  network you control.
- **Under `pnpm dev`, secrets fall back** to AES-GCM with a fixed, bundled
  app secret. Adequate against casual disk inspection; not against an attacker
  with the device.
- **The pairing code is the only authentication.** 6 characters. Someone who
  sees it can join. It is re-checked at discovery, not on the established TCP
  link.

Report vulnerabilities privately via **GitHub Security Advisories** on this
repository. See [SECURITY.md](SECURITY.md).

<!-- audit: private-key finding — docs/AUDIT_V0.1_PHASE14.md § "privateKey at rest" -->

---

## Roadmap

### V0.1 — validate the core hypothesis _(current)_

Prove that agent-mediated introduction helps two strangers start. Requires:
the app launching, one live LLM provider, and two machines completing a session.

### V0.2 — better discovery and matching

QR-code pairing · matching heuristics · improved P2P · zh/en localisation

### V0.3 — network layer

DHT / rendezvous · relay / TURN · encrypted agent identity

### V0.4 — relationship engine

Interaction patterns · shared activity suggestions · local-only trust

See [docs/ROADMAP.md](docs/ROADMAP.md).

---

## Contributing

Issues, ideas, and pull requests are welcome — especially from people who want
to be the first users.

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — principles, dev setup, PR guidance
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — Contributor Covenant 2.1
- **[SECURITY.md](SECURITY.md)** — threat model and private reporting
- **Issues** — use the templates; include OS, Rust version, and what you expected
- **Discussions** — open questions and design ideas

Early-stage project: a well-explained bug report is as valuable as a patch.

---

## License

[MIT](LICENSE) © 2026 Kindora Contributors

The Chinese product and development specification is in
[开发手册.md](开发手册.md).
````

---

## 4. Assets required before merging

| Asset                                               | Why                                      | Blocks merge?                |
| --------------------------------------------------- | ---------------------------------------- | ---------------------------- |
| Screenshot: MatchView (5 fields)                    | The product's core artifact is visual    | Yes                          |
| Screenshot: ConnectView showing a LAN code          | Proves the real feature                  | Yes                          |
| Screenshot or GIF: Connect → Match → Consent → Chat | The core loop in one frame               | Yes                          |
| Terminal transcript of `tauri:dev` launching        | Evidence for Quick Start                 | Yes                          |
| Recorded § 4.7 no-LLM manual flow                   | Evidence for "Experimental" → "Verified" | No, but strongly recommended |

**Do not fabricate screenshots.** They must be captured from a real run. If the
app cannot start, ship the README **without** them and say so.

---

## 5. Proposed community files

All are proposals. None has been created.

### 5.1 P0 — `CODE_OF_CONDUCT.md`

[Contributor Covenant](https://www.contributor-covenant.org/) v2.1, verbatim.
Set `enforcement_contact` to the same real address as §5.3. **Not
`kindora.example`/`kindora.local`.**

_Why P0:_ GitHub surfaces this in the community-health panel; its absence is a
strong negative signal to outside contributors.

### 5.2 P0 — `rust-toolchain.toml`

```toml
[toolchain]
channel = "stable"
```

_Acceptance:_ on a machine whose default is 1.77.2, `cargo check --lib`
succeeds with no `PATH` override.

### 5.3 P1 — `SECURITY.md` contact replacement

Delete `security@kindora.local`. Replace with an address the maintainer
actually reads, or remove the email line and keep only GitHub Security
Advisories. `.local` is a reserved, non-routable TLD — as written, the security
contact reaches nobody.

### 5.4 P1 — `.github/ISSUE_TEMPLATE/bug_report.yml`

Sections: what happened · expected · steps · environment (OS + version, Node,
pnpm, Rust — with a dropdown defaulting to `stable`) · LAN specifics (were both
machines on the same subnet? was a pairing code involved?) · logs ·
screenshots. Include a checkbox: _"I searched existing issues."_

### 5.5 P1 — `.github/ISSUE_TEMPLATE/feature_request.yml`

Sections: problem · proposed solution · alternatives · scope (Local-first?
Privacy-preserving? transport? UI? docs?) · V0.1 fit. Add
`labels: ["enhancement"]`.

### 5.6 P1 — `.github/PULL_REQUEST_TEMPLATE.md`

Checklist: change is scoped to one concern · `pnpm test` passes ·
`pnpm lint` passes · `pnpm typecheck` passes · Rust changes add or update
`cargo test` · new behaviour has a test · no secrets, keys, or `localStorage`
dumps in the diff · README/docs updated if user-visible behaviour changed.

### 5.7 P2 — `.github/ISSUE_TEMPLATE/config.yml`

```yaml
blank_issues_enabled: false
contact_links:
  - name: Question or idea
    url: https://github.com/free-revalution/Kindora/discussions
    about: Ask anything that is not a bug report.
```

### 5.8 P2 — `SUPPORT.md`

Route: bug → issue template; security → Security Advisories; question → Discussions;
local setup problem → the troubleshooting table in README § Quick start.

### 5.9 P2 — `.github/dependabot.yml`

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: cargo
    directory: /apps/desktop/src-tauri
    schedule: { interval: weekly }
```

_Acceptance:_ dependabot opens a PR within a week. Given `Cargo.lock` is
currently gitignored, this is a prerequisite for P0-2 to be meaningful.

### 5.10 P2 — `docs/community/ROADMAP.md`

A public, dated mirror of the engineering roadmap. Must include a
"Recently shipped" section with dates so progress is visible.

---

## 6. Initial contribution tasks

Each task below was verified to correspond to real, unfinished work in the
tree. **Do not label anything `good first issue` until P0-1 through P0-3 land** —
otherwise the first outside contributor hits a build failure and does not return.

| #      | Task                                                                              | Scope                                                         | Acceptance                                                                                           |
| ------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **1**  | Add `rust-toolchain.toml`                                                         | 2-line file                                                   | `cargo check --lib` works on a machine defaulting to 1.77.2                                          |
| **2**  | Stop gitignoring the app `Cargo.lock`                                             | 1 `.gitignore` line + commit the lockfile                     | Fresh clone builds the same versions twice                                                           |
| **3**  | Update `docs/ARCHITECTURE.md`                                                     | Rewrite to match reality; add the Rust layer and LAN protocol | Every claim maps to a file:line or a test                                                            |
| **4**  | Add the missing `block` message type to `docs/PROTOCOL.md` + wire-framing section | `PROTOCOL.md` only                                            | Doc type list diffs clean against `envelope.ts`                                                      |
| **5**  | `test:live` — opt-in live LLM smoke test                                          | New script + `vitest.live.config.ts`; gated on `LIVE_LLM=1`   | `LIVE_LLM=1 pnpm test:live` passes with a real key; **skips cleanly with no key and spends nothing** |
| **6**  | Add `lan_protocol_e2e` to CI + fix the pnpm version mismatch                      | `.github/workflows/ci.yml`                                    | CI log shows 13 tests; pnpm majors agree                                                             |
| **7**  | Add a macOS runner to CI                                                          | `ci.yml`                                                      | A `macos-latest` job in the Actions tab                                                              |
| **8**  | Document Tauri system dependencies per platform                                   | `README.md`                                                   | A Linux contributor reaches `cargo check` from the README alone                                      |
| **9**  | Add an Ollama preset round-trip test                                              | `apps/desktop/src/__tests__/llm-service.test.ts`              | A test asserts a keyless Ollama config saves and loads                                               |
| **10** | Write a troubleshooting section                                                   | `README.md`                                                   | Every symptom in § Quick start's table came from a real failure someone hit                          |

**On labels.** `help wanted` — safe on **#5**, **#6**, **#8**, **#10** (clear
scope, no product decisions). `good first issue` — safe on **#1**, **#2**, **#4**,
**#9** after the P0s land. **#3** and **#7** need maintainer context, so label
them `documentation` / `help wanted` rather than `good first issue`.

---

## 7. GitHub Description and Topics (proposed, not applied)

`gh` is not authenticated on this machine, so the current values are unknown
— see the audit § 8. Verify before changing.

### 7.1 Description (≤ 100 chars)

```
Open-source desktop client for personal AI social agents. Your AI finds the connection; you make the friendship.
```

That is 116 characters. Trimmed options:

```
Personal AI social agents. Your AI finds the connection; you make the friendship.
```

(83 chars)

```
Open-source desktop client for personal AI social agents — agent-to-agent matching, human decisions.
```

(102 chars — still 2 over)

**Recommended, 96 chars:**

```
Open-source personal AI social agents. Your agent finds the connection; you make the friendship.
```

### 7.2 Topics

GitHub allows 20. Choose for reach **and** accuracy — every topic should be one
a visitor would actually search for. Proposed set (18):

| Topic            | Rationale                     |
| ---------------- | ----------------------------- |
| `ai-agent`       | Primary category              |
| `ai-agents`      | Plural variant, higher volume |
| `agent`          | Broad                         |
| `personal-ai`    | Product category              |
| `ai-social`      | Differentiator                |
| `social-network` | Category                      |
| `matching`       | Feature                       |
| `llm`            | Stack                         |
| `local-first`    | Product principle             |
| `privacy`        | Product principle             |
| `open-source`    | Expected                      |
| `tauri`          | Stack                         |
| `rust`           | Stack                         |
| `react`          | Stack                         |
| `typescript`     | Stack                         |
| `p2p`            | Architecture                  |
| `desktop`        | Platform                      |
| `protocol`       | KSA                           |

**Deliberately excluded:** `dating` and `dating-app` — Kindora is explicitly not
a dating app, and `PRODUCT.md` says so. Attracting that traffic would produce
the wrong user. Also excluded: `web3`, `blockchain`, `chatbot`, `companion` —
all inaccurate.

### 7.3 Social preview image

No `og:image` is configured `[NOT VERIFIED — needs authenticated API access]`.
Recommend a 1280×640 card: the logo, the tagline, and a status band reading
**"V0.1 · experimental · source only"**. The status band prevents a visitor from
arriving with a wrong expectation.

---

## 8. What this proposal does not do

- It does not modify `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/`, or
  any application code.
- It does not apply GitHub Description, Topics, Discussions, or Releases.
- It does not add badges. The CI workflow currently omits `lan_protocol_e2e` and
  runs on one platform; a badge over it would advertise less than it implies.
- It does not claim the product works. The draft's "Experimental" section is
  deliberately prominent, and that is intended to stay until § 4.7 has been
  run by a human on two machines and recorded.
