# Contributing to Kindora

Thanks for your interest in improving Kindora.

## Principles

- **Human First.** AI assists human connection; it does not replace it.
- **Local First.** User data stays on the user's device.
- **Privacy First.** Exchange only the minimum needed for matching.
- **MVP First.** Do not add features that don't help validate the core hypothesis.

## Areas that welcome contributions

- **LLM Providers** — add adapters for new providers in `packages/llm`
- **UI / UX** — improvements to the desktop app under `apps/desktop`
- **Protocol** — KSA message schema, validation, replay protection
- **Transport** — WebRTC, LAN, manual signaling
- **Security** — prompt-injection hardening, key storage, validation
- **Localization** — Kindora targets Chinese + English first
- **Testing** — unit, integration, end-to-end coverage
- **Documentation** — typo fixes, examples, walkthroughs

## Development

```bash
pnpm install
pnpm test

# Run the desktop app — note this is NOT `pnpm dev`, which only starts Vite
pnpm -C apps/desktop tauri:dev
```

Rust tests run from the Tauri crate:

```bash
cd apps/desktop/src-tauri
cargo test --lib
cargo test --test lan_e2e -- --test-threads=1
cargo test --test lan_protocol_e2e -- --test-threads=1
```

Prerequisites and troubleshooting are in the
[README Quick Start](README.md#quick-start). Note that Rust **stable** is
required — `rust-toolchain.toml` at the repository root pins it.

## Code of Conduct

This project follows the
[Contributor Covenant 2.1](CODE_OF_CONDUCT.md). By participating you are
expected to uphold it.

## Pull Requests

1. Keep changes scoped. One concern per PR.
2. Update or add tests.
3. Run `pnpm test` and `pnpm lint` locally before opening a PR.
4. Do not introduce features outside the V0.1 scope (see `开发手册.md` § 68).
