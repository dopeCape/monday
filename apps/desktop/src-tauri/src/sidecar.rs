//! The app's side of the Sidecar (ADR 0005, ADR 0006, ADR 0013). The Sidecar is
//! a background service that keeps running when the window closes: at launch
//! the app finds it (or starts it) through `service::ensure`, unlocks it with
//! the root key from the keychain over loopback, and hands the webview its
//! port and the stable loopback token. Closing the window leaves it running;
//! Settings › Sync server stops or restarts it on purpose.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::service::{self, install, launch, runtime, token};

#[derive(Serialize, Clone, Default)]
pub struct SidecarInfo {
    pub port: u16,
    pub token: String,
    pub running: bool,
}

#[derive(Default)]
pub struct SidecarState {
    pub info: Mutex<SidecarInfo>,
    /// One start, stop or restart at a time.
    pub busy: Mutex<()>,
}

/// How long a start may take: a first run initialises Postgres and migrates.
const READY_DEADLINE: Duration = Duration::from_secs(150);

/// Where everything is: the data directory, the bundled server and its resources.
struct Paths {
    data_dir: PathBuf,
    bundled_exe: PathBuf,
    resources: PathBuf,
}

fn paths(app: &AppHandle) -> Result<Paths, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    // Bundled: <resource_dir>/resources/{pg,drizzle,server-build}. Dev: src-tauri/resources.
    let resources = app
        .path()
        .resource_dir()
        .map(|r| r.join("resources"))
        .ok()
        .filter(|r| r.join("pg").exists())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    // The shell plugin's sidecar lives beside the app's executable.
    let bundled_exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or_else(|| "no directory for the app".to_string())?
        .join(install::exe_name());
    Ok(Paths {
        data_dir,
        bundled_exe,
        resources,
    })
}

fn host(app: &AppHandle) -> Result<service::RealHost, String> {
    let p = paths(app)?;
    let token = token::load_or_create(&token::Keychain, &p.data_dir, token::generate)?;
    let build = install::bundled_build(&p.resources, &p.bundled_exe)?;
    let launcher = launch::for_this_machine(&p.data_dir);
    Ok(service::RealHost {
        data_dir: p.data_dir,
        token,
        bundled_exe: p.bundled_exe,
        resources: p.resources,
        build,
        launcher,
        began: Instant::now(),
    })
}

/// Hands the root key to a locked service over loopback; the key never touches disk.
fn unlock(port: u16, token: &str) {
    let locked = service::service_status(port, token)
        .ok()
        .and_then(|v| v.get("unlocked").and_then(|u| u.as_bool()))
        .map(|u| !u)
        .unwrap_or(false);
    if !locked {
        return;
    }
    match crate::rootkey::load_or_create() {
        Ok(Some(key)) => {
            let body = serde_json::json!({ "rootKey": key }).to_string();
            match service::http::request(
                port,
                "POST",
                "/unlock",
                token,
                Some(&body),
                Duration::from_secs(10),
            ) {
                Ok(res) if res.status == 200 => {}
                Ok(res) => eprintln!("[monday] the Sidecar refused the root key ({})", res.status),
                Err(e) => eprintln!("[monday] could not unlock the Sidecar: {e}"),
            }
        }
        // No keychain: the Sidecar stays locked and the UI offers the recovery file.
        Ok(None) => {}
        Err(e) => eprintln!("[monday] root key: {e}"),
    }
}

/// Finds or starts the service, unlocks it, and returns what the webview needs.
fn ensure_blocking(app: &AppHandle) -> Result<SidecarInfo, String> {
    let state = app.state::<SidecarState>();
    let _one = state.busy.lock().unwrap_or_else(|e| e.into_inner());
    let h = host(app)?;
    let port = service::ensure(&h, &h.build, READY_DEADLINE)?;
    unlock(port, &h.token);
    // The login start follows the installed copy of this build.
    if h.launcher.login_start_enabled() {
        if let Ok(spec) = h.installed_spec() {
            let _ = h.launcher.set_login_start(&spec, true);
        }
    }
    install::prune(&h.data_dir, &h.build);
    let info = SidecarInfo {
        port,
        token: h.token.clone(),
        running: true,
    };
    *state.info.lock().unwrap() = info.clone();
    Ok(info)
}

/// Stops the running service on purpose (Settings, Stop).
fn stop_blocking(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    let _one = state.busy.lock().unwrap_or_else(|e| e.into_inner());
    let p = paths(app)?;
    let token = token::load_or_create(&token::Keychain, &p.data_dir, token::generate)?;
    if let Some((rt, _)) = runtime::read(&p.data_dir) {
        service::stop_service(&rt, &token, true, &launch::Places::for_user(&p.data_dir))?;
        runtime::remove(&p.data_dir);
    }
    state.info.lock().unwrap().running = false;
    Ok(())
}

/// At app start: find or start the service in the background, then tell the webview.
pub fn start_in_background(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || match ensure_blocking(&handle) {
        Ok(info) => {
            let _ = handle.emit("sidecar:ready", info);
        }
        Err(e) => {
            eprintln!("[monday] sidecar failed to start: {e}");
            // The webview shows the Server section instead of a blank window.
            let _ = handle.emit("sidecar:failed", e);
        }
    });
}

#[tauri::command]
pub fn sidecar_info(app: AppHandle) -> SidecarInfo {
    app.state::<SidecarState>().info.lock().unwrap().clone()
}

/// Settings › Sync server › Stop: the service goes until monday opens again or Start.
#[tauri::command]
pub async fn sidecar_stop(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || stop_blocking(&handle))
        .await
        .map_err(|e| e.to_string())??;
    let _ = app.emit("sidecar:stopped", ());
    Ok(())
}

/// Settings › Sync server › Restart (or Start when stopped).
#[tauri::command]
pub async fn sidecar_restart(app: AppHandle) -> Result<SidecarInfo, String> {
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        stop_blocking(&handle)?;
        ensure_blocking(&handle)
    })
    .await
    .map_err(|e| e.to_string())?;
    match result {
        Ok(info) => {
            let _ = app.emit("sidecar:ready", info.clone());
            Ok(info)
        }
        Err(e) => {
            let _ = app.emit("sidecar:failed", e.clone());
            Err(e)
        }
    }
}

/// The server.sidecar.start_at_login Setting, applied: installs or removes the
/// login start. Returns whether it is on now.
#[tauri::command]
pub async fn sidecar_login_start(app: AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let h = host(&app)?;
        if h.launcher.login_start_enabled() == enabled {
            return Ok(enabled);
        }
        let spec = h.installed_spec()?;
        h.launcher.set_login_start(&spec, enabled)?;
        Ok(h.launcher.login_start_enabled())
    })
    .await
    .map_err(|e| e.to_string())?
}
