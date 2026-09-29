use std::path::Path;

fn main() {
    refuse_busy_sidecar();
    tauri_build::build()
}

/// tauri-build copies `binaries/monday-server-<triple>` to
/// `target/<profile>/monday-server`. A Sidecar running from that copy (one
/// started before ADR 0013, or by hand) holds it open for execution, and the
/// copy would fail with a bare "Text file busy". Say what to do instead. The
/// background service normally runs from its own copy in the data directory
/// (src/service/install.rs), so a rebuild never touches it.
fn refuse_busy_sidecar() {
    let Ok(out) = std::env::var("OUT_DIR") else {
        return;
    };
    // OUT_DIR is target/<profile>/build/<crate>-<hash>/out.
    let Some(profile_dir) = Path::new(&out).ancestors().nth(3) else {
        return;
    };
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let exe = profile_dir.join(if windows {
        "monday-server.exe"
    } else {
        "monday-server"
    });
    if !exe.exists() {
        return;
    }
    // Opening for writing changes nothing; it only asks whether the file is in use.
    if let Err(e) = std::fs::OpenOptions::new().write(true).open(&exe) {
        // ETXTBSY on Linux, ERROR_SHARING_VIOLATION on Windows.
        let busy = matches!(e.raw_os_error(), Some(26) if !windows)
            || matches!(e.raw_os_error(), Some(32) if windows);
        if busy {
            panic!(
                "\n\nmonday's Sidecar is running from {exe}, so the build cannot replace it.\n\
                 Stop it first, then build again:\n\
                 \x20 systemctl --user stop monday-sidecar      (Linux with systemd)\n\
                 \x20 {exe} stop                                  (any platform)\n\
                 \x20 or Settings > Sync server > Background service > Stop\n\
                 See docs/dev/sidecar.md.\n",
                exe = exe.display()
            );
        }
    }
}
