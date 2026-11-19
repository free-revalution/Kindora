// Secret store — thin Tauri command surface over the `keyring` crate.
//
// V0.1 keys we care about:
//   - `llm:<provider>:api-key` (matches the browser SecretStore keys)
//
// On macOS the entries land in the user's login keychain under
// service = "com.kindora.app". On Windows they go to the Credential
// Manager. On Linux they go to the Secret Service (libsecret).
//
// V0.1 limitation: there is no ACL or biometric prompt. Any process
// running as the current user can read the entry. This is the same
// trust model as 1Password's "Unlock with password" tier.

/// LLM / general secrets service. **Must stay** `com.kindora.app` (HC-1).
pub const SERVICE_GENERAL: &str = "com.kindora.app";

/// Agent identity key service after M1 (P0-2A / A4).
pub const AGENT_SERVICE: &str = "com.kindora.app.agent";

/// Legacy agent key user name under `SERVICE_GENERAL` (pre-M1).
pub const AGENT_KEY_NAME: &str = "agent.identity.p256";

/// Post-M1 agent key user name under `AGENT_SERVICE`.
pub const NEW_AGENT_KEY_NAME: &str = "identity.p256";

/// Exact allow-list for LLM API keys (P0-2A / A5 / §4.2.3).
pub const ALLOWED_SECRET_KEYS: &[&str] = &[
    "llm:openai-compatible:api-key",
    "llm:anthropic:api-key",
    "llm:ollama:api-key",
    "llm:minimax:api-key",
];

/// Resolve a secret key against the allow-list. Shared by set/exists/delete.
pub fn resolve_secret_key(key: &str) -> Result<&'static str, SecretError> {
    if key.is_empty() {
        return Err(SecretError::InvalidKey("empty key".into()));
    }
    if key.len() > 256 {
        return Err(SecretError::InvalidKey("key too long".into()));
    }
    // Reject percent-encoding / case variants — exact match only.
    for &allowed in ALLOWED_SECRET_KEYS {
        if key == allowed {
            return Ok(allowed);
        }
    }
    Err(SecretError::InvalidKey(format!(
        "key not in allow-list: {key}"
    )))
}

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keyring error: {0}")]
    Keyring(String),
    /// No entry exists for the key.
    ///
    /// Phase A: the frontend reads "no key" as `null` (see
    /// `secret_get`, which returns `Ok(None)`), so this variant is
    /// part of the published error taxonomy rather than a path the
    /// current commands take. It is exported from the crate root so
    /// the taxonomy stays symmetric with the TypeScript
    /// `AgentKeyErrorKind` union.
    #[error("not found")]
    NotFound,
    #[error("invalid key: {0}")]
    InvalidKey(String),
}

impl serde::Serialize for SecretError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub fn secret_set(key: String, value: String) -> Result<(), SecretError> {
    let key = resolve_secret_key(&key)?;
    let entry = keyring::Entry::new(SERVICE_GENERAL, key)
        .map_err(|e| SecretError::Keyring(format!("{e}")))?;
    entry
        .set_password(&value)
        .map_err(|e| SecretError::Keyring(format!("{e}")))?;
    Ok(())
}

/// Internal read for Rust-side LLM (A-LLM). **Not** registered as a
/// WebView command after MB-1 — see `secret_exists` for the UI path.
pub fn secret_get_internal(key: &str) -> Result<Option<String>, SecretError> {
    let key = resolve_secret_key(key)?;
    let entry = keyring::Entry::new(SERVICE_GENERAL, key)
        .map_err(|e| SecretError::Keyring(format!("{e}")))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(SecretError::Keyring(format!("{e}"))),
    }
}


pub fn secret_delete(key: String) -> Result<(), SecretError> {
    let key = resolve_secret_key(&key)?;
    let entry = keyring::Entry::new(SERVICE_GENERAL, key)
        .map_err(|e| SecretError::Keyring(format!("{e}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SecretError::Keyring(format!("{e}"))),
    }
}

/// Existence only — never returns the secret value (A5 / F3).
pub fn secret_exists(key: String) -> Result<bool, SecretError> {
    let key = resolve_secret_key(&key)?;
    let entry = keyring::Entry::new(SERVICE_GENERAL, key)
        .map_err(|e| SecretError::Keyring(format!("{e}")))?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(SecretError::Keyring(format!("{e}"))),
    }
}

#[cfg(test)]
mod secret_whitelist_tests {
    use super::*;

    #[test]
    fn allow_list_accepts_exact_keys() {
        for k in ALLOWED_SECRET_KEYS {
            assert!(resolve_secret_key(k).is_ok());
        }
    }

    #[test]
    fn allow_list_rejects_case_and_unknown() {
        assert!(resolve_secret_key("LLM:openai-compatible:api-key").is_err());
        assert!(resolve_secret_key("llm:openai-compatible:api-key%00").is_err());
        assert!(resolve_secret_key("agent.identity.p256").is_err());
        assert!(resolve_secret_key("").is_err());
    }
}

/* ------------------------------------------------------------------ */
/* Agent identity key — Phase A / A1                                    */
/* ------------------------------------------------------------------ */

/// Errors from the agent-key surface.
///
/// Unlike `SecretError` (which serialises to a plain string, for
/// backwards compatibility with the `secret_*` commands), this type
/// serialises to `{ kind, message }` so the frontend can branch on a
/// stable machine-readable kind instead of parsing English text.
#[derive(Debug, thiserror::Error)]
pub enum AgentKeyError {
    /// The OS keychain is locked and needs to be unlocked by the user.
    #[error("the OS keychain is locked: {0}")]
    KeychainLocked(String),
    /// The OS keychain refused access to this item.
    #[error("the OS keychain denied access: {0}")]
    KeychainDenied(String),
    /// No keychain backend is reachable (e.g. no Secret Service on Linux).
    #[error("the OS keychain is not available: {0}")]
    KeychainUnavailable(String),
    /// No agent key is stored.
    ///
    /// Phase A: the frontend reads "no key yet" as `null` (see
    /// `agent_key_get`, which returns `Ok(None)`), so this kind is
    /// part of the published error taxonomy rather than a path the
    /// current commands take. It is exported from the crate root so
    /// the taxonomy stays symmetric with the TypeScript
    /// `AgentKeyErrorKind` union.
    #[error("no agent key is stored in the OS keychain")]
    NotFound,
    /// The stored value is not a usable key.
    #[error("the stored agent key is corrupt: {0}")]
    Corrupt(String),
    /// The supplied value is not acceptable.
    #[error("invalid agent key: {0}")]
    InvalidKey(String),
    /// Anything else the keyring backend reported.
    #[error("keyring error: {0}")]
    Keyring(String),
}

impl AgentKeyError {
    /// Stable, machine-readable kind.
    pub fn kind(&self) -> &'static str {
        match self {
            AgentKeyError::KeychainLocked(_) => "keychain_locked",
            AgentKeyError::KeychainDenied(_) => "keychain_denied",
            AgentKeyError::KeychainUnavailable(_) => "keychain_unavailable",
            AgentKeyError::NotFound => "not_found",
            AgentKeyError::Corrupt(_) => "corrupt",
            AgentKeyError::InvalidKey(_) => "invalid_key",
            AgentKeyError::Keyring(_) => "keyring",
        }
    }
}

impl serde::Serialize for AgentKeyError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AgentKeyError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

/// Classify a `keyring` error into an `AgentKeyError`.
///
/// `keyring` 3.x does not expose typed variants for "locked" / "denied"
/// / "unavailable" that are stable across the macOS, Windows and Linux
/// backends — the underlying cause is a boxed platform error whose text
/// differs per platform. We therefore classify on the rendered
/// message, which is the only cross-platform signal available. This is
/// best-effort by design and documented as such; the fallback is the
/// generic `Keyring` kind, which never loses information.
fn classify_keyring_error(err: &keyring::Error) -> AgentKeyError {
    let text = err.to_string();
    let lowered = text.to_ascii_lowercase();

    // macOS `errSecInteractionNotAllowed` → "User interaction is not allowed."
    if lowered.contains("interaction is not allowed")
        || lowered.contains("interactionnotallowed")
        || lowered.contains("is locked")
    {
        return AgentKeyError::KeychainLocked(text);
    }

    // macOS `errSecAuthFailed` / `errSecNoAccessForItem`, Windows `ERROR_ACCESS_DENIED`.
    if lowered.contains("denied")
        || lowered.contains("not permitted")
        || lowered.contains("not authorized")
        || lowered.contains("no access for")
        || lowered.contains("auth failed")
        || lowered.contains("not trusted")
    {
        return AgentKeyError::KeychainDenied(text);
    }

    // Linux: no D-Bus Secret Service reachable.
    if lowered.contains("no storage access")
        || lowered.contains("not available")
        || lowered.contains("no such interface")
        || lowered.contains("secret service")
        || lowered.contains("dbus")
    {
        return AgentKeyError::KeychainUnavailable(text);
    }

    AgentKeyError::Keyring(text)
}

/// True when `value` looks like a base64 string.
///
/// We deliberately do not decode here: the `base64` crate is only a
/// transitive dependency of this workspace, and pulling it in as a
/// direct dependency would require a registry fetch. Shape validation
/// is enough to catch a truncated or wrong-format entry; the frontend
/// still does the authoritative parse.
fn is_base64_shaped(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

/// Store the agent's private key — writes the **new** M1 location.
pub fn agent_key_store(value: String) -> Result<(), AgentKeyError> {
    if !is_base64_shaped(&value) {
        return Err(AgentKeyError::InvalidKey(
            "value must be a non-empty base64 string".into(),
        ));
    }
    let entry = keyring::Entry::new(AGENT_SERVICE, NEW_AGENT_KEY_NAME)
        .map_err(|e| classify_keyring_error(&e))?;
    entry
        .set_password(&value)
        .map_err(|e| classify_keyring_error(&e))?;
    Ok(())
}

/// Read the agent's private key (prefer new service, fall back to legacy).
///
/// **Internal / transitional** — must not be exposed to WebView after MB-1.
pub fn agent_key_get() -> Result<Option<String>, AgentKeyError> {
    // Prefer post-M1 location.
    let new_entry = keyring::Entry::new(AGENT_SERVICE, NEW_AGENT_KEY_NAME)
        .map_err(|e| classify_keyring_error(&e))?;
    match new_entry.get_password() {
        Ok(value) => {
            if !is_base64_shaped(&value) {
                return Err(AgentKeyError::Corrupt(
                    "stored value is not a base64 string".into(),
                ));
            }
            return Ok(Some(value));
        }
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(classify_keyring_error(&e)),
    }
    // Legacy pre-M1 location.
    let entry = keyring::Entry::new(SERVICE_GENERAL, AGENT_KEY_NAME)
        .map_err(|e| classify_keyring_error(&e))?;
    match entry.get_password() {
        Ok(value) => {
            if !is_base64_shaped(&value) {
                return Err(AgentKeyError::Corrupt(
                    "stored value is not a base64 string".into(),
                ));
            }
            Ok(Some(value))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(classify_keyring_error(&e)),
    }
}

/// True when an agent key is present in the OS keychain.
pub fn agent_key_exists() -> Result<bool, AgentKeyError> {
    Ok(agent_key_get()?.is_some())
}

/// Remove the agent's private key from **both** locations.
pub fn agent_key_delete() -> Result<(), AgentKeyError> {
    for (svc, name) in [
        (AGENT_SERVICE, NEW_AGENT_KEY_NAME),
        (SERVICE_GENERAL, AGENT_KEY_NAME),
    ] {
        let entry = keyring::Entry::new(svc, name).map_err(|e| classify_keyring_error(&e))?;
        match entry.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(classify_keyring_error(&e)),
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Native signing — P0-2A (internal only; D4 removes WebView agent_sign) */
/* ------------------------------------------------------------------ */

/// Fixed probe for `agent_key_matches_public_key` — never exposed as a
/// general signing API (D4: no arbitrary-byte WebView signer).
const KEY_MATCH_PROBE: &[u8] = b"kindora:key-match-probe:v1";

/// Confirm the OS-keychain private key matches `public_key_spki_b64`.
///
/// Signs a Rust-fixed probe and verifies with the provided SPKI. The
/// WebView never chooses the signed bytes (P0-2A D4).
pub fn agent_key_matches_public_key(public_key_spki_b64: String) -> Result<bool, AgentKeyError> {
    use base64::Engine;
    use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
    use p256::pkcs8::DecodePublicKey;

    let spki = decode_standard_b64(&public_key_spki_b64).map_err(|e| {
        AgentKeyError::InvalidKey(format!("public key is not valid base64: {e}"))
    })?;
    let verifying_key = VerifyingKey::from_public_key_der(&spki).map_err(|e| {
        AgentKeyError::InvalidKey(format!("public key is not a SPKI P-256 key: {e}"))
    })?;

    let message_b64 =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(KEY_MATCH_PROBE);
    let sig_b64 = agent_sign(message_b64)?;
    let sig_raw = decode_b64url(&sig_b64).map_err(|e| {
        AgentKeyError::Corrupt(format!("signature decode failed: {e}"))
    })?;
    let signature = Signature::from_slice(&sig_raw).map_err(|e| {
        AgentKeyError::Corrupt(format!("signature is not raw P-1363: {e}"))
    })?;
    Ok(verifying_key.verify(KEY_MATCH_PROBE, &signature).is_ok())
}

/// Sign canonical bytes with the OS-keychain private key (**internal**).
///
/// Not registered on the WebView command surface (D4). Used by
/// `agent_sign_envelope` and `agent_key_matches_public_key` only.
///
/// Returns **unpadded base64url** of the raw P-1363 `r ‖ s` (64 bytes).
pub fn agent_sign(message_b64url: String) -> Result<String, AgentKeyError> {
    use base64::Engine;
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};
    use p256::pkcs8::DecodePrivateKey;

    let pkcs8_b64 = agent_key_get()?.ok_or(AgentKeyError::NotFound)?;
    let pkcs8 = decode_standard_b64(&pkcs8_b64).map_err(|e| {
        AgentKeyError::Corrupt(format!("private key is not valid base64: {e}"))
    })?;
    let signing_key = SigningKey::from_pkcs8_der(&pkcs8).map_err(|e| {
        AgentKeyError::Corrupt(format!("private key is not a PKCS#8 P-256 key: {e}"))
    })?;

    let message = decode_b64url(&message_b64url).map_err(|e| {
        AgentKeyError::InvalidKey(format!("message must be unpadded base64url: {e}"))
    })?;
    if message.is_empty() {
        return Err(AgentKeyError::InvalidKey("message must not be empty".into()));
    }
    if message.len() > 65_536 {
        return Err(AgentKeyError::InvalidKey(
            "message exceeds 64 KiB signing limit".into(),
        ));
    }

    // `Signer::sign` on p256's SigningKey applies SHA-256 then ECDSA —
    // the same composition WebCrypto uses for `{ name: 'ECDSA', hash: 'SHA-256' }`.
    let signature: Signature = signing_key.sign(&message);
    let raw = signature.to_bytes();
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw))
}

fn decode_standard_b64(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    // PKCS#8 keys are stored as standard (padded) base64 from WebCrypto export.
    base64::engine::general_purpose::STANDARD.decode(text.trim())
}

fn decode_b64url(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    let trimmed = text.trim();
    // Accept both unpadded and padded URL-safe forms.
    match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(trimmed) {
        Ok(bytes) => Ok(bytes),
        Err(_) => base64::engine::general_purpose::URL_SAFE.decode(trimmed),
    }
}

#[cfg(test)]
mod agent_sign_tests {
    use super::*;
    use base64::Engine;
    use p256::ecdsa::{signature::Signer, signature::Verifier, Signature, SigningKey};

    #[test]
    fn decode_b64url_accepts_unpadded() {
        let raw = decode_b64url("aGVsbG8").expect("hello");
        assert_eq!(raw, b"hello");
    }

    #[test]
    fn sign_random_key_produces_verifiable_p1363() {
        let key = SigningKey::random(&mut rand_core::OsRng);
        let message = b"kindora-agent-sign-test";
        let message_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(message);
        let msg = decode_b64url(&message_b64).expect("decode msg");
        let signature: Signature = key.sign(&msg);
        assert_eq!(signature.to_bytes().len(), 64);
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes());
        let raw_back = decode_b64url(&encoded).expect("decode sig");
        assert_eq!(raw_back.len(), 64);
        key.verifying_key()
            .verify(message, &signature)
            .expect("self-verify");
    }
}
