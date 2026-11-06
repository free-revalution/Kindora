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

const SERVICE: &str = "com.kindora.app";

/// The keychain entry that holds the agent's long-term private key.
///
/// Phase A / A1. The key is the base64 PKCS#8 form of the ECDSA P-256
/// private key; it is stored **only** here, never in localStorage.
///
/// The name must satisfy `validate_key` (ASCII alphanumeric plus
/// `: - _ .`).
pub const AGENT_KEY_NAME: &str = "agent.identity.p256";

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

fn validate_key(key: &str) -> Result<(), SecretError> {
    if key.is_empty() {
        return Err(SecretError::InvalidKey("empty key".into()));
    }
    if key.len() > 256 {
        return Err(SecretError::InvalidKey("key too long".into()));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ':' || c == '-' || c == '_' || c == '.')
    {
        return Err(SecretError::InvalidKey(
            "key must be ASCII alphanumeric / : - _ .".into(),
        ));
    }
    Ok(())
}

pub fn secret_set(key: String, value: String) -> Result<(), SecretError> {
    validate_key(&key)?;
    let entry =
        keyring::Entry::new(SERVICE, &key).map_err(|e| SecretError::Keyring(format!("{e}")))?;
    entry
        .set_password(&value)
        .map_err(|e| SecretError::Keyring(format!("{e}")))?;
    Ok(())
}

pub fn secret_get(key: String) -> Result<Option<String>, SecretError> {
    validate_key(&key)?;
    let entry =
        keyring::Entry::new(SERVICE, &key).map_err(|e| SecretError::Keyring(format!("{e}")))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(SecretError::Keyring(format!("{e}"))),
    }
}

pub fn secret_delete(key: String) -> Result<(), SecretError> {
    validate_key(&key)?;
    let entry =
        keyring::Entry::new(SERVICE, &key).map_err(|e| SecretError::Keyring(format!("{e}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SecretError::Keyring(format!("{e}"))),
    }
}

pub fn secret_list() -> Result<Vec<String>, SecretError> {
    // keyring crate 3.x does not expose a portable list API. We return an empty
    // vec and let the UI iterate via its known keyspace. Documented limitation.
    Ok(vec![])
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

/// Store the agent's private key in the OS keychain.
pub fn agent_key_store(value: String) -> Result<(), AgentKeyError> {
    if !is_base64_shaped(&value) {
        return Err(AgentKeyError::InvalidKey(
            "value must be a non-empty base64 string".into(),
        ));
    }
    let entry =
        keyring::Entry::new(SERVICE, AGENT_KEY_NAME).map_err(|e| classify_keyring_error(&e))?;
    entry
        .set_password(&value)
        .map_err(|e| classify_keyring_error(&e))?;
    Ok(())
}

/// Read the agent's private key back out of the OS keychain.
///
/// Returns `Ok(None)` when no entry exists (a fresh device).
pub fn agent_key_get() -> Result<Option<String>, AgentKeyError> {
    let entry =
        keyring::Entry::new(SERVICE, AGENT_KEY_NAME).map_err(|e| classify_keyring_error(&e))?;
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

/// Remove the agent's private key from the OS keychain.
///
/// Deleting a key that is not there is a no-op, not an error.
pub fn agent_key_delete() -> Result<(), AgentKeyError> {
    let entry =
        keyring::Entry::new(SERVICE, AGENT_KEY_NAME).map_err(|e| classify_keyring_error(&e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(classify_keyring_error(&e)),
    }
}
