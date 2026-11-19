# P0-2A merge-blocker checklist (A-MB)

Recorded after the 2026-11-19 full-push implementation wave.
**Do not claim “credential isolation complete” unless every MB row is ✅.**

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| **MB-1** | `secret_get` removed from WebView command surface | ✅ | `lib.rs` invoke_handler has `secret_exists` only; no `secret_get` / `secret_list` |
| **MB-2** | API keys read only in Rust for LLM | ✅ | `llm_chat` / `llm_test_connection` use `secret_get_internal`; TS Tauri path does not load plaintext |
| **MB-3** | SSRF chain on custom `baseUrl` | ✅ | `llm.rs` S-6…S-9 unit tests; redirects disabled in `llm_http` |
| **MB-4** | Zero-leakage: errors/audit omit secrets | ✅ | LLM error redaction + sensitive_guard on envelopes |
| **MB-5** | No false “isolation complete” marketing | ✅ | This checklist + DEVELOPMENT_STATUS honesty notes |

## HD / D defaults applied this wave

| Decision | Choice |
| --- | --- |
| **HD-1** | Abort when old≠new keychain entries (re-authorize / create new agent) |
| **HD-2** | Confirm once via `rfd` before M1 copy |
| **D-3** | GitHub-hosted runners for A-41 (`rust-e3b` job) |
| **D-5** | Linux `zenity` missing → fail-closed (RES-11 still open) |

## Still not VERIFIED by this checklist

- Two-device GUI H-1…H-9 / J-1…J-9
- Live LLM provider calls with real credentials
- A-41-5 / RES-13 closed (needs green `rust-e3b` on all three OSes in CI)
- P0-2B (starts only after P0-2A merge)
