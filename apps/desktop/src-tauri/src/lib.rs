mod config;
mod db;
mod links;
mod notify;
mod platform;
mod power;
mod rootkey;
mod secrets;

// The desktop shell runs and owns things a phone does not have (docs/mobile.md):
// the Sidecar as a background service, the Local runtime CLIs, a config file
// someone else may edit, WebKitGTK's memory knobs. The phone is a client of a
// paired Server and gets none of them.
#[cfg(desktop)]
mod runtimes;
#[cfg(desktop)]
mod service;
#[cfg(desktop)]
mod sidecar;
#[cfg(desktop)]
mod webview_memory;

#[cfg(desktop)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    webview_memory::apply_before_start();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(db::DbState::default());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_shell::init())
        .manage(sidecar::SidecarState::default());
    builder
        .invoke_handler(handlers())
        .setup(|app| {
            links::create_main_window(app)?;
            #[cfg(desktop)]
            {
                for window in app.webview_windows().values() {
                    webview_memory::lean_cache(window);
                }
                config::watch(app.handle().clone());
                // The Sidecar is a background service (ADR 0013): found or started
                // here, and left running when the window closes.
                sidecar::start_in_background(app.handle());
            }
            Ok(())
        })
        // Closing the window quits the app and nothing else: the Sidecar and its
        // Postgres keep syncing, sorting and running Workflows (ADR 0013).
        // Settings › Sync server stops it on purpose.
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The commands the webview may invoke on a computer.
#[cfg(desktop)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        platform::platform_kind,
        config::read_config,
        config::write_config,
        config::read_palette_file,
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
        sidecar::sidecar_info,
        sidecar::sidecar_stop,
        sidecar::sidecar_restart,
        sidecar::sidecar_login_start,
        rootkey::recovery_file,
        rootkey::import_recovery_key,
        db::db_exec,
        db::db_query,
        db::db_batch,
        db::db_close,
        power::power_info,
        power::network_info,
        runtimes::env_path,
        notify::notify,
        webview_memory::webview_memory_save,
    ]
}

/// The commands the webview may invoke on a phone: no Sidecar, no Local
/// runtimes, no WebKitGTK. The config file is the app's own private one.
#[cfg(mobile)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        platform::platform_kind,
        config::read_config,
        config::write_config,
        config::read_palette_file,
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
        rootkey::recovery_file,
        rootkey::import_recovery_key,
        db::db_exec,
        db::db_query,
        db::db_batch,
        db::db_close,
        power::power_info,
        power::network_info,
        notify::notify,
    ]
}
