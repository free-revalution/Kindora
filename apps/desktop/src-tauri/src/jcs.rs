//! RFC 8785 JSON Canonicalization Scheme (JCS) — P0-2A / A1.
//!
//! Thin wrapper around `serde_json_canonicalizer` so envelope signing on
//! the Rust side hashes the same bytes as `@kindora/protocol`'s
//! `canonicalize` / `canonicalizeToBytes`. Golden vectors live in
//! `packages/protocol/src/__tests__/fixtures/jcs-vectors.json` and are
//! asserted on both sides (design §5.2 / §5.3 test A).

use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum JcsError {
    #[error("JCS serialize: {0}")]
    Serialize(String),
}

/// Canonical JSON string (UTF-8), matching RFC 8785 / JCS.
pub fn canonicalize(value: &Value) -> Result<String, JcsError> {
    serde_json_canonicalizer::to_string(value).map_err(|e| JcsError::Serialize(e.to_string()))
}

/// Canonical JSON as UTF-8 bytes — the input to SHA-256 for payload digests.
pub fn canonicalize_to_bytes(value: &Value) -> Result<Vec<u8>, JcsError> {
    Ok(canonicalize(value)?.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rfc_8785_section_3_2_3_reference_vector() {
        // Same input/expected pair as packages/protocol canonical-json.test.ts
        // and fixtures/jcs-vectors.json ("rfc-8785-3.2.3").
        let input = json!({
            "numbers": [333333333.3333333, 1e30, 4.5, 0.002, 1e-27],
            "string": "€$\u{000f}\nA'B\"\\\\\"/",
            "literals": [null, true, false],
        });
        let expected = concat!(
            r#"{"literals":[null,true,false],"#,
            r#""numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"#,
            r#""string":"€$\u000f\nA'B\"\\\\\"/"}"#,
        );
        assert_eq!(canonicalize(&input).unwrap(), expected);
    }

    #[test]
    fn sorts_object_keys_by_utf16_code_unit() {
        let value = json!({ "b": 1, "a": 2, "c": 3 });
        assert_eq!(canonicalize(&value).unwrap(), r#"{"a":2,"b":1,"c":3}"#);
    }

    #[test]
    fn golden_vectors_file_matches_rust_jcs() {
        // Path relative to this crate's manifest (CARGO_MANIFEST_DIR).
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/src/__tests__/fixtures/jcs-vectors.json"
        );
        let raw = std::fs::read_to_string(path).expect("jcs-vectors.json must exist");
        let doc: Value = serde_json::from_str(&raw).expect("jcs-vectors.json must be JSON");
        let vectors = doc
            .get("vectors")
            .and_then(|v| v.as_array())
            .expect("vectors array");
        assert!(!vectors.is_empty(), "golden vector file must not be empty");
        for entry in vectors {
            let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("?");
            let input = entry.get("input").expect("input");
            let expected = entry
                .get("expected")
                .and_then(|v| v.as_str())
                .expect("expected string");
            let got = canonicalize(input).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(got, expected, "vector `{name}` mismatch");
        }
    }
}
