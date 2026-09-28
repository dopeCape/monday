// The app's Local runtime worker (localWorker.ts) as a hook: running while
// this Device's `ai.mode` is local, the AI level is not off, the Sidecar runs
// and the chosen command-line agent was detected ready; stopped otherwise.

import type { LocalCli, RuntimeStatus, Settings } from "@monday/shared";
import { useEffect, useRef } from "react";
import { createApi } from "../platform/api.ts";
import { backgroundMcpOf, startLocalWorker } from "./localWorker.ts";
import type { ProcessRunner } from "./runtimes/index.ts";

/** Whether this Device should take background work now, and with which CLI. */
export function localWorkerCli(
  settings: Pick<Settings, "ai.mode" | "ai.level" | "ai.local.cli">,
  statusOf: (cli: LocalCli) => RuntimeStatus | null,
): LocalCli | null {
  if (settings["ai.mode"] !== "local" || settings["ai.level"] === "off") return null;
  const cli = settings["ai.local.cli"];
  const status = statusOf(cli);
  return status?.installed && !status.reason ? cli : null;
}

export function useLocalWorker(options: {
  spawn: ProcessRunner | null;
  sidecar: { running: boolean; port: number; token: string } | null;
  settings: Settings;
  runtimes: Record<LocalCli, RuntimeStatus> | null;
}) {
  const settingsRef = useRef(options.settings);
  settingsRef.current = options.settings;
  const cli = localWorkerCli(options.settings, (c) => options.runtimes?.[c] ?? null);
  const { spawn, sidecar } = options;
  const port = sidecar?.running ? sidecar.port : null;
  const token = sidecar?.running ? sidecar.token : null;
  const model = cli ? options.settings[`ai.local.model.${cli}`] : "";
  const concurrency = options.settings["ai.local.background.concurrency"];
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model and concurrency are read at start; a change restarts the loops.
  useEffect(() => {
    if (!spawn || !cli || port === null || token === null) return;
    const target = { baseUrl: `http://127.0.0.1:${port}`, token };
    const worker = startLocalWorker({
      api: createApi(() => target),
      runner: spawn,
      mcp: backgroundMcpOf({ port, token }),
      cli,
      settings: () => settingsRef.current,
      log: (line) => console.warn(line),
    });
    return () => worker.stop();
  }, [spawn, cli, port, token, model, concurrency]);
}
