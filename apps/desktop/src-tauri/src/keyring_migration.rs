//! Agent identity keychain migration M1 — P0-2A / A4.
//!
//! Old: `(com.kindora.app, agent.identity.p256)`
//! New: `(com.kindora.app.agent, identity.p256)`
//!
//! HD-1 = abort when old and new differ (no silent overwrite).
//! HD-2 = optional confirm before first migration (caller supplies Confirmer).
//! M2 (delete old) is **out of scope** for P0-2A.

use crate::confirmer::{ConfirmError, UserConfirmer};
use crate::keychain::{Keychain, KeychainBackendError};
use crate::secrets::{AGENT_KEY_NAME, AGENT_SERVICE, NEW_AGENT_KEY_NAME, SERVICE_GENERAL};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MigrationError {
    #[error("keychain unavailable: {0}")]
    Unknown(String),
    #[error("old and new keychain entries differ — re-authorize required")]
    Conflict,
    #[error("user declined migration confirmation")]
    Declined,
    #[error("confirm failed: {0}")]
    Confirm(String),
    #[error("migration write failed: {0}")]
    Write(String),
    #[error("migration verify failed: {0}")]
    Verify(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// No old entry; nothing to do (fresh install or already on new only).
    NothingToMigrate,
    /// Already on new service with matching content (or only new exists).
    AlreadyMigrated,
    /// Copied old → new and verified.
    Migrated,
}

/// Run M1. Never deletes the old entry. Never treats NoStorageAccess as NoEntry.
pub fn migrate_agent_key_m1<K: Keychain, C: UserConfirmer>(
    kc: &K,
    confirmer: Option<&C>,
) -> Result<MigrationOutcome, MigrationError> {
    let old = match kc.get_password(SERVICE_GENERAL, AGENT_KEY_NAME) {
        Ok(v) => Some(v),
        Err(KeychainBackendError::NoEntry) => None,
        Err(e) => return Err(MigrationError::Unknown(e.to_string())),
    };

    let new = match kc.get_password(AGENT_SERVICE, NEW_AGENT_KEY_NAME) {
        Ok(v) => Some(v),
        Err(KeychainBackendError::NoEntry) => None,
        Err(e) => return Err(MigrationError::Unknown(e.to_string())),
    };

    match (old.as_deref(), new.as_deref()) {
        (None, None) => Ok(MigrationOutcome::NothingToMigrate),
        (None, Some(_)) => Ok(MigrationOutcome::AlreadyMigrated),
        (Some(o), Some(n)) if o == n => Ok(MigrationOutcome::AlreadyMigrated),
        (Some(_), Some(_)) => Err(MigrationError::Conflict), // HD-1
        (Some(o), None) => {
            if let Some(c) = confirmer {
                // HD-2
                match c.confirm_send(
                    "Kindora will move your agent identity key to a dedicated keychain entry. Continue?",
                ) {
                    Ok(true) => {}
                    Ok(false) => return Err(MigrationError::Declined),
                    Err(ConfirmError::RateLimited) => {
                        return Err(MigrationError::Confirm("rate limited".into()));
                    }
                    Err(e) => return Err(MigrationError::Confirm(e.to_string())),
                }
            }
            kc.set_password(AGENT_SERVICE, NEW_AGENT_KEY_NAME, o)
                .map_err(|e| MigrationError::Write(e.to_string()))?;
            let read_back = kc
                .get_password(AGENT_SERVICE, NEW_AGENT_KEY_NAME)
                .map_err(|e| MigrationError::Verify(e.to_string()))?;
            if read_back != o {
                let _ = kc.delete_password(AGENT_SERVICE, NEW_AGENT_KEY_NAME);
                return Err(MigrationError::Verify("read-back mismatch".into()));
            }
            Ok(MigrationOutcome::Migrated)
        }
    }
}

/// Resolve which service/user holds the agent key after M1 preference:
/// prefer new, fall back to old (so pre-migration installs still sign).
#[allow(dead_code)]
pub fn resolve_agent_key_location<K: Keychain>(
    kc: &K,
) -> Result<(String, String), KeychainBackendError> {
    match kc.get_password(AGENT_SERVICE, NEW_AGENT_KEY_NAME) {
        Ok(_) => Ok((AGENT_SERVICE.to_string(), NEW_AGENT_KEY_NAME.to_string())),
        Err(KeychainBackendError::NoEntry) => {
            match kc.get_password(SERVICE_GENERAL, AGENT_KEY_NAME) {
                Ok(_) => Ok((SERVICE_GENERAL.to_string(), AGENT_KEY_NAME.to_string())),
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::confirmer::MockConfirmer;
    use crate::keychain::MemoryKeychain;

    #[test]
    fn migrates_old_to_new_when_confirmed() {
        let kc = MemoryKeychain::new();
        kc.set_password(SERVICE_GENERAL, AGENT_KEY_NAME, "pkcs8-old")
            .unwrap();
        let c = MockConfirmer { always: true };
        let out = migrate_agent_key_m1(&kc, Some(&c)).unwrap();
        assert_eq!(out, MigrationOutcome::Migrated);
        assert_eq!(
            kc.get_password(AGENT_SERVICE, NEW_AGENT_KEY_NAME).unwrap(),
            "pkcs8-old"
        );
        // Old still present (M2 deferred).
        assert_eq!(
            kc.get_password(SERVICE_GENERAL, AGENT_KEY_NAME).unwrap(),
            "pkcs8-old"
        );
    }

    #[test]
    fn conflict_when_old_and_new_differ() {
        let kc = MemoryKeychain::new();
        kc.set_password(SERVICE_GENERAL, AGENT_KEY_NAME, "old")
            .unwrap();
        kc.set_password(AGENT_SERVICE, NEW_AGENT_KEY_NAME, "new")
            .unwrap();
        let err = migrate_agent_key_m1::<_, MockConfirmer>(&kc, None).unwrap_err();
        assert_eq!(err, MigrationError::Conflict);
    }

    #[test]
    fn declines_when_user_says_no() {
        let kc = MemoryKeychain::new();
        kc.set_password(SERVICE_GENERAL, AGENT_KEY_NAME, "pkcs8")
            .unwrap();
        let c = MockConfirmer { always: false };
        let err = migrate_agent_key_m1(&kc, Some(&c)).unwrap_err();
        assert_eq!(err, MigrationError::Declined);
    }
}
