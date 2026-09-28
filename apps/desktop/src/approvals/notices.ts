// Telling the user a Workflow Run stopped at a Step that needs their
// approval: once per waiting Step (the Run and the Activity row it waits
// on), with the Workflow's name and what the Step wants to do. Only Steps
// that started waiting recently count, so opening monday on a Run that has
// waited for days stays quiet (it is in the Approvals queue). The notices
// Settings decide whether anything is told; a Step skipped because they are
// off is not told later either. Pure: the caller delivers, as a desktop
// notification or a note in the window.

import type { Settings } from "@monday/shared";
import type { LiveRunsSnapshot } from "./live-runs.ts";
import { waitingStepOf, whatOf } from "./queue.ts";

export type ApprovalNoticeSettings = Pick<
  Settings,
  | "notifications.enabled"
  | "notifications.workflow_approvals"
  | "notifications.workflow_approvals_recent_minutes"
  | "strings.notifications.workflow_approval.title"
  | "strings.notifications.workflow_approval.body"
>;

export interface ApprovalNotice {
  /** The waiting Step it is about; told once. */
  key: string;
  runId: string;
  workflowId: string;
  title: string;
  body: string;
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** The key of one waiting Step: a Run can wait again on a later Step, and that is news again. */
export function waitingKey(run: {
  id: string;
  waitingActivityId: string | null;
  waitingStep: number | null;
  currentStep: number;
}): string {
  return `${run.id}:${run.waitingActivityId ?? run.waitingStep ?? run.currentStep}`;
}

/**
 * The notices due now, and the waiting Steps told (or deliberately skipped)
 * so far. A Step whose Activity row is still being read waits for it, so the
 * notice can say what the Step will do.
 */
export function approvalNotices(input: {
  live: LiveRunsSnapshot;
  told: ReadonlySet<string>;
  settings: ApprovalNoticeSettings;
  now: Date;
}): { notices: ApprovalNotice[]; told: Set<string> } {
  const { live, settings: s } = input;
  const told = new Set(input.told);
  const notices: ApprovalNotice[] = [];
  if (!live.loaded) return { notices, told };
  const on = s["notifications.enabled"] && s["notifications.workflow_approvals"];
  const since = input.now.getTime() - s["notifications.workflow_approvals_recent_minutes"] * 60_000;
  for (const run of live.runs) {
    if (run.status !== "paused") continue;
    const key = waitingKey(run);
    if (told.has(key)) continue;
    const activityId = run.waitingActivityId;
    // Still being read: the next snapshot has it.
    if (activityId && !live.activity.has(activityId)) continue;
    const activity = activityId ? (live.activity.get(activityId) ?? null) : null;
    const workflow = live.workflows.get(run.workflowId);
    const step = waitingStepOf(run, workflow);
    told.add(key);
    const at = Date.parse(activity?.at ?? step.at ?? run.startedAt);
    if (!on || (Number.isFinite(at) && at < since)) continue;
    notices.push({
      key,
      runId: run.id,
      workflowId: run.workflowId,
      title: fill(s["strings.notifications.workflow_approval.title"], {
        workflow: workflow?.name ?? run.workflowId,
      }),
      body: fill(s["strings.notifications.workflow_approval.body"], {
        n: step.index + 1,
        step: step.name,
        what: whatOf(activity, step.detail || step.name),
        subject: run.subject,
      }),
    });
  }
  return { notices, told };
}
