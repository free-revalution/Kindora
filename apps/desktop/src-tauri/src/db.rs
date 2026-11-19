//! Rust-owned SQLite access — P0-2B / B1 (skeleton).
//!
//! Opens the same path as legacy `tauri-plugin-sql` (`app_config_dir()/kindora.db`).
//! Full `db_*` command surface lands in B2; this module proves open policy +
//! schema-version read without removing the plugin yet (B6).

use crate::db_path::{
    candidate_db_paths, canonical_db_path, classify_database_file, DatabaseFileKind,
};
use std::path::{Path, PathBuf};

/// Must stay in lockstep with `packages/storage` `SCHEMA_VERSION`.
pub const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("not-a-kindora-database")]
    NotAKindoraDatabase,
    #[error("legacy-database-unreadable")]
    LegacyUnreadable,
    #[error("schema-too-new")]
    SchemaTooNew,
    #[error("io: {0}")]
    #[allow(dead_code)]
    Io(String),
    #[error("sql: {0}")]
    Sql(String),
}

impl serde::Serialize for DbError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbResolveResult {
    pub canonical: String,
    pub kind: String,
    pub policy: String,
    pub candidates: Vec<String>,
}

/// Resolve which database file the Rust layer would open (B0/B1).
pub fn resolve_db_layout(config_dir: &Path, data_dir: &Path) -> Result<DbResolveResult, DbError> {
    let probe = FsProbe;
    let canonical = canonical_db_path(config_dir);
    let kind = classify_database_file(&probe, &canonical);
    let candidates: Vec<(PathBuf, DatabaseFileKind)> = candidate_db_paths(config_dir, data_dir)
        .into_iter()
        .map(|p| {
            let k = classify_database_file(&probe, &p);
            (p, k)
        })
        .collect();
    let policy = open_policy(kind, &candidates)?;
    Ok(DbResolveResult {
        canonical: canonical.display().to_string(),
        kind: kind_label(kind).into(),
        policy: policy_label(policy).into(),
        candidates: candidates
            .into_iter()
            .map(|(p, _)| p.display().to_string())
            .collect(),
    })
}

fn kind_label(k: DatabaseFileKind) -> &'static str {
    match k {
        DatabaseFileKind::Kindora => "kindora",
        DatabaseFileKind::NotKindora => "not-a-kindora-database",
        DatabaseFileKind::Missing => "missing",
        DatabaseFileKind::Unreadable => "unreadable",
    }
}

fn policy_label(p: OpenPolicy) -> &'static str {
    match p {
        OpenPolicy::OpenCanonical => "open-canonical",
        OpenPolicy::MigrateFromLegacy => "migrate-from-legacy",
        OpenPolicy::FirstRunCreate => "first-run-create",
    }
}

/// Decide open policy (T-B0-3): never silently replace a broken legacy DB.
pub fn open_policy(
    canonical_kind: DatabaseFileKind,
    candidate_kinds: &[(PathBuf, DatabaseFileKind)],
) -> Result<OpenPolicy, DbError> {
    match canonical_kind {
        DatabaseFileKind::Kindora => Ok(OpenPolicy::OpenCanonical),
        DatabaseFileKind::NotKindora => Err(DbError::NotAKindoraDatabase),
        DatabaseFileKind::Unreadable => Err(DbError::LegacyUnreadable),
        DatabaseFileKind::Missing => {
            let mut legacy_unreadable = false;
            for (_p, k) in candidate_kinds {
                match k {
                    DatabaseFileKind::Kindora => {
                        return Ok(OpenPolicy::MigrateFromLegacy);
                    }
                    DatabaseFileKind::Unreadable | DatabaseFileKind::NotKindora => {
                        legacy_unreadable = true;
                    }
                    DatabaseFileKind::Missing => {}
                }
            }
            if legacy_unreadable {
                return Err(DbError::LegacyUnreadable);
            }
            Ok(OpenPolicy::FirstRunCreate)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenPolicy {
    OpenCanonical,
    MigrateFromLegacy,
    FirstRunCreate,
}

/// Open an existing Kindora SQLite file (read schema version; no migrate yet).
pub async fn open_existing(path: &Path) -> Result<sqlx::SqlitePool, DbError> {
    let url = format!("sqlite:{}?mode=rw", path.display());
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .map_err(|e| DbError::Sql(e.to_string()))?;
    let version = read_schema_version(&pool).await?;
    if version > SCHEMA_VERSION {
        pool.close().await;
        return Err(DbError::SchemaTooNew);
    }
    Ok(pool)
}

pub async fn read_schema_version(pool: &sqlx::SqlitePool) -> Result<i64, DbError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
            .fetch_optional(pool)
            .await
            .map_err(|e| DbError::Sql(e.to_string()))?;
    Ok(row.map(|r| r.0).unwrap_or(0))
}

struct FsProbe;

impl crate::db_path::DbProbe for FsProbe {
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn read_prefix(&self, path: &Path, len: usize) -> Result<Vec<u8>, ()> {
        use std::io::Read;
        let mut f = std::fs::File::open(path).map_err(|_| ())?;
        let mut buf = vec![0u8; len];
        let n = f.read(&mut buf).map_err(|_| ())?;
        buf.truncate(n);
        Ok(buf)
    }

    fn file_contains(&self, path: &Path, needle: &[u8]) -> Result<bool, ()> {
        let data = std::fs::read(path).map_err(|_| ())?;
        Ok(data.windows(needle.len()).any(|w| w == needle))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_when_all_missing() {
        let policy = open_policy(DatabaseFileKind::Missing, &[]).unwrap();
        assert_eq!(policy, OpenPolicy::FirstRunCreate);
    }

    #[test]
    fn refuses_not_kindora_at_canonical() {
        let err = open_policy(DatabaseFileKind::NotKindora, &[]).unwrap_err();
        assert!(matches!(err, DbError::NotAKindoraDatabase));
    }

    #[test]
    fn migrate_when_legacy_kindora_and_canonical_missing() {
        let legacy = PathBuf::from("/data/kindora.db");
        let policy = open_policy(
            DatabaseFileKind::Missing,
            &[(legacy, DatabaseFileKind::Kindora)],
        )
        .unwrap();
        assert_eq!(policy, OpenPolicy::MigrateFromLegacy);
    }

    #[test]
    fn schema_version_constant_matches_storage_package() {
        // packages/storage/src/sql-migrations.ts exports SCHEMA_VERSION = 1.
        assert_eq!(SCHEMA_VERSION, 1);
    }
}
