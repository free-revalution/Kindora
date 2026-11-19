//! Credential-shape regex — P0-2A / A0 (`regex` crate landing).
//!
//! Mirrors the defence-in-depth patterns in
//! `packages/protocol/src/sensitive-field-guard.ts`. Full inbound
//! sensitive-field enforcement on the Rust wire path is a later task;
//! this module proves the dependency is wired and keeps the patterns
//! in one place.

use regex::Regex;
use std::sync::OnceLock;

fn api_key_like() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Long-ish high-entropy token shapes (sk-…, Bearer …, hex blobs).
        Regex::new(r"(?i)\b(sk-[a-z0-9_-]{16,}|bearer\s+[a-z0-9._~+/=-]{16,}|[a-f0-9]{40,})\b")
            .expect("credential_shape regex must compile")
    })
}

/// True when `text` looks like it contains an API-key / bearer-shaped secret.
pub fn looks_like_credential(text: &str) -> bool {
    api_key_like().is_match(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_openai_style_key() {
        assert!(looks_like_credential("header sk-abcdefghijklmnopqrstuvwxyz01 footer"));
    }

    #[test]
    fn ignores_ordinary_prose() {
        assert!(!looks_like_credential("hello from Kindora matching"));
    }
}
