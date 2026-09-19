//! Config file location and watching (ADR 0001).
//!
//! Precedence: MONDAY_CONFIG, then ~/.config/monday/monday.toml on every platform
//! if it exists, then the platform's own config directory.

use std::path::{Path, PathBuf};
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
    // Windows has no HOME; USERPROFILE stands in, as packages/shared's paths.ts does.
    let home = env("HOME").or_else(|| env("USERPROFILE"));
    if let Some(home) = home.clone() {
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
    if let Some(home) = home {
        return PathBuf::from(home).join(".config").join(APP_DIR).join(FILE_NAME);
    }
    PathBuf::from(FILE_NAME)
}

/// Where a palette path points: `~` expands to HOME, a relative path is under
/// the config directory, an absolute one is itself. Pure, so it can be tested.
pub fn resolve_palette_path(path: &str, home: Option<&str>, config_dir: &Path) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(h) = home {
            let rest = trimmed.trim_start_matches('~').trim_start_matches(['/', '\\']);
            return PathBuf::from(h).join(rest);
        }
    }
    let p = PathBuf::from(trimmed);
    if p.is_absolute() {
        p
    } else {
        config_dir.join(p)
    }
}

/// Read the palette file `appearance.palette` names: token TOML or base16 YAML.
/// Read only; the app never writes it (ADR 0001).
#[tauri::command]
pub fn read_palette_file(app: AppHandle, path: String) -> ConfigFile {
    let config_dir = config_path(&app).parent().map(Path::to_path_buf).unwrap_or_default();
    let home = std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok());
    let resolved = resolve_palette_path(&path, home.as_deref(), &config_dir);
    let text = std::fs::read_to_string(&resolved).unwrap_or_default();
    ConfigFile { exists: resolved.is_file(), path: resolved.to_string_lossy().into_owned(), text }
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
    fn userprofile_stands_in_for_home() {
        let mut m = HashMap::new();
        m.insert("USERPROFILE", "/nonexistent-profile".to_string());
        let p = resolve_path(&env(&m), None);
        assert_eq!(p, PathBuf::from("/nonexistent-profile/.config/monday/monday.toml"));
    }

    #[test]
    fn palette_paths_expand_home_and_fall_under_the_config_dir() {
        let dir = Path::new("/home/u/.config/monday");
        assert_eq!(
            resolve_palette_path("~/palettes/x.toml", Some("/home/u"), dir),
            PathBuf::from("/home/u/palettes/x.toml")
        );
        assert_eq!(
            resolve_palette_path("x.toml", Some("/home/u"), dir),
            PathBuf::from("/home/u/.config/monday/x.toml")
        );
        assert_eq!(resolve_palette_path("/abs/x.yaml", None, dir), PathBuf::from("/abs/x.yaml"));
        // Without a HOME the tilde path is taken as written, under the config dir.
        assert_eq!(
            resolve_palette_path("~/x.toml", None, dir),
            PathBuf::from("/home/u/.config/monday/~/x.toml")
        );
    }

    #[test]
    fn platform_dir_when_no_dotfile() {
        let mut m = HashMap::new();
        m.insert("HOME", "/nonexistent-home".to_string());
        let p = resolve_path(&env(&m), Some(PathBuf::from("/plat")));
        assert_eq!(p, PathBuf::from("/plat/monday/monday.toml"));
    }
}
