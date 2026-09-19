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

export const triggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("arrival"),
      /** Only Threads routing put in this Group (or Sub-group). */
      group: z.string().min(1).optional(),
      /** Only Threads whose headers match; combined with `group` when both are set. */
      predicate: predicateSchema.optional(),
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
      kind: z.literal("thread_event"),
      event: z.enum(THREAD_EVENTS),
      /** For `tagged`: the Tag name; for `moved`: the Group id. */
      value: z.string().min(1).optional(),
    })
    .describe("Something happens to a Thread"),
]);
export type Trigger = z.output<typeof triggerSchema>;

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

export const conditionSchema = z.object({
  /** A template whose rendered value is tested, such as {{steps.extract.role}}. */
  left: template,
  op: z.enum(["contains", "equals", "matches", "exists", "not_contains"]),
  value: z.string().optional(),
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
  z.object({ ...base, kind: z.literal("drive"), folder: z.string().min(1), name: template }),
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

export interface DryRunThread {
  threadId: Id;
  subject: string;
  from: string;
  steps: DryRunStep[];
}

/** What a Dry run reports: the would-be Activity over the last N matching Threads, nothing applied. */
export interface DryRunPreview {
  workflowId: Id;
  version: number;
  /** Threads the trigger would have matched. */
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
      return {
        kind: "trig",
        icon: "envelope",
        label: "Email arrives",
        detail: parts.join(", ") || undefined,
      };
    }
    case "schedule":
      return { kind: "trig", icon: "calendar", label: "On a schedule", detail: trigger.cron };
    case "manual":
      return { kind: "trig", icon: "hand", label: "When asked", detail: undefined };
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
      return { kind: "cond", icon: "branch", label: step.name, detail: undefined };
    case "slack":
      return act("slack", step.channel);
    case "notion":
      return act("notion", step.database);
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
