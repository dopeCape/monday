// OpenCode as a Local runtime (docs/research/agent-cli-integration.md): the
// user's own `opencode acp`, the Agent Client Protocol v1 over stdio, which
// OpenCode speaks natively. monday's MCP server is passed in `session/new`
// (ACP's one way to hand an agent tools) and the built-ins are stripped
// twice: OPENCODE_CONFIG_CONTENT denies every tool but monday's, and any
// `session/request_permission` for a tool that is not monday's is rejected
// unless the Session is in Developer mode. A permission request for one of
// monday's tools is allowed at once: the approval lives inside the tool.
//
// Protocol (from the ACP v1 schema and OpenCode's docs; OpenCode was not
// installed on the machine that wrote fixtures/opencode.acp.jsonl):
//   -> initialize, session/new {cwd, mcpServers}, session/prompt {sessionId, prompt}
//   <- session/update {update.sessionUpdate: agent_message_chunk | tool_call | tool_call_update}
//      session/request_permission (a request, answered by id), the prompt's result {stopReason}

import type {
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  SessionStartContext,
  TurnOutcome,
} from "@monday/shared";
import { withHandover } from "@monday/shared";
import type { Process } from "./process.ts";
import {
  builtinCall,
  CLI_LABEL,
  createTurnRelay,
  type LocalRuntimeDeps,
  localRuntimeInfo,
  spawnTarget,
  summarizeInput,
  type TurnRelay,
  turnContextOf,
} from "./session.ts";

export const OPENCODE_TOOL_PREFIX = "monday_";

/** OpenCode's config for the process: monday's server, every other tool denied unless Developer mode. */
export function opencodeConfig(
  mcp: { url: string; token: string },
  context: SessionStartContext,
  model: string,
): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    ...(model ? { model } : {}),
    mcp: {
      monday: {
        type: "remote",
        url: mcp.url,
        enabled: true,
        headers: {
          Authorization: `Bearer ${mcp.token}`,
          "X-Monday-Workspace": context.workspaceId,
          "X-Monday-Session": context.sessionId,
          ...(context.pinned?.length ? { "X-Monday-Pinned": context.pinned.join(",") } : {}),
        },
        timeout: 3_600_000,
      },
    },
    permission: context.developerMode
      ? { "*": "allow", ...(context.webFetch ? {} : { webfetch: "deny", websearch: "deny" }) }
      : { "*": "deny", [`${OPENCODE_TOOL_PREFIX}*`]: "allow" },
  };
}

/** The MCP server as ACP's session/new lists it. */
export function acpMcpServers(mcp: { url: string; token: string }, context: SessionStartContext) {
  return [
    {
      type: "http",
      name: "monday",
      url: mcp.url,
      headers: [
        { name: "Authorization", value: `Bearer ${mcp.token}` },
        { name: "X-Monday-Workspace", value: context.workspaceId },
        { name: "X-Monday-Session", value: context.sessionId },
        ...(context.pinned?.length
          ? [{ name: "X-Monday-Pinned", value: context.pinned.join(",") }]
          : []),
      ],
    },
  ];
}

interface Rpc {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

interface Update {
  sessionUpdate: string;
  content?: { type: string; text?: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export function createOpencodeSession(deps: LocalRuntimeDeps): AgentSession {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const label = CLI_LABEL.opencode;
  let context: SessionStartContext | null = null;
  let process: Process | null = null;
  let relay: TurnRelay | null = null;
  let spawnedFor: { epoch: number; developerMode: boolean; webFetch: boolean } | null = null;
  let fresh = true;
  let model: string | null = null;
  let acpSessionId = "";
  let nextId = 1;
  let textId = "";
  const pending = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  const tools = new Map<string, { title: string; summary: string }>();

  const write = async (message: Rpc) => {
    if (!process) throw new Error(`${label} was not started`);
    await process.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      void write({ id, method, params }).catch(reject);
    });

  const isMonday = (title: string | undefined) => (title ?? "").startsWith(OPENCODE_TOOL_PREFIX);

  /** The streamed text so far; it lands as one text event when a tool call or the turn ends it. */
  let streamed = "";
  const flushText = () => {
    if (streamed && relay) relay.emit({ kind: "text", id: textId || newId(), text: streamed });
    streamed = "";
    textId = "";
  };

  const onUpdate = (update: Update) => {
    const r = relay;
    if (!r) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.type === "text" ? (update.content.text ?? "") : "";
        if (!text) return;
        if (!textId) textId = newId();
        streamed += text;
        r.emit({ kind: "delta", id: textId, text });
        return;
      }
      case "tool_call": {
        flushText();
        if (!update.toolCallId || isMonday(update.title)) return;
        const summary = summarizeInput(update.rawInput);
        tools.set(update.toolCallId, { title: update.title ?? update.kind ?? "tool", summary });
        r.emit({
          kind: "tool",
          call: builtinCall(update.toolCallId, update.title ?? "tool", summary, "running"),
          preview: null,
        });
        return;
      }
      case "tool_call_update": {
        const known = update.toolCallId ? tools.get(update.toolCallId) : undefined;
        if (!known || !update.toolCallId) return;
        if (update.status !== "completed" && update.status !== "failed") return;
        tools.delete(update.toolCallId);
        r.emit({
          kind: "tool",
          call: builtinCall(
            update.toolCallId,
            known.title,
            known.summary,
            update.status === "failed" ? "failed" : "done",
            summarizeInput(update.rawOutput),
          ),
          preview: null,
        });
        return;
      }
      default:
        return;
    }
  };

  const onLine = (raw: string) => {
    if (!raw.trim().startsWith("{")) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(raw) as Rpc;
    } catch {
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const waiter = pending.get(Number(msg.id));
      if (waiter) {
        pending.delete(Number(msg.id));
        if (msg.error) waiter.reject(new Error(msg.error.message ?? "opencode error"));
        else waiter.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.id !== undefined && msg.method === "session/request_permission") {
      const params = msg.params as {
        toolCall?: { title?: string };
        options?: Array<{ optionId: string; kind: string }>;
      };
      const allow = isMonday(params.toolCall?.title) || context?.developerMode === true;
      const wanted = allow ? "allow_once" : "reject_once";
      const option = params.options?.find((o) => o.kind === wanted) ?? params.options?.[0];
      void write({
        id: msg.id,
        result: option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    if (msg.id !== undefined && msg.method) {
      void write({
        id: msg.id,
        error: { code: -32601, message: `monday does not answer ${msg.method}` },
      });
      return;
    }
    if (msg.method === "session/update") {
      const update = (msg.params as { update?: Update } | undefined)?.update;
      if (update) onUpdate(update);
    }
  };

  const kill = async () => {
    const p = process;
    process = null;
    relay?.stop();
    relay = null;
    spawnedFor = null;
    acpSessionId = "";
    for (const w of pending.values()) w.reject(new Error(`${label} stopped`));
    pending.clear();
    if (p) await p.kill();
  };

  const spawn = async (ctx: SessionStartContext) => {
    const settings = deps.settings();
    const target = spawnTarget("opencode", settings.command);
    const spawned = await deps.runner(target.name, {
      args: ["acp"],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(deps.mcp, ctx, settings.model)),
      },
      pathPrefix: target.pathPrefix,
    });
    process = spawned;
    relay = createTurnRelay(deps.link, ctx.sessionId, newId);
    spawnedFor = { epoch: ctx.epoch, developerMode: ctx.developerMode, webFetch: ctx.webFetch };
    fresh = true;
    model = settings.model || null;
    spawned.onStdout(onLine);
    spawned.onStderr((line) => deps.log?.(`[opencode] ${line}`));
    void spawned.exited.then((code) => {
      if (process !== spawned) return;
      process = null;
      spawnedFor = null;
      if (relay?.busy) relay.fail(`${label} exited (code ${code ?? "signal"}).`, "exited");
    });
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "monday", version: "0.1.0" },
    });
    const created = await request("session/new", {
      cwd: deps.cwd ?? ".",
      mcpServers: acpMcpServers(deps.mcp, ctx),
    });
    acpSessionId = String(created.sessionId ?? "");
    const models = created.models as { currentModelId?: string } | undefined;
    if (models?.currentModelId) model = models.currentModelId;
    if (!acpSessionId) throw new Error(`${label} did not open a session`);
  };

  return {
    async start(next) {
      context = next;
      const same =
        spawnedFor &&
        spawnedFor.epoch === next.epoch &&
        spawnedFor.developerMode === next.developerMode &&
        spawnedFor.webFetch === next.webFetch;
      if (process && same) return;
      await kill();
      await spawn(next);
    },

    async send(text, onEvent): Promise<TurnOutcome> {
      const ctx = context;
      const r = relay;
      if (!ctx || !process || !r) throw new Error(`${label} was not started`);
      const user: AgentEvent = { kind: "user", id: newId(), text };
      onEvent(user);
      await deps.link.append(ctx.sessionId, user);
      const prompt = fresh && ctx.transcript.length > 0 ? withHandover(text, ctx.transcript) : text;
      const outcome = r.begin(onEvent);
      void request("session/prompt", {
        sessionId: acpSessionId,
        prompt: [{ type: "text", text: prompt }],
      })
        .then((result) => {
          fresh = false;
          flushText();
          const stop = String(result.stopReason ?? "end_turn");
          if (stop === "end_turn" || stop === "max_turn_requests") relay?.end();
          else relay?.fail(`${label} stopped: ${stop}.`, stop);
        })
        .catch((error: unknown) => {
          flushText();
          relay?.fail(error instanceof Error ? error.message : String(error));
        });
      return outcome;
    },

    async resume(activityId, decision: ApprovalDecision, onEvent): Promise<TurnOutcome> {
      const ctx = context;
      const r = relay;
      if (!ctx || !r) throw new Error(`${label} was not started`);
      const outcome = r.begin(onEvent);
      try {
        await deps.link.approve(ctx.sessionId, activityId, decision, turnContextOf(ctx), () => {});
      } catch (error) {
        r.fail(error instanceof Error ? error.message : String(error));
      }
      return outcome;
    },

    async cancel() {
      if (process && acpSessionId) {
        await write({ method: "session/cancel", params: { sessionId: acpSessionId } }).catch(
          () => {},
        );
      }
      await kill();
    },

    runtime() {
      return localRuntimeInfo("opencode", model);
    },
  };
}
