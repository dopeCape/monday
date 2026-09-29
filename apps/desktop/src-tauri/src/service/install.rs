//! The service's own copy of the server (ADR 0013). The background service
//! does not run the executable inside the app bundle: an AppImage's mount is
//! gone once the app exits, an update replaces the bundle under a running
//! service, and a rebuild in development would hit "Text file busy". So each
//! build is copied once, with its Postgres and migrations, into
//! `<data dir>/sidecar/<build>/`, and the service runs from there. Older
//! copies are removed once a newer service is up.
//!
//! The build id is `resources/server-build` (written by `bun run stage` from
//! the binary's hash), else a fingerprint of the bundled binary.

use std::hash::Hasher;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const BUILD_FILE: &str = "server-build";
pub const SERVICE_DIR: &str = "sidecar";
const COMPLETE: &str = ".complete";

pub fn exe_name() -> &'static str {
    if cfg!(windows) {
        "monday-server.exe"
    } else {
        "monday-server"
    }
}

/// Only characters that are safe in a directory name and a unit file.
pub fn safe_build(build: &str) -> String {
    let s: String = build
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(64)
        .collect();
    // Never "." or "..": the name is joined to a directory that gets replaced.
    let s = s.trim_start_matches('.').to_string();
    if s.is_empty() {
        "unknown".to_string()
    } else {
        s
    }
}

/// The bundled server's build: the stage script's file, else a fingerprint of the binary.
pub fn bundled_build(resources: &Path, exe: &Path) -> Result<String, String> {
    if let Ok(text) = std::fs::read_to_string(resources.join(BUILD_FILE)) {
        let id = safe_build(text.trim());
        if id != "unknown" {
            return Ok(id);
        }
    }
    fingerprint(exe)
}

/// Length and a hash of every byte: stable for one binary, different for the next.
pub fn fingerprint(exe: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(exe).map_err(|e| format!("{}: {e}", exe.display()))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut len: u64 = 0;
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        len += n as u64;
        hasher.write(&buf[..n]);
    }
    Ok(format!("fp-{len:x}-{:016x}", hasher.finish()))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        // Follows symlinks: a library link becomes a copy, which Postgres loads the same.
        if std::fs::metadata(entry.path())?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// The service executable for this build, copied from the bundle when it is not there yet.
pub fn install(
    bundled_exe: &Path,
    resources: &Path,
    data_dir: &Path,
    build: &str,
) -> Result<PathBuf, String> {
    let root = data_dir.join(SERVICE_DIR);
    let dir = root.join(safe_build(build));
    let exe = dir.join(exe_name());
    if dir.join(COMPLETE).exists() && exe.exists() {
        return Ok(exe);
    }
    let partial = root.join(format!(
        "{}.partial-{}",
        safe_build(build),
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&partial);
    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(partial.join("resources"))?;
        std::fs::copy(bundled_exe, partial.join(exe_name()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                partial.join(exe_name()),
                std::fs::Permissions::from_mode(0o755),
            )?;
        }
        for sub in ["pg", "drizzle"] {
            let from = resources.join(sub);
            if from.exists() {
                copy_dir(&from, &partial.join("resources").join(sub))?;
            }
        }
        std::fs::write(partial.join(COMPLETE), build)?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&partial, &dir)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(format!("could not install the background service: {e}"));
    }
    Ok(exe)
}

/// Removes every copy but the one for `keep`; a copy still in use (Windows) stays.
pub fn prune(data_dir: &Path, keep: &str) {
    let keep = safe_build(keep);
    let Ok(entries) = std::fs::read_dir(data_dir.join(SERVICE_DIR)) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() != keep {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::testdir::TempDir;

    fn bundle(dir: &Path, content: &[u8]) -> (PathBuf, PathBuf) {
        let exe = dir.join("bundle").join(exe_name());
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, content).unwrap();
        let res = dir.join("bundle").join("resources");
        std::fs::create_dir_all(res.join("pg").join("bin")).unwrap();
        std::fs::write(res.join("pg").join("bin").join("postgres"), b"pg").unwrap();
        std::fs::create_dir_all(res.join("drizzle").join("meta")).unwrap();
        std::fs::write(
            res.join("drizzle").join("meta").join("_journal.json"),
            b"{}",
        )
        .unwrap();
        (exe, res)
    }

    #[test]
    fn the_build_is_the_stage_file_else_a_fingerprint_of_the_binary() {
        let t = TempDir::new("build");
        let (exe, res) = bundle(t.path(), b"server v1");
        let fp1 = bundled_build(&res, &exe).unwrap();
        assert!(fp1.starts_with("fp-9-"));
        assert_eq!(bundled_build(&res, &exe).unwrap(), fp1);
        std::fs::write(&exe, b"server v2").unwrap();
        assert_ne!(bundled_build(&res, &exe).unwrap(), fp1);
        std::fs::write(res.join(BUILD_FILE), "abc123\n").unwrap();
        assert_eq!(bundled_build(&res, &exe).unwrap(), "abc123");
        assert_eq!(safe_build("../x y/z"), "xyz");
        assert_eq!(safe_build(".."), "unknown");
        assert_eq!(safe_build("///"), "unknown");
    }

    #[test]
    fn install_copies_once_per_build_and_prune_keeps_the_current_one() {
        let t = TempDir::new("install");
        let data = t.path().join("data");
        let (exe, res) = bundle(t.path(), b"server v1");
        let installed = install(&exe, &res, &data, "b1").unwrap();
        assert_eq!(installed, data.join("sidecar").join("b1").join(exe_name()));
        assert_eq!(std::fs::read(&installed).unwrap(), b"server v1");
        assert!(data.join("sidecar/b1/resources/pg/bin/postgres").exists());
        assert!(data
            .join("sidecar/b1/resources/drizzle/meta/_journal.json")
            .exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&installed).unwrap().permissions().mode();
            assert_eq!(mode & 0o755, 0o755);
        }
        // The bundle changing under the same build does not recopy: the copy is the build's.
        std::fs::write(&exe, b"changed").unwrap();
        install(&exe, &res, &data, "b1").unwrap();
        assert_eq!(std::fs::read(&installed).unwrap(), b"server v1");

        let second = install(&exe, &res, &data, "b2").unwrap();
        assert_eq!(std::fs::read(&second).unwrap(), b"changed");
        prune(&data, "b2");
        assert!(!data.join("sidecar/b1").exists());
        assert!(data.join("sidecar/b2").exists());
        // No partial copy is left behind.
        let names: Vec<String> = std::fs::read_dir(data.join("sidecar"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["b2".to_string()]);
    }

    #[test]
    fn a_missing_bundle_is_an_error_and_leaves_nothing() {
        let t = TempDir::new("missing");
        let data = t.path().join("data");
        let err = install(&t.path().join("nope"), &t.path().join("res"), &data, "b1").unwrap_err();
        assert!(err.contains("could not install"));
        assert!(!data.join("sidecar/b1").exists());
    }
}
