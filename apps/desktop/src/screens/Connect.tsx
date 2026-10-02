// The phone's first run, "Connect to your monday" (platform/remote.ts). A
// phone has no Sidecar: it pairs with the user's monday by the Pairing invite
// the computer shows under Settings › Sync server › Devices › Add a phone.
// Scan the QR code where the platform has a camera scanner, or type the
// address and the short code (also how the Android emulator reaches the
// host's Sidecar, at http://10.0.2.2:<port>, and the iOS simulator at
// http://localhost:<port>). Before pairing there is no Server to read
// Settings from, so the words are the shipped defaults unless given.
//
// Also the status line a paired phone shows: "Connected to {name}", or that
// its monday is locked, unreachable, or signed this phone out.

import { defaultSettings, type Settings } from "@monday/shared";
import { Btn, Input } from "@monday/ui";
import {
  CheckCircleIcon,
  CircleNotchIcon,
  LockSimpleIcon,
  QrCodeIcon,
  WarningIcon,
  WifiSlashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { FetchLike } from "../platform/cloud.ts";
import {
  ConnectError,
  type ConnectErrorCode,
  type ConnectInput,
  connectPhone,
  REMOTE_STATE_STRING,
  type RemoteState,
  type RemoteTarget,
} from "../platform/remote.ts";

const ERROR_STRING = {
  not_a_code: "strings.mobile.connect.error.not_a_code",
  invalid_url: "strings.mobile.connect.error.invalid_url",
  insecure: "strings.mobile.connect.error.insecure",
  invalid_code: "strings.mobile.connect.error.invalid_code",
  unreachable: "strings.mobile.connect.error.unreachable",
  rejected: "strings.mobile.connect.error.rejected",
  too_many: "strings.mobile.connect.error.too_many",
  pin: "strings.mobile.connect.error.pin",
} as const satisfies Record<ConnectErrorCode, keyof Settings>;

export interface ConnectProps {
  /** This phone's name as the computer's Devices panel lists it. */
  deviceName: string;
  /** Called with the new target; the caller keeps it (saveRemoteTarget) and starts the Shell on it. */
  onConnected: (target: RemoteTarget) => void;
  /** The camera scanner (Platform.scanQr); absent, only typing is offered. */
  scanQr?: (() => Promise<string | null>) | undefined;
  fetch?: FetchLike | undefined;
  pinnedFetch?: ((fingerprint: string) => FetchLike) | undefined;
  /** The words; the shipped defaults before any Server is known. */
  settings?: Settings | undefined;
}

export function Connect(props: ConnectProps) {
  const s = props.settings ?? defaultSettings();
  const [manual, setManual] = useState(!props.scanQr);
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (input: ConnectInput) => {
    setBusy(true);
    setError(null);
    try {
      const target = await connectPhone(input, {
        name: props.deviceName,
        fetch: props.fetch,
        pinnedFetch: props.pinnedFetch,
      });
      props.onConnected(target);
    } catch (e) {
      setError(
        e instanceof ConnectError
          ? s[ERROR_STRING[e.code]]
          : s["strings.mobile.connect.error.unreachable"],
      );
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    const text = await props.scanQr?.().catch(() => null);
    if (text) await run({ kind: "scan", text });
  };

  return (
    <main className="connect-phone" data-screen="connect">
      <h1>{s["strings.mobile.connect.title"]}</h1>
      <p className="note">{s["strings.mobile.connect.help"]}</p>
      {props.scanQr ? (
        <Btn primary disabled={busy} onClick={() => void scan()}>
          <QrCodeIcon weight="bold" aria-hidden />
          {s["strings.mobile.connect.scan"]}
        </Btn>
      ) : null}
      {props.scanQr && !manual ? (
        <Btn sm onClick={() => setManual(true)}>
          {s["strings.mobile.connect.manual"]}
        </Btn>
      ) : null}
      {manual ? (
        <form
          className="wizard-fields"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ kind: "manual", url, code, fingerprint });
          }}
        >
          <label className="wizard-field" htmlFor="connect-url">
            <span>{s["strings.mobile.connect.url"]}</span>
            <Input
              id="connect-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={s["strings.mobile.connect.url_placeholder"]}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          <label className="wizard-field" htmlFor="connect-code">
            <span>{s["strings.mobile.connect.code"]}</span>
            <Input
              id="connect-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ABCD-1234"
              autoCapitalize="characters"
              autoCorrect="off"
            />
          </label>
          <label className="wizard-field" htmlFor="connect-fingerprint">
            <span>{s["strings.mobile.connect.fingerprint"]}</span>
            <Input
              id="connect-fingerprint"
              value={fingerprint}
              onChange={(e) => setFingerprint(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          <Btn primary type="submit" disabled={busy || !url.trim() || !code.trim()}>
            {busy ? s["strings.mobile.connect.working"] : s["strings.mobile.connect.submit"]}
          </Btn>
        </form>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </main>
  );
}

const STATE_ICON = {
  connecting: CircleNotchIcon,
  connected: CheckCircleIcon,
  locked: LockSimpleIcon,
  unreachable: WifiSlashIcon,
  revoked: WarningIcon,
} as const satisfies Record<RemoteState, unknown>;

/** "Connected to {name}" and its other states, for the phone's chrome. */
export function RemoteStatus({
  state,
  name,
  settings,
}: {
  state: RemoteState;
  name: string;
  settings?: Settings | undefined;
}) {
  const s = settings ?? defaultSettings();
  const Icon = STATE_ICON[state];
  return (
    <div className="remote-status" data-remote-state={state} role="status">
      <Icon weight="bold" aria-hidden />
      <span>{s[REMOTE_STATE_STRING[state]].replaceAll("{name}", name)}</span>
    </div>
  );
}
