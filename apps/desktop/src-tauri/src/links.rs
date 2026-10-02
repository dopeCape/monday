// The main window, built here rather than from the config alone so it can
// catch the links in a Message. A Message's body renders in a sandboxed frame
// with scripts off, where WebKit runs no click listener at all, not even the
// app's; its links get target="_blank" (html-body.tsx), so a click is a new
// window request, which lands here. Web and mail links open in the system
// browser or mail app; nothing ever opens inside monday.

use tauri::webview::NewWindowResponse;
use tauri::{App, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Whether a link from a Message may leave the app: web pages and mail addresses only.
pub fn opens_outside(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")
}

pub fn create_main_window(app: &mut App) -> tauri::Result<()> {
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else {
        return Ok(());
    };
    let handle = app.handle().clone();
    WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_new_window(move |url, _features| {
            let href = url.as_str();
            if opens_outside(href) {
                if let Err(error) = handle.opener().open_url(href, None::<&str>) {
                    eprintln!("[monday] could not open a link: {error}");
                }
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::opens_outside;

    #[test]
    fn only_web_and_mail_links_leave_the_app() {
        assert!(opens_outside("https://example.com/a"));
        assert!(opens_outside("HTTP://example.com"));
        assert!(opens_outside("mailto:a@b.test"));
        assert!(!opens_outside("about:srcdoc#top"));
        assert!(!opens_outside("javascript:alert(1)"));
        assert!(!opens_outside("file:///etc/passwd"));
        assert!(!opens_outside("tauri://localhost/x"));
    }
}
