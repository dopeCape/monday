// Claude Code as a Local runtime (docs/research/agent-cli-integration.md):
// the user's own installed `claude` in print mode with stream-json in and
// out, monday's MCP server registered over loopback and every built-in tool
// removed (`--tools ""`, `--strict-mcp-config`, `--setting-sources ""`)
// unless the Session is in Developer mode. The argument shape is the one the
// Tauri capability allows; the model, when the Setting names one, travels in
// ANTHROPIC_MODEL so the shape never changes. monday never touches the
// CLI's login: the binary reads its own credentials.
//
// Stream format (recorded from Claude Code 2.1.223 in fixtures/):
//   system/init                 model, tools, mcp_servers with status
//   stream_event                raw API deltas (content_block_start, content_block_delta, ...)
//   assistant                   one message per completed content block (text or tool_use)
//   user                        tool results
//   result                      subtype success or error_*, is_error, result text

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

/** Built-ins Developer mode allows without a prompt; web tools only when web fetch is on. */
const DEVELOPER_TOOLS = ["Bash", "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "Agent"];
const WEB_TOOLS = ["WebFetch", "WebSearch"];

export const MONDAY_TOOL_PREFIX = "mcp__monday__";

/** The MCP config the CLI is handed: monday's loopback server with the Device token and who is calling. */
export function mcpConfigFor(
  mcp: { url: string; token: string },
  context: Pick<SessionStartContext, "workspaceId" | "sessionId" | "pinned">,
): string {
  return JSON.stringify({
    mcpServers: {
      monday: {
        type: "http",
        url: mcp.url,
        headers: {
          Authorization: `Bearer ${mcp.token}`,
          "X-Monday-Workspace": context.workspaceId,
          "X-Monday-Session": context.sessionId,
          ...(context.pinned?.length ? { "X-Monday-Pinned": context.pinned.join(",") } : {}),
        },
      },
    },
  });
}

/** The exact argument list, in the shape the capability's scope validates. */
export function claudeArgs(
  context: SessionStartContext,
  mcp: { url: string; token: string },
  systemPrompt: string,
  sessionId: string,
): string[] {
  const allowed = context.developerMode
    ? ["mcp__monday", ...DEVELOPER_TOOLS, ...(context.webFetch ? WEB_TOOLS : [])]
    : ["mcp__monday"];
  return [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigFor(mcp, context),
    "--setting-sources",
    "",
    "--permission-mode",
    context.developerMode ? "acceptEdits" : "dontAsk",
    "--allowedTools",
    allowed.join(","),
    "--tools",
    context.developerMode ? "default" : "",
    "--system-prompt",
    systemPrompt,
    "--session-id",
    sessionId,
    "--no-session-persistence",
  ];
}

/** One line the CLI reads: a user turn in stream-json. */
export function userLine(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

interface StreamLine {
  type: string;
  subtype?: string;
  model?: string;
  mcp_servers?: Array<{ name: string; status: string }>;
  event?: {
    type: string;
    index?: number;
    message?: { id: string };
    content_block?: { type: string };
    delta?: { type: string; text?: string };
  };
  message?: {
    id?: string;
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
  is_error?: boolean;
  result?: string;
}

/** Text of a tool_result block, whatever shape it came in. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : ""))
      .join("");
  }
  return "";
}

export function createClaudeCodeSession(deps: LocalRuntimeDeps): AgentSession {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  let context: SessionStartContext | null = null;
  let process: Process | null = null;
  let relay: TurnRelay | null = null;
  let spawnedFor: { epoch: number; developerMode: boolean; webFetch: boolean } | null = null;
  let fresh = true;
  let model: string | null = null;
  /** Why the CLI cannot serve turns, learned from its init line. */
  let startupError: string | null = null;
  let messageId = "";
  /** Text block ids per API message, in order started; how many of them got their final text. */
  const textBlocks = new Map<string, string[]>();
  const finalized = new Map<string, number>();
  /** Developer mode tool calls in flight, by tool_use id. */
  const builtins = new Map<string, { tool: string; summary: string }>();

  const label = CLI_LABEL["claude-code"];

  const onLine = (raw: string) => {
    if (!raw.trim().startsWith("{")) return;
    let line: StreamLine;
    try {
      line = JSON.parse(raw) as StreamLine;
    } catch {
      return;
    }
    const r = relay;
    switch (line.type) {
      case "system": {
        if (line.subtype === "init") {
          model = line.model ?? model;
          const status = line.mcp_servers?.find((s) => s.name === "monday")?.status ?? "missing";
          if (status !== "connected") {
            startupError = `${label} could not reach monday's tools (${status}).`;
            if (r?.busy) r.fail(startupError, "mcp_unreachable");
          }
        }
        return;
      }
      case "stream_event": {
        const event = line.event;
        if (!event || !r) return;
        if (event.type === "message_start" && event.message?.id) {
          messageId = event.message.id;
          textBlocks.set(messageId, []);
          finalized.set(messageId, 0);
        } else if (event.type === "content_block_start" && event.content_block?.type === "text") {
          const id = `${messageId}:${event.index ?? 0}`;
          textBlocks.get(messageId)?.push(id);
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          r.emit({
            kind: "delta",
            id: `${messageId}:${event.index ?? 0}`,
            text: event.delta.text ?? "",
          });
        }
        return;
      }
      case "assistant": {
        const msg = line.message;
        if (!msg || !r) return;
        const id = msg.id ?? messageId;
        for (const block of msg.content ?? []) {
          if (block.type === "text") {
            const n = finalized.get(id) ?? 0;
            const textId = textBlocks.get(id)?.[n] ?? `${id}:${n}`;
            finalized.set(id, n + 1);
            if (block.text) r.emit({ kind: "text", id: textId, text: block.text });
          } else if (block.type === "tool_use" && block.name && block.id) {
            if (block.name.startsWith(MONDAY_TOOL_PREFIX)) continue; // the Server's card
            const summary = summarizeInput(block.input);
            builtins.set(block.id, { tool: block.name, summary });
            r.emit({
              kind: "tool",
              call: builtinCall(block.id, block.name, summary, "running"),
              preview: null,
            });
          }
        }
        return;
      }
      case "user": {
        if (!r) return;
        for (const block of line.message?.content ?? []) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const known = builtins.get(block.tool_use_id);
          if (!known) continue;
          builtins.delete(block.tool_use_id);
          const text = resultText(block.content).split("\n")[0]?.slice(0, 160) ?? "";
          r.emit({
            kind: "tool",
            call: builtinCall(
              block.tool_use_id,
              known.tool,
              known.summary,
              block.is_error ? "failed" : "done",
              text,
            ),
            preview: null,
          });
        }
        return;
      }
      case "result": {
        if (!r) return;
        fresh = false;
        if (line.is_error || (line.subtype && line.subtype !== "success")) {
          r.fail(line.result || `${label} stopped: ${line.subtype ?? "error"}.`, line.subtype);
        } else {
          r.end();
        }
        return;
      }
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
    if (p) await p.kill();
  };

  const spawn = async (ctx: SessionStartContext) => {
    const settings = deps.settings();
    const target = spawnTarget("claude", settings.command);
    const env: Record<string, string> = {
      MCP_TOOL_TIMEOUT: String(settings.toolTimeoutSeconds * 1000),
      MCP_TIMEOUT: "30000",
      ...(settings.model ? { ANTHROPIC_MODEL: settings.model } : {}),
    };
    const system = `${settings.systemPrompt}\n\nWorkspace: ${ctx.address}. Today is ${(deps.now ?? (() => new Date()))().toISOString()}.`;
    const spawned = await deps.runner(target.name, {
      args: claudeArgs(ctx, deps.mcp, system, crypto.randomUUID()),
      env,
      pathPrefix: target.pathPrefix,
    });
    process = spawned;
    relay = createTurnRelay(deps.link, ctx.sessionId, newId);
    spawnedFor = { epoch: ctx.epoch, developerMode: ctx.developerMode, webFetch: ctx.webFetch };
    fresh = true;
    model = null;
    startupError = null;
    spawned.onStdout(onLine);
    spawned.onStderr((line) => deps.log?.(`[claude] ${line}`));
    void spawned.exited.then((code) => {
      if (process !== spawned) return;
      process = null;
      spawnedFor = null;
      if (relay?.busy) relay.fail(`${label} exited (code ${code ?? "signal"}).`, "exited");
    });
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
      const p = process;
      const r = relay;
      if (!ctx || !p || !r) throw new Error(`${label} was not started`);
      const user: AgentEvent = { kind: "user", id: newId(), text };
      onEvent(user);
      await deps.link.append(ctx.sessionId, user);
      const prompt = fresh && ctx.transcript.length > 0 ? withHandover(text, ctx.transcript) : text;
      const outcome = r.begin(onEvent);
      if (startupError) {
        r.fail(startupError, "mcp_unreachable");
        return outcome;
      }
      try {
        await p.write(userLine(prompt));
      } catch (error) {
        r.fail(error instanceof Error ? error.message : String(error));
      }
      return outcome;
    },

    async resume(activityId, decision: ApprovalDecision, onEvent): Promise<TurnOutcome> {
      const ctx = context;
      const r = relay;
      if (!ctx || !r) throw new Error(`${label} was not started`);
      // Open the next stretch of the turn before answering, so nothing the CLI says is missed;
      // the card's own updates arrive over the live link.
      const outcome = r.begin(onEvent);
      try {
        await deps.link.approve(ctx.sessionId, activityId, decision, turnContextOf(ctx), () => {});
      } catch (error) {
        r.fail(error instanceof Error ? error.message : String(error));
      }
      return outcome;
    },

    async cancel() {
      await kill();
    },

    runtime() {
      return localRuntimeInfo("claude-code", model);
    },
  };
}
