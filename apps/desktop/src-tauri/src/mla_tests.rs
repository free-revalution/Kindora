//! MLA test matrix — P0-2A / A-MLA-T (§10.1).
//!
//! Exhaust / expire / revoke / replay / concurrent consume.

#[cfg(test)]
mod tests {
    use crate::authorization::{
        agent_sign_envelope, AuthorizationContext, AuthorizationError, SendGrant,
        DEFAULT_SEND_QUOTA,
    };
    use crate::session::SessionPhase;
    use crate::trust_store::TrustLevel;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn ctx() -> AuthorizationContext {
        AuthorizationContext {
            phase: SessionPhase::Chat,
            local_agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            peer_agent_id: Some("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into()),
            peer_trust: TrustLevel::Verified,
            consent_local: true,
            consent_peer: true,
            local_key_id: Some("kid".into()),
        }
    }

    fn signer() -> Box<crate::authorization::SignerFn> {
        Box::new(|_bytes| {
            Ok("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                .to_string())
        })
    }

    #[test]
    fn grant_exhausts_after_quota() {
        let mut grant = Some(SendGrant {
            remaining: 2,
            expires_unix_ms: u64::MAX,
        });
        let s = signer();
        for _ in 0..2 {
            agent_sign_envelope(
                "chat_message",
                json!({"text": "hi"}),
                &ctx(),
                &mut grant,
                true,
                s.as_ref(),
            )
            .unwrap();
        }
        let err = agent_sign_envelope(
            "chat_message",
            json!({"text": "hi"}),
            &ctx(),
            &mut grant,
            true,
            s.as_ref(),
        )
        .unwrap_err();
        assert_eq!(err, AuthorizationError::SendGrantExhausted);
    }

    #[test]
    fn grant_expires() {
        let mut grant = Some(SendGrant {
            remaining: DEFAULT_SEND_QUOTA,
            expires_unix_ms: 1, // long expired
        });
        let err = agent_sign_envelope(
            "chat_message",
            json!({"text": "hi"}),
            &ctx(),
            &mut grant,
            true,
            signer().as_ref(),
        )
        .unwrap_err();
        assert_eq!(err, AuthorizationError::SendGrantExpired);
    }

    #[test]
    fn revoke_clears_grant() {
        let mut grant: Option<SendGrant> = None; // revoked
        let err = agent_sign_envelope(
            "chat_message",
            json!({"text": "hi"}),
            &ctx(),
            &mut grant,
            true,
            signer().as_ref(),
        )
        .unwrap_err();
        assert_eq!(err, AuthorizationError::MlaGrantRequired);
    }

    #[test]
    fn concurrent_consume_never_exceeds_quota() {
        let grant = Arc::new(Mutex::new(Some(SendGrant {
            remaining: 5,
            expires_unix_ms: u64::MAX,
        })));
        let mut handles = vec![];
        for _ in 0..10 {
            let g = Arc::clone(&grant);
            handles.push(std::thread::spawn(move || {
                let mut guard = g.lock().unwrap();
                agent_sign_envelope(
                    "chat_message",
                    json!({"text": "hi"}),
                    &ctx(),
                    &mut *guard,
                    true,
                    signer().as_ref(),
                )
                .ok()
            }));
        }
        let ok_count = handles
            .into_iter()
            .filter_map(|h| h.join().ok().flatten())
            .count();
        assert!(ok_count <= 5, "ok_count={ok_count}");
        let remaining = grant.lock().unwrap().as_ref().map(|g| g.remaining).unwrap_or(0);
        assert_eq!(ok_count + remaining as usize, 5);
    }
}
