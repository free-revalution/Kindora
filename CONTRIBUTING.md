# Contributing to Kindora

Thanks for your interest. Kindora is an experiment, and you are welcome to help
run it.

**You do not need to be a Rust expert.** Documentation fixes, translations,
reproduction steps, and UI polish are genuinely valuable contributions to a
project like this.

---

## Principles

These four rules shape every design decision. A pull request that contradicts
them will be discussed rather than merged.

- **Human First.** AI assists human connection; it does not replace it. The
  agent drafts, the human sends.
- **Local First.** User data stays on the user's device. There is no server to
  send it to.
- **Privacy First.** Exchange only the minimum needed for matching, and only
  what the user's boundaries allow.
- **MVP First.** Do not add features that do not help validate the core
  hypothesis: *can personal AI agents help people discover meaningful human
  connections?*

---

## Ways to contribute

| If you want to… | Start here |
| --- | --- |
| Report a bug | [Bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) |
| Propose a feature | [Feature request template](.github/ISSUE_TEMPLATE/feature_request.yml) |
| Propose an architecture change | [Technical proposal template](.github/ISSUE_TEMPLATE/technical_proposal.yml) |
| Discuss direction | [GitHub Discussions](https://github.com/free-revalution/Kindora/discussions) |
| Fix a typo or clarify the docs | Edit the file and open a PR |
| Add a language | See [Adding a language](#adding-a-language) below |
| Write code | Claim a [`good first issue`](https://github.com/free-revalution/Kindora/labels/good%20first%20issue) |

A well-explained bug report is as valuable as a patch. If you can describe the
expected result, the actual result, and the exact steps to reproduce, you have
already done most of the work.

---

## Development setup

### Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 20 | from the root `package.json` `engines` |
| pnpm | 10 | `packageManager: pnpm@10.32.1` |
| Rust | **stable** | pinned by `rust-toolchain.toml` in the repo root |

Linux additionally needs `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`librsvg2-dev`, `patchelf`, `build-essential`, `libssl-dev`. On macOS install
the Xcode Command Line Tools; on Windows you need WebView2 and MSVC.

### Install

```bash
git clone https://github.com/free-revalution/Kindora.git
cd Kindora
pnpm install
```

### Run the desktop app

```bash
pnpm -C apps/desktop tauri:dev
```

> Run this **from the repository root**. `pnpm dev` at the root only starts a
> Vite dev server (`127.0.0.1:1420`) and does *not* open a desktop window.
> Running `pnpm -C apps/desktop tauri:dev` from inside `apps/desktop` fails
> with `ENOENT ... /apps/desktop/apps/desktop`.

### Run the tests

```bash
# TypeScript — the whole workspace
pnpm test
pnpm typecheck
pnpm lint

# Rust — from the Tauri crate
cd apps/desktop/src-tauri
cargo test --lib                                          # unit tests
cargo test --test lan_e2e -- --test-threads=1             # LAN over real sockets
cargo test --test lan_protocol_e2e -- --test-threads=1   # KSA protocol E2E
```

`--test-threads=1` is required for the two Rust integration suites: parallel
execution is unreliable against the macOS and Linux kernel UDP buffer pools.

The Rust integration tests bind **real UDP and TCP sockets**. They do not need
a Tauri window, and they are the only place where the LAN transport is
exercised against actual sockets.

---

## Repository layout

```text
apps/desktop/          React UI + Tauri (Rust) backend
packages/protocol/     KSA 0.1 envelope, validation, replay guard, rate limiter
packages/agent/        Ed25519 identity, match analysis, icebreaker generation
packages/llm/          Provider adapters
packages/matching/     Match / consent / icebreaker / chat orchestrators
packages/storage/      Profile, settings, secrets, block list
packages/transport/    LAN (real) · Loopback · WebRTC (stub) · PairingSession
```

Packages resolve to **source**, not to a built `dist`. If you add a package,
export it from `src/index.ts` — a consumer imports the TypeScript directly.

---

## Pull requests

1. **One concern per PR.** A drive-by refactor bundled into a feature patch
   makes the diff impossible to review, and review is what keeps this project
   trustworthy.
2. **Add or update tests** for anything you change. The Rust LAN suites and the
   Vitest suites are the safety net; a change that cannot be tested should come
   with a note saying why.
3. **Run `pnpm test`, `pnpm typecheck` and `pnpm lint` before opening the PR.**
   CI runs the same commands on every push and will fail on the same things
   you can.
4. **Stay inside the current scope.** See [ROADMAP.md](ROADMAP.md) for what is
   planned and, at the bottom of that file, what is deliberately excluded.
   Out-of-scope ideas are welcome as a
   [technical proposal](.github/ISSUE_TEMPLATE/technical_proposal.yml) — they
   are just not welcome as a patch.
6. **Follow the existing style.** Prettier and ESLint own formatting:
   `pnpm format` rewrites, `pnpm format:check` verifies.
7. **Never commit an API key, a `.env` file, a real profile, or a log that
   contains one.** The CI will not catch this for you.

### Commit messages

```
<type>: <short summary in the imperative mood>

<why the change is needed>

<what changed, if it is not obvious from the diff>
```

Types used in this repository: `feat`, `fix`, `docs`, `test`, `refactor`,
`chore`, `perf`, `build`, `ci`.

### What to write in the PR body

The [PR template](.github/pull_request_template.md) asks for a short summary,
a linked issue, and — most importantly — **how you tested it**, including the
commands you ran and their results. "It works on my machine" is useful; the
exact command and its output is reviewable.

---

## Adding a language

Kindora ships English and 简体中文 today. The system is deliberately small so
that adding a language is a translation job, not a code change:

1. Copy `apps/desktop/src/i18n/dictionaries/en.ts` to
   `apps/desktop/src/i18n/dictionaries/<code>.ts`.
2. Translate the **values**. Keep the **keys** byte-identical — `en.ts` is the
   source of truth for the key set, and TypeScript will fail the build if a key
   is missing or misspelled.
3. Register it in `apps/desktop/src/i18n/locale.ts`: add the code to the
   `Locale` union, add an entry to `LOCALES` (with `englishName`, an
   `endonym` written in the language itself, and the `htmlLang` BCP-47 tag),
   and add it to `SUPPORTED_LOCALES`.
4. Run `pnpm test` — `apps/desktop/src/__tests__/i18n.test.tsx` checks key-set
   parity between every dictionary and flags strings that were left untranslated
   by accident.

Placeholders like `{max}`, `{peer}` and `{models}` are filled in at render time
— translate the sentence around them, never the placeholder itself.

A handful of strings are intentionally left in English: product and provider
names (`Kindora`, `OpenAI`, `Anthropic`, `Ollama`, `MiniMax`), model ids, and
the transport names `LAN` / `Loopback`. They are proper nouns or protocol
identifiers. The test file lists them explicitly.

---

## Adding an LLM provider

Provider adapters live in `packages/llm/src/providers/`. A new provider needs:

- an adapter that implements the provider interface in `packages/llm/src`;
- an entry in `PROVIDER_PRESETS` in `apps/desktop/src/lib/llm-service.ts`
  (including `requiresApiKey`, which decides whether the Settings screen asks
  for a key at all);
- tests in `packages/llm/src/__tests__/`.

Note that `clearLLMConfig()` in `llm-service.ts` enumerates provider kinds
explicitly — add yours there too, or its key will survive a "clear everything".

---

## Code of conduct

This project follows the
[Contributor Covenant 2.1](CODE_OF_CONDUCT.md). By participating you are
expected to uphold it. Reports go to **jiang-revolution@outlook.com**.

---

## Security issues

**Do not open a public issue for a vulnerability.** Follow
[SECURITY.md](SECURITY.md) instead — it has the private reporting channel.

---

## Licence

By contributing you agree that your contribution is licensed under the
[MIT Licence](LICENSE), the same as the rest of the project.
