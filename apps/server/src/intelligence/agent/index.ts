// The Agent host (ADR 0002, ADR 0007, ADR 0009): the MCP tool server, the
// LangGraph loop over the Hosted runtime, Sessions and the Activity log
// behind one interface. A turn streams events to the caller as it runs and
// persists the transcript; a tool that asks pauses the turn at a checkpoint
// and the same Session resumes it with the user's decision. Everything
// below is reached through seams (ToolHost, ActivityLog, SessionStore, the
// checkpointer, the runtime) so the whole loop runs in a test without a
// network, and with or without Postgres.

import { type BaseCheckpointSaver, MemorySaver } from "@langchain/langgraph";
import type {
  ActivityRecord,
  AgentEvent,
  ApprovalDecision,
  SessionSummary,
  ToolCall,
  ToolHost,
  TurnContext,
} from "@monday/shared";
import type { HostedRuntime } from "../runtime/index.ts";
import { type ActivityLog, type ActivityRow, publicActivity } from "./activity.ts";
import { type AgentGraph, createAgentGraph, type RunContext } from "./graph.ts";
import type { SessionStore } from "./sessions.ts";
import { createToolServer, type ToolServer } from "./tools/index.ts";

export type { ActivityLog, ActivityRow } from "./activity.ts";
export { createActivityLog, createMemoryActivityLog, publicActivity } from "./activity.ts";
export { createServerToolHost } from "./host.ts";
export type { SessionStore } from "./sessions.ts";
export { collapseEvents, createMemorySessionStore, createSessionStore } from "./sessions.ts";
export type { ToolServer } from "./tools/index.ts";
export { createToolServer, TOOL_CATALOG } from "./tools/index.ts";

export interface AgentSettings {
  systemPrompt: string;
  previewAbove: number;
  alwaysAsk: string[];
  maxSteps: number;
  searchLimit: number;
}

export interface AgentHostOptions {
  runtime: HostedRuntime;
  activity: ActivityLog;
  sessions: SessionStore;
  /** The ToolHost for a Workspace: Postgres on the Server, the Store on a Device. */
  hostFor(workspaceId: string): ToolHost;
  settings(): Promise<AgentSettings>;
  /** The Workspace's address, appended to the system prompt. */
  workspaceAddress(workspaceId: string): Promise<string>;
  /** LangGraph's checkpointer; PostgresSaver in production, memory by default. */
  checkpointer?: BaseCheckpointSaver;
  now?: () => Date;
}

export interface TurnResult {
  /** The Activity row that waits for approval, when the turn paused. */
  waiting: string | null;
}

export class SessionNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} not found`);
    this.name = "SessionNotFoundError";
  }
}

export class TurnBusyError extends Error {
  readonly status = 409;
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} is already running a turn`);
    this.name = "TurnBusyError";
  }
}

export interface AgentHost {
  createSession(workspaceId: string): Promise<SessionSummary>;
  listSessions(workspaceId: string): Promise<SessionSummary[]>;
  getSession(id: string): Promise<{ session: SessionSummary; events: AgentEvent[] } | null>;
  /** Runs one user turn, streaming events, until the model stops or a tool asks. */
  turn(
    sessionId: string,
    text: string,
    context: TurnContext,
    onEvent: (event: AgentEvent) => void,
  ): Promise<TurnResult>;
  /** Answers a waiting tool call and runs on from there. */
  resume(
    sessionId: string,
    activityId: string,
    decision: ApprovalDecision,
    context: TurnContext,
    onEvent: (event: AgentEvent) => void,
  ): Promise<TurnResult>;
  listActivity(
    workspaceId: string,
    options?: { limit?: number; sessionId?: string },
  ): Promise<ActivityRecord[]>;
  /** Undo from a card or the Activity page; the Session, when given, gets the event. */
  undo(activityId: string, sessionId?: string | null): Promise<ActivityRecord>;
  /** The tool server for a Workspace, for the loopback MCP transports. */
  tools(workspaceId: string): ToolServer;
}

/** The card the composer renders for an Activity row. */
export function toolCallOf(row: ActivityRow): ToolCall {
  const {
    workspaceId: _w,
    actor: _a,
    callId: _c,
    input: _i,
    preview: _p,
    decision,
    at: _t,
    undo: _u,
    resultText: _rt,
    resultData: _r,
    ...call
  } = row;
  return {
    ...call,
    approvedBy: decision === "approved" ? "user" : null,
    ...(decision === "declined" ? { declined: true } : {}),
  };
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const { runtime, activity, sessions } = options;
  const now = options.now ?? (() => new Date());
  const checkpointer = options.checkpointer ?? new MemorySaver();
  const toolServers = new Map<string, ToolServer>();
  const running = new Map<string, RunContext>();

  const tools = (workspaceId: string): ToolServer => {
    let server = toolServers.get(workspaceId);
    if (!server) {
      server = createToolServer({
        host: options.hostFor(workspaceId),
        activity,
        now,
        settings: async () => {
          const s = await options.settings();
          return {
            previewAbove: s.previewAbove,
            alwaysAsk: s.alwaysAsk,
            searchLimit: s.searchLimit,
          };
        },
      });
      toolServers.set(workspaceId, server);
    }
    return server;
  };

  const graph: AgentGraph = createAgentGraph({
    runtime,
    checkpointer,
    contextFor: (sessionId) => {
      const ctx = running.get(sessionId);
      if (!ctx) throw new Error(`no run context for session ${sessionId}`);
      return ctx;
    },
  });

  const toolEvent = (row: ActivityRow): AgentEvent => ({
    kind: "tool",
    call: toolCallOf(row),
    preview: row.preview,
  });

  /** Drives the graph for one turn or resume, translating what happens into events. */
  const drive = async (
    session: SessionSummary,
    context: TurnContext,
    onEvent: (event: AgentEvent) => void,
    run: () => Promise<Awaited<ReturnType<AgentGraph["turn"]>>>,
  ): Promise<TurnResult> => {
    if (running.has(session.id)) throw new TurnBusyError(session.id);
    const emit = (event: AgentEvent) => {
      onEvent(event);
      if (event.kind !== "delta") void sessions.append(session.id, event);
    };
    const settings = await options.settings();
    const address = await options.workspaceAddress(session.workspaceId);
    let textId = crypto.randomUUID();
    running.set(session.id, {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      system: `${settings.systemPrompt}\n\nWorkspace: ${address}. Today is ${now().toISOString()}.`,
      pinned: context.pinned ?? [],
      maxSteps: settings.maxSteps,
      tools: tools(session.workspaceId),
      onText: (delta) => onEvent({ kind: "delta", id: textId, text: delta }),
      onAssistant: (text) => {
        emit({ kind: "text", id: textId, text });
        textId = crypto.randomUUID();
      },
      onTool: (row) => emit(toolEvent(row)),
    });
    const doneId = crypto.randomUUID();
    try {
      const result = await run();
      const waiting = result.interrupted?.activityId ?? null;
      if (!waiting && result.state.steps >= settings.maxSteps) {
        const last = result.state.messages.at(-1);
        if (last?.role !== "assistant" || last.toolCalls.length > 0) {
          emit({
            kind: "text",
            id: crypto.randomUUID(),
            text: `Stopped after ${settings.maxSteps} steps. Ask me to continue if you want more.`,
          });
        }
      }
      emit({ kind: "done", id: doneId, waiting });
      return { waiting };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof Error && "provider" in error && error.name === "NoProviderKeyError"
          ? "no_shared_key"
          : undefined;
      emit({ kind: "error", id: doneId, message, ...(code ? { code } : {}) });
      emit({ kind: "done", id: crypto.randomUUID(), waiting: null });
      return { waiting: null };
    } finally {
      running.delete(session.id);
      await sessions.touch(session.id);
    }
  };

  const requireSession = async (id: string): Promise<SessionSummary> => {
    const session = await sessions.get(id);
    if (!session) throw new SessionNotFoundError(id);
    return session;
  };

  return {
    tools,

    async createSession(workspaceId) {
      const choice = await runtime.resolve("composer");
      return sessions.create(workspaceId, {
        kind: "hosted",
        provider: choice.provider,
        model: choice.model,
      });
    },

    listSessions: (workspaceId) => sessions.list(workspaceId),

    async getSession(id) {
      const session = await sessions.get(id);
      if (!session) return null;
      return { session, events: await sessions.events(id) };
    },

    async turn(sessionId, text, context, onEvent) {
      const session = await requireSession(sessionId);
      const userEvent: AgentEvent = { kind: "user", id: crypto.randomUUID(), text };
      onEvent(userEvent);
      await sessions.append(session.id, userEvent);
      await sessions.touch(session.id, text.slice(0, 120));
      return drive(session, context, onEvent, () => graph.turn(session.id, text));
    },

    async resume(sessionId, activityId, decision, context, onEvent) {
      const session = await requireSession(sessionId);
      const row = await activity.get(activityId);
      if (!row || row.sessionId !== session.id || row.status !== "waiting") {
        throw new SessionNotFoundError(activityId);
      }
      return drive(session, context, onEvent, () => graph.resume(session.id, decision));
    },

    async listActivity(workspaceId, opts) {
      const rows = await activity.list(workspaceId, opts);
      return rows.map(publicActivity);
    },

    async undo(activityId, sessionId = null) {
      const target = await activity.get(activityId);
      const workspaceId = target?.workspaceId;
      if (!workspaceId) throw new SessionNotFoundError(activityId);
      const outcome = await tools(workspaceId).undo(activityId, sessionId);
      if (sessionId) {
        const undone = await activity.get(activityId);
        if (undone) await sessions.append(sessionId, toolEvent(undone));
        await sessions.append(sessionId, toolEvent(outcome.activity));
      }
      return publicActivity(outcome.activity);
    },
  };
}
