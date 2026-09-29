// Settings › Sync server › Background service (ADR 0013): the Sidecar keeps
// running with the window closed, and this card says so. Running since when,
// its PID and memory, who runs it (systemd, launchd or itself), whether it is
// locked, and the two things the user may do on purpose: Restart, and Stop
// (asked first, since mail stops syncing until monday opens again). Stopped,
// it offers Start. Every string is a Setting; the status is GET /service and
// the actions are the host's (src-tauri/src/sidecar.rs), so tests script both.

import type { ServiceStatus } from "@monday/shared";
import { Btn, formatWhen, Tag } from "@monday/ui";
import { useCallback, useEffect, useState } from "react";
import { platform } from "../../platform/tauri.ts";
import { useShell } from "../../shell/Shell.tsx";
import { Card, DangerAction } from "./render.tsx";
import { fill } from "./wizard.ts";

/** The host's controls; the app's by default. */
export interface ServiceHost {
  stop(): Promise<void>;
  restart(): Promise<unknown>;
}

const appHost: ServiceHost = {
  stop: () => platform().then((p) => p.sidecarStop()),
  restart: () => platform().then((p) => p.sidecarRestart()),
};

export interface ServiceCardProps {
  host?: ServiceHost | undefined;
  now?: (() => Date) | undefined;
}

/** Megabytes, whole, of the server and its Postgres together. */
export function memoryMb(status: Pick<ServiceStatus, "rssBytes" | "postgresRssBytes">): number {
  return Math.round((status.rssBytes + (status.postgresRssBytes ?? 0)) / (1024 * 1024));
}

export function ServiceCard({ host = appHost, now = () => new Date() }: ServiceCardProps) {
  const shell = useShell();
  const s = shell.settings;
  const running = shell.sidecar?.running ?? false;
  const known = shell.sidecar !== null;
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!running) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await shell.api.service.status());
    } catch {
      setStatus(null);
    }
  }, [running, shell.api]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
    } catch (e) {
      setError(
        fill(s["strings.server.service.failed"], {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!known) return null;

  const line = !running
    ? s["strings.server.service.stopped"]
    : status
      ? fill(s["strings.server.service.running"], {
          since: formatWhen(status.startedAt, now()),
          pid: status.pid,
          mb: memoryMb(status),
        })
      : undefined;

  return (
    <Card
      title={s["strings.server.service.title"]}
      hint={line}
      block
      attrs={{ "data-panel": "service", "data-running": running ? "true" : "false" }}
      below={
        <div className="stack">
          <span className="help">{s["strings.server.service.help"]}</span>
          {status && !status.unlocked ? (
            <span className="note" data-service="locked">
              {s["strings.server.service.locked"]}
            </span>
          ) : null}
        </div>
      }
      foot={
        <>
          {status ? <span>{s[`strings.server.service.managed.${status.managedBy}`]}</span> : null}
          {error ? <span className="err">{error}</span> : null}
          <span className="sp" />
          {running ? (
            <>
              <Btn sm disabled={busy} onClick={() => void act(host.restart)}>
                {busy ? s["strings.server.service.working"] : s["strings.server.service.restart"]}
              </Btn>
              <DangerAction
                label={s["strings.server.service.stop"]}
                confirm={s["strings.server.service.stop_confirm"]}
                busy={busy}
                onConfirm={() => act(host.stop)}
              />
            </>
          ) : (
            <Btn sm primary disabled={busy} onClick={() => void act(host.restart)}>
              {busy ? s["strings.server.service.working"] : s["strings.server.service.start"]}
            </Btn>
          )}
        </>
      }
    >
      <Tag kind={running ? "ok" : "warn"}>
        {running
          ? s["strings.server.service.state.running"]
          : s["strings.server.service.state.stopped"]}
      </Tag>
    </Card>
  );
}
