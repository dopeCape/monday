// A Workflow's state in one word for the list and the detail: locked while
// the AI level keeps Workflows paused, off when switched off, waiting while a
// Run waits for an approval, failing when its latest finished Run failed,
// on otherwise. The words are strings.workflows.status.* Settings.

import type { RunView, Settings, WorkflowView } from "@monday/shared";
import type { WorkflowStatusKind } from "@monday/ui";

export function workflowStatus(
  w: WorkflowView,
  runs: readonly RunView[],
  locked: boolean,
): WorkflowStatusKind {
  if (locked) return "locked";
  if (!w.enabled) return "off";
  const own = runs.filter((r) => r.workflowId === w.id);
  if (w.paused > 0 || own.some((r) => r.status === "paused")) return "waiting";
  // The newest finished Run: the loaded Runs are newest first; `recent` is oldest first.
  const finished = own.find((r) => r.status === "done" || r.status === "failed");
  const last = finished?.status ?? [...w.recent].reverse().find((r) => r !== "running");
  return last === "failed" ? "failing" : "on";
}

/** The status in the user's words; waiting carries its count. */
export function statusLabel(
  kind: WorkflowStatusKind,
  waiting: number,
  settings: Pick<
    Settings,
    | "strings.workflows.status.on"
    | "strings.workflows.status.off"
    | "strings.workflows.status.locked"
    | "strings.workflows.status.failing"
    | "strings.workflows.waiting_tag"
  >,
): string {
  switch (kind) {
    case "on":
      return settings["strings.workflows.status.on"];
    case "off":
      return settings["strings.workflows.status.off"];
    case "locked":
      return settings["strings.workflows.status.locked"];
    case "failing":
      return settings["strings.workflows.status.failing"];
    case "waiting":
      return settings["strings.workflows.waiting_tag"].replace("{n}", String(Math.max(1, waiting)));
  }
}
