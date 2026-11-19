//! Inbound envelope processing and session phases — P0-2A / A7.

use crate::envelope::{build_signing_input, SignableEnvelope, SIGNATURE_ALG, SIGNING_SCHEME};
use crate::fingerprint::derive_pairing_fingerprint;
use crate::trust_store::{TrustLevel, TrustStore};
use base64::Engine;
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const ALL_MESSAGE_TYPES: &[&str] = &[
    "hello",
    "profile_exchange",
    "match_request",
    "match_response",
    "icebreaker_request",
    "icebreaker_response",
    "chat_message",
    "permission_request",
    "consent_accept",
    "consent_reject",
    "block",
    "disconnect",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    Discovering,
    HelloExchange,
    Verified,
    Consent,
    Chat,
    Closed,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("invalid-envelope")]
    InvalidEnvelope,
    #[error("type-not-allowed-in-phase")]
    TypeNotAllowedInPhase,
    #[error("business-before-verified")]
    BusinessBeforeVerified,
    #[error("unsigned-envelope")]
    UnsignedEnvelope,
    #[error("signature-invalid")]
    SignatureInvalid,
    #[error("peer-identity-changed")]
    PeerIdentityChanged,
    #[error("sender-mismatch")]
    SenderMismatch,
}

/// Types that require out-of-band fingerprint verification (IBR-3 / IBR-11).
pub fn requires_verified_trust(type_name: &str) -> bool {
    matches!(
        type_name,
        "consent_accept"
            | "consent_reject"
            | "chat_message"
            | "icebreaker_request"
            | "icebreaker_response"
            | "permission_request"
    )
}

pub fn requires_mla_grant(type_name: &str) -> bool {
    matches!(
        type_name,
        "chat_message" | "icebreaker_request" | "icebreaker_response"
    )
}

fn is_business_before_verified(type_name: &str) -> bool {
    requires_verified_trust(type_name)
        || matches!(
            type_name,
            "match_request" | "match_response" | "profile_exchange"
        )
}

fn phase_allows_inbound(phase: SessionPhase, type_name: &str) -> bool {
    if !ALL_MESSAGE_TYPES.contains(&type_name) {
        return false;
    }
    match phase {
        SessionPhase::Closed => type_name == "disconnect",
        SessionPhase::Discovering => type_name == "hello",
        SessionPhase::HelloExchange => {
            matches!(type_name, "hello" | "profile_exchange" | "disconnect")
        }
        SessionPhase::Verified => !matches!(
            type_name,
            "chat_message" | "icebreaker_request" | "icebreaker_response"
        ),
        SessionPhase::Consent => !matches!(
            type_name,
            "chat_message" | "icebreaker_request" | "icebreaker_response"
        ),
        SessionPhase::Chat => type_name != "hello",
    }
}

pub fn derive_key_id_from_spki(spki: &[u8]) -> String {
    let digest = Sha256::digest(spki);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn decode_standard_b64(s: &str) -> Result<Vec<u8>, SessionError> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|_| SessionError::InvalidEnvelope)
}

fn decode_b64url(s: &str) -> Result<Vec<u8>, SessionError> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(s))
        .map_err(|_| SessionError::InvalidEnvelope)
}

fn parse_signable(envelope: &Value) -> Result<(SignableEnvelope, Value), SessionError> {
    let protocol = envelope
        .get("protocol")
        .and_then(|v| v.as_str())
        .ok_or(SessionError::InvalidEnvelope)?;
    let version = envelope
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or(SessionError::InvalidEnvelope)?;
    let message_id = envelope
        .get("messageId")
        .and_then(|v| v.as_str())
        .ok_or(SessionError::InvalidEnvelope)?;
    let timestamp = envelope
        .get("timestamp")
        .and_then(|v| v.as_str())
        .ok_or(SessionError::InvalidEnvelope)?;
    let type_name = envelope
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or(SessionError::InvalidEnvelope)?;
    let sender = envelope
        .get("sender")
        .and_then(|v| v.as_str())
        .ok_or(SessionError::InvalidEnvelope)?;
    let payload = envelope
        .get("payload")
        .cloned()
        .ok_or(SessionError::InvalidEnvelope)?;
    let signature = envelope
        .get("signature")
        .cloned()
        .ok_or(SessionError::UnsignedEnvelope)?;

    let env = SignableEnvelope {
        protocol: protocol.to_string(),
        version: version.to_string(),
        message_id: message_id.to_string(),
        timestamp: timestamp.to_string(),
        type_name: type_name.to_string(),
        sender: sender.to_string(),
        payload,
    };
    Ok((env, signature))
}

fn verify_es256(spki: &[u8], message: &[u8], sig_b64url: &str) -> Result<(), SessionError> {
    if sig_b64url.len() > 256 {
        return Err(SessionError::SignatureInvalid);
    }
    let sig_bytes = decode_b64url(sig_b64url)?;
    if sig_bytes.len() != 64 {
        return Err(SessionError::SignatureInvalid);
    }
    let verifying_key =
        VerifyingKey::from_public_key_der(spki).map_err(|_| SessionError::SignatureInvalid)?;
    let signature = Signature::from_slice(&sig_bytes).map_err(|_| SessionError::SignatureInvalid)?;
    verifying_key
        .verify(message, &signature)
        .map_err(|_| SessionError::SignatureInvalid)
}

pub struct InboundFrameProcessor {
    pub phase: SessionPhase,
    pub local_agent_id: String,
    pub peer_agent_id: Option<String>,
    pub peer_spki: Option<Vec<u8>>,
    pub peer_key_id: Option<String>,
    pub peer_fingerprint: Option<String>,
    pub peer_trust: TrustLevel,
    pub trust_store: TrustStore,
    seen_hello: bool,
    seen_message_ids: HashSet<String>,
}

impl InboundFrameProcessor {
    pub fn new(local_agent_id: String) -> Self {
        Self {
            phase: SessionPhase::Discovering,
            local_agent_id,
            peer_agent_id: None,
            peer_spki: None,
            peer_key_id: None,
            peer_fingerprint: None,
            peer_trust: TrustLevel::Untrusted,
            trust_store: TrustStore::in_memory(),
            seen_hello: false,
            seen_message_ids: HashSet::new(),
        }
    }

    pub fn with_trust_store(mut self, store: TrustStore) -> Self {
        self.trust_store = store;
        self
    }

    fn recipient_for(&self, type_name: &str) -> String {
        if type_name == "hello" {
            String::new()
        } else {
            self.local_agent_id.clone()
        }
    }

    fn latch_peer_from_hello(
        &mut self,
        sender: &str,
        payload: &Value,
        signature: &Value,
    ) -> Result<(), SessionError> {
        if self.seen_hello {
            let pk = payload
                .get("publicKey")
                .and_then(|v| v.as_str())
                .ok_or(SessionError::InvalidEnvelope)?;
            let spki = decode_standard_b64(pk)?;
            if self.peer_spki.as_deref() != Some(spki.as_slice()) {
                return Err(SessionError::PeerIdentityChanged);
            }
            return Ok(());
        }
        self.seen_hello = true;
        let pk = payload
            .get("publicKey")
            .and_then(|v| v.as_str())
            .ok_or(SessionError::InvalidEnvelope)?;
        let spki = decode_standard_b64(pk)?;
        let expected_key_id = derive_key_id_from_spki(&spki);
        let key_id = signature
            .get("keyId")
            .and_then(|v| v.as_str())
            .ok_or(SessionError::InvalidEnvelope)?;
        if key_id != expected_key_id {
            return Err(SessionError::SignatureInvalid);
        }
        let fp = derive_pairing_fingerprint(sender, &spki);
        self.peer_agent_id = Some(sender.to_string());
        self.peer_spki = Some(spki);
        self.peer_key_id = Some(key_id.to_string());
        self.peer_fingerprint = Some(fp.clone());
        self.phase = SessionPhase::HelloExchange;
        if let Some(pinned) = self.trust_store.get(sender, &fp) {
            self.peer_trust = pinned;
        } else {
            self.peer_trust = TrustLevel::Provisional;
            let _ = self.trust_store.set(sender, &fp, TrustLevel::Provisional);
        }
        Ok(())
    }

    /// Parse JSON frame → phase gate → verify signature → update trust.
    pub fn process_inbound(&mut self, frame_json: &str) -> Result<(), SessionError> {
        let envelope: Value =
            serde_json::from_str(frame_json).map_err(|_| SessionError::InvalidEnvelope)?;
        let (env, signature) = parse_signable(&envelope)?;
        let type_name = env.type_name.as_str();

        if self.phase != SessionPhase::Verified
            && self.phase != SessionPhase::Consent
            && self.phase != SessionPhase::Chat
            && is_business_before_verified(type_name)
        {
            return Err(SessionError::BusinessBeforeVerified);
        }

        if !phase_allows_inbound(self.phase, type_name) {
            return Err(SessionError::TypeNotAllowedInPhase);
        }

        if signature.get("alg").and_then(|v| v.as_str()) != Some(SIGNATURE_ALG) {
            return Err(SessionError::SignatureInvalid);
        }
        if signature.get("signedFields").and_then(|v| v.as_str()) != Some(SIGNING_SCHEME) {
            return Err(SessionError::SignatureInvalid);
        }

        if type_name == "hello" {
            self.latch_peer_from_hello(&env.sender, &env.payload, &signature)?;
        } else {
            let Some(peer_sender) = self.peer_agent_id.as_deref() else {
                return Err(SessionError::InvalidEnvelope);
            };
            if env.sender != peer_sender {
                return Err(SessionError::SenderMismatch);
            }
            let Some(spki) = self.peer_spki.as_deref() else {
                return Err(SessionError::InvalidEnvelope);
            };
            let key_id = signature
                .get("keyId")
                .and_then(|v| v.as_str())
                .ok_or(SessionError::InvalidEnvelope)?;
            if Some(key_id) != self.peer_key_id.as_deref() {
                return Err(SessionError::PeerIdentityChanged);
            }
            let sig_val = signature
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or(SessionError::InvalidEnvelope)?;
            let signing_input = build_signing_input(&env, &self.recipient_for(type_name))
                .map_err(|_| SessionError::InvalidEnvelope)?;
            verify_es256(spki, &signing_input, sig_val)?;
        }

        if type_name == "hello" {
            let spki = self.peer_spki.as_deref().unwrap();
            let sig_val = signature
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or(SessionError::InvalidEnvelope)?;
            let signing_input =
                build_signing_input(&env, "").map_err(|_| SessionError::InvalidEnvelope)?;
            verify_es256(spki, &signing_input, sig_val)?;
        }

        if !self.seen_message_ids.insert(env.message_id.clone()) {
            return Err(SessionError::InvalidEnvelope);
        }

        if requires_verified_trust(type_name)
            && !matches!(self.peer_trust, TrustLevel::Verified | TrustLevel::Pinned)
        {
            return Err(SessionError::BusinessBeforeVerified);
        }

        if type_name == "disconnect" || type_name == "block" {
            self.phase = SessionPhase::Closed;
        }

        Ok(())
    }

    pub fn mark_peer_verified(&mut self) -> Result<(), SessionError> {
        let (Some(agent_id), Some(fp)) = (self.peer_agent_id.clone(), self.peer_fingerprint.clone()) else {
            return Err(SessionError::InvalidEnvelope);
        };
        self.trust_store
            .set(&agent_id, &fp, TrustLevel::Verified)
            .map_err(|_| SessionError::InvalidEnvelope)?;
        self.peer_trust = TrustLevel::Verified;
        self.phase = SessionPhase::Verified;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::build_signing_input;
    use p256::ecdsa::{signature::Signer, SigningKey};
    use p256::elliptic_curve::pkcs8::EncodePublicKey;
    use p256::PublicKey;
    use rand_core::OsRng;
    use serde_json::json;

    fn sign_envelope(
        signing_key: &SigningKey,
        env: &SignableEnvelope,
        recipient: &str,
        spki_b64: &str,
    ) -> Value {
        let input = build_signing_input(env, recipient).unwrap();
        let sig: Signature = signing_key.sign(&input);
        let key_id = derive_key_id_from_spki(&base64::engine::general_purpose::STANDARD.decode(spki_b64).unwrap());
        json!({
            "protocol": env.protocol,
            "version": env.version,
            "messageId": env.message_id,
            "timestamp": env.timestamp,
            "type": env.type_name,
            "sender": env.sender,
            "payload": env.payload,
            "signature": {
                "alg": SIGNATURE_ALG,
                "signedFields": SIGNING_SCHEME,
                "keyId": key_id,
                "value": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes()),
            }
        })
    }

    #[test]
    fn rejects_chat_before_verified() {
        let signing_key = SigningKey::random(&mut OsRng);
        let spki = PublicKey::from(*signing_key.verifying_key())
            .to_public_key_der()
            .expect("spki der")
            .to_vec();
        let spki_b64 = base64::engine::general_purpose::STANDARD.encode(&spki);
        let sender = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let local = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

        let hello = SignableEnvelope {
            protocol: "KSA".into(),
            version: "0.1".into(),
            message_id: "11111111-1111-4111-8111-111111111111".into(),
            timestamp: "2026-01-01T00:00:00.000Z".into(),
            type_name: "hello".into(),
            sender: sender.into(),
            payload: json!({"displayName": "Peer", "publicKey": spki_b64, "capabilities": {"protocolVersion": "0.1"}}),
        };
        let hello_wire = sign_envelope(&signing_key, &hello, "", &spki_b64);

        let mut proc = InboundFrameProcessor::new(local.to_string());
        proc.process_inbound(&hello_wire.to_string()).unwrap();
        assert_eq!(proc.phase, SessionPhase::HelloExchange);

        let chat = SignableEnvelope {
            protocol: "KSA".into(),
            version: "0.1".into(),
            message_id: "22222222-2222-4222-8222-222222222222".into(),
            timestamp: "2026-01-02T00:00:00.000Z".into(),
            type_name: "chat_message".into(),
            sender: sender.into(),
            payload: json!({"text": "hi"}),
        };
        let chat_wire = sign_envelope(&signing_key, &chat, local, &spki_b64);
        assert_eq!(
            proc.process_inbound(&chat_wire.to_string()),
            Err(SessionError::BusinessBeforeVerified)
        );
    }
}