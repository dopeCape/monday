//! The Local runtimes' host side (CONTEXT.md, Local runtime; slice 15). The
//! CLIs themselves are spawned by the shell plugin under the scopes in
//! `capabilities/default.json`: `claude`, `codex` and `opencode` by name on
//! PATH, each with a fixed argument shape, plus their version and login
//! checks. The one thing the webview cannot learn on its own is the host's
//! PATH, which it needs to put a Settings path override in front of.

/// The host process's PATH, so a per-device path override can be searched first.
#[tauri::command]
pub fn env_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_path_reads_the_host_path() {
        // The test runner always has a PATH; the command hands it over verbatim.
        assert_eq!(env_path(), std::env::var("PATH").unwrap_or_default());
    }
}
