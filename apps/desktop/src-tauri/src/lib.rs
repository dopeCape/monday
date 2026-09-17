mod config;
mod db;
mod rootkey;
mod power;
mod secrets;
mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .manage(sidecar::SidecarState::default())
        .manage(db::DbState::default())
        .invoke_handler(tauri::generate_handler![
            config::read_config,
            config::write_config,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            sidecar::sidecar_info,
            rootkey::recovery_file,
            rootkey::import_recovery_key,
            db::db_exec,
            db::db_query,
            db::db_batch,
            db::db_close,
            power::power_info,
            power::network_info,
        ])
        .setup(|app| {
            config::watch(app.handle().clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match sidecar::start(&handle).await {
                    Ok(info) => {
                        use tauri::Emitter;
                        let _ = handle.emit("sidecar:ready", info);
                    }
                    Err(e) => eprintln!("[monday] sidecar failed to start: {e}"),
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                sidecar::stop(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
