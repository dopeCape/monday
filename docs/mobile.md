# monday on a phone

The desktop shell (`apps/desktop`) also builds for Android and iOS with Tauri 2
mobile. A phone is a **client of a paired Server**: Bun and the embedded
Postgres cannot run there, so there is no Sidecar on a phone. It reaches the
Server it was paired with (the Cloud target, `platform/cloud.ts`), keeps its own
Cache (SQLCipher, in the app's data directory) and its own keychain.

## What differs on a phone

The Rust side splits on Tauri's `desktop` / `mobile` cfg, so Android and iOS
are gated the same way; `target_os` appears only where the two differ (the
keychain).

| Part | Computer | Phone |
| --- | --- | --- |
| Sidecar, `service/` (systemd, launchd) | started and found at launch | not built |
| Local runtimes (`runtimes.rs`, shell plugin) | `claude`, `codex`, `opencode` spawn | not built; `spawn` rejects as not installed |
| Config file (`config.rs`) | `~/.config/monday/monday.toml`, watched | the app's private config directory, not watched |
| WebKitGTK memory (`webview_memory.rs`) | Linux only | not built |
| Links in a Message (`links.rs`) | new window requests go to the system browser | navigations to web or mail links go to the system browser |
| Power and network (`power.rs`) | read from the OS (Linux) | report battery and metered until read from the OS, so the pre-warm waits |
| Keychain (`secrets.rs`) | OS keychain (`keyring`) | Android: Keystore; iOS: Keychain (see below) |
| Cache (`db.rs`) | SQLCipher, vendored OpenSSL | the same |
| Capability | `capabilities/default.json` | `capabilities/mobile.json` (no shell, no spawn, no window frame) |
| Bundle | Sidecar binary and Postgres resources | none (`tauri.android.conf.json`, `tauri.ios.conf.json`) |

The webview learns which it is from `platform().kind` (`"desktop"` or
`"mobile"`, from the `platform_kind` command). On a phone the platform layer
answers the Sidecar's methods itself (`sidecarInfo` says not running, stop and
restart reject), has no window `frame`, and a config write tells its own
listeners. The browser dev server says `"desktop"` unless the URL has
`?kind=mobile`.

## The keychain on a phone

`secrets.rs` is the only place that touches a keychain; the root key and the
Cache keys go through it too, and the webview's `secret_get`, `secret_set` and
`secret_delete` commands are the same on every platform.

- **Android**: [`android-native-keyring-store`](https://crates.io/crates/android-native-keyring-store)
  (keyring-core). Each secret is encrypted with an AES key created in the
  Android Keystore, which never leaves it, and stored in the app's private
  SharedPreferences. The crate needs the Android context:
  `MainActivity.onCreate` hands it over through `io.crates.keyring.Keyring`
  (`gen/android/app/src/main/java/io/crates/keyring/Keyring.kt`).
- **iOS**: the `keyring` crate's Apple backend, a generic password in the iOS Keychain.

## Toolchain (this repo's NixOS setup)

- `shell.nix`'s Rust toolchain carries the Android targets
  (`aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`,
  `x86_64-linux-android`).
- `shell-android.nix` is `shell.nix` plus `ANDROID_HOME`, `NDK_HOME` and
  `JAVA_HOME` (JDK 21). The SDK is the one under `~/Android/Sdk` (set
  `ANDROID_HOME` first to use another); `NDK_HOME` is the newest NDK there.
- The NDK comes from the SDK manager (once; it is not in the repo):

  ```sh
  ~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager --install "ndk;27.3.13750724"
  ```

  On NixOS the NDK's prebuilt clang needs `nix-ld` (`programs.nix-ld.enable`).

## Android

The Android Studio project is `apps/desktop/src-tauri/gen/android`, generated
by `tauri android init` and committed; its build outputs are ignored.

Build a debug APK for the emulator (x86_64):

```sh
nix-shell shell-android.nix --run 'cd apps/desktop && bun tauri android build --debug --target x86_64 --apk'
```

The APK lands at
`apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
For a phone use `--target aarch64` (or leave `--target` out for all four).

Install and start it on a running emulator or a phone with USB debugging:

```sh
adb install -r apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n io.monday.desktop/.MainActivity
adb logcat | grep -i -e monday -e RustStdoutStderr
```

`bun tauri android dev` runs the app against the Vite dev server instead
(the phone must reach this machine).

## iOS

iOS builds need macOS with Xcode; they cannot be built on this machine.

**Without a Mac**: run the `ios` workflow (`.github/workflows/ios.yml`, Actions,
"Run workflow"). It generates the Xcode project on a macOS runner, builds a
debug app for the Simulator and uploads it as the `monday-ios-simulator`
artifact. Nothing is signed.

**On a Mac**:

1. Install Xcode (and its command line tools), then the Rust iOS targets:
   `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`.
2. `bun install`, then in `apps/desktop`: `bun tauri ios init` (creates
   `src-tauri/gen/apple`; it is not committed yet).
3. Simulator: `bun tauri ios dev` picks a booted Simulator, or
   `bun tauri ios build --debug --target aarch64-sim` and
   `xcrun simctl install booted <the .app under src-tauri/gen/apple/build>`.
4. A real iPhone needs a signing team. Set it in the environment, never in the
   config: `export APPLE_DEVELOPMENT_TEAM=<your team id>` (Xcode, Settings,
   Accounts), then `bun tauri ios build` or `bun tauri ios dev --open` to run
   from Xcode.

The minimum iOS version is 15.0 (`tauri.ios.conf.json`).

## What is verified

- Android: the debug APK builds here (x86_64). Running it on an emulator is
  the next check.
- iOS: configured (the keychain backend, the Cache's vendored OpenSSL, the
  config file, the capability, the workflow) but not compiled here; the
  workflow is the first real build.
