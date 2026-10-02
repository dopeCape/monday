// The main window, built here rather than from the config alone so it can
// catch the links in a Message. A Message's body renders in a sandboxed frame
// with scripts off, where WebKit runs no click listener at all, not even the
// app's; its links get target="_blank" (html-body.tsx), so a click is a new
// window request, which lands here. Web and mail links open in the system
// browser or mail app; nothing ever opens inside monday.
//
// A phone's webview has no new window requests: a target="_blank" link
// navigates the one webview instead. There the navigation handler catches it:
// the app's own pages stay, web and mail links go to the system browser or
// mail app, and anything else goes nowhere.

use tauri::{App, Url, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Whether a link from a Message may leave the app: web pages and mail addresses only.
pub fn opens_outside(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")
}

/// Where a navigation of the phone's webview goes.
#[derive(Debug, PartialEq)]
pub enum Navigation {
    /// The app's own page (or the dev server's): the webview loads it.
    Stay,
    /// A web or mail link: the system browser or mail app opens it.
    Outside,
    /// Anything else: nothing happens.
    Block,
}

/// Decides a phone navigation. `dev` is the dev server's URL in a dev build.
#[cfg_attr(desktop, allow(dead_code))]
pub fn navigation(url: &Url, dev: Option<&Url>) -> Navigation {
    match url.scheme() {
        // The app's own origin: tauri://localhost on iOS, asset loads, srcdoc frames.
        "tauri" | "asset" | "about" | "data" | "blob" => return Navigation::Stay,
        // http://tauri.localhost is the app's origin on Android.
        "http" | "https" if url.host_str() == Some("tauri.localhost") => return Navigation::Stay,
        _ => {}
    }
    if dev.is_some_and(|d| d.origin() == url.origin()) {
        return Navigation::Stay;
    }
    if opens_outside(url.as_str()) {
        Navigation::Outside
    } else {
        Navigation::Block
    }
}

#[cfg(desktop)]
pub fn create_main_window(app: &mut App) -> tauri::Result<()> {
    use tauri::webview::NewWindowResponse;
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

#[cfg(mobile)]
pub fn create_main_window(app: &mut App) -> tauri::Result<()> {
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else {
        return Ok(());
    };
    let handle = app.handle().clone();
    let dev = app.config().build.dev_url.clone();
    WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_navigation(move |url| match navigation(url, dev.as_ref()) {
            Navigation::Stay => true,
            Navigation::Outside => {
                if let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>) {
                    eprintln!("[monday] could not open a link: {error}");
                }
                false
            }
            Navigation::Block => false,
        })
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn a_phone_keeps_its_own_pages_and_sends_links_out() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert_eq!(navigation(&url("http://tauri.localhost/index.html"), None), Navigation::Stay);
        assert_eq!(navigation(&url("tauri://localhost/"), None), Navigation::Stay);
        assert_eq!(navigation(&url("about:srcdoc"), None), Navigation::Stay);
        assert_eq!(navigation(&url("https://example.com/a"), None), Navigation::Outside);
        assert_eq!(navigation(&url("mailto:a@b.test"), None), Navigation::Outside);
        assert_eq!(navigation(&url("javascript:alert(1)"), None), Navigation::Block);
        assert_eq!(navigation(&url("file:///etc/passwd"), None), Navigation::Block);
        let dev = url("http://192.168.1.5:1420");
        assert_eq!(navigation(&url("http://192.168.1.5:1420/x"), Some(&dev)), Navigation::Stay);
        assert_eq!(navigation(&url("http://192.168.1.5:9000/x"), Some(&dev)), Navigation::Outside);
    }
}
