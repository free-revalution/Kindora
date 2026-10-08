# Architecture

> Status: **V0.1 — Phase 0 Bootstrap.** Subject to change.

## High-Level

```text
┌──────────────────────────────────────────────────────────┐
│                   apps/desktop (Tauri + React)           │
│                                                          │
│   ┌──────────┐   ┌──────────┐   ┌─────────────────────┐  │
│   │  UI      │   │ Agent    │   │ Chat Surface        │  │
│   │ (React)  │◄──┤ Runtime  │◄──┤ (Human A ↔ Human B) │  │
│   └──────────┘   └────┬─────┘   └─────────────────────┘  │
│                       │                                  │
│            ┌──────────┼──────────┐                       │
│            ▼          ▼          ▼                       │
│        ┌───────┐  ┌───────┐  ┌────────┐                  │
│        │ LLM   │  │Match- │  │Proto-  │                  │
│        │Adapter│  │  ing  │  │  col   │                  │
│        └───────┘  └───────┘  └────────┘                  │
│                       │                                  │
│                       ▼                                  │
│                ┌────────────┐                            │
│                │ Transport  │  (WebRTC / LAN / Manual)   │
│                └────────────┘                            │
└──────────────────────────────────────────────────────────┘
                         │
                         ▼
                  Local SQLite
                  OS Keychain (API keys)
```

## Packages

| Package        | Responsibility                                              |
|----------------|-------------------------------------------------------------|
| `protocol`     | KSA 0.1 message schema, validation, serialization          |
| `agent`        | Agent runtime, prompt assembly, context windowing           |
| `llm`          | Provider adapters (OpenAI-compatible, Anthropic, Ollama)   |
| `matching`     | Structured + LLM semantic compatibility analysis            |
| `storage`      | SQLite persistence for profile, conversations, settings     |
| `transport`    | Pluggable transport layer (WebRTC, LAN, manual signaling)   |

## Cross-Cutting Constraints

- **Local First.** All persistent state lives in the user's SQLite DB and OS keychain.
- **Privacy First.** Agents exchange only the minimum public profile fields.
- **Bounded Interaction.** Agent-to-Agent messages capped (default 6).
- **Untrusted Remote.** Peer agent messages are data, not instructions.
