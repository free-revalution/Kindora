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
   localStorage                   OS Keychain
 (profile, settings,             (API keys only)
  block list, agent key)
```

**There is no server.** The only network traffic leaves the machine to your own
LLM provider and, when pairing over LAN, to the other device.

## Packages

| Package | Responsibility | Notes |
| --- | --- | --- |
| `protocol` | KSA 0.1 envelope, validation, serialization, replay guard, rate limiter, sensitive-field guard, prompt-injection sanitiser | |
| `agent` | Ed25519 identity, profile validation, prompt assembly, match analysis, icebreaker generation, chat-assist suggestions | |
| `llm` | Provider adapters — OpenAI-compatible, Anthropic, Ollama, MiniMax | |
| `matching` | Match / consent / icebreaker / chat orchestrators, plus the display formatters | |
| `storage` | Profile, settings, secrets, block list — **currently `localStorage`** | SQLite is **not** wired up |
| `transport` | LAN (real), Loopback (real), WebRTC (**stub**), pairing-session state machine, pairing code, QR payload helpers | |

Packages resolve to **source**, not to a built `dist` — a consumer imports the
TypeScript directly.

## Data storage — what is actually stored where

| Data | Store | Notes |
| --- | --- | --- |
| Agent profile, social intent, conversation style | `localStorage` (`@kindora/storage` `ProfileStore`) | |
| Agent Ed25519 private key (base64 PKCS8) | `localStorage`, inside the profile record | **Not encrypted at rest** |
| LLM provider / model / base URL | `localStorage` (`SettingsStore`) | |
| API keys | **OS secret store** via the `keyring` crate | Falls back to AES-GCM `localStorage` in browser dev mode only |
| Blocked agent ids | `localStorage` (`BlockedAgentsStore`) | No UI to view it yet |
| Chat messages | **In memory only** | Lost when the window closes |
| SQLite | `tauri-plugin-sql` is registered, but **nothing calls it** | |

## The desktop shell

`apps/desktop/src-tauri` exposes two families of Tauri commands:

- `lan_*` — the LAN transport: `host_start`, `host_status`, `host_linked`,
  `host_poll`, `host_send`, `host_stop`, `join_discover`, `join_connect`,
  `join_poll`, `join_send`, `join_disconnect`.
- `secret_*` — the OS secret store: `secret_set`, `secret_get`,
  `secret_delete`, `secret_list`.

The React side talks to them through `apps/desktop/src/lib/lan-connect-service.ts`
and `apps/desktop/src/lib/tauri-secret-store.ts`, which detect a Tauri runtime
and fall back to browser-safe equivalents when there is none.

## The transport layer

- **LAN** — UDP broadcast discovery on port **52419**, then a TCP channel. The
  socket layer is covered by 31 integration tests that bind real sockets.
  **The channel is not encrypted** — see [SECURITY.md](../SECURITY.md).
- **Loopback** — both ends of a conversation inside one process. Used by the
  dev server and by the test suites.
- **WebRTC** — the interface is fixed, the implementation is a stub:
  `connect()` throws.

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
