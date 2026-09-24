//! How much memory the webview keeps before WebKit lets go of its caches.
//!
//! The limit is the `app.webview_memory_mb` Setting. WebKit takes it only
//! before its first web process starts, so the webview saves the Setting to a
//! small file in the app's data directory (`webview_memory`) and the next
//! start reads it back. Above a third of the limit WebKit frees caches it can
//! rebuild; above half it also collects garbage hard. It never kills the page.
//! The cache model drops WebKit's in-memory page and resource caches: images
//! in mail still come from the disk cache.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "webview_memory";
/// The Setting's schema default, used before the webview has saved one.
const DEFAULT_MB: u32 = 384;

/// The app's data directory before Tauri is up (Linux: XDG data home + identifier).
fn data_dir_early() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))?;
    Some(base.join("io.monday.desktop"))
}

/// Reads the saved limit; the default when there is none or it is not a number.
pub fn parse_mb(text: Option<&str>) -> u32 {
    text.and_then(|t| t.trim().parse::<u32>().ok())
        .filter(|mb| *mb >= 64)
        .unwrap_or(DEFAULT_MB)
}

/// Sets WebKit's memory pressure limits; call before the Builder makes a webview.
#[cfg(target_os = "linux")]
pub fn apply_before_start() {
    use webkit2gtk::ffi;
    let saved = data_dir_early().and_then(|d| std::fs::read_to_string(d.join(FILE_NAME)).ok());
    // The C API directly: the Rust wrapper asserts GTK is initialised, and it
    // is not yet; WebKit only needs this before its first web process.
    unsafe {
        let settings = ffi::webkit_memory_pressure_settings_new();
        ffi::webkit_memory_pressure_settings_set_memory_limit(settings, parse_mb(saved.as_deref()));
        ffi::webkit_memory_pressure_settings_set_conservative_threshold(settings, 0.33);
        ffi::webkit_memory_pressure_settings_set_strict_threshold(settings, 0.5);
        ffi::webkit_memory_pressure_settings_set_poll_interval(settings, 10.0);
        ffi::webkit_website_data_manager_set_memory_pressure_settings(settings);
        ffi::webkit_memory_pressure_settings_free(settings);
    }
}

#[cfg(not(target_os = "linux"))]
pub fn apply_before_start() {}

/// Drops the in-memory page and resource caches for a webview.
#[cfg(target_os = "linux")]
pub fn lean_cache(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use webkit2gtk::{CacheModel, WebContextExt, WebViewExt};
        if let Some(context) = webview.inner().context() {
            context.set_cache_model(CacheModel::DocumentViewer);
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub fn lean_cache(_window: &tauri::WebviewWindow) {}

/// Saves the Setting for the next start. Returns whether it changed.
#[tauri::command]
pub fn webview_memory_save(app: AppHandle, mb: u32) -> Result<bool, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join(FILE_NAME);
    let before = std::fs::read_to_string(&path).ok();
    if parse_mb(before.as_deref()) == mb && before.is_some() {
        return Ok(false);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{mb}\n")).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_limit_or_the_default() {
        assert_eq!(parse_mb(Some("512\n")), 512);
        assert_eq!(parse_mb(None), DEFAULT_MB);
        assert_eq!(parse_mb(Some("lots")), DEFAULT_MB);
        assert_eq!(parse_mb(Some("10")), DEFAULT_MB);
    }
}
