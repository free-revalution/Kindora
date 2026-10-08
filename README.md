# Kindora

> **Your AI finds the connection. You make the friendship.**

Kindora is an open-source personal AI social agent client that helps people discover meaningful human connections through agent-to-agent matching.

Your AI understands you. Other people's AI understands them. The agents find common ground. Humans make the connection.

---

## Status

**V0.1 — Experimental Open Source MVP**

Goal: validate that AI Agent–mediated social interaction can help two strangers start a real conversation.

---

## Features (V0.1 target)

- Personal AI Social Agent
- User-owned LLM (BYO API key)
- Agent-to-Agent Matching
- Privacy First
- Local First
- Open Source
- Human-in-the-loop

---

## Repository Layout

```text
kindora/
├── apps/
│   └── desktop/          Tauri + React UI
├── packages/
│   ├── protocol/         KSA Protocol
│   ├── agent/            Agent runtime
│   ├── llm/              LLM provider adapters
│   ├── matching/         Structured + LLM matching
│   ├── storage/          SQLite + profile persistence
│   └── transport/        WebRTC / LAN transport
├── docs/                 PRODUCT / ARCHITECTURE / PROTOCOL / ROADMAP
├── 开发手册.md            Authoritative product + dev spec (zh)
└── README.md             This file (en)
```

---

## Quick Start

```bash
# Install Rust (one-time)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install JS deps
pnpm install

# Run desktop app
pnpm dev

# Build everything
pnpm build

# Test everything
pnpm test
```

See [开发手册.md](开发手册.md) for the full product and development specification.

---

## License

[MIT](LICENSE)
