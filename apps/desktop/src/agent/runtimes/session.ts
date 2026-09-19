// What the three Local adapters share (CONTEXT.md, Local runtime; ADR 0002):
// the settings and seams they are built over, and the relay that turns a
// CLI's stream plus the Server's live tool cards into one AgentSession
// turn. A turn ends when the CLI says its turn is over, or earlier when a
// monday tool asks: the card arrives over the live link with status
// waiting, the CLI itself is blocked inside the MCP call, and `resume`
// answers the card and keeps relaying until the next stop.

import type {
  AgentEvent,
  ApprovalDecision,
  LocalCli,
  RuntimeInfo,
  SessionStartContext,
  ToolCall,
  TurnContext,
  TurnOutcome,
} from "@monday/shared";
import { createLiveWatch, type SessionLink } from "./link.ts";
import type { ProcessRunner } from "./process.ts";

export const CLI_LABEL: Record<LocalCli, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** The Settings a Local runtime reads (docs/spec/settings.md, AI and agent). */
export interface LocalRuntimeSettings {
  /** ai.local.path.<cli>: a name on PATH or a full path. */
  command: string;
  /** ai.local.model.<cli>; empty means the CLI's default. */
  model: string;
  /** ai.local.tool_timeout_seconds. */
  toolTimeoutSeconds: number;
  /** agent.system_prompt. */
  systemPrompt: string;
}

/** Where monday's MCP server is for this Device: the Sidecar's loopback endpoint and its token. */
export interface McpEndpoint {
  url: string;
  token: string;
}

export interface LocalRuntimeDeps {
  runner: ProcessRunner;
  link: SessionLink;
  mcp: McpEndpoint;
  settings: () => LocalRuntimeSettings;
  now?: (() => Date) | undefined;
  /** Diagnostics from the CLI's stderr; the console in the app, a list in tests. */
  log?: ((line: string) => void) | undefined;
  /** Ids for events; random in the app, sequential in tests. */
  newId?: (() => string) | undefined;
  /** The directory a CLI that wants one is started in; the app's own by default. */
  cwd?: string | undefined;
}

/** The scope name and the binary for a command the capability allows (src-tauri/capabilities). */
export interface SpawnTarget {
  /** The scope name the platform spawns by. */
  name: string;
  /** The binary the scope runs; the Setting's override when it is a path. */
  pathPrefix: string | undefined;
}

/** Splits a Setting's command into the scope name and the directory to search first. */
export function spawnTarget(scopeName: string, command: string): SpawnTarget {
  const at = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  if (at < 0) return { name: scopeName, pathPrefix: undefined };
  return { name: scopeName, pathPrefix: command.slice(0, at) };
}

/** The relay between a CLI's stream, the Server's live cards and the turn in flight. */
export interface TurnRelay {
  /** Opens a turn: resolves when the CLI ends it or a tool asks. */
  begin(onEvent: (event: AgentEvent) => void): Promise<TurnOutcome>;
  /** Something the CLI said; persisted unless it is a delta. */
  emit(event: AgentEvent): void;
  /** The CLI ended its turn. */
  end(): void;
  /** The CLI failed; the turn ends with an error card. */
  fail(message: string, code?: string): void;
  /** Whether a turn is open. */
  readonly busy: boolean;
  stop(): void;
}

export function createTurnRelay(
  link: SessionLink,
  sessionId: string,
  newId: () => string,
): TurnRelay {
  let current: { onEvent: (e: AgentEvent) => void; resolve: (o: TurnOutcome) => void } | null =
    null;
  /** Events that arrived between turns; the next turn replays them first. */
  const buffered: AgentEvent[] = [];
  const watch = createLiveWatch(link, sessionId);

  const finish = (outcome: TurnOutcome) => {
    const turn = current;
    if (!turn) return;
    current = null;
    turn.onEvent({ kind: "done", id: newId(), waiting: outcome.waiting });
    turn.resolve(outcome);
  };

  const deliver = (event: AgentEvent) => {
    if (current) current.onEvent(event);
    else buffered.push(event);
    if (event.kind === "tool" && event.call.status === "waiting") {
      finish({ waiting: event.call.id });
    }
  };

  watch.onEvent(deliver);

  return {
    get busy() {
      return current !== null;
    },
    begin(onEvent) {
      return new Promise<TurnOutcome>((resolve) => {
        current = { onEvent, resolve };
        for (const event of buffered.splice(0)) deliver(event);
      });
    },
    emit(event) {
      if (event.kind !== "delta") void link.append(sessionId, event);
      deliver(event);
    },
    end() {
      finish({ waiting: null });
    },
    fail(message, code) {
      const event: AgentEvent = { kind: "error", id: newId(), message, ...(code ? { code } : {}) };
      void link.append(sessionId, event);
      deliver(event);
      finish({ waiting: null });
    },
    stop() {
      watch.stop();
      finish({ waiting: null });
    },
  };
}

/** The card for a Local runtime's own tool used in Developer mode; the composer marks it. */
export function builtinCall(
  id: string,
  tool: string,
  inputSummary: string,
  status: ToolCall["status"],
  result?: string,
): ToolCall {
  return {
    id,
    sessionId: null,
    runId: null,
    tool,
    tier: "always-ask",
    inputSummary,
    status,
    approvedBy: status === "waiting" ? null : "user",
    ...(result !== undefined ? { result } : {}),
    undoable: false,
    builtin: true,
  };
}

/** One line of a tool's input, for the card. */
export function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input.slice(0, 120);
  if (typeof input !== "object") return String(input);
  const record = input as Record<string, unknown>;
  const first = Object.entries(record)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`);
  return first.join(" · ");
}

/** The turn context the link's approve call carries. */
export function turnContextOf(context: SessionStartContext): TurnContext {
  return {
    ...(context.pinned !== undefined ? { pinned: context.pinned } : {}),
    ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
  };
}

export function localRuntimeInfo(cli: LocalCli, model: string | null): RuntimeInfo {
  return {
    runtime: { kind: "local", cli, ...(model ? { model } : {}) },
    model,
  };
}

export type { ApprovalDecision };
