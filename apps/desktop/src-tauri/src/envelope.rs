//! Envelope signing input — P0-2A / A2.
//!
//! Must match `@kindora/protocol` `buildSigningInput` byte-for-byte:
//!
//! ```text
//! KSA-SIG-V1\n
//! <protocol>\n
//! <version>\n
//! <messageId>\n
//! <timestamp>\n
//! <type>\n
//! <sender>\n
//! <recipient>\n
//! <base64url(SHA-256(JCS(payload)))>\n
//! ```

use crate::jcs;
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const SIGNING_INPUT_HEADER: &str = "KSA-SIG-V1";
pub const SIGNATURE_ALG: &str = "ES256";
pub const SIGNING_SCHEME: &str = "ksa-sig-v1";

#[derive(Debug, Clone)]
pub struct SignableEnvelope {
    pub protocol: String,
    pub version: String,
    pub message_id: String,
    pub timestamp: String,
    pub type_name: String,
    pub sender: String,
    pub payload: Value,
}

#[derive(Debug, thiserror::Error)]
pub enum EnvelopeError {
    #[error("JCS: {0}")]
    Jcs(String),
}

/// Build the exact bytes that get signed / verified.
pub fn build_signing_input(
    envelope: &SignableEnvelope,
    recipient: &str,
) -> Result<Vec<u8>, EnvelopeError> {
    let canonical = jcs::canonicalize_to_bytes(&envelope.payload)
        .map_err(|e| EnvelopeError::Jcs(e.to_string()))?;
    let digest = Sha256::digest(&canonical);
    let digest_b64 =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest.as_slice());
    let records = [
        SIGNING_INPUT_HEADER,
        envelope.protocol.as_str(),
        envelope.version.as_str(),
        envelope.message_id.as_str(),
        envelope.timestamp.as_str(),
        envelope.type_name.as_str(),
        envelope.sender.as_str(),
        recipient,
        digest_b64.as_str(),
    ];
    let mut out = String::new();
    for r in records {
        out.push_str(r);
        out.push('\n');
    }
    Ok(out.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn signing_input_is_lf_terminated_records() {
        let env = SignableEnvelope {
            protocol: "ksa".into(),
            version: "0.1".into(),
            message_id: "11111111-1111-4111-8111-111111111111".into(),
            timestamp: "2026-01-01T00:00:00.000Z".into(),
            type_name: "hello".into(),
            sender: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            payload: json!({"displayName": "t", "capabilities": {"protocolVersion": "0.1"}}),
        };
        let bytes = build_signing_input(&env, "").unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("KSA-SIG-V1\n"));
        assert!(text.ends_with('\n'));
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 9);
        assert_eq!(lines[0], "KSA-SIG-V1");
        assert_eq!(lines[7], ""); // empty recipient for hello
    }

    #[test]
    fn golden_vectors_match_shared_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/src/__tests__/fixtures/signing-input-vectors.json"
        );
        let Ok(raw) = std::fs::read_to_string(path) else {
            // Fixture may be generated in the same wave; skip if absent.
            return;
        };
        let doc: Value = serde_json::from_str(&raw).expect("signing-input-vectors.json");
        let vectors = doc["vectors"].as_array().expect("vectors");
        for entry in vectors {
            let name = entry["name"].as_str().unwrap_or("?");
            let env_obj = &entry["envelope"];
            let env = SignableEnvelope {
                protocol: env_obj["protocol"].as_str().unwrap().into(),
                version: env_obj["version"].as_str().unwrap().into(),
                message_id: env_obj["messageId"].as_str().unwrap().into(),
                timestamp: env_obj["timestamp"].as_str().unwrap().into(),
                type_name: env_obj["type"].as_str().unwrap().into(),
                sender: env_obj["sender"].as_str().unwrap().into(),
                payload: env_obj["payload"].clone(),
            };
            let recipient = entry["recipient"].as_str().unwrap_or("");
            let expected_b64 = entry["expectedInputB64url"].as_str().unwrap();
            let got = build_signing_input(&env, recipient).unwrap();
            let got_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&got);
            assert_eq!(got_b64, expected_b64, "vector `{name}`");
        }
    }
}
