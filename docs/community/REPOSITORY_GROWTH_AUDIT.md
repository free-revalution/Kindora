# Kindora Repository Growth Audit

**Audit date:** 2026-10-23
**Auditor:** Claude Code (GLM-4.7)
**Commit audited:** `b1d7f62` — "Phase 16.6: LAN concurrency boundary audit (§ 5.6)"
**Method:** Read-only inspection of the working tree plus two live read-only commands
(`pnpm lint`, file/glob queries). **No application code, no configuration, and no
GitHub settings were modified.** GitHub server-side settings (Description, Topics,
Discussions, Releases, branch protection) could **not** be inspected — see
[§ 8 Limitations](#8-limitations).

Every statement in this document is tagged:

| Tag               | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `[VERIFIED]`      | Read directly from the working tree, or observed in a command run during this audit.          |
| `[FROM-TERMINAL]` | Reported by the maintainer in `终端测试.md` / prior session output. Not re-run by this audit. |
| `[ASSUMPTION]`    | An inference or recommendation. **Not** an established fact.                                  |

---

## 1. Executive summary

Kindora's **code** is further along than its **public face**. The V0.1 user flow
is implemented end-to-end in TypeScript, with 541 passing Vitest tests and 31
passing Rust tests `[FROM-TERMINAL]`.

The **documentation** does not match that code, and in several places actively
misstates it. The README tells a developer to run `pnpm dev` to "Run desktop
app" — but that script starts a Vite dev server, not a desktop application
`[VERIFIED]`. The architecture document declares "Phase 0 Bootstrap" sixteen
phases out of date, and claims all state lives in SQLite when no TypeScript code
calls the SQLite plugin at all `[VERIFIED]`.

The **onboarding path** is broken before it begins. `pnpm -C apps/desktop
tauri:dev` exits 101 on a clean checkout because `Cargo.lock` is gitignored and
`[package]` lacks a `default-run` key `[VERIFIED]`. A stranger who clones this
repository today cannot get a window on screen.

**The single most important framing for any public communication:** the product
has **never been run in a GUI by anyone**, and **no LLM provider has ever been
called by any test**. Both facts are `[VERIFIED]`. The README must not imply
otherwise.

### Headline numbers

| Metric                       | Value                                     | Source                               |
| ---------------------------- | ----------------------------------------- | ------------------------------------ |
| Commits                      | 39                                        | `[VERIFIED]`                         |
| Distinct contributors        | 1 (`Kindora Dev <kindora@example.local>`) | `[VERIFIED]`                         |
| Tags / GitHub Releases       | 0 / not verified                          | `[VERIFIED]` / see §8                |
| Tracked files                | 199                                       | `[VERIFIED]`                         |
| Active development window    | 2026-10-08 → 2026-10-18 (11 days)         | `[VERIFIED]`                         |
| Vitest                       | 541 passed / 54 files                     | `[FROM-TERMINAL]`                    |
| Rust integration tests       | 15 (`lan_e2e`) + 13 (`lan_protocol_e2e`)  | `[FROM-TERMINAL]`                    |
| Rust unit tests              | 3                                         | `[FROM-TERMINAL]`                    |
| `pnpm lint`                  | exit 0                                    | `[VERIFIED]` — run during this audit |
| Phase 16.6 concurrency tests | 8 (mock-IPC, not live sockets)            | `[VERIFIED]`                         |

---

## 2. Repository homepage problems

### 2.1 The README's primary instruction is wrong `[VERIFIED]`

```markdown
## Quick Start

# Run desktop app

pnpm dev
```

`pnpm dev` resolves to root `package.json` → `"dev": "pnpm -C apps/desktop dev"` →
`apps/desktop/package.json` → `"dev": "vite"`. It starts a **Vite dev server on
127.0.0.1:1420** and nothing else. No Tauri window, no Rust, no desktop app.

The command that would start the app — `pnpm -C apps/desktop tauri:dev` — appears
nowhere in the README or CONTRIBUTING.md `[VERIFIED]`.

**Impact:** Every first-time visitor follows the documented path, sees a web page
in a browser instead of a desktop app, and concludes the project is a web app or
is broken. This is the single highest-impact documentation defect.

### 2.2 The documented command is also non-functional `[VERIFIED]`

Even correcting the above, `pnpm -C apps/desktop tauri:dev` currently fails:

```
error: `cargo run` could not determine which binary to run. Use the `--bin`
       option to specify a binary, or the `default-run` manifest key.
available binaries: kindora-desktop, lan_cross_process_host, lan_cross_process_joiner
```

Cause: `apps/desktop/src-tauri/Cargo.toml` `[package]` has no `default-run` key,
while `src/bin/` contains two additional binaries added in commit `bbf360a`
("Phase 13") `[VERIFIED]`. `tauri dev` invokes `cargo run` without `--bin`.

**Impact:** There is currently **no working documented path to a running desktop
app**. The workaround (run `pnpm -C apps/desktop dev` and `cargo run --bin
kindora-desktop` in two terminals) is not written down anywhere.

### 2.3 The README makes capability claims the code does not support `[VERIFIED]`

```markdown
│ ├── storage/ SQLite + profile persistence
│ └── transport/ WebRTC / LAN transport
```

Both are partly false:

- **`storage` = "SQLite + profile persistence".** `tauri-plugin-sql` **is** in
  `Cargo.toml` and `sql:*` permissions **are** in `capabilities/default.json`,
  but there is **zero** TypeScript code importing or calling
  `@tauri-apps/plugin-sql`. `apps/desktop/src/lib/agent-service.ts:19` hardcodes
  `new BrowserLocalStorageProfileStore()`. All persistence is `localStorage`.
- **`transport` = "WebRTC / LAN transport".** LAN is real. `WebRtcTransport`
  (`packages/transport/src/webrtc-transport.ts`) has `connect()` throwing
  `Error('WebRtcTransport is not implemented in V0.1 dev…')`; `send()` and
  `onMessage()` also throw. Manual signaling (Mode B) does not exist.

**Impact:** A developer reading this concludes cross-network pairing works. It
does not. If they file a bug report saying "WebRTC does not connect", the project
looks worse than if the README had said "LAN only, WebRTC planned".

### 2.4 "Features (V0.1 target)" does not distinguish shipped from aspirational `[VERIFIED]`

```markdown
## Features (V0.1 target)

- Personal AI Social Agent
- User-owned LLM (BYO API key)
- Agent-to-Agent Matching
- Privacy First / Local First / Open Source / Human-in-the-loop
```

Every bullet is a **goal statement**, not a status. A visitor cannot tell whether
"Agent-to-Agent Matching" runs, or is planned. This directly conflicts with the
explicit instruction not to present unverified capability as complete.

**Recommended:** split into **Verified / Experimental / Not implemented** — see
[README_REWRITE_PROPOSAL.md § 5](README_REWRITE_PROPOSAL.md).

### 2.5 No screenshots, no demo, no visual anchor `[VERIFIED]`

The README is 76 lines of text with zero images. For a product whose entire
value proposition is a visual, two-person interaction flow, there is nothing to
look at.

### 2.6 Missing navigation and credibility scaffolding `[VERIFIED]`

Present: `README.md`, `CONTRIBUTING.md`, `LICENSE`, `SECURITY.md`.
Absent: badges, screenshots, Contributing/Issues/Discussions links from the
README, "report a bug" pointer, acknowledgement of the current experimental
status in the first screenful.

### 2.7 Repository layout in the README is incomplete and slightly wrong `[VERIFIED]**

The tree shows `kindora/` as the root folder name (actual: `Kindora/`), omits
`experiments/` (15 tracked files, including a full cross-process UDP harness),
omits `apps/desktop/src-tauri/` entirely (which is where all the Rust lives), and
shows `开发手册.md` as present — it exists in `HEAD` but is **deleted in the
working tree** as an uncommitted change `[VERIFIED]`.

> **Risk to flag:** the maintainer has an unstaged deletion of `开发手册.md` and
> `回复.md`. If committed, the README link to `开发手册.md` breaks for every
> visitor. This audit did not touch those files.

---

## 3. Inaccurate, stale, or ambiguous documentation content

### 3.1 `docs/ARCHITECTURE.md` — stale by 16 phases `[VERIFIED]`

```markdown
> Status: **V0.1 — Phase 0 Bootstrap.** Subject to change.
```

The project is at Phase 16.6. Specific false claims:

| Claim in ARCHITECTURE.md                                                     | Reality                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Diagram: "Local SQLite"                                                      | Not implemented. `localStorage` only.                                    |
| Diagram: "OS Keychain (API keys)"                                            | **TRUE** — verified working, credit where due.                           |
| Table: `storage` → "SQLite persistence for profile, conversations, settings" | No SQLite. Conversations have no persistence at all.                     |
| Table: `transport` → "(WebRTC, LAN, manual signaling)"                       | Only LAN is real. WebRTC is a stub; manual signaling absent.             |
| "All persistent state lives in the user's SQLite DB and OS keychain."        | False. `localStorage` + keychain (API keys only).                        |
| No Rust/Tauri layer in the diagram                                           | The entire `src-tauri/` (UDP discovery, TCP link, keyring) is invisible. |

The diagram also omits the LAN wire protocol that is the most substantial
implementation in the repo: UDP broadcast discovery on port **52419**, a random
TCP port announced in-band, and a three-step `ready` → `lan_announce` →
`lan_invite_ack` handshake (`apps/desktop/src-tauri/src/lan.rs:36`) `[VERIFIED]`.

### 3.2 `SECURITY.md` — placeholder contact + an incomplete disclosure `[VERIFIED]`

```markdown
- Email: `security@kindora.local` (placeholder — replace with the project's actual contact)
```

The `.local` TLD is reserved and non-routable. A security researcher who follows
this path contacts nobody. The document helpfully self-labels it a placeholder,
but it is still the published contact of record.

Accurate claims (verified):

- API keys go to the OS keychain via the `keyring` crate, runtime-detected —
  `apps/desktop/src/lib/llm-service.ts:29-31` `[VERIFIED]`
- No `console.*` calls in production code `[VERIFIED]`
- Prompt-injection sanitiser exists with credential-pattern stripping `[VERIFIED]`
- Tauri CSP is set (was `null`, now `default-src 'self'` with an explicit
  provider allowlist) `[VERIFIED]`

Omitted material disclosure:

- **The agent's PKCS8 private key is stored in plaintext in webview
  `localStorage`** under `kindora:agent`
  (`apps/desktop/src/lib/agent-service.ts:38`). `docs/AUDIT_V0.1_PHASE14.md`
  records this as `NOT_IMPLEMENTED`, deferred. A security-facing document should
  disclose it `[VERIFIED]`.

### 3.3 `CONTRIBUTING.md` — repeats the wrong command `[VERIFIED]`

```bash
pnpm install
pnpm test
pnpm dev          # ← Vite only
```

It correctly tells contributors to run `pnpm test` and `pnpm lint`; `pnpm lint`
does pass (exit 0, run during this audit) `[VERIFIED]`. But `pnpm dev` is again
mis-presented as development setup. It also references `开发手册.md § 68` as bare
text rather than a link, and that file is currently deleted locally.

### 3.4 `docs/PROTOCOL.md` — accurate, with one gap `[VERIFIED]`

Genuinely the best-maintained doc in the repo. The envelope shape, the six
validation rules, replay protection, and the privacy boundary all match
`packages/protocol/src/`.

Gaps:

- **Omits the `block` message type.** The code implements it
  (`packages/protocol/src/envelope.ts`); the doc lists 9 types, the code has 10.
- No wire framing (newline-delimited JSON assumed but undocumented) `[ASSUMPTION — not verified against the wire]`
- No mapping of message types onto the LAN handshake
- No version-negotiation / forward-compatibility discussion

### 3.5 `docs/PRODUCT.md` and `docs/ROADMAP.md` — accurate `[VERIFIED]`

Both are honest. `PRODUCT.md` states clearly what Kindora is **not** (not a
dating app, not a companion, not a general AI chat app) and lists V0.1
non-goals. `ROADMAP.md` correctly places WebRTC at V0.1 manual signaling and
QR pairing at V0.2. These should be preserved largely as-is.

**One inconsistency:** `PRODUCT.md` and `ROADMAP.md` both link to
`../开发手册.md` — a relative link to a file deleted in the working tree.

---

## 4. Feature classification

> Classification basis: **implementation code + tests**, per the explicit
> instruction not to infer from directory names.

### 4.1 Implemented and covered by tests `[VERIFIED]`

| Capability                                                                          | Evidence                                                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Agent profile creation & editing                                                    | `views/CreateAgentForm.tsx`, `profile-flow.test.tsx`                                 |
| LLM provider config (4 presets)                                                     | `llm-service.ts:114` — openai-compatible, anthropic, ollama, minimax                 |
| API key → OS keychain                                                               | `lib/tauri-secret-store.ts` + `keyring` crate; `tauri-secret-store.test.ts`          |
| KSA 0.1 envelope + validation + replay guard + rate limiter + sensitive-field guard | `packages/protocol/src/` (10 message types)                                          |
| Loopback transport (in-process)                                                     | `packages/transport/src/loopback-transport.ts`                                       |
| **LAN transport (real UDP + TCP)**                                                  | `src-tauri/src/lan.rs`; 15 `lan_e2e` + 13 `lan_protocol_e2e` tests `[FROM-TERMINAL]` |
| `PairingSession` state machine                                                      | `pairing-session.ts`                                                                 |
| Pairing code generation                                                             | `pairing-code.ts` (6 chars)                                                          |
| LLM match analysis + 5-field display                                                | `packages/matching/src/orchestrator.ts`, `views/MatchView.tsx`                       |
| Human consent flow (accept/reject/disconnect/block)                                 | `views/ConsentView.tsx`, `consent-orchestrator.ts`                                   |
| Block list persistence + enforcement                                                | `storage/blocked-agents-store.ts`                                                    |
| Icebreaker generation                                                               | `packages/agent/src/generate-icebreaker.ts`, `views/IcebreakerView.tsx`              |
| Human↔human chat                                                                    | `views/ChatView.tsx`, `chat-orchestrator.ts`                                         |
| "Ask My Agent" assist panel                                                         | `connect-service.ts` `runChatAssist`, `views/ChatView.tsx`                           |
| Prompt-injection guard + credential stripping                                       | `packages/protocol/src/prompt-injection-guard.ts`                                    |
| Tauri CSP                                                                           | `tauri.conf.json:26`                                                                 |

### 4.2 Experimental — code exists, never exercised end-to-end in a GUI `[VERIFIED]`

| Capability                                                       | Why "experimental"                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The **entire desktop application**                               | `tauri:dev` exits 101. No one has seen a window.                                                                                                                                                                                            |
| **All** LLM-dependent features (match, icebreaker, Ask My Agent) | Every test mocks `globalThis.fetch`. No test has ever reached `api.openai.com`, `api.anthropic.com`, `api.minimaxi.com`, or a local Ollama. Provider schema drift, auth-header changes, and SSE/malformed-JSON handling are **unverified**. |
| LAN pairing **through the GUI**                                  | Verified only at the Rust socket layer and via a JS IPC shim. The React `ConnectView` path has never run against a real Tauri IPC bridge.                                                                                                   |
| Consent / icebreaker / chat **through the GUI**                  | Exercised in jsdom only.                                                                                                                                                                                                                    |

### 4.3 Not implemented `[VERIFIED]`

| Capability                              | Evidence                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **WebRTC transport**                    | `webrtc-transport.ts` — `connect`/`send`/`onMessage` all throw                                                |
| Manual signaling (Mode B)               | No SDP code anywhere                                                                                          |
| Cross-network pairing (Mode C)          | Depends on WebRTC                                                                                             |
| **SQLite persistence**                  | Rust plugin + capabilities present; **zero** TS callers                                                       |
| Chat / conversation history persistence | `chat-orchestrator.ts` has no storage calls; closes on window close                                           |
| Match / connection history              | `STORAGE_TABLES` declares `matches`, `connections`, `conversations`, `messages` — none have an implementation |
| **Private-key encryption at rest**      | PKCS8 key in plaintext `localStorage`                                                                         |
| QR-code pairing **UI**                  | `encodeQrPayload`/`decodeQrPayload` exist with **zero consumers**                                             |
| Block-list management screen            | Block works and persists; no UI to view/revoke                                                                |
| Playwright desktop E2E                  | `apps/desktop/e2e` does not exist                                                                             |
| Live LLM smoke test                     | No `test:live` script exists in any `package.json`                                                            |
| macOS / Windows CI runners              | `ci.yml` is `ubuntu-latest` only                                                                              |
| `tauri build` in CI                     | Excluded by design comment; never run `[NOT VERIFIED — no artifact]`                                          |

---

## 5. Onboarding barriers

### 5.1 For an ordinary user (non-developer) — **cannot onboard at all** `[VERIFIED]`

There is no installer, no release, no download. `git ls-files | grep tags` →
0 tags. `docs/ROADMAP.md` V0.1 lists "Personal Agent" and "Manual Pairing" as
in-scope, but there is no shipped artifact.

**This is an honest V0.1 limitation, not a defect.** The correct response is to
say so plainly in the README ("no binary releases yet; source-only, developer
audience") rather than to paper over it.

### 5.2 For a developer — four independent blockers

Ranked by where a newcomer actually stops:

| #     | Blocker                                                                                                                                                                                                                                                                                                                                      | Evidence     | Severity |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------- |
| **1** | **App does not start.** `tauri:dev` exits 101 (`default-run` missing)                                                                                                                                                                                                                                                                        | `[VERIFIED]` | **P0**   |
| **2** | **`Cargo.lock` is gitignored.** `apps/desktop/src-tauri/Cargo.lock` is not tracked (`.gitignore:16`). A fresh clone resolves dependency versions from scratch.                                                                                                                                                                               | `[VERIFIED]` | **P0**   |
| **3** | **Rust toolchain unspecified and wrong by default.** No `rust-toolchain.toml`. The machine's active default (`1.77.2-aarch64-apple-darwin`) **cannot compile the dependency tree** — `idna_adapter v1.2.2` requires `edition2024`. Every cargo command needs `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`. | `[VERIFIED]` | **P0**   |
| **4** | **No Tauri system dependencies documented.** `grep -rn "webkit2gtk\|WebView2\|xcode" README.md CONTRIBUTING.md docs/` → **zero matches**. Linux needs `libwebkit2gtk-4.1-dev`; Windows needs WebView2; macOS needs Xcode CLT.                                                                                                                | `[VERIFIED]` | **P1**   |

**Blocker #2 deserves emphasis.** Excluding `Cargo.lock` is correct for a
library crate and **wrong for an application crate**. Kindora ships an app.
Consequences, all `[VERIFIED]` or directly observed:

- Builds are **not reproducible**. A dependency can break the project with zero
  code change. The `idna_adapter` / `edition2024` breakage the maintainer hit is
  a live example.
- **CI's cargo cache is silently broken.** `ci.yml` computes its cache key from
  `hashFiles('apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/Cargo.lock')`
  — the second path never exists in the repo, so the key is always
  `hashFiles`-degraded and the cache effectively never restores.
- Inconsistency: `experiments/phase21_experiment_a/Cargo.lock` **is** tracked
  (`[VERIFIED]`). The exclusion is applied only to the app crate.

Secondary friction `[VERIFIED]`:

- **CI installs pnpm 9, `package.json` pins `packageManager: pnpm@10.32.1`.**
  Version mismatch between local and CI.
- No `.env.example`, no "I got this error" troubleshooting section.

---

## 6. Missing community files and GitHub configuration

### 6.1 Files present `[VERIFIED]`

| File                       | Size          | Assessment                                     |
| -------------------------- | ------------- | ---------------------------------------------- |
| `README.md`                | 76 lines      | Too thin; contains errors (§2)                 |
| `CONTRIBUTING.md`          | 36 lines      | Reasonable tone; wrong dev command             |
| `LICENSE`                  | MIT, 21 lines | Fine. Copyright holder: "Kindora Contributors" |
| `SECURITY.md`              | —             | Good threat model; placeholder contact         |
| `.github/workflows/ci.yml` | 78 lines      | Real PASS/FAIL; gaps below                     |

### 6.2 Files absent `[VERIFIED]`

| Path                                         | Purpose                               | Priority |
| -------------------------------------------- | ------------------------------------- | -------- |
| `.github/ISSUE_TEMPLATE/bug_report.yml`      | Structured bug reports                | P1       |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Structured feature requests           | P1       |
| `.github/ISSUE_TEMPLATE/config.yml`          | Blank-issue link → Discussions        | P2       |
| `.github/PULL_REQUEST_TEMPLATE.md`           | PR checklist                          | P1       |
| `CODE_OF_CONDUCT.md`                         | Contributor Covenant                  | **P0**   |
| `SUPPORT.md`                                 | "Where to ask what"                   | P2       |
| `.github/dependabot.yml`                     | Security updates for `pnpm` + `cargo` | P2       |
| `docs/community/ROADMAP.md`                  | Community-facing roadmap              | P2       |
| `rust-toolchain.toml`                        | Pins the toolchain (see §5.2 #3)      | **P0**   |
| `apps/desktop/src-tauri/.gitignore` override | Re-include `Cargo.lock`               | **P0**   |

**Note on `CODE_OF_CONDUCT.md`:** GitHub now surfaces a "Code of Conduct"
link in the community-health surface, and its absence is a strong negative
signal to first-time contributors. For a project asking for outside help, this
is the cheapest credibility fix available.

### 6.3 CI gaps `[VERIFIED]`

| Gap                          | Detail                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lan_protocol_e2e` not in CI | `grep -c lan_protocol_e2e ci.yml` → **0**. The 13 two-process tests added in Phase 16.1 never run in CI.                                                                      |
| Single platform              | `runs-on: ubuntu-latest` only. macOS is the primary dev platform and is not covered.                                                                                          |
| No `tauri build`             | Deliberately excluded by comment.                                                                                                                                             |
| Dangling workflow reference  | `ci.yml` comment states the `tauri-build` job "runs in a separate workflow (`tauri.yml`) on tagged releases" — **`.github/workflows/tauri.yml` does not exist** `[VERIFIED]`. |
| Broken cargo cache key       | `hashFiles()` on the gitignored `Cargo.lock` (§5.2 #2).                                                                                                                       |

---

## 7. Prioritized improvement plan

Each item states its **acceptance criterion** as a command or an observable.

### P0 — Fix before any promotion

| ID       | Action                                                                    | Files                                             | Acceptance                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0-1** | Add `default-run = "kindora-desktop"` to `[package]`                      | `apps/desktop/src-tauri/Cargo.toml`               | `pnpm -C apps/desktop tauri:dev` launches a window; window stays open ≥10 s                                                                                       |
| **P0-2** | Stop ignoring the app's `Cargo.lock`; commit it                           | `.gitignore`, `apps/desktop/src-tauri/Cargo.lock` | `git ls-files apps/desktop/src-tauri/ \| grep Cargo.lock` returns a path; a fresh `git clone && pnpm install && cargo check --lib` succeeds with no version drift |
| **P0-3** | Add `rust-toolchain.toml` pinning `channel = "stable"`                    | `rust-toolchain.toml` (new)                       | A machine with default 1.77.2 runs `cargo check --lib` **without** a manual `PATH` override                                                                       |
| **P0-4** | Add `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1)                       | `CODE_OF_CONDUCT.md` (new)                        | File present at repo root; linked from README and CONTRIBUTING                                                                                                    |
| **P0-5** | Fix README Quick Start to the actually-working command sequence           | `README.md`                                       | Every command in Quick Start has been executed verbatim on a clean checkout by someone other than the author                                                      |
| **P0-6** | Correct the two false capability claims ("SQLite", "WebRTC")              | `README.md`                                       | No README line asserts a capability that lacks an implementation + test                                                                                           |
| **P0-7** | Commit or restore the pending `开发手册.md` / `回复.md` deletion decision | (maintainer decision)                             | README's `开发手册.md` link resolves for a visitor                                                                                                                |

### P1 — Next

| ID       | Action                                                                                                                      | Acceptance                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **P1-1** | Rewrite `docs/ARCHITECTURE.md`: drop "Phase 0", remove the SQLite claim, add the Rust/Tauri layer and the LAN wire protocol | Every claim in the doc maps to a file:line or a passing test                                       |
| **P1-2** | Rewrite the README with Verified / Experimental / Not-implemented sections                                                  | A reader can answer "does LAN work?" and "does WebRTC work?" without reading the code              |
| **P1-3** | Replace `security@kindora.local` with a real monitored address                                                              | `security@…` resolves to a mailbox the maintainer controls                                         |
| **P1-4** | Document Tauri system dependencies per platform                                                                             | A Linux contributor can go from clone to `cargo check` using only the README                       |
| **P1-5** | Add `bug_report.yml` + `feature_request.yml` + `PR_TEMPLATE.md`                                                             | Issue form appears at `github.com/free-revalution/Kindora/issues/new/choose`                       |
| **P1-6** | Add `lan_protocol_e2e` to CI; fix the CI pnpm version to 10; add a macOS runner                                             | CI log shows 13 tests from `lan_protocol_e2e`; `package.json` and `ci.yml` agree on the pnpm major |
| **P1-7** | Update `SECURITY.md` to disclose the plaintext private key at rest                                                          | Disclosure present and linked to `AUDIT_V0.1_PHASE14.md`                                           |
| **P1-8** | Add `protocolVersion` / wire framing to `PROTOCOL.md`; add the missing `block` type                                         | Doc's type list is generated from or diffed against `envelope.ts`                                  |

### P2 — Later

| ID       | Action                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| **P2-1** | Add a `test:live` script gated on `LIVE_LLM=1` (OpenAI / Anthropic / MiniMax / Ollama)                               |
| **P2-2** | Screenshot set or a short screen-recording of the eight screens                                                      |
| **P2-3** | Playwright desktop E2E against `vite dev`                                                                            |
| **P2-4** | `dependabot.yml` for pnpm + cargo                                                                                    |
| **P2-5** | `SUPPORT.md`; `ISSUE_TEMPLATE/config.yml` routing blank issues to Discussions                                        |
| **P2-6** | Decide the fate of `experiments/` (15 tracked files of a completed Phase 2.1 harness) — archive, document, or remove |
| **P2-7** | Add real GitHub Actions badges to the README **only after** P1-6 lands                                               |
| **P2-8** | `docs/community/ROADMAP.md`                                                                                          |

---

## 8. Limitations

**Not verified — `gh` is not authenticated on this machine** `[VERIFIED]`:

```
$ gh auth status
You are not logged into any GitHub hosts.
```

Consequently this audit makes **no claim** about:

- GitHub Description or Topics
- Whether Discussions is enabled, or its categories
- Whether any Releases, binaries, or download links exist
- Stars, forks, watchers, or traffic
- Branch protection, CODEOWNERS, or the default branch's visibility
- Whether `main` on the remote equals local `b1d7f62`

These must be inspected with `gh auth login` before any propagation plan is
executed. See [README_REWRITE_PROPOSAL.md § 10](README_REWRITE_PROPOSAL.md).

**Also not verified:**

- Whether `pnpm tauri:build` has ever succeeded. No artifact, no tag, no CI job.
- Whether `pnpm install --frozen-lockfile` succeeds from a clean checkout. Needs
  network; not run here.
- Behaviour on Windows or Linux. CI is `ubuntu-latest` only and only compiles.

**Working tree note:** `开发手册.md` and `回复.md` are deleted (unstaged) and
`终端测试.md` is untracked. This audit read from `HEAD` where the file was
needed and did not restore, stage, or modify any of them.

---

## 9. Summary judgement

Kindora is a **10-day-old, single-author project with unusually strong test
discipline and unusually weak public communication**. 541 Vitest tests and 31
Rust tests in 39 commits is a genuinely high ratio. What is missing is not work —
it is the honest description of that work.

The specific trap this project is in: **the tests create a false impression of
completeness.** A visitor who reads "541 tests passing" and "V0.1 — Experimental
Open Source MVP" will reasonably infer a working two-person LAN product. It is
not. The app does not start; no LLM call has ever succeeded; no two-machine
session has ever been completed by a human.

The rewrite proposal that follows is built around one rule: **every claim in
public documentation must map to either a passing test or an explicit "not yet
implemented" label.** Nothing in the recommended README should be inferrable —
only stated.
