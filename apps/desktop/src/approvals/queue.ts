// The Approvals queue as data: every approval waiting for the user, from any
// screen (docs/spec/workflows.md, "Approvals"). A Workflow Run paused at a
// Step that asks, a call waiting in the current agent Session, and an
// external caller's call parked on the owner. Each item says where it comes
// from, what it will do and which Thread it is about; the sheet draws them
// and answers through the same paths as where they started (ADR 0002). Pure:
// the words are strings.approvals.* Settings, filled here.

import type {
  ActivityRecord,
  ExternalPending,
  RunView,
  Settings,
  ToolCall,
  ToolPreview,
  WorkflowView,
} from "@monday/shared";
import type { LiveRunsSnapshot } from "./live-runs.ts";

export type ApprovalStrings = Pick<
  Settings,
  | "strings.approvals.from_run"
  | "strings.approvals.from_session"
  | "strings.approvals.from_external"
  | "strings.approvals.about"
>;

interface Base {
  /** Stable across reads: the waiting Activity row, or the Run and its Step. */
  key: string;
  /** Where it comes from, worded: "Candidate intake · Step 4: Slack". */
  from: string;
  /** What it will do, as a line: "post to slack #hiring". */
  what: string;
  /** "About Application: Senior Rust engineer", when a Thread is named. */
  about: string | null;
  threadId: string | null;
  /** When it started waiting, when known. */
  since: string | null;
  /** The card's call. */
  call: ToolCall;
  preview: ToolPreview | null;
}

export type ApprovalItem =
  | (Base & {
      kind: "run";
      run: RunView;
      /** Whether "Always allow this step" applies: a Standing approval can be granted on it. */
      standing: boolean;
    })
  | (Base & { kind: "session" })
  | (Base & { kind: "external"; sessionId: string | null });

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** A tool name as a sentence reads it: "post to slack". */
export const toolWords = (tool: string) => tool.replaceAll("_", " ").replace(/\./g, " ");

/** What a call will do in one line: the tool in words, then what it names. */
export function whatOf(
  call: { tool: string; inputSummary: string } | null,
  fallback: string,
): string {
  if (!call) return fallback;
  const summary = call.inputSummary.trim();
  return summary ? `${toolWords(call.tool)} ${summary}` : toolWords(call.tool);
}

/** The waiting Step of a paused Run: its index, name and the Workflow's Step count. */
export function waitingStepOf(
  run: RunView,
  workflow: WorkflowView | undefined,
): { index: number; name: string; total: number; at: string | null; detail: string } {
  const index = run.waitingStep ?? run.currentStep;
  const row = run.steps.find((s) => s.index === index);
  const name = row?.name ?? workflow?.steps[index]?.name ?? "";
  return {
    index,
    name,
    total: Math.max(workflow?.steps.length ?? 0, run.steps.length, index + 1),
    at: row?.at ?? null,
    detail: row?.detail ?? "",
  };
}

function runItem(
  run: RunView,
  workflows: ReadonlyMap<string, WorkflowView>,
  activity: ActivityRecord | null,
  s: ApprovalStrings,
): ApprovalItem {
  const workflow = workflows.get(run.workflowId);
  const step = waitingStepOf(run, workflow);
  const stepId = workflow?.steps[step.index]?.id ?? null;
  const call: ToolCall = {
    id: activity?.id ?? run.waitingActivityId ?? `${run.id}:${step.index}`,
    sessionId: null,
    runId: run.id,
    tool: activity?.tool ?? step.name,
    tier: activity?.tier ?? "always-ask",
    inputSummary: activity?.inputSummary ?? run.subject,
    status: "waiting",
    approvedBy: null,
    undoable: false,
  };
  return {
    kind: "run",
    key: `run:${run.id}:${run.waitingActivityId ?? step.index}`,
    run,
    // A Standing approval is kept per Step id; a Step the document no longer has cannot take one.
    standing: stepId !== null && !(workflow?.standingApprovals ?? []).includes(stepId),
    from: fill(s["strings.approvals.from_run"], {
      workflow: workflow?.name ?? run.workflowId,
      n: step.index + 1,
      step: step.name,
    }),
    what: whatOf(activity, step.detail || step.name),
    about: run.subject ? fill(s["strings.approvals.about"], { subject: run.subject }) : null,
    threadId: run.threadId,
    since: activity?.at ?? step.at,
    call,
    preview: activity?.preview ?? null,
  };
}

export interface ApprovalInput {
  live: LiveRunsSnapshot;
  /** Calls waiting in the current agent Session. */
  session: readonly ToolCall[];
  /** External callers' calls parked on the owner. */
  external: readonly ExternalPending[];
  strings: ApprovalStrings;
}

/** Every approval waiting, oldest first: Workflow Runs, then the Session's calls, then external ones. */
export function approvalItems(input: ApprovalInput): ApprovalItem[] {
  const s = input.strings;
  const runs = input.live.runs
    .filter((r) => r.status === "paused")
    .map((r) =>
      runItem(
        r,
        input.live.workflows,
        r.waitingActivityId ? (input.live.activity.get(r.waitingActivityId) ?? null) : null,
        s,
      ),
    )
    .sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  const session = input.session
    .filter((c) => c.status === "waiting")
    .map(
      (call): ApprovalItem => ({
        kind: "session",
        key: `session:${call.id}`,
        from: s["strings.approvals.from_session"],
        what: whatOf(call, call.tool),
        about: null,
        threadId: null,
        since: null,
        call,
        preview: null,
      }),
    );
  // A call the open Session already shows is listed once, as the Session's.
  const inSession = new Set(session.map((i) => i.call.id));
  const external = input.external
    .filter((p) => p.status === "waiting" && !inSession.has(p.activityId))
    .map(
      (p): ApprovalItem => ({
        kind: "external",
        key: `external:${p.activityId}`,
        sessionId: p.sessionId,
        from: fill(s["strings.approvals.from_external"], { credential: p.credentialName }),
        what: whatOf(p, p.tool),
        about: null,
        threadId: null,
        since: p.at,
        call: {
          id: p.activityId,
          sessionId: p.sessionId,
          runId: null,
          tool: p.tool,
          tier: "always-ask",
          inputSummary: p.inputSummary,
          status: "waiting",
          approvedBy: null,
          undoable: false,
          actorName: p.credentialName,
        },
        preview: null,
      }),
    );
  return [...runs, ...session, ...external];
}

/** How many Runs are going and how many wait for an approval, for the nav. */
export function runCounts(live: LiveRunsSnapshot): { running: number; waiting: number } {
  let running = 0;
  let waiting = 0;
  for (const r of live.runs) {
    if (r.status === "paused") waiting += 1;
    else running += 1;
  }
  return { running, waiting };
}
