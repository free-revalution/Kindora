//! Injectable keychain backend — P0-2A / A3.
//!
//! Production uses the OS `keyring` crate. Tests inject `MemoryKeychain`
//! (and fault-injecting wrappers) so migration / secret paths can be
//! exercised without touching the login keychain.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Errors from a keychain backend. Mapped to `SecretError` / `AgentKeyError`
/// at the command boundary.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum KeychainBackendError {
    #[error("no entry")]
    NoEntry,
    #[error("no storage access: {0}")]
    NoStorageAccess(String),
    #[error("platform failure: {0}")]
    Platform(String),
}

pub trait Keychain: Send + Sync {
    fn get_password(&self, service: &str, user: &str) -> Result<String, KeychainBackendError>;
    fn set_password(
        &self,
        service: &str,
        user: &str,
        password: &str,
    ) -> Result<(), KeychainBackendError>;
    fn delete_password(&self, service: &str, user: &str) -> Result<(), KeychainBackendError>;
    /// True when an entry exists. Distinguishes NoEntry from other errors.
    fn exists(&self, service: &str, user: &str) -> Result<bool, KeychainBackendError> {
        match self.get_password(service, user) {
            Ok(_) => Ok(true),
            Err(KeychainBackendError::NoEntry) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

/// OS keychain via `keyring 3.x`.
#[derive(Debug, Default, Clone)]
pub struct OsKeychain;

impl Keychain for OsKeychain {
    fn get_password(&self, service: &str, user: &str) -> Result<String, KeychainBackendError> {
        let entry = keyring::Entry::new(service, user)
            .map_err(|e| KeychainBackendError::Platform(e.to_string()))?;
        match entry.get_password() {
            Ok(v) => Ok(v),
            Err(keyring::Error::NoEntry) => Err(KeychainBackendError::NoEntry),
            Err(e) => Err(map_keyring_err(e)),
        }
    }

    fn set_password(
        &self,
        service: &str,
        user: &str,
        password: &str,
    ) -> Result<(), KeychainBackendError> {
        let entry = keyring::Entry::new(service, user)
            .map_err(|e| KeychainBackendError::Platform(e.to_string()))?;
        entry
            .set_password(password)
            .map_err(map_keyring_err)
    }

    fn delete_password(&self, service: &str, user: &str) -> Result<(), KeychainBackendError> {
        let entry = keyring::Entry::new(service, user)
            .map_err(|e| KeychainBackendError::Platform(e.to_string()))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_keyring_err(e)),
        }
    }
}

fn map_keyring_err(err: keyring::Error) -> KeychainBackendError {
    let text = err.to_string();
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("no storage access")
        || lowered.contains("is locked")
        || lowered.contains("interaction is not allowed")
    {
        return KeychainBackendError::NoStorageAccess(text);
    }
    KeychainBackendError::Platform(text)
}

/// In-memory keychain for tests.
#[derive(Debug, Default, Clone)]
pub struct MemoryKeychain {
    inner: Arc<Mutex<HashMap<(String, String), String>>>,
}

impl MemoryKeychain {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Keychain for MemoryKeychain {
    fn get_password(&self, service: &str, user: &str) -> Result<String, KeychainBackendError> {
        let map = self.inner.lock().expect("memory keychain lock");
        map.get(&(service.to_string(), user.to_string()))
            .cloned()
            .ok_or(KeychainBackendError::NoEntry)
    }

    fn set_password(
        &self,
        service: &str,
        user: &str,
        password: &str,
    ) -> Result<(), KeychainBackendError> {
        let mut map = self.inner.lock().expect("memory keychain lock");
        map.insert((service.to_string(), user.to_string()), password.to_string());
        Ok(())
    }

    fn delete_password(&self, service: &str, user: &str) -> Result<(), KeychainBackendError> {
        let mut map = self.inner.lock().expect("memory keychain lock");
        map.remove(&(service.to_string(), user.to_string()));
        Ok(())
    }
}

/// Fault-injecting wrapper for migration tests (§4.5.5).
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainFault {
    None,
    FailGet,
    FailSet,
    FailDelete,
    NoStorageAccess,
}

#[allow(dead_code)]
#[derive(Clone)]
pub struct FaultyKeychain<K: Keychain> {
    pub inner: Arc<K>,
    pub fault: Arc<Mutex<KeychainFault>>,
}

impl<K: Keychain> FaultyKeychain<K> {
    pub fn new(inner: K) -> Self {
        Self {
            inner: Arc::new(inner),
            fault: Arc::new(Mutex::new(KeychainFault::None)),
        }
    }

    pub fn set_fault(&self, fault: KeychainFault) {
        *self.fault.lock().expect("fault lock") = fault;
    }
}

impl<K: Keychain> Keychain for FaultyKeychain<K> {
    fn get_password(&self, service: &str, user: &str) -> Result<String, KeychainBackendError> {
        match *self.fault.lock().expect("fault lock") {
            KeychainFault::FailGet => Err(KeychainBackendError::Platform("injected get fail".into())),
            KeychainFault::NoStorageAccess => {
                Err(KeychainBackendError::NoStorageAccess("injected locked".into()))
            }
            _ => self.inner.get_password(service, user),
        }
    }

    fn set_password(
        &self,
        service: &str,
        user: &str,
        password: &str,
    ) -> Result<(), KeychainBackendError> {
        match *self.fault.lock().expect("fault lock") {
            KeychainFault::FailSet => Err(KeychainBackendError::Platform("injected set fail".into())),
            KeychainFault::NoStorageAccess => {
                Err(KeychainBackendError::NoStorageAccess("injected locked".into()))
            }
            _ => self.inner.set_password(service, user, password),
        }
    }

    fn delete_password(&self, service: &str, user: &str) -> Result<(), KeychainBackendError> {
        match *self.fault.lock().expect("fault lock") {
            KeychainFault::FailDelete => {
                Err(KeychainBackendError::Platform("injected delete fail".into()))
            }
            _ => self.inner.delete_password(service, user),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_round_trip() {
        let kc = MemoryKeychain::new();
        kc.set_password("svc", "user", "secret").unwrap();
        assert_eq!(kc.get_password("svc", "user").unwrap(), "secret");
        assert!(kc.exists("svc", "user").unwrap());
        kc.delete_password("svc", "user").unwrap();
        assert!(!kc.exists("svc", "user").unwrap());
    }
}
