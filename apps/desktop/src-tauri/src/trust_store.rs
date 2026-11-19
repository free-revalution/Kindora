//! Peer trust levels and optional persistence — P0-2A / A6 (IBR-8).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    Untrusted,
    /// PoK only (`hello` seen); out-of-band fingerprint not confirmed.
    Provisional,
    Verified,
    Pinned,
    /// Known key rotation — must re-confirm before `Verified`.
    Changed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerTrustRecord {
    pub agent_id: String,
    pub fingerprint: String,
    pub level: TrustLevel,
    pub first_seen_unix_ms: u64,
    pub last_seen_unix_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum TrustStoreError {
    #[error("peer-not-found")]
    PeerNotFound,
    #[error("fingerprint-mismatch")]
    FingerprintMismatch,
    #[error("silent-retrust-forbidden")]
    SilentRetrustForbidden,
    #[error("io: {0}")]
    Io(String),
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// In-memory trust table with optional JSON file under app data (stub).
#[derive(Debug, Clone, Default)]
pub struct TrustStore {
    by_agent: HashMap<String, PeerTrustRecord>,
    file_path: Option<PathBuf>,
}

impl TrustStore {
    pub fn in_memory() -> Self {
        Self::default()
    }

    pub fn with_app_data_file(base: &Path) -> Self {
        Self {
            by_agent: HashMap::new(),
            file_path: Some(base.join("trust_store.json")),
        }
    }

    pub fn get(&self, agent_id: &str, fingerprint: &str) -> Option<TrustLevel> {
        self.by_agent.get(agent_id).and_then(|r| {
            if crate::fingerprint::fingerprints_match(&r.fingerprint, fingerprint) {
                Some(r.level)
            } else if matches!(r.level, TrustLevel::Verified | TrustLevel::Pinned) {
                Some(TrustLevel::Changed)
            } else {
                None
            }
        })
    }

    /// Set trust for `(agent_id, fingerprint)`. Refuses silent `Changed → Verified`.
    pub fn set(
        &mut self,
        agent_id: &str,
        fingerprint: &str,
        level: TrustLevel,
    ) -> Result<(), TrustStoreError> {
        if level == TrustLevel::Verified {
            if let Some(existing) = self.by_agent.get(agent_id) {
                if existing.level == TrustLevel::Changed {
                    return Err(TrustStoreError::SilentRetrustForbidden);
                }
            }
        }

        let ts = now_ms();
        match self.by_agent.get(agent_id) {
            None => {
                self.by_agent.insert(
                    agent_id.to_string(),
                    PeerTrustRecord {
                        agent_id: agent_id.to_string(),
                        fingerprint: fingerprint.to_string(),
                        level,
                        first_seen_unix_ms: ts,
                        last_seen_unix_ms: ts,
                    },
                );
            }
            Some(existing) => {
                let fp_matches =
                    crate::fingerprint::fingerprints_match(&existing.fingerprint, fingerprint);
                let mut next_level = level;
                if !fp_matches
                    && matches!(
                        existing.level,
                        TrustLevel::Verified | TrustLevel::Pinned | TrustLevel::Changed
                    )
                {
                    next_level = TrustLevel::Changed;
                }
                let updated = PeerTrustRecord {
                    agent_id: agent_id.to_string(),
                    fingerprint: fingerprint.to_string(),
                    level: next_level,
                    first_seen_unix_ms: existing.first_seen_unix_ms,
                    last_seen_unix_ms: ts,
                };
                self.by_agent.insert(agent_id.to_string(), updated);
                if level == TrustLevel::Verified && next_level == TrustLevel::Changed {
                    let _ = self.save();
                    return Err(TrustStoreError::SilentRetrustForbidden);
                }
            }
        }
        let _ = self.save();
        Ok(())
    }

    /// After user re-confirms a rotated key out-of-band.
    pub fn confirm_after_key_change(
        &mut self,
        agent_id: &str,
        fingerprint: &str,
    ) -> Result<(), TrustStoreError> {
        let Some(existing) = self.by_agent.get(agent_id) else {
            return Err(TrustStoreError::PeerNotFound);
        };
        if existing.level != TrustLevel::Changed {
            return Err(TrustStoreError::FingerprintMismatch);
        }
        let ts = now_ms();
        self.by_agent.insert(
            agent_id.to_string(),
            PeerTrustRecord {
                agent_id: agent_id.to_string(),
                fingerprint: fingerprint.to_string(),
                level: TrustLevel::Verified,
                first_seen_unix_ms: existing.first_seen_unix_ms,
                last_seen_unix_ms: ts,
            },
        );
        let _ = self.save();
        Ok(())
    }

    pub fn load(&mut self) -> Result<(), TrustStoreError> {
        let Some(path) = self.file_path.as_ref() else {
            return Ok(());
        };
        let Ok(raw) = std::fs::read_to_string(path) else {
            return Ok(());
        };
        let records: Vec<PeerTrustRecord> =
            serde_json::from_str(&raw).map_err(|e| TrustStoreError::Io(e.to_string()))?;
        self.by_agent.clear();
        for r in records {
            self.by_agent.insert(r.agent_id.clone(), r);
        }
        Ok(())
    }

    pub fn save(&self) -> Result<(), TrustStoreError> {
        let Some(path) = self.file_path.as_ref() else {
            return Ok(());
        };
        let records: Vec<&PeerTrustRecord> = self.by_agent.values().collect();
        let json =
            serde_json::to_string_pretty(&records).map_err(|e| TrustStoreError::Io(e.to_string()))?;
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(path, json).map_err(|e| TrustStoreError::Io(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_to_verified_requires_explicit_confirm() {
        let mut store = TrustStore::in_memory();
        store
            .set("peer-1", "AAAAAA", TrustLevel::Verified)
            .unwrap();
        store
            .set("peer-1", "BBBBBB", TrustLevel::Verified)
            .unwrap_err();
        assert_eq!(
            store.get("peer-1", "BBBBBB"),
            Some(TrustLevel::Changed)
        );
        assert!(matches!(
            store.set("peer-1", "BBBBBB", TrustLevel::Verified),
            Err(TrustStoreError::SilentRetrustForbidden)
        ));
        store.confirm_after_key_change("peer-1", "BBBBBB").unwrap();
        assert_eq!(store.get("peer-1", "BBBBBB"), Some(TrustLevel::Verified));
    }
}