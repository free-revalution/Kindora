# Roadmap

> The canonical roadmap now lives at the repository root:
> **[ROADMAP.md](../ROADMAP.md)**.
>
> It was moved there so that GitHub renders it as a first-class project page
> and so the "Roadmap" link in the README points at a single source of truth.
> This stub is kept so that older links to `docs/ROADMAP.md` keep working.

## Current phase

**V0.1 — Core experience.** The agent profile, matching, consent, icebreaker,
chat, LAN transport and OS-keychain secret storage are implemented and covered
by automated tests. What is **not** done: verification against a live LLM
provider, a complete two-machine GUI session, and any form of cross-network
(WebRTC) pairing.

See [../ROADMAP.md](../ROADMAP.md) for the full phase plan, and
[DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) for the per-feature truth with
code evidence.

## Deliberately out of scope

Ranking algorithms that decide what a user should see; paid placement and
advertising; data brokerage; and agent-authored messages sent without a human
pressing send.
