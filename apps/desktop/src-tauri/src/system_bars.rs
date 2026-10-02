//! The phone's status and navigation bars follow monday's appearance, not the
//! system's (docs/mobile.md). The webview draws edge to edge, so the bars sit
//! over monday's own background: dark appearance, light icons. The webview
//! asks with `set_system_bars` whenever the resolved appearance changes.
//!
//! Android: `SystemBarsPlugin` in gen/android (WindowInsetsControllerCompat).
//! iOS: not done yet; the status bar there follows the system appearance.

use tauri::plugin::{Builder, TauriPlugin};
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

/// The Android side, once registered.
#[cfg(target_os = "android")]
struct SystemBars<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("system-bars")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("io.monday.desktop", "SystemBarsPlugin")?;
                _app.manage(SystemBars(handle));
            }
            Ok(())
        })
        .build()
}

/// Light icons over a dark appearance, dark icons over a light one. A no-op where there are no bars to set.
#[tauri::command]
pub async fn set_system_bars(app: AppHandle, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    if let Some(bars) = app.try_state::<SystemBars<tauri::Wry>>() {
        bars.0
            .run_mobile_plugin::<serde_json::Value>("setSystemBars", serde_json::json!({ "dark": dark }))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = (app, dark);
    Ok(())
}
