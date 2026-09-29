//! Starting the background service so it outlives the app, and its login
//! start, per platform (ADR 0013):
//!
//! - Linux with a systemd user manager: the `monday-sidecar.service` user unit
//!   (units.rs), started with `systemctl --user start`; login start is
//!   `systemctl --user enable`.
//! - Linux without one: a detached process (its own session, stdio to the
//!   log); login start is an XDG autostart entry.
//! - macOS: a LaunchAgent, bootstrapped into the GUI domain; login start is
//!   the plist living in ~/Library/LaunchAgents rather than the data directory.
//! - Windows: a detached process with no console; login start is the
//!   `monday-sidecar` value under HKCU\...\Run.
//!
//! Every path here comes from a `Places` so tests write into a temporary
//! directory; nothing in the tests runs systemctl, launchctl or reg.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::units::{self, ServiceSpec};

/// Where a launcher writes its files.
#[derive(Clone, Debug)]
pub struct Places {
    /// `~/.config/systemd/user`
    pub systemd_user: PathBuf,
    /// `~/.config/autostart`
    pub autostart: PathBuf,
    /// `~/Library/LaunchAgents`
    pub launch_agents: PathBuf,
    /// The app's data directory (the LaunchAgent lives here while login start is off).
    pub data_dir: PathBuf,
}

impl Places {
    /// The real places for this user.
    pub fn for_user(data_dir: &Path) -> Places {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        Places {
            systemd_user: config.join("systemd").join("user"),
            autostart: config.join("autostart"),
            launch_agents: home.join("Library").join("LaunchAgents"),
            data_dir: data_dir.to_path_buf(),
        }
    }
}

pub trait Launcher: Send + Sync {
    /// What the service reports as `managedBy`.
    fn manager(&self) -> &'static str;
    /// Starts the service for this spec (writing or refreshing its unit first).
    fn start(&self, spec: &ServiceSpec) -> Result<(), String>;
    /// Stops it through the service manager, for a service that did not stop when asked.
    fn stop(&self) -> Result<(), String> {
        Ok(())
    }
    fn set_login_start(&self, spec: &ServiceSpec, enabled: bool) -> Result<(), String>;
    fn login_start_enabled(&self) -> bool;
}

/// A command with no console window on Windows.
pub fn quiet_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let out = quiet_command(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(format!(
            "{program} {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Writes a file only when its text changed; true when it did.
pub fn write_if_changed(path: &Path, text: &str) -> Result<bool, String> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(text) {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, text).map_err(|e| e.to_string())?;
    Ok(true)
}

/* ------------------------------ systemd ------------------------------ */

pub struct Systemd {
    pub places: Places,
}

impl Systemd {
    pub fn unit_path(&self) -> PathBuf {
        self.places.systemd_user.join(units::SYSTEMD_UNIT)
    }

    /// Whether this session has a systemd user manager to talk to.
    pub fn available() -> bool {
        cfg!(target_os = "linux")
            && quiet_command("systemctl")
                .args(["--user", "show-environment"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
    }

    /// Writes or refreshes the unit; true when systemd must reload it.
    pub fn write_unit(&self, spec: &ServiceSpec) -> Result<bool, String> {
        write_if_changed(&self.unit_path(), &units::systemd_unit(spec))
    }
}

impl Launcher for Systemd {
    fn manager(&self) -> &'static str {
        "systemd"
    }
    fn start(&self, spec: &ServiceSpec) -> Result<(), String> {
        if self.write_unit(spec)? {
            run("systemctl", &["--user", "daemon-reload"])?;
        }
        let _ = run(
            "systemctl",
            &["--user", "reset-failed", units::SYSTEMD_UNIT],
        );
        run("systemctl", &["--user", "start", units::SYSTEMD_UNIT]).map(|_| ())
    }
    fn stop(&self) -> Result<(), String> {
        run("systemctl", &["--user", "stop", units::SYSTEMD_UNIT]).map(|_| ())
    }
    fn set_login_start(&self, spec: &ServiceSpec, enabled: bool) -> Result<(), String> {
        if self.write_unit(spec)? {
            run("systemctl", &["--user", "daemon-reload"])?;
        }
        let verb = if enabled { "enable" } else { "disable" };
        run("systemctl", &["--user", verb, units::SYSTEMD_UNIT]).map(|_| ())
    }
    fn login_start_enabled(&self) -> bool {
        run("systemctl", &["--user", "is-enabled", units::SYSTEMD_UNIT])
            .map(|o| o.trim() == "enabled")
            .unwrap_or(false)
    }
}

/* ------------------------------ launchd ------------------------------ */

pub struct Launchd {
    pub places: Places,
}

impl Launchd {
    fn file_name() -> String {
        format!("{}.plist", units::LAUNCHD_LABEL)
    }
    /// The plist in LaunchAgents (loaded at every login) or in the data directory (not).
    pub fn plist_path(&self, at_login: bool) -> PathBuf {
        if at_login {
            self.places.launch_agents.join(Self::file_name())
        } else {
            self.places.data_dir.join(Self::file_name())
        }
    }
    /// Writes the plist where it lives now (LaunchAgents when login start is on).
    pub fn write_plist(&self, spec: &ServiceSpec) -> Result<PathBuf, String> {
        let path = self.plist_path(self.login_start_enabled());
        write_if_changed(&path, &units::launchd_plist(spec))?;
        Ok(path)
    }
    /// Moves the plist between the two places; the running job is not touched.
    pub fn move_plist(&self, spec: &ServiceSpec, enabled: bool) -> Result<(), String> {
        write_if_changed(&self.plist_path(enabled), &units::launchd_plist(spec))?;
        let _ = std::fs::remove_file(self.plist_path(!enabled));
        Ok(())
    }
    #[cfg(unix)]
    fn domain() -> String {
        // SAFETY: getuid never fails.
        format!("gui/{}", unsafe { libc::getuid() })
    }
    #[cfg(not(unix))]
    fn domain() -> String {
        "gui/0".to_string()
    }
}

impl Launcher for Launchd {
    fn manager(&self) -> &'static str {
        "launchd"
    }
    fn start(&self, spec: &ServiceSpec) -> Result<(), String> {
        let plist = self.write_plist(spec)?;
        let target = format!("{}/{}", Self::domain(), units::LAUNCHD_LABEL);
        // A job loaded earlier (stopped, or an older build) is unloaded first.
        let _ = run("launchctl", &["bootout", &target]);
        run(
            "launchctl",
            &["bootstrap", &Self::domain(), &plist.to_string_lossy()],
        )
        .map(|_| ())
    }
    fn stop(&self) -> Result<(), String> {
        let target = format!("{}/{}", Self::domain(), units::LAUNCHD_LABEL);
        run("launchctl", &["bootout", &target]).map(|_| ())
    }
    fn set_login_start(&self, spec: &ServiceSpec, enabled: bool) -> Result<(), String> {
        self.move_plist(spec, enabled)
    }
    fn login_start_enabled(&self) -> bool {
        self.plist_path(true).exists()
    }
}

/* ------------------------------ a detached process ------------------------------ */

pub struct Detached {
    pub places: Places,
}

impl Detached {
    pub fn autostart_path(&self) -> PathBuf {
        self.places.autostart.join(units::AUTOSTART_FILE)
    }
}

/// Opens the log for appending, creating it.
fn log_file(path: &Path) -> Result<std::fs::File, String> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Spawns the service detached from the app: its own session, stdio to the log,
/// and (on Unix) a double fork so it is never the app's child or zombie.
pub fn spawn_detached(spec: &ServiceSpec, manager: &str) -> Result<(), String> {
    let log = log_file(&spec.log)?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&spec.exe);
    cmd.args(units::service_args(spec, manager))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .current_dir(&spec.data_dir);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: only async-signal-safe calls between fork and exec: setsid,
        // fork and _exit. The middle process exits at once, so the service is
        // adopted by init (or the session's reaper) and outlives the app.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                match libc::fork() {
                    -1 => Err(std::io::Error::last_os_error()),
                    0 => Ok(()),
                    _ => libc::_exit(0),
                }
            });
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not start the service: {e}"))?;
        // Reaps the middle process, which has already exited.
        let _ = child.wait();
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        match cmd.spawn() {
            Ok(_) => Ok(()),
            Err(_) => {
                // A job that forbids breaking away: start it inside the job instead.
                cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
                cmd.spawn()
                    .map(|_| ())
                    .map_err(|e| format!("could not start the service: {e}"))
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
const RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

impl Launcher for Detached {
    fn manager(&self) -> &'static str {
        "process"
    }
    fn start(&self, spec: &ServiceSpec) -> Result<(), String> {
        spawn_detached(spec, self.manager())
    }
    #[cfg(windows)]
    fn set_login_start(&self, spec: &ServiceSpec, enabled: bool) -> Result<(), String> {
        if enabled {
            let line = units::windows_command_line(spec);
            run(
                "reg",
                &[
                    "add",
                    RUN_KEY,
                    "/v",
                    units::RUN_KEY_VALUE,
                    "/t",
                    "REG_SZ",
                    "/d",
                    &line,
                    "/f",
                ],
            )
            .map(|_| ())
        } else {
            let _ = run(
                "reg",
                &["delete", RUN_KEY, "/v", units::RUN_KEY_VALUE, "/f"],
            );
            Ok(())
        }
    }
    #[cfg(windows)]
    fn login_start_enabled(&self) -> bool {
        run("reg", &["query", RUN_KEY, "/v", units::RUN_KEY_VALUE]).is_ok()
    }
    #[cfg(not(windows))]
    fn set_login_start(&self, spec: &ServiceSpec, enabled: bool) -> Result<(), String> {
        if enabled {
            write_if_changed(&self.autostart_path(), &units::xdg_autostart(spec)).map(|_| ())
        } else {
            match std::fs::remove_file(self.autostart_path()) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
    }
    #[cfg(not(windows))]
    fn login_start_enabled(&self) -> bool {
        self.autostart_path().exists()
    }
}

/// The launcher for this machine: systemd or a detached process on Linux,
/// launchd on macOS, a detached process on Windows.
pub fn for_this_machine(data_dir: &Path) -> Box<dyn Launcher> {
    let places = Places::for_user(data_dir);
    if cfg!(target_os = "macos") {
        return Box::new(Launchd { places });
    }
    if cfg!(target_os = "linux") && Systemd::available() {
        return Box::new(Systemd { places });
    }
    Box::new(Detached { places })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::testdir::TempDir;

    fn places(root: &Path) -> Places {
        Places {
            systemd_user: root.join("config/systemd/user"),
            autostart: root.join("config/autostart"),
            launch_agents: root.join("Library/LaunchAgents"),
            data_dir: root.join("data"),
        }
    }

    fn spec(root: &Path, build: &str) -> ServiceSpec {
        ServiceSpec {
            exe: root.join("data/sidecar").join(build).join("monday-server"),
            data_dir: root.join("data"),
            build: build.to_string(),
            log: root.join("data/sidecar.log"),
            path_env: None,
        }
    }

    #[test]
    fn the_unit_is_written_once_and_refreshed_for_a_new_build() {
        let t = TempDir::new("systemd");
        let s = Systemd {
            places: places(t.path()),
        };
        assert!(s.write_unit(&spec(t.path(), "b1")).unwrap());
        assert!(!s.write_unit(&spec(t.path(), "b1")).unwrap());
        assert!(s.write_unit(&spec(t.path(), "b2")).unwrap());
        let text = std::fs::read_to_string(s.unit_path()).unwrap();
        assert!(text.contains("/sidecar/b2/monday-server"));
        assert!(s
            .unit_path()
            .ends_with("config/systemd/user/monday-sidecar.service"));
    }

    #[test]
    fn the_launch_agent_moves_between_the_data_directory_and_launch_agents() {
        let t = TempDir::new("launchd");
        let l = Launchd {
            places: places(t.path()),
        };
        assert!(!l.login_start_enabled());
        let at = l.write_plist(&spec(t.path(), "b1")).unwrap();
        assert_eq!(at, t.path().join("data/io.monday.sidecar.plist"));
        l.move_plist(&spec(t.path(), "b1"), true).unwrap();
        assert!(l.login_start_enabled());
        assert!(!t.path().join("data/io.monday.sidecar.plist").exists());
        // A new build is written where it lives now.
        let at = l.write_plist(&spec(t.path(), "b2")).unwrap();
        assert_eq!(
            at,
            t.path()
                .join("Library/LaunchAgents/io.monday.sidecar.plist")
        );
        assert!(std::fs::read_to_string(&at)
            .unwrap()
            .contains("/sidecar/b2/monday-server"));
        l.move_plist(&spec(t.path(), "b2"), false).unwrap();
        assert!(!l.login_start_enabled());
        assert!(t.path().join("data/io.monday.sidecar.plist").exists());
    }

    #[cfg(not(windows))]
    #[test]
    fn without_systemd_login_start_is_an_autostart_entry() {
        let t = TempDir::new("autostart");
        let d = Detached {
            places: places(t.path()),
        };
        assert!(!d.login_start_enabled());
        d.set_login_start(&spec(t.path(), "b1"), true).unwrap();
        assert!(d.login_start_enabled());
        let text = std::fs::read_to_string(d.autostart_path()).unwrap();
        assert!(text.contains("--managed-by process"));
        d.set_login_start(&spec(t.path(), "b1"), false).unwrap();
        assert!(!d.login_start_enabled());
        // Turning off what is already off is fine.
        d.set_login_start(&spec(t.path(), "b1"), false).unwrap();
    }

    #[test]
    fn places_follow_xdg_config_home() {
        let p = Places::for_user(Path::new("/data"));
        assert!(p.systemd_user.ends_with("systemd/user"));
        assert!(p.autostart.ends_with("autostart"));
        assert_eq!(p.data_dir, PathBuf::from("/data"));
    }

    #[cfg(unix)]
    #[test]
    fn a_detached_start_outlives_its_starter_and_writes_to_the_log() {
        // A stand-in for the server: a shell script that records its arguments
        // and its session, in a temporary directory. No real service starts.
        let t = TempDir::new("detached");
        let data = t.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let exe = t.path().join("fake-server.sh");
        std::fs::write(
            &exe,
            "#!/bin/sh\necho \"args: $*\"\nps -o sid= -p $$ > \"$PWD/sid\"\necho $PPID > \"$PWD/ppid\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let s = ServiceSpec {
            exe,
            data_dir: data.clone(),
            build: "b1".into(),
            log: data.join("sidecar.log"),
            path_env: None,
        };
        spawn_detached(&s, "process").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !data.join("ppid").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        let log = std::fs::read_to_string(data.join("sidecar.log")).unwrap();
        assert!(log.contains("args: service --data-dir"));
        assert!(log.contains("--managed-by process"));
        // Not our child: the double fork handed it to init or a reaper.
        let ppid: u32 = std::fs::read_to_string(data.join("ppid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_ne!(ppid, std::process::id());
        // Its own session, not ours.
        let sid: i32 = std::fs::read_to_string(data.join("sid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap_or(0);
        let ours = unsafe { libc::getsid(0) };
        assert_ne!(sid, ours);
    }
}
