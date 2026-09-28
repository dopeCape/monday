// Run history's words (docs/spec/workflows.md): every Workflow's Runs,
// newest first, each in four states (running, waiting, done, failed), what
// started it, how long it took and, for a failed Run, the Step it stopped
// at. Pure over RunView and the strings.workflows.run_history.* Settings.

import type { RunView, Settings } from "@monday/shared";
import { fill } from "../inbox/triage.ts";

type HistoryKey = Extract<keyof Settings, `strings.workflows.run_history.${string}`>;
export type HistoryStrings = Pick<Settings, HistoryKey>;

const PREFIX = "strings.workflows.run_history.";

/** Run history's words out of Settings. */
export function historyStrings(settings: Settings): HistoryStrings {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(PREFIX)) out[key] = value;
  }
  return out as HistoryStrings;
}

/** The four states a Run shows as: queued reads as running, paused as waiting. */
export type HistoryState = "running" | "waiting" | "done" | "failed";

export function historyState(run: Pick<RunView, "status">): HistoryState {
  switch (run.status) {
    case "queued":
    case "running":
      return "running";
    case "paused":
      return "waiting";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

export function stateLabel(state: HistoryState, s: HistoryStrings): string {
  return s[`strings.workflows.run_history.state.${state}`];
}

/** What started the Run, in plain words. */
export function triggerLabel(run: Pick<RunView, "trigger">, s: HistoryStrings): string {
  return s[`strings.workflows.run_history.trigger.${run.trigger.kind}`];
}

/** A length of time in the user's units: "42 s", "3 min", "1 h 4 min". */
export function durationText(ms: number, s: HistoryStrings): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return fill(s["strings.workflows.run_history.seconds"], { n: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return fill(s["strings.workflows.run_history.minutes"], { n: minutes });
  return fill(s["strings.workflows.run_history.hours"], {
    h: Math.floor(minutes / 60),
    m: minutes % 60,
  });
}

/** "Took 42 s", or "Still running" for a Run that has not finished. */
export function durationLine(
  run: Pick<RunView, "startedAt" | "finishedAt">,
  s: HistoryStrings,
): string {
  if (!run.finishedAt) return s["strings.workflows.run_history.still_running"];
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return fill(s["strings.workflows.run_history.took"], { duration: durationText(ms, s) });
}

/** For a failed Run: "Failed at step 2, Notion"; null when no Step is named. */
export function failedStepLine(
  run: Pick<RunView, "status" | "failedStep" | "steps">,
  s: HistoryStrings,
): string | null {
  if (run.status !== "failed") return null;
  const step =
    (run.failedStep !== null ? run.steps.find((st) => st.index === run.failedStep) : undefined) ??
    run.steps.find((st) => st.status === "failed");
  if (!step) return null;
  return fill(s["strings.workflows.run_history.failed_at"], {
    n: step.index + 1,
    step: step.name,
  });
}

/** The newest Runs first, at most `limit` of them. */
export function newestRuns(runs: readonly RunView[], limit: number): RunView[] {
  return [...runs]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
    .slice(0, limit);
}
