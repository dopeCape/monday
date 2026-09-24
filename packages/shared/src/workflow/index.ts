// Workflows (ADR 0003, CONTEXT.md "Workflow", "Kind", "Trigger", "Step",
// "Run", "Placement", "Dry run", "Budget", "Standing approval"): the JSON
// document the Agent writes, validated against this schema, and the shapes
// the /workflows routes exchange with the client. A hybrid Workflow is a
// declarative skeleton of typed Steps; an agentic Workflow is the same
// document with one agentic Step. Runtime-neutral: zod only.

import { z } from "zod";
import type { Id, IsoDate, Placement, Tier } from "../domain.ts";
import { parseCron } from "./cron.ts";

export type { CronSchedule } from "./cron.ts";
export { cronMatches, nextCronRun, parseCron } from "./cron.ts";
export type { StepContext, TemplateContext } from "./template.ts";
export { evaluateCondition, readPath, renderTemplate } from "./template.ts";

/* ------------------------------ Triggers ------------------------------ */

export const predicateSchema = z.object({
  senders: z.array(z.string().min(1)).optional(),
  domains: z.array(z.string().min(1)).optional(),
  subjectPatterns: z.array(z.string().min(1)).optional(),
  listIds: z.array(z.string().min(1)).optional(),
  hasAttachment: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type PredicateInput = z.output<typeof predicateSchema>;

/** The Thread events a Workflow can start on, read from the Changes feed. */
export const THREAD_EVENTS = ["tagged", "archived", "snoozed", "moved", "starred"] as const;
export type ThreadEvent = (typeof THREAD_EVENTS)[number];

/**
 * A semantic test the judge answers (ADR 0012, slice 27): a statement about
 * the Thread worded so that yes is high ("the message is a complaint"), and
 * the probability at or above which it holds. Absent, the threshold is the
 * Setting workflows.judged.threshold.
 */
export const judgedSchema = z.object({
  statement: z.string().min(1).max(2000),
  threshold: z.number().min(0).max(1).optional(),
});
export type Judged = z.output<typeof judgedSchema>;

export const triggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("arrival"),
      /** Only Threads routing put in this Group (or Sub-group). */
      group: z.string().min(1).optional(),
      /** Only Threads whose headers match; combined with `group` when both are set. */
      predicate: predicateSchema.optional(),
      /** Only Threads the judge says the statement holds for; combined with the two above. */
      judge: judgedSchema.optional(),
    })
    .describe("A Thread arrives"),
  z
    .object({
      kind: z.literal("schedule"),
      /** Five fields: minute hour day-of-month month day-of-week, UTC. */
      cron: z
        .string()
        .min(9)
        .max(100)
        .refine(
          (v) => {
            try {
              parseCron(v);
              return true;
            } catch {
              return false;
            }
          },
          { message: "five cron fields: minute hour day month weekday" },
        ),
    })
    .describe("On a schedule"),
  z.object({ kind: z.literal("manual") }).describe("Only when asked"),
  z
    .object({
      kind: z.literal("silence"),
      /** Days without a reply from the user before the Run starts. */
      days: z.int().min(1).max(365),
      /** Only Threads in this Group (or Sub-group). */
      group: z.string().min(1).optional(),
    })
    .describe("Silence after N days"),
  z
    .object({
      kind: z.literal("thread_event"),
      event: z.enum(THREAD_EVENTS),
      /** For `tagged`: the Tag name; for `moved`: the Group id. */
      value: z.string().min(1).optional(),
    })
    .describe("Something happens to a Thread"),
]);
export type Trigger = z.output<typeof triggerSchema>;

/** "Fridays 16:00" and "1st of month 06:00" for the crons the Agent writes; the raw cron otherwise. */
export function describeCron(cron: string): string {
  const [m, h, d, mo, w] = cron.trim().split(/\s+/);
  if (!m || !h || d === undefined || mo === undefined || w === undefined) return cron;
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return cron;
  const time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  const days = [
    "Sundays",
    "Mondays",
    "Tuesdays",
    "Wednesdays",
    "Thursdays",
    "Fridays",
    "Saturdays",
  ];
  const names: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  if (d === "*" && mo === "*" && w !== "*") {
    const n = names[w.toLowerCase()] ?? (/^\d$/.test(w) ? Number(w) % 7 : null);
    if (n !== null && days[n]) return `${days[n]} ${time}`;
  }
  if (w === "*" && mo === "*" && /^\d+$/.test(d)) {
    const n = Number(d);
    const suffix =
      n % 10 === 1 && n !== 11
        ? "st"
        : n % 10 === 2 && n !== 12
          ? "nd"
          : n % 10 === 3 && n !== 13
            ? "rd"
            : "th";
    return `${n}${suffix} of month ${time}`;
  }
  if (d === "*" && mo === "*" && w === "*") return `Daily ${time}`;
  return cron;
}

/* ------------------------------ Steps ------------------------------ */

/** The five integrations (design/js/data.js, docs/spec/onboarding.md). */
export const INTEGRATIONS = ["slack", "notion", "drive", "discord", "webhook"] as const;
export type Integration = (typeof INTEGRATIONS)[number];

const stepId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "a step id is lowercase letters, digits and underscores");
const name = z.string().min(1).max(120);
/** A text with {{thread.subject}}, {{thread.from}}, {{steps.<id>.<field>}} holes. */
const template = z.string().max(20_000);

export const budgetSchema = z.object({
  /** Tool calls the Step may make; null means the Setting. */
  calls: z.int().min(1).nullable().optional(),
  /** Model tokens (input plus output) the Step may spend; null means the Setting. */
  tokens: z.int().min(1000).nullable().optional(),
  /** Wall time in minutes; null means the Setting. */
  minutes: z.int().min(1).nullable().optional(),
});
export type Budget = z.output<typeof budgetSchema>;

export const FAILURE_POLICIES = ["stop", "skip", "notify"] as const;
export type FailurePolicy = (typeof FAILURE_POLICIES)[number];
const failurePolicy = z.enum(FAILURE_POLICIES);

const base = {
  id: stepId,
  name,
  /** Overrides the Workflow's failure policy for this Step. */
  onFailure: failurePolicy.optional(),
};

export const CONDITION_OPS = [
  "contains",
  "equals",
  "matches",
  "exists",
  "not_contains",
  "judged",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export const conditionSchema = z
  .object({
    /**
     * A template whose rendered value is tested, such as {{steps.extract.role}}.
     * A `judged` condition may leave it out: the judge reads the Thread.
     */
    left: template.default(""),
    op: z.enum(CONDITION_OPS),
    value: z.string().optional(),
    /** For `judged`: the statement the judge tests, worded so that yes is high. */
    statement: z.string().min(1).max(2000).optional(),
    /** For `judged`: the probability at or above which the statement holds; absent means the Setting. */
    threshold: z.number().min(0).max(1).optional(),
  })
  .superRefine((when, ctx) => {
    if (when.op === "judged" && !when.statement) {
      ctx.addIssue({
        code: "custom",
        path: ["statement"],
        message: "a judged condition needs a statement",
      });
    }
  });
export type Condition = z.output<typeof conditionSchema>;

export const stepSchema = z.discriminatedUnion("kind", [
  /* Built-in */
  z.object({
    ...base,
    kind: z.literal("tag"),
    add: z.array(z.string().min(1)).default([]),
    remove: z.array(z.string().min(1)).default([]),
  }),
  z.object({ ...base, kind: z.literal("move"), group: z.string().min(1).nullable() }),
  z.object({ ...base, kind: z.literal("archive") }),
  z.object({
    ...base,
    kind: z.literal("snooze"),
    hours: z
      .number()
      .positive()
      .max(24 * 365),
  }),
  z.object({
    ...base,
    kind: z.literal("draft_reply"),
    /** The reply text, with holes; absent means "in my voice" from `instructions`. */
    template: template.optional(),
    /** What the draft-in-voice Task writes when there is no template. */
    instructions: z.string().max(4000).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("send"),
    /** The draft_reply Step whose Draft this sends. Always asks. */
    draftFrom: stepId,
  }),
  z.object({ ...base, kind: z.literal("notify"), text: template }),
  z.object({
    ...base,
    kind: z.literal("wait"),
    hours: z
      .number()
      .positive()
      .max(24 * 365),
  }),
  z.object({
    ...base,
    kind: z.literal("condition"),
    when: conditionSchema,
    /** What happens when the test fails: the Run ends, or only the next Step is skipped. */
    otherwise: z.enum(["stop", "skip_next"]).default("stop"),
  }),
  /* Integrations */
  z.object({ ...base, kind: z.literal("slack"), channel: z.string().min(1), text: template }),
  z.object({
    ...base,
    kind: z.literal("notion"),
    database: z.string().min(1),
    properties: z.record(z.string().min(1), template).default({}),
  }),
  z.object({
    ...base,
    kind: z.literal("drive"),
    folder: z.string().min(1),
    /** What the file is saved as; absent keeps the attachment's name. */
    fileName: template.optional(),
  }),
  z.object({ ...base, kind: z.literal("discord"), channel: z.string().min(1), text: template }),
  z.object({
    ...base,
    kind: z.literal("webhook"),
    url: z.url(),
    method: z.enum(["POST", "PUT"]).default("POST"),
    body: z.record(z.string(), template).default({}),
  }),
  /* An MCP server's tool as a Step (docs/spec/settings.md, "MCP servers") */
  z.object({
    ...base,
    kind: z.literal("mcp"),
    /** The server's name in workflows.mcp_servers. */
    server: z.string().min(1),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  /* The agentic Step */
  z.object({
    ...base,
    kind: z.literal("agentic"),
    prompt: template,
    /** Tool names the Step may call; empty means every tool the catalog has. */
    tools: z.array(z.string().min(1)).default([]),
    budget: budgetSchema.default({}),
    /** Fields the Step should report, readable later as {{steps.<id>.<field>}}. */
    outputs: z.array(z.string().min(1)).default([]),
  }),
]);
export type Step = z.output<typeof stepSchema>;
export type StepKind = Step["kind"];
export type StepInput = z.input<typeof stepSchema>;

export const STEP_KINDS: readonly StepKind[] = [
  "tag",
  "move",
  "archive",
  "snooze",
  "draft_reply",
  "send",
  "notify",
  "wait",
  "condition",
  "slack",
  "notion",
  "drive",
  "discord",
  "webhook",
  "mcp",
  "agentic",
];

/** The Tier a Step kind runs at before any promotion: what leaves the mailbox asks. */
export function stepTier(kind: StepKind): Tier {
  switch (kind) {
    case "send":
    case "slack":
    case "notion":
    case "drive":
    case "discord":
    case "webhook":
    case "mcp":
      return "always-ask";
    case "tag":
    case "move":
    case "archive":
    case "snooze":
    case "draft_reply":
      return "reversible";
    default:
      return "read-only";
  }
}

/** Whether a Step kind changes anything: a Dry run records these instead of applying them. */
export function stepMutates(kind: StepKind): boolean {
  return stepTier(kind) !== "read-only" || kind === "agentic";
}

/* ------------------------------ The document ------------------------------ */

export const placementSchema = z.enum(["server", "local"]) satisfies z.ZodType<Placement>;

/** What create and update take: the document without its row state. */
export const workflowInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    /** The sentence the user asked for, kept as the Workflow's description. */
    sentence: z.string().max(2000).default(""),
    kind: z.enum(["hybrid", "agentic"]).default("hybrid"),
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1).max(50),
    /** Null means the Setting workflows.placement. */
    placement: placementSchema.nullable().default(null),
    failurePolicy: failurePolicy.default("stop"),
    /** Step ids whose always-ask calls run unattended in this Workflow. */
    standingApprovals: z.array(stepId).default([]),
  })
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    doc.steps.forEach((step, index) => {
      if (ids.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `step id "${step.id}" is used twice`,
        });
      }
      ids.add(step.id);
      if (step.kind === "send" && !doc.steps.slice(0, index).some((s) => s.id === step.draftFrom)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "draftFrom"],
          message: `send step "${step.id}" needs an earlier draft_reply step "${step.draftFrom}"`,
        });
      }
    });
    if (doc.kind === "agentic" && (doc.steps.length !== 1 || doc.steps[0]?.kind !== "agentic")) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "an agentic Workflow has exactly one agentic step",
      });
    }
    for (const id of doc.standingApprovals) {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["standingApprovals"],
          message: `standing approval names an unknown step "${id}"`,
        });
      }
    }
  });
export type WorkflowInput = z.output<typeof workflowInputSchema>;
export type WorkflowInputRaw = z.input<typeof workflowInputSchema>;

/** Validates a document the Agent or a route handed in; the error is one readable line. */
export function parseWorkflowInput(
  value: unknown,
): { ok: true; value: WorkflowInput } | { ok: false; error: string } {
  const parsed = workflowInputSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const error = parsed.error.issues
    .map((i) => `${i.path.map(String).join(".") || "document"}: ${i.message}`)
    .join("; ");
  return { ok: false, error };
}

/** A Workflow as stored and served: the document at its current version plus row state. */
export interface WorkflowDocument extends WorkflowInput {
  id: Id;
  workspaceId: Id;
  version: number;
  enabled: boolean;
  /** The Placement in effect: the document's, or the Setting's. */
  placementInEffect: Placement;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** What the list shows beside a Workflow. */
export interface WorkflowView extends WorkflowDocument {
  lastRunAt: IsoDate | null;
  /** Runs started today, UTC. */
  runsToday: number;
  /** The last dozen Runs' outcomes, oldest first, for the sparkline. */
  recent: Array<"done" | "failed" | "paused" | "running">;
  /** Runs waiting for an approval. */
  paused: number;
}

/* ------------------------------ Runs ------------------------------ */

export type RunStatus = "queued" | "running" | "paused" | "done" | "failed";
export type RunStepStatus = "running" | "done" | "failed" | "waiting" | "skipped";

/** What started a Run. */
export type RunTrigger =
  | { kind: "arrival"; threadId: Id }
  | { kind: "thread_event"; threadId: Id; event: ThreadEvent }
  | { kind: "schedule"; at: IsoDate }
  | { kind: "silence"; threadId: Id }
  | { kind: "manual"; threadId: Id | null };

export interface RunStepView {
  index: number;
  stepId: string;
  name: string;
  kind: StepKind;
  status: RunStepStatus;
  /** The one line the Run log shows. */
  detail: string;
  /** The Activity row the Step ran as, when it ran through a tool. */
  activityId: Id | null;
  at: IsoDate;
}

export interface RunView {
  id: Id;
  workflowId: Id;
  workspaceId: Id;
  /** The version the Run ran under; a later edit never changes it. */
  version: number;
  status: RunStatus;
  trigger: RunTrigger;
  /** The Thread the Run is about, for the log line. */
  threadId: Id | null;
  subject: string;
  currentStep: number;
  failedStep: number | null;
  /** The Activity row waiting for approval while paused. */
  waitingActivityId: Id | null;
  /** The paused Step's index while paused. */
  waitingStep: number | null;
  error: string | null;
  steps: RunStepView[];
  startedAt: IsoDate;
  finishedAt: IsoDate | null;
}

/* ------------------------------ Dry run ------------------------------ */

export type DryStepStatus = "would_apply" | "would_ask" | "skipped" | "done" | "stopped";

export interface DryRunStep {
  index: number;
  stepId: string;
  name: string;
  kind: StepKind;
  status: DryStepStatus;
  detail: string;
}

/** What the judge said about one Thread in a Dry run (slice 27): the trigger's or a condition Step's statement. */
export interface DryRunJudgment {
  /** "trigger", or the condition Step's id. */
  where: string;
  statement: string;
  /** The probability the statement holds; null when no judge answered. */
  probability: number | null;
  threshold: number;
  held: boolean;
  /** Why there is no probability: no judge is configured, or the request failed. */
  reason?: string | undefined;
}

export interface DryRunThread {
  threadId: Id;
  subject: string;
  from: string;
  steps: DryRunStep[];
  /** The judged statements this Thread was tested against, in order. */
  judged?: DryRunJudgment[] | undefined;
}

/** What a Dry run reports: the would-be Activity over the last N matching Threads, nothing applied. */
export interface DryRunPreview {
  workflowId: Id;
  version: number;
  /** Threads the trigger would have matched; with a judged trigger, the Threads the judge was asked about. */
  considered: number;
  threads: DryRunThread[];
}

/* ------------------------------ MCP servers as steps ------------------------------ */

export const mcpServerSchema = z.object({
  name: z.string().min(1).max(60),
  /** A command to spawn (stdio), or a URL (streamable HTTP). */
  command: z.string().min(1).optional(),
  url: z.url().optional(),
  /** A bearer token for a URL server. */
  token: z.string().optional(),
  /** Which of its tools become Workflow steps and Agent tools; empty means every one. */
  tools: z.array(z.string().min(1)).default([]),
});
export type McpServerSetting = z.output<typeof mcpServerSchema>;

/* ------------------------------ Describing a document ------------------------------ */

/** A node of the chain the Workflows page draws; the icon is a name the UI maps to Phosphor. */
export interface FlowNodeText {
  kind: "trig" | "act" | "cond";
  icon: string;
  label: string;
  detail: string | undefined;
}

export function describeTrigger(
  trigger: Trigger,
  groupName?: (id: string) => string,
): FlowNodeText {
  switch (trigger.kind) {
    case "arrival": {
      const parts: string[] = [];
      if (trigger.group)
        parts.push(`matches ${groupName ? groupName(trigger.group) : trigger.group}`);
      if (trigger.predicate?.domains?.length)
        parts.push(`from ${trigger.predicate.domains.join(", ")}`);
      if (trigger.predicate?.senders?.length)
        parts.push(`from ${trigger.predicate.senders.join(", ")}`);
      if (trigger.predicate?.subjectPatterns?.length)
        parts.push(`subject ${trigger.predicate.subjectPatterns.join(", ")}`);
      if (trigger.predicate?.hasAttachment) parts.push("with an attachment");
      if (trigger.judge) parts.push(trigger.judge.statement);
      return {
        kind: "trig",
        icon: "envelope",
        label: "Email arrives",
        detail: parts.join(", ") || undefined,
      };
    }
    case "schedule":
      return {
        kind: "trig",
        icon: "calendar",
        label: describeCron(trigger.cron),
        detail: undefined,
      };
    case "manual":
      return { kind: "trig", icon: "hand", label: "When asked", detail: undefined };
    case "silence":
      return {
        kind: "trig",
        icon: "timer",
        label: "No reply",
        detail: `${trigger.days} day${trigger.days === 1 ? "" : "s"}${trigger.group ? ` in ${groupName ? groupName(trigger.group) : trigger.group}` : ""}`,
      };
    case "thread_event":
      return {
        kind: "trig",
        icon: "tag",
        label: `Thread ${trigger.event}`,
        detail: trigger.value,
      };
  }
}

export function describeStep(step: Step, groupName?: (id: string) => string): FlowNodeText {
  const act = (icon: string, detail?: string | null): FlowNodeText => ({
    kind: "act",
    icon,
    label: step.name,
    detail: detail || undefined,
  });
  switch (step.kind) {
    case "tag":
      return act(
        "tag",
        [...step.add.map((t) => `+${t}`), ...step.remove.map((t) => `-${t}`)].join(" "),
      );
    case "move":
      return act(
        "folder",
        step.group ? (groupName ? groupName(step.group) : step.group) : "no group",
      );
    case "archive":
      return act("archive");
    case "snooze":
      return act("clock", `${step.hours} h`);
    case "draft_reply":
      return act("note", step.template ? "from template" : "in my voice");
    case "send":
      return act("send", "asks first");
    case "notify":
      return act("bell");
    case "wait":
      return act("timer", `${step.hours} h`);
    case "condition":
      return {
        kind: "cond",
        icon: "branch",
        label: step.name,
        detail: step.when.op === "judged" ? step.when.statement : undefined,
      };
    case "slack":
      return act("slack", step.channel);
    case "notion":
      return act("notion", `add row to ${step.database}`);
    case "drive":
      return act("drive", step.folder);
    case "discord":
      return act("discord", step.channel);
    case "webhook":
      return act("webhook", new URL(step.url).host);
    case "mcp":
      return act("plug", `${step.server}: ${step.tool}`);
    case "agentic":
      return act("brain", step.outputs.join(", "));
  }
}

export function describeWorkflow(
  doc: Pick<WorkflowInput, "trigger" | "steps">,
  groupName?: (id: string) => string,
): FlowNodeText[] {
  return [
    describeTrigger(doc.trigger, groupName),
    ...doc.steps.map((s) => describeStep(s, groupName)),
  ];
}

/* ------------------------------ Sketches and diffs ------------------------------ */

/**
 * A Workflow document as a card draws it: what the Agent is about to create
 * or change (the composer's Workflow card) and what the Workflows page shows.
 * Row state (id, version, enabled) stays out.
 */
export type WorkflowSketch = Pick<
  WorkflowInput,
  "name" | "sentence" | "kind" | "trigger" | "steps" | "placement" | "standingApprovals"
>;

/** The sketch of a document: the fields a card draws, nothing else. */
export function sketchOf(doc: WorkflowSketch): WorkflowSketch {
  return {
    name: doc.name,
    sentence: doc.sentence,
    kind: doc.kind,
    trigger: doc.trigger,
    steps: doc.steps,
    placement: doc.placement,
    standingApprovals: doc.standingApprovals,
  };
}

export type WorkflowChange = "added" | "changed" | "same";

/** What an edit changes, Step by Step (Steps are matched by id). */
export interface WorkflowDiff {
  renamed: boolean;
  sentence: boolean;
  trigger: WorkflowChange;
  /** One entry per Step of the new document, in its order. */
  steps: Array<{ id: string; change: WorkflowChange }>;
  /** Steps the old document had and the new one does not, in their old order. */
  removed: Step[];
  /** Whether anything at all differs. */
  changed: boolean;
}

/** JSON with sorted keys, so two documents that differ only in key order compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What changed between two versions of a Workflow: the card marks new, changed and removed Steps. */
export function diffWorkflow(
  previous: Pick<WorkflowSketch, "name" | "sentence" | "trigger" | "steps">,
  next: Pick<WorkflowSketch, "name" | "sentence" | "trigger" | "steps">,
): WorkflowDiff {
  const before = new Map(previous.steps.map((s) => [s.id, s]));
  const after = new Set(next.steps.map((s) => s.id));
  const steps = next.steps.map((s) => {
    const old = before.get(s.id);
    const change: WorkflowChange = !old ? "added" : stable(old) === stable(s) ? "same" : "changed";
    return { id: s.id, change };
  });
  const removed = previous.steps.filter((s) => !after.has(s.id));
  const renamed = previous.name !== next.name;
  const sentence = previous.sentence !== next.sentence;
  const trigger: WorkflowChange =
    stable(previous.trigger) === stable(next.trigger) ? "same" : "changed";
  return {
    renamed,
    sentence,
    trigger,
    steps,
    removed,
    changed:
      renamed ||
      sentence ||
      trigger !== "same" ||
      removed.length > 0 ||
      steps.some((s) => s.change !== "same"),
  };
}
