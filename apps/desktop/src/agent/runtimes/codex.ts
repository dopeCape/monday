// Codex as a Local runtime (docs/research/agent-cli-integration.md): the
// user's own `codex app-server`, JSON-RPC over stdio with the `jsonrpc`
// field omitted, one thread per Session with monday's MCP server in the
// thread's config and the built-ins stripped there: no shell tool, no
// unified exec, no apps, no browser or computer use, no web search, no
// image tools, a read-only sandbox so `apply_patch` (which has no switch)
// cannot write. Developer mode turns them back on with a full-access
// sandbox. Codex asks the client before running a non-read-only MCP tool
// (`mcpServer/elicitation/request` with `codex_approval_kind`); the adapter
// accepts, because the approval lives inside the tool (ADR 0002).
//
// Protocol (recorded from Codex 0.146.0 in fixtures/, schema from
// `codex app-server generate-json-schema`):
//   -> initialize {clientInfo}, initialized, thread/start {config, ...}, turn/start {threadId, input}
//   <- thread/started, turn/started, item/started, item/agentMessage/delta, item/completed,
//      turn/completed {turn.status}, mcpServer/elicitation/request (a request, answered by id)

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

/** The per-thread config overrides: monday's server, and every built-in off unless Developer mode. */
export function codexThreadConfig(
  mcp: { url: string; token: string },
  context: SessionStartContext,
): Record<string, unknown> {
  const developer = context.developerMode;
  return {
    mcp_servers: {
      monday: {
        url: mcp.url,
        http_headers: {
          Authorization: `Bearer ${mcp.token}`,
          "X-Monday-Workspace": context.workspaceId,
          "X-Monday-Session": context.sessionId,
          ...(context.pinned?.length ? { "X-Monday-Pinned": context.pinned.join(",") } : {}),
        },
        default_tools_approval_mode: "auto",
        startup_timeout_sec: 30,
      },
    },
    features: {
      shell_tool: developer,
      unified_exec: developer,
      apps: false,
      browser_use: false,
      computer_use: false,
      image_generation: false,
      in_app_browser: false,
      plugins: false,
      skill_search: false,
    },
    web_search: developer && context.webFetch ? "live" : "disabled",
    tools: { view_image: false },
  };
}

export function codexThreadStartParams(
  mcp: { url: string; token: string },
  context: SessionStartContext,
  systemPrompt: string,
  model: string,
): Record<string, unknown> {
  return {
    ephemeral: true,
    sandbox: context.developerMode ? "danger-full-access" : "read-only",
    approvalPolicy: "never",
    baseInstructions: systemPrompt,
    ...(model ? { model } : {}),
    config: codexThreadConfig(mcp, context),
  };
}

interface Rpc {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

interface Item {
  type: string;
  id: string;
  text?: string;
  server?: string;
  tool?: string;
  status?: string;
  arguments?: unknown;
  command?: string | string[];
  changes?: unknown;
  query?: string;
  error?: { message?: string } | null;
  result?: unknown;
  aggregatedOutput?: string;
  exitCode?: number | null;
}

export function createCodexSession(deps: LocalRuntimeDeps): AgentSession {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const label = CLI_LABEL.codex;
  let context: SessionStartContext | null = null;
  let process: Process | null = null;
  let relay: TurnRelay | null = null;
  let spawnedFor: { epoch: number; developerMode: boolean; webFetch: boolean } | null = null;
  let fresh = true;
  let model: string | null = null;
  let threadId = "";
  let turnId = "";
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();

  const write = async (message: Rpc) => {
    if (!process) throw new Error(`${label} was not started`);
    await process.write(`${JSON.stringify(message)}\n`);
  };

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      void write({ id, method, params }).catch(reject);
    });

  const builtinSummary = (item: Item): string => {
    if (item.type === "commandExecution") {
      return Array.isArray(item.command) ? item.command.join(" ") : (item.command ?? "");
    }
    if (item.type === "webSearch") return item.query ?? "";
    if (item.type === "fileChange") return summarizeInput(item.changes);
    return summarizeInput(item.arguments);
  };

  const onItem = (item: Item, done: boolean) => {
    const r = relay;
    if (!r) return;
    switch (item.type) {
      case "agentMessage":
        if (done && item.text) r.emit({ kind: "text", id: item.id, text: item.text });
        return;
      case "mcpToolCall":
        // monday's tools: the Server's card. Another server's tool is a Developer mode built-in.
        if (item.server === "monday") return;
        break;
      case "commandExecution":
      case "fileChange":
      case "webSearch":
      case "imageView":
        break;
      default:
        return;
    }
    const tool = item.type === "mcpToolCall" ? `${item.server}_${item.tool}` : item.type;
    const failed = item.status === "failed" || (item.exitCode !== undefined && item.exitCode !== 0);
    const result = done
      ? (item.error?.message ?? item.aggregatedOutput?.split("\n")[0]?.slice(0, 160) ?? "")
      : undefined;
    r.emit({
      kind: "tool",
      call: builtinCall(
        item.id,
        tool,
        builtinSummary(item),
        done ? (failed ? "failed" : "done") : "running",
        result,
      ),
      preview: null,
    });
  };

  const onLine = (raw: string) => {
    if (!raw.trim().startsWith("{")) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(raw) as Rpc;
    } catch {
      return;
    }
    // A response to one of ours.
    if (msg.id !== undefined && !msg.method) {
      const waiter = pending.get(Number(msg.id));
      if (waiter) {
        pending.delete(Number(msg.id));
        if (msg.error) waiter.reject(new Error(msg.error.message ?? "codex error"));
        else waiter.resolve(msg.result ?? {});
      }
      return;
    }
    // A request from the server: approvals belong to monday's tools, so an MCP elicitation
    // is accepted; anything else is declined because the built-ins are off.
    if (msg.id !== undefined && msg.method) {
      const meta = (msg.params?._meta ?? {}) as { codex_approval_kind?: string };
      if (
        msg.method === "mcpServer/elicitation/request" &&
        meta.codex_approval_kind === "mcp_tool_call"
      ) {
        void write({ id: msg.id, result: { action: "accept", content: {} } });
      } else if (msg.method === "mcpServer/elicitation/request") {
        void write({ id: msg.id, result: { action: "decline" } });
      } else if (msg.method?.endsWith("/requestApproval")) {
        void write({
          id: msg.id,
          result: { decision: context?.developerMode ? "accept" : "decline" },
        });
      } else {
        void write({
          id: msg.id,
          error: { code: -32601, message: `monday does not answer ${msg.method}` },
        });
      }
      return;
    }
    const r = relay;
    const params = msg.params ?? {};
    switch (msg.method) {
      case "item/agentMessage/delta":
        r?.emit({
          kind: "delta",
          id: String(params.itemId ?? ""),
          text: String(params.delta ?? ""),
        });
        return;
      case "item/started":
        onItem(params.item as Item, false);
        return;
      case "item/completed":
        onItem(params.item as Item, true);
        return;
      case "turn/completed": {
        if (!r) return;
        fresh = false;
        const turn = params.turn as
          | { status?: string; error?: { message?: string } | null }
          | undefined;
        if (turn?.status === "failed")
          r.fail(turn.error?.message ?? `${label} failed the turn.`, "failed");
        else if (turn?.status === "interrupted") r.fail(`${label} was interrupted.`, "interrupted");
        else r.end();
        return;
      }
      case "error":
        r?.fail(String((params as { message?: string }).message ?? `${label} error.`));
        return;
      default:
        return;
    }
  };

  const kill = async () => {
    const p = process;
    process = null;
    relay?.stop();
    relay = null;
    spawnedFor = null;
    threadId = "";
    for (const w of pending.values()) w.reject(new Error(`${label} stopped`));
    pending.clear();
    if (p) await p.kill();
  };

  const spawn = async (ctx: SessionStartContext) => {
    const settings = deps.settings();
    const target = spawnTarget("codex", settings.command);
    const spawned = await deps.runner(target.name, {
      args: ["app-server"],
      env: {},
      pathPrefix: target.pathPrefix,
    });
    process = spawned;
    relay = createTurnRelay(deps.link, ctx.sessionId, newId);
    spawnedFor = { epoch: ctx.epoch, developerMode: ctx.developerMode, webFetch: ctx.webFetch };
    fresh = true;
    model = null;
    spawned.onStdout(onLine);
    spawned.onStderr((line) => deps.log?.(`[codex] ${line}`));
    void spawned.exited.then((code) => {
      if (process !== spawned) return;
      process = null;
      spawnedFor = null;
      if (relay?.busy) relay.fail(`${label} exited (code ${code ?? "signal"}).`, "exited");
    });
    await request("initialize", { clientInfo: { name: "monday", version: "0.1.0" } });
    await write({ method: "initialized" });
    const system = `${settings.systemPrompt}\n\nWorkspace: ${ctx.address}. Today is ${(deps.now ?? (() => new Date()))().toISOString()}.`;
    const started = await request(
      "thread/start",
      codexThreadStartParams(deps.mcp, ctx, system, settings.model),
    );
    threadId = String((started.thread as { id?: string } | undefined)?.id ?? "");
    model = typeof started.model === "string" ? started.model : null;
    if (!threadId) throw new Error(`${label} did not start a thread`);
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
      try {
        await spawn(next);
      } catch (error) {
        // A CLI that spawned but never opened its session is not half-started: the
        // next turn spawns it again instead of talking to a session that is not there.
        await kill();
        throw error;
      }
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
      try {
        const started = await request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
        });
        turnId = String((started.turn as { id?: string } | undefined)?.id ?? "");
      } catch (error) {
        r.fail(error instanceof Error ? error.message : String(error));
      }
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
      if (process && threadId && turnId) {
        // A graceful interrupt first, briefly; the kill below ends an unresponsive CLI.
        await Promise.race([
          request("turn/interrupt", { threadId, turnId }).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      }
      await kill();
    },

    runtime() {
      return localRuntimeInfo("codex", model);
    },
  };
}
