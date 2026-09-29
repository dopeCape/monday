//! The Sidecar as a background service (ADR 0013). The app no longer owns the
//! server process: it finds the one already running (the runtime file, then
//! GET /service with the token), reuses it when it runs the bundled build,
//! replaces it gracefully when the app was updated, cleans up after one that
//! died, and otherwise starts one through the platform's service manager so it
//! keeps running after the window closes. `ensure` is the decision loop over a
//! `Host`, so the loop is tested with a scripted host and the real one does the
//! files, processes and HTTP.

pub mod decide;
pub mod http;
pub mod install;
pub mod launch;
pub mod runtime;
#[cfg(test)]
pub mod testdir;
pub mod token;
pub mod units;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use decide::{decide, Found, Health, Plan};
use runtime::RuntimeInfo;
use units::ServiceSpec;

/// What the loop needs from the world.
pub trait Host {
    fn runtime(&self) -> Option<(RuntimeInfo, Duration)>;
    fn remove_runtime(&self);
    /// Alive and the Sidecar's own process.
    fn alive(&self, pid: u32) -> bool;
    fn health(&self, port: u16) -> Health;
    /// Makes the service go: POST /service/stop when graceful, then the
    /// service manager, then signals. Ok once the process is gone.
    fn stop(&self, rt: &RuntimeInfo, graceful: bool) -> Result<(), String>;
    fn start(&self) -> Result<(), String>;
    fn sleep(&self, d: Duration);
    /// Time since the loop began.
    fn elapsed(&self) -> Duration;
    /// The end of the service's log, for an error message.
    fn log_tail(&self) -> String {
        String::new()
    }
}

/// How long a started service may take to write its runtime file at all.
pub const FIRST_SIGN: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(250);

/// Finds or starts the service and returns its port once it answers with this build.
pub fn ensure(host: &dyn Host, bundled_build: &str, deadline: Duration) -> Result<u16, String> {
    let mut started_at: Option<Duration> = None;
    let mut replaced = 0;
    let failed = |host: &dyn Host, why: &str| {
        let tail = host.log_tail();
        if tail.is_empty() {
            why.to_string()
        } else {
            format!("{why}. Last lines of the log:\n{tail}")
        }
    };
    loop {
        if host.elapsed() > deadline {
            return Err(failed(
                host,
                "the background service did not become ready in time",
            ));
        }
        let found = host.runtime();
        let rt = found.as_ref().map(|(r, _)| r);
        let age = found.as_ref().map(|(_, a)| *a).unwrap_or_default();
        let alive = rt.map(|r| host.alive(r.pid)).unwrap_or(false);
        let health = match rt {
            Some(r) if alive && r.ready() => Some(host.health(r.port.unwrap_or_default())),
            _ => None,
        };
        let plan = decide(
            &Found {
                runtime: rt,
                age,
                alive,
                health,
            },
            bundled_build,
        );
        if !matches!(plan, Plan::Wait) {
            eprintln!(
                "[monday] sidecar: {plan:?} (alive: {alive}, health: {:?})",
                health_label(rt, alive, host)
            );
        }
        match plan {
            Plan::Reuse { port } => return Ok(port),
            Plan::Wait => host.sleep(POLL),
            Plan::Start | Plan::CleanThenStart => {
                if plan == Plan::CleanThenStart {
                    host.remove_runtime();
                }
                match started_at {
                    None => {
                        host.start()?;
                        started_at = Some(host.elapsed());
                    }
                    // Ours exited before it was ready.
                    Some(_) if plan == Plan::CleanThenStart => {
                        return Err(failed(
                            host,
                            "the background service stopped while starting",
                        ));
                    }
                    Some(at) if host.elapsed() - at > FIRST_SIGN => {
                        return Err(failed(host, "the background service did not start"));
                    }
                    Some(_) => host.sleep(POLL),
                }
            }
            Plan::Replace { graceful, .. } => {
                let rt = rt.expect("replace has a runtime file");
                if replaced >= 2 {
                    return Err(failed(
                        host,
                        "the running background service could not be replaced",
                    ));
                }
                replaced += 1;
                host.stop(rt, graceful)?;
                host.remove_runtime();
                host.start()?;
                started_at = Some(host.elapsed());
            }
        }
    }
}

/** What the last health check said, for the log line; asked again only for the log. */
fn health_label(rt: Option<&RuntimeInfo>, alive: bool, host: &dyn Host) -> Option<Health> {
    match rt {
        Some(r) if alive && r.ready() => Some(host.health(r.port.unwrap_or_default())),
        _ => None,
    }
}

/* ------------------------------ the real host ------------------------------ */

pub struct RealHost {
    pub data_dir: PathBuf,
    pub token: String,
    pub bundled_exe: PathBuf,
    pub resources: PathBuf,
    pub build: String,
    pub launcher: Box<dyn launch::Launcher>,
    pub began: Instant,
}

pub const LOG_FILE: &str = "sidecar.log";
/// How long a service asked to stop gets before the next, firmer way.
const STOP_WAIT: Duration = Duration::from_secs(25);

fn wait_gone(pid: u32, within: Duration) -> bool {
    let until = Instant::now() + within;
    while Instant::now() < until {
        if !runtime::sidecar_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !runtime::sidecar_alive(pid)
}

#[cfg(unix)]
fn signal(pid: u32, hard: bool) {
    // SAFETY: a signal to a pid we just confirmed is the Sidecar.
    unsafe {
        libc::kill(pid as i32, if hard { libc::SIGKILL } else { libc::SIGTERM });
    }
}

#[cfg(windows)]
fn signal(pid: u32, _hard: bool) {
    // No SIGTERM on Windows: the stop route is the graceful path; this is the last resort.
    let _ = launch::quiet_command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

#[cfg(not(any(unix, windows)))]
fn signal(_pid: u32, _hard: bool) {}

/// The service's status, as GET /service answers it.
pub fn service_status(port: u16, token: &str) -> Result<serde_json::Value, String> {
    let res = http::request(port, "GET", "/service", token, None, Duration::from_secs(3))?;
    if res.status != 200 {
        return Err(format!("GET /service answered {}", res.status));
    }
    serde_json::from_str(&res.body).map_err(|e| e.to_string())
}

/// Stops the service a runtime file names, as gently as it will go.
pub fn stop_service(
    rt: &RuntimeInfo,
    token: &str,
    graceful: bool,
    places: &launch::Places,
) -> Result<(), String> {
    if !runtime::sidecar_alive(rt.pid) {
        return Ok(());
    }
    if graceful {
        if let Some(port) = rt.port {
            let _ = http::request(
                port,
                "POST",
                "/service/stop",
                token,
                None,
                Duration::from_secs(5),
            );
            if wait_gone(rt.pid, STOP_WAIT) {
                return Ok(());
            }
        }
    }
    // A managed service is stopped by its manager, which would restart a killed one.
    let manager: Option<Box<dyn launch::Launcher>> = match rt.managed_by.as_str() {
        "systemd" => Some(Box::new(launch::Systemd {
            places: places.clone(),
        })),
        "launchd" => Some(Box::new(launch::Launchd {
            places: places.clone(),
        })),
        _ => None,
    };
    if let Some(m) = manager {
        if m.stop().is_ok() && wait_gone(rt.pid, STOP_WAIT) {
            return Ok(());
        }
    }
    signal(rt.pid, false);
    if wait_gone(rt.pid, Duration::from_secs(12)) {
        return Ok(());
    }
    signal(rt.pid, true);
    if wait_gone(rt.pid, Duration::from_secs(5)) {
        Ok(())
    } else {
        Err(format!(
            "the background service (pid {}) would not stop",
            rt.pid
        ))
    }
}

impl RealHost {
    pub fn spec(&self, exe: PathBuf) -> ServiceSpec {
        ServiceSpec {
            exe,
            data_dir: self.data_dir.clone(),
            build: self.build.clone(),
            log: self.data_dir.join(LOG_FILE),
            path_env: std::env::var("PATH").ok(),
        }
    }

    /// The installed copy's spec for this build (installing it when missing).
    pub fn installed_spec(&self) -> Result<ServiceSpec, String> {
        let exe = install::install(
            &self.bundled_exe,
            &self.resources,
            &self.data_dir,
            &self.build,
        )?;
        Ok(self.spec(exe))
    }
}

impl Host for RealHost {
    fn runtime(&self) -> Option<(RuntimeInfo, Duration)> {
        runtime::read(&self.data_dir)
    }
    fn remove_runtime(&self) {
        runtime::remove(&self.data_dir)
    }
    fn alive(&self, pid: u32) -> bool {
        runtime::sidecar_alive(pid)
    }
    fn health(&self, port: u16) -> Health {
        match http::request(
            port,
            "GET",
            "/service",
            &self.token,
            None,
            Duration::from_secs(3),
        ) {
            Ok(res) if res.status == 200 => serde_json::from_str::<serde_json::Value>(&res.body)
                .ok()
                .and_then(|v| v.get("build").and_then(|b| b.as_str()).map(str::to_string))
                .map(|build| Health::Healthy { build })
                .unwrap_or(Health::NoAnswer),
            Ok(res) if res.status == 401 => Health::Unauthorized,
            _ => Health::NoAnswer,
        }
    }
    fn stop(&self, rt: &RuntimeInfo, graceful: bool) -> Result<(), String> {
        stop_service(
            rt,
            &self.token,
            graceful,
            &launch::Places::for_user(&self.data_dir),
        )
    }
    fn start(&self) -> Result<(), String> {
        let spec = self.installed_spec()?;
        match self.launcher.start(&spec) {
            Ok(()) => Ok(()),
            Err(e) if self.launcher.manager() != "process" => {
                eprintln!(
                    "[monday] {} could not start the service ({e}); starting it on its own",
                    self.launcher.manager()
                );
                launch::spawn_detached(&spec, "process")
            }
            Err(e) => Err(e),
        }
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d)
    }
    fn elapsed(&self) -> Duration {
        self.began.elapsed()
    }
    fn log_tail(&self) -> String {
        tail(&self.data_dir.join(LOG_FILE), 12)
    }
}

/// The last lines of a file.
pub fn tail(path: &Path, lines: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A scripted world: a runtime file, which pids are alive, what /service
    /// says, and what the loop did about it.
    struct Script {
        rt: RefCell<Option<RuntimeInfo>>,
        age: Cell<Duration>,
        alive: RefCell<Vec<u32>>,
        health: RefCell<Health>,
        clock: Cell<Duration>,
        log: RefCell<Vec<String>>,
        /// What a start does: the runtime file it leads to after one poll.
        on_start: RefCell<Option<RuntimeInfo>>,
        on_start_health: RefCell<Health>,
    }

    fn rt(pid: u32, state: &str, port: Option<u16>, build: &str) -> RuntimeInfo {
        RuntimeInfo {
            pid,
            port,
            build: build.into(),
            started_at: "x".into(),
            state: state.into(),
            managed_by: "systemd".into(),
        }
    }

    impl Script {
        fn new(existing: Option<RuntimeInfo>, alive: &[u32], health: Health) -> Script {
            Script {
                rt: RefCell::new(existing),
                age: Cell::new(Duration::from_secs(1)),
                alive: RefCell::new(alive.to_vec()),
                health: RefCell::new(health),
                clock: Cell::new(Duration::ZERO),
                log: RefCell::new(vec![]),
                on_start: RefCell::new(Some(rt(200, "ready", Some(6000), "new"))),
                on_start_health: RefCell::new(Health::Healthy {
                    build: "new".into(),
                }),
            }
        }
        fn did(&self) -> Vec<String> {
            self.log.borrow().clone()
        }
    }

    impl Host for Script {
        fn runtime(&self) -> Option<(RuntimeInfo, Duration)> {
            self.rt.borrow().clone().map(|r| (r, self.age.get()))
        }
        fn remove_runtime(&self) {
            self.log.borrow_mut().push("remove".into());
            *self.rt.borrow_mut() = None;
        }
        fn alive(&self, pid: u32) -> bool {
            self.alive.borrow().contains(&pid)
        }
        fn health(&self, port: u16) -> Health {
            self.log.borrow_mut().push(format!("health {port}"));
            self.health.borrow().clone()
        }
        fn stop(&self, rt: &RuntimeInfo, graceful: bool) -> Result<(), String> {
            self.log
                .borrow_mut()
                .push(format!("stop {} graceful={graceful}", rt.pid));
            self.alive.borrow_mut().retain(|p| *p != rt.pid);
            Ok(())
        }
        fn start(&self) -> Result<(), String> {
            self.log.borrow_mut().push("start".into());
            if let Some(next) = self.on_start.borrow().clone() {
                self.alive.borrow_mut().push(next.pid);
                *self.rt.borrow_mut() = Some(next);
                *self.health.borrow_mut() = self.on_start_health.borrow().clone();
            }
            Ok(())
        }
        fn sleep(&self, d: Duration) {
            self.clock.set(self.clock.get() + d);
        }
        fn elapsed(&self) -> Duration {
            self.clock.get()
        }
    }

    const DEADLINE: Duration = Duration::from_secs(120);

    #[test]
    fn reuses_a_healthy_service_of_the_same_build_and_starts_nothing() {
        let s = Script::new(
            Some(rt(100, "ready", Some(5000), "new")),
            &[100],
            Health::Healthy {
                build: "new".into(),
            },
        );
        assert_eq!(ensure(&s, "new", DEADLINE).unwrap(), 5000);
        assert_eq!(s.did(), vec!["health 5000"]);
    }

    #[test]
    fn an_updated_app_stops_the_old_build_gracefully_and_starts_its_own() {
        let s = Script::new(
            Some(rt(100, "ready", Some(5000), "old")),
            &[100],
            Health::Healthy {
                build: "old".into(),
            },
        );
        assert_eq!(ensure(&s, "new", DEADLINE).unwrap(), 6000);
        assert_eq!(
            s.did(),
            vec![
                "health 5000",
                "stop 100 graceful=true",
                "remove",
                "start",
                "health 6000"
            ]
        );
    }

    #[test]
    fn a_stale_file_is_cleaned_up_and_a_fresh_one_started() {
        let s = Script::new(
            Some(rt(100, "ready", Some(5000), "new")),
            &[],
            Health::NoAnswer,
        );
        assert_eq!(ensure(&s, "new", DEADLINE).unwrap(), 6000);
        assert_eq!(s.did(), vec!["remove", "start", "health 6000"]);
    }

    #[test]
    fn nothing_running_starts_one() {
        let s = Script::new(None, &[], Health::NoAnswer);
        assert_eq!(ensure(&s, "new", DEADLINE).unwrap(), 6000);
        assert_eq!(s.did(), vec!["start", "health 6000"]);
    }

    #[test]
    fn a_hung_service_is_signalled_not_asked() {
        let s = Script::new(
            Some(rt(100, "ready", Some(5000), "new")),
            &[100],
            Health::NoAnswer,
        );
        assert_eq!(ensure(&s, "new", DEADLINE).unwrap(), 6000);
        assert_eq!(
            s.did(),
            vec![
                "health 5000",
                "stop 100 graceful=false",
                "remove",
                "start",
                "health 6000"
            ]
        );
    }

    #[test]
    fn a_service_still_starting_is_waited_for() {
        let s = Script::new(
            Some(rt(100, "starting", None, "new")),
            &[100],
            Health::NoAnswer,
        );
        // After two polls it is ready.
        let polls = Cell::new(0);
        struct Ready<'a>(&'a Script, &'a Cell<u32>);
        impl Host for Ready<'_> {
            fn runtime(&self) -> Option<(RuntimeInfo, Duration)> {
                if self.1.get() >= 2 {
                    *self.0.rt.borrow_mut() = Some(rt(100, "ready", Some(5000), "new"));
                    *self.0.health.borrow_mut() = Health::Healthy {
                        build: "new".into(),
                    };
                }
                self.0.runtime()
            }
            fn remove_runtime(&self) {
                self.0.remove_runtime()
            }
            fn alive(&self, pid: u32) -> bool {
                self.0.alive(pid)
            }
            fn health(&self, port: u16) -> Health {
                self.0.health(port)
            }
            fn stop(&self, rt: &RuntimeInfo, g: bool) -> Result<(), String> {
                self.0.stop(rt, g)
            }
            fn start(&self) -> Result<(), String> {
                self.0.start()
            }
            fn sleep(&self, d: Duration) {
                self.1.set(self.1.get() + 1);
                self.0.sleep(d)
            }
            fn elapsed(&self) -> Duration {
                self.0.elapsed()
            }
        }
        assert_eq!(ensure(&Ready(&s, &polls), "new", DEADLINE).unwrap(), 5000);
        assert!(!s.did().contains(&"start".to_string()));
    }

    #[test]
    fn a_start_that_never_shows_up_fails_with_a_reason() {
        let s = Script::new(None, &[], Health::NoAnswer);
        *s.on_start.borrow_mut() = None;
        let err = ensure(&s, "new", DEADLINE).unwrap_err();
        assert!(err.contains("did not start"), "{err}");
        assert_eq!(s.did(), vec!["start"]);
    }

    #[test]
    fn a_start_that_dies_fails_instead_of_starting_again() {
        let s = Script::new(None, &[], Health::NoAnswer);
        // It writes a file, then its pid is gone.
        *s.on_start.borrow_mut() = Some(rt(300, "starting", None, "new"));
        struct Dies<'a>(&'a Script);
        impl Host for Dies<'_> {
            fn runtime(&self) -> Option<(RuntimeInfo, Duration)> {
                self.0.runtime()
            }
            fn remove_runtime(&self) {
                self.0.remove_runtime()
            }
            fn alive(&self, _pid: u32) -> bool {
                false
            }
            fn health(&self, port: u16) -> Health {
                self.0.health(port)
            }
            fn stop(&self, rt: &RuntimeInfo, g: bool) -> Result<(), String> {
                self.0.stop(rt, g)
            }
            fn start(&self) -> Result<(), String> {
                self.0.start()
            }
            fn sleep(&self, d: Duration) {
                self.0.sleep(d)
            }
            fn elapsed(&self) -> Duration {
                self.0.elapsed()
            }
        }
        let err = ensure(&Dies(&s), "new", DEADLINE).unwrap_err();
        assert!(err.contains("stopped while starting"), "{err}");
        assert_eq!(s.did().iter().filter(|d| *d == "start").count(), 1);
    }

    #[test]
    fn a_service_that_keeps_coming_back_old_is_given_up_on() {
        let s = Script::new(
            Some(rt(100, "ready", Some(5000), "old")),
            &[100],
            Health::Healthy {
                build: "old".into(),
            },
        );
        // Every start brings the old build back (a stale copy somewhere).
        *s.on_start.borrow_mut() = Some(rt(101, "ready", Some(5001), "old"));
        *s.on_start_health.borrow_mut() = Health::Healthy {
            build: "old".into(),
        };
        let err = ensure(&s, "new", DEADLINE).unwrap_err();
        assert!(err.contains("could not be replaced"), "{err}");
    }

    #[test]
    fn the_log_tail_is_the_last_lines() {
        let t = testdir::TempDir::new("tail");
        let p = t.path().join("log");
        std::fs::write(&p, "a\nb\nc\nd\n").unwrap();
        assert_eq!(tail(&p, 2), "c\nd");
        assert_eq!(tail(&t.path().join("none"), 2), "");
    }
}
