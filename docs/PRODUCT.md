# Product

The authoritative product specification is [开发手册.md](../开发手册.md) (zh). This document provides an English summary.

## Positioning

Kindora is **not**:

- A general AI chat app.
- An AI companion.
- A dating app.

Kindora **is**: an open-source personal AI social agent client.

## Core Loop

```text
User A → Create Personal Agent
       → Connect to Agent B
       → Agent A ↔ Agent B (bounded exchange)
       → Analyze Compatibility
       → Match Report
       → Human A + Human B consent
       → Icebreaker
       → Human A ↔ Human B
       → AI Assistance on request
```

## Non-Goals (V0.1)

- Global Agent discovery / DHT / Relay
- Trust / reputation scores
- Feed / likes / followers
- Dating features
- Payment / subscription / ads
- Centralized user database

The first 20 testers are expected to be technical users who can configure their own LLM API key.
