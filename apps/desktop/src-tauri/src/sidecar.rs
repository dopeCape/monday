//! Spawn the bundled server as a Tauri sidecar (ADR 0005, ADR 0006, research 4).
//!
//! Port 0 and a fresh per-launch token in the environment; the server prints its bound
//! port once on stdout; the parent pid is passed so the server can watch us.

use std::sync::Mutex;

use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Serialize, Clone, Default)]
pub struct SidecarInfo {
    pub port: u16,
    pub token: String,
    pub running: bool,
}

#[derive(Default)]
pub struct SidecarState {
    pub info: Mutex<SidecarInfo>,
    pub child: Mutex<Option<CommandChild>>,
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Start the sidecar. Resolves once the server has printed its port, or errors.
pub async fn start(app: &AppHandle) -> Result<SidecarInfo, String> {
    let token = new_token();
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    // Bundled: <resource_dir>/resources/{pg,drizzle}. Dev: src-tauri/resources.
    let resources = app
        .path()
        .resource_dir()
        .map(|r| r.join("resources"))
        .ok()
        .filter(|r| r.join("pg").exists())
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));

    let mut cmd = app
        .shell()
        .sidecar("monday-server")
        .map_err(|e| e.to_string())?
        .env("PORT", "0")
        .env("MONDAY_MODE", "sidecar")
        .env("MONDAY_SIDECAR_TOKEN", &token)
        .env("MONDAY_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env("MONDAY_PARENT_PID", std::process::id().to_string())
        .env("MONDAY_RESOURCES_DIR", resources.to_string_lossy().to_string());
    // The user-held root key unlocks the Sidecar at boot (research 5). Without a
    // keychain the server starts locked and the UI offers the recovery file path.
    if let Some(key) = crate::rootkey::load_or_create()? {
        cmd = cmd.env("MONDAY_ROOT_KEY", key);
    }

    let (mut rx, child) = cmd.spawn().map_err(|e| e.to_string())?;
    let state = app.state::<SidecarState>();
    *state.child.lock().unwrap() = Some(child);

    // Wait for the single "listening on http://127.0.0.1:<port>" line.
    let mut port: Option<u16> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let s = String::from_utf8_lossy(&line);
                if let Some(idx) = s.rfind(':') {
                    if s.contains("listening on") {
                        if let Ok(p) = s[idx + 1..].trim().parse::<u16>() {
                            port = Some(p);
                            break;
                        }
                    }
                }
            }
            CommandEvent::Stderr(line) => {
                eprintln!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end());
            }
            CommandEvent::Terminated(t) => {
                return Err(format!("sidecar exited before listening (code {:?})", t.code));
            }
            _ => {}
        }
    }
    let port = port.ok_or_else(|| "sidecar closed stdout without a port".to_string())?;

    // Keep draining output so the child never blocks on a full pipe.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stderr(line) = event {
                eprintln!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end());
            }
        }
    });

    let info = SidecarInfo { port, token, running: true };
    *state.info.lock().unwrap() = info.clone();
    Ok(info)
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    state.info.lock().unwrap().running = false;
}

#[tauri::command]
pub fn sidecar_info(app: AppHandle) -> SidecarInfo {
    app.state::<SidecarState>().info.lock().unwrap().clone()
}
