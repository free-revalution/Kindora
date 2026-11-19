//! Outbound envelope authorization — P0-2A / A8 (five gates).

use crate::envelope::{
    build_signing_input, SignableEnvelope, SIGNATURE_ALG, SIGNING_SCHEME,
};
use crate::sensitive_guard::{reject_if_sensitive, SensitiveGuardError};
use crate::session::{requires_mla_grant, requires_verified_trust, SessionPhase, ALL_MESSAGE_TYPES};
use crate::trust_store::TrustLevel;
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const DEFAULT_SEND_QUOTA: u32 = 5;
pub const DEFAULT_GRANT_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct SendGrant {
    pub remaining: u32,
    pub expires_unix_ms: u64,
}

impl SendGrant {
    pub fn fresh(now_ms: u64) -> Self {
        Self {
            remaining: DEFAULT_SEND_QUOTA,
            expires_unix_ms: now_ms.saturating_add(DEFAULT_GRANT_TTL_MS),
        }
    }

    pub fn active(&self, now_ms: u64) -> bool {
        self.remaining > 0 && now_ms <= self.expires_unix_ms
    }
}

#[derive(Debug, Clone)]
pub struct AuthorizationContext {
    pub phase: SessionPhase,
    pub local_agent_id: String,
    pub peer_agent_id: Option<String>,
    pub peer_trust: TrustLevel,
    pub consent_local: bool,
    pub consent_peer: bool,
    pub local_key_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedEnvelopeParts {
    pub protocol: String,
    pub version: String,
    pub message_id: String,
    pub timestamp: String,
    pub type_name: String,
    pub sender: String,
    pub recipient: String,
    pub payload: Value,
    pub signature: Value,
}

pub type SignerFn = dyn Fn(&[u8]) -> Result<String, AuthorizationError>;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthorizationError {
    #[error("type-not-whitelisted")]
    TypeNotWhitelisted,
    #[error("type-not-allowed-in-phase")]
    TypeNotAllowedInPhase,
    #[error("peer-not-verified")]
    PeerNotVerified,
    #[error("consent-required")]
    ConsentRequired,
    #[error("send-grant-exhausted")]
    SendGrantExhausted,
    #[error("send-grant-expired")]
    SendGrantExpired,
    #[error("mla-grant-required")]
    MlaGrantRequired,
    #[error("sensitive-field-detected")]
    SensitiveField,
    #[error("signing-failed")]
    SigningFailed,
    #[error("session-closed")]
    SessionClosed,
}

impl From<SensitiveGuardError> for AuthorizationError {
    fn from(_: SensitiveGuardError) -> Self {
        AuthorizationError::SensitiveField
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// UTC `YYYY-MM-DDTHH:MM:SS.mmmZ` without extra dependencies.
fn iso8601_utc_now_ms() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    let total_ms = duration.as_millis();
    let secs = (total_ms / 1000) as i64;
    let millis = (total_ms % 1000) as u32;
    let (y, mo, d, h, mi, s) = unix_secs_to_utc(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

fn unix_secs_to_utc(mut secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let s = (secs % 60) as u32;
    secs /= 60;
    let mi = (secs % 60) as u32;
    secs /= 60;
    let h = (secs % 24) as u32;
    let mut days = secs / 24;
    let mut year = 1970i32;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let mut month = 1u32;
    loop {
        let dim = days_in_month(year, month);
        if days < dim {
            break;
        }
        days -= dim;
        month += 1;
    }
  let day = days as u32 + 1;
    (year, month, day, h, mi, s)
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i32, month: u32) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

fn recipient_for(type_name: &str, peer_agent_id: &Option<String>) -> String {
    if type_name == "hello" {
        String::new()
    } else {
        peer_agent_id.clone().unwrap_or_default()
    }
}

fn phase_allows_outbound(phase: SessionPhase, type_name: &str) -> bool {
    if phase == SessionPhase::Closed {
        return type_name == "disconnect";
    }
    if !ALL_MESSAGE_TYPES.contains(&type_name) {
        return false;
    }
    match phase {
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
        SessionPhase::Closed => false,
    }
}

fn trust_allows_outbound(ctx: &AuthorizationContext, type_name: &str) -> Result<(), AuthorizationError> {
    if requires_verified_trust(type_name) {
        match ctx.peer_trust {
            TrustLevel::Verified | TrustLevel::Pinned => Ok(()),
            _ => Err(AuthorizationError::PeerNotVerified),
        }
    } else {
        Ok(())
    }
}

fn consent_allows_outbound(ctx: &AuthorizationContext, type_name: &str) -> Result<(), AuthorizationError> {
    if matches!(
        type_name,
        "chat_message" | "icebreaker_request" | "icebreaker_response"
    ) {
        if !(ctx.consent_local && ctx.consent_peer) {
            return Err(AuthorizationError::ConsentRequired);
        }
    }
    Ok(())
}

fn consume_grant(grant: &mut SendGrant, now_ms: u64) -> Result<(), AuthorizationError> {
    if now_ms > grant.expires_unix_ms {
        return Err(AuthorizationError::SendGrantExpired);
    }
    if grant.remaining == 0 {
        return Err(AuthorizationError::SendGrantExhausted);
    }
    grant.remaining -= 1;
    Ok(())
}

/// Pure authorization + signing pipeline (private key stays in `signer` callback).
pub fn agent_sign_envelope(
    type_name: &str,
    payload: Value,
    ctx: &AuthorizationContext,
    grant: &mut Option<SendGrant>,
    mla_confirmed: bool,
    signer: &SignerFn,
) -> Result<SignedEnvelopeParts, AuthorizationError> {
    if ctx.phase == SessionPhase::Closed {
        return Err(AuthorizationError::SessionClosed);
    }

    // Gate 1 — type whitelist
    if !ALL_MESSAGE_TYPES.contains(&type_name) {
        return Err(AuthorizationError::TypeNotWhitelisted);
    }

    // Gate 7 (partial) — sensitive payload
    reject_if_sensitive(&payload)?;

    // Gate 2 — phase matrix
    if !phase_allows_outbound(ctx.phase, type_name) {
        return Err(AuthorizationError::TypeNotAllowedInPhase);
    }

    // Gate 3 — verified / pinned for chat & consent family
    trust_allows_outbound(ctx, type_name)?;
    consent_allows_outbound(ctx, type_name)?;

    let now_ms = now_unix_ms();

    // Gate 5 — MLA grant required (initial confirm flag + active grant)
    if requires_mla_grant(type_name) {
        if !mla_confirmed {
            return Err(AuthorizationError::MlaGrantRequired);
        }
        let g = grant.as_mut().ok_or(AuthorizationError::MlaGrantRequired)?;
        if !g.active(now_ms) {
            if now_ms > g.expires_unix_ms {
                return Err(AuthorizationError::SendGrantExpired);
            }
            return Err(AuthorizationError::SendGrantExhausted);
        }
        // Gate 4 — consume one unit per send
        consume_grant(g, now_ms)?;
    }

    let message_id = Uuid::new_v4().to_string();
    let timestamp = iso8601_utc_now_ms();
    let recipient = recipient_for(type_name, &ctx.peer_agent_id);

    let env = SignableEnvelope {
        protocol: "KSA".into(),
        version: "0.1".into(),
        message_id: message_id.clone(),
        timestamp: timestamp.clone(),
        type_name: type_name.to_string(),
        sender: ctx.local_agent_id.clone(),
        payload: payload.clone(),
    };

    let signing_bytes =
        build_signing_input(&env, &recipient).map_err(|_| AuthorizationError::SigningFailed)?;
    let sig_value = signer(&signing_bytes)?;

    let key_id = ctx.local_key_id.clone().unwrap_or_default();

    Ok(SignedEnvelopeParts {
        protocol: env.protocol,
        version: env.version,
        message_id,
        timestamp,
        type_name: type_name.to_string(),
        sender: ctx.local_agent_id.clone(),
        recipient,
        payload,
        signature: json!({
            "alg": SIGNATURE_ALG,
            "signedFields": SIGNING_SCHEME,
            "keyId": key_id,
            "value": sig_value,
        }),
    })
}

impl AuthorizationContext {
    pub fn with_local_key_id(mut self, key_id: String) -> Self {
        self.local_key_id = Some(key_id);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionPhase;
    use serde_json::json;

    fn base_ctx(phase: SessionPhase, trust: TrustLevel) -> AuthorizationContext {
        AuthorizationContext {
            phase,
            local_agent_id: "local-agent".into(),
            peer_agent_id: Some("peer-agent".into()),
            peer_trust: trust,
            consent_local: true,
            consent_peer: true,
            local_key_id: Some("kid".into()),
        }
    }

    #[test]
    fn gate2_rejects_chat_in_verified_phase() {
        let ctx = base_ctx(SessionPhase::Verified, TrustLevel::Verified);
        let mut grant = Some(SendGrant::fresh(now_unix_ms()));
        let err = agent_sign_envelope(
            "chat_message",
            json!({"text": "hi"}),
            &ctx,
            &mut grant,
            true,
            &|_| Ok("sig".into()),
        )
        .unwrap_err();
        assert_eq!(err, AuthorizationError::TypeNotAllowedInPhase);
    }

    #[test]
    fn gate3_requires_verified_for_consent() {
        let ctx = base_ctx(SessionPhase::Consent, TrustLevel::Provisional);
        let mut grant = None;
        let err = agent_sign_envelope(
            "consent_accept",
            json!({}),
            &ctx,
            &mut grant,
            false,
            &|_| Ok("sig".into()),
        )
        .unwrap_err();
        assert_eq!(err, AuthorizationError::PeerNotVerified);
    }

    #[test]
    fn gate4_consumes_send_grant() {
        let ctx = base_ctx(SessionPhase::Chat, TrustLevel::Verified);
        let mut grant = Some(SendGrant {
            remaining: 1,
            expires_unix_ms: now_unix_ms() + 60_000,
        });
        agent_sign_envelope(
            "chat_message",
            json!({"text": "one"}),
            &ctx,
            &mut grant,
            true,
            &|_| Ok("sig".into()),
        )
        .unwrap();
        assert_eq!(grant.as_ref().unwrap().remaining, 0);
        let err = agent_sign_envelope(
            "chat_message",
            json!({"text": "two"}),
            &ctx,
            &mut grant,
            true,
            &|_| Ok("sig".into()),
        )
        .unwrap_err();
        assert_eq!(err, AuthorizationError::SendGrantExhausted);
    }

    #[test]
    fn gate5_requires_mla_confirmation() {
        let ctx = base_ctx(SessionPhase::Chat, TrustLevel::Verified);
        let mut grant = Some(SendGrant::fresh(now_unix_ms()));
        let err = agent_sign_envelope(
            "chat_message",
            json!({"text": "hi"}),
            &ctx,
            &mut grant,
            false,
            &|_| Ok("sig".into()),
        )
        .unwrap_err();
        assert_eq!(err, AuthorizationError::MlaGrantRequired);
    }
}