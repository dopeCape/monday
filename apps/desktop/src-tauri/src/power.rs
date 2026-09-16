//! Power and network conditions for the pre-warm Job (ADR 0011): bodies are
//! fetched in the background only on mains power and an unmetered connection,
//! so the two commands here answer "may the Cache spend battery and data?".
//!
//! Linux reads `/sys/class/power_supply` directly (no crate, no daemon): a
//! `Mains` or `USB` supply that is `online`, or the absence of any `Battery`
//! supply, means mains. Metered networks are asked of NetworkManager through
//! `nmcli` when it is installed; without it a connection is assumed unmetered.
//! Other platforms are stubs for now (see the TODOs), reporting mains and
//! unmetered so the Job runs rather than never runs.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PowerInfo {
    /// True on mains or when there is no battery at all.
    pub mains: bool,
    /// Charge from 0 to 1, or None without a battery.
    pub level: Option<f64>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct NetworkInfo {
    pub online: bool,
    /// True on a connection the OS marks as metered; unknown reads as false.
    pub metered: bool,
}

#[tauri::command]
pub fn power_info() -> PowerInfo {
    read_power()
}

#[tauri::command]
pub fn network_info() -> NetworkInfo {
    read_network()
}

#[cfg(target_os = "linux")]
fn read_power() -> PowerInfo {
    read_power_from(std::path::Path::new("/sys/class/power_supply"))
}

/// The Linux reading, split out so a test can point it at a fake tree.
#[cfg(target_os = "linux")]
pub fn read_power_from(root: &std::path::Path) -> PowerInfo {
    let read = |p: std::path::PathBuf| std::fs::read_to_string(p).ok().map(|s| s.trim().to_string());
    let mut saw_battery = false;
    let mut battery_level: Option<f64> = None;
    let mut battery_charging = false;
    let mut mains_online = false;
    let Ok(entries) = std::fs::read_dir(root) else {
        return PowerInfo { mains: true, level: None };
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let kind = read(dir.join("type")).unwrap_or_default();
        match kind.as_str() {
            "Battery" => {
                // A battery that is not present (an empty bay) does not count.
                if read(dir.join("present")).as_deref() == Some("0") {
                    continue;
                }
                saw_battery = true;
                let level = read(dir.join("capacity"))
                    .and_then(|c| c.parse::<f64>().ok())
                    .map(|c| (c / 100.0).clamp(0.0, 1.0));
                if level.is_some() {
                    battery_level = level;
                }
                let status = read(dir.join("status")).unwrap_or_default();
                if status == "Charging" || status == "Full" {
                    battery_charging = true;
                }
            }
            "Mains" | "USB" | "USB_PD" | "USB_C" | "USB_DCP" | "USB_CDP" | "USB_ACA" | "Wireless" => {
                if read(dir.join("online")).as_deref() == Some("1") {
                    mains_online = true;
                }
            }
            _ => {}
        }
    }
    PowerInfo {
        mains: !saw_battery || mains_online || battery_charging,
        level: battery_level,
    }
}

#[cfg(target_os = "linux")]
fn read_network() -> NetworkInfo {
    // NetworkManager marks connections metered (yes, no, guess-yes, guess-no);
    // `nmcli -t -f GENERAL.METERED dev show` prints one `GENERAL.METERED:<value>` per device.
    let output = std::process::Command::new("nmcli")
        .args(["-t", "-f", "GENERAL.STATE,GENERAL.METERED", "dev", "show"])
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            parse_nmcli(&text)
        }
        // No NetworkManager: assume online and unmetered rather than never pre-warming.
        _ => NetworkInfo { online: true, metered: false },
    }
}

/// Reads `nmcli -t -f GENERAL.STATE,GENERAL.METERED dev show`: a device is
/// connected when its state is 100; the connection is metered when any
/// connected device says `yes` or `guess-yes`.
#[cfg(target_os = "linux")]
pub fn parse_nmcli(text: &str) -> NetworkInfo {
    let mut online = false;
    let mut metered = false;
    let mut connected = false;
    for line in text.lines() {
        if let Some(state) = line.strip_prefix("GENERAL.STATE:") {
            connected = state.trim_start().starts_with("100");
            if connected {
                online = true;
            }
        } else if let Some(value) = line.strip_prefix("GENERAL.METERED:") {
            let v = value.trim();
            if connected && (v.starts_with("yes") || v.starts_with("guess-yes")) {
                metered = true;
            }
        }
    }
    NetworkInfo { online, metered }
}

#[cfg(not(target_os = "linux"))]
fn read_power() -> PowerInfo {
    // TODO: macOS via IOKit's IOPSCopyPowerSourcesInfo, Windows via GetSystemPowerStatus.
    PowerInfo { mains: true, level: None }
}

#[cfg(not(target_os = "linux"))]
fn read_network() -> NetworkInfo {
    // TODO: macOS via NWPathMonitor (isExpensive/isConstrained), Windows via NetworkInformation.
    NetworkInfo { online: true, metered: false }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;

    fn supply(root: &std::path::Path, name: &str, files: &[(&str, &str)]) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        for (k, v) in files {
            fs::write(dir.join(k), v).unwrap();
        }
    }

    #[test]
    fn no_battery_means_mains() {
        let root = std::env::temp_dir().join(format!("monday-power-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        supply(&root, "AC", &[("type", "Mains"), ("online", "0")]);
        assert_eq!(read_power_from(&root), PowerInfo { mains: true, level: None });
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn battery_discharging_is_not_mains() {
        let root = std::env::temp_dir().join(format!("monday-power-b-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        supply(&root, "AC", &[("type", "Mains"), ("online", "0")]);
        supply(&root, "BAT0", &[("type", "Battery"), ("present", "1"), ("capacity", "42"), ("status", "Discharging")]);
        assert_eq!(read_power_from(&root), PowerInfo { mains: false, level: Some(0.42) });
        fs::write(root.join("AC/online"), "1").unwrap();
        assert!(read_power_from(&root).mains);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn nmcli_metered_only_when_a_connected_device_says_so() {
        let text = "GENERAL.STATE:100 (connected)\nGENERAL.METERED:yes\nGENERAL.STATE:30 (disconnected)\nGENERAL.METERED:no\n";
        assert_eq!(parse_nmcli(text), NetworkInfo { online: true, metered: true });
        let text = "GENERAL.STATE:100 (connected)\nGENERAL.METERED:guess-no\n";
        assert_eq!(parse_nmcli(text), NetworkInfo { online: true, metered: false });
        let text = "GENERAL.STATE:20 (unavailable)\nGENERAL.METERED:yes\n";
        assert_eq!(parse_nmcli(text), NetworkInfo { online: false, metered: false });
    }
}
