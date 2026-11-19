//! P0-2A / A-12 — WebView command surface deny-list regression tests.

#[cfg(test)]
mod tests {
    use crate::registered_webview_commands;

    const FORBIDDEN_COMMANDS: &[&str] = &[
        "secret_get",
        "secret_list",
        "agent_key_get",
        // D4 — arbitrary-byte signer must not be on the WebView surface.
        "agent_sign",
    ];

    /// T1: the only signing IPC is gated `agent_sign_envelope`.
    const ALLOWED_SIGNING_COMMANDS: &[&str] = &["agent_sign_envelope"];

    #[test]
    fn t1_signing_surface_is_only_agent_sign_envelope() {
        let registered = registered_webview_commands();
        let signing: Vec<_> = registered
            .iter()
            .filter(|name| name.contains("sign"))
            .copied()
            .collect();
        assert_eq!(
            signing,
            ALLOWED_SIGNING_COMMANDS,
            "WebView must only expose agent_sign_envelope (D4)"
        );
    }

    #[test]
    fn t2_secret_and_key_get_not_registered() {
        let registered = registered_webview_commands();
        for forbidden in FORBIDDEN_COMMANDS {
            assert!(
                !registered.contains(forbidden),
                "`{forbidden}` must not be exposed to the WebView"
            );
        }
    }

    #[test]
    fn t3_no_grant_ipc_commands() {
        let registered = registered_webview_commands();
        for name in registered {
            let lower = name.to_ascii_lowercase();
            assert!(
                !lower.contains("send_grant"),
                "must not expose SendGrant via IPC (`{name}`)"
            );
            assert!(
                !lower.contains("mla_confirm"),
                "must not expose MLA confirmation bypass (`{name}`)"
            );
        }
    }

    #[test]
    fn t4_session_auth_commands_present() {
        let registered = registered_webview_commands();
        for required in [
            "session_bind_local",
            "session_note_peer",
            "session_confirm_peer_fingerprint",
            "session_set_mutual_consent",
            "agent_key_matches_public_key",
        ] {
            assert!(
                registered.contains(&required),
                "`{required}` must be registered"
            );
        }
    }
}
