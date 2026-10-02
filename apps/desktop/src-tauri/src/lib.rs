mod config;
mod links;
mod db;
mod notify;
mod power;
mod rootkey;
mod runtimes;
mod secrets;
mod service;
mod sidecar;
mod webview_memory;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    webview_memory::apply_before_start();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(sidecar::SidecarState::default())
        .manage(db::DbState::default())
        .invoke_handler(tauri::generate_handler![
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
        ])
        .setup(|app| {
            links::create_main_window(app)?;
            for window in app.webview_windows().values() {
                webview_memory::lean_cache(window);
            }
            config::watch(app.handle().clone());
            // The Sidecar is a background service (ADR 0013): found or started
            // here, and left running when the window closes.
            sidecar::start_in_background(app.handle());
            Ok(())
        })
        // Closing the window quits the app and nothing else: the Sidecar and its
        // Postgres keep syncing, sorting and running Workflows (ADR 0013).
        // Settings › Sync server stops it on purpose.
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
