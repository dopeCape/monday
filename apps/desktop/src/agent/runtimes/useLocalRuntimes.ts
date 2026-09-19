// Detection as the screens use it (docs/spec/settings.md, "the detected
// CLIs and their status"; docs/spec/agent-composer.md, Runtime differences):
// runs the checks once the host can spawn, again when a command Setting
// changes, and hands the statuses to the composer header and the AI
// settings page. Null while nothing was detected yet, or where nothing can
// be spawned (the browser dev server).

import type { LocalCli, RuntimeStatus, Settings } from "@monday/shared";
import { useEffect, useState } from "react";
import { detectRuntimes } from "./detect.ts";
import type { ProcessRunner } from "./process.ts";

export type LocalRuntimeStatuses = Record<LocalCli, RuntimeStatus>;

export function useLocalRuntimes(
  runner: ProcessRunner | null,
  settings: Settings,
): LocalRuntimeStatuses | null {
  const [statuses, setStatuses] = useState<LocalRuntimeStatuses | null>(null);
  const claude = settings["ai.local.path.claude-code"];
  const codex = settings["ai.local.path.codex"];
  const opencode = settings["ai.local.path.opencode"];
  const notInstalled = settings["strings.agent.not_installed"];
  const notLoggedIn = settings["strings.agent.not_logged_in"];
  useEffect(() => {
    if (!runner) return;
    let cancelled = false;
    void detectRuntimes({
      runner,
      commands: { "claude-code": claude, codex, opencode },
      strings: { notInstalled, notLoggedIn },
    }).then((found) => {
      if (!cancelled) setStatuses(found);
    });
    return () => {
      cancelled = true;
    };
  }, [runner, claude, codex, opencode, notInstalled, notLoggedIn]);
  return statuses;
}
