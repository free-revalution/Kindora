//! Rust-side LLM HTTP — P0-2A / A-LLM.
//!
//! API keys are read from the OS keychain via `secrets::secret_get_internal`
//! and never returned to the WebView. Outbound URLs pass SSRF checks (S-6…S-9).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};

use crate::credential_shape::looks_like_credential;
use crate::secrets::secret_get_internal;

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);

const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChatResponse {
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmTestConnectionResponse {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("{0}")]
    Public(String),
}

impl serde::Serialize for LlmError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Validate and parse a base URL for the given provider (S-6…S-9).
pub fn validate_llm_base_url(provider: &str, base_url: &str) -> Result<reqwest::Url, String> {
    reject_userinfo_in_raw(base_url)?;
    let url = reqwest::Url::parse(base_url.trim()).map_err(|e| format!("invalid baseUrl: {e}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ssrf-userinfo-rejected".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "baseUrl must include a host".to_string())?;
    let scheme = url.scheme();

    if provider == "ollama" {
        if scheme == "http" {
            if !is_ollama_loopback_host(host) {
                return Err("ssrf-scheme-not-allowed: Ollama http must use loopback host".into());
            }
            validate_port(url_port(&url))?;
            if is_ip_literal(host) {
                let ip: IpAddr = host
                    .parse()
                    .or_else(|_| host.trim_matches(['[', ']']).parse())
                    .map_err(|_| "invalid Ollama host IP".to_string())?;
                if !is_loopback_ip(ip) {
                    return Err("ssrf-private-address".into());
                }
            }
            return Ok(url);
        }
        if scheme == "https" {
            validate_remote_https_host_literal(host)?;
            validate_port(url_port(&url))?;
            return Ok(url);
        }
        return Err("ssrf-scheme-not-allowed".into());
    }

    if scheme != "https" {
        return Err("ssrf-scheme-not-allowed".into());
    }
    validate_port(url_port(&url))?;
    validate_remote_https_host_literal(host)?;
    Ok(url)
}

fn reject_userinfo_in_raw(raw: &str) -> Result<(), String> {
    let trimmed = raw.trim();
  // Authority segment before path/query — reject embedded credentials.
    let authority = trimmed
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split(&['/', '?', '#'][..]).next())
        .unwrap_or("");
    let decoded = percent_decode_userinfo(authority);
    if decoded.contains('@') {
        let at = decoded.find('@').unwrap();
        let before = &decoded[..at];
        if !before.is_empty() && before != ":" && before.contains(':') {
            return Err("ssrf-userinfo-rejected".into());
        }
        if !before.is_empty() && !before.contains(':') {
            return Err("ssrf-userinfo-rejected".into());
        }
    }
    Ok(())
}

fn percent_decode_userinfo(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    let bytes = segment.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(v as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn is_ollama_loopback_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "localhost" || h == "127.0.0.1" || h == "::1" || h == "[::1]"
}

fn is_ip_literal(host: &str) -> bool {
    host.parse::<IpAddr>().is_ok() || host.starts_with('[')
}

fn url_port(url: &reqwest::Url) -> u16 {
    match url.port() {
        Some(p) => p,
        None if url.scheme() == "https" => 443,
        None => 80,
    }
}

fn validate_port(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("invalid port".into());
    }
    Ok(())
}

fn validate_remote_https_host_literal(host: &str) -> Result<(), String> {
    let ip: IpAddr = if let Ok(ip) = host.parse() {
        ip
    } else if let Some(inner) = host.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        inner.parse().map_err(|_| "invalid IPv6 literal".to_string())?
    } else {
        return Ok(());
    };
    if is_restricted_ip(ip) {
        return Err("ssrf-private-address".into());
    }
    Ok(())
}

pub fn is_restricted_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_restricted_ipv4(v4),
        IpAddr::V6(v6) => is_restricted_ipv6(v6),
    }
}

fn is_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

fn is_restricted_ipv4(v4: Ipv4Addr) -> bool {
    if v4.is_unspecified() || v4.is_loopback() || v4.is_private() || v4.is_link_local() {
        return true;
    }
    let o = v4.octets();
    // CGNAT 100.64.0.0/10
    if o[0] == 100 && (o[1] & 0xc0) == 64 {
        return true;
    }
    // multicast 224.0.0.0/4
    if o[0] >= 224 && o[0] <= 239 {
        return true;
    }
    // reserved / broadcast
    o[0] == 255
}

fn is_restricted_ipv6(v6: Ipv6Addr) -> bool {
    if v6.is_unspecified() || v6.is_loopback() {
        return true;
    }
    let segs = v6.segments();
    // link-local fe80::/10
    if (segs[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // unique local fc00::/7
    if (segs[0] & 0xfe00) == 0xfc00 {
        return true;
    }
    // multicast ff00::/8
    if (segs[0] & 0xff00) == 0xff00 {
        return true;
    }
    false
}

async fn resolve_and_validate(host: &str, port: u16, provider: &str) -> Result<Vec<SocketAddr>, String> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| redact_err(format!("dns lookup failed: {e}"), &[]))?
        .collect();
    if addrs.is_empty() {
        return Err("dns lookup returned no addresses".into());
    }
    for addr in &addrs {
        let ip = addr.ip();
        if provider == "ollama" {
            if !is_loopback_ip(ip) {
                return Err("ssrf-private-address".into());
            }
        } else if is_restricted_ip(ip) {
            return Err("ssrf-private-address".into());
        }
    }
    Ok(addrs)
}

async fn http_client_for_url(url: &reqwest::Url, provider: &str) -> Result<reqwest::Client, String> {
    let host = url.host_str().ok_or("missing host")?;
    let port = url_port(url);

    if host.parse::<IpAddr>().is_ok() || host.starts_with('[') {
        return reqwest::Client::builder()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .build()
            .map_err(|e| format!("failed to build HTTP client: {e}"));
    }

    let addrs = resolve_and_validate(host, port, provider).await?;
    let mut cb = reqwest::Client::builder()
        .redirect(Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TOTAL_TIMEOUT);
    for addr in addrs {
        cb = cb.resolve(host, addr);
    }
    cb.build().map_err(|e| format!("failed to build HTTP client: {e}"))
}

fn default_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("https://api.anthropic.com"),
        "ollama" => Some("http://localhost:11434"),
        "minimax" => Some("https://api.minimaxi.com/v1"),
        _ => None,
    }
}

fn resolved_base_url(provider: &str, base_url: Option<String>) -> Result<String, String> {
    let raw = base_url
        .filter(|s| !s.trim().is_empty())
        .or_else(|| default_base_url(provider).map(str::to_string))
        .ok_or_else(|| format!("baseUrl is required for provider {provider}"))?;
    validate_llm_base_url(provider, &raw).map(|_| raw)
}

fn secret_key_for_provider(provider: &str) -> String {
    format!("llm:{provider}:api-key")
}

fn provider_needs_api_key(provider: &str) -> bool {
    provider != "ollama"
}

fn load_api_key(provider: &str, override_key: Option<String>) -> Result<Option<String>, String> {
    if let Some(k) = override_key.filter(|s| !s.is_empty()) {
        return Ok(Some(k));
    }
    if !provider_needs_api_key(provider) {
        return Ok(None);
    }
    let key = secret_get_internal(&secret_key_for_provider(provider))
        .map_err(|e| redact_err(e.to_string(), &[]))?;
    let key = key.ok_or_else(|| "no API key stored for this provider".to_string())?;
    Ok(Some(key))
}

fn join_url(base: &str, path: &str) -> Result<String, String> {
    let trimmed = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    Ok(format!("{trimmed}/{path}"))
}

fn redact_err(msg: String, secrets: &[&str]) -> String {
    let mut out = msg;
    for s in secrets {
        if !s.is_empty() {
            out = out.replace(s, "***");
            let bearer = format!("Bearer {s}");
            let bearer_lc = format!("bearer {s}");
            out = out.replace(&bearer, "***");
            out = out.replace(&bearer_lc, "***");
        }
    }
    if looks_like_credential(&out) {
        return "LLM request failed (details redacted)".to_string();
    }
    out
}

async fn read_body_limited(response: reqwest::Response, secrets: &[&str]) -> Result<Vec<u8>, String> {
    let bytes = response
        .bytes()
        .await
        .map_err(|e| redact_err(format!("read body: {e}"), secrets))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("response body exceeds size limit".into());
    }
    Ok(bytes.to_vec())
}

pub async fn llm_chat_impl(
    provider: String,
    model: String,
    base_url: Option<String>,
    messages: Vec<LlmChatMessage>,
) -> Result<LlmChatResponse, LlmError> {
    let base = resolved_base_url(&provider, base_url).map_err(LlmError::Public)?;
    let url = validate_llm_base_url(&provider, &base).map_err(LlmError::Public)?;
    let api_key = load_api_key(&provider, None).map_err(LlmError::Public)?;
    let secrets: Vec<String> = api_key.iter().map(|s| s.as_str().to_string()).collect();
    let secret_refs: Vec<&str> = secrets.iter().map(String::as_str).collect();

    let client = http_client_for_url(&url, &provider)
        .await
        .map_err(|e| LlmError::Public(redact_err(e, &secret_refs)))?;

    let content = match provider.as_str() {
        "anthropic" => {
            chat_anthropic(&client, &base, &model, &messages, api_key.as_deref().unwrap(), &secret_refs)
                .await?
        }
        "ollama" => chat_ollama(&client, &base, &model, &messages, &secret_refs).await?,
        "openai-compatible" | "minimax" => {
            chat_openai_compatible(
                &client,
                &base,
                &model,
                &messages,
                api_key.as_deref(),
                &secret_refs,
            )
            .await?
        }
        other => {
            return Err(LlmError::Public(format!("unknown provider: {other}")));
        }
    };

    Ok(LlmChatResponse { content })
}

pub async fn llm_test_connection_impl(
    provider: String,
    model: String,
    base_url: Option<String>,
    api_key: Option<String>,
) -> LlmTestConnectionResponse {
    let test_messages = vec![
        LlmChatMessage {
            role: "system".into(),
            content: "Reply with exactly the word \"ok\" and nothing else.".into(),
        },
        LlmChatMessage {
            role: "user".into(),
            content: "ping".into(),
        },
    ];

    match llm_chat_with_key(provider, model, base_url, test_messages, api_key).await {
        Ok(reply) => LlmTestConnectionResponse {
            ok: true,
            message: reply.content,
        },
        Err(e) => LlmTestConnectionResponse {
            ok: false,
            message: e.to_string(),
        },
    }
}

async fn llm_chat_with_key(
    provider: String,
    model: String,
    base_url: Option<String>,
    messages: Vec<LlmChatMessage>,
    api_key: Option<String>,
) -> Result<LlmChatResponse, LlmError> {
    let base = resolved_base_url(&provider, base_url).map_err(LlmError::Public)?;
    let url = validate_llm_base_url(&provider, &base).map_err(LlmError::Public)?;
    let api_key = load_api_key(&provider, api_key).map_err(LlmError::Public)?;
    let secrets: Vec<String> = api_key.iter().map(|s| s.as_str().to_string()).collect();
    let secret_refs: Vec<&str> = secrets.iter().map(String::as_str).collect();

    let client = http_client_for_url(&url, &provider)
        .await
        .map_err(|e| LlmError::Public(redact_err(e, &secret_refs)))?;

    let content = match provider.as_str() {
        "anthropic" => {
            chat_anthropic(&client, &base, &model, &messages, api_key.as_deref().unwrap(), &secret_refs)
                .await?
        }
        "ollama" => chat_ollama(&client, &base, &model, &messages, &secret_refs).await?,
        "openai-compatible" | "minimax" => {
            chat_openai_compatible(
                &client,
                &base,
                &model,
                &messages,
                api_key.as_deref(),
                &secret_refs,
            )
            .await?
        }
        other => {
            return Err(LlmError::Public(format!("unknown provider: {other}")));
        }
    };

    Ok(LlmChatResponse { content })
}

async fn chat_openai_compatible(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    messages: &[LlmChatMessage],
    api_key: Option<&str>,
    secrets: &[&str],
) -> Result<String, LlmError> {
    let url = join_url(base, "chat/completions").map_err(LlmError::Public)?;
    validate_llm_base_url("openai-compatible", &url).map_err(LlmError::Public)?;

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
        "max_tokens": 256,
    });

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);
    if let Some(key) = api_key {
        req = req.header("Authorization", format!("Bearer {key}"));
    }

    let response = req
        .send()
        .await
        .map_err(|e| LlmError::Public(redact_err(format!("request failed: {e}"), secrets)))?;

    let status = response.status();
    let bytes = read_body_limited(response, secrets)
        .await
        .map_err(LlmError::Public)?;

    let payload: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
        LlmError::Public(redact_err(format!("invalid JSON response: {e}"), secrets))
    })?;

    if !status.is_success() {
        let msg = payload
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("request failed");
        return Err(LlmError::Public(redact_err(msg.to_string(), secrets)));
    }

    let content = payload
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if content.is_empty() {
        return Err(LlmError::Public(
            "OpenAI-compatible response had no message content".into(),
        ));
    }
    Ok(content.to_string())
}

async fn chat_anthropic(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    messages: &[LlmChatMessage],
    api_key: &str,
    secrets: &[&str],
) -> Result<String, LlmError> {
    let url = join_url(base, "v1/messages").map_err(LlmError::Public)?;
    validate_llm_base_url("anthropic", &url).map_err(LlmError::Public)?;

    let system = messages
        .iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.as_str());
    let conversation: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect();

    if conversation.is_empty() {
        return Err(LlmError::Public(
            "Anthropic requires at least one user/assistant message.".into(),
        ));
    }

    let mut body = serde_json::json!({
        "model": model,
        "messages": conversation,
        "max_tokens": 64,
    });
    if let Some(s) = system {
        body["system"] = serde_json::Value::String(s.to_string());
    }

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| LlmError::Public(redact_err(format!("request failed: {e}"), secrets)))?;

    let status = response.status();
    let bytes = read_body_limited(response, secrets)
        .await
        .map_err(LlmError::Public)?;

    let payload: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
        LlmError::Public(redact_err(format!("invalid JSON response: {e}"), secrets))
    })?;

    if !status.is_success() {
        let msg = payload
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("request failed");
        return Err(LlmError::Public(redact_err(msg.to_string(), secrets)));
    }

    let text = payload
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    if text.is_empty() {
        return Err(LlmError::Public("Anthropic response had no text content".into()));
    }
    Ok(text)
}

async fn chat_ollama(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    messages: &[LlmChatMessage],
    secrets: &[&str],
) -> Result<String, LlmError> {
    let url = join_url(base, "api/chat").map_err(LlmError::Public)?;
    validate_llm_base_url("ollama", &url).map_err(LlmError::Public)?;

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| LlmError::Public(redact_err(format!("request failed: {e}"), secrets)))?;

    let status = response.status();
    let bytes = read_body_limited(response, secrets)
        .await
        .map_err(LlmError::Public)?;

    let payload: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
        LlmError::Public(redact_err(format!("invalid JSON response: {e}"), secrets))
    })?;

    if !status.is_success() {
        let msg = payload
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("request failed");
        return Err(LlmError::Public(redact_err(msg.to_string(), secrets)));
    }

    let content = payload
        .pointer("/message/content")
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if content.is_empty() {
        return Err(LlmError::Public("Ollama response had no message content".into()));
    }
    Ok(content.to_string())
}

#[cfg(test)]
mod ssrf_tests {
    use super::*;

    #[test]
    fn rejects_url_userinfo() {
        assert!(validate_llm_base_url(
            "openai-compatible",
            "https://user:pass@api.example.com/v1"
        )
        .is_err());
        assert!(validate_llm_base_url(
            "openai-compatible",
            "https://api.example.com/v1"
        )
        .is_ok());
    }

    #[test]
    fn rejects_http_for_non_ollama() {
        assert!(validate_llm_base_url(
            "openai-compatible",
            "http://api.example.com/v1"
        )
        .is_err());
        assert!(validate_llm_base_url(
            "anthropic",
            "http://api.anthropic.com"
        )
        .is_err());
    }

    #[test]
    fn allows_ollama_localhost_http() {
        assert!(validate_llm_base_url("ollama", "http://127.0.0.1:11434").is_ok());
        assert!(validate_llm_base_url("ollama", "http://localhost:11434").is_ok());
        assert!(validate_llm_base_url("ollama", "http://[::1]:11434").is_ok());
    }

    #[test]
    fn rejects_ollama_http_on_remote_host() {
        assert!(validate_llm_base_url("ollama", "http://10.0.0.5:11434").is_err());
    }

    #[test]
    fn rejects_private_ip_literal_in_https_url() {
        assert!(validate_llm_base_url("openai-compatible", "https://192.168.1.1/v1").is_err());
    }
}