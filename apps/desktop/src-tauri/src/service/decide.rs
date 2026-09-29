//! What the app does with the Sidecar it finds at launch (ADR 0013). Pure:
//! the runtime file, whether its process is alive, what /service answered
//! and the build this app bundles go in; a plan comes out.

use std::time::Duration;

use super::runtime::RuntimeInfo;

/// What GET /service with the app's token answered.
#[derive(Clone, Debug, PartialEq)]
pub enum Health {
    /// It answered, running this build.
    Healthy { build: String },
    /// It answered 401: it holds another token (the keychain entry was replaced).
    Unauthorized,
    /// No answer, or not one we understand: hung, or not listening.
    NoAnswer,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Plan {
    /// Nothing runs: start one.
    Start,
    /// The file names a process that is gone: remove the file, then start one.
    CleanThenStart,
    /// A service is starting (Postgres, migrations): wait for it.
    Wait,
    /// A healthy service of this build: use it, start nothing.
    Reuse { port: u16 },
    /// A service that must go: another build (the app was updated), a token it
    /// does not share, no answer, or a start that never finished. `graceful`
    /// asks it through POST /service/stop first; otherwise it is signalled.
    Replace {
        pid: u32,
        port: Option<u16>,
        graceful: bool,
    },
}

pub struct Found<'a> {
    pub runtime: Option<&'a RuntimeInfo>,
    /// How long ago the runtime file was written.
    pub age: Duration,
    /// Alive and the Sidecar's own process.
    pub alive: bool,
    /// None when it was not asked (not ready, or not alive).
    pub health: Option<Health>,
}

/// How long a service may stay "starting" before it counts as stuck.
pub const START_GRACE: Duration = Duration::from_secs(120);

pub fn decide(found: &Found<'_>, bundled_build: &str) -> Plan {
    let Some(rt) = found.runtime else {
        return Plan::Start;
    };
    if !found.alive {
        return Plan::CleanThenStart;
    }
    if !rt.ready() {
        return if found.age < START_GRACE {
            Plan::Wait
        } else {
            Plan::Replace {
                pid: rt.pid,
                port: None,
                graceful: false,
            }
        };
    }
    match &found.health {
        Some(Health::Healthy { build }) if build == bundled_build => Plan::Reuse {
            port: rt.port.unwrap_or_default(),
        },
        Some(Health::Healthy { .. }) => Plan::Replace {
            pid: rt.pid,
            port: rt.port,
            graceful: true,
        },
        Some(Health::Unauthorized) | Some(Health::NoAnswer) | None => Plan::Replace {
            pid: rt.pid,
            port: rt.port,
            graceful: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(state: &str, port: Option<u16>, build: &str) -> RuntimeInfo {
        RuntimeInfo {
            pid: 42,
            port,
            build: build.to_string(),
            started_at: "2026-09-29T08:00:00.000Z".to_string(),
            state: state.to_string(),
            managed_by: "systemd".to_string(),
        }
    }

    fn found<'a>(r: Option<&'a RuntimeInfo>, alive: bool, health: Option<Health>) -> Found<'a> {
        Found {
            runtime: r,
            age: Duration::from_secs(1),
            alive,
            health,
        }
    }

    #[test]
    fn nothing_running_starts_fresh() {
        assert_eq!(decide(&found(None, false, None), "b1"), Plan::Start);
    }

    #[test]
    fn a_dead_pid_is_cleaned_up_then_started() {
        let r = rt("ready", Some(5000), "b1");
        assert_eq!(
            decide(&found(Some(&r), false, None), "b1"),
            Plan::CleanThenStart
        );
    }

    #[test]
    fn a_healthy_service_of_the_same_build_is_reused() {
        let r = rt("ready", Some(5000), "b1");
        let h = Some(Health::Healthy { build: "b1".into() });
        assert_eq!(
            decide(&found(Some(&r), true, h), "b1"),
            Plan::Reuse { port: 5000 }
        );
    }

    #[test]
    fn another_build_is_asked_to_stop_and_replaced() {
        let r = rt("ready", Some(5000), "old");
        let h = Some(Health::Healthy {
            build: "old".into(),
        });
        assert_eq!(
            decide(&found(Some(&r), true, h), "new"),
            Plan::Replace {
                pid: 42,
                port: Some(5000),
                graceful: true
            }
        );
    }

    #[test]
    fn no_answer_or_another_token_is_signalled_and_replaced() {
        let r = rt("ready", Some(5000), "b1");
        for h in [Some(Health::NoAnswer), Some(Health::Unauthorized), None] {
            assert_eq!(
                decide(&found(Some(&r), true, h), "b1"),
                Plan::Replace {
                    pid: 42,
                    port: Some(5000),
                    graceful: false
                }
            );
        }
    }

    #[test]
    fn a_starting_service_is_waited_for_until_it_is_stuck() {
        let r = rt("starting", None, "b1");
        assert_eq!(decide(&found(Some(&r), true, None), "b1"), Plan::Wait);
        let stuck = Found {
            runtime: Some(&r),
            age: START_GRACE,
            alive: true,
            health: None,
        };
        assert_eq!(
            decide(&stuck, "b1"),
            Plan::Replace {
                pid: 42,
                port: None,
                graceful: false
            }
        );
    }
}
