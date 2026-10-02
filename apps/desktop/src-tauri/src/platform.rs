//! What kind of Device the shell runs on, for the webview's platform layer
//! (apps/desktop/src/platform/tauri.ts, `Platform.kind`). A computer runs the
//! Sidecar and the Local runtimes; a phone is a client of a paired Server
//! (docs/mobile.md).

/// The kind for this build: "desktop" or "mobile".
pub const fn kind() -> &'static str {
    if cfg!(mobile) {
        "mobile"
    } else {
        "desktop"
    }
}

#[tauri::command]
pub fn platform_kind() -> &'static str {
    kind()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_desktop_build_says_desktop() {
        // Tests run on the host, which is a computer.
        assert_eq!(super::platform_kind(), "desktop");
    }
}
