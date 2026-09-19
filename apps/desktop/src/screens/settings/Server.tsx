// Settings › Sync server, the Server panel (docs/spec/settings.md "Sync server";
// ADR 0005, ADR 0008): the current mode with health, the three upgrade cards
// with Deploy buttons while the install is Sidecar only, the database move and
// the re-pairing of this Device with the Cloud URL. The schema-backed controls
// (server.prefer, server.insecure_allowed and the rest of the Connection group)
// and the Devices list render from the schema-driven renderer beside this
// panel (slice 17). Every string is a Setting. The network is the Shell's api
// and a pairing fetch, so tests script both.

import {
  type Capabilities,
  type CloudPlatform,
  DEPLOYMENT_FEATURES,
  deployLink,
  type EnvVar,
  type Settings,
} from "@monday/shared";
import { Btn, Input, Tag } from "@monday/ui";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import {
  ApiError,
  type CopyResult,
  type ExportResult,
  type UpgradeStatus,
} from "../../platform/api.ts";
import {
  type FetchLike,
  normalizeCloudUrl,
  PairError,
  type PairOutcome,
  pairCloud,
} from "../../platform/cloud.ts";
import { platform } from "../../platform/tauri.ts";
import { useShell } from "../../shell/Shell.tsx";
import { Card } from "./render.tsx";
import { fill } from "./wizard.ts";

export interface ServerProps {
  /** The pairing transport; tests script it. Defaults to fetch. */
  pairFetch?: FetchLike | undefined;
  /** The name this Device pairs under. */
  deviceName?: string | undefined;
  /** Opens a Deploy link in the browser; defaults to the platform's opener. */
  openExternal?: ((url: string) => Promise<void>) | undefined;
}

const PLATFORMS: readonly CloudPlatform[] = ["vercel", "netlify", "container"];

function errorText(s: Settings, error: unknown): string {
  if (error instanceof PairError) {
    switch (error.code) {
      case "insecure":
        return s["strings.server.error.insecure"];
      case "unreachable":
        return s["strings.server.error.unreachable"];
      case "invalid_setup_code":
        return s["strings.server.error.invalid_setup_code"];
      case "expired":
        return s["strings.server.error.expired"];
      default:
        return fill(s["strings.server.error.generic"], { message: error.message });
    }
  }
  if (error instanceof ApiError && error.status === 0) return s["strings.server.error.unreachable"];
  const message = error instanceof Error ? error.message : String(error);
  return fill(s["strings.server.error.generic"], { message });
}

export interface ServerPanelProps extends ServerProps {
  /** "server" renders the mode line; "cloud" the upgrade cards, the database move and the connection. Both by default. */
  part?: "server" | "cloud" | undefined;
}

export function Server({
  pairFetch,
  deviceName = "This device",
  openExternal,
  part,
}: ServerPanelProps) {
  const shell = useShell();
  const s = shell.settings;
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [upgrade, setUpgrade] = useState<UpgradeStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!shell.server) {
      setCaps(null);
      setHealthy(null);
      return;
    }
    try {
      setCaps(await shell.api.capabilities());
      setHealthy(true);
    } catch {
      setHealthy(false);
    }
    if (shell.sidecar?.running) {
      setUpgrade(await shell.api.upgrade.status().catch(() => null));
    }
  }, [shell.api, shell.server, shell.sidecar]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const topology = caps?.topology ?? (shell.cloud ? "cloud" : "sidecar");
  const modeLabel = s[`strings.server.mode.${topology}`];
  const target =
    shell.server?.kind === "cloud"
      ? fill(s["strings.server.target.cloud"], { host: hostOf(shell.server.target.baseUrl) })
      : shell.server?.kind === "sidecar" && shell.sidecar
        ? fill(s["strings.server.target.sidecar"], { port: shell.sidecar.port })
        : s["strings.server.target.none"];

  const showServer = part !== "cloud";
  const showCloud = part !== "server";
  return (
    <div className="stack" data-panel={part ?? "server"}>
      {showServer ? (
        <Card title={s["strings.server.talking_to"]} hint={target} attrs={{ "data-panel": "mode" }}>
          <Tag kind={healthy === false ? "warn" : healthy ? "ok" : undefined}>
            {healthy === false ? s["strings.server.health.down"] : modeLabel}
          </Tag>
          <Btn
            sm
            onClick={() => {
              void shell.refreshServers().then(refresh);
            }}
          >
            {s["strings.server.check"]}
          </Btn>
        </Card>
      ) : null}

      {showCloud && topology === "sidecar" && !shell.cloud ? (
        <UpgradeCards
          openExternal={
            openExternal ?? ((url) => platform().then((host) => host.openExternal(url)))
          }
        />
      ) : null}

      {showCloud && shell.sidecar?.running ? <Move upgrade={upgrade} onDone={refresh} /> : null}

      {showCloud ? (
        <Connect pairFetch={pairFetch} deviceName={deviceName} onDone={refresh} />
      ) : null}
    </div>
  );
}

/** A labelled input row in the wizard's style; the child gets the label's id. */
function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string | undefined;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="wizard-field">
      <label className="wizard-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {help ? <span className="help">{help}</span> : null}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* ------------------------------ Upgrade cards ------------------------------ */

function UpgradeCards({ openExternal }: { openExternal: (url: string) => Promise<void> }) {
  const shell = useShell();
  const s = shell.settings;
  const repo = s["server.deploy_repo"];
  return (
    <Card
      title={s["strings.server.upgrade.title"]}
      block
      attrs={{ "data-panel": "upgrade" }}
    >
      <div className="upgrade-cards">
        {PLATFORMS.map((p) => {
          const link = deployLink(p, repo);
          const mode = p === "container" ? "container" : p;
          const f = DEPLOYMENT_FEATURES[mode];
          const adds = [
            f.pushWebhooks ? s["strings.server.card.push"] : null,
            f.scheduledSendsWhileClosed ? s["strings.server.card.closed"] : null,
            f.holdsConnections ? s["strings.server.card.connections"] : null,
          ].filter((x): x is string => x !== null);
          return (
            <div className="upgrade-card" key={p} data-platform={p}>
              <b>{s[`strings.server.card.${p}.title`]}</b>
              <span>{s[`strings.server.card.${p}.blurb`]}</span>
              <span className="adds">
                {s["strings.server.card.gives"]} {adds.join(", ")}.
              </span>
              <EnvList env={link.env} />
              <Btn
                primary={p !== "container"}
                onClick={() => {
                  void openExternal(link.url);
                }}
              >
                {p === "container"
                  ? s["strings.server.card.guide"]
                  : s["strings.server.card.deploy"]}
              </Btn>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function EnvList({ env }: { env: EnvVar[] }) {
  const s = useShell().settings;
  return (
    <div className="env-list">
      <i>{s["strings.server.card.env"]}</i>
      {env.map((e) => (
        <div key={e.name} className={e.required ? "req" : ""}>
          <code>{e.name}</code>
          <span>{e.help}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ Move the database ------------------------------ */

function Move({ upgrade, onDone }: { upgrade: UpgradeStatus | null; onDone: () => void }) {
  const shell = useShell();
  const s = shell.settings;
  const [dbUrl, setDbUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<CopyResult | null>(null);
  const [exported, setExported] = useState<ExportResult | null>(upgrade?.lastExport ?? null);
  const [error, setError] = useState<string | null>(null);

  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      setCopied(await shell.api.upgrade.copy(dbUrl.trim(), true));
      onDone();
    } catch (e) {
      setError(errorText(s, e));
    } finally {
      setBusy(false);
    }
  };
  const exportDump = async () => {
    setBusy(true);
    setError(null);
    try {
      setExported(await shell.api.upgrade.export());
    } catch (e) {
      setError(errorText(s, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={s["strings.server.move.title"]}
      hint={s["strings.server.move.db_help"]}
      block
      attrs={{ "data-panel": "move" }}
      foot={
        <>
          {copied ? (
            <span className="ok">
              {fill(s["strings.server.move.copied"], {
                tables: copied.tables.length,
                rows: copied.tables.reduce((n, t) => n + t.rows, 0),
              })}
            </span>
          ) : null}
          {exported ? (
            <span className="ok">
              {fill(s["strings.server.move.exported"], { path: exported.path })}.{" "}
              {s["strings.server.move.export_help"]}
            </span>
          ) : null}
          {error ? <span className="err">{error}</span> : null}
          <span className="sp" />
          {upgrade?.canExport ? (
            <Btn sm disabled={busy} onClick={() => void exportDump()}>
              {s["strings.server.move.export"]}
            </Btn>
          ) : null}
          <Btn sm primary disabled={busy || !dbUrl.trim()} onClick={() => void copy()}>
            {busy ? s["strings.server.move.copying"] : s["strings.server.move.copy"]}
          </Btn>
        </>
      }
    >
      <div className="wizard-fields">
        <Field label={s["strings.server.move.db_url"]}>
          {(id) => (
            <Input
              id={id}
              value={dbUrl}
              onChange={(e) => setDbUrl(e.target.value)}
              placeholder="postgres://user:password@host/monday"
              spellCheck={false}
              autoComplete="off"
            />
          )}
        </Field>
      </div>
    </Card>
  );
}

/* ------------------------------ Connect (re-pair) ------------------------------ */

function Connect({
  pairFetch,
  deviceName,
  onDone,
}: {
  pairFetch: FetchLike | undefined;
  deviceName: string;
  onDone: () => void;
}) {
  const shell = useShell();
  const s = shell.settings;
  const [url, setUrl] = useState(shell.cloud?.baseUrl ?? s["server.url"]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Extract<PairOutcome, { status: "confirm" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attach, setAttach] = useState<{ dbUrl: string; done: boolean }>({
    dbUrl: "",
    done: false,
  });

  const connect = async () => {
    const base = normalizeCloudUrl(url);
    if (!base) {
      setError(s["strings.server.error.invalid_url"]);
      return;
    }
    setBusy(true);
    setError(null);
    setConfirm(null);
    try {
      const outcome = await pairCloud(base, code, {
        name: deviceName,
        insecureAllowed: s["server.insecure_allowed"],
        ...(pairFetch ? { fetch: pairFetch } : {}),
      });
      if (outcome.status === "paired") {
        await shell.setCloud(outcome.target);
        await shell.set("server.url", base);
        onDone();
      } else {
        setConfirm(outcome);
        const target = await outcome.claim();
        setConfirm(null);
        await shell.setCloud(target);
        await shell.set("server.url", base);
        onDone();
      }
    } catch (e) {
      setConfirm(null);
      setError(errorText(s, e));
    } finally {
      setBusy(false);
    }
  };

  const doAttach = async () => {
    setBusy(true);
    setError(null);
    try {
      await shell.api.upgrade.attach(attach.dbUrl.trim());
      setAttach((a) => ({ ...a, done: true }));
    } catch (e) {
      setError(errorText(s, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={s["strings.server.connect.title"]}
      hint={
        shell.cloud
          ? fill(s["strings.server.connect.done"], { host: hostOf(shell.cloud.baseUrl) })
          : s["strings.server.connect.code_help"]
      }
      block
      attrs={{ "data-panel": "connect" }}
      foot={
        <>
          {confirm ? (
            <span>{fill(s["strings.server.connect.confirm"], { code: confirm.code })}</span>
          ) : null}
          {attach.done ? <span className="ok">{s["strings.server.connect.restart"]}</span> : null}
          {error ? <span className="err">{error}</span> : null}
          <span className="sp" />
          {shell.cloud ? (
            <>
              {shell.sidecar?.running ? (
                <Btn
                  sm
                  primary
                  disabled={busy || !attach.dbUrl.trim()}
                  onClick={() => void doAttach()}
                >
                  {s["strings.server.connect.attach"]}
                </Btn>
              ) : null}
              <Btn
                sm
                onClick={() => {
                  void shell.setCloud(null).then(onDone);
                }}
              >
                {s["strings.server.connect.forget"]}
              </Btn>
            </>
          ) : (
            <Btn
              sm
              primary
              disabled={busy || !url.trim() || !code.trim()}
              onClick={() => void connect()}
            >
              {busy ? s["strings.server.connect.connecting"] : s["strings.server.connect.button"]}
            </Btn>
          )}
        </>
      }
    >
      {shell.cloud ? (
        <div className="wizard-fields">
          {shell.sidecar?.running ? (
            <Field
              label={s["strings.server.connect.attach"]}
              help={s["strings.server.connect.attach_help"]}
            >
              {(id) => (
                <Input
                  id={id}
                  value={attach.dbUrl}
                  onChange={(e) => setAttach({ dbUrl: e.target.value, done: false })}
                  placeholder="postgres://user:password@host/monday"
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
            </Field>
          ) : null}
        </div>
      ) : (
        <div className="wizard-fields">
          <Field label={s["strings.server.connect.url"]}>
            {(id) => (
              <Input
                id={id}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://monday-server.vercel.app"
                spellCheck={false}
                autoComplete="off"
              />
            )}
          </Field>
          <Field label={s["strings.server.connect.code"]}>
            {(id) => (
              <Input
                id={id}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            )}
          </Field>
        </div>
      )}
    </Card>
  );
}
