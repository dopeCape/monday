//! Desktop notifications (docs/spec/settings.md, notifications.*): a calendar
//! reminder or a Workflow failure reaches the OS through the notification
//! plugin's Rust side, so the webview never asks WebKit for permission (which
//! the host denies by default). Whether one is sent at all is the Setting the
//! caller already checked.

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// The text a notification carries, trimmed to what a notification center shows.
pub fn trim_for_notification(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars.saturating_sub(3)).collect();
    out.push_str("...");
    out
}

/// Titles longer than this are cut; bodies get twice as much.
pub const TITLE_CHARS: usize = 80;

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(trim_for_notification(&title, TITLE_CHARS))
        .body(trim_for_notification(&body, TITLE_CHARS * 2))
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_passes_and_long_text_is_cut_with_an_ellipsis() {
        assert_eq!(trim_for_notification("  Standup at 10  ", 80), "Standup at 10");
        let long = "x".repeat(100);
        let cut = trim_for_notification(&long, 80);
        assert_eq!(cut.chars().count(), 80);
        assert!(cut.ends_with("..."));
    }
}
