# 30-Day Launch Plan — Kindora

**Date:** 2026-10-23
**Companion to:** [REPOSITORY_GROWTH_AUDIT.md](REPOSITORY_GROWTH_AUDIT.md) · [README_REWRITE_PROPOSAL.md](README_REWRITE_PROPOSAL.md)
**Status:** PROPOSAL ONLY — nothing here has been executed. No Release was
published, no GitHub setting was changed, and nothing was posted anywhere.

---

## 0. The sequencing problem

Every item in § 4–§ 7 below is blocked on the same three P0 fixes from the
audit. Posting to Hacker News a repository whose Quick Start fails is a
one-way door: the front page arrives once, and it will not come back.

```
Days  1–4   P0 fixes        → app starts, clean clone works
Days  5–9   manual verify   → § 4.7 flow run by a human, recorded
Days 10–14  first Release   → v0.1.0-alpha.1
Days 15–20  docs + assets   → screenshots, video, community files
Days 21–30  launch          → one announcement, then listen
```

**Day 1 is not "write a tweet." Day 1 is "make `pnpm install && cargo check`
work on a machine that has never seen the repo."**

---

## 1. GitHub Discussions — category design

**Prerequisite:** Discussions is currently unknown to be enabled `[NOT VERIFIED
— `gh`is not authenticated; check with`gh api repos/free-revalution/Kindora`
or the repository Settings page]`.

If it is disabled, enabling it is reasonable — but **only after** at least the
`Question or idea` category has real content, or it becomes a ghost tab. For a
project this small, a 3-category setup beats a 6-category one.

### Proposed categories

| Category        | Emoji | Purpose                                                   | Suggested pinned post                                         |
| --------------- | ----- | --------------------------------------------------------- | ------------------------------------------------------------- |
| **Q&A**         | ❓    | Setup help, "how do I…", Rust/LAN/tooling problems        | README Quick Start + troubleshooting table                    |
| **Ideas**       | 💡    | Feature proposals, architecture discussion                | `docs/ROADMAP.md` — ask which V0.2 item matters most to you   |
| **Show & tell** | 🛠️    | "I got two agents talking" write-ups, forks, integrations | Post-run checklist for `docs/phase16/manual-lan-e2e.md` § 4.7 |

**Deliberately not created:** `Announcements`, `General`, `Q&A` duplicates.
For a repo with one contributor and a handful of users, `General` becomes a
dumping ground and `Announcements` goes stale.

### Suggested pinned discussions

1. **"Read this first: Kindora is V0.1 and the app does not build on a stock
   toolchain."** Lead with the honest status. Include the three P0 fixes and the
   troubleshooting table. Pin for 30 days, unpin once the fixes are merged.
2. **"What's the highest-value thing I could work on?"** Link the ten tasks in
   the README rewrite proposal § 6.
3. **"V0.1 scope: what we are deliberately not building."** Lift the non-goals
   from `docs/PRODUCT.md`. This pre-empts the most common bad-faith critique of
   an early-stage project — that it is pretending to be something it is not.

---

## 2. First Release — entry criteria

**Recommendation: do not cut `v0.1.0` yet. Cut `v0.1.0-alpha.1`.**

A `v0.1.0` label invites people to expect a working product. `alpha.1` invites
people to expect what actually exists.

### 2.1 Hard gates — all must pass

| #   | Gate                                                                                       | How to verify                                                   |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 1   | `pnpm -C apps/desktop tauri:dev` launches a window on a **clean clone**                    | A person who has never seen the repo does it                    |
| 2   | `pnpm install && pnpm -r build && pnpm -r typecheck` pass on a clean clone                 | CI green                                                        |
| 3   | `cargo check --lib` passes with **no** `PATH` override                                     | `rust-toolchain.toml` present                                   |
| 4   | `Cargo.lock` committed; two clean clones build identical versions                          | `git ls-files … \| grep Cargo.lock`                             |
| 5   | Full suite green: 541 Vitest, 3 + 15 + 13 Rust, lint, typecheck, build                     | CI + local                                                      |
| 6   | **The § 4.7 no-LLM manual flow is run end-to-end by a human and recorded**                 | `docs/phase16/results-YYYY-MM-DD.md` exists with real PASS/FAIL |
| 7   | **At least one live LLM provider call succeeds** and the match screen renders all 5 fields | Screenshot + the API response                                   |
| 8   | `pnpm tauri:build` produces an installable artifact on the maintainer's OS                 | The `.app`/`.dmg` opens and reaches Home                        |
| 9   | SECURITY.md has a real contact (not `kindora.local`)                                       | `[VERIFIED]`                                                    |
| 10  | CODE_OF_CONDUCT.md merged                                                                  | `[VERIFIED]`                                                    |

**Gate 6 and gate 7 are the honest ones.** They are the difference between
"the tests pass" and "the product works." A release cut without them will
produce issue reports that are really bug reports against a claim you never made
— which is worse than no launch.

### 2.2 Optional gates — unblock only if satisfied

- Two **machines** have completed a LAN pairing (single-machine loopback is not
  sufficient for a "LAN" claim)
- Cross-platform build verified on at least one non-macOS OS

If 6/7 are met but the two-machine test is not, ship `alpha.1` with the README
status section saying "single-machine LAN verified; two-machine pending." That
is defensible. Shipping with "LAN works" unqualified is not.

### 2.3 Release mechanics

```bash
# Verify preconditions first
gh auth status
gh release list                       # expect: empty
git tag -l                            # expect: empty
pnpm -C apps/desktop tauri:build      # produce the artifact
```

Then, on the maintainer's decision:

```bash
gh release create v0.1.0-alpha.1 \
  --title "v0.1.0-alpha.1 — first runnable build" \
  --notes-file docs/community/release-notes-alpha1.md \
  <path-to-artifact>
```

**Do not run any of these until the maintainer explicitly approves.** Per the
task constraints, no Release is published automatically.

**Release notes must contain, in this order:**

1. What this build is — one paragraph.
2. **What is verified** — with the exact test counts and the date they were run.
3. **What is not verified** — the README's Experimental and Not-implemented
   tables, copied verbatim.
4. Known issues — the `default-run` issue if unfixed, the plaintext private key,
   the unencrypted transport.
5. How to run from source.

---

## 3. Demo video script

**Constraint:** this cannot be scripted until gates 1–8 pass. It must be a real
screen recording. Fabricating or mocking one is not acceptable.

**Format:** 90 seconds, 1080p, silent with burned-in captions. No voiceover —
it must be understandable muted, since most viewers watch muted.

### Shot list

| #   | Time      | Screen                                                                                         | Caption                                               | What it proves      |
| --- | --------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------- |
| 1   | 0:00–0:08 | Launch, Welcome                                                                                | "Kindora — your AI finds the connection."             | It starts           |
| 2   | 0:08–0:18 | Create Agent form, filling fields                                                              | "Create your agent."                                  | Not a toy           |
| 3   | 0:18–0:28 | Home → Settings → paste key → Save                                                             | "Bring your own LLM key. Stored in your OS keychain." | BYO key, privacy    |
| 4   | 0:28–0:38 | **Split screen**: A → Connect → LAN → Host (6-char code); B → Connect → LAN → Join, types code | "Same LAN. Type the code. No server, no account."     | The real feature    |
| 5   | 0:38–0:52 | Both → MatchView                                                                               | "Both agents analysed compatibility."                 | The 5 fields render |
| 6   | 0:52–1:02 | Consent on both sides                                                                          | "Humans decide."                                      | The core principle  |
| 7   | 1:02–1:12 | Icebreaker: 3 suggestions, click **Use**                                                       | "AI proposes. You send."                              | The rule            |
| 8   | 1:12–1:25 | Chat, type, send, receive                                                                      | "Then you talk."                                      | The payoff          |
| 9   | 1:25–1:30 | Terminal: `pnpm -C apps/desktop tauri:dev`                                                     | "V0.1 · experimental · MIT · source only"             | Honesty + CTA       |

**Hard rule:** the closing card must carry the status line. A 90-second video
that omits "experimental" will produce a comment thread about the omission.

**Storage:** GitHub does not host video. Use a `docs/assets/demo.mp4` committed
to the repo **only if under ~5 MB**, otherwise link to a screencast host and say
in the README that the asset is external.

---

## 4. Announcement drafts

All three are **drafts**. None has been posted. Each is calibrated to the same
honest status: the app starts, LAN is well-tested, the LLM path is unverified,
WebRTC is not built.

### 4.1 Hacker News — Show HN

> **Title:** Show HN: Kindora – open-source personal AI social agents (Tauri + Rust, LAN pairing)
>
> **Body:**
>
> I built Kindora, an open-source desktop client where your personal AI agent
> meets someone else's agent, and you both decide whether to become friends.
> It's a Tauri + Rust + React app, MIT licensed, 39 commits, one developer.
>
> **What it does.** You create an agent once — nickname, interests, social
> intent, conversation style, explicit boundaries. Two people exchange a
> 6-character pairing code on the same LAN. UDP broadcast discovery on port
> 52419, then a TCP channel. The two agents exchange bounded, schema-validated
> envelopes and each runs its own analysis producing compatibility signal,
> common ground, recommended topics, potential friction, and an explanation.
> Both humans see it. Both consent. The agent proposes icebreakers; you pick or
> skip. Then you chat. The AI never auto-sends — it only ever fills your draft.
>
> **Why.** Most AI social products run the model at people — scoring them,
> ranking them, generating a profile from their data. I wanted the model running
> between two people who each control their own agent, with no score at all.
>
> **Status — please read before trying it.** This is V0.1 and it is early:
>
> - The Rust LAN layer is genuinely tested: 15 + 13 integration tests against
>   real UDP and TCP sockets, plus 541 TypeScript tests.
> - The desktop app builds and runs, but **no one has yet completed a full
>   two-machine session by hand.** That step is in progress.
> - Every LLM test mocks `fetch`. No test has called a live provider yet.
> - **WebRTC is a stub.** Same-LAN only. Cross-network pairing does not exist.
> - State lives in `localStorage`. SQLite is registered in the Rust side but
>   nothing calls it.
> - The agent's private key is currently plaintext in the webview. That's a
>   known weakness, not a design decision.
>
> I'd rather say all that up front than have you discover it.
>
> **Feedback I'd most like:** is agent-to-agent matching with a human consent
> gate actually interesting, or is that gate where the product dies? I've built
> the mechanics; I haven't found out if people want it.
>
> Repo: https://github.com/free-revalution/Kindora
> Roadmap: https://github.com/free-revalution/Kindora/blob/main/docs/ROADMAP.md

### 4.2 Reddit

**Subreddit recommendation: `r/selfhosted` or `r/opensource`, not `r/dating`.**
`PRODUCT.md` states Kindora is not a dating app; posting there would attract the
wrong audience and misframe the project.

**Title (r/selfhosted):**

> Kindora — self-hosted personal AI social agents. Your agent meets another person's agent; you both decide. (Tauri + Rust, MIT)
>
> **Body:**
>
> Posting a project I've been building. Fully local except the LLM call you
> choose to make. No account, no server, no telemetry, no score.
>
> How it works: you author a personal agent once. Two people on the same LAN
> exchange a 6-character code. UDP broadcast discovery, then TCP. The agents
> exchange bounded schema-validated messages and each analyses compatibility.
> Both humans see the report and both consent. Then it's just chat.
>
> Stack: Tauri 2, Rust, React, TypeScript, SQLite-ready (not wired yet),
> OS keychain for API keys.
>
> **Honest status:** V0.1. The LAN socket layer has 28 integration tests against
> real sockets. The GUI has not yet been driven through a complete two-machine
> session by hand — that's the next milestone. WebRTC is a stub, so it's
> same-LAN only. Chat history isn't persisted yet, and the private key is
> plaintext in localStorage.
>
> If you try it: `rustup default stable` is required, and `cargo check` needs
> the Linux webkit2gtk packages. Both are in the README.
>
> Repo: https://github.com/free-revalution/Kindora
> Happy to answer questions about the protocol design (KSA 0.1) — the envelope
> schema and validation rules are documented.

### 4.3 X / Bluesky

**Single post:**

> Kindora is open source: personal AI social agents. Your agent meets someone
> else's agent, finds the common ground, and gets out of the way. Both humans
> decide. No score, no feed, no server.
>
> V0.1 — same-LAN pairing only, WebRTC not built yet, and the two-machine GUI
> run isn't finished. Being upfront rather than implying it works.
>
> github.com/free-revalution/Kindora

**Thread (follow-ups), only if engaged:**

1. `> The interesting constraint: the AI never auto-sends. It fills your draft. You press Send.`
2. `> The LAN layer is 28 Rust integration tests over real UDP + TCP. Port 52419.`
3. `> Open question I'd like answered: does the human consent gate kill the product, or is it the product?`

### 4.4 Posting discipline

- **One primary venue per week.** HN, then Reddit, then X. Not all three on day 1.
- **Answer every comment for the first 72 hours.** A launch post with unanswered
  questions is worse than no post.
- **Log criticism honestly.** Especially "it doesn't work" — that is the most
  useful signal available and it should not be argued away.
- **Do not repost after a quiet HN submission.** HN punishes resubmission.

---

## 5. The 30-day plan

### Days 1–4 — Make it installable _(nothing is public yet)_

| Day | Task                                                                         | Gate                            |
| --- | ---------------------------------------------------------------------------- | ------------------------------- |
| 1   | Add `default-run = "kindora-desktop"` to `Cargo.toml`                        | —                               |
| 1   | Add `rust-toolchain.toml` (`channel = "stable"`)                             | —                               |
| 1   | Un-ignore `Cargo.lock`; commit it                                            | —                               |
| 2   | `CODE_OF_CONDUCT.md`; real `SECURITY.md` contact                             | —                               |
| 2   | README rewrite merged **with** a working Quick Start                         | —                               |
| 3   | **Fresh-clone test:** someone who has never seen the repo follows the README | ← **the actual goal of week 1** |
| 3   | Fix CI: add `lan_protocol_e2e`, pnpm 9 → 10, add a macOS runner              | —                               |
| 4   | `ARCHITECTURE.md` rewritten; `PROTOCOL.md` gets `block` + wire framing       | —                               |

### Days 5–9 — Prove it works _(the highest-value week)_

| Day | Task                                                                                          |
| --- | --------------------------------------------------------------------------------------------- |
| 5   | Run `docs/phase16/manual-lan-e2e.md` § 4.7 on one machine. Record real PASS/FAIL              |
| 6   | Fix whatever fails. **Do not proceed until it passes**                                        |
| 7   | Second machine, or two VMs. Full two-machine § 4.7 + § 1 happy path                           |
| 8   | One live LLM call (MiniMax or Ollama). Screenshot the 5-field MatchView                       |
| 9   | Write `docs/phase16/results-YYYY-MM-DD.md`; fill README's status tables with **real** results |

**Day 9 is the gate for everything below.** If it is not done, the launch is
postponed — not weakened.

### Days 10–14 — Package

| Day | Task                                                            |
| --- | --------------------------------------------------------------- |
| 10  | `pnpm tauri:build`. Confirm the artifact opens and reaches Home |
| 11  | Record the demo video (§ 3)                                     |
| 12  | Issue templates, PR template, `dependabot.yml`, `SUPPORT.md`    |
| 13  | Open Discussions; write and pin the three posts (§ 1)           |
| 14  | Draft release notes; **hold** the cut until reviewed            |

### Days 15–16 — First Release

`gh release create v0.1.0-alpha.1` with the artifact, only after the maintainer
approves and all ten gates in § 2.1 are green.

### Days 17–20 — Assets and posts queued

| Day | Task                                                                |
| --- | ------------------------------------------------------------------- |
| 17  | README gets the video, the screenshots, the corrected status tables |
| 18  | Publish the "how it works" explainer                                |
| 19  | **Hold.** Let the Release circulate. Respond to issues              |
| 20  | First triage pass                                                   |

### Days 21–24 — Show HN

Post § 4.1. Stay available 72 hours. Expect and welcome "does it actually work?"
— answer with the status section, not with defensiveness.

### Days 25–28 — Reddit, then X

| Day | Task                |
| --- | ------------------- |
| 26  | r/selfhosted, § 4.2 |
| 28  | X / Bluesky, § 4.3  |

### Days 29–30 — Retrospective

| Task                                                                        |
| --------------------------------------------------------------------------- |
| Count real first-time clone successes vs failures — the metric that matters |
| Close or label every open issue                                             |
| Publish a short "what we learned in month one" post                         |
| Update `docs/community/ROADMAP.md` with dates                               |

---

## 6. Measurement

### 6.1 What is currently measurable

**Nothing.** `gh` is not authenticated on this machine `[VERIFIED]`, so no
GitHub-side number has been read. Establish the Day 0 baseline before any
change, or growth will be unprovable.

```bash
gh auth login
gh api repos/free-revalution/Kindora            # description, topics, visibility
gh api repos/free-revalution/Kindora/releases   # expect: []
gh api repos/free-revalution/Kindora/discussions --jq '.categories'
gh api repos/free-revalution/Kindora/traffic/clones   # needs push access, 14-day window
```

### 6.2 The metrics — and which ones actually matter

| Metric                       | How                                                              | Target (30d)    | Weight    |
| ---------------------------- | ---------------------------------------------------------------- | --------------- | --------- |
| **Fresh-clone success rate** | Ask every new issue reporter "did the Quick Start work?"         | ≥ 80%           | **★★★★★** |
| **Issues from non-authors**  | `gh issue list --author "@me" --exclude-author` inverted         | ≥ 5             | **★★★★★** |
| **External PRs merged**      | GitHub Insights → Contributors                                   | ≥ 1             | **★★★★**  |
| **First-time-star → clone**  | Cannot measure directly; proxy = clone traffic ÷ unique visitors | rising          | **★★★★**  |
| Stars                        | Repo Insights                                                    | organic only    | ★★★       |
| Unique visitors (14d)        | `gh api .../traffic/views`                                       | baseline + 100% | ★★        |
| Discussion posts             | `gh api .../discussions`                                         | ≥ 3 substantive | ★★★       |
| Forks                        | Repo Insights                                                    | ≥ 2             | ★★        |
| Releases downloaded          | `gh release view --json assets`                                  | ≥ 10            | ★★★       |

### 6.3 The honest framing

**Stars are a vanity metric for this project.** A repository with 200 stars and
a broken Quick Start has failed. A repository with 30 stars, a working
one-command install, and 5 substantive issues from strangers has validated
something.

Rank the metrics accordingly. The first two rows are the ones worth optimising;
everything else is context.

### 6.4 Baseline snapshot — to be filled at Day 0

```
stars:            ___
forks:            ___
watchers:         ___
open issues:      ___
open PRs:         ___
releases:         ___
discussions:      ___ (enabled? ___)
unique visitors:  ___ (14d, once API access exists)
clones:           ___ (14d, once API access exists)
```

---

## 7. Actions NOT taken

Per the task constraints and general practice:

- **No Release was created.** No tags exist and none were added.
- **No GitHub setting was changed** — not Description, not Topics, not
  Discussions, not visibility, not branch protection.
- **Nothing was posted** to X, Reddit, Hacker News, or anywhere else.
- **No application code, configuration, or documentation was modified.** Only
  the three new files under `docs/community/` were created.
- **The maintainer's uncommitted changes** to `开发手册.md` and `回复.md` were
  left untouched.

Every command in this document is written to be **read first and run
deliberately**. Nothing here should be pasted and executed without reading.

---

## 8. One-paragraph summary for the maintainer

The project has unusually good tests and unusually bad onboarding. The highest
-leverage work in the next 30 days is not marketing — it is making a stranger's
clean clone succeed, then completing one honest two-machine session by hand and
writing down what happened. Only then does a public launch make sense. The plan
above sequences it that way on purpose: the announcement is worth nothing if the
first person who tries it cannot get the app to start.
