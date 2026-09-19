// Workflows (ADR 0003, ADR 0002, ADR 0005; CONTEXT.md "Workflow", "Run",
// "Step", "Trigger", "Placement", "Dry run", "Standing approval", "Budget"):
// the documents the Agent writes, their versions, and the step runner. A Run
// is a chain of Jobs, one per Step, with its state in workflow_runs and each
// Step's outcome in workflow_run_steps. Every Step that maps to a tool runs
// through the tool server, so tiers, previews and the Activity log are the
// composer's: a Step above the free tier pauses the Run at the same waiting
// row a composer card shows, a Standing approval answers it unattended, and
// the user's decision resumes the Run's next Job. The agentic Step is one
// LangGraph thread under the Run with a tool allowlist and its Budget.
// Triggers never run inline: an arrival or a Thread event enqueues a trigger
// Job, a schedule is a Job that re-arms itself at the next cron minute.

import type {
  ActivityRecord,
  AiLevel,
  ApprovalDecision,
  DryRunPreview,
  DryRunStep,
  DryRunThread,
  Id,
  Placement,
  Predicate,
  RunStepStatus,
  RunStepView,
  RunTrigger,
  RunView,
  Step,
  StepContext,
  TemplateContext,
  ThreadEvent,
  Trigger,
  WorkflowInput,
  WorkflowView,
} from "@monday/shared";
import {
  evaluateCondition,
  matchesPredicate,
  nextCronRun,
  parseCron,
  renderTemplate,
  stepMutates,
} from "@monday/shared";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { ChangeBus } from "../changes/bus.ts";
import { LockedError } from "../crypto/keys.ts";
import type { Db } from "../db/client.ts";
import {
  accounts,
  threads,
  workflowRunSteps,
  workflowRuns,
  workflows as workflowsTable,
  workflowVersions,
  workspaces,
} from "../db/schema.ts";
import type {
  ActivityLog,
  ActivityRow,
  AgentHost,
  ToolServer,
  WorkflowsSeam,
} from "../intelligence/agent/index.ts";
import {
  BudgetExceededError,
  INTEGRATION_TOOL,
  publicActivity,
} from "../intelligence/agent/index.ts";
import { ROUTE_STEP } from "../intelligence/routing/index.ts";
import type { HostedRuntime } from "../intelligence/runtime/index.ts";
import type { Job, StepContext as JobContext, Jobs, StepResult } from "../jobs/index.ts";
import { type Mailstore, NotFoundError } from "../mailstore/index.ts";
import type { Integrations } from "./integrations.ts";
import type { McpClients } from "./mcp.ts";

export type { FakeIntegrations, IntegrationPost, Integrations } from "./integrations.ts";
export { createFakeIntegrations, createHttpIntegrations } from "./integrations.ts";
export type { FakeMcpClients, McpClients } from "./mcp.ts";
export { createFakeMcpClients, createSdkMcpClients } from "./mcp.ts";

export const WORKFLOW_TRIGGER_STEP = "workflow-trigger";
export const WORKFLOW_STEP_STEP = "workflow-step";
export const WORKFLOW_SCHEDULE_STEP = "workflow-schedule";

export type TriggerJobPayload =
  | { workspaceId: Id; threadId: Id; source: "arrival" }
  | { workspaceId: Id; threadId: Id; source: "event"; event: ThreadEvent; value: string | null };

export interface StepJobPayload {
  runId: Id;
  index: number;
}

export interface ScheduleJobPayload {
  workflowId: Id;
  version: number;
}

/** The Workflow Settings, read once per operation (ADR 0004). */
export interface WorkflowSettings {
  placement: Placement;
  askBeforeEnable: boolean;
  notifyOnFailure: boolean;
  retentionDays: number;
  budget: { calls: number; tokens: number; minutes: number };
  agenticSystemPrompt: string;
  stepRetries: number;
  routingWaitSeconds: number;
  dryRunRecent: number;
  /** When the silence triggers look for Threads gone quiet (a cron). */
  silenceCheckCron: string;
  failedNotice: string;
}

export interface WorkflowsOptions {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  agent: AgentHost;
  activity: ActivityLog;
  integrations: Integrations;
  mcp: McpClients;
  settings: () => Promise<WorkflowSettings>;
  now?: () => Date;
  log?: (message: string) => void;
  /**
   * The AI level (CONTEXT.md). Below `automate` no Workflow is triggered or
   * scheduled; the documents and their enabled flags stay as they are and
   * come back when the level rises. Absent means `automate`.
   */
  level?: () => Promise<AiLevel>;
}

export interface Workflows extends WorkflowsSeam {
  /** A Dry run of a document that is not saved yet, over recent mail; the catalog proposals show it. */
  dryRunInput(workspaceId: Id, input: WorkflowInput, recent?: number): Promise<DryRunPreview>;
  /** The document of one version, or null. */
  version(workflowId: Id, version: number): Promise<WorkflowInput | null>;
  /** Grants or revokes a Standing approval on one Step. */
  standing(workflowId: Id, stepId: string, granted: boolean): Promise<WorkflowView>;
  /** The Activity rows a Run's Steps wrote, oldest first. */
  activityOf(runId: Id): Promise<ActivityRecord[]>;
  /** The sync engine's new-Thread hook: enqueues the trigger Job, or null when nothing listens. */
  onArrival(workspaceId: Id, threadId: Id): Promise<string | null>;
  /** Reads Thread events off the Changes feed for the Workspaces that listen; returns the unsubscribe. */
  watch(bus: ChangeBus): () => void;
  /** Deletes Runs older than the retention Setting; returns how many. */
  prune(): Promise<number>;
  registerSteps(jobs: Jobs): void;
}

export class WorkflowNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly workflowId: string) {
    super(`workflow ${workflowId} not found`);
    this.name = "WorkflowNotFoundError";
  }
}

export class RunNotWaitingError extends Error {
  readonly status = 409;
  constructor(readonly runId: string) {
    super(`run ${runId} is not waiting for an approval`);
    this.name = "RunNotWaitingError";
  }
}

/** Thrown out of a tool's `ask` to leave the Activity row waiting and pause the Run. */
class PausedSignal extends Error {
  constructor(readonly activityId: string) {
    super("paused");
    this.name = "PausedSignal";
  }
}

type WorkflowRow = typeof workflowsTable.$inferSelect;
type RunRow = typeof workflowRuns.$inferSelect;
type StepRow = typeof workflowRunSteps.$inferSelect;
type ThreadRow = typeof threads.$inferSelect;

/** What one Step's execution came to. */
type StepOutcome =
  | { kind: "done"; detail: string; output?: StepContext; activityId?: string | null }
  | { kind: "paused"; activityId: string; detail: string }
  | { kind: "declined"; detail: string; activityId: string | null }
  | { kind: "failed"; detail: string; activityId?: string | null }
  | { kind: "stop"; detail: string }
  | { kind: "skip_next"; detail: string }
  | { kind: "wait"; until: string; detail: string }
  /** A Dry run's answer: what would happen. */
  | { kind: "would"; detail: string; asks: boolean };

interface StepEnv {
  workspaceId: Id;
  runId: Id;
  workflow: WorkflowRow;
  doc: WorkflowInput;
  step: Step;
  index: number;
  thread: ThreadRow | null;
  ctx: TemplateContext;
  tools: ToolServer;
  standing: boolean;
  /** The user's answer to the waiting Step, when this is a resume. */
  decision: ApprovalDecision | null;
  dry: boolean;
  deadline: number;
  settings: WorkflowSettings;
  /** The Step row from an earlier attempt (a wait in progress). */
  existing: StepRow | null;
}

const personLine = (p: { name: string; email: string }) =>
  p.name ? `${p.name} <${p.email}>` : p.email;

function lastJsonObject(text: string): Record<string, unknown> | null {
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  for (
    let start = text.lastIndexOf("{", end);
    start >= 0;
    start = text.lastIndexOf("{", start - 1)
  ) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
    if (start === 0) break;
  }
  return null;
}

export function createWorkflows(options: WorkflowsOptions): Workflows {
  const { db, mailstore, activity, agent } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const level = options.level ?? (async (): Promise<AiLevel> => "automate");
  /** Whether Workflows may run unasked right now (CONTEXT.md "AI level"). */
  const automated = async () => (await level()) === "automate";
  let jobs: Jobs | null = null;

  /* ------------------------------ Rows and views ------------------------------ */

  const row = async (workflowId: Id): Promise<WorkflowRow | null> =>
    (await db.query.workflows.findFirst({ where: eq(workflowsTable.id, workflowId) })) ?? null;

  const requireRow = async (workflowId: Id): Promise<WorkflowRow> => {
    const found = await row(workflowId);
    if (!found) throw new WorkflowNotFoundError(workflowId);
    return found;
  };

  const document = async (workflowId: Id, version: number): Promise<WorkflowInput | null> => {
    const found = await db.query.workflowVersions.findFirst({
      where: and(
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.version, version),
      ),
    });
    return found?.document ?? null;
  };

  const placementOf = async (doc: WorkflowInput): Promise<Placement> =>
    doc.placement ?? (await options.settings()).placement;

  const view = async (w: WorkflowRow): Promise<WorkflowView> => {
    const doc = await document(w.id, w.currentVersion);
    if (!doc) throw new WorkflowNotFoundError(w.id);
    const recentRows = await db
      .select({ status: workflowRuns.status, startedAt: workflowRuns.startedAt })
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, w.id))
      .orderBy(desc(workflowRuns.startedAt))
      .limit(12);
    const dayStart = new Date(now());
    dayStart.setUTCHours(0, 0, 0, 0);
    const [today] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, w.id), gte(workflowRuns.startedAt, dayStart)));
    const [paused] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workflowId, w.id), eq(workflowRuns.status, "paused")));
    return {
      ...doc,
      standingApprovals: w.standingApprovals,
      id: w.id,
      workspaceId: w.workspaceId,
      version: w.currentVersion,
      enabled: w.enabled,
      placementInEffect: await placementOf(doc),
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
      lastRunAt: recentRows[0]?.startedAt.toISOString() ?? null,
      runsToday: today?.n ?? 0,
      recent: recentRows
        .slice()
        .reverse()
        .map((r) => (r.status === "queued" ? "running" : r.status)),
      paused: paused?.n ?? 0,
    };
  };

  const stepView = (s: StepRow): RunStepView => ({
    index: s.index,
    stepId: s.stepId,
    name: s.name,
    kind: s.kind,
    status: s.status,
    detail: s.detail,
    activityId: s.activityId,
    at: s.at.toISOString(),
  });

  const runView = async (r: RunRow): Promise<RunView> => {
    const steps = await db
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.runId, r.id))
      .orderBy(workflowRunSteps.index);
    const waiting = steps.find((s) => s.status === "waiting");
    return {
      id: r.id,
      workflowId: r.workflowId,
      workspaceId: r.workspaceId,
      version: r.version,
      status: r.status,
      trigger: r.trigger,
      threadId: r.threadId,
      subject: r.subject,
      currentStep: r.currentStep,
      failedStep: r.failedStep,
      waitingActivityId: r.waitingActivityId,
      waitingStep: r.status === "paused" ? (waiting?.index ?? r.currentStep) : null,
      error: r.error,
      steps: steps.map(stepView),
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  };

  const loadRun = async (runId: Id): Promise<RunRow | null> =>
    (await db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, runId) })) ?? null;

  const patchRun = async (runId: Id, patch: Partial<RunRow>): Promise<void> => {
    await db.update(workflowRuns).set(patch).where(eq(workflowRuns.id, runId));
  };

  const writeStep = async (
    runId: Id,
    index: number,
    step: Step,
    status: RunStepStatus,
    detail: string,
    extra: { activityId?: string | null; result?: unknown } = {},
  ): Promise<void> => {
    await db
      .insert(workflowRunSteps)
      .values({
        runId,
        index,
        stepId: step.id,
        name: step.name,
        kind: step.kind,
        status,
        detail: detail.slice(0, 500),
        activityId: extra.activityId ?? null,
        result: extra.result ?? null,
        at: now(),
      })
      .onConflictDoUpdate({
        target: [workflowRunSteps.runId, workflowRunSteps.index],
        set: {
          status,
          detail: detail.slice(0, 500),
          activityId: extra.activityId ?? null,
          result: extra.result ?? null,
          at: now(),
        },
      });
  };

  /* ------------------------------ Threads for triggers and templates ------------------------------ */

  const threadRow = async (threadId: Id): Promise<ThreadRow | null> =>
    (await db.query.threads.findFirst({ where: eq(threads.id, threadId) })) ?? null;

  /** The real subject when unlocked, the index prefix otherwise. */
  const subjectOf = async (t: ThreadRow): Promise<string> => {
    try {
      return await mailstore.readThreadSubject(t.id);
    } catch (error) {
      if (error instanceof LockedError || error instanceof NotFoundError) return t.subjectSearch;
      throw error;
    }
  };

  const factsOf = async (t: ThreadRow) => {
    const headers = await mailstore.listMessages(t.id);
    const newest = headers[headers.length - 1] ?? null;
    return {
      subject: await subjectOf(t),
      from: newest?.from ?? t.participants[0] ?? null,
      participants: t.participants,
      hasAttachments: t.hasAttachments,
      headers: newest?.headers ?? {},
      attachments: headers.flatMap((h) => h.attachments),
    };
  };

  const triggerMatches = async (
    trigger: Trigger,
    t: ThreadRow,
    event: { event: ThreadEvent; value: string | null } | null,
  ): Promise<boolean> => {
    if (trigger.kind === "arrival") {
      if (event) return false;
      if (trigger.group && t.groupId !== trigger.group && t.subgroupId !== trigger.group) {
        return false;
      }
      if (trigger.predicate) {
        const facts = await factsOf(t);
        if (!matchesPredicate(trigger.predicate as Predicate, facts)) return false;
      }
      return Boolean(trigger.group || trigger.predicate);
    }
    if (trigger.kind === "thread_event") {
      if (!event || event.event !== trigger.event) return false;
      if (trigger.value && event.value !== trigger.value) return false;
      return true;
    }
    return false;
  };

  const templateContext = async (
    runId: Id,
    workflowId: Id,
    t: ThreadRow | null,
    steps: Record<string, StepContext>,
  ): Promise<TemplateContext> => {
    if (!t) return { thread: null, run: { id: runId, workflow: workflowId }, steps };
    const facts = await factsOf(t);
    return {
      thread: {
        id: t.id,
        subject: facts.subject,
        from: facts.from ? personLine(facts.from) : "",
        fromEmail: facts.from?.email,
        group: t.subgroupId ?? t.groupId,
      },
      run: { id: runId, workflow: workflowId },
      steps,
    };
  };

  /* ------------------------------ Steps ------------------------------ */

  const callTool = async (
    env: StepEnv,
    name: string,
    args: Record<string, unknown>,
    would: string,
  ): Promise<StepOutcome> => {
    if (env.dry) {
      const preview = await env.tools.preview({ name, args });
      if (preview.kind === "refused") return { kind: "failed", detail: preview.text };
      if (preview.kind === "result") return { kind: "would", detail: preview.text, asks: false };
      const line =
        preview.preview.kind === "text"
          ? (preview.preview.text.split("\n")[0] ?? would).replace(/:\s*$/, "")
          : preview.preview.kind === "send"
            ? `send "${preview.preview.subject}" to ${preview.preview.to.map(personLine).join(", ")}`
            : preview.preview.kind === "threads"
              ? `${preview.preview.action} ${preview.preview.count} thread${preview.preview.count === 1 ? "" : "s"}`
              : `${preview.preview.key}: ${JSON.stringify(preview.preview.to)}`;
      return { kind: "would", detail: `${would}: ${line}`, asks: preview.asks && !env.standing };
    }
    try {
      const outcome = await env.tools.call(
        { name, args, callId: `step-${env.index}`, sessionId: null, runId: env.runId },
        {
          ask: async (waiting) => {
            if (env.standing) return "standing";
            if (env.decision) return env.decision;
            throw new PausedSignal(waiting.id);
          },
        },
      );
      const activityId = outcome.activity.id;
      if (outcome.isError) return { kind: "failed", detail: outcome.text, activityId };
      if (outcome.activity.decision === "declined") {
        return { kind: "declined", detail: "Declined", activityId };
      }
      const data =
        outcome.activity.resultData && typeof outcome.activity.resultData === "object"
          ? (outcome.activity.resultData as Record<string, unknown>)
          : {};
      return {
        kind: "done",
        detail: outcome.activity.result ?? outcome.text.split("\n")[0] ?? "",
        output: { ...data, text: outcome.text },
        activityId,
      };
    } catch (error) {
      if (error instanceof PausedSignal) {
        return {
          kind: "paused",
          activityId: error.activityId,
          detail: "Waiting for your approval",
        };
      }
      throw error;
    }
  };

  /** A note in the Activity log for a Step that runs through no tool. */
  const note = async (
    env: StepEnv,
    tool: string,
    summary: string,
    status: ActivityRow["status"] = "done",
    resultText?: string,
  ): Promise<string> => {
    const started = await activity.start({
      workspaceId: env.workspaceId,
      sessionId: null,
      runId: env.runId,
      callId: `step-${env.index}`,
      tool,
      tier: "read-only",
      input: { step: env.step.id, workflow: env.workflow.id },
      summary,
      preview: null,
      status,
      decision: "auto",
    });
    if (resultText !== undefined) await activity.update(started.id, { resultText });
    return started.id;
  };

  const needThread = (env: StepEnv): StepOutcome | null =>
    env.thread ? null : { kind: "failed", detail: "This step needs a Thread; the Run has none." };

  const render = (env: StepEnv, text: string) => renderTemplate(text, env.ctx);

  const execute = async (env: StepEnv): Promise<StepOutcome> => {
    const { step } = env;
    const thread = env.thread;
    const ids = thread ? [thread.id] : [];
    switch (step.kind) {
      case "tag": {
        const missing = needThread(env);
        if (missing) return missing;
        return callTool(
          env,
          "tag_threads",
          { thread_ids: ids, add: step.add, remove: step.remove },
          "Tag",
        );
      }
      case "move": {
        const missing = needThread(env);
        if (missing) return missing;
        return callTool(env, "move_threads", { thread_ids: ids, group: step.group }, "Move");
      }
      case "archive": {
        const missing = needThread(env);
        if (missing) return missing;
        return callTool(env, "archive_threads", { thread_ids: ids }, "Archive");
      }
      case "snooze": {
        const missing = needThread(env);
        if (missing) return missing;
        const until = new Date(now().getTime() + step.hours * 3_600_000).toISOString();
        return callTool(env, "snooze_threads", { thread_ids: ids, until }, "Snooze");
      }
      case "draft_reply": {
        const missing = needThread(env);
        if (missing) return missing;
        let body: string;
        if (step.template !== undefined) body = render(env, step.template);
        else if (env.dry) {
          return { kind: "would", detail: "Draft a reply in your voice", asks: false };
        } else {
          const result = await options.runtime.run(
            "draft-in-voice",
            {
              system:
                "Write the body of a reply email in the user's voice. Plain text, no subject line, no signature placeholders.",
              prompt: `${render(env, step.instructions ?? "Reply to this thread.")}\n\nThread subject: ${env.ctx.thread?.subject ?? ""}\nFrom: ${env.ctx.thread?.from ?? ""}`,
            },
            { workspaceId: env.workspaceId, jobId: null },
          );
          body = result.output.trim();
        }
        return callTool(
          env,
          "draft_message",
          { kind: "reply", thread_id: thread?.id, body },
          "Draft a reply",
        );
      }
      case "send": {
        const draftId = env.ctx.steps[step.draftFrom]?.draftId;
        if (env.dry && typeof draftId !== "string") {
          return {
            kind: "would",
            detail: `Send the draft from "${step.draftFrom}"`,
            asks: !env.standing,
          };
        }
        if (typeof draftId !== "string") {
          return { kind: "failed", detail: `No Draft from step "${step.draftFrom}" to send.` };
        }
        return callTool(env, "send_draft", { draft_id: draftId }, "Send");
      }
      case "notify": {
        const text = render(env, step.text);
        if (env.dry) return { kind: "would", detail: `Notify: ${text}`, asks: false };
        const activityId = await note(env, "workflow.notify", text, "done", text);
        return { kind: "done", detail: text, output: { text }, activityId };
      }
      case "wait": {
        if (env.dry) return { kind: "would", detail: `Wait ${step.hours} h`, asks: false };
        const previous =
          env.existing?.result && typeof env.existing.result === "object"
            ? (env.existing.result as { until?: string }).until
            : undefined;
        const until = previous ?? new Date(now().getTime() + step.hours * 3_600_000).toISOString();
        if (now().toISOString() >= until) return { kind: "done", detail: `Waited ${step.hours} h` };
        return { kind: "wait", until, detail: `Waiting until ${until}` };
      }
      case "condition": {
        const ok = evaluateCondition(step.when, env.ctx);
        const shown = renderTemplate(step.when.left, env.ctx).slice(0, 80);
        if (ok) return { kind: "done", detail: `Yes: ${shown || "(empty)"}` };
        const detail = `No: ${shown || "(empty)"}`;
        return step.otherwise === "skip_next"
          ? { kind: "skip_next", detail }
          : { kind: "stop", detail };
      }
      case "slack":
      case "discord":
        return callTool(
          env,
          INTEGRATION_TOOL[step.kind],
          { channel: step.channel, text: render(env, step.text) },
          `Post to ${step.channel}`,
        );
      case "notion":
        return callTool(
          env,
          INTEGRATION_TOOL.notion,
          {
            database: step.database,
            properties: Object.fromEntries(
              Object.entries(step.properties).map(([k, v]) => [k, render(env, v)]),
            ),
          },
          `Add a row to ${step.database}`,
        );
      case "drive": {
        const missing = needThread(env);
        if (missing || !thread) return missing ?? { kind: "failed", detail: "no thread" };
        const facts = await factsOf(thread);
        const attachment = facts.attachments[0];
        if (!attachment) return { kind: "failed", detail: "The Thread has no attachment to save." };
        return callTool(
          env,
          INTEGRATION_TOOL.drive,
          {
            attachment_id: attachment.id,
            folder: step.folder,
            ...(step.fileName ? { name: render(env, step.fileName) } : {}),
          },
          `Save to ${step.folder}`,
        );
      }
      case "webhook":
        return callTool(
          env,
          INTEGRATION_TOOL.webhook,
          {
            url: step.url,
            method: step.method,
            body: Object.fromEntries(
              Object.entries(step.body).map(([k, v]) => [k, render(env, v)]),
            ),
          },
          `${step.method} ${new URL(step.url).host}`,
        );
      case "mcp":
        return callTool(
          env,
          "call_mcp_tool",
          {
            server: step.server,
            tool: step.tool,
            args: Object.fromEntries(
              Object.entries(step.args).map(([k, v]) => [
                k,
                typeof v === "string" ? render(env, v) : v,
              ]),
            ),
          },
          `${step.server}: ${step.tool}`,
        );
      case "agentic":
        return agenticStep(env);
    }
  };

  const agenticStep = async (env: StepEnv): Promise<StepOutcome> => {
    const { step } = env;
    if (step.kind !== "agentic") return { kind: "failed", detail: "not an agentic step" };
    const budget = {
      calls: step.budget.calls ?? env.settings.budget.calls,
      tokens: step.budget.tokens ?? env.settings.budget.tokens,
      minutes: step.budget.minutes ?? env.settings.budget.minutes,
    };
    if (env.dry) {
      return {
        kind: "would",
        detail: `Run the agent (${budget.calls} calls, ${budget.tokens} tokens, ${budget.minutes} min)`,
        asks: false,
      };
    }
    const outputs = step.outputs.length
      ? `\n\nWhen you are done, report these fields as one JSON object on the last line: ${step.outputs.join(", ")}.`
      : "";
    const threadLine = env.ctx.thread
      ? `\n\nThe Thread this step is about: id ${env.ctx.thread.id}, subject "${env.ctx.thread.subject}", from ${env.ctx.thread.from}. Use read_thread to read it.`
      : "";
    const activityId =
      env.existing?.activityId ?? (await note(env, "workflow.agentic", step.name, "running"));
    try {
      const result = await agent.runStep({
        workspaceId: env.workspaceId,
        runId: env.runId,
        key: `run:${env.runId}:${env.index}`,
        system: `${env.settings.agenticSystemPrompt}\n\nWorkflow: ${env.workflow.name}. Step: ${step.name}.${outputs}`,
        prompt: `${render(env, step.prompt)}${threadLine}`,
        allow: step.tools.length ? step.tools : null,
        maxToolCalls: budget.calls,
        maxTokens: budget.tokens,
        deadline: Math.min(env.deadline, now().getTime() + budget.minutes * 60_000),
        approve: async () => (env.standing ? "standing" : null),
        ...(env.decision ? { resume: env.decision } : {}),
      });
      if (result.interrupted) {
        await activity.update(activityId, { status: "waiting" });
        return {
          kind: "paused",
          activityId: result.interrupted.activityId,
          detail: `Waiting for your approval of ${result.interrupted.tool.replaceAll("_", " ")}`,
        };
      }
      const reported = lastJsonObject(result.text) ?? {};
      const output: StepContext = { text: result.text };
      for (const field of step.outputs) output[field] = reported[field] ?? "";
      const summary = `${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"}, ${result.tokens} tokens`;
      await activity.update(activityId, { status: "done", resultText: result.text });
      const shown = step.outputs.length
        ? step.outputs.map((f) => `${f}: ${String(output[f] ?? "")}`).join(", ")
        : (result.text.split("\n")[0] ?? summary);
      return { kind: "done", detail: shown || summary, output, activityId };
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        await activity.update(activityId, { status: "failed", resultText: error.message });
        return { kind: "failed", detail: `Budget exceeded: ${error.cap}`, activityId };
      }
      await activity.update(activityId, {
        status: "failed",
        resultText: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  /* ------------------------------ The Run: one Job per Step ------------------------------ */

  const stepJobId = (runId: Id, index: number, resume = false) =>
    `${WORKFLOW_STEP_STEP}:${runId}:${index}${resume ? `:${crypto.randomUUID().slice(0, 8)}` : ""}`;

  const needsFor = async (doc: WorkflowInput): Promise<string[]> =>
    (await placementOf(doc)) === "local" ? ["needs-process"] : [];

  const enqueueStep = async (run: RunRow, doc: WorkflowInput, index: number, resume = false) => {
    if (!jobs) throw new Error("workflow Jobs need registerSteps first");
    const payload: StepJobPayload = { runId: run.id, index };
    return jobs.enqueue(WORKFLOW_STEP_STEP, payload, {
      id: stepJobId(run.id, index, resume),
      needs: await needsFor(doc),
    });
  };

  const createRun = async (
    w: WorkflowRow,
    doc: WorkflowInput,
    trigger: RunTrigger,
    thread: ThreadRow | null,
    id: string = crypto.randomUUID(),
  ): Promise<RunRow | null> => {
    const inserted = await db
      .insert(workflowRuns)
      .values({
        id,
        workflowId: w.id,
        workspaceId: w.workspaceId,
        version: w.currentVersion,
        status: "queued",
        trigger,
        threadId: thread?.id ?? null,
        subject: thread ? await subjectOf(thread) : "",
        startedAt: now(),
      })
      .onConflictDoNothing({ target: workflowRuns.id })
      .returning();
    const run = inserted[0];
    if (!run) return null;
    await enqueueStep(run, doc, 0);
    return run;
  };

  const finishRun = async (
    run: RunRow,
    status: "done" | "failed",
    extra: { failedStep?: number | null; error?: string | null } = {},
  ) => {
    await patchRun(run.id, {
      status,
      failedStep: extra.failedStep ?? null,
      error: extra.error ?? null,
      waitingActivityId: null,
      decision: null,
      finishedAt: now(),
    });
  };

  const skipRest = async (run: RunRow, doc: WorkflowInput, from: number, detail: string) => {
    for (let i = from; i < doc.steps.length; i++) {
      const step = doc.steps[i];
      if (step) await writeStep(run.id, i, step, "skipped", detail);
    }
  };

  const advance = async (run: RunRow, doc: WorkflowInput, next: number): Promise<void> => {
    if (next < doc.steps.length) await enqueueStep(run, doc, next);
    else await finishRun(run, "done");
  };

  /** Applies a Step's outcome to the Run and decides what the Job returns. */
  const settle = async (
    run: RunRow,
    w: WorkflowRow,
    doc: WorkflowInput,
    index: number,
    step: Step,
    outcome: StepOutcome,
    settings: WorkflowSettings,
  ): Promise<StepResult> => {
    switch (outcome.kind) {
      case "done": {
        await writeStep(run.id, index, step, "done", outcome.detail, {
          activityId: outcome.activityId ?? null,
          result: outcome.output ?? null,
        });
        const context = { ...run.context, [step.id]: outcome.output ?? { text: outcome.detail } };
        await patchRun(run.id, { context, decision: null, waitingActivityId: null });
        await advance({ ...run, context }, doc, index + 1);
        return "done";
      }
      case "paused":
        await writeStep(run.id, index, step, "waiting", outcome.detail, {
          activityId: outcome.activityId,
        });
        await patchRun(run.id, {
          status: "paused",
          waitingActivityId: outcome.activityId,
          decision: null,
        });
        return "done";
      case "wait":
        await writeStep(run.id, index, step, "running", outcome.detail, {
          result: { until: outcome.until },
        });
        return { sleepMs: Math.max(0, Date.parse(outcome.until) - now().getTime()) };
      case "stop":
        await writeStep(run.id, index, step, "done", outcome.detail);
        await skipRest(run, doc, index + 1, `Skipped: ${step.name} said no`);
        await finishRun(run, "done");
        return "done";
      case "skip_next": {
        await writeStep(run.id, index, step, "done", outcome.detail);
        const skipped = doc.steps[index + 1];
        if (skipped) {
          await writeStep(run.id, index + 1, skipped, "skipped", `Skipped: ${step.name} said no`);
        }
        await advance(run, doc, index + 2);
        return "done";
      }
      case "would":
        throw new Error("a Dry run outcome reached the runner");
      case "declined":
      case "failed": {
        const policy = step.onFailure ?? doc.failurePolicy;
        const detail = outcome.kind === "declined" ? "Declined by you" : outcome.detail;
        if (policy === "skip") {
          await writeStep(run.id, index, step, "skipped", `Skipped after failure: ${detail}`, {
            activityId: outcome.activityId ?? null,
          });
          await patchRun(run.id, { decision: null, waitingActivityId: null });
          await advance(run, doc, index + 1);
          return "done";
        }
        await writeStep(run.id, index, step, "failed", detail, {
          activityId: outcome.activityId ?? null,
        });
        await skipRest(run, doc, index + 1, `Skipped: ${step.name} failed`);
        await finishRun(run, "failed", { failedStep: index, error: detail });
        if (policy === "notify" || settings.notifyOnFailure) {
          const text = settings.failedNotice
            .replaceAll("{name}", w.name)
            .replaceAll("{step}", step.name);
          await activity.start({
            workspaceId: run.workspaceId,
            sessionId: null,
            runId: run.id,
            callId: `failed-${index}`,
            tool: "workflow.failed",
            tier: "read-only",
            input: { step: step.id, workflow: w.id },
            summary: text,
            preview: null,
            status: "done",
            decision: "auto",
          });
        }
        return "done";
      }
    }
  };

  const runStepJob = async (job: Job<StepJobPayload>, ctx: JobContext): Promise<StepResult> => {
    const { runId, index } = job.payload;
    const run = await loadRun(runId);
    if (!run || run.status === "done" || run.status === "failed") return "done";
    const w = await row(run.workflowId);
    const doc = w ? await document(run.workflowId, run.version) : null;
    if (!w || !doc) {
      await finishRun(run, "failed", { error: "the workflow is gone" });
      return "done";
    }
    const step = doc.steps[index];
    if (!step) {
      await finishRun(run, "done");
      return "done";
    }
    const settings = await options.settings();
    const existing =
      (await db.query.workflowRunSteps.findFirst({
        where: and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.index, index)),
      })) ?? null;
    const decision = run.status === "paused" ? run.decision : null;
    await patchRun(run.id, { status: "running", currentStep: index });
    const thread = run.threadId ? await threadRow(run.threadId) : null;
    const env: StepEnv = {
      workspaceId: run.workspaceId,
      runId: run.id,
      workflow: w,
      doc,
      step,
      index,
      thread,
      ctx: await templateContext(run.id, w.id, thread, run.context),
      tools: agent.tools(run.workspaceId),
      standing: w.standingApprovals.includes(step.id),
      decision,
      dry: false,
      deadline: ctx.deadline,
      settings,
      existing,
    };
    let outcome: StepOutcome;
    try {
      outcome = await execute(env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`run ${run.id} step ${index} (${step.id}): ${message}`);
      // Transient errors get the Jobs table's retries with backoff (ADR 0005); then the policy.
      if (job.attempts <= settings.stepRetries) {
        await patchRun(run.id, { status: decision ? "paused" : "queued" });
        throw error;
      }
      outcome = { kind: "failed", detail: message };
    }
    return settle(run, w, doc, index, step, outcome, settings);
  };

  /* ------------------------------ Triggers ------------------------------ */

  const enabledWorkflows = async (workspaceId: Id): Promise<WorkflowRow[]> =>
    db
      .select()
      .from(workflowsTable)
      .where(and(eq(workflowsTable.workspaceId, workspaceId), eq(workflowsTable.enabled, true)));

  const runTriggerJob = async (job: Job<TriggerJobPayload>): Promise<StepResult> => {
    const { workspaceId, threadId } = job.payload;
    if (!(await automated())) return "done";
    await prune().catch((error) => log(`prune: ${error instanceof Error ? error.message : error}`));
    const t = await threadRow(threadId);
    if (!t) return "done";
    const candidates: Array<{ w: WorkflowRow; doc: WorkflowInput }> = [];
    for (const w of await enabledWorkflows(workspaceId)) {
      const doc = await document(w.id, w.currentVersion);
      if (doc) candidates.push({ w, doc });
    }
    const event =
      job.payload.source === "event"
        ? { event: job.payload.event, value: job.payload.value }
        : null;
    // An arrival trigger with a Group filter waits for routing to place the Thread first.
    if (
      !event &&
      jobs &&
      t.groupId === null &&
      candidates.some((c) => c.doc.trigger.kind === "arrival" && c.doc.trigger.group)
    ) {
      const route = await jobs.get(`${ROUTE_STEP}:${threadId}`);
      if (route && (route.status === "queued" || route.status === "running")) {
        const settings = await options.settings();
        return { sleepMs: settings.routingWaitSeconds * 1000 };
      }
    }
    for (const { w, doc } of candidates) {
      if (!(await triggerMatches(doc.trigger, t, event))) continue;
      const trigger: RunTrigger = event
        ? { kind: "thread_event", threadId, event: event.event }
        : { kind: "arrival", threadId };
      const id = event
        ? `run:${w.id}:${event.event}:${threadId}`
        : `run:${w.id}:arrival:${threadId}`;
      const run = await createRun(w, doc, trigger, t, id);
      if (run) log(`run ${run.id}: ${w.name} on ${threadId}`);
    }
    return "done";
  };

  /** Threads silent for N days: nothing from anyone since, and the last word was not the user's. */
  const silentThreads = async (
    w: WorkflowRow,
    trigger: { days: number; group?: string | undefined },
    limit: number,
  ): Promise<ThreadRow[]> => {
    const cutoff = new Date(now().getTime() - trigger.days * 86_400_000);
    const rows = await db
      .select()
      .from(threads)
      .where(
        and(
          eq(threads.workspaceId, w.workspaceId),
          eq(threads.deleted, false),
          eq(threads.archived, false),
          lt(threads.lastActivity, cutoff),
          ...(trigger.group
            ? [
                sql`(${threads.groupId} = ${trigger.group} or ${threads.subgroupId} = ${trigger.group})`,
              ]
            : []),
        ),
      )
      .orderBy(desc(threads.lastActivity))
      .limit(limit);
    const address = await ownerAddress(w.workspaceId);
    const out: ThreadRow[] = [];
    for (const t of rows) {
      const headers = await mailstore.listMessages(t.id);
      const last = headers[headers.length - 1];
      if (last && address && last.from.email.toLowerCase() === address) continue;
      out.push(t);
    }
    return out;
  };

  const ownerAddress = async (workspaceId: Id): Promise<string | null> => {
    const rows = await db
      .select({ address: accounts.address })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    return rows[0]?.address.toLowerCase() ?? null;
  };

  /** A schedule fires one Run at each cron minute; a silence trigger checks daily for Threads gone quiet. */
  const runScheduleJob = async (job: Job<ScheduleJobPayload>): Promise<StepResult> => {
    const { workflowId, version } = job.payload;
    const w = await row(workflowId);
    if (!w?.enabled || w.currentVersion !== version) return "done";
    const doc = await document(workflowId, version);
    if (!doc) return "done";
    const at = now();
    const run = await automated();
    if (!run) {
      // Below `automate` the schedule ticks without acting, so it is still armed when the level rises.
    } else if (doc.trigger.kind === "schedule") {
      await createRun(w, doc, { kind: "schedule", at: at.toISOString() }, null);
    } else if (doc.trigger.kind === "silence") {
      for (const t of await silentThreads(w, doc.trigger, 500)) {
        await createRun(
          w,
          doc,
          { kind: "silence", threadId: t.id },
          t,
          `run:${w.id}:silence:${t.id}`,
        );
      }
    } else return "done";
    const next = nextCronRun(
      parseCron(cronOf(doc, (await options.settings()).silenceCheckCron)),
      at,
    );
    if (!next) return "done";
    return { sleepMs: next.getTime() - at.getTime() };
  };

  const cronOf = (doc: WorkflowInput, silenceCron: string): string =>
    doc.trigger.kind === "schedule" ? doc.trigger.cron : silenceCron;

  const armSchedule = async (w: WorkflowRow, doc: WorkflowInput): Promise<void> => {
    if (!jobs || !w.enabled) return;
    if (doc.trigger.kind !== "schedule" && doc.trigger.kind !== "silence") return;
    const next = nextCronRun(
      parseCron(cronOf(doc, (await options.settings()).silenceCheckCron)),
      now(),
    );
    if (!next) return;
    const payload: ScheduleJobPayload = { workflowId: w.id, version: w.currentVersion };
    await jobs.enqueue(WORKFLOW_SCHEDULE_STEP, payload, {
      id: `${WORKFLOW_SCHEDULE_STEP}:${w.id}:${w.currentVersion}`,
      runAt: next,
      needs: await needsFor(doc),
    });
  };

  /* ------------------------------ Dry run ------------------------------ */

  const dryRunThreads = async (
    w: WorkflowRow,
    doc: WorkflowInput,
    recent: number,
  ): Promise<{ considered: number; threads: ThreadRow[] }> => {
    if (doc.trigger.kind === "schedule" || doc.trigger.kind === "manual") {
      return { considered: 0, threads: [] };
    }
    if (doc.trigger.kind === "silence") {
      const silent = await silentThreads(w, doc.trigger, 500);
      return { considered: silent.length, threads: silent.slice(0, recent) };
    }
    const rows = await db
      .select()
      .from(threads)
      .where(and(eq(threads.workspaceId, w.workspaceId), eq(threads.deleted, false)))
      .orderBy(desc(threads.lastActivity))
      .limit(500);
    const matched: ThreadRow[] = [];
    for (const t of rows) {
      const trigger = doc.trigger;
      const event =
        trigger.kind === "thread_event"
          ? { event: trigger.event, value: trigger.value ?? null }
          : null;
      let ok = false;
      if (event) {
        switch (event.event) {
          case "archived":
            ok = t.archived;
            break;
          case "snoozed":
            ok = t.snoozedUntil !== null;
            break;
          case "starred":
            ok = t.starred;
            break;
          case "moved":
            ok = event.value
              ? t.groupId === event.value || t.subgroupId === event.value
              : t.groupId !== null;
            break;
          case "tagged":
            ok = false;
            break;
        }
      } else ok = await triggerMatches(trigger, t, null);
      if (ok) matched.push(t);
    }
    return { considered: matched.length, threads: matched.slice(0, recent) };
  };

  const dryRunOne = async (
    w: WorkflowRow,
    doc: WorkflowInput,
    t: ThreadRow | null,
    settings: WorkflowSettings,
  ): Promise<DryRunThread> => {
    const runId = `dry:${crypto.randomUUID()}`;
    const context: Record<string, StepContext> = {};
    const steps: DryRunStep[] = [];
    let skipNext = false;
    let stopped = false;
    const facts = t ? await factsOf(t) : null;
    for (let index = 0; index < doc.steps.length; index++) {
      const step = doc.steps[index];
      if (!step) continue;
      const line = (status: DryRunStep["status"], detail: string) =>
        steps.push({ index, stepId: step.id, name: step.name, kind: step.kind, status, detail });
      if (stopped) {
        line("skipped", "Skipped: an earlier step said no");
        continue;
      }
      if (skipNext) {
        skipNext = false;
        line("skipped", "Skipped: the condition said no");
        continue;
      }
      const env: StepEnv = {
        workspaceId: w.workspaceId,
        runId,
        workflow: w,
        doc,
        step,
        index,
        thread: t,
        ctx: await templateContext(runId, w.id, t, context),
        tools: agent.tools(w.workspaceId),
        standing: w.standingApprovals.includes(step.id),
        decision: null,
        dry: true,
        deadline: now().getTime() + 60_000,
        settings,
        existing: null,
      };
      let outcome: StepOutcome;
      try {
        outcome = await execute(env);
      } catch (error) {
        outcome = {
          kind: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      switch (outcome.kind) {
        case "would":
          line(outcome.asks ? "would_ask" : "would_apply", outcome.detail);
          if (!stepMutates(step.kind)) context[step.id] = { text: outcome.detail };
          break;
        case "done":
          line("done", outcome.detail);
          context[step.id] = outcome.output ?? { text: outcome.detail };
          break;
        case "stop":
          line("stopped", outcome.detail);
          stopped = true;
          break;
        case "skip_next":
          line("done", outcome.detail);
          skipNext = true;
          break;
        case "failed":
        case "declined":
          line("skipped", outcome.detail);
          if ((step.onFailure ?? doc.failurePolicy) !== "skip") stopped = true;
          break;
        case "paused":
        case "wait":
          line("would_apply", outcome.detail);
          break;
      }
    }
    return {
      threadId: t?.id ?? "",
      subject: facts?.subject ?? "",
      from: facts?.from ? personLine(facts.from) : "",
      steps,
    };
  };

  /* ------------------------------ Thread events off the feed ------------------------------ */

  const eventsOf = (change: { kind: string; payload: unknown; entityId: string }) => {
    const out: Array<{ threadId: Id; event: ThreadEvent; value: string | null }> = [];
    const p = change.payload as Record<string, unknown>;
    if (change.kind === "thread_tags" && Array.isArray(p.ids)) {
      for (const id of p.ids as string[])
        out.push({ threadId: String(p.threadId), event: "tagged", value: id });
    }
    if (change.kind === "thread" && typeof p.id === "string") {
      if (p.archived === true) out.push({ threadId: p.id, event: "archived", value: null });
      if (typeof p.snoozedUntil === "string")
        out.push({ threadId: p.id, event: "snoozed", value: null });
      if (p.starred === true) out.push({ threadId: p.id, event: "starred", value: null });
      if (typeof p.group === "string") {
        out.push({ threadId: p.id, event: "moved", value: String(p.subgroup ?? p.group) });
      }
    }
    return out;
  };

  /* ------------------------------ Retention ------------------------------ */

  const prune = async (): Promise<number> => {
    const settings = await options.settings();
    const cutoff = new Date(now().getTime() - settings.retentionDays * 86_400_000);
    const gone = await db
      .delete(workflowRuns)
      .where(
        and(lt(workflowRuns.finishedAt, cutoff), inArray(workflowRuns.status, ["done", "failed"])),
      )
      .returning({ id: workflowRuns.id });
    return gone.length;
  };

  /* ------------------------------ The interface ------------------------------ */

  const api: Workflows = {
    async list(workspaceId) {
      const rows = await db
        .select()
        .from(workflowsTable)
        .where(eq(workflowsTable.workspaceId, workspaceId))
        .orderBy(desc(workflowsTable.updatedAt));
      return Promise.all(rows.map(view));
    },

    async get(workflowId) {
      const found = await row(workflowId);
      return found ? view(found) : null;
    },

    version: document,

    async create(workspaceId, input) {
      const id = crypto.randomUUID();
      const at = now();
      await db.transaction(async (tx) => {
        await tx.insert(workflowsTable).values({
          id,
          workspaceId,
          name: input.name,
          enabled: false,
          currentVersion: 1,
          standingApprovals: input.standingApprovals,
          createdAt: at,
          updatedAt: at,
        });
        await tx
          .insert(workflowVersions)
          .values({ workflowId: id, version: 1, document: input, createdAt: at });
      });
      return view(await requireRow(id));
    },

    async update(workflowId, input) {
      const w = await requireRow(workflowId);
      const version = w.currentVersion + 1;
      const at = now();
      await db.transaction(async (tx) => {
        await tx
          .insert(workflowVersions)
          .values({ workflowId, version, document: input, createdAt: at });
        await tx
          .update(workflowsTable)
          .set({
            name: input.name,
            currentVersion: version,
            standingApprovals: input.standingApprovals.filter((id) =>
              input.steps.some((s) => s.id === id),
            ),
            updatedAt: at,
          })
          .where(eq(workflowsTable.id, workflowId));
      });
      const updated = await requireRow(workflowId);
      await armSchedule(updated, input);
      return view(updated);
    },

    async revert(workflowId, version) {
      const w = await requireRow(workflowId);
      const doc = await document(workflowId, version);
      if (!doc) throw new WorkflowNotFoundError(`${workflowId}@${version}`);
      await db
        .update(workflowsTable)
        .set({ name: doc.name, currentVersion: version, updatedAt: now() })
        .where(eq(workflowsTable.id, w.id));
      const updated = await requireRow(workflowId);
      await armSchedule(updated, doc);
      return view(updated);
    },

    async remove(workflowId) {
      await db.delete(workflowsTable).where(eq(workflowsTable.id, workflowId));
    },

    async enable(workflowId, enabled) {
      const w = await requireRow(workflowId);
      await db
        .update(workflowsTable)
        .set({ enabled, updatedAt: now() })
        .where(eq(workflowsTable.id, w.id));
      const updated = await requireRow(workflowId);
      const doc = await document(workflowId, updated.currentVersion);
      if (doc) await armSchedule(updated, doc);
      return view(updated);
    },

    async standing(workflowId, stepId, granted) {
      const w = await requireRow(workflowId);
      const next = granted
        ? [...new Set([...w.standingApprovals, stepId])]
        : w.standingApprovals.filter((id) => id !== stepId);
      await db
        .update(workflowsTable)
        .set({ standingApprovals: next, updatedAt: now() })
        .where(eq(workflowsTable.id, w.id));
      return view(await requireRow(workflowId));
    },

    async dryRun(workflowId, recent) {
      const w = await requireRow(workflowId);
      const doc = await document(workflowId, w.currentVersion);
      if (!doc) throw new WorkflowNotFoundError(workflowId);
      const settings = await options.settings();
      const sample = await dryRunThreads(w, doc, recent ?? settings.dryRunRecent);
      const out: DryRunThread[] = [];
      if (doc.trigger.kind === "schedule" || doc.trigger.kind === "manual") {
        out.push(await dryRunOne(w, doc, null, settings));
      } else {
        for (const t of sample.threads) out.push(await dryRunOne(w, doc, t, settings));
      }
      const preview: DryRunPreview = {
        workflowId,
        version: w.currentVersion,
        considered: sample.considered,
        threads: out,
      };
      return preview;
    },

    async dryRunInput(workspaceId, input, recent) {
      const settings = await options.settings();
      const at = now();
      const w: WorkflowRow = {
        id: `preview:${crypto.randomUUID()}`,
        workspaceId,
        name: input.name,
        enabled: false,
        currentVersion: 0,
        standingApprovals: [],
        createdAt: at,
        updatedAt: at,
      };
      const sample = await dryRunThreads(w, input, recent ?? settings.dryRunRecent);
      const out: DryRunThread[] = [];
      if (input.trigger.kind === "schedule" || input.trigger.kind === "manual") {
        out.push(await dryRunOne(w, input, null, settings));
      } else {
        for (const t of sample.threads) out.push(await dryRunOne(w, input, t, settings));
      }
      return { workflowId: w.id, version: 0, considered: sample.considered, threads: out };
    },

    async runs(workspaceId, opts = {}) {
      const rows = await db
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workspaceId, workspaceId),
            ...(opts.workflowId ? [eq(workflowRuns.workflowId, opts.workflowId)] : []),
            ...(opts.status ? [eq(workflowRuns.status, opts.status)] : []),
          ),
        )
        .orderBy(desc(workflowRuns.startedAt))
        .limit(100);
      return Promise.all(rows.map(runView));
    },

    async run(runId) {
      const found = await loadRun(runId);
      return found ? runView(found) : null;
    },

    async decide(runId, decision, opts = {}) {
      const run = await loadRun(runId);
      if (run?.status !== "paused") throw new RunNotWaitingError(runId);
      const w = await requireRow(run.workflowId);
      const doc = await document(run.workflowId, run.version);
      if (!doc) throw new WorkflowNotFoundError(run.workflowId);
      const step = doc.steps[run.currentStep];
      if (opts.standing && decision === "approved" && step) {
        await api.standing(w.id, step.id, true);
      }
      await patchRun(run.id, { decision });
      await enqueueStep(run, doc, run.currentStep, true);
      return runView((await loadRun(runId)) as RunRow);
    },

    async start(workflowId, threadId = null) {
      const w = await requireRow(workflowId);
      const doc = await document(workflowId, w.currentVersion);
      if (!doc) throw new WorkflowNotFoundError(workflowId);
      const t = threadId ? await threadRow(threadId) : null;
      const run = await createRun(
        w,
        doc,
        { kind: "manual", threadId: t?.id ?? null },
        t,
        `run:${w.id}:manual:${crypto.randomUUID()}`,
      );
      if (!run) throw new Error("run not created");
      return runView(run);
    },

    async askBeforeEnable() {
      return (await options.settings()).askBeforeEnable;
    },

    async activityOf(runId) {
      const run = await loadRun(runId);
      if (!run) return [];
      const rows = await activity.list(run.workspaceId, { runId, limit: 200 });
      return rows.map(publicActivity).reverse();
    },

    async onArrival(workspaceId, threadId) {
      if (!jobs || !(await automated())) return null;
      const listening = await db
        .select({ id: workflowsTable.id })
        .from(workflowsTable)
        .where(and(eq(workflowsTable.workspaceId, workspaceId), eq(workflowsTable.enabled, true)))
        .limit(1);
      if (listening.length === 0) return null;
      const payload: TriggerJobPayload = { workspaceId, threadId, source: "arrival" };
      return jobs.enqueue(WORKFLOW_TRIGGER_STEP, payload, {
        id: `${WORKFLOW_TRIGGER_STEP}:${threadId}`,
      });
    },

    watch(bus) {
      const cursors = new Map<Id, number>();
      const subscriptions = new Map<Id, () => void>();
      let stopped = false;
      const onNotice = async (workspaceId: Id, seq: number) => {
        if (!jobs) return;
        if (!(await automated())) {
          // The cursor still moves, so old events do not fire when the level rises.
          cursors.set(workspaceId, Math.max(cursors.get(workspaceId) ?? seq, seq));
          return;
        }
        const since = cursors.get(workspaceId);
        if (since === undefined) {
          cursors.set(workspaceId, seq);
          return;
        }
        if (seq <= since) return;
        cursors.set(workspaceId, seq);
        const page = await mailstore.listChanges(workspaceId, { since, limit: 500 });
        for (const change of page.changes) {
          for (const e of eventsOf(change)) {
            const payload: TriggerJobPayload = {
              workspaceId,
              threadId: e.threadId,
              source: "event",
              event: e.event,
              value: e.value,
            };
            await jobs.enqueue(WORKFLOW_TRIGGER_STEP, payload, {
              id: `${WORKFLOW_TRIGGER_STEP}:event:${change.seq}:${e.event}:${e.value ?? ""}`,
            });
          }
        }
      };
      const refresh = async () => {
        if (stopped) return;
        const rows = await db
          .selectDistinct({ workspaceId: workflowsTable.workspaceId })
          .from(workflowsTable)
          .where(eq(workflowsTable.enabled, true));
        for (const r of rows) {
          if (subscriptions.has(r.workspaceId)) continue;
          cursors.set(r.workspaceId, await mailstore.latestSeq(r.workspaceId));
          subscriptions.set(
            r.workspaceId,
            bus.subscribe(r.workspaceId, (notice) => {
              void onNotice(notice.workspaceId, notice.seq).catch((error) =>
                log(`watch: ${error instanceof Error ? error.message : error}`),
              );
            }),
          );
        }
      };
      void refresh().catch((error) =>
        log(`watch: ${error instanceof Error ? error.message : error}`),
      );
      watchers.add(refresh);
      return () => {
        stopped = true;
        watchers.delete(refresh);
        for (const off of subscriptions.values()) off();
        subscriptions.clear();
      };
    },

    prune,

    registerSteps(target) {
      jobs = target;
      target.registerStep<TriggerJobPayload>(WORKFLOW_TRIGGER_STEP, runTriggerJob);
      target.registerStep<StepJobPayload>(WORKFLOW_STEP_STEP, runStepJob);
      target.registerStep<ScheduleJobPayload>(WORKFLOW_SCHEDULE_STEP, runScheduleJob);
    },
  };

  /** Watchers re-check which Workspaces listen after a Workflow is enabled. */
  const watchers = new Set<() => Promise<void>>();
  const enableInner = api.enable;
  api.enable = async (workflowId, enabled) => {
    const result = await enableInner(workflowId, enabled);
    for (const refresh of watchers) await refresh();
    return result;
  };

  return api;
}
