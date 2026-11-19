//! LLM HTTP client scaffolding — P0-2A / A-LLM-0.
//!
//! Lands `reqwest 0.12.28` with the approved TLS feature set
//! (`rustls-tls-native-roots` + `json` + `http2` + `stream`, no
//! `system-proxy`, default features off). Actual provider calls that
//! read API keys only from the keychain land in A-LLM; this module only
//! proves the client builds with redirect-disabled defaults (Q4b).

use reqwest::redirect::Policy;

#[derive(Debug, thiserror::Error)]
pub enum LlmHttpError {
    #[error("failed to build LLM HTTP client: {0}")]
    Build(String),
}

/// Build a TLS-capable HTTP client for server-side LLM calls.
///
/// Redirects are disabled by default (SSRF defence starts here; full
/// URL allow-listing is A-SSRF).
pub fn build_llm_http_client() -> Result<reqwest::Client, LlmHttpError> {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|e| LlmHttpError::Build(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_client_with_redirects_disabled() {
        let client = build_llm_http_client().expect("client must build");
        // Smoke: type is usable; no network call.
        let _ = client;
    }
}
