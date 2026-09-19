// The Agent host (ADR 0002, ADR 0007, ADR 0009): the MCP tool server, the
// LangGraph loop over the Hosted runtime, Sessions and the Activity log
// behind one interface. A turn streams events to the caller as it runs and
// persists the transcript; a tool that asks pauses the turn at a checkpoint
// and the same Session resumes it with the user's decision. Everything
// below is reached through seams (ToolHost, ActivityLog, SessionStore, the
// checkpointer, the runtime) so the whole loop runs in a test without a
// network, and with or without Postgres.
//
// Slice 15: the Hosted loop sits behind the AgentSession seam, and a Session
// on a Local runtime (a CLI a Device drives) shares the same Sessions and
// Activity log. Its tool calls arrive over MCP (`call`), approvals wait in
// `resume` exactly as a Hosted interrupt does, and the tool cards reach the
// Device through `live`.

import { type BaseCheckpointSaver, MemorySaver } from "@langchain/langgraph";
import type {
  ActivityRecord,
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  Runtime,
  SessionStartContext,
  SessionSummary,
  ToolCall,
  ToolHost,
  TurnContext,
} from "@monday/shared";
import type { HostedRuntime } from "../runtime/index.ts";
import { type ActivityLog, type ActivityRow, publicActivity } from "./activity.ts";
import {
  type AgentGraph,
  BudgetExceededError,
  createAgentGraph,
  type InterruptPayload,
  type RunContext,
} from "./graph.ts";
import { createHostedSession, SessionNotFoundError, TurnBusyError } from "./session-runtime.ts";
import type { SessionStore } from "./sessions.ts";
import {
  createToolServer,
  type ToolExtensions,
  type ToolOutcome,
  type ToolServer,
} from "./tools/index.ts";

export type { ActivityLog, ActivityRow } from "./activity.ts";
export { createActivityLog, createMemoryActivityLog, publicActivity } from "./activity.ts";
export type { InterruptPayload } from "./graph.ts";
export { BudgetExceededError } from "./graph.ts";
export { createServerToolHost } from "./host.ts";
export { createMondayMcpServer, type McpContext, mcpResultOf } from "./mcp.ts";
export {
  createHostedSession,
  graphThreadId,
  SessionNotFoundError,
  TurnBusyError,
} from "./session-runtime.ts";
export type { SessionStore } from "./sessions.ts";
export { collapseEvents, createMemorySessionStore, createSessionStore } from "./sessions.ts";
export type {
  CalendarSeam,
  IntegrationsSeam,
  McpSeam,
  ToolExtensions,
  ToolOutcome,
  ToolServer,
  WorkflowsSeam,
} from "./tools/index.ts";
export { createToolServer, INTEGRATION_TOOL, TOOL_CATALOG } from "./tools/index.ts";

export interface AgentSettings {
  systemPrompt: string;
  previewAbove: number;
  alwaysAsk: string[];
  maxSteps: number;
  searchLimit: number;
  /** Whether the Agent may fetch web pages (ai.web_fetch). */
  webFetch?: boolean | undefined;
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
  /** The seams of the extension tools; filled after creation by the modules that need this host. */
  extensions?: ToolExtensions | undefined;
}

export interface TurnResult {
  /** The Activity row that waits for approval, when the turn paused. */
  waiting: string | null;
}

/** One agentic Step of a Workflow (ADR 0003): a LangGraph thread of its own under the Run. */
export interface StepRunInput {
  workspaceId: string;
  runId: string;
  /** The checkpoint thread id: unique per Step within the Run, stable across a resume. */
  key: string;
  system: string;
  prompt: string;
  /** Tool names the Step may call; null means every tool. */
  allow: readonly string[] | null;
  /** The Budget: tool calls, tokens, and the moment the Step must be done by. */
  maxToolCalls: number;
  maxTokens: number;
  deadline: number;
  /** A Standing approval answers "standing"; null pauses the Run at the interrupt. */
  approve(row: ActivityRow): Promise<"standing" | null>;
  onTool?: ((row: ActivityRow) => void) | undefined;
  /** Resumes the paused thread with the decision instead of starting a new one. */
  resume?: ApprovalDecision | undefined;
}

export interface StepRunResult {
  /** The model's final text; empty while interrupted. */
  text: string;
  interrupted: InterruptPayload | null;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
}

/** A turn was sent to the Server for a Session a Device's Local runtime drives. */
export class LocalSessionError extends Error {
  readonly status = 409;
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} runs on a Local runtime; its turns come from the Device`);
    this.name = "LocalSessionError";
  }
}

/** One tool call from a Local runtime, over an MCP transport. */
export interface LocalCall {
  workspaceId: string;
  sessionId: string | null;
  name: string;
  args: unknown;
  /** The CLI's own id for the call when it has one; generated otherwise. */
  callId?: string | undefined;
  pinned?: readonly string[] | undefined;
}

export interface AgentHost {
  /** A Session on the Hosted runtime by default, or on the Local runtime a Device names. */
  createSession(workspaceId: string, runtime?: Runtime): Promise<SessionSummary>;
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
  /** Moves the Session to another Runtime; the thread gets a line and the next turn hands the transcript over. */
  switchRuntime(sessionId: string, runtime: Runtime): Promise<AgentEvent>;
  /** A Device's Local runtime persists what its CLI said; tool cards come from `call`. */
  appendEvent(sessionId: string, event: AgentEvent): Promise<void>;
  /** Server-side events for a Session as they happen: the tool cards of MCP calls. */
  live(sessionId: string, listener: (event: AgentEvent) => void): () => void;
  /** One tool call from a Local runtime: tiers and approvals inside, the same Activity row. */
  call(input: LocalCall): Promise<ToolOutcome>;
  /** Everything a runtime needs before a turn on this Session. */
  startContext(sessionId: string, context: TurnContext): Promise<SessionStartContext>;
  listActivity(
    workspaceId: string,
    options?: { limit?: number; sessionId?: string },
  ): Promise<ActivityRecord[]>;
  /** Undo from a card or the Activity page; the Session, when given, gets the event. */
  undo(activityId: string, sessionId?: string | null): Promise<ActivityRecord>;
  /** The tool server for a Workspace, for the loopback MCP transports. */
  tools(workspaceId: string): ToolServer;
  /**
   * Runs one agentic Step through the same graph as a turn, with a tool
   * allowlist and the Budget enforced: over any cap throws BudgetExceededError.
   */
  runStep(input: StepRunInput): Promise<StepRunResult>;
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

/** How many times a transcript switched Runtime. */
export function epochOf(events: readonly AgentEvent[]): number {
  return events.filter((e) => e.kind === "runtime").length;
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const { runtime, activity, sessions } = options;
  const now = options.now ?? (() => new Date());
  const checkpointer = options.checkpointer ?? new MemorySaver();
  const toolServers = new Map<string, ToolServer>();
  const running = new Map<string, RunContext>();
  const hosted = new Map<string, { runtime: string; session: AgentSession }>();
  /** Approvals a Local runtime's tool call waits on, by Activity row. */
  const pending = new Map<string, (decision: ApprovalDecision) => void>();
  /** Decisions that arrived before the call registered its wait. */
  const decided = new Map<string, ApprovalDecision>();
  /** Who waits for a waiting row to move on, by Activity row. */
  const settled = new Map<string, Array<(row: ActivityRow) => void>>();
  const listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  const tools = (workspaceId: string): ToolServer => {
    let server = toolServers.get(workspaceId);
    if (!server) {
      server = createToolServer({
        host: options.hostFor(workspaceId),
        activity,
        now,
        extensions: options.extensions,
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
    contextFor: (threadId) => {
      const ctx = running.get(threadId);
      if (!ctx) throw new Error(`no run context for thread ${threadId}`);
      return ctx;
    },
  });

  const toolEvent = (row: ActivityRow): AgentEvent => ({
    kind: "tool",
    call: toolCallOf(row),
    preview: row.preview,
  });

  const publish = (sessionId: string, event: AgentEvent) => {
    for (const listener of listeners.get(sessionId) ?? []) listener(event);
  };

  const requireSession = async (id: string): Promise<SessionSummary> => {
    const session = await sessions.get(id);
    if (!session) throw new SessionNotFoundError(id);
    return session;
  };

  const startContext = async (
    session: SessionSummary,
    context: TurnContext,
  ): Promise<SessionStartContext> => {
    const transcript = await sessions.events(session.id);
    const settings = await options.settings();
    return {
      ...context,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      address: await options.workspaceAddress(session.workspaceId),
      epoch: epochOf(transcript),
      transcript,
      developerMode: false,
      webFetch: settings.webFetch ?? false,
    };
  };

  /** The Hosted AgentSession for a Session, recreated when its Runtime changed. */
  const hostedFor = (session: SessionSummary): AgentSession => {
    if (session.runtime.kind !== "hosted") throw new LocalSessionError(session.id);
    const key = JSON.stringify(session.runtime);
    const cached = hosted.get(session.id);
    if (cached && cached.runtime === key) return cached.session;
    const created = createHostedSession({
      session,
      graph,
      sessions,
      activity,
      tools: tools(session.workspaceId),
      settings: async () => {
        const s = await options.settings();
        return { systemPrompt: s.systemPrompt, maxSteps: s.maxSteps };
      },
      bind: (threadId, ctx) => {
        if (running.has(threadId)) throw new TurnBusyError(session.id);
        running.set(threadId, ctx);
        return () => running.delete(threadId);
      },
      toolEvent,
      now,
    });
    hosted.set(session.id, { runtime: key, session: created });
    return created;
  };

  /** A Local runtime's approval: answers the waiting call and streams the card as it moves on. */
  const resumeLocal = async (
    session: SessionSummary,
    activityId: string,
    decision: ApprovalDecision,
    onEvent: (event: AgentEvent) => void,
  ): Promise<TurnResult> => {
    const row = await activity.get(activityId);
    if (!row || row.sessionId !== session.id || row.status !== "waiting") {
      throw new SessionNotFoundError(activityId);
    }
    const moved = new Promise<ActivityRow>((resolve) => {
      settled.set(activityId, [...(settled.get(activityId) ?? []), resolve]);
    });
    const resolve = pending.get(activityId);
    if (resolve) {
      pending.delete(activityId);
      resolve(decision);
    } else {
      decided.set(activityId, decision);
    }
    const next = await moved;
    onEvent(toolEvent(next));
    onEvent({ kind: "done", id: crypto.randomUUID(), waiting: null });
    await sessions.touch(session.id);
    return { waiting: null };
  };

  return {
    tools,

    async runStep(input) {
      if (running.has(input.key)) throw new TurnBusyError(input.key);
      let tokens = 0;
      let text = "";
      running.set(input.key, {
        workspaceId: input.workspaceId,
        sessionId: input.key,
        runId: input.runId,
        system: input.system,
        pinned: [],
        // One model call per tool round plus the closing answer.
        maxSteps: input.maxToolCalls + 1,
        maxToolCalls: input.maxToolCalls,
        tools: tools(input.workspaceId),
        task: "agentic-step",
        allow: input.allow ?? undefined,
        onText: () => {},
        onAssistant: (answer) => {
          text = answer;
        },
        onTool: (row) => input.onTool?.(row),
        onUsage: (usage) => {
          tokens += usage.inputTokens + usage.outputTokens;
          if (tokens > input.maxTokens) throw new BudgetExceededError("tokens");
          if (now().getTime() > input.deadline) throw new BudgetExceededError("minutes");
        },
        approve: input.approve,
      });
      try {
        const result = input.resume
          ? await graph.resume(input.key, input.resume)
          : await graph.turn(input.key, input.prompt);
        const last = result.state.messages.at(-1);
        if (
          !result.interrupted &&
          last?.role === "assistant" &&
          last.toolCalls.length > 0 &&
          result.state.steps >= input.maxToolCalls + 1
        ) {
          throw new BudgetExceededError("calls");
        }
        return {
          text: result.interrupted ? "" : text || (last?.role === "assistant" ? last.content : ""),
          interrupted: result.interrupted,
          modelCalls: result.state.steps,
          toolCalls: result.state.toolCalls,
          tokens,
        };
      } finally {
        running.delete(input.key);
      }
    },

    async createSession(workspaceId, requested) {
      if (requested) return sessions.create(workspaceId, requested);
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
      const agent = hostedFor(session);
      await agent.start(await startContext(session, context));
      return agent.send(text, onEvent);
    },

    async resume(sessionId, activityId, decision, context, onEvent) {
      const session = await requireSession(sessionId);
      if (session.runtime.kind === "local") {
        return resumeLocal(session, activityId, decision, onEvent);
      }
      const agent = hostedFor(session);
      await agent.start(await startContext(session, context));
      return agent.resume(activityId, decision, onEvent);
    },

    async switchRuntime(sessionId, next) {
      const session = await requireSession(sessionId);
      await sessions.setRuntime(session.id, next);
      hosted.delete(session.id);
      const event: AgentEvent = { kind: "runtime", id: crypto.randomUUID(), runtime: next };
      await sessions.append(session.id, event);
      return event;
    },

    async appendEvent(sessionId, event) {
      const session = await requireSession(sessionId);
      if (event.kind === "delta") return;
      await sessions.append(session.id, event);
      await sessions.touch(
        session.id,
        event.kind === "user" ? event.text.slice(0, 120) : undefined,
      );
    },

    live(sessionId, listener) {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.set(sessionId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(sessionId);
      };
    },

    async call(input) {
      const server = tools(input.workspaceId);
      const sessionId = input.sessionId;
      const emit = (row: ActivityRow) => {
        const event = toolEvent(row);
        if (sessionId) {
          publish(sessionId, event);
          void sessions.append(sessionId, event);
        }
        if (row.status !== "waiting") {
          const waiters = settled.get(row.id);
          if (waiters) {
            settled.delete(row.id);
            for (const w of waiters) w(row);
          }
        }
      };
      return server.call(
        {
          name: input.name,
          args: input.args,
          callId: input.callId ?? crypto.randomUUID(),
          sessionId,
          pinned: input.pinned,
        },
        {
          ask: (row) => {
            const early = decided.get(row.id);
            if (early) {
              decided.delete(row.id);
              return Promise.resolve(early);
            }
            return new Promise<ApprovalDecision>((resolve) => pending.set(row.id, resolve));
          },
          onUpdate: emit,
        },
      );
    },

    async startContext(sessionId, context) {
      return startContext(await requireSession(sessionId), context);
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
