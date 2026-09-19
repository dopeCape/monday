// The MCP tool server (ADR 0002): one catalog, exposed in-process to the
// LangGraph loop now and over stdio and streamable HTTP for the Local
// runtimes and external MCP later (slices 15 and 19). Approvals live here,
// inside call(): a tool above the free tier, or a reversible batch above the
// preview threshold, asks through `ask` before it applies. Every call is a
// row in the Activity log from the moment it starts, and a call id already
// finished is answered from that row rather than run again, which is what
// keeps a re-executed LangGraph node from applying twice.

import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalDecision, Tier, ToolHost, ToolPreview, UndoRecord } from "@monday/shared";
import { tierOf } from "@monday/shared";
import { z } from "zod";
import type { ToolSpec } from "../../runtime/index.ts";
import type { ActivityLog, ActivityRow } from "../activity.ts";
import { findTool, TOOL_CATALOG, type ToolContext, type ToolSettings } from "./catalog.ts";
import type { ToolExtensions } from "./extensions.ts";

export type { ToolDefinition, ToolPlan, ToolSettings } from "./catalog.ts";
export { TOOL_CATALOG } from "./catalog.ts";
export type {
  ExternalSeam,
  IntegrationsSeam,
  McpSeam,
  ToolExtensions,
  WorkflowsSeam,
} from "./extensions.ts";
export { INTEGRATION_TOOL } from "./extensions.ts";

export interface ToolCallRequest {
  name: string;
  args: unknown;
  /** The model's id for the call; the ledger key within the Session. */
  callId: string;
  sessionId: string | null;
  /** The Workflow Run a Step calls under; the ledger key beside callId when there is no Session. */
  runId?: string | null | undefined;
  /** Setting keys the calling Device pins. */
  pinned?: readonly string[] | undefined;
  /** An external MCP caller (slice 19): named on the Activity row as its actor. */
  actor?: { kind: "external"; name: string } | undefined;
  /** A lower cap on search results than the Agent's Setting, for external callers. */
  searchLimit?: number | undefined;
}

export interface ToolCallContext {
  /**
   * Shows the preview and waits for the user. In the LangGraph loop this is
   * an interrupt; a Workflow Step with a Standing approval answers "standing".
   */
  ask(row: ActivityRow, preview: ToolPreview): Promise<ApprovalDecision | "standing">;
  /** Every change to the call's Activity row, so a transport can stream the card. */
  onUpdate?: ((row: ActivityRow) => void) | undefined;
}

export interface ToolOutcome {
  activity: ActivityRow;
  /** What the model reads back. */
  text: string;
  isError: boolean;
}

/** What a tool would do, without doing it: a Dry run reads these. */
export type ToolPreviewOutcome =
  | { kind: "result"; text: string }
  | { kind: "refused"; text: string }
  | { kind: "action"; preview: ToolPreview; count: number; asks: boolean };

export interface ToolServer {
  /** The tools as the model sees them. */
  specs(): ToolSpec[];
  /** The tools as an MCP client lists them. */
  mcpTools(): McpTool[];
  /** The Tier a tool runs at now, promotions included. */
  tierOf(name: string): Promise<Tier | null>;
  call(request: ToolCallRequest, ctx: ToolCallContext): Promise<ToolOutcome>;
  /** Plans a call and reports the preview without applying it or writing the Activity log. */
  preview(request: Pick<ToolCallRequest, "name" | "args" | "pinned">): Promise<ToolPreviewOutcome>;
  /** Replays an Activity row's undo record and marks it undone. */
  undo(activityId: string, sessionId?: string | null): Promise<ToolOutcome>;
}

export interface ToolServerOptions {
  host: ToolHost;
  activity: ActivityLog;
  settings: () => Promise<ToolSettings>;
  now?: () => Date;
  /**
   * The seams the extension tools act through. Read at call time, so a
   * module created after the tool server (the Workflows module, which needs
   * the Agent host) can fill its slot later.
   */
  extensions?: ToolExtensions | undefined;
}

/** JSON Schema for a tool input, in the object shape MCP requires. */
export function inputSchemaOf(schema: z.ZodType): McpTool["inputSchema"] {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
  const { $schema: _s, ...rest } = json;
  return { ...rest, type: "object" } as McpTool["inputSchema"];
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createToolServer(options: ToolServerOptions): ToolServer {
  const { host, activity } = options;
  const now = options.now ?? (() => new Date());

  const specs = (): ToolSpec[] =>
    TOOL_CATALOG.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: inputSchemaOf(t.input),
    }));

  const asks = (name: string, settings: ToolSettings): boolean => {
    const tool = findTool(name);
    if (!tool) return false;
    return (
      tool.tier === "leaves_mailbox" ||
      tool.tier === "destructive" ||
      settings.alwaysAsk.includes(name)
    );
  };

  const context = (
    pinned: readonly string[],
    settings: ToolSettings,
    sessionId: string | null,
  ): ToolContext => ({
    host,
    pinned: new Set(pinned),
    settings,
    now,
    latestUndoable: async () => {
      const row =
        (await activity.latestUndoable(host.workspaceId, sessionId)) ??
        (await activity.latestUndoable(host.workspaceId));
      return row ? { id: row.id, tool: row.tool, undo: row.undo } : null;
    },
    undoActivity: async (id) => {
      const outcome = await server.undo(id, sessionId);
      return { text: outcome.text };
    },
    extensions: options.extensions,
  });

  const finish = async (
    row: ActivityRow,
    patch: Parameters<ActivityLog["update"]>[1],
    ctx: ToolCallContext,
  ): Promise<ActivityRow> => {
    const updated = await activity.update(row.id, patch);
    ctx.onUpdate?.(updated);
    return updated;
  };

  const server: ToolServer = {
    specs,

    mcpTools() {
      return TOOL_CATALOG.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: inputSchemaOf(t.input),
        annotations: {
          readOnlyHint: t.tier === "read",
          destructiveHint: t.tier === "destructive" || t.tier === "leaves_mailbox",
          idempotentHint: t.tier === "read",
          openWorldHint: t.tier === "leaves_mailbox",
        },
        _meta: { tier: t.tier },
      }));
    },

    async tierOf(name) {
      const tool = findTool(name);
      if (!tool) return null;
      return asks(name, await options.settings()) ? "always-ask" : tierOf(tool.tier);
    },

    async preview(request) {
      const settings = await options.settings();
      const tool = findTool(request.name);
      if (!tool) return { kind: "refused", text: `Unknown tool "${request.name}".` };
      const parsed = tool.input.safeParse(request.args ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`)
          .join("; ");
        return { kind: "refused", text: `Invalid input: ${issues}` };
      }
      const plan = await tool.run(parsed.data, context(request.pinned ?? [], settings, null));
      if (plan.kind === "result") return { kind: "result", text: plan.text };
      if (plan.kind === "refused") return { kind: "refused", text: plan.text };
      return {
        kind: "action",
        preview: plan.preview,
        count: plan.count,
        asks: asks(tool.name, settings) || plan.count > settings.previewAbove,
      };
    },

    async call(request, ctx) {
      const base = await options.settings();
      const settings: ToolSettings =
        request.searchLimit !== undefined
          ? { ...base, searchLimit: Math.min(base.searchLimit, request.searchLimit) }
          : base;
      const existing = request.sessionId
        ? await activity.findCall(request.sessionId, request.callId)
        : request.runId
          ? await activity.findRunCall(request.runId, request.callId)
          : null;
      if (existing && existing.status !== "waiting" && existing.status !== "running") {
        return {
          activity: existing,
          text: existing.resultText ?? "",
          isError: existing.status === "failed",
        };
      }
      const tool = findTool(request.name);
      const start = async (fields: {
        tier: Tier;
        input: Record<string, unknown>;
        summary: string;
        status: ActivityRow["status"];
        preview?: ToolPreview | null;
      }): Promise<ActivityRow> => {
        if (existing) {
          return finish(
            existing,
            { status: fields.status, summary: fields.summary, preview: fields.preview ?? null },
            ctx,
          );
        }
        const row = await activity.start({
          workspaceId: host.workspaceId,
          sessionId: request.sessionId,
          runId: request.runId ?? null,
          callId: request.callId,
          tool: request.name,
          tier: fields.tier,
          input: fields.input,
          summary: fields.summary,
          preview: fields.preview ?? null,
          status: fields.status,
          decision: null,
          actor: request.actor,
        });
        ctx.onUpdate?.(row);
        return row;
      };
      const fail = async (row: ActivityRow, text: string): Promise<ToolOutcome> => ({
        activity: await finish(row, { status: "failed", resultText: text }, ctx),
        text,
        isError: true,
      });

      const args =
        request.args && typeof request.args === "object"
          ? (request.args as Record<string, unknown>)
          : {};
      if (!tool) {
        const row = await start({ tier: "read-only", input: args, summary: "", status: "running" });
        return fail(row, `Unknown tool "${request.name}".`);
      }
      const tier: Tier = asks(tool.name, settings) ? "always-ask" : tierOf(tool.tier);
      if (typeof args.__invalid === "string") {
        const row = await start({ tier, input: args, summary: "", status: "running" });
        return fail(row, `The arguments did not parse: ${args.__invalid}`);
      }
      const parsed = tool.input.safeParse(args);
      if (!parsed.success) {
        const row = await start({ tier, input: args, summary: "", status: "running" });
        const issues = parsed.error.issues
          .map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`)
          .join("; ");
        return fail(row, `Invalid input: ${issues}`);
      }
      const input = parsed.data;
      const summary = tool.summarize(input);
      const row = await start({ tier, input: args, summary, status: "running" });

      let plan: Awaited<ReturnType<typeof tool.run>>;
      try {
        plan = await tool.run(input, context(request.pinned ?? [], settings, request.sessionId));
      } catch (error) {
        return fail(row, error instanceof Error ? error.message : String(error));
      }
      if (plan.kind === "result") {
        const done = await finish(
          row,
          { status: "done", decision: "auto", resultText: plan.text, result: plan.data },
          ctx,
        );
        return { activity: done, text: plan.text, isError: false };
      }
      if (plan.kind === "refused") return fail(row, plan.text);

      const needsApproval = tier === "always-ask" || plan.count > settings.previewAbove;
      let decision: ApprovalDecision | "auto" | "standing" = "auto";
      if (needsApproval) {
        const waiting = await finish(row, { status: "waiting", preview: plan.preview }, ctx);
        decision = await ctx.ask(waiting, plan.preview);
        if (decision === "declined") {
          const text = "Declined by the user; nothing changed. Do not retry this action.";
          const done = await finish(
            waiting,
            { status: "done", decision: "declined", resultText: text, result: null },
            ctx,
          );
          return { activity: done, text, isError: false };
        }
      }
      try {
        const running = needsApproval
          ? await finish(row, { status: "running", decision, preview: plan.preview }, ctx)
          : row;
        const applied = await plan.apply();
        const done = await finish(
          running,
          {
            status: "done",
            decision,
            preview: plan.preview,
            resultText: applied.text,
            result: applied.data,
            undo: applied.undo,
          },
          ctx,
        );
        return { activity: done, text: applied.text, isError: false };
      } catch (error) {
        return fail(row, error instanceof Error ? error.message : String(error));
      }
    },

    async undo(activityId, sessionId = null) {
      const target = await activity.get(activityId);
      const record = (): Promise<ActivityRow> =>
        activity.start({
          workspaceId: host.workspaceId,
          sessionId,
          callId: null,
          tool: "undo",
          tier: "reversible",
          input: { activity_id: activityId },
          summary: target ? `${target.tool}: ${target.inputSummary}` : activityId,
          preview: null,
          status: "running",
          decision: "auto",
        });
      if (!target?.undo) {
        const row = await activity.update((await record()).id, {
          status: "failed",
          resultText: "Nothing to undo for that action.",
        });
        return { activity: row, text: row.resultText ?? "", isError: true };
      }
      if (target.undoneAt) {
        const row = await activity.update((await record()).id, {
          status: "failed",
          resultText: "That action was already undone.",
        });
        return { activity: row, text: row.resultText ?? "", isError: true };
      }
      const text = await replayUndo(host, target.undo, options.extensions);
      await activity.update(target.id, { undoneAt: now().toISOString() });
      const row = await activity.update((await record()).id, {
        status: "done",
        resultText: text,
        result: { undid: target.id },
      });
      return { activity: row, text, isError: false };
    },
  };
  return server;
}

/** Applies an undo record through the host; the wording is what the card and the model read. */
export async function replayUndo(
  host: ToolHost,
  undo: UndoRecord,
  extensions?: ToolExtensions | undefined,
): Promise<string> {
  switch (undo.kind) {
    case "intents": {
      const { applied } = await host.applyIntents(undo.intents, { actor: "user" });
      return `Undone: ${applied} of ${undo.intents.length} thread${undo.intents.length === 1 ? "" : "s"} restored.`;
    }
    case "settings": {
      for (const entry of undo.entries) await host.writeSetting(entry.key, entry.previous);
      return `Undone: ${undo.entries.map((e) => `${e.key} back to ${stringify(e.previous)}`).join("; ")}.`;
    }
    case "draft":
      await host.deleteDraft(undo.draftId);
      return "Undone: the Draft was deleted.";
    case "send": {
      const result = await host.cancelSend(undo.sendId);
      return result.applied
        ? "Undone: the send was cancelled and the Draft reopened."
        : "Too late to undo: the message has already been sent.";
    }
    case "workflow": {
      const workflows = extensions?.workflows;
      if (!workflows) return "Cannot undo: workflows are not available from this host.";
      if (!undo.previous) {
        await workflows.remove(undo.workflowId);
        return "Undone: the workflow was deleted.";
      }
      const current = await workflows.get(undo.workflowId);
      if (!current) return "Cannot undo: the workflow no longer exists.";
      if (current.version !== undo.previous.version) {
        await workflows.revert(undo.workflowId, undo.previous.version);
      }
      if (current.enabled !== undo.previous.enabled) {
        await workflows.enable(undo.workflowId, undo.previous.enabled);
      }
      return `Undone: the workflow is back at version ${undo.previous.version}, ${undo.previous.enabled ? "enabled" : "disabled"}.`;
    }
    case "external_key": {
      const external = extensions?.external;
      if (!external) return "Cannot undo: external access is not available from this host.";
      const revoked = await external.revoke(undo.credentialId);
      return revoked
        ? "Undone: the key was revoked."
        : "Nothing to undo: the key was already revoked.";
    }
  }
}
