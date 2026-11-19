//! Sensitive-field guard (Rust) — P0-2A / A9, mirrors TS defence-in-depth.

use crate::credential_shape::looks_like_credential;
use serde_json::Value;
use std::collections::HashSet;

const DEFAULT_MAX_DEPTH: usize = 32;
const DEFAULT_MAX_NODES: usize = 10_000;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SensitiveGuardError {
    #[error("sensitive-field-detected at {path}: {detail}")]
    Detected { path: String, detail: String },
}

fn normalise_field_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn is_allowed_public_field(name: &str) -> bool {
    matches!(
        normalise_field_name(name).as_str(),
        "publickey"
            | "publickeys"
            | "ephemeralpublickey"
            | "sessionkeyexchange"
            | "keyid"
            | "publickeyfingerprint"
            | "hostpublickeyfingerprint"
            | "keyfingerprint"
            | "fingerprint"
    )
}

fn is_forbidden_field(name: &str) -> bool {
    if is_allowed_public_field(name) {
        return false;
    }
    static FORBIDDEN: &[&str] = &[
        "apikey",
        "apikeys",
        "apisecret",
        "secret",
        "secrets",
        "secretkey",
        "privatekey",
        "privatekeys",
        "password",
        "passwd",
        "passphrase",
        "token",
        "tokens",
        "accesstoken",
        "refreshtoken",
        "bearertoken",
        "authorization",
        "cookie",
        "cookies",
        "credential",
        "credentials",
    ];
    let n = normalise_field_name(name);
    FORBIDDEN.contains(&n.as_str())
}

fn walk(value: &Value, path: &str, depth: usize, nodes: &mut usize) -> Result<(), SensitiveGuardError> {
    *nodes += 1;
    if *nodes > DEFAULT_MAX_NODES {
        return Err(SensitiveGuardError::Detected {
            path: path.to_string(),
            detail: "payload-too-large".into(),
        });
    }
    if depth > DEFAULT_MAX_DEPTH {
        return Err(SensitiveGuardError::Detected {
            path: path.to_string(),
            detail: "max-depth-exceeded".into(),
        });
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(s) => {
            if looks_like_credential(s) {
                return Err(SensitiveGuardError::Detected {
                    path: path.to_string(),
                    detail: "credential-like string".into(),
                });
            }
            Ok(())
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                walk(item, &format!("{path}[{i}]"), depth + 1, nodes)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            let mut seen = HashSet::new();
            for (key, item) in map {
                if !seen.insert(key.clone()) {
                    return Err(SensitiveGuardError::Detected {
                        path: path.to_string(),
                        detail: "duplicate-field".into(),
                    });
                }
                if is_forbidden_field(key) {
                    return Err(SensitiveGuardError::Detected {
                        path: format!("{path}.{key}"),
                        detail: "forbidden field name".into(),
                    });
                }
                walk(item, &format!("{path}.{key}"), depth + 1, nodes)?;
            }
            Ok(())
        }
    }
}

/// Reject when any string or field name looks sensitive.
pub fn reject_if_sensitive(payload: &Value) -> Result<(), SensitiveGuardError> {
    walk(payload, "$", 0, &mut 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_forbidden_field() {
        let err = reject_if_sensitive(&json!({"apiKey": "x"})).unwrap_err();
        assert!(matches!(err, SensitiveGuardError::Detected { .. }));
    }

    #[test]
    fn rejects_credential_in_nested_string() {
        let err = reject_if_sensitive(&json!({"note": "use sk-abcdefghijklmnopqrstuvwxyz01"}))
            .unwrap_err();
        assert!(matches!(err, SensitiveGuardError::Detected { .. }));
    }

    #[test]
    fn allows_public_key_field() {
        reject_if_sensitive(&json!({"publicKey": "QUJDRA=="})).unwrap();
    }
}