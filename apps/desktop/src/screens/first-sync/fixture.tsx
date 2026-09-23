// What the browser dev server renders for `?screen=first-sync` (and
// `&state=pacing` or `&state=error`): the screen over a fixed reading, the
// same numbers the mock's design/js/screens/first-sync.js draws, so the
// headless shot compares like with like. Never loaded in the app.

import type { FirstSyncProgress } from "@monday/shared";
import { useShell } from "../../shell/Shell.tsx";
import { FirstSyncView } from "../FirstSync.tsx";
import { emptyTracker, fill, formatEta, phaseLines } from "./model.ts";

export const FIXTURE_PROGRESS: FirstSyncProgress = {
  accountId: "acct-genai",
  workspaceId: "ws-genai",
  provider: "gmail",
  address: "tejas@genai-labs.io",
  headers: { done: 12_418, total: 12_418, complete: true },
  bodies: { done: 380, total: 640, complete: false },
  pacing: false,
  error: null,
  at: "2026-09-16T10:00:00Z",
};

export function FirstSyncFixture({ state }: { state: string | null }) {
  const s = useShell().settings;
  const progress: FirstSyncProgress =
    state === "pacing"
      ? { ...FIXTURE_PROGRESS, pacing: true }
      : state === "error"
        ? {
            ...FIXTURE_PROGRESS,
            error: { kind: "auth", message: "invalid_grant" },
          }
        : FIXTURE_PROGRESS;
  const error = progress.error
    ? fill(s["strings.first_sync.error.auth"], {
        provider: s["strings.first_sync.provider.gmail"],
        address: progress.address,
      })
    : null;
  return (
    <div className="app" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <FirstSyncView
        address={progress.address}
        provider={progress.provider}
        lines={phaseLines(progress, emptyTracker(), "inbox_bodies", s)}
        eta={formatEta(2 * 60_000, s)}
        pacing={progress.pacing}
        error={error}
        onRetry={() => {}}
        onSettings={() => {}}
        s={s}
      />
    </div>
  );
}
