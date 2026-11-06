# Architecture

> Status: **V0.1.** This document describes what the code does **today**, not
> what it is planned to do. Where something is not implemented, it says so.

## High-level

```text
┌──────────────────────────────────────────────────────────┐
│                   apps/desktop (Tauri + React)           │
│                                                          │
│   ┌──────────┐   ┌──────────┐   ┌─────────────────────┐  │
│   │  UI      │   │  Match   │   │ Chat Surface        │  │
│   │ (React)  │◄──┤  Consent │◄──┤ (Human A ↔ Human B) │  │
│   └──────────┘   │ Icebreak │   └─────────────────────┘  │
│                  └────┬─────┘                             │
│                       │                                   │
│            ┌──────────┼──────────┐                        │
│            ▼          ▼          ▼                        │
│        ┌───────┐  ┌───────┐  ┌────────┐                   │
│        │ LLM   │  │Match- │  │Proto-  │                   │
│        │Adapter│  │  ing  │  │  col   │                   │
│        └───────┘  └───────┘  └────────┘                   │
│                       │                                   │
│                       ▼                                   │
│                ┌────────────┐                             │
│                │ Transport  │  (LAN ✅ · Loopback ✅ ·    │
│                │            │   WebRTC ⛔ stub)           │
│                └────────────┘                             │
└──────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  local business DB                OS Keychain
 (SQLite: profile, settings,       (API keys, agent key)
  block list, chat transcript;
  localStorage in browser dev mode)
```

**There is no server.** The only network traffic leaves the machine to your own
LLM provider and, when pairing over LAN, to the other device.

## Packages

| Package     | Responsibility                                                                                                                                                                                                         | Notes                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol`  | KSA 0.1 envelope, validation, serialization, replay guard, rate limiter, sensitive-field guard, prompt-injection sanitiser, **RFC 8785 canonical JSON**, **ES256 envelope signatures**, **the profile privacy filter** |                                                                                                                                                                                                                                            |
| `agent`     | ECDSA P-256 identity, **envelope signer**, profile validation, prompt assembly, match analysis, icebreaker generation, chat-assist suggestions                                                                         |                                                                                                                                                                                                                                            |
| `llm`       | Provider adapters — OpenAI-compatible, Anthropic, Ollama, MiniMax — behind **one error model and one transport layer**, so every provider fails the same way                                                           |                                                                                                                                                                                                                                            |
| `matching`  | Match / consent / icebreaker / chat orchestrators, plus the display formatters                                                                                                                                         | The chat orchestrator writes to the database through the **`ChatPersistence` port** (`packages/matching/src/chat-persistence.ts`); `apps/desktop` adapts it to `@kindora/storage` — the port keeps `matching` free of a storage dependency |
| `storage`   | Profile, settings, secrets, block list, chat transcript — **the local business database (SQLite)** in the desktop app, `localStorage` in browser dev mode (the identity key lives in the OS keychain)                  | Phase D / D1: `packages/storage/src/database.ts` defines the port; `sqlite-database.ts` and `memory-database.ts` are its two implementations                                                                                               |
| `transport` | LAN (real), Loopback (real), WebRTC (**stub**), pairing-session state machine, **session encryption (ECDH/HKDF/AES-GCM)**, **identity fingerprint**, QR payload helpers                                                |                                                                                                                                                                                                                                            |

Packages resolve to **source**, not to a built `dist` — a consumer imports the
TypeScript directly.

## Data storage — what is actually stored where

| Data                                             | Store                                                                                                                                                                  | Notes                                                                                                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent profile, social intent, conversation style | **Local business database (SQLite)** in the desktop app — `profiles` / `agents` tables (`@kindora/storage` `DatabaseProfileStore`); `localStorage` in browser dev mode |                                                                                                                                                                                                                                  |
| Agent ECDSA P-256 private key (base64 PKCS8)     | **OS keychain** (`agent.identity.p256`) in the desktop app; `localStorage` in browser dev mode only                                                                    | The profile record keeps a _marker_, never the key, when the key lives in the keychain. The database has **no private-key column at all**                                                                                        |
| LLM provider / model / base URL                  | **Local business database (SQLite)** — `settings` table (`DatabaseSettingsStore`); `localStorage` in browser dev mode                                                  |                                                                                                                                                                                                                                  |
| API keys                                         | **OS secret store** via the `keyring` crate                                                                                                                            | Falls back to AES-GCM `localStorage` in browser dev mode only                                                                                                                                                                    |
| Blocked agent ids                                | **Local business database (SQLite)** — `blocked_agents` table (`DatabaseBlockedAgentsStore`); `localStorage` in browser dev mode                                       | Managed in the UI (`BlockedAgentsView`)                                                                                                                                                                                          |
| Chat messages                                    | **Local business database (SQLite)** — `sessions` / `messages` tables (`ChatRepository`); **in memory only** in browser dev mode                                       | Phase D / D2: every message is written down **before** it goes out (`PENDING`), then `SENT` / `FAILED`. A **received** message is `DELIVERED` — KSA 0.1 has no delivery receipt, so an outbound message never claims `DELIVERED` |
| SQLite                                           | `tauri-plugin-sql` **is** used — `apps/desktop/src/lib/tauri-sql-executor.ts` calls `plugin:sql                                                                        | load                                                                                                                                                                                                                             | execute | select`directly. Only ever opened as`sqlite:kindora.db` | The file lives in the app's config directory. Schema + migrations: `packages/storage/src/sql-migrations.ts` / `sql-migrator.ts` |

## The desktop shell

`apps/desktop/src-tauri` exposes three families of Tauri commands:

- `lan_*` — the LAN transport: `host_start`, `host_status`, `host_linked`,
  `host_poll`, `host_send`, `host_stop`, `join_discover`, `join_connect`,
  `join_poll`, `join_send`, `join_disconnect`.
- `secret_*` — the OS secret store: `secret_set`, `secret_get`,
  `secret_delete`, `secret_list`.
- `agent_key_*` — the agent's long-term identity key: `agent_key_store`,
  `agent_key_get`, `agent_key_exists`, `agent_key_delete`.

The React side talks to them through `apps/desktop/src/lib/lan-connect-service.ts`
and `apps/desktop/src/lib/tauri-secret-store.ts`, which detect a Tauri runtime
and fall back to browser-safe equivalents when there is none.

**A fourth path is not a command of this crate at all.** The local business
database is reached through the `tauri-plugin-sql` plugin's own IPC commands —
`plugin:sql|load`, `plugin:sql|execute`, `plugin:sql|select`,
`plugin:sql|close` — which the capability file already grants. The plugin is
registered in `apps/desktop/src-tauri/src/lib.rs`; the frontend calls it
directly from `apps/desktop/src/lib/tauri-sql-executor.ts`. Only
`sqlite:kindora.db` is ever opened.

## The transport layer

- **LAN** — UDP broadcast discovery on port **52419**, then a TCP channel. The
  socket layer is covered by **48 Rust tests across four suites** that bind real
  sockets (`--lib` 13, `lan_e2e` 18, `lan_protocol_e2e` 13, `lan_limits` 4) —
  all green as of 2026-11-06.
  **The TCP channel itself has no TLS**, but every payload is encrypted
  end-to-end above it (ECDH P-256 + HKDF-SHA256 + AES-256-GCM); the envelope
  header and the signature stay in the clear. See
  [SECURITY.md](../SECURITY.md) and [PROTOCOL.md](PROTOCOL.md).
- **Loopback** — both ends of a conversation inside one process. Used by the
  dev server and by the test suites.
- **WebRTC** — the interface is fixed, the implementation is a stub: every entry
  point throws a typed `WebRtcNotImplementedError` (code `WEBRTC_NOT_IMPLEMENTED`),
  and no code path lets `connect()` resolve. The signalling contract the real
  implementation must satisfy is in `packages/transport/src/webrtc-transport.ts`.

## Cross-cutting constraints

- **Local First.** Persistent state stays on the user's device.
- **Privacy First.** Agents exchange only the minimum public profile fields,
  and only what the user's boundaries allow.
- **Bounded Interaction.** Agent-to-Agent exchanges are capped.
- **Untrusted Remote.** Peer agent messages are data, never instructions.
- **Human in the loop.** The AI drafts; a human sends. This is enforced in the
  orchestrators, not just in the UI.

## Reading the code

Start at `packages/protocol/src/index.ts` for the wire contract, then
`packages/matching/src/orchestrator.ts` for the conversation flow, then
`apps/desktop/src/App.tsx` for how the screens are wired.

Per-feature status with evidence: [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md).
