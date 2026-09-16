//! Config file location and watching (ADR 0001).
//!
//! Precedence: MONDAY_CONFIG, then ~/.config/monday/monday.toml on every platform
//! if it exists, then the platform's own config directory.

use std::path::PathBuf;
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const FILE_NAME: &str = "monday.toml";
pub const APP_DIR: &str = "monday";

/// Resolve the config file path from the environment. Pure, so it can be tested.
pub fn resolve_path(env: &dyn Fn(&str) -> Option<String>, platform_dir: Option<PathBuf>) -> PathBuf {
    if let Some(explicit) = env("MONDAY_CONFIG") {
        return PathBuf::from(explicit);
    }
    if let Some(home) = env("HOME") {
        let dot = PathBuf::from(home).join(".config").join(APP_DIR).join(FILE_NAME);
        if dot.exists() {
            return dot;
        }
        if let Some(xdg) = env("XDG_CONFIG_HOME") {
            let x = PathBuf::from(xdg).join(APP_DIR).join(FILE_NAME);
            if x.exists() {
                return x;
            }
        }
    }
    if let Some(dir) = platform_dir {
        return dir.join(APP_DIR).join(FILE_NAME);
    }
    if let Some(home) = env("HOME") {
        return PathBuf::from(home).join(".config").join(APP_DIR).join(FILE_NAME);
    }
    PathBuf::from(FILE_NAME)
}

pub fn config_path(app: &AppHandle) -> PathBuf {
    let env = |k: &str| std::env::var(k).ok();
    resolve_path(&env, app.path().config_dir().ok())
}

#[derive(Serialize, Clone)]
pub struct ConfigFile {
    pub path: String,
    pub exists: bool,
    pub text: String,
}

#[tauri::command]
pub fn read_config(app: AppHandle) -> ConfigFile {
    let path = config_path(&app);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    ConfigFile { exists: path.exists(), path: path.to_string_lossy().into_owned(), text }
}

/// Write the file only when the user asked for it (ADR 0001). The caller has already
/// produced comment-preserving text in TypeScript; Rust only persists it atomically.
#[tauri::command]
pub fn write_config(app: AppHandle, text: String) -> Result<(), String> {
    let path = config_path(&app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Watch the config directory (not the file, so editors that replace the file are seen)
/// and emit `config:changed` with the new contents.
pub fn watch(app: AppHandle) {
    let path = config_path(&app);
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    std::thread::spawn(move || {
        let handle = app.clone();
        let file = path.clone();
        let mut debouncer = match new_debouncer(Duration::from_millis(200), move |res: DebounceEventResult| {
            if let Ok(events) = res {
                if events.iter().any(|e| e.path == file) {
                    let cf = read_config(handle.clone());
                    let _ = handle.emit("config:changed", cf);
                }
            }
        }) {
            Ok(d) => d,
            Err(_) => return,
        };
        if debouncer.watcher().watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env<'a>(map: &'a HashMap<&'a str, String>) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| map.get(k).cloned()
    }

    #[test]
    fn explicit_override_wins() {
        let mut m = HashMap::new();
        m.insert("MONDAY_CONFIG", "/x/y.toml".to_string());
        m.insert("HOME", "/home/u".to_string());
        let p = resolve_path(&env(&m), Some(PathBuf::from("/plat")));
        assert_eq!(p, PathBuf::from("/x/y.toml"));
    }

    #[test]
    fn platform_dir_when_no_dotfile() {
        let mut m = HashMap::new();
        m.insert("HOME", "/nonexistent-home".to_string());
        let p = resolve_path(&env(&m), Some(PathBuf::from("/plat")));
        assert_eq!(p, PathBuf::from("/plat/monday/monday.toml"));
    }
}
