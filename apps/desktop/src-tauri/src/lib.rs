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

mod lan;
mod secrets;

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

pub struct AppState {
    pub lan: LanState,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            lan: LanState::new(),
        }
    }
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
fn secret_get(key: String) -> Result<Option<String>, SecretError> {
    secrets::secret_get(key)
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), SecretError> {
    secrets::secret_delete(key)
}

#[tauri::command]
fn secret_list() -> Result<Vec<String>, SecretError> {
    secrets::secret_list()
}

// ---------- Agent identity key commands (Phase A / A1) ----------

#[tauri::command]
fn agent_key_store(value: String) -> Result<(), AgentKeyError> {
    secrets::agent_key_store(value)
}

#[tauri::command]
fn agent_key_get() -> Result<Option<String>, AgentKeyError> {
    secrets::agent_key_get()
}

#[tauri::command]
fn agent_key_exists() -> Result<bool, AgentKeyError> {
    secrets::agent_key_exists()
}

#[tauri::command]
fn agent_key_delete() -> Result<(), AgentKeyError> {
    secrets::agent_key_delete()
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
            secret_get,
            secret_delete,
            secret_list,
            agent_key_store,
            agent_key_get,
            agent_key_exists,
            agent_key_delete,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
