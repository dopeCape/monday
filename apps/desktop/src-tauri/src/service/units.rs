//! The files that describe the background service to each platform's service
//! manager (ADR 0013), generated as text so they are tested on any host:
//! a systemd user unit (Linux), a LaunchAgent plist (macOS), an XDG autostart
//! entry (Linux without systemd, login start only) and a command line for the
//! Windows Run key. None carries a secret: the token is the 0600 token file
//! the server reads itself, and the root key reaches the service over
//! loopback (POST /unlock) from the app.

use std::path::{Path, PathBuf};

pub const SYSTEMD_UNIT: &str = "monday-sidecar.service";
pub const LAUNCHD_LABEL: &str = "io.monday.sidecar";
pub const AUTOSTART_FILE: &str = "monday-sidecar.desktop";
#[cfg_attr(not(windows), allow(dead_code))]
pub const RUN_KEY_VALUE: &str = "monday-sidecar";

/// One installed service: the copied executable, the data directory, its build and log.
#[derive(Clone, Debug)]
pub struct ServiceSpec {
    pub exe: PathBuf,
    pub data_dir: PathBuf,
    pub build: String,
    pub log: PathBuf,
    /// The PATH the service sees under systemd, whose user manager may not have
    /// the desktop's (notify-send lives on it). Not a secret.
    pub path_env: Option<String>,
}

/// The server's arguments: `service --data-dir <dir> --build <id> --managed-by <manager>`.
pub fn service_args(spec: &ServiceSpec, managed_by: &str) -> Vec<String> {
    vec![
        "service".to_string(),
        "--data-dir".to_string(),
        spec.data_dir.to_string_lossy().to_string(),
        "--build".to_string(),
        spec.build.clone(),
        "--managed-by".to_string(),
        managed_by.to_string(),
    ]
}

/// A systemd ExecStart word: double-quoted with C escapes, `%` and `$` doubled.
fn systemd_word(word: &str) -> String {
    let escaped = word
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    format!("\"{escaped}\"")
}

/// A path in a systemd setting that takes no quoting: only `%` is special.
fn systemd_path(path: &Path) -> String {
    path.to_string_lossy().replace('%', "%%")
}

/// `~/.config/systemd/user/monday-sidecar.service`. Stopped on purpose (exit 0)
/// it stays stopped; a crash restarts it. SIGTERM reaches the server first
/// (KillMode=mixed), which stops its Postgres before systemd kills the rest.
pub fn systemd_unit(spec: &ServiceSpec) -> String {
    let mut exec = vec![systemd_word(&spec.exe.to_string_lossy())];
    exec.extend(
        service_args(spec, "systemd")
            .iter()
            .map(|a| systemd_word(a)),
    );
    let log = systemd_path(&spec.log);
    let env = spec
        .path_env
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| {
            let v = p
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('%', "%%");
            format!("Environment=\"PATH={v}\"\n")
        })
        .unwrap_or_default();
    format!(
        "# Written by monday (ADR 0013). monday rewrites this file when it updates;\n\
         # stop the service with: systemctl --user stop {SYSTEMD_UNIT}\n\
         [Unit]\n\
         Description=monday background service (Sidecar: mail sync, Workflows, reminders)\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={}\n\
         {env}\
         Restart=on-failure\n\
         RestartSec=5\n\
         KillMode=mixed\n\
         KillSignal=SIGTERM\n\
         TimeoutStopSec=30\n\
         StandardOutput=append:{log}\n\
         StandardError=append:{log}\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exec.join(" ")
    )
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The LaunchAgent. Loaded from `~/Library/LaunchAgents` it also starts at
/// login; loaded from the data directory it runs until logout only.
/// KeepAlive restarts a crash but not a stop on purpose (exit 0).
pub fn launchd_plist(spec: &ServiceSpec) -> String {
    let mut args = vec![spec.exe.to_string_lossy().to_string()];
    args.extend(service_args(spec, "launchd"));
    let program: String = args
        .iter()
        .map(|a| format!("    <string>{}</string>\n", xml_escape(a)))
        .collect();
    let log = xml_escape(&spec.log.to_string_lossy());
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <!-- Written by monday (ADR 0013); rewritten when monday updates. -->\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \x20 <key>Label</key>\n\
         \x20 <string>{LAUNCHD_LABEL}</string>\n\
         \x20 <key>ProgramArguments</key>\n\
         \x20 <array>\n\
         {program}\
         \x20 </array>\n\
         \x20 <key>RunAtLoad</key>\n\
         \x20 <true/>\n\
         \x20 <key>KeepAlive</key>\n\
         \x20 <dict>\n\
         \x20   <key>SuccessfulExit</key>\n\
         \x20   <false/>\n\
         \x20 </dict>\n\
         \x20 <key>ProcessType</key>\n\
         \x20 <string>Background</string>\n\
         \x20 <key>StandardOutPath</key>\n\
         \x20 <string>{log}</string>\n\
         \x20 <key>StandardErrorPath</key>\n\
         \x20 <string>{log}</string>\n\
         </dict>\n\
         </plist>\n"
    )
}

/// A desktop-entry Exec argument: quoted when it holds anything special.
fn desktop_word(word: &str) -> String {
    let needs = word.is_empty()
        || word.chars().any(|c| {
            c.is_whitespace()
                || matches!(
                    c,
                    '"' | '\''
                        | '\\'
                        | '>'
                        | '<'
                        | '~'
                        | '|'
                        | '&'
                        | ';'
                        | '$'
                        | '*'
                        | '?'
                        | '#'
                        | '('
                        | ')'
                        | '`'
                )
        });
    let percent = word.replace('%', "%%");
    if !needs {
        return percent;
    }
    let inner = percent
        .replace('\\', "\\\\\\\\")
        .replace('"', "\\\\\"")
        .replace('`', "\\\\`")
        .replace('$', "\\\\$");
    format!("\"{inner}\"")
}

/// `~/.config/autostart/monday-sidecar.desktop`: the login start where there is no systemd.
pub fn xdg_autostart(spec: &ServiceSpec) -> String {
    let mut exec = vec![desktop_word(&spec.exe.to_string_lossy())];
    exec.extend(
        service_args(spec, "process")
            .iter()
            .map(|a| desktop_word(a)),
    );
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=monday background service\n\
         Comment=Keeps monday's mail syncing while its window is closed\n\
         Exec={}\n\
         Terminal=false\n\
         NoDisplay=true\n\
         X-GNOME-Autostart-enabled=true\n",
        exec.join(" ")
    )
}

/// One argument as CommandLineToArgvW reads it back.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

/// The Run key's value: the service started at login on Windows.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_command_line(spec: &ServiceSpec) -> String {
    let mut words = vec![windows_arg(&spec.exe.to_string_lossy())];
    words.extend(service_args(spec, "process").iter().map(|a| windows_arg(a)));
    words.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(dir: &str) -> ServiceSpec {
        ServiceSpec {
            exe: PathBuf::from(format!("{dir}/sidecar/b1/monday-server")),
            data_dir: PathBuf::from(dir),
            build: "b1".to_string(),
            log: PathBuf::from(format!("{dir}/sidecar.log")),
            path_env: None,
        }
    }

    #[test]
    fn the_systemd_unit_runs_the_copied_server_as_a_service() {
        let unit = systemd_unit(&spec("/home/u/.local/share/io.monday.desktop"));
        assert!(unit.contains(
            "ExecStart=\"/home/u/.local/share/io.monday.desktop/sidecar/b1/monday-server\" \"service\" \"--data-dir\" \"/home/u/.local/share/io.monday.desktop\" \"--build\" \"b1\" \"--managed-by\" \"systemd\"\n"
        ));
        assert!(unit.contains("Restart=on-failure\n"));
        assert!(unit.contains("KillMode=mixed\n"));
        assert!(unit.contains(
            "StandardOutput=append:/home/u/.local/share/io.monday.desktop/sidecar.log\n"
        ));
        assert!(unit.contains("WantedBy=default.target\n"));
        assert!(!unit.contains("Environment="));
        let with_path = systemd_unit(&ServiceSpec {
            path_env: Some("/run/current-system/sw/bin:/home/u/100%".into()),
            ..spec("/d")
        });
        assert!(with_path.contains(
            "ExecStart=\"/d/sidecar/b1/monday-server\" \"service\" \"--data-dir\" \"/d\" \"--build\" \"b1\" \"--managed-by\" \"systemd\"\nEnvironment=\"PATH=/run/current-system/sw/bin:/home/u/100%%\"\nRestart=on-failure\n"
        ));
        // No secret, ever.
        assert!(!unit.to_lowercase().contains("token"));
        assert!(!unit.contains("MONDAY_ROOT_KEY"));
    }

    #[test]
    fn systemd_words_escape_quotes_percent_and_dollar() {
        assert_eq!(systemd_word("a b"), "\"a b\"");
        assert_eq!(systemd_word("50%"), "\"50%%\"");
        assert_eq!(systemd_word("$HOME"), "\"$$HOME\"");
        assert_eq!(systemd_word("say \"hi\"\\"), "\"say \\\"hi\\\"\\\\\"");
        let unit = systemd_unit(&spec("/home/u/100% data"));
        assert!(unit.contains("\"/home/u/100%% data\""));
        assert!(unit.contains("append:/home/u/100%% data/sidecar.log"));
    }

    #[test]
    fn the_launch_agent_restarts_crashes_and_escapes_xml() {
        let plist = launchd_plist(&spec(
            "/Users/u/Library/Application Support/io.monday.desktop",
        ));
        assert!(plist.contains("<string>io.monday.sidecar</string>"));
        assert!(plist.contains(
            "<string>/Users/u/Library/Application Support/io.monday.desktop/sidecar/b1/monday-server</string>"
        ));
        assert!(plist.contains("<string>--managed-by</string>\n    <string>launchd</string>"));
        assert!(plist.contains("<key>SuccessfulExit</key>\n    <false/>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(!plist.to_lowercase().contains("token"));
        let odd = launchd_plist(&spec("/Users/u/R&D <x>"));
        assert!(odd.contains("/Users/u/R&amp;D &lt;x&gt;/sidecar.log"));
    }

    #[test]
    fn the_autostart_entry_quotes_what_it_must() {
        let entry = xdg_autostart(&spec("/home/u/my data"));
        assert!(entry.contains(
            "Exec=\"/home/u/my data/sidecar/b1/monday-server\" service --data-dir \"/home/u/my data\" --build b1 --managed-by process\n"
        ));
        assert!(entry.contains("NoDisplay=true"));
        assert_eq!(desktop_word("50%"), "50%%");
    }

    #[test]
    fn windows_arguments_survive_command_line_to_argv() {
        assert_eq!(windows_arg("plain"), "plain");
        assert_eq!(
            windows_arg("C:\\Program Files\\x"),
            "\"C:\\Program Files\\x\""
        );
        assert_eq!(windows_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(windows_arg("ends\\ "), "\"ends\\ \"");
        assert_eq!(windows_arg("dir\\"), "dir\\");
        assert_eq!(windows_arg("a dir\\"), "\"a dir\\\\\"");
        assert_eq!(windows_arg(""), "\"\"");
        let line = windows_command_line(&ServiceSpec {
            exe: PathBuf::from(
                "C:\\Users\\u\\AppData\\Roaming\\io.monday.desktop\\sidecar\\b1\\monday-server.exe",
            ),
            data_dir: PathBuf::from("C:\\Users\\u\\AppData\\Roaming\\io.monday.desktop"),
            build: "b1".into(),
            log: PathBuf::from("C:\\x\\sidecar.log"),
            path_env: None,
        });
        assert_eq!(
            line,
            "C:\\Users\\u\\AppData\\Roaming\\io.monday.desktop\\sidecar\\b1\\monday-server.exe service --data-dir C:\\Users\\u\\AppData\\Roaming\\io.monday.desktop --build b1 --managed-by process"
        );
    }
}
