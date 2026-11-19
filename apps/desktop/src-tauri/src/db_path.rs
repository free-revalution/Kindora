//! SQLite database path resolution — P0-2B / B0 (§7.1.5).
//!
//! Canonical path: `app_config_dir()/kindora.db` (matches legacy
//! `tauri-plugin-sql` with `sqlite:kindora.db`).

use std::path::{Path, PathBuf};

pub const KINDORA_DB_FILENAME: &str = "kindora.db";
pub const KINDORA_SQLITE_LEGACY: &str = "kindora.sqlite";

/// SQLite file header magic (first 16 bytes of every SQLite 3 database).
pub const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseFileKind {
    /// Looks like a Kindora app database (schema markers present).
    Kindora,
    /// SQLite (or file) present but missing Kindora schema markers.
    NotKindora,
    /// Path does not exist.
    Missing,
    /// Exists but cannot be probed (permissions, I/O).
    Unreadable,
}

/// Abstraction for existence / readability checks (unit tests use in-memory probes).
pub trait DbProbe {
    fn exists(&self, path: &Path) -> bool;
    fn read_prefix(&self, path: &Path, len: usize) -> Result<Vec<u8>, ()>;
    fn file_contains(&self, path: &Path, needle: &[u8]) -> Result<bool, ()>;
}

/// Canonical database location for new opens.
pub fn canonical_db_path(config_dir: &Path) -> PathBuf {
    config_dir.join(KINDORA_DB_FILENAME)
}

/// Candidate paths in probe order (§7.1.5) — read-only discovery.
pub fn candidate_db_paths(config_dir: &Path, data_dir: &Path) -> Vec<PathBuf> {
    vec![
        config_dir.join(KINDORA_DB_FILENAME),
        data_dir.join(KINDORA_DB_FILENAME),
        config_dir.join(KINDORA_SQLITE_LEGACY),
    ]
}

/// Lightweight Kindora DB check: SQLite magic plus `schema_migrations` or `agents` table names.
pub fn is_kindora_db_probe<P: DbProbe>(probe: &P, path: &Path) -> DatabaseFileKind {
    if !probe.exists(path) {
        return DatabaseFileKind::Missing;
    }
    let header = match probe.read_prefix(path, 16) {
        Ok(h) => h,
        Err(()) => return DatabaseFileKind::Unreadable,
    };
    if header != SQLITE_MAGIC {
        return DatabaseFileKind::NotKindora;
    }
    let has_migrations = probe
        .file_contains(path, b"schema_migrations")
        .unwrap_or(false);
    let has_agents = probe.file_contains(path, b"agents").unwrap_or(false);
    if has_migrations || has_agents {
        DatabaseFileKind::Kindora
    } else {
        DatabaseFileKind::NotKindora
    }
}

/// Classify a path for B0 migration / first-run policy (T-B0-1…3).
pub fn classify_database_file<P: DbProbe>(probe: &P, path: &Path) -> DatabaseFileKind {
    is_kindora_db_probe(probe, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryProbe {
        files: HashMap<PathBuf, Vec<u8>>,
    }

    impl MemoryProbe {
        fn insert(&mut self, path: PathBuf, bytes: Vec<u8>) {
            self.files.insert(path, bytes);
        }
    }

    impl DbProbe for MemoryProbe {
        fn exists(&self, path: &Path) -> bool {
            self.files.contains_key(path)
        }

        fn read_prefix(&self, path: &Path, len: usize) -> Result<Vec<u8>, ()> {
            let data = self.files.get(path).ok_or(())?;
            let end = len.min(data.len());
            Ok(data[..end].to_vec())
        }

        fn file_contains(&self, path: &Path, needle: &[u8]) -> Result<bool, ()> {
            let data = self.files.get(path).ok_or(())?;
            Ok(data.windows(needle.len()).any(|w| w == needle))
        }
    }

  fn sqlite_blob_with_table(table_name: &str) -> Vec<u8> {
        let mut v = SQLITE_MAGIC.to_vec();
        v.extend_from_slice(table_name.as_bytes());
        v
    }

    #[test]
    fn t_b0_path_rules() {
        let config = Path::new("/cfg/com.kindora.app");
        let data = Path::new("/data/com.kindora.app");
        let paths = candidate_db_paths(config, data);
        assert_eq!(paths.len(), 3);
        assert_eq!(paths[0], config.join("kindora.db"));
        assert_eq!(paths[1], data.join("kindora.db"));
        assert_eq!(paths[2], config.join("kindora.sqlite"));
        assert_eq!(
            canonical_db_path(config),
            config.join("kindora.db")
        );
    }

    #[test]
    fn t_b0_classify_missing() {
        let probe = MemoryProbe::default();
        let p = Path::new("/cfg/kindora.db");
        assert_eq!(
            classify_database_file(&probe, p),
            DatabaseFileKind::Missing
        );
    }

    #[test]
    fn t_b0_classify_not_kindora_sqlite_without_markers() {
        let mut probe = MemoryProbe::default();
        let p = PathBuf::from("/cfg/other.db");
        probe.insert(p.clone(), SQLITE_MAGIC.to_vec());
        assert_eq!(
            classify_database_file(&probe, &p),
            DatabaseFileKind::NotKindora
        );
    }

    #[test]
    fn t_b0_classify_kindora_when_schema_migrations_present() {
        let mut probe = MemoryProbe::default();
        let p = PathBuf::from("/cfg/kindora.db");
        probe.insert(p.clone(), sqlite_blob_with_table("schema_migrations"));
        assert_eq!(
            classify_database_file(&probe, &p),
            DatabaseFileKind::Kindora
        );
    }

    #[test]
    fn t_b0_classify_kindora_when_agents_present() {
        let mut probe = MemoryProbe::default();
        let p = PathBuf::from("/data/kindora.db");
        probe.insert(p.clone(), sqlite_blob_with_table("agents"));
        assert_eq!(
            classify_database_file(&probe, &p),
            DatabaseFileKind::Kindora
        );
    }

    #[test]
    fn t_b0_classify_unreadable_when_prefix_unreadable() {
        struct BrokenProbe;
        impl DbProbe for BrokenProbe {
            fn exists(&self, _path: &Path) -> bool {
                true
            }
            fn read_prefix(&self, _path: &Path, _len: usize) -> Result<Vec<u8>, ()> {
                Err(())
            }
            fn file_contains(&self, _path: &Path, _needle: &[u8]) -> Result<bool, ()> {
                Err(())
            }
        }
        let p = Path::new("/cfg/kindora.db");
        assert_eq!(
            classify_database_file(&BrokenProbe, p),
            DatabaseFileKind::Unreadable
        );
    }
}