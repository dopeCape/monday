// The catalog's extensions (slice 16): the five integrations and MCP servers
// as always-ask tools, and the Workflow tools the composer authors Workflows
// with (ADR 0003: the Agent writes the document, never code). They reach
// their modules through seams the tool server is handed at creation
// (ToolExtensions), so a Device ToolHost without them simply refuses.

import type {
  DryRunPreview,
  RunView,
  ToolPreview,
  WorkflowInput,
  WorkflowView,
} from "@monday/shared";
import { describeWorkflow, type INTEGRATIONS, parseWorkflowInput } from "@monday/shared";
import { z } from "zod";
import type { IntegrationPost, IntegrationResult } from "../../../workflows/integrations.ts";
import type { McpCallResult } from "../../../workflows/mcp.ts";
import type { ToolDefinition, ToolPlan } from "./catalog.ts";

/* ------------------------------ Seams ------------------------------ */

export interface IntegrationsSeam {
  post(workspaceId: string, post: IntegrationPost): Promise<IntegrationResult>;
  configured(integration: (typeof INTEGRATIONS)[number]): Promise<boolean>;
}

export interface McpSeam {
  call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/** What the Workflow tools act through: the Workflows module on the Server. */
export interface WorkflowsSeam {
  list(workspaceId: string): Promise<WorkflowView[]>;
  get(workflowId: string): Promise<WorkflowView | null>;
  create(workspaceId: string, input: WorkflowInput): Promise<WorkflowView>;
  /** A new version; the old one stays for the Runs that ran under it. */
  update(workflowId: string, input: WorkflowInput): Promise<WorkflowView>;
  /** Points the Workflow back at an earlier version (Undo of an update). */
  revert(workflowId: string, version: number): Promise<WorkflowView>;
  remove(workflowId: string): Promise<void>;
  enable(workflowId: string, enabled: boolean): Promise<WorkflowView>;
  dryRun(workflowId: string, recent?: number): Promise<DryRunPreview>;
  runs(
    workspaceId: string,
    options?: { workflowId?: string; status?: RunView["status"] },
  ): Promise<RunView[]>;
  run(runId: string): Promise<RunView | null>;
  /** Answers a paused Run; `standing` also grants a Standing approval on that Step. */
  decide(
    runId: string,
    decision: "approved" | "declined",
    options?: { standing?: boolean },
  ): Promise<RunView>;
  start(workflowId: string, threadId?: string | null): Promise<RunView>;
  /** The Setting workflows.ask_before_enable. */
  askBeforeEnable(): Promise<boolean>;
}

export interface ToolExtensions {
  integrations?: IntegrationsSeam | undefined;
  mcp?: McpSeam | undefined;
  workflows?: WorkflowsSeam | undefined;
}

const text = (t: string): ToolPreview => ({ kind: "text", text: t });

/* ------------------------------ Integrations ------------------------------ */

function integrationPlan(
  seam: IntegrationsSeam | undefined,
  workspaceId: string,
  post: IntegrationPost,
  line: string,
): ToolPlan {
  if (!seam) return { kind: "refused", text: "Integrations are not available from this host." };
  return {
    kind: "action",
    preview: text(line),
    count: 1,
    apply: async () => {
      if (!(await seam.configured(post.integration))) {
        throw new Error(
          `${post.integration} is not set up; add it under Settings, Workflows, Integrations.`,
        );
      }
      const result = await seam.post(workspaceId, post);
      return { text: result.text, data: result.data, undo: null };
    },
  };
}

const postToSlack: ToolDefinition<{ channel: string; text: string }> = {
  name: "post_to_slack",
  description: "Post a message to a Slack channel. Reaches a third party, so it always asks first.",
  tier: "leaves_mailbox",
  input: z.object({ channel: z.string().min(1), text: z.string().min(1).max(20_000) }),
  summarize: (i) => i.channel,
  run: async (i, ctx) =>
    integrationPlan(
      ctx.extensions?.integrations,
      ctx.host.workspaceId,
      { integration: "slack", channel: i.channel, text: i.text },
      `Slack ${i.channel}:\n${i.text}`,
    ),
};

const postToDiscord: ToolDefinition<{ channel: string; text: string }> = {
  name: "post_to_discord",
  description:
    "Post a message to a Discord channel. Reaches a third party, so it always asks first.",
  tier: "leaves_mailbox",
  input: z.object({ channel: z.string().min(1), text: z.string().min(1).max(20_000) }),
  summarize: (i) => i.channel,
  run: async (i, ctx) =>
    integrationPlan(
      ctx.extensions?.integrations,
      ctx.host.workspaceId,
      { integration: "discord", channel: i.channel, text: i.text },
      `Discord ${i.channel}:\n${i.text}`,
    ),
};

const addNotionRow: ToolDefinition<{ database: string; properties: Record<string, string> }> = {
  name: "add_notion_row",
  description:
    "Add a row to a Notion database; the first property is the title. Reaches a third party, so it always asks first.",
  tier: "leaves_mailbox",
  input: z.object({
    database: z.string().min(1).describe("The database id or name as configured"),
    properties: z.record(z.string().min(1), z.string()),
  }),
  summarize: (i) => i.database,
  run: async (i, ctx) =>
    integrationPlan(
      ctx.extensions?.integrations,
      ctx.host.workspaceId,
      { integration: "notion", database: i.database, properties: i.properties },
      `Notion ${i.database}:\n${Object.entries(i.properties)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")}`,
    ),
};

const saveToDrive: ToolDefinition<{
  attachment_id: string;
  folder: string;
  name?: string | undefined;
}> = {
  name: "save_to_drive",
  description:
    "Save an attachment to a Google Drive folder, optionally renamed. Reaches a third party, so it always asks first.",
  tier: "leaves_mailbox",
  input: z.object({
    attachment_id: z.string().min(1),
    folder: z.string().min(1).describe("The Drive folder id"),
    name: z.string().min(1).optional(),
  }),
  summarize: (i) => `${i.name ?? i.attachment_id} to ${i.folder}`,
  async run(i, ctx) {
    if (!ctx.host.readAttachment) {
      return { kind: "refused", text: "Attachments cannot be read from this host." };
    }
    const attachment = await ctx.host.readAttachment(i.attachment_id);
    if (!attachment) return { kind: "refused", text: `Attachment ${i.attachment_id} not found.` };
    const name = i.name ?? attachment.name;
    return integrationPlan(
      ctx.extensions?.integrations,
      ctx.host.workspaceId,
      {
        integration: "drive",
        folder: i.folder,
        name,
        mediaType: attachment.mediaType,
        bytes: attachment.bytes,
      },
      `Drive ${i.folder}: ${name} (${attachment.bytes.length} bytes)`,
    );
  },
};

const callWebhook: ToolDefinition<{
  url: string;
  method: "POST" | "PUT";
  body: Record<string, unknown>;
}> = {
  name: "call_webhook",
  description: "Send JSON to a URL. Reaches a third party, so it always asks first.",
  tier: "leaves_mailbox",
  input: z.object({
    url: z.url(),
    method: z.enum(["POST", "PUT"]).default("POST"),
    body: z.record(z.string(), z.unknown()).default({}),
  }),
  summarize: (i) => `${i.method} ${new URL(i.url).host}`,
  run: async (i, ctx) =>
    integrationPlan(
      ctx.extensions?.integrations,
      ctx.host.workspaceId,
      { integration: "webhook", url: i.url, method: i.method, body: i.body },
      `${i.method} ${i.url}\n${JSON.stringify(i.body, null, 2)}`,
    ),
};

const callMcpTool: ToolDefinition<{ server: string; tool: string; args: Record<string, unknown> }> =
  {
    name: "call_mcp_tool",
    description:
      "Call a tool on an MCP server the user added under Settings, Workflows. Reaches a third party, so it always asks first.",
    tier: "leaves_mailbox",
    input: z.object({
      server: z.string().min(1),
      tool: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
    }),
    summarize: (i) => `${i.server}: ${i.tool}`,
    async run(i, ctx) {
      const seam = ctx.extensions?.mcp;
      if (!seam) return { kind: "refused", text: "MCP servers are not available from this host." };
      return {
        kind: "action",
        preview: text(`${i.server} ${i.tool}\n${JSON.stringify(i.args, null, 2)}`),
        count: 1,
        apply: async () => {
          const result = await seam.call(i.server, i.tool, i.args);
          if (result.isError) throw new Error(result.text || `${i.tool} failed`);
          return { text: result.text || `${i.tool} done`, data: result.data, undo: null };
        },
      };
    },
  };

/* ------------------------------ Workflows ------------------------------ */

const needWorkflows = (ctx: { extensions?: ToolExtensions | undefined }): WorkflowsSeam | null =>
  ctx.extensions?.workflows ?? null;

const REFUSED = "Workflows are not available from this host.";

function chainText(doc: Pick<WorkflowInput, "trigger" | "steps">): string {
  return describeWorkflow(doc)
    .map((n) => (n.detail ? `${n.label} (${n.detail})` : n.label))
    .join(" -> ");
}

function workflowLine(w: WorkflowView): string {
  return `${w.id} "${w.name}" v${w.version} ${w.enabled ? "enabled" : "disabled"} on ${w.placementInEffect}: ${chainText(w)}`;
}

function dryRunText(preview: DryRunPreview): string {
  if (preview.threads.length === 0)
    return "No recent Thread matches this trigger; nothing to show.";
  return [
    `Dry run over ${preview.threads.length} of ${preview.considered} matching threads (nothing applied):`,
    ...preview.threads.map(
      (t) =>
        `- ${t.subject} (${t.from}): ${t.steps.map((s) => `${s.name} ${s.status}${s.detail ? ` [${s.detail}]` : ""}`).join("; ")}`,
    ),
  ].join("\n");
}

const listWorkflows: ToolDefinition<Record<string, never>> = {
  name: "list_workflows",
  description:
    "The Workflows of this Workspace with their id, version, enabled state, Placement and step chain.",
  tier: "read",
  input: z.object({}),
  summarize: () => "",
  async run(_i, ctx) {
    const seam = needWorkflows(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const list = await seam.list(ctx.host.workspaceId);
    return {
      kind: "result",
      text: list.length ? list.map(workflowLine).join("\n") : "No workflows yet.",
      data: { workflows: list },
    };
  },
};

const documentField = z
  .record(z.string(), z.unknown())
  .describe(
    "The Workflow document: name, sentence, kind (hybrid or agentic), trigger ({kind: arrival, group?, predicate?} | {kind: schedule, cron} | {kind: manual} | {kind: thread_event, event, value?}), steps (each with id, name, kind and its fields: tag {add, remove}; move {group}; archive; snooze {hours}; draft_reply {template | instructions}; send {draftFrom}; notify {text}; wait {hours}; condition {when: {left, op, value}, otherwise}; slack {channel, text}; notion {database, properties}; drive {folder, name}; discord {channel, text}; webhook {url, method, body}; mcp {server, tool, args}; agentic {prompt, tools, budget, outputs}), placement (server | local | null), failurePolicy (stop | skip | notify). Texts may hold {{thread.subject}}, {{thread.from}} and {{steps.<id>.<field>}}.",
  );

const createWorkflow: ToolDefinition<{ document: Record<string, unknown> }> = {
  name: "create_workflow",
  description:
    "Create a Workflow from a document. It starts disabled; enable_workflow turns it on after a Dry run. Reversible: undo deletes it.",
  tier: "reversible",
  input: z.object({ document: documentField }),
  summarize: (i) => String(i.document.name ?? "workflow"),
  async run(i, ctx) {
    const seam = needWorkflows(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    // Standing approvals are the user's to grant, never the Agent's.
    const parsed = parseWorkflowInput({ ...i.document, standingApprovals: [] });
    if (!parsed.ok)
      return { kind: "refused", text: `The document does not validate: ${parsed.error}` };
    const doc = parsed.value;
    return {
      kind: "action",
      preview: text(`${doc.name}: ${chainText(doc)}`),
      count: 1,
      apply: async () => {
        const created = await seam.create(ctx.host.workspaceId, doc);
        return {
          text: `Created workflow ${created.id} "${created.name}" (disabled). Run dry_run_workflow, then enable_workflow.`,
          data: { workflow: created },
          undo: { kind: "workflow", workflowId: created.id, previous: null },
        };
      },
    };
  },
};

const updateWorkflow: ToolDefinition<{ workflow_id: string; document: Record<string, unknown> }> = {
  name: "update_workflow",
  description:
    "Replace a Workflow's document with a new version; earlier versions stay for the Runs that used them. Reversible: undo points back at the previous version.",
  tier: "reversible",
  input: z.object({ workflow_id: z.string().min(1), document: documentField }),
  summarize: (i) => i.workflow_id,
  async run(i, ctx) {
    const seam = needWorkflows(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const current = await seam.get(i.workflow_id);
    if (!current) return { kind: "refused", text: `Workflow ${i.workflow_id} not found.` };
    const parsed = parseWorkflowInput({
      ...i.document,
      standingApprovals: current.standingApprovals,
    });
    if (!parsed.ok)
      return { kind: "refused", text: `The document does not validate: ${parsed.error}` };
    const doc = parsed.value;
    return {
      kind: "action",
      preview: text(`${doc.name} v${current.version + 1}: ${chainText(doc)}`),
      count: 1,
      apply: async () => {
        const updated = await seam.update(i.workflow_id, doc);
        return {
          text: `Updated ${updated.id} to version ${updated.version}.`,
          data: { workflow: updated },
          undo: {
            kind: "workflow",
            workflowId: updated.id,
            previous: { version: current.version, enabled: current.enabled },
          },
        };
      },
    };
  },
};

const enableWorkflow: ToolDefinition<{ workflow_id: string; enabled: boolean }> = {
  name: "enable_workflow",
  description:
    "Turn a Workflow on or off. Turning one on shows its Dry run and asks first while workflows.ask_before_enable is on. Reversible.",
  tier: "reversible",
  input: z.object({ workflow_id: z.string().min(1), enabled: z.boolean() }),
  summarize: (i) => `${i.workflow_id} ${i.enabled ? "on" : "off"}`,
  async run(i, ctx) {
    const seam = needWorkflows(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const current = await seam.get(i.workflow_id);
    if (!current) return { kind: "refused", text: `Workflow ${i.workflow_id} not found.` };
    if (current.enabled === i.enabled) {
      return { kind: "result", text: `Already ${i.enabled ? "enabled" : "disabled"}.`, data: null };
    }
    let preview = text(`${i.enabled ? "Enable" : "Disable"} "${current.name}"`);
    let count = 1;
    if (i.enabled && (await seam.askBeforeEnable())) {
      const dry = await seam.dryRun(i.workflow_id);
      preview = text(`Enable "${current.name}"?\n${dryRunText(dry)}`);
      // Above every preview threshold, so the card asks before enabling (ADR 0004: the Setting decides).
      count = Number.MAX_SAFE_INTEGER;
    }
    return {
      kind: "action",
      preview,
      count,
      apply: async () => {
        const updated = await seam.enable(i.workflow_id, i.enabled);
        return {
          text: `${updated.name} is now ${updated.enabled ? "enabled" : "disabled"}.`,
          data: { workflow: updated },
          undo: {
            kind: "workflow",
            workflowId: updated.id,
            previous: { version: current.version, enabled: current.enabled },
          },
        };
      },
    };
  },
};

const dryRunWorkflow: ToolDefinition<{ workflow_id: string; recent?: number | undefined }> = {
  name: "dry_run_workflow",
  description:
    "Run a Workflow over the last N matching Threads without applying anything, and report what it would have done.",
  tier: "read",
  input: z.object({ workflow_id: z.string().min(1), recent: z.int().min(1).max(200).optional() }),
  summarize: (i) => i.workflow_id,
  async run(i, ctx) {
    const seam = needWorkflows(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const preview = await seam.dryRun(i.workflow_id, i.recent);
    return { kind: "result", text: dryRunText(preview), data: preview };
  },
};

const listWorkflowRuns: ToolDefinition<{
  workflow_id?: string | undefined;
  status?: RunView["status"] | undefined;
}> = {
  name: "list_workflow_runs",
  description:
    "Recent Runs, newest first, with their status, steps and any Step waiting for approval.",
  tier: "read",
  input: z.object({
    workflow_id: z.string().min(1).optional(),
    status: z.enum(["queued", "running", "paused", "done", "failed"]).optional(),
  }),
  summarize: (i) => [i.workflow_id, i.status].filter(Boolean).join(" ") || "all",
  async run(i, ctx) {
    const seam = needWorkflows(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const runs = await seam.runs(ctx.host.workspaceId, {
      ...(i.workflow_id ? { workflowId: i.workflow_id } : {}),
      ...(i.status ? { status: i.status } : {}),
    });
    return {
      kind: "result",
      text: runs.length
        ? runs
            .map(
              (r) =>
                `${r.id} ${r.workflowId} v${r.version} ${r.status}${r.subject ? ` "${r.subject}"` : ""}: ${r.steps.map((s) => `${s.name} ${s.status}`).join(", ")}${r.waitingActivityId ? ` (waiting at step ${r.waitingStep})` : ""}`,
            )
            .join("\n")
        : "No runs.",
      data: { runs },
    };
  },
};

const approveWorkflowStep: ToolDefinition<{
  run_id: string;
  decision: "approved" | "declined";
  standing?: boolean | undefined;
}> = {
  name: "approve_workflow_step",
  description:
    "Answer a Workflow Run paused at a Step that asks. Shows that Step's exact payload and asks the user; `standing` also grants a Standing approval so the Step never asks again in this Workflow.",
  tier: "leaves_mailbox",
  input: z.object({
    run_id: z.string().min(1),
    decision: z.enum(["approved", "declined"]),
    standing: z.boolean().optional(),
  }),
  summarize: (i) => `${i.run_id} ${i.decision}${i.standing ? " (standing)" : ""}`,
  async run(i, ctx) {
    const seam = needWorkflows(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const run = await seam.run(i.run_id);
    if (!run) return { kind: "refused", text: `Run ${i.run_id} not found.` };
    if (run.status !== "paused" || run.waitingStep === null) {
      return { kind: "refused", text: `Run ${i.run_id} is not waiting for an approval.` };
    }
    const step = run.steps.find((s) => s.index === run.waitingStep);
    return {
      kind: "action",
      preview: text(
        `${i.decision === "approved" ? "Approve" : "Decline"} step "${step?.name ?? run.waitingStep}" of run ${run.id}${run.subject ? ` for "${run.subject}"` : ""}${i.standing ? ", and always allow it in this workflow" : ""}.\n${step?.detail ?? ""}`,
      ),
      count: 1,
      apply: async () => {
        const updated = await seam.decide(i.run_id, i.decision, {
          standing: i.standing === true,
        });
        return {
          text: `Run ${updated.id} ${i.decision}; it is now ${updated.status}.`,
          data: { run: updated },
          undo: null,
        };
      },
    };
  },
};

const runWorkflow: ToolDefinition<{ workflow_id: string; thread_id?: string | undefined }> = {
  name: "run_workflow",
  description:
    "Start a Run of a Workflow now, on a Thread when it is about one. Steps that leave the mailbox still ask.",
  tier: "reversible",
  input: z.object({ workflow_id: z.string().min(1), thread_id: z.string().min(1).optional() }),
  summarize: (i) => `${i.workflow_id}${i.thread_id ? ` on ${i.thread_id}` : ""}`,
  async run(i, ctx) {
    const seam = needWorkflows(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const current = await seam.get(i.workflow_id);
    if (!current) return { kind: "refused", text: `Workflow ${i.workflow_id} not found.` };
    return {
      kind: "action",
      preview: text(`Run "${current.name}" now${i.thread_id ? ` on thread ${i.thread_id}` : ""}`),
      count: 1,
      apply: async () => {
        const run = await seam.start(i.workflow_id, i.thread_id ?? null);
        return { text: `Run ${run.id} started (${run.status}).`, data: { run }, undo: null };
      },
    };
  },
};

export const EXTENSION_TOOLS: readonly ToolDefinition<never>[] = [
  postToSlack,
  postToDiscord,
  addNotionRow,
  saveToDrive,
  callWebhook,
  callMcpTool,
  listWorkflows,
  createWorkflow,
  updateWorkflow,
  enableWorkflow,
  dryRunWorkflow,
  listWorkflowRuns,
  approveWorkflowStep,
  runWorkflow,
] as unknown as readonly ToolDefinition<never>[];

/** The tool an integration Step of a Workflow maps to. */
export const INTEGRATION_TOOL: Record<(typeof INTEGRATIONS)[number], string> = {
  slack: "post_to_slack",
  discord: "post_to_discord",
  notion: "add_notion_row",
  drive: "save_to_drive",
  webhook: "call_webhook",
};
