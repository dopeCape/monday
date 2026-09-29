//! The runtime file the Sidecar writes in the data directory (ADR 0013):
//! `sidecar.json` with its pid, port, build and state, written atomically by
//! the server (apps/server/entry/service.ts) and removed on a clean shutdown.
//! It never holds the token. The app reads it to find a Sidecar that is still
//! running from an earlier launch.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Deserialize;

pub const RUNTIME_FILE: &str = "sidecar.json";

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub pid: u32,
    /// None while the service is starting (Postgres, migrations) and not yet listening.
    pub port: Option<u16>,
    pub build: String,
    pub started_at: String,
    /// "starting" or "ready".
    pub state: String,
    #[serde(default = "default_manager")]
    pub managed_by: String,
}

fn default_manager() -> String {
    "process".to_string()
}

impl RuntimeInfo {
    pub fn ready(&self) -> bool {
        self.state == "ready" && self.port.is_some()
    }
}

/// A runtime file's text, or None when it is not one.
pub fn parse(text: &str) -> Option<RuntimeInfo> {
    let info: RuntimeInfo = serde_json::from_str(text).ok()?;
    if info.pid == 0 || (info.state != "starting" && info.state != "ready") {
        return None;
    }
    if info.state == "ready" && info.port.unwrap_or(0) == 0 {
        return None;
    }
    Some(info)
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(RUNTIME_FILE)
}

/// The runtime file and how long ago it was last written.
pub fn read(data_dir: &Path) -> Option<(RuntimeInfo, Duration)> {
    let p = path(data_dir);
    let text = std::fs::read_to_string(&p).ok()?;
    let info = parse(&text)?;
    let age = std::fs::metadata(&p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .unwrap_or_default();
    Some((info, age))
}

/// Removes a stale runtime file (its process is gone).
pub fn remove(data_dir: &Path) {
    let _ = std::fs::remove_file(path(data_dir));
}

/// Whether a process with this pid exists (a zombie counts; the service is never our child).
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: kill(pid, 0) only probes; it sends nothing.
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    tasklist_line(pid).is_some()
}

#[cfg(windows)]
fn tasklist_line(pid: u32) -> Option<String> {
    let out = super::launch::quiet_command("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    text.contains(&format!("\"{pid}\"")).then_some(text)
}

/// The command line of a process, where the platform lets us read it.
#[cfg(target_os = "linux")]
fn command_line(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(String::from_utf8_lossy(&raw).replace('\0', " "))
}

#[cfg(target_os = "macos")]
fn command_line(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(windows)]
fn command_line(pid: u32) -> Option<String> {
    tasklist_line(pid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn command_line(_pid: u32) -> Option<String> {
    None
}

/// Whether a command line is the Sidecar's, so a recycled pid is never signalled.
pub fn is_sidecar_command(line: &str) -> bool {
    line.contains("monday-server")
}

/// Alive, and the Sidecar: a pid the runtime file names but some other program
/// now holds reads as gone. Where the command line cannot be read, alive is enough.
pub fn sidecar_alive(pid: u32) -> bool {
    if !pid_alive(pid) {
        return false;
    }
    command_line(pid)
        .map(|l| is_sidecar_command(&l))
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ready_file_parses_and_a_starting_one_has_no_port() {
        let ready = r#"{"pid":42,"port":51234,"build":"b1","startedAt":"2026-09-29T08:00:00.000Z","state":"ready","managedBy":"systemd"}"#;
        let info = parse(ready).unwrap();
        assert_eq!(info.port, Some(51234));
        assert!(info.ready());
        assert_eq!(info.managed_by, "systemd");

        let starting = r#"{"pid":42,"port":null,"build":"b1","startedAt":"x","state":"starting","managedBy":"process"}"#;
        let info = parse(starting).unwrap();
        assert!(!info.ready());
    }

    #[test]
    fn anything_else_is_not_a_runtime_file() {
        assert!(parse("not json").is_none());
        assert!(
            parse(r#"{"pid":0,"port":1,"build":"b","startedAt":"x","state":"ready"}"#).is_none()
        );
        assert!(parse(r#"{"pid":1,"port":1,"build":"b","startedAt":"x","state":"odd"}"#).is_none());
        assert!(
            parse(r#"{"pid":1,"port":null,"build":"b","startedAt":"x","state":"ready"}"#).is_none()
        );
        // A file without a manager reads as a plain process.
        let info =
            parse(r#"{"pid":1,"port":2,"build":"b","startedAt":"x","state":"ready"}"#).unwrap();
        assert_eq!(info.managed_by, "process");
    }

    #[test]
    fn read_and_remove_in_a_directory() {
        let dir = crate::service::testdir::TempDir::new("runtime");
        assert!(read(dir.path()).is_none());
        std::fs::write(
            path(dir.path()),
            r#"{"pid":7,"port":9,"build":"b","startedAt":"x","state":"ready","managedBy":"process"}"#,
        )
        .unwrap();
        let (info, age) = read(dir.path()).unwrap();
        assert_eq!(info.pid, 7);
        assert!(age < Duration::from_secs(60));
        remove(dir.path());
        assert!(read(dir.path()).is_none());
    }

    #[test]
    fn only_the_sidecar_command_line_counts() {
        assert!(is_sidecar_command(
            "/home/u/.local/share/io.monday.desktop/sidecar/b1/monday-server service --data-dir /x"
        ));
        assert!(!is_sidecar_command("/usr/bin/firefox"));
    }

    #[test]
    fn this_process_is_alive_and_a_huge_pid_is_not() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(4_000_000));
        // This test binary is not the Sidecar.
        #[cfg(target_os = "linux")]
        assert!(!sidecar_alive(std::process::id()));
    }
}
