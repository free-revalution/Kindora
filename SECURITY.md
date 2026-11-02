# Security Policy

Kindora is an experimental project that exchanges data between two people's
devices. This document describes what is protected, what is **not**, and how to
report a problem.

---

## Reporting a vulnerability

**Please do not open a public issue for a security-sensitive report.**

Report privately through either of these channels:

1. **GitHub Security Advisory** — open one from the
   [Security tab](https://github.com/free-revalution/Kindora/security/advisories/new)
   on this repository (the "Report a vulnerability" button), **or**
2. **Email:** **jiang-revolution@outlook.com**

Please include:

- what an attacker can do, and what they need in order to do it;
- the affected version or commit;
- reproduction steps;
- whether the issue requires the victim's consent (for example, a peer you
  deliberately paired with) or not.

We will acknowledge a report, and we will not ask you to keep a confirmed
vulnerability secret indefinitely. If a fix is straightforward we will open a
pull request and credit you; if it is not, we will say so rather than go quiet.

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

---

## Supported versions

Kindora has **no tagged releases and no published installers yet** — it is
source-only. That makes the supported-version list short:

| Version | Supported |
| --- | --- |
| `main` (current tip) | ✅ Yes |
| Any commit older than the current `main` | ❌ No — please re-check against `main` before reporting |

When releases are published, this table will be replaced with a list of
supported minor versions and their security-fix window.

---

## Threat model (V0.1)

Kindora treats **all remote agent messages as untrusted input**. A peer agent
must never be able to:

- modify system prompts, permissions, or profile data;
- read API keys, private keys, local files, or contacts;
- invoke shell, browser, MCP, or filesystem tools;
- cause a message to be sent on the user's behalf.

All inbound protocol messages are schema-validated, rate-limited, replay-guarded,
and passed through a sensitive-field guard and a prompt-injection sanitiser
before any content reaches an LLM prompt.

**In scope:** the protocol, the transport, the agent prompt construction, the
local storage layer.

**Out of scope:** the security of the LLM provider you choose, the security of
your operating system, and the security of the network between two machines
that you have not explicitly paired.

---

## API key handling

- An API key is written to the **OS-native secret store** via the `keyring`
  crate — macOS Keychain, Windows Credential Manager, or Linux Secret Service.
- **In browser dev mode only** (`pnpm dev`, i.e. a plain Vite page with no Tauri
  runtime), the key falls back to `BrowserLocalStorageEncryptedSecretStore` —
  AES-GCM in `localStorage`. That fallback exists so the UI can be developed
  without a native build. **It is weaker than the OS keychain**, and it is not
  what the shipped desktop app uses.
- A key is **never** sent to another agent, never written to a log, never
  included in a profile, and never committed to git.
- A stored key is **never displayed**, not even masked-and-decoded. The Settings
  screen shows only *whether* a key exists. Removing a key is an explicit,
  separate action — saving an unchanged provider never deletes it.
- A failing secret write fails the whole save. The app will not leave you
  configured against a key that was never stored.

---

## Known security limitations

These are real, current, and not yet fixed. They are listed here so that nobody
has to discover them by reading the source.

### 1. LAN traffic is not encrypted

The LAN transport uses a **plain TCP channel** with no TLS. Anything on the same
local network can read the profile data, match analyses, and chat messages
exchanged between two paired Kindora instances. The transport source says so
explicitly (`packages/transport/src/lan-transport.ts`): *production must add TLS
or a WebRTC DataChannel layer*.

**Mitigation today:** use Kindora only on a network you trust. The planned
Phase 3 (see [ROADMAP.md](ROADMAP.md)) adds TLS to the TCP path and a WebRTC
DataChannel for cross-network use.

### 2. The agent's private key is stored in plaintext

The Ed25519 private key is exported as base64-encoded PKCS8 and stored in the
webview's `localStorage`. Anyone with access to the user's localStorage can
read it. It is **not** encrypted at rest.

### 3. A peer is identified by a pairing code, not by a verified key

Pairing proves that two people typed the same 6-character code. It does not
cryptographically verify the identity of the peer. A code-guessing adversary on
the same LAN is a theoretical concern that the current design does not address.

### 4. The prompt-injection sanitiser is heuristic

Remote profile content is stripped of credential-like patterns and clearly
delimited as untrusted data, and the system prompt is rebuilt for every analysis
pass. That is defence in depth, not a proof. **A determined peer may still
influence an analysis.** The user always sees the raw analysis and makes the
decision, which is the reason the product exists.

### 5. Experimental status

No external security audit has been performed. No releases have been published.
Treat this as research-grade software.

---

## Responsible disclosure

- Please give the maintainer a reasonable window to publish a fix before
  disclosing publicly.
- Do not include real API keys, real user profiles, or personal data in a
  report. Synthetic data is sufficient to reproduce anything.
- Do not test against infrastructure you do not own, and do not involve other
  users without their consent.

---

## Reporting non-security issues

Bugs, feature requests and design questions belong in
[GitHub Issues](https://github.com/free-revalution/Kindora/issues) or
[Discussions](https://github.com/free-revalution/Kindora/discussions). Use the
issue templates in `.github/ISSUE_TEMPLATE/`.
