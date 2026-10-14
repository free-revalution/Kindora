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

use serde::{Deserialize, Serialize};

const SERVICE: &str = "com.kindora.app";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keyring error: {0}")]
    Keyring(String),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetArgs {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetArgs {
    pub key: String,
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
    let entry = keyring::Entry::new(SERVICE, &key)
        .map_err(|e| SecretError::Keyring(format!("{e}")))?;
    entry
        .set_password(&value)
        .map_err(|e| SecretError::Keyring(format!("{e}")))?;
    Ok(())
}

pub fn secret_get(key: String) -> Result<Option<String>, SecretError> {
    validate_key(&key)?;
    let entry = keyring::Entry::new(SERVICE, &key)
        .map_err(|e| SecretError::Keyring(format!("{e}")))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(SecretError::Keyring(format!("{e}"))),
    }
}

pub fn secret_delete(key: String) -> Result<(), SecretError> {
    validate_key(&key)?;
    let entry = keyring::Entry::new(SERVICE, &key)
        .map_err(|e| SecretError::Keyring(format!("{e}")))?;
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
