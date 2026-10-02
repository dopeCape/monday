// Add a phone (Settings › Sync server › Devices; ADR 0006 amended for
// phones). The card asks the Server for a Pairing invite and shows it as a QR
// code, the short code, the addresses and the LAN certificate's fingerprint;
// the phone's Connect screen scans or types it. LAN access (server.lan.*) is
// warned about here whatever its state: off means a phone cannot reach this
// computer, on means anyone on the network can reach the port, plain HTTP
// means mail crosses the network in the clear, and a changed Setting waits
// for a restart of the background service.

import {
  formatInviteCode,
  type LanStatus,
  type PairingInvite,
  shortFingerprint,
} from "@monday/shared";
import { Btn, formatWhen } from "@monday/ui";
import { DeviceMobileIcon, WarningIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useShell } from "../../shell/Shell.tsx";
import { QrCode } from "./QrCode.tsx";
import { Card, messageOf, useSettingsScreen } from "./render.tsx";
import { fill } from "./wizard.ts";

type Strings = ReturnType<typeof useShell>["settings"];

function Warn({ children, kind }: { children: string; kind: string }) {
  return (
    <div className="phone-warn" data-warn={kind}>
      <WarningIcon weight="bold" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** The warnings the LAN listener's state calls for; the saved Setting before an invite is made. */
export function lanWarnings(
  s: Strings,
  lan: LanStatus | null,
  enabled: boolean,
): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = [];
  if (!lan) {
    if (!enabled) out.push({ kind: "lan-off", text: s["strings.server.phone.lan_off"] });
    return out;
  }
  if (lan.restartNeeded) out.push({ kind: "restart", text: s["strings.server.phone.lan_restart"] });
  if (lan.error) {
    out.push({
      kind: "error",
      text: fill(s["strings.server.phone.lan_error"], { message: lan.error }),
    });
  }
  if (lan.listening) {
    out.push({
      kind: "lan-on",
      text: fill(s["strings.server.phone.lan_warning"], { port: String(lan.port) }),
    });
    if (!lan.tls) out.push({ kind: "plain", text: s["strings.server.phone.lan_plain"] });
  } else if (!lan.enabled) {
    out.push({ kind: "lan-off", text: s["strings.server.phone.lan_off"] });
  }
  return out;
}

export function PhoneInvite() {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [invite, setInvite] = useState<PairingInvite | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useRef(false);

  // Expiry flips the card to "make a new one"; the Server refuses it then anyway.
  useEffect(() => {
    if (!invite) return;
    const left = new Date(invite.expiresAt).getTime() - screen.now().getTime();
    if (left <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [invite, screen]);

  // An invite left open when the page closes is cancelled, best effort.
  useEffect(
    () => () => {
      if (open.current) void shell.api.devices.cancelInvite().catch(() => {});
    },
    [shell.api],
  );

  const make = () => {
    setBusy(true);
    setError(null);
    shell.api.devices
      .invite()
      .then((made) => {
        open.current = true;
        setExpired(false);
        setInvite(made);
      })
      .catch((e) => setError(fill(s["strings.settings.failed"], { message: messageOf(e) })))
      .finally(() => setBusy(false));
  };

  const cancel = () => {
    open.current = false;
    setInvite(null);
    setExpired(false);
    void shell.api.devices.cancelInvite().catch(() => {});
  };

  const warnings = lanWarnings(s, invite?.lan ?? null, shell.settings["server.lan.enabled"]);

  return (
    <Card
      title={
        <span className="with-mark">
          <span className="lg">
            <DeviceMobileIcon weight="bold" aria-hidden />
          </span>
          {s["strings.server.phone.title"]}
        </span>
      }
      hint={s["strings.server.phone.help"]}
      block
      attrs={{ "data-panel": "add-phone" }}
      below={
        <>
          {invite && !expired ? (
            <div className="phone-invite">
              <QrCode text={invite.payload} label={s["strings.server.phone.qr_label"]} />
              <dl>
                <dt>{s["strings.server.phone.code"]}</dt>
                <dd className="invite-code" data-invite-code>
                  {formatInviteCode(invite.code)}
                </dd>
                {invite.urls.map((url) => (
                  <FragmentRow key={url} label={s["strings.server.phone.address"]} value={url} />
                ))}
                {invite.fingerprint ? (
                  <>
                    <dt />
                    <dd data-fingerprint>
                      {fill(s["strings.server.phone.fingerprint"], {
                        fingerprint: shortFingerprint(invite.fingerprint),
                      })}
                    </dd>
                  </>
                ) : null}
                <dt />
                <dd>
                  {fill(s["strings.server.phone.expires"], {
                    when: formatWhen(invite.expiresAt, screen.now()),
                  })}
                </dd>
              </dl>
            </div>
          ) : null}
          {invite && expired ? (
            <div className="note">{s["strings.server.phone.expired"]}</div>
          ) : null}
          {warnings.map((w) => (
            <Warn key={w.kind} kind={w.kind}>
              {w.text}
            </Warn>
          ))}
        </>
      }
      foot={
        <>
          {error ? <span className="err">{error}</span> : null}
          <span className="sp" />
          {invite && !expired ? (
            <Btn sm onClick={cancel}>
              {s["strings.server.phone.cancel"]}
            </Btn>
          ) : null}
          <Btn sm primary={!invite || expired} disabled={busy} onClick={make}>
            {invite ? s["strings.server.phone.again"] : s["strings.server.phone.start"]}
          </Btn>
        </>
      }
    />
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-invite-url>{value}</dd>
    </>
  );
}
