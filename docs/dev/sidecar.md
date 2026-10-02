# The Sidecar in development

Since ADR 0013 the Sidecar is a background service: closing the window, or stopping `tauri dev`, leaves it and its Postgres running. This note is the restart and rebuild procedure.

## Where it lives

Everything is in the app's data directory (`~/.local/share/io.monday.desktop` on Linux, `~/Library/Application Support/io.monday.desktop` on macOS, `%APPDATA%\io.monday.desktop` on Windows):

| File | What |
|---|---|
| `sidecar.json` | pid, port, build, start time, state, manager. Gone after a clean stop. |
| `sidecar.token` | the loopback token (0600), a copy of the keychain's `sidecar-token` |
| `sidecar.log`, `sidecar.log.1` | the service's output, rotated by size |
| `sidecar/<build>/` | the copy of `monday-server`, Postgres and the migrations the service runs |
| `postgres/` | the embedded database |

On Linux with systemd the unit is `~/.config/systemd/user/monday-sidecar.service`.

## Rebuilding

The service runs its own copy under `sidecar/<build>/`, so `bun run stage` and the Rust build never touch the running executable. The next app launch compares builds (`resources/server-build`, written by `bun run stage`) and replaces an older service by itself: it asks it to stop, waits for its Postgres to close, then starts the new copy. No manual stop is needed for a rebuild.

`resources/server-build` must exist for the Tauri build (it is listed in `tauri.conf.json`); `bun run stage` writes it.

## Stopping it by hand

Any of these, then wait for it to go (it finishes its Job leases and stops Postgres first):

```sh
systemctl --user stop monday-sidecar          # Linux with systemd
~/.local/share/io.monday.desktop/sidecar/*/monday-server stop   # any platform; reads sidecar.json
curl -X POST -H "Authorization: Bearer $(cat ~/.local/share/io.monday.desktop/sidecar.token)" \
  http://127.0.0.1:$(jq .port ~/.local/share/io.monday.desktop/sidecar.json)/service/stop
```

or Settings › Sync server › Background service › Stop. `monday-server status` prints the runtime file.

Stop by the pid in `sidecar.json`, never with `pkill -f monday` (it matches the shell that runs it). A service run by systemd is restarted after a crash or a kill, not after `systemctl --user stop` or `POST /service/stop`; stop it through systemd when in doubt.

## "Text file busy"

That means a Sidecar is running from the very file being replaced: one started before ADR 0013, or by hand from `binaries/` or `target/debug/`. `bun run stage` and the Rust build check for it and print the commands above instead of the bare error.

## Logs

```sh
tail -f ~/.local/share/io.monday.desktop/sidecar.log
```

## Login start

`server.sidecar.start_at_login` (Settings › Sync server › Background service) enables or disables the systemd unit, moves the LaunchAgent in or out of `~/Library/LaunchAgents`, writes or removes `~/.config/autostart/monday-sidecar.desktop` (Linux without systemd), or sets the Run key value (Windows). Tests never touch these places; they write into temporary directories.

## Pairing a phone in development

A phone is a Device of the running Sidecar (ADR 0006 amendment). The emulators reach the host without LAN access:

- Android emulator: the host's `127.0.0.1` is `10.0.2.2`. The address is `http://10.0.2.2:<port>`, the port from `sidecar.json`.
- iOS simulator: the host is `localhost`, so `http://localhost:<port>`; App Transport Security allows localhost.

Make an invite in Settings › Sync server › Devices › Add a phone (the short code is under the QR code), or from a shell:

```sh
DIR=~/.local/share/io.monday.desktop
curl -s -X POST -H "Authorization: Bearer $(cat $DIR/sidecar.token)" \
  http://127.0.0.1:$(jq .port $DIR/sidecar.json)/pair/invite | jq '{code, expiresAt}'
```

On the phone's Connect screen choose "Type it instead", enter the address and the code. The webview on Android must allow cleartext to `10.0.2.2` (the platform's network security config). The phone appears in the Devices list as a Phone; Revoke signs it out.

A real phone on the same Wi-Fi needs LAN access: turn on Let phones connect over your network (`server.lan.enabled`), restart the background service, and scan the QR code. The listener is `0.0.0.0:47820` (`server.lan.port`) over HTTPS with the certificate in `lan-tls/` of the data directory; deleting that folder makes a new certificate at the next start, and every phone paired by QR code must pair again.
