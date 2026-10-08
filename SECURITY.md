# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Kindora, please report it privately:

- Open a GitHub Security Advisory on this repository, **OR**
- Email: `security@kindora.local` (placeholder — replace with the project's actual contact)

Please do **not** open a public issue for security-sensitive reports.

## Threat Model (V0.1)

Kindora treats **all remote agent messages as untrusted input**. Specifically:

- A peer agent must never be able to modify system prompts, permissions, or profile data.
- A peer agent must never be able to read API keys, private keys, local files, or contacts.
- A peer agent must never be able to invoke shell, browser, MCP, or filesystem tools.
- All inbound protocol messages are schema-validated and rate-limited.

## API Key Handling

- API keys are stored only in the OS-native secret store (macOS Keychain / Windows Credential Manager / Linux Secret Service).
- API keys are **never** sent to other agents, written to logs, included in profiles, or committed to git.

## Prompt Injection Defenses

- System prompts explicitly mark remote agent content as untrusted data.
- Agent context is rebuilt for each analysis pass; remote content never modifies the system prompt.

## Out of Scope for V0.1

- Reputation / Trust scores (require network scale we do not have)
- Global discovery / DHT (postponed to V0.3)
- Payment, subscriptions, advertisements (explicitly excluded)

See [开发手册.md § 34–36, § 56–57](开发手册.md) for the full security constraints.
