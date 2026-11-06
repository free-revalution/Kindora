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

| Version                                  | Supported                                               |
| ---------------------------------------- | ------------------------------------------------------- |
| `main` (current tip)                     | ✅ Yes                                                  |
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
- cause a message to be sent on the user's behalf;
- **impersonate another agent** — that is, claim a `sender` id it does not
  own;
- **read the contents of a payload** it was not the intended recipient of.

All inbound protocol messages are schema-validated, rate-limited, replay-guarded,
and passed through a sensitive-field guard and a prompt-injection sanitiser
before any content reaches an LLM prompt. Beyond that, every envelope carries
an **ES256 signature** over its own contents, and every payload is encrypted
with a **session key** negotiated over ephemeral ECDH.

**In scope:** the protocol, the transport, the agent prompt construction, the
privacy/consent layer, and the local storage layer (the SQLite business
database and the OS secret store).

**Out of scope:** the security of the LLM provider you choose, the security of
your operating system, and the security of the network between two machines
that you have not explicitly paired.

---

## What the protocol guarantees

The details are in [PROTOCOL.md](docs/PROTOCOL.md). The short version:

### Message authenticity

Every envelope is signed with **ECDSA P-256 / SHA-256 (ES256)** over a canonical
byte string that includes the payload digest, the sender, the message type,
the timestamp, the message id **and the recipient's agent id**. (`hello` is
signed too — with an empty recipient, because the peer is not yet known when
it is sent.)

- The payload is hashed in its **RFC 8785 canonical** form, so a peer cannot
  change a field's meaning by reordering keys.
- The signature is bound to **one recipient**, so it cannot be lifted out of
  one pairing and replayed into another.
- A peer whose key id changes is **rejected** (TOFU). Recovery means pairing
  again.

### Session encryption

The LAN transport is plaintext TCP, so the protocol negotiates its own
end-to-end encryption:

- **ECDH P-256** with a fresh **ephemeral** key pair per session (forward
  secrecy: a later compromise of the long-term identity key does not decrypt
  traffic that was already exchanged);
- **HKDF-SHA256** over a transcript that both sides sort by agent id, so
  neither side has to agree on who is the host;
- **AES-256-GCM** with a 12-byte nonce (4-byte counter + 8 random bytes);
- the envelope **header and signature are the additional authenticated data**,
  so neither can be swapped, replayed onto another frame, or stripped;
- only the **payload** is encrypted — the header stays in the clear so a
  receiver can route the frame.
- the session key's lifecycle is bounded: it is derived once per session, the
  cipher is **destroyed** when the session is torn down or reset for a
  reconnect, and a reconnect negotiates a **fresh** ephemeral key pair rather
  than reusing the old one.

### Identity at rest

The long-term private key lives in the **OS keychain** (macOS Keychain /
Windows Credential Manager / Linux Secret Service) via the `keyring` crate.
The browser-side store refuses to write a private key to `localStorage` when
the record says the key lives in the keychain, and a legacy plaintext record
is migrated on load.

### Pairing

The pairing code is the **host's identity fingerprint** — a short
authentication string derived from the host's own public key — not a random
password. The joiner recomputes it from the public key the host presents and
closes the session on a mismatch. The UI says so explicitly, because a code
that looks like a password invites the wrong mental model.

---

## Privacy and consent

Privacy is enforced **before a byte leaves the machine**, not by asking the
peer to behave.

### The order of a pairing

```text
discover device
    ↓
establish the secure channel (TLS-equivalent: ECDH + HKDF + AES-GCM)
    ↓
verify the peer's identity (ES256 signature over the transcript)
    ↓
check the local block list
    ↓
exchange only the minimum public information
    ↓
both sides confirm whether to continue
    ↓
exchange the profile, filtered by the local user's authorisation
    ↓
match
    ↓
open further interaction only as far as the user authorised
```

Each arrow is a gate. The block list is consulted **before** the profile is
sent; consent is requested **before** the profile is sent; and a refusal stops
the exchange rather than merely annotating it.

### Field-level authorisation

Every profile field has a boundary flag (`allowBio`, `allowCurrentActivity`,
`allowAvatar`, `allowInterests`, `allowSocialIntent`, `allowConversationStyle`,
`allowAgentConversation`). The flags are set in the UI, persisted, and applied
by `packages/protocol/src/profile-privacy-filter.ts`:

- a field the user has not authorised is **removed from the object before it is
  serialised** — it never reaches the wire, so it cannot be recovered from a
  captured frame;
- the filter runs on the **outbound** direction only; a peer cannot widen the
  local authorisation by asserting a different consent state;
- revoking an authorisation takes effect on the **next** outbound message.

### The block list

Blocked agent ids live in the local business database and are checked by the
consent layer — a business-trust boundary, not a UI affordance. A blocked peer
cannot get past the block-list check, so it never reaches the profile exchange.
Unblocking restores the normal flow.

### What this does not cover

- The block list is **local**. It is not published, not synchronised, and does
  not travel with the agent; a peer you blocked on one machine is not known to
  another.
- The peer still learns that **a** Kindora agent exists on your network, and
  the LAN header exposes the shape of the conversation (§ 3 below).

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
  screen shows only _whether_ a key exists. Removing a key is an explicit,
  separate action — saving an unchanged provider never deletes it.
- A failing secret write fails the whole save. The app will not leave you
  configured against a key that was never stored.

---

## Known security limitations

These are real, current, and not yet fixed. They are listed here so that nobody
has to discover them by reading the source.

### 1. The private key is read back into the webview in order to sign

The shipped desktop app stores the agent's private key in the **OS keychain**,
and the Rust side exposes it through the `agent_key_*` commands. There is
currently **no Rust-side signer**: to produce an ES256 signature, the webview
asks Rust for the key, imports it into WebCrypto, and signs there.

The key is imported as **non-extractable**, so once it is inside WebCrypto it
cannot be exported again — but it _did_ cross the Rust→JS boundary in
cleartext to get there. An attacker with code execution inside the webview
(say, via an XSS in a rendered remote profile field) can request the key.

**Fix:** implement `agent_sign` in Rust using the `p256` crate, so the private
key never leaves the keychain process. Tracked in
[REMEDIATION_PROGRESS.md](docs/REMEDIATION_PROGRESS.md) as a Phase A follow-up.

### 2. Browser dev mode keeps the private key in `localStorage`

When there is no Tauri runtime (`pnpm dev`, a plain Vite page), there is no
OS keychain. The agent record is then tagged
`privateKeyStorage.kind === 'dev-localstorage'` and the private key is kept in
`localStorage` in plaintext.

This is a **dev-only** path and the app labels it as such. The proper fix is a
**non-extractable** WebCrypto key persisted in IndexedDB, so the key material
never exists in readable form at all — that is not implemented yet.

### 3. The transport has no TLS, and only the payload is encrypted

The LAN transport is plaintext TCP with UDP-broadcast discovery. The session
cipher encrypts the **payload** of every envelope, but the **header stays in
the clear** — protocol version, message type, sender, message id, timestamp,
and the signature itself. A passive observer on the same LAN can therefore see
_that_ two agents are talking, _when_, _how often_, and _how large_ the
messages are — but not their contents.

The signature is visible too, which is fine: it is public data by design.

**Fix:** TLS on the TCP path, or a WebRTC DataChannel for cross-network use.
**Neither has landed.** The LAN-reliability work (bounded frame size, bounded
receive queue, per-connection rate limit, invalid-UTF-8 handling, reconnect)
made the transport _well-behaved_; it did not make it _confidential at the
link layer_. The WebRTC path is still an explicit `WEBRTC_NOT_IMPLEMENTED`
stub — the signalling contract is fixed, but there is no DataChannel, so there
is no cross-network path to speak of.

### 4. The pairing fingerprint is a stable identifier, not a one-time secret

The fingerprint is derived from the host's long-term key, so **the same device
always shows the same code**. That is what makes it useful — the user can
confirm they are talking to the same person they paired with last week — but it
also means:

- it is **not** a one-time secret, so it does not protect against a
  **replay**: an attacker who observes a fingerprint and is later able to
  intercept the pairing attempt can present it again;
- it is **not** a credential at all. The fingerprint grants no access. The
  session is authenticated by the ES256 signature on every envelope; the
  fingerprint only binds the session to the identity the user was shown.

The residual risk is narrow: an attacker must both observe the fingerprint
_and_ win the race to be the peer that presents a matching key. Fingerprint
observation is not trivial for a passive LAN observer, because the fingerprint
is never transmitted — it is computed locally from the public key the host
presents.

### 5. The sensitive-field guard can false-positive on base64url key material

The guard scans outbound text for credential-shaped strings. Base64url
encodings of key material look, in places, like long opaque tokens. Because the
guard's word boundaries require a preceding non-word character, the
false-positive rate on real base64url material is roughly **1 in 100 000** per
match attempt — low, but not zero. The guard was left unchanged rather than
weakened, because weakening it to stop false positives would also stop it
catching real secrets. A false positive is a visible, recoverable annoyance; a
false negative is a leak.

### 6. The prompt-injection sanitiser is heuristic

Remote profile content is stripped of credential-like patterns and clearly
delimited as untrusted data, and the system prompt is rebuilt for every analysis
pass. That is defence in depth, not a proof. **A determined peer may still
influence an analysis.** The user always sees the raw analysis and makes the
decision, which is the reason the product exists.

### 7. Signature verification lives in JavaScript, and JCS is implemented once

Every implementation of the signing scheme has to agree byte-for-byte on the
canonical payload encoding. Kindora implements RFC 8785 (JCS) by hand in
`packages/protocol/src/canonical-json.ts` — no third-party dependency — and the
Rust side never parses an envelope, so the two do not have to agree yet.

If Rust ever starts parsing envelopes, it must implement the **same** JCS
function. A JCS that sorts by code point instead of UTF-16 code units, or
escapes non-ASCII, will make every signature fail to verify — and the error
will read like a key mismatch rather than a serialisation mismatch. The same
applies to the signature encoding: WebCrypto produces raw `r || s` (P1363),
while Rust's `p256` crate produces **DER** by default and must be converted
explicitly.

### 8. Experimental status

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
