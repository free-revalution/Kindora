//! Pairing fingerprint derivation — P0-2A / A6.
//!
//! Byte-for-byte equivalent to `packages/transport/src/pairing-fingerprint.ts`.

use sha2::{Digest, Sha256};

/// Crockford Base32 alphabet (no I, L, O, U).
pub const CROCKFORD_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub const PAIRING_FINGERPRINT_LENGTH: usize = 6;

/// Encode `bytes` with Crockford Base32 (MSB-first, 5 bits per character).
pub fn crockford_base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((buffer >> bits) & 0x1f) as usize;
            out.push(CROCKFORD_ALPHABET[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((buffer << (5 - bits)) & 0x1f) as usize;
        out.push(CROCKFORD_ALPHABET[idx] as char);
    }
    out
}

/// `CrockfordBase32(SHA-256(utf8(agent_id) ‖ spki_der))[0..6]`.
pub fn derive_pairing_fingerprint(agent_id: &str, spki_der: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(agent_id.as_bytes());
    hasher.update(spki_der);
    let digest = hasher.finalize();
    crockford_base32(&digest)[..PAIRING_FINGERPRINT_LENGTH].to_string()
}

/// Case-insensitive, ignores whitespace and cosmetic dashes.
pub fn fingerprints_match(a: &str, b: &str) -> bool {
    fn normalise(value: &str) -> String {
        value
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .map(|c| c.to_ascii_uppercase())
            .collect()
    }
    normalise(a) == normalise(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_match_ignores_case_and_dashes() {
        assert!(fingerprints_match("a1b2c3", "A1B-2C3"));
        assert!(fingerprints_match("  ab-cd-ef ", "ABCDEF"));
        assert!(!fingerprints_match("AAAAAA", "BBBBBB"));
    }

    #[test]
    fn derive_is_deterministic_for_fixed_input() {
        let agent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let spki = b"\x30\x59\x30\x13\x06\x07\x2a\x86\x48\xce\x3d\x02\x01\x06\x08\x2a\x86\x48\xce\x3d\x03\x01\x07\x03\x42\x00";
        let a = derive_pairing_fingerprint(agent, spki);
        let b = derive_pairing_fingerprint(agent, spki);
        assert_eq!(a.len(), PAIRING_FINGERPRINT_LENGTH);
        assert_eq!(a, b);
        assert!(a.chars().all(|c| CROCKFORD_ALPHABET.contains(&(c as u8))));
    }

    #[test]
    fn golden_vectors_from_shared_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/protocol/src/__tests__/fixtures/fingerprint-vectors.json"
        );
        let Ok(raw) = std::fs::read_to_string(path) else {
            return;
        };
        let doc: serde_json::Value = serde_json::from_str(&raw).expect("fingerprint-vectors.json");
        let vectors = doc["vectors"].as_array().expect("vectors array");
        for entry in vectors {
            let name = entry["name"].as_str().unwrap_or("?");
            let agent_id = entry["agentId"].as_str().expect("agentId");
            let spki_b64 = entry["spkiDerBase64"].as_str().expect("spkiDerBase64");
            let expected = entry["expectedFingerprint"].as_str().expect("expectedFingerprint");
            use base64::Engine;
            let spki = base64::engine::general_purpose::STANDARD
                .decode(spki_b64)
                .unwrap_or_else(|_| panic!("vector `{name}` spki base64"));
            let got = derive_pairing_fingerprint(agent_id, &spki);
            assert_eq!(got, expected, "vector `{name}`");
        }
    }
}