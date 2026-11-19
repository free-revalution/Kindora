// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Kindora Desktop — Tauri 2 backend.
//!
//! V0.1 surface:
//!   - `lan_*` commands: UDP discovery + TCP message transport
//!   - `secret_*` commands: OS keychain via `keyring` crate (LLM API keys)
//!   - `agent_key_*` commands: OS keychain, agent long-term private key
//!     (Phase A / A1)
//!
//! Note: the `tauri-plugin-sql` plugin is registered below. Since
//! Phase D / D1 the frontend talks to it directly through the plugin's
//! own IPC commands (`plugin:sql|load|execute|select|close`); the
//! capability file already grants them. The frontend only ever opens
//! `sqlite:kindora.db` — see `apps/desktop/src/lib/tauri-sql-executor.ts`.
//! No `sqlite_*` commands are defined *in this crate*; the plugin's
//! commands are used as-is.

use std::time::{SystemTime, UNIX_EPOCH};

mod authorization;
mod confirmer;
mod credential_shape;
mod db;
mod db_path;
mod envelope;
mod fingerprint;
mod jcs;
mod keychain;
mod keyring_migration;
mod lan;
mod llm;
mod llm_http;
mod mla_tests;
mod native_confirm;
mod outbound_session;
mod secrets;
mod sensitive_guard;
mod session;
mod trust_store;

#[cfg(test)]
mod disable_list_tests;

// Re-export scaffolding for later P0-2A tasks / cross-language tests.
#[doc(hidden)]
pub use credential_shape::looks_like_credential;
#[doc(hidden)]
pub use jcs::{canonicalize as jcs_canonicalize, canonicalize_to_bytes as jcs_canonicalize_to_bytes};
#[doc(hidden)]
pub use llm_http::{build_llm_http_client, LlmHttpError};
#[doc(hidden)]
pub use native_confirm::info_level as native_confirm_info_level;
pub use authorization::{
    AuthorizationContext, AuthorizationError, SendGrant, SignedEnvelopeParts,
    DEFAULT_GRANT_TTL_MS, DEFAULT_SEND_QUOTA,
};
pub use authorization::agent_sign_envelope as authorize_outbound_envelope;
pub use confirmer::{ConfirmError, MockConfirmer, RfdConfirmer, UserConfirmer};
pub use fingerprint::{
    crockford_base32, derive_pairing_fingerprint, fingerprints_match, CROCKFORD_ALPHABET,
    PAIRING_FINGERPRINT_LENGTH,
};
pub use sensitive_guard::{reject_if_sensitive, SensitiveGuardError};
pub use session::{
    InboundFrameProcessor, SessionError, SessionPhase, ALL_MESSAGE_TYPES,
};
pub use trust_store::{PeerTrustRecord, TrustLevel, TrustStore, TrustStoreError};

// Re-export the LAN transport surface for the in-tree integration test
// (`tests/lan_e2e.rs`) and for any future external integration tests
// that want to drive the production LanState without going through
// the Tauri command layer.
#[doc(hidden)]
pub use lan::{HostInfo, LanError, LanState, PeerInfo};
// The two error types are part of the crate's public API, not just
// internal plumbing: the `kind` / message contract they carry is
// mirrored by the TypeScript `AgentKeyErrorKind` union
// (`apps/desktop/src/lib/tauri-agent-keychain.ts`). Publishing them
// keeps that taxonomy symmetric on both sides of the IPC boundary.
pub use secrets::{AgentKeyError, SecretError};

pub struct MlaGrantState {
    pub grant: std::sync::Mutex<Option<SendGrant>>,
}

impl MlaGrantState {
    pub fn new() -> Self {
        Self {
            grant: std::sync::Mutex::new(None),
        }
    }
}

/// P0-2B / B1 — optional Rust-owned SQLite pool (plugin path still active).
pub struct DbPoolState {
    pub pool: std::sync::Mutex<Option<sqlx::SqlitePool>>,
    pub resolve: std::sync::Mutex<Option<db::DbResolveResult>>,
}

impl DbPoolState {
    pub fn new() -> Self {
        Self {
            pool: std::sync::Mutex::new(None),
            resolve: std::sync::Mutex::new(None),
        }
    }
}

pub struct AppState {
    pub lan: LanState,
    pub mla: MlaGrantState,
    pub outbound: outbound_session::OutboundSessionState,
    pub db: DbPoolState,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            lan: LanState::new(),
            mla: MlaGrantState::new(),
            outbound: outbound_session::OutboundSessionState::new(),
            db: DbPoolState::new(),
        }
    }
}

/// Commands exposed to the WebView — keep in sync with `invoke_handler!`.
pub fn registered_webview_commands() -> &'static [&'static str] {
    const COMMANDS: &[&str] = &[
        "lan_host_start",
        "lan_host_status",
        "lan_host_linked",
        "lan_host_poll",
        "lan_host_send",
        "lan_host_stop",
        "lan_join_discover",
        "lan_join_connect",
        "lan_join_poll",
        "lan_join_send",
        "lan_join_disconnect",
        "secret_set",
        "secret_delete",
        "secret_exists",
        "llm_chat",
        "llm_test_connection",
        "agent_key_store",
        "agent_key_exists",
        "agent_key_delete",
        "agent_key_matches_public_key",
        "agent_sign_envelope",
        "agent_local_fingerprint",
        "agent_verify_peer_fingerprint",
        "agent_migrate_keychain",
        "session_bind_local",
        "session_note_peer",
        "session_confirm_peer_fingerprint",
        "session_set_mutual_consent",
        "session_advance_chat",
        "session_clear",
        "db_resolve",
        "db_status",
    ];
    COMMANDS
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- LAN commands ----------

#[tauri::command]
async fn lan_host_start(
    state: tauri::State<'_, AppState>,
    code: String,
    agent_id: String,
    display_name: String,
) -> Result<HostInfo, LanError> {
    state.lan.host_start(code, agent_id, display_name).await
}

#[tauri::command]
async fn lan_host_status(state: tauri::State<'_, AppState>) -> Result<Option<HostInfo>, LanError> {
    state.lan.host_status().await
}

#[tauri::command]
async fn lan_host_linked(state: tauri::State<'_, AppState>) -> Result<bool, LanError> {
    Ok(state.lan.host_linked().await)
}

#[tauri::command]
async fn lan_host_poll(state: tauri::State<'_, AppState>) -> Result<Vec<String>, LanError> {
    state.lan.host_poll().await
}

#[tauri::command]
async fn lan_host_send(state: tauri::State<'_, AppState>, message: String) -> Result<(), LanError> {
    state.lan.host_send(message).await
}

#[tauri::command]
async fn lan_host_stop(state: tauri::State<'_, AppState>) -> Result<(), LanError> {
    state.lan.host_stop().await
}

#[tauri::command]
async fn lan_join_discover(
    state: tauri::State<'_, AppState>,
    code: String,
    timeout_ms: Option<u64>,
) -> Result<Vec<PeerInfo>, LanError> {
    state
        .lan
        .join_discover(code, timeout_ms.unwrap_or(2500))
        .await
}

#[tauri::command]
async fn lan_join_connect(
    state: tauri::State<'_, AppState>,
    peer_ip: String,
    peer_port: u16,
) -> Result<PeerInfo, LanError> {
    state.lan.join_connect(peer_ip, peer_port).await
}

#[tauri::command]
async fn lan_join_poll(state: tauri::State<'_, AppState>) -> Result<Vec<String>, LanError> {
    state.lan.join_poll().await
}

#[tauri::command]
async fn lan_join_send(state: tauri::State<'_, AppState>, message: String) -> Result<(), LanError> {
    state.lan.join_send(message).await
}

#[tauri::command]
async fn lan_join_disconnect(state: tauri::State<'_, AppState>) -> Result<(), LanError> {
    state.lan.join_disconnect().await
}

// ---------- Secret commands ----------

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), SecretError> {
    secrets::secret_set(key, value)
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), SecretError> {
    secrets::secret_delete(key)
}

/// Existence only — never returns plaintext (P0-2A / A5 / MB-1).
#[tauri::command]
fn secret_exists(key: String) -> Result<bool, SecretError> {
    secrets::secret_exists(key)
}

// ---------- LLM commands (P0-2A / A-LLM) ----------

#[tauri::command]
async fn llm_chat(
    provider: String,
    model: String,
    base_url: Option<String>,
    messages: Vec<llm::LlmChatMessage>,
) -> Result<llm::LlmChatResponse, llm::LlmError> {
    llm::llm_chat_impl(provider, model, base_url, messages).await
}

#[tauri::command]
async fn llm_test_connection(
    provider: String,
    model: String,
    base_url: Option<String>,
    api_key: Option<String>,
) -> llm::LlmTestConnectionResponse {
    llm::llm_test_connection_impl(provider, model, base_url, api_key).await
}

// ---------- Agent identity key commands (Phase A / A1 + P0-2A) ----------

#[tauri::command]
fn agent_key_store(value: String) -> Result<(), AgentKeyError> {
    secrets::agent_key_store(value)
}

/// Existence only — private key never returned to WebView (SEC-01 / MB).
#[tauri::command]
fn agent_key_exists() -> Result<bool, AgentKeyError> {
    secrets::agent_key_exists()
}

#[tauri::command]
fn agent_key_delete() -> Result<(), AgentKeyError> {
    secrets::agent_key_delete()
}

/// Confirm OS-keychain key matches the recorded public key (D4-safe).
#[tauri::command]
fn agent_key_matches_public_key(public_key_b64: String) -> Result<bool, AgentKeyError> {
    secrets::agent_key_matches_public_key(public_key_b64)
}

fn rust_envelope_signer(bytes: &[u8]) -> Result<String, AuthorizationError> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    secrets::agent_sign(b64).map_err(|_| AuthorizationError::SigningFailed)
}

/// Sign an outbound KSA envelope with Rust authorisation gates (A8 / A-MLA).
///
/// WebView may only submit `{ typeName, payload }`. Phase / trust /
/// consent / local identity are read from `AppState.outbound` (D4 / A10).
#[tauri::command]
fn agent_sign_envelope(
    state: tauri::State<'_, AppState>,
    type_name: String,
    payload: serde_json::Value,
) -> Result<SignedEnvelopeParts, String> {
    use crate::authorization::agent_sign_envelope as authorize_and_sign;
    let snap = state.outbound.snapshot()?;
    let ctx = AuthorizationContext {
        phase: snap.phase,
        local_agent_id: snap.local_agent_id,
        peer_agent_id: snap.peer_agent_id,
        peer_trust: snap.peer_trust,
        consent_local: snap.consent_local,
        consent_peer: snap.consent_peer,
        local_key_id: snap.local_key_id,
    };

    let mut grant_guard = state
        .mla
        .grant
        .lock()
        .map_err(|_| "mla-grant-lock-poisoned".to_string())?;

    let mla_confirmed = if session::requires_mla_grant(&type_name) {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let active = grant_guard
            .as_ref()
            .map(|g| g.active(now_ms))
            .unwrap_or(false);
        if active {
            true
        } else {
            let confirmer = RfdConfirmer::new();
            let summary = format!("Send {type_name} message?");
            match confirmer.confirm_send(&summary) {
                Ok(true) => {
                    *grant_guard = Some(SendGrant::fresh(now_ms));
                    true
                }
                Ok(false) => return Err("mla-denied".into()),
                Err(e) => return Err(e.to_string()),
            }
        }
    } else {
        false
    };

    authorize_and_sign(
        &type_name,
        payload,
        &ctx,
        &mut grant_guard,
        mla_confirmed,
        &rust_envelope_signer,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn session_bind_local(
    state: tauri::State<'_, AppState>,
    local_agent_id: String,
    public_key_b64: Option<String>,
) -> Result<(), String> {
    let key_id = match public_key_b64 {
        Some(pk) => Some(outbound_session::key_id_from_public_key_b64(&pk)?),
        None => None,
    };
    state.outbound.bind_local(local_agent_id, key_id)
}

#[tauri::command]
fn session_note_peer(
    state: tauri::State<'_, AppState>,
    peer_agent_id: String,
    peer_public_key_b64: String,
) -> Result<String, String> {
    state.outbound.note_peer(peer_agent_id, peer_public_key_b64)
}

#[tauri::command]
fn session_confirm_peer_fingerprint(
    state: tauri::State<'_, AppState>,
    claimed: String,
) -> Result<(), String> {
    state.outbound.confirm_peer_fingerprint(claimed)
}

#[tauri::command]
fn session_set_mutual_consent(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.outbound.set_mutual_consent()
}

#[tauri::command]
fn session_advance_chat(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.outbound.advance_to_chat()
}

#[tauri::command]
fn session_clear(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let _ = state.mla.grant.lock().map(|mut g| *g = None);
    state.outbound.clear()
}

/// Local pairing fingerprint (Rust-authoritative — A6 / A10).
#[tauri::command]
fn agent_local_fingerprint(agent_id: String, public_key_b64: String) -> Result<String, String> {
    use base64::Engine;
    let spki = base64::engine::general_purpose::STANDARD
        .decode(public_key_b64.trim())
        .map_err(|e| format!("invalid public key base64: {e}"))?;
    Ok(derive_pairing_fingerprint(&agent_id, &spki))
}

/// Compare claimed fingerprint with derived (case/dash insensitive).
#[tauri::command]
fn agent_verify_peer_fingerprint(claimed: String, expected: String) -> bool {
    fingerprints_match(&claimed, &expected)
}

/// Run M1 keychain migration (HD-1 abort on conflict; HD-2 confirm).
#[tauri::command]
fn agent_migrate_keychain() -> Result<String, String> {
    use keychain::OsKeychain;
    use keyring_migration::{migrate_agent_key_m1, MigrationOutcome};
    let kc = OsKeychain;
    let confirmer = RfdConfirmer::new();
    match migrate_agent_key_m1(&kc, Some(&confirmer)) {
        Ok(MigrationOutcome::NothingToMigrate) => Ok("nothing".into()),
        Ok(MigrationOutcome::AlreadyMigrated) => Ok("already".into()),
        Ok(MigrationOutcome::Migrated) => Ok("migrated".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// P0-2B / B0–B1 — resolve canonical DB path + open policy (no mutate).
#[tauri::command]
fn db_resolve(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<db::DbResolveResult, String> {
    use tauri::Manager;
    let config = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let result = db::resolve_db_layout(&config, &data).map_err(|e| e.to_string())?;
    if let Ok(mut guard) = state.db.resolve.lock() {
        *guard = Some(result.clone());
    }
    Ok(result)
}

/// P0-2B / B1 — whether Rust opened the SQLite pool at startup.
#[tauri::command]
fn db_status(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let opened = state
        .db
        .pool
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    let resolve = state
        .db
        .resolve
        .lock()
        .ok()
        .and_then(|g| g.clone());
    Ok(serde_json::json!({
        "rustPoolOpen": opened,
        "resolve": resolve,
    }))
}

// ---------- entry point ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Best-effort logger init; ignore if RUST_LOG is unset / logger already set.
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            lan_host_start,
            lan_host_status,
            lan_host_linked,
            lan_host_poll,
            lan_host_send,
            lan_host_stop,
            lan_join_discover,
            lan_join_connect,
            lan_join_poll,
            lan_join_send,
            lan_join_disconnect,
            secret_set,
            secret_delete,
            secret_exists,
            llm_chat,
            llm_test_connection,
            agent_key_store,
            agent_key_exists,
            agent_key_delete,
            agent_key_matches_public_key,
            agent_sign_envelope,
            agent_local_fingerprint,
            agent_verify_peer_fingerprint,
            agent_migrate_keychain,
            session_bind_local,
            session_note_peer,
            session_confirm_peer_fingerprint,
            session_set_mutual_consent,
            session_advance_chat,
            session_clear,
            db_resolve,
            db_status,
        ])
        .setup(|app| {
            // P0-2B / B1 — probe + open Rust SQLite pool when a Kindora
            // DB already exists. First-run create still belongs to the
            // TS plugin path until B2/B6 remove it; we never silent-create
            // over a broken legacy file (open_policy).
            use tauri::Manager;
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            let config = handle.path().app_config_dir().ok();
            let data = handle.path().app_data_dir().ok();
            if let (Some(config), Some(data)) = (config, data) {
                match db::resolve_db_layout(&config, &data) {
                    Ok(resolved) => {
                        if let Ok(mut g) = state.db.resolve.lock() {
                            *g = Some(resolved.clone());
                        }
                        if resolved.policy == "open-canonical" {
                            let path = std::path::PathBuf::from(&resolved.canonical);
                            let state_pool = app.state::<AppState>();
                            tauri::async_runtime::block_on(async move {
                                match db::open_existing(&path).await {
                                    Ok(pool) => {
                                        if let Ok(mut g) = state_pool.db.pool.lock() {
                                            *g = Some(pool);
                                        }
                                        log::info!(
                                            "kindora: Rust SQLite pool opened at {}",
                                            path.display()
                                        );
                                    }
                                    Err(e) => {
                                        log::warn!(
                                            "kindora: Rust SQLite open deferred ({e}); plugin path remains"
                                        );
                                    }
                                }
                            });
                        } else {
                            log::info!(
                                "kindora: Rust SQLite policy={} — pool not opened (plugin owns first-run/migrate)",
                                resolved.policy
                            );
                        }
                    }
                    Err(e) => {
                        log::warn!("kindora: db_resolve at startup failed: {e}");
                    }
                }
            }
            // Best-effort M1 keychain migration (HD-1/HD-2) at launch.
            let _ = agent_migrate_keychain();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
