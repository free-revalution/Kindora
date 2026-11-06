# Protocol — KSA 0.1

KSA = **Kindora Social Agent Protocol**, version `0.1`.

This document is the wire contract. It is normative for anyone implementing a
KSA peer — including a future Rust implementation.

---

## Envelope

```json
{
  "protocol": "KSA",
  "version": "0.1",
  "messageId": "uuid",
  "timestamp": "ISO-8601",
  "type": "profile_exchange",
  "sender": "agent_id",
  "payload": {},
  "signature": {
    "alg": "ES256",
    "keyId": "base64url(SHA-256(SPKI DER))",
    "value": "base64url(raw r||s)",
    "signedFields": "ksa-sig-v1"
  }
}
```

`signature` is **optional on the wire** — the envelope shape still parses for a
peer that predates signing — but **mandatory on every message the transport
accepts**, `hello` included. A message that arrives without a valid signature
is dropped and counted; three failures close the session with
`closeReason = "signature-invalid"`.

## Message Types (V0.1)

The complete list, as defined in `packages/protocol/src/index.ts`
(`MESSAGE_TYPES`):

- `hello`
- `profile_exchange`
- `match_request`
- `match_response`
- `icebreaker_request`
- `icebreaker_response`
- `chat_message`
- `permission_request`
- `consent_accept`
- `consent_reject`
- `block`
- `disconnect`

The list is **fixed**. Adding a type is a breaking protocol change, so the
handshake reuses the existing bidirectional `hello` rather than introducing new
message types.

## Session Flow — the two-phase profile exchange

The **order** of messages on a session is normative, and it changed in Phase B.
Before Phase B the full profile crossed the wire _before_ the human consent
step — and crossed it twice (once as `profile_exchange.payload.profile`, once
nested in `profile_exchange.payload.agent.profile`, and a third time as
`match_request.payload.selfProfile`). The flow below guarantees that only a
minimal card travels before the consent, and that the authorised profile
travels only after **both** sides accepted.

```text
hello  ──►  (peer hello)          handshake — carries NO profile fields
          ┌──────────────────────────────────────────────────┐
          │ PHASE 1 — identify                                 │
          │ profile_exchange  { public card }                 │
          └──────────────────────────────────────────────────┘
consent_accept / consent_reject / block        the human decision, both sides
          ┌──────────────────────────────────────────────────┐
          │ PHASE 2 — exchange + match                       │
          │ match_request   { authorised profile }            │
          │ match_response  { analysis }                      │
          └──────────────────────────────────────────────────┘
icebreaker_request → icebreaker_response → chat_message …
```

### The public card — `profile_exchange.payload.profile`

| field               | in the card?                                         |
| ------------------- | ---------------------------------------------------- |
| `nickname`          | always — it is already disclosed by `hello`          |
| `socialIntent`      | only if the sender's `allowSocialIntent` is set      |
| `conversationStyle` | only if the sender's `allowConversationStyle` is set |
| `bio`               | **never**                                            |
| `interests`         | **never**                                            |
| `currentActivities` | **never**                                            |
| `avatar`            | **never** — the key is omitted entirely              |

`profile_exchange.payload.agent.profile` carries **the same card**, not the
full profile.

### The authorised profile — `match_request.payload.selfProfile`

Every field the sender did not authorise is removed **before** the envelope is
built:

| field               | gated by                 | when withheld      |
| ------------------- | ------------------------ | ------------------ |
| `bio`               | `allowBio`               | `""`               |
| `interests`         | `allowInterests`         | `[]`               |
| `currentActivities` | `allowCurrentActivity`   | `[]`               |
| `socialIntent`      | `allowSocialIntent`      | `[]`               |
| `conversationStyle` | `allowConversationStyle` | `[]`               |
| `avatar`            | `allowAvatar`            | the key is omitted |

`nickname` is always present.

The rule is **local**: the sender's own boundaries decide what leaves the
device. A peer may not widen the disclosure by accepting — the peer's
`consent_accept` is evidence that _they_ agreed, never permission to send
more. The sender asserts the filtered copy immediately before sending
(`assertProfileWithinBoundaries`); a copy that still carries an unauthorised
field is a programmer error and the send is refused.

The **defaults** are the minimal-necessary set: `allowInterests` on, every
other field-level gate off (`allowBio`, `allowAvatar`, `allowCurrentActivity`
false; `allowSocialIntent` and `allowConversationStyle` on so the consent
screen has something to show). The behavioural flags
(`allowAgentConversation`, `allowContactExchange`, `allowOfflineMeeting`,
`allowProjectDetails`) are separate and default to
`true / false / false / false`.

### The block list

A peer on the local block list is refused **before any profile data leaves the
device**, and the check is repeated before the phase-2 profile exchange — so an
agent blocked while the consent screen was up does not receive the authorised
profile either. The refusal closes the session with
`closeReason = "peer-blocked"`.

## Validation Rules

1. `protocol` MUST be `"KSA"`.
2. `version` MUST be a supported version (`0.1` only in V0.1).
3. `messageId` MUST be unique; replays of the same id are rejected.
4. `timestamp` MUST be within an acceptable skew window (default 60s).
5. `type` MUST be one of the V0.1 types listed above.
6. `payload` MUST validate against the type's schema.
7. `signature`, when present, MUST have `alg === "ES256"`,
   `signedFields === "ksa-sig-v1"`, a `keyId` that is base64url of a 32-byte
   digest, and a `value` that is base64url of a 64-byte signature.

The validator **normalises** the payload (drops unknown fields, filters invalid
enum members, forces the five required boundary booleans and defaults the five
optional field-level disclosure gates). This matters for signing —
see below.

## Canonical JSON (RFC 8785 / JCS)

Anything that is hashed MUST first be serialised with **RFC 8785 JSON
Canonicalization Scheme**. `JSON.stringify` is **not** equivalent: it preserves
insertion order, so two peers that assemble the same payload with the keys in a
different order would compute different digests.

The implementation lives in `packages/protocol/src/canonical-json.ts` and has
**no third-party dependency**. Its rules:

- object properties are sorted by their **UTF-16 code units** (not code points,
  not UTF-8 bytes — this differs for characters outside the BMP);
- strings use JSON escaping with the short forms `\b \f \n \r \t` and `\u00xx`
  for the remaining C0 controls; non-ASCII is emitted as UTF-8, never as
  `\uXXXX`;
- numbers use the ECMAScript `Number::toString` algorithm, with `-0`
  serialised as `0`;
- `undefined` object properties are omitted; `undefined` array elements become
  `null`;
- there is no insignificant whitespace.

> ### ⚠️ Cross-language constraint
>
> Both ends of KSA 0.1 are TypeScript today — the Rust side only moves opaque
> strings and never parses an envelope. That is the only reason a JS-only JCS
> implementation is safe.
>
> **If Rust ever starts parsing envelopes, it must implement this exact
> function.** A JCS that sorts by code point, escapes non-ASCII, or formats
> numbers differently will make every signature fail to verify, with an error
> that looks like a key mismatch rather than a serialisation mismatch.

## Signatures

### Algorithm

ECDSA P-256 with SHA-256, identified on the wire as `ES256`. The signature
value is the **raw `r || s` form (64 bytes, P1363)** encoded as unpadded
base64url — the shape WebCrypto produces natively.

> Rust's `p256` crate emits **DER** by default. A Rust verifier must convert
> explicitly (`Signature::to_bytes()`); a DER blob silently fails to verify
> against a raw `r||s` signature and the error reads like a bad key.

### Signing input

The signature covers a deterministic byte string. Every record is
**LF-terminated** — including the last one — so no field can contain a newline
and no field can be shifted into its neighbour's position:

```text
KSA-SIG-V1\n
<protocol>\n
<version>\n
<messageId>\n
<timestamp>\n
<type>\n
<sender>\n
<recipient>\n
<base64url(SHA-256(JCS(payload)))>\n
```

- The payload digest is taken over the **validated** payload — the exact shape
  the receiver ends up with after `validateEnvelope`. Both sides therefore hash
  identical bytes even though the validator drops unknown fields, filters
  invalid enum members and forces the boundary booleans.
- `recipient` binds a message to one session: the sender signs with the
  **peer's** agent id, the receiver verifies against its **own** agent id. A
  signature therefore cannot be lifted out of one pairing and replayed into
  another.
- `hello` is the exception: it is sent before the peer is known, so it signs
  with an **empty** recipient.
- The signature is **not** part of its own signing input.

### Key binding and rotation

| Concept  | Definition                                                      |
| -------- | --------------------------------------------------------------- |
| `keyId`  | `base64url(SHA-256(SPKI DER))` — the public-key fingerprint     |
| Trust    | TOFU: the peer's key is latched from the first accepted `hello` |
| Rotation | A different `keyId` for the same `agentId` is **rejected**      |
| Recovery | The user pairs again, or explicitly trusts the new key          |

A `hello` whose `signature.keyId` does not match the digest of the public key
it carries is rejected outright (`hello-key-id-mismatch`).

## Session encryption

The LAN transport is **plaintext TCP**. Kindora adds an end-to-end encrypted
layer _inside_ the envelope.

### Key agreement

Each side generates a fresh **ephemeral** ECDH P-256 key pair per session and
offers the public half in its `hello` (`payload.sessionKeyExchange`).

```text
sharedSecret = ECDH_P256(esk_local, Epk_peer)
transcript   = JCS([{agentId, ephemeralPublicKey}, …])   // exactly 2 entries,
                                                           // sorted by agentId
sessionKey   = HKDF-SHA256(ikm = sharedSecret,
                           salt = transcript,
                           info = "KSA-SESSION-V1",
                           len  = 32)
```

The transcript is **sorted by agent id**, so the host and the joiner derive
byte-identical salts without having to agree on who is the host. Ephemeral
keys give the session forward secrecy: compromising the long-term identity key
later does not decrypt traffic that was already exchanged.

### Frame shape

```json
{
  "protocol": "KSA",
  "version": "0.1",
  "messageId": "…",
  "timestamp": "…",
  "type": "chat_message",
  "sender": "…",
  "signature": { "alg": "ES256", "keyId": "…", "value": "…", "signedFields": "ksa-sig-v1" },
  "nonce": "base64url(12 bytes)",
  "ciphertext": "base64url(AES-256-GCM ciphertext || 16-byte tag)"
}
```

- The header and the signature stay in the clear so a receiver can route the
  frame and check the signature without the session key first.
- The **header + signature are the AES-GCM additional authenticated data**, so
  an attacker cannot move the header of one frame onto the ciphertext of
  another, nor strip a signature.
- The nonce is 12 bytes: a **4-byte big-endian counter** followed by **8
  session-scoped random bytes**. The counter guarantees uniqueness within a
  session; the random half removes any chance of two sessions colliding.
- Only the payload is encrypted. The plaintext exists only in the two peers'
  memory.

### Ordering rule

The `hello` is sent **in the clear** — it has to be, because it carries the
ephemeral key the peer needs in order to derive anything. Therefore:

> Every encrypted frame is sent **after** the sender's own `hello`, and the
> receiver installs the cipher only after it has accepted the peer's `hello`.

A frame that arrives in the window between those two events is **queued, not
dropped** (bounded at 32 frames), and flushed the moment the cipher is
installed.

## Pairing fingerprint

The pairing code is the **host's identity fingerprint**, not a password and
not a temporary key:

```text
fingerprint = CrockfordBase32( SHA-256( utf8(agentId) || SPKI_DER ) )[0..6]
```

Six Crockford characters carry 30 bits and read out loud without ambiguity
(the alphabet omits `I`, `L`, `O`, `U`). It is displayed grouped as `A1B2-C3`
and compared case- and dash-insensitively.

The joiner recomputes the fingerprint from the public key the host presents in
its `hello` and compares it with what the user typed. A mismatch closes the
session with `closeReason = "peer-fingerprint-mismatch"` before any data is
exchanged.

**The fingerprint is not a credential.** It grants no access on its own — the
session is authenticated by the ES256 signature over every envelope. The
fingerprint only binds the session to the identity the user was shown. Because
it is derived from a long-term key, it is **stable per identity**: the same
device always shows the same fingerprint. See `SECURITY.md` for the replay
trade-off this implies.

## Capabilities

`AgentCapabilities` carries three functional flags and four security flags that
cannot be confused with one another:

| Flag                          | Meaning                                   | Value in KSA 0.1          |
| ----------------------------- | ----------------------------------------- | ------------------------- |
| `supportsMatchAnalysis`       | can run the match analysis                | `true`                    |
| `supportsIcebreaker`          | can generate icebreakers                  | `true`                    |
| `supportsChatAssist`          | can assist chat                           | `true`                    |
| `supportsMessageSigning`      | can produce and verify ES256 signatures   | depends on the runtime    |
| `supportsSessionEncryption`   | can take part in an E2E encrypted session | depends on the runtime    |
| `supportsTransportEncryption` | **the transport has TLS**                 | `false` — there is no TLS |
| `supportsWebRtc`              | can use a WebRTC DataChannel              | `false` — not implemented |

The four security flags are derived from the actual runtime configuration
(`buildRuntimeCapabilities` in `@kindora/agent`), never hard-coded. A peer
that advertises `supportsSessionEncryption` **must** offer an ephemeral key —
a claim without a key is treated as a lie and closes the session.

The security flags are optional on the wire and default to `false` when
absent, so a peer that predates them still parses.

## Replay Protection

- Maintain a short-lived LRU of recent `messageId`s.
- Reject messages older than the skew window.

## Privacy Boundary

Exchanged payloads MUST NOT contain:

- API keys
- Private keys
- Local file paths
- Full conversation history
- Contacts
- Exact location
- System information

On top of that, a profile payload carries **only what the sender's own
boundaries authorise** — see [Session Flow](#session-flow--the-two-phase-profile-exchange).
A field the sender did not authorise is emptied (or omitted) before the
envelope is built; it is never sent and then "handled privately" by the
receiver.

## Base64 dialects

| Alphabet                   | Where                                                                            |
| -------------------------- | -------------------------------------------------------------------------------- |
| standard (`+/=`)           | the legacy `Agent.publicKey` / `privateKey` fields (SPKI / PKCS8)                |
| base64url (`-_`, unpadded) | everything new: signatures, digests, key ids, ephemeral keys, ciphertext, nonces |
