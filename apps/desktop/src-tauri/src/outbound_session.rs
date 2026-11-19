//! Rust-authoritative outbound authorisation context (P0-2A / A10 follow-up).
//!
//! WebView must not supply `phase` / `peer_trust` / `consent_*` when signing.
//! Those fields live here and are mutated only by dedicated session commands.

use crate::fingerprint::{derive_pairing_fingerprint, fingerprints_match};
use crate::session::{derive_key_id_from_spki, SessionPhase};
use crate::trust_store::TrustLevel;
use base64::Engine;
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub struct OutboundSession {
    pub local_agent_id: String,
    pub local_key_id: Option<String>,
    pub phase: SessionPhase,
    pub peer_agent_id: Option<String>,
    pub peer_fingerprint: Option<String>,
    pub peer_trust: TrustLevel,
    pub consent_local: bool,
    pub consent_peer: bool,
}

impl OutboundSession {
    pub fn new(local_agent_id: String, local_key_id: Option<String>) -> Self {
        Self {
            local_agent_id,
            local_key_id,
            phase: SessionPhase::HelloExchange,
            peer_agent_id: None,
            peer_fingerprint: None,
            peer_trust: TrustLevel::Untrusted,
            consent_local: false,
            consent_peer: false,
        }
    }
}

#[derive(Debug, Default)]
pub struct OutboundSessionState {
    pub inner: Mutex<Option<OutboundSession>>,
}

impl OutboundSessionState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub fn bind_local(
        &self,
        local_agent_id: String,
        local_key_id: Option<String>,
    ) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "outbound-session-lock-poisoned".to_string())?;
        *guard = Some(OutboundSession::new(local_agent_id, local_key_id));
        Ok(())
    }

    pub fn note_peer(
        &self,
        peer_agent_id: String,
        peer_public_key_b64: String,
    ) -> Result<String, String> {
        let spki = decode_spki(&peer_public_key_b64)?;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "outbound-session-lock-poisoned".to_string())?;
        let session = guard
            .as_mut()
            .ok_or_else(|| "outbound-session-unbound".to_string())?;
        let fp = derive_pairing_fingerprint(&peer_agent_id, &spki);
        session.peer_agent_id = Some(peer_agent_id);
        session.peer_fingerprint = Some(fp.clone());
        if !matches!(
            session.peer_trust,
            TrustLevel::Verified | TrustLevel::Pinned
        ) {
            session.peer_trust = TrustLevel::Provisional;
        }
        if session.phase == SessionPhase::Discovering {
            session.phase = SessionPhase::HelloExchange;
        }
        Ok(fp)
    }

    /// Confirm out-of-band fingerprint (IBR-5). Claimed value must match
    /// the Rust-derived peer fingerprint already latched by `note_peer`.
    pub fn confirm_peer_fingerprint(&self, claimed: String) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "outbound-session-lock-poisoned".to_string())?;
        let session = guard
            .as_mut()
            .ok_or_else(|| "outbound-session-unbound".to_string())?;
        let expected = session
            .peer_fingerprint
            .as_deref()
            .ok_or_else(|| "peer-fingerprint-unknown".to_string())?;
        if !fingerprints_match(&claimed, expected) {
            return Err("peer-fingerprint-mismatch".into());
        }
        if session.peer_trust == TrustLevel::Changed {
            return Err("silent-retrust-forbidden".into());
        }
        session.peer_trust = TrustLevel::Verified;
        if matches!(
            session.phase,
            SessionPhase::HelloExchange | SessionPhase::Discovering
        ) {
            session.phase = SessionPhase::Verified;
        }
        Ok(())
    }

    pub fn set_mutual_consent(&self) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "outbound-session-lock-poisoned".to_string())?;
        let session = guard
            .as_mut()
            .ok_or_else(|| "outbound-session-unbound".to_string())?;
        if !matches!(
            session.peer_trust,
            TrustLevel::Verified | TrustLevel::Pinned
        ) {
            return Err("peer-not-verified".into());
        }
        session.consent_local = true;
        session.consent_peer = true;
        session.phase = SessionPhase::Consent;
        Ok(())
    }

    pub fn advance_to_chat(&self) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "outbound-session-lock-poisoned".to_string())?;
        let session = guard
            .as_mut()
            .ok_or_else(|| "outbound-session-unbound".to_string())?;
        if !(session.consent_local && session.consent_peer) {
            return Err("consent-required".into());
        }
        session.phase = SessionPhase::Chat;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "outbound-session-lock-poisoned".to_string())?;
        *guard = None;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<OutboundSession, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "outbound-session-lock-poisoned".to_string())?;
        guard
            .clone()
            .ok_or_else(|| "outbound-session-unbound".to_string())
    }
}

fn decode_spki(b64: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64.trim()))
        .map_err(|_| "invalid-peer-public-key".to_string())
}

/// Derive key id from SPKI for session bind (exported for IPC).
pub fn key_id_from_public_key_b64(public_key_b64: &str) -> Result<String, String> {
    let spki = decode_spki(public_key_b64)?;
    Ok(derive_key_id_from_spki(&spki))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirm_requires_note_peer_first() {
        let state = OutboundSessionState::new();
        state
            .bind_local("local".into(), Some("kid".into()))
            .unwrap();
        let err = state
            .confirm_peer_fingerprint("ABCDEF".into())
            .unwrap_err();
        assert_eq!(err, "peer-fingerprint-unknown");
    }

    #[test]
    fn mutual_consent_requires_verified() {
        let state = OutboundSessionState::new();
        state.bind_local("local".into(), None).unwrap();
        let err = state.set_mutual_consent().unwrap_err();
        assert_eq!(err, "peer-not-verified");
    }
}
