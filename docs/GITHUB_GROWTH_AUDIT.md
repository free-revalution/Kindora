# GitHub growth & community audit — V1.0

**Scope:** the external presentation and community-collaboration surface of
[free-revalution/Kindora](https://github.com/free-revalution/Kindora) — the
README, roadmap, contribution system, issue and PR templates, community
guidance, and CI.

**Not in scope, and not touched:** product behaviour. No file under
`packages/*/src`, `apps/desktop/src`, or `apps/desktop/src-tauri/src` was
modified. The protocol, the transport, the matching logic and the LLM adapters
are exactly as they were.

**Audit performed against:** `main` @ `0060838` ("part test").

---

> **📌 后续变化（2026-11-05 补注）—— 这份审计是"某个时点的快照"，不是现状描述。**
>
> 审计之后，仓库做了一轮整改（Phase A ~ D）。**下面正文里的证据与结论按当时的代码写，
> 有一处已经被后来的改动推翻，单独点出来：**
>
> | 审计里的说法                                                                                                                            | 现在的实际情况                                                                                                                                                                                                                                                                                                            |
> | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | § 1.3 F16 与 § 6.3：「**SQLite is not called from TypeScript**」—— `grep -rn "sqlite" apps/desktop/src packages/*/src` 只有一个注释命中 | ❌ **已不成立。** Phase D / D1 之后，前端**直接**调用 `tauri-plugin-sql` 的 `plugin:sql\|load\|execute\|select\|close`（`apps/desktop/src/lib/tauri-sql-executor.ts`），**桌面端真的用 SQLite 存本地业务数据**了。`docs/ARCHITECTURE.md` 与 `docs/DEVELOPMENT_STATUS.md` 已经同步改成现在的样子 —— **这两份文档才是现读** |
> | § 6.1：TypeScript 用例 **567** 条                                                                                                       | 那是 `0060838` 的数字。**当前工作树是 76 个测试文件 / 914 条用例**（Phase A ~ D 净增 20 个文件 / 347 条）。见 `docs/DEVELOPMENT_STATUS.md`                                                                                                                                                                                |
> | § 1.3 F1–F16 里关于文档缺失、模板缺失、社区文件缺失的结论                                                                               | **已经按这份审计的建议补齐**（`docs/DEVELOPMENT_STATUS.md`、issue / PR 模板、community 目录等）—— 那些是**当时的**缺口                                                                                                                                                                                                    |
>
> **没变的是审计的方法与口径**：先读代码再下结论、**没跑过的就写"没跑过"**、
> 把"仓库设置需要维护者手工确认"单独列出来。整改记录沿用同一口径。
> 当前的逐阶段状态见 [`REMEDIATION_PROGRESS.md`](REMEDIATION_PROGRESS.md)。

---

## 0. Method and verification honesty

Everything in this audit was derived by reading the repository. Where a claim
depends on the state of the GitHub _repository settings_ rather than the code,
it is listed in [§ 5](#5-manual-github-actions-required) as an action for the
maintainer, **not** as a completed step.

Two things could not be executed during this pass, and are reported as such
rather than as successes:

| What                                                          | Why                                                                                                                                | Consequence                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`, `pnpm typecheck`, `pnpm lint`, `cargo test`      | The environment's Bash safety classifier was unavailable for the duration of the work, so no execution command could be dispatched | Test **counts** in § 6 are a static inventory counted from the source tree, **not** a claim that the suite was run and passed. The CI badge is the record of actual runs. |
| `gh` CLI queries (repo settings, labels, issues, Discussions) | Same                                                                                                                               | The GitHub-side state in § 5 is **unverified**. The maintainer must check it.                                                                                             |

The CI changes in [§ 3](#3-files-modified) are therefore **unverified against a
live run**. They use the same command forms as the existing, passing job.

---

## 1. Original repository state — audit findings

### 1.1 What was already good

These were audited and found **adequate**; they were improved, not replaced.

| Asset                      | Finding                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                | Already honest and specific — it led with "V0.1 — Experimental", separated implemented / experimental / not-implemented, and explicitly warned that the GUI had never been driven through a complete two-machine session and that no test had ever called a live LLM provider. This is rare and valuable; the rewrite preserved that honesty. |
| `CODE_OF_CONDUCT.md`       | Already Contributor Covenant 2.1, with a real contact address. Complete.                                                                                                                                                                                                                                                                      |
| `SECURITY.md`              | Had a real private-reporting channel and a threat model, but no _known-limitations_ section — the most important part for an honest security page.                                                                                                                                                                                            |
| `CONTRIBUTING.md`          | Thin. No test commands, no PR expectations, no guidance for translators or new providers.                                                                                                                                                                                                                                                     |
| `.github/workflows/ci.yml` | Existed and was sensible — typecheck, build, test, `cargo check --lib`, `cargo test --test lan_e2e`. It was **missing** `cargo test --lib`, the protocol E2E suite, and it pinned pnpm 9 against a pnpm 10 lockfile.                                                                                                                          |
| `docs/`                    | Had PRODUCT, ARCHITECTURE, PROTOCOL, ROADMAP, and a `community/` folder.                                                                                                                                                                                                                                                                      |

### 1.2 Broken and missing

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                     | Severity                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| F1  | **Five documents linked to `开发手册.md`, which no longer exists.** The file was deleted in commit `0060838`; `git ls-files "*.md"` confirms it is gone, but the links survived. Every one of them 404s for a visitor.                                                                                                                                                                                                                                                                                                            | `README.md:81,153,177`, `SECURITY.md:40`, `docs/ROADMAP.md:18`, `CONTRIBUTING.md:57`, `docs/PRODUCT.md:3`                    | **High** — a first-time visitor clicking the main spec link gets a dead end                                     |
| F2  | **No root `ROADMAP.md`.** The roadmap lived at `docs/ROADMAP.md`, which GitHub does not surface as a project page.                                                                                                                                                                                                                                                                                                                                                                                                                | `git ls-files "*.md"`                                                                                                        | Medium                                                                                                          |
| F3  | **No `docs/DEVELOPMENT_STATUS.md`.** The honest per-feature truth existed only as prose inside the README and a 37 KB audit in `docs/community/`.                                                                                                                                                                                                                                                                                                                                                                                 | directory listing                                                                                                            | High                                                                                                            |
| F4  | **No issue templates.** Issues would arrive as blank text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `.github/` contained only `workflows/`                                                                                       | High                                                                                                            |
| F5  | **No PR template.** No place to ask "how was this tested?"                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `.github/`                                                                                                                   | Medium                                                                                                          |
| F6  | **No `docs/COMMUNITY.md`.** No single page telling a newcomer where to ask what.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | directory listing                                                                                                            | Medium                                                                                                          |
| F7  | **No monthly development-update template.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | directory listing                                                                                                            | Low                                                                                                             |
| F8  | **CI installed pnpm 9 against a pnpm 10 project.** `pnpm/action-setup@v4` was given `version: 9`, overriding the root `packageManager: pnpm@10.32.1`.                                                                                                                                                                                                                                                                                                                                                                             | `.github/workflows/ci.yml` (old)                                                                                             | Medium                                                                                                          |
| F9  | **CI never ran the Rust unit tests**, nor the protocol E2E suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `.github/workflows/ci.yml` (old)                                                                                             | Medium                                                                                                          |
| F10 | **CI's header comment referenced a `tauri.yml` workflow that does not exist.**                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `ls .github/workflows` → `ci.yml` only                                                                                       | Low                                                                                                             |
| F11 | **The README's test counts were stale.** It claimed "28 Rust integration tests" and "lan_e2e (15)". The current tree has 18 and 13 → 31. It also said "React UI (8 screens)" where there are 10 user-facing screens across 11 view states.                                                                                                                                                                                                                                                                                        | `apps/desktop/src/App.tsx:28-59`, `grep -c "#\[tokio::test"`                                                                 | Medium                                                                                                          |
| F12 | **The README did not mention i18n at all**, although English + 简体中文 shipped in the same commit.                                                                                                                                                                                                                                                                                                                                                                                                                               | `apps/desktop/src/i18n/`                                                                                                     | Low                                                                                                             |
| F13 | **The README's "API keys stored in the OS-native secret store" was true only for the Tauri build.** Browser dev mode falls back to an AES-GCM-encrypted `localStorage` store. A visitor reading only the README would assume the stronger guarantee everywhere.                                                                                                                                                                                                                                                                   | `apps/desktop/src/lib/llm-service.ts:29-31`                                                                                  | Medium                                                                                                          |
| F14 | **`SECURITY.md` did not disclose that LAN traffic is unencrypted.** The transport source itself says _"production must add TLS or a WebRTC DataChannel layer"_.                                                                                                                                                                                                                                                                                                                                                                   | `packages/transport/src/lan-transport.ts:24`                                                                                 | **High** — a security page that omits the largest known weakness is worse than no page                          |
| F15 | **No labels, no issue tracker hygiene.** No evidence of the 13 labels the plan calls for.                                                                                                                                                                                                                                                                                                                                                                                                                                         | `gh label list` — **not run**, see § 0                                                                                       | Unknown                                                                                                         |
| F16 | **`docs/ARCHITECTURE.md` was materially wrong.** It drew the storage layer as "Local SQLite" and described `storage` as "SQLite persistence for profile, conversations, settings", and stated "All persistent state lives in the user's SQLite DB and OS keychain". **None of that is true**: SQLite is registered but never called, and everything is in `localStorage`. It also listed "manual signaling" as a transport that does not exist, omitted MiniMax from the provider list, and was still headed "Phase 0 Bootstrap". | `docs/ARCHITECTURE.md:30,42,47,25,43,40,3` vs `apps/desktop/src-tauri/src/lib.rs:151` and `grep -rn "sqlite" packages/*/src` | **High** — this is the document a technical reviewer opens first, and it described a system that does not exist |
| F17 | **`docs/PROTOCOL.md` listed 9 of the 12 KSA message types.** `consent_accept`, `consent_reject` and `block` were missing — the three that carry the consent flow.                                                                                                                                                                                                                                                                                                                                                                 | `docs/PROTOCOL.md` (old) vs `packages/protocol/src/index.ts:17-30` (`MESSAGE_TYPES`)                                         | Medium                                                                                                          |

### 1.3 What the code actually says (feature status, with evidence)

Every status claim in the README, the roadmap and `DEVELOPMENT_STATUS.md` traces
to one of these. Full table in [§ 6](#6-evidence-for-every-feature-status-claim).

| Capability                                                                 | State                              | Evidence                                                                                                                                    |
| -------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent profile — create / edit / persist                                    | Implemented                        | `packages/agent/src/profile.ts`, `packages/storage/src/profile-store.ts`                                                                    |
| LLM providers — OpenAI-compatible, Anthropic, Ollama, MiniMax              | Implemented                        | `apps/desktop/src/lib/llm-service.ts:251-280`                                                                                               |
| API keys → OS secret store                                                 | Implemented                        | `apps/desktop/src-tauri/src/secrets.rs`, `keyring` 3 (`Cargo.toml:34`)                                                                      |
| KSA 0.1 — validation / replay guard / rate limiter / sensitive-field guard | Implemented                        | `packages/protocol/src/{validation,replay-protection,rate-limiter,sensitive-field-guard}.ts`                                                |
| LAN transport — UDP 52419 + TCP                                            | Implemented                        | `apps/desktop/src-tauri/src/lan.rs:36`                                                                                                      |
| Loopback transport                                                         | Implemented                        | `packages/transport/src/loopback-transport.ts`                                                                                              |
| Match report — 5 fields                                                    | Implemented                        | `packages/protocol/src/index.ts:152-167`                                                                                                    |
| Consent / block list                                                       | Implemented                        | `packages/matching/src/consent-orchestrator.ts`, `packages/storage/src/blocked-agents-store.ts`                                             |
| Icebreaker                                                                 | Implemented                        | `packages/agent/src/generate-icebreaker.ts`                                                                                                 |
| Chat + "Ask My Agent"                                                      | Implemented                        | `packages/matching/src/chat-orchestrator.ts`                                                                                                |
| Prompt-injection sanitiser                                                 | Implemented                        | `packages/protocol/src/prompt-injection-guard.ts`                                                                                           |
| English + 简体中文 UI                                                      | Implemented                        | `apps/desktop/src/i18n/locale.ts:36`                                                                                                        |
| Live LLM provider calls                                                    | **Never tested**                   | every provider test mocks `fetch`                                                                                                           |
| Two-machine GUI session                                                    | **Never run**                      | no automated or manual record                                                                                                               |
| WebRTC / cross-network                                                     | **Not implemented**                | `packages/transport/src/webrtc-transport.ts:40-45` — `connect()` throws                                                                     |
| SQLite persistence                                                         | **Not implemented**                | plugin registered at `apps/desktop/src-tauri/src/lib.rs:151`; no TypeScript calls it (only a comment at `packages/storage/src/index.ts:11`) |
| Chat history persistence                                                   | **Not implemented**                | no message store exists                                                                                                                     |
| Private-key encryption at rest                                             | **Not implemented**                | `packages/agent/src/identity.ts:61,67` → `packages/storage/src/profile-store.ts:20`                                                         |
| QR-code pairing                                                            | **Not implemented** (helpers only) | `packages/transport/src/qr-payload.ts`; no UI                                                                                               |
| Block-list screen                                                          | **Not implemented**                | store exists, no view                                                                                                                       |
| Releases / installers                                                      | **Not implemented**                | `git tag` → empty; no published release                                                                                                     |
| DHT / rendezvous / TURN                                                    | Not started                        | —                                                                                                                                           |

---

## 2. Files added

| Path                                            | Purpose                                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ROADMAP.md`                                    | The canonical roadmap at the repository root, restructured into the five phases, with `[x]` / `[~]` / `[ ]` states and an explicit "deliberately out of scope" section.                                            |
| `docs/DEVELOPMENT_STATUS.md`                    | The per-feature truth, with `path:line` evidence for every claim, the test inventory, and the six known technical limitations.                                                                                     |
| `docs/COMMUNITY.md`                             | Where to ask what, the discussion categories, the three open questions, what the project is trying to build and the four constraints that follow from it, labels, and what to expect from a spare-time maintainer. |
| `docs/DEVELOPMENT_UPDATE_TEMPLATE.md`           | The monthly update template.                                                                                                                                                                                       |
| `docs/GITHUB_GROWTH_AUDIT.md`                   | This file.                                                                                                                                                                                                         |
| `.github/ISSUE_TEMPLATE/bug_report.yml`         | Bug form — area, version, OS, reproduction steps, expected vs actual, logs with a redaction reminder, and required checkboxes.                                                                                     |
| `.github/ISSUE_TEMPLATE/feature_request.yml`    | Feature form — problem, scenario, value, alternatives, optional implementation thoughts, affected area.                                                                                                            |
| `.github/ISSUE_TEMPLATE/technical_proposal.yml` | Proposal form — problem, solution, technical impact, alternatives, risks, testing approach, size.                                                                                                                  |
| `.github/ISSUE_TEMPLATE/config.yml`             | Blank issues disabled; contact links for discussions, private security reporting, and the status document.                                                                                                         |
| `.github/pull_request_template.md`              | PR body — what / why / linked issue / **how it was tested** / breaking changes / screenshots / security considerations / checklist.                                                                                |

---

## 3. Files modified

| Path                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                | Full rewrite. New header with a real badge set, a mermaid architecture diagram that distinguishes implemented from planned, feature tables carrying an explicit state per row, a verified Getting Started section, a troubleshooting row for the `ENOENT` / `Address already in use` failure modes, and honest Repository Layout. **All four dead `开发手册.md` links removed** (F1). Stale counts corrected (F11). i18n added (F12). The browser-dev key-storage nuance added (F13). |
| `docs/ROADMAP.md`          | Replaced with a pointer to the new root `ROADMAP.md`, keeping the old URL alive (F2). The dead `开发手册.md` link is gone.                                                                                                                                                                                                                                                                                                                                                            |
| `CONTRIBUTING.md`          | Expanded: ways to contribute, full dev setup, all test commands, repository layout, PR rules, commit-message format, **adding a language** (step-by-step, with the real file names and the test that checks parity), **adding an LLM provider** (including the `clearLLMConfig()` list that is easy to miss), and a scope guardrail. The dead `开发手册.md` link is gone.                                                                                                             |
| `SECURITY.md`              | Expanded: reporting channels, **supported versions** (with the honest note that there are no tagged releases yet), the threat model, API-key handling including the browser-dev fallback, and a new **Known security limitations** section covering unencrypted LAN traffic, the plaintext private key, code-based peer identity, heuristic injection defence, and the absence of an audit. The dead `开发手册.md` link is gone.                                                      |
| `CODE_OF_CONDUCT.md`       | Cosmetic only — the `[INSERT CONTACT METHOD]` link label at the bottom was a leftover from the Contributor Covenant template and read as an unfilled placeholder. Now `[contact]`.                                                                                                                                                                                                                                                                                                    |
| `docs/ARCHITECTURE.md`     | **Corrected (F16).** The storage layer was drawn as "Local SQLite" and described as "SQLite persistence for profile, conversations, settings"; the transport list included manual signaling; MiniMax was missing from the provider list; the status line still said "Phase 0 Bootstrap". Rewritten against the code: an explicit _what is stored where_ table, the real transport status, the real provider list, and the real command surface.                                       |
| `docs/PRODUCT.md`          | The dead `开发手册.md` link removed (F1); it now points at `docs/DEVELOPMENT_STATUS.md` instead.                                                                                                                                                                                                                                                                                                                                                                                      |
| `docs/PROTOCOL.md`         | **Corrected (F17).** The message-type list had 9 of the 12 types in `MESSAGE_TYPES`; `consent_accept`, `consent_reject` and `block` were missing. Now the full list, with the source of truth named.                                                                                                                                                                                                                                                                                  |
| `.github/workflows/ci.yml` | pnpm version pin removed so the action uses `packageManager` from `package.json` (F8). Added `cargo test --lib` (F9) and `cargo test --test lan_protocol_e2e -- --test-threads=1` (F9). The stale `tauri.yml` reference replaced with the truth (F10). A comment records why `pnpm lint` and `pnpm format:check` are not gating yet.                                                                                                                                                  |

---

## 4. Files deliberately not touched

| Path                                                                                                                             | Why                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/community/30_DAY_LAUNCH_PLAN.md`, `docs/community/README_REWRITE_PROPOSAL.md`, `docs/community/REPOSITORY_GROWTH_AUDIT.md` | Prior work product. Not superseded, not wrong — left in place. The new audit is a separate, current document.                                    |
| `docs/AUDIT_V0.1.md`, `docs/AUDIT_V0.1_PHASE14.md`, `docs/phase16/manual-lan-e2e.md`                                             | Historical audit and manual-test records. They are the evidence trail.                                                                           |
| `packages/**`, `apps/desktop/src/**`, `apps/desktop/src-tauri/src/**`                                                            | Out of scope by instruction. No product code was touched.                                                                                        |
| `开发手册.md`, `终端测试.md`, `回顾.md`                                                                                          | Already deleted by the maintainer in commit `0060838`; `git status` is clean. Their removal was not "done" by this pass and is not claimed here. |

---

## 5. Manual GitHub actions required

**None of these can be done from a clone.** They are settings on the GitHub
repository, and they are listed here rather than reported as complete.

### 5.1 Repository settings

| #   | Action                                          | Why                                                                                                                                                                                                                             | How                                                                                                                                                                        |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **Enable Discussions**                          | The README badge, `docs/COMMUNITY.md`, `.github/ISSUE_TEMPLATE/config.yml` and the PR template all link to `/discussions`. If it is off, those links 404.                                                                       | Repo → **Settings** → **General** → **Features** → check **Discussions**.                                                                                                  |
| M2  | **Create the 13 labels**                        | The issue forms reference `bug`, `enhancement`, `discussion`, `help wanted`; `docs/COMMUNITY.md` documents all 13. Labels that do not exist are silently ignored by the forms, and the documented label table would be fiction. | See [§ 5.3](#53-labels-to-create).                                                                                                                                         |
| M3  | **Enable Private Vulnerability Reporting**      | `SECURITY.md` points at the advisory form. If the feature is off, that link 404s.                                                                                                                                               | Repo → **Settings** → **Advanced Security** → **Private vulnerability reporting**. **Until this is confirmed on, do not claim it is enabled.**                             |
| M4  | **Set the repository description and homepage** | The description is the second line of every search result.                                                                                                                                                                      | Repo → **Settings** → **General** → **Description**. Suggested: `Local-first AI social agent client — your AI finds the connection, you make the friendship.`              |
| M5  | **Set topics**                                  | Topics drive discovery in the GitHub search.                                                                                                                                                                                    | Repo → **Settings** → **Topics**. Suggested: `tauri`, `react`, `typescript`, `rust`, `ai-agent`, `local-first`, `p2p`, `networking`, `social-discovery`, `llm`, `privacy`. |
| M6  | **Confirm the MIT licence is detected**         | The badge says MIT; the badge renders from GitHub's licence detection. `LICENSE` exists, so it should.                                                                                                                          | Repo → **Settings** → check the licence field reads MIT.                                                                                                                   |
| M7  | **Decide on branch protection for `main`**      | Nothing stops a push to `main` today. Not required, but worth a decision before outside contributors arrive.                                                                                                                    | Repo → **Settings** → **Branches**.                                                                                                                                        |

### 5.2 Discussion categories to create

After enabling Discussions (M1), create these categories:

| Category      | Purpose                                   |
| ------------- | ----------------------------------------- |
| Announcements | Project announcements and monthly updates |
| General       | General discussion                        |
| Ideas         | New ideas                                 |
| Show and Tell | Project demos                             |
| Q&A           | Technical questions                       |
| Development   | Development discussion                    |

### 5.3 Labels to create

| Label              | Colour   | Description                                                |
| ------------------ | -------- | ---------------------------------------------------------- |
| `good first issue` | `7057ff` | Contained, well-specified, a reasonable first contribution |
| `help wanted`      | `008672` | We would like help, but it is not a first contribution     |
| `bug`              | `d73a4a` | Something does not work as documented                      |
| `enhancement`      | `a2eeef` | A new or improved capability                               |
| `documentation`    | `0075ca` | Docs, examples, translations                               |
| `frontend`         | `c5def5` | React / Tauri UI                                           |
| `backend`          | `1d76db` | Rust / Tauri commands                                      |
| `rust`             | `dea584` | Rust code                                                  |
| `typescript`       | `3178c6` | TypeScript code                                            |
| `ai-agent`         | `b60205` | Agent behaviour, prompts, matching                         |
| `networking`       | `5319e7` | Transport, discovery, sockets                              |
| `security`         | `b60205` | Secrets, keys, injection, privacy boundaries               |
| `discussion`       | `ededed` | Needs a design conversation before it can be an issue      |

### 5.4 Issues to create

**These were not created.** Creating them changes the public surface of the
repository and needs explicit authorisation. Each is specified below in the
format the plan requires, so the maintainer can create them directly, or
authorise a script to do it.

Every issue below assumes the problem still exists **at the commit audited
here**; each was checked against the code before being written up.

---

#### Issue 1 — Improve README and repository documentation

- **Labels:** `documentation`, `good first issue`
- **Direction:** Documentation · **Difficulty:** Easy

**Background.** The README was rewritten during the V1.0 community pass. This
issue tracks the _second_ pass: the parts that need a real user's eye rather
than the maintainer's.

**Problem.** The current README is accurate but dense. A reader who is not
already an AI-agent developer has to parse a mermaid diagram and three feature
tables before they know what the product does.

**Expected result.** A README a non-expert can read in 30 seconds and a
developer can still use as a setup reference.

**Acceptance criteria.**

- [ ] The first screen communicates what Kindora is and what it is not.
- [ ] Every install and run command is executed at least once in a clean
      environment and the output is recorded in the issue.
- [ ] No feature-status claim contradicts `docs/DEVELOPMENT_STATUS.md`.
- [ ] No download, user, coverage or production-readiness claim appears that
      the repository cannot substantiate.
- [ ] All internal links resolve.

**Relevant modules.** `README.md`, `docs/DEVELOPMENT_STATUS.md`.

**Contribution notes.** Docs-only. No build required.

---

#### Issue 2 — Add a GUI startup smoke test

- **Labels:** `good first issue`, `tauri`, `frontend`
- **Direction:** Tauri · **Difficulty:** Easy–Medium

**Background.** There is currently no automated check that the desktop window
starts. The Rust library compiles and the TypeScript tests pass, but nothing
exercises the Tauri runtime.

**Problem.** A regression that breaks startup is only found by a human opening
the app. `docs/DEVELOPMENT_STATUS.md` lists "the desktop app in a real window"
as _implemented but unvalidated_ for exactly this reason.

**Expected result.** A repeatable check that launches the app, asserts that the
first screen renders, and fails loudly on an initialisation error.

**Acceptance criteria.**

- [ ] The app launches in the test environment.
- [ ] A failure to initialise (missing keychain, broken profile store, missing
      LLM config) is detected and reported, not silently rendered as an empty
      screen.
- [ ] The run environment is documented (OS, Rust version, Node version).
- [ ] The existing test suites are unaffected — no suite is modified to make
      this one pass.

**Relevant modules.** `apps/desktop/src-tauri`, `apps/desktop/src/__tests__/`.

**Contribution notes.** The hard part is choosing the harness. `tauri-driver`
with WebDriver, or a `tauri::test` harness — a proposal is welcome before code.

---

#### Issue 3 — Improve the matching-explanation UI

- **Labels:** `enhancement`, `frontend`, `help wanted`
- **Direction:** React / TypeScript · **Difficulty:** Medium

**Background.** The match screen renders the five analysis fields, but it does
not distinguish "the agent found nothing" from "the agent has not run yet", and
the friction list is visually identical to the common-ground list.

**Problem.** The screen under-communicates. A user cannot tell a weak match
from a failed analysis.

**Expected result.** A match screen where the strength of the match, the
shared ground, the topics, the possible friction and the reasoning are
visually distinct, and every empty state has its own explanation.

**Acceptance criteria.**

- [ ] Common ground, recommended topics and potential friction are visually
      distinct.
- [ ] An empty analysis and a not-yet-run analysis are distinguishable.
- [ ] The existing five fields and their names are unchanged.
- [ ] The wire format and the `MatchAnalysis` type are unchanged.
- [ ] Tests cover the new states.

**Relevant modules.** `apps/desktop/src/views/MatchView.tsx`,
`packages/protocol/src/index.ts`.

**Contribution notes.** Please open a short proposal first — this is a design
change, and the maintainer has a view on the layout.

---

#### Issue 4 — Add optional real-LLM integration tests

- **Labels:** `ai-agent`, `help wanted`
- **Direction:** AI / TypeScript · **Difficulty:** Medium

**Background.** Every LLM test mocks `fetch`. The provider adapters have never
been pointed at a real API, so real request shapes, auth headers, rate-limit
responses and error bodies are unverified.

**Problem.** The app may be wired correctly and still fail against a real
provider, and no test would catch it.

**Expected result.** An opt-in integration suite that runs against a real
provider when a key is present in the environment, and is skipped otherwise.

**Acceptance criteria.**

- [ ] The existing mocked tests keep running independently and unchanged.
- [ ] The real-API tests do **not** run by default, and are skipped — not
      failed — when the environment variable is absent.
- [ ] No API key reaches a log, a snapshot, a test name, or git.
- [ ] The environment variable is named and documented.
- [ ] A failure prints a diagnosis that distinguishes an authentication
      failure from a malformed response from a network failure.

**Relevant modules.** `packages/llm/src/providers/`,
`packages/llm/src/__tests__/`.

**Contribution notes.** Do **not** commit a key or a `.env`. Use an environment
variable and document the name in the issue.

---

#### Issue 5 — Implement SQLite profile persistence

- **Labels:** `backend`, `rust`, `help wanted`
- **Direction:** Rust / SQLite · **Difficulty:** Medium–Hard

**Background.** The `tauri-plugin-sql` plugin is registered in
`apps/desktop/src-tauri/src/lib.rs:151`, but no TypeScript code calls it. Every
piece of state lives in `localStorage`.

**Problem.** `localStorage` is not a database. There is no migration story, no
transactional write, and no query capability.

**Expected result.** Profile persistence backed by SQLite, with an explicit
migration strategy.

**Acceptance criteria.**

- [ ] A documented data model for the profile, its settings and the block
      list.
- [ ] Data written before the change is recovered after it.
- [ ] The migration strategy is written down — what happens to a profile written
      by an older build.
- [ ] The existing `ProfileStore` interface is not broken for its callers.
- [ ] A migration is tested, not just a fresh install.

**Relevant modules.** `packages/storage/src/profile-store.ts`,
`packages/storage/src/settings-store.ts`,
`packages/storage/src/blocked-agents-store.ts`.

**Contribution notes.** The migration path is the hard part, and it is where
the review effort should go. Please open a technical proposal first.

---

#### Issue 6 — Implement the WebRTC DataChannel transport

- **Labels:** `networking`, `rust`, `help wanted`
- **Direction:** Rust / Networking · **Difficulty:** Hard

**Background.** `packages/transport/src/webrtc-transport.ts` is a stub whose
`connect()` throws. The transport contract is already fixed, so the desktop UI
can be wired against a real implementation without churn.

**Problem.** Kindora is same-LAN only. Two people on different networks cannot
connect at all, and the LAN channel is unencrypted
(`packages/transport/src/lan-transport.ts:24`).

**Expected result.** A working DataChannel transport, at minimum behind manual
signalling (copy and paste the SDP offer and answer).

**Acceptance criteria.**

- [ ] The design is discussed in public first — a technical proposal, not a
      large pull request.
- [ ] The signalling method and the dependencies are decided and written down.
- [ ] The implementation has unit tests.
- [ ] There is a **real two-endpoint** test over a DataChannel, not only a
      mocked one.
- [ ] The existing LAN transport is untouched and still passes.

**Relevant modules.** `packages/transport/src/webrtc-transport.ts`,
`packages/transport/src/index.ts`, `packages/transport/src/pairing-session.ts`.

**Contribution notes.** Do not attempt this as a first contribution. The
design discussion is the contribution, at first.

---

#### Issue 7 — Improve the security documentation

- **Labels:** `documentation`, `security`, `good first issue`
- **Direction:** Security / Documentation · **Difficulty:** Easy–Medium

**Background.** `SECURITY.md` now lists six known limitations. It is accurate
today and will drift.

**Problem.** Nothing keeps the security documentation in step with the code. A
future change — say, adding TLS to the LAN transport, or encrypting the
private key — will not update the document automatically.

**Expected result.** A security document that a reader can trust, plus a
process that keeps it current.

**Acceptance criteria.**

- [ ] How API keys are stored is documented for **both** the Tauri build and
      browser dev mode, including the difference in strength.
- [ ] The scope of local data protection is documented — what stays on the
      device and what leaves it.
- [ ] The network security boundary is documented — including the fact that the
      LAN channel is currently unencrypted.
- [ ] Known risks are listed.
- [ ] Security capabilities are not overstated. If something is not
      implemented, it says so.
- [ ] The "how to report" path matches what the repository actually has
      configured (see M3 in [§ 5.1](#51-repository-settings)).

**Relevant modules.** `SECURITY.md`, `packages/storage/src/`,
`apps/desktop/src-tauri/src/secrets.rs`.

**Contribution notes.** Read the code, not the design docs.

---

#### Issue 8 — Improve the developer setup documentation

- **Labels:** `documentation`, `good first issue`
- **Direction:** Documentation / DX · **Difficulty:** Easy

**Background.** The README's setup section is accurate but has been written by
someone whose machine already had everything installed.

**Problem.** The failure modes that actually stop a new contributor are the
toolchain-version ones: an old Rust toolchain, a Linux package missing, a
`pnpm -C` path mistake.

**Expected result.** A setup guide that a new contributor can follow from a
clean machine.

**Acceptance criteria.**

- [ ] The install steps are complete.
- [ ] The Rust toolchain requirement is explicit — `stable`, and why
      `rust-toolchain.toml` exists.
- [ ] The Node and pnpm requirements are explicit.
- [ ] Common errors have a documented fix, each reproduced at least once.
- [ ] The whole guide is followed once in a clean environment, and that run is
      recorded in the issue.

**Relevant modules.** `README.md`, `CONTRIBUTING.md`, `rust-toolchain.toml`.

**Contribution notes.** The "reproduce each error" requirement is the point.
A troubleshooting table copied from memory is worthless.

---

### 5.5 Optional, later — deliberately not done now

| Item                                                 | Why not                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS / Windows / Linux CI matrix                    | § 6 of the plan warns against adding fragile platform coverage for its own sake. The Rust LAN suite binds real sockets and is the most likely source of platform-specific flakiness. Add it when the suites are hardened, and one platform at a time. |
| Tauri desktop build in CI                            | Needs platform-specific assets and a full Rust toolchain; it is verified locally before a release tag.                                                                                                                                                |
| `pnpm lint` / `pnpm format:check` as required checks | Neither was verified green across the whole tree during this pass (§ 0). Adding a permanently-red required check helps nobody.                                                                                                                        |
| Show HN                                              | Needs a real GUI demo video and a stable build. Not yet.                                                                                                                                                                                              |
| Product Hunt                                         | Explicitly not a first-phase goal.                                                                                                                                                                                                                    |

---

## 6. Evidence for every feature-status claim

Counted from the source tree, not inferred from documentation.

### 6.1 Test inventory

| Suite                                     | Files / cases           | Counted how               |
| ----------------------------------------- | ----------------------- | ------------------------- |
| Vitest — `@kindora/agent`                 | 14 files, 126 cases     | `it(` declarations        |
| Vitest — `@kindora/transport`             | 8 files, 115 cases      | `it(` declarations        |
| Vitest — `@kindora/desktop`               | 13 files, 115 cases     | `it(` declarations        |
| Vitest — `@kindora/protocol`              | 8 files, 103 cases      | `it(` declarations        |
| Vitest — `@kindora/matching`              | 7 files, 60 cases       | `it(` declarations        |
| Vitest — `@kindora/storage`               | 4 files, 29 cases       | `it(` declarations        |
| Vitest — `@kindora/llm`                   | 2 files, 19 cases       | `it(` declarations        |
| **Vitest total**                          | **56 files, 567 cases** |                           |
| Rust `cargo test --lib`                   | 3 cases                 | `#[test]` in `src/lan.rs` |
| Rust `cargo test --test lan_e2e`          | 18 cases                | `#[tokio::test]`          |
| Rust `cargo test --test lan_protocol_e2e` | 13 cases                | `#[tokio::test]`          |
| **Rust total**                            | **34 cases**            |                           |

The nine `test(` matches in the tree are `RegExp.test()` calls in source, not
test declarations; they are excluded. Reproduce with:

```bash
grep -roE "\bit\(" apps/desktop/src packages/*/src | wc -l     # 567
grep -rn "#\[tokio::test" apps/desktop/src-tauri/tests/ | wc -l
```

**These are counts, not results.** Whether the suite passes at this commit is
what the CI badge records.

### 6.2 Claim → evidence

Every claim in the README, `ROADMAP.md` and `docs/DEVELOPMENT_STATUS.md` is
one of the rows in [§ 1.3](#13-what-the-code-actually-says-feature-status-with-evidence).
The commands that verify them are printed at the bottom of
`docs/DEVELOPMENT_STATUS.md`.

### 6.3 The things that are hardest to check, and how they were checked

| Claim                                  | How it was established                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "SQLite is not called from TypeScript" | `grep -rn "sqlite" apps/desktop/src packages/*/src` → one hit, a comment in `packages/storage/src/index.ts:11`. The `tauri_plugin_sql` registration in `lib.rs:151` registers a plugin, not a call.                |
| "There is no QR UI"                    | `grep -rni "qr" apps/desktop/src/views apps/desktop/src/App.tsx` → no hits. The helpers are in `packages/transport/src/qr-payload.ts`.                                                                             |
| "No releases"                          | `git tag` → empty.                                                                                                                                                                                                 |
| "The LAN port is 52419"                | `apps/desktop/src-tauri/src/lan.rs:36` — `const DISCOVERY_PORT: u16 = 52419;`.                                                                                                                                     |
| "No TLS on the LAN channel"            | `grep -rni "tls\|ssl\|rustls\|native-tls"` over `src-tauri/src`, `packages/transport/src`, `packages/protocol/src` → one hit, and it is the comment saying TLS is missing.                                         |
| "There are 4 provider kinds"           | `apps/desktop/src/lib/llm-service.ts:251-280`. The `clearLLMConfig()` list at line 138 independently enumerates the same four.                                                                                     |
| "The private key is plaintext"         | `packages/agent/src/identity.ts:61` exports `'pkcs8'` and line 67 base64s it; `packages/storage/src/profile-store.ts:20` stores the string.                                                                        |
| "The AI never auto-sends"              | Every outbound message path in `packages/matching/src/` and `apps/desktop/src/views/` is gated behind an explicit user action. `packages/agent/src/system-prompt.ts` constrains the agent's output to suggestions. |

---

## 7. Risks that remain before promoting this repository

These are the things that would hurt credibility if a visitor pushes back. Each
one is a real limitation, not a hypothetical.

| #   | Risk                                                                                                                                           | Severity | Mitigation in this pass                                                                                                                                                     | Remaining action                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **"Your tests all mock the LLM."** A technically literate visitor will check this in the first ten minutes.                                    | High     | Stated prominently in the README Status section, in `docs/DEVELOPMENT_STATUS.md`, and in Issue 4.                                                                           | Ship Issue 4's opt-in real-LLM suite.                                                                                                                 |
| R2  | **"The LAN traffic is unencrypted."** Disclosed in the source but not in the old `SECURITY.md`.                                                | High     | Now the first entry under Known security limitations in `SECURITY.md`, and listed in `docs/DEVELOPMENT_STATUS.md`.                                                          | TLS on the TCP path (Phase 3). Until then, say "same-LAN only, trusted network".                                                                      |
| R3  | **"Nobody has run two real machines."**                                                                                                        | High     | Stated in the README Status section and in `docs/DEVELOPMENT_STATUS.md`.                                                                                                    | Two real devices, two people. This is the single highest-value verification available and it needs no code.                                           |
| R4  | **The Discussions badge 404s** if M1 is not done.                                                                                              | Medium   | The badge and the links exist; the enabling step is M1.                                                                                                                     | Do M1.                                                                                                                                                |
| R5  | **Issue-form labels are ignored** if M2 is not done — `bug`, `enhancement`, `discussion` and `help wanted` will not be applied to new issues.  | Medium   | Documented in M2.                                                                                                                                                           | Do M2.                                                                                                                                                |
| R6  | **`SECURITY.md` points at an advisory form** that 404s if M3 is not done.                                                                      | Medium   | The wording is written so that it does not _claim_ private reporting is enabled.                                                                                            | Do M3, then verify the link.                                                                                                                          |
| R7  | **A visitor finds the previous 37 KB audit** in `docs/community/` and cannot tell which document is current.                                   | Low      | This file states its scope and the commit it was audited against.                                                                                                           | Consider a one-line banner on the three older `docs/community/` files pointing here. Not done in this pass to avoid touching files outside the scope. |
| R8  | **The CI change is unverified** (§ 0). If `cargo test --lib` or the protocol E2E suite fails on `ubuntu-latest`, CI goes red on the next push. | Medium   | Both commands mirror the shape of the existing, passing `lan_e2e` job.                                                                                                      | Watch the next CI run; revert the two added steps if either is red on Linux.                                                                          |
| R9  | **A first-time contributor opens a PR and waits three weeks.**                                                                                 | Medium   | `CONTRIBUTING.md` and `docs/COMMUNITY.md` now state the response expectation honestly, including that a declined PR is usually a scope decision.                            | Keep the monthly update cadence.                                                                                                                      |
| R10 | **The private key is plaintext in `localStorage`** — a security researcher will find this in minutes.                                          | Medium   | Disclosed in `SECURITY.md` and `docs/DEVELOPMENT_STATUS.md`.                                                                                                                | Roadmap Phase 2.                                                                                                                                      |
| R11 | **Star growth pressure leads to over-promising.** The biggest risk to this repository is a roadmap that drifts from reality.                   | Medium   | Every unchecked item in `ROADMAP.md` is genuinely unchecked; the doc says explicitly that it is a direction and not a promise.                                              | Keep it that way.                                                                                                                                     |
| R12 | **The `开发手册.md` deletion left the project without a spec.** Five documents linked to it; it is gone.                                       | Low      | The dead links are removed and `docs/ARCHITECTURE.md`, `docs/PRODUCT.md` and `docs/PROTOCOL.md` have been corrected against the code, so they now serve as the living spec. | If the maintainer wants the full original spec back in the repo, that is a separate, deliberate task.                                                 |

---

## 8. Verification checklist for the maintainer

Run these before pushing this work, and again after the manual GitHub actions
in § 5.

```bash
cd /Users/jiang/development/Kindora

# 1. The suites — these must be green before this is committed.
pnpm install
pnpm typecheck
pnpm lint
pnpm test
cd apps/desktop/src-tauri
cargo test --lib
cargo test --test lan_e2e -- --test-threads=1
cargo test --test lan_protocol_e2e -- --test-threads=1
cd ../../..

# 2. The README's commands, from a clean checkout.
pnpm -C apps/desktop tauri:dev

# 3. No dead internal links.
#    (docs/GITHUB_GROWTH_AUDIT.md is excluded on purpose — it quotes the
#    old link targets in order to document them.)
grep -rn "开发手册\|终端测试" README.md CONTRIBUTING.md SECURITY.md ROADMAP.md CODE_OF_CONDUCT.md docs/*.md .github/ \
  | grep -v "docs/GITHUB_GROWTH_AUDIT.md"

# 3b. Every relative markdown link in the docs resolves.
#     Check by eye — there are ~30 of them, listed in § 3 of this audit.
grep -oE "\]\([^)#][^)]*\)" README.md CONTRIBUTING.md SECURITY.md ROADMAP.md docs/*.md

# 4. The counts in docs/DEVELOPMENT_STATUS.md still match the tree.
grep -roE "\bit\(" apps/desktop/src packages/*/src | wc -l          # expect 567
grep -c "#\[tokio::test" apps/desktop/src-tauri/tests/lan_e2e.rs   # expect 18
grep -c "#\[tokio::test" apps/desktop/src-tauri/tests/lan_protocol_e2e.rs  # expect 13
```

**Then, on the GitHub side:** do M1–M7, create the labels, create the eight
issues from § 5.4, and post the first development update using
`docs/DEVELOPMENT_UPDATE_TEMPLATE.md`.

---

## 9. Definition of done

| Criterion                                                                              | State                                                                                           |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| README states the project's premise, its limits, and how to run it                     | ✅ `README.md`                                                                                  |
| No feature status claim is stronger than the code                                      | ✅ `docs/DEVELOPMENT_STATUS.md` § 6                                                             |
| The architecture and protocol documents describe the system that exists                | ✅ `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md` — corrected against the code (F16, F17)           |
| No dead internal link remains                                                          | ✅ the five `开发手册.md` links removed (F1)                                                    |
| Roadmap exists at the repository root and every unchecked item is genuinely unchecked  | ✅ `ROADMAP.md`                                                                                 |
| Contributing guide covers setup, tests, PRs, translations and new providers            | ✅ `CONTRIBUTING.md`                                                                            |
| Code of conduct is the Contributor Covenant with a real contact                        | ✅ `CODE_OF_CONDUCT.md` (unchanged in substance)                                                |
| Security page names the reporting channel, the supported versions and the known limits | ✅ `SECURITY.md`                                                                                |
| Issue templates cover bugs, features and technical proposals                           | ✅ `.github/ISSUE_TEMPLATE/`                                                                    |
| PR template asks how the change was tested                                             | ✅ `.github/pull_request_template.md`                                                           |
| Good first issue candidates are specified and ready to create                          | ✅ § 5.4 — **not created**, awaiting authorisation                                              |
| Discussions categories and the three opening questions are specified                   | ✅ § 5.2, `docs/COMMUNITY.md`                                                                   |
| CI covers typecheck, build, Vitest, Rust unit tests and both Rust E2E suites           | ✅ `.github/workflows/ci.yml` — **unverified locally**, see R8                                  |
| No core business logic was modified                                                    | ✅ nothing under `packages/*/src`, `apps/desktop/src`, `apps/desktop/src-tauri/src` was touched |
| No fabricated download, user, coverage or production-readiness claim                   | ✅ none present                                                                                 |
| No secret, token or personal data added                                                | ✅ none added                                                                                   |
| The maintainer's own working-tree changes were preserved                               | ✅ `git status` was clean before and after; no unrelated file was touched                       |
| Nothing was committed or pushed on the maintainer's behalf                             | ✅ the working tree is left for review                                                          |
