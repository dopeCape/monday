// The Hosted runtime behind the AgentSession seam (ADR 0007, slice 15): one
// Session's turns over the LangGraph loop, translating what the graph does
// into the events the composer streams and the transcript keeps. The three
// Local adapters on a Device implement the same seam over their CLI, so the
// host treats every runtime alike. A Runtime switch mid-Session starts a new
// epoch: the graph gets a fresh thread and the first turn carries the
// transcript so far as context, so tool calls already made are not repeated.

import type {
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  SessionStartContext,
  SessionSummary,
  TurnOutcome,
} from "@monday/shared";
import { withHandover } from "@monday/shared";
import type { ActivityLog, ActivityRow } from "./activity.ts";
import type { AgentGraph, RunContext } from "./graph.ts";
import type { SessionStore } from "./sessions.ts";
import type { ToolServer } from "./tools/index.ts";

export interface HostedSessionSettings {
  systemPrompt: string;
  maxSteps: number;
}

export interface HostedSessionOptions {
  session: SessionSummary;
  graph: AgentGraph;
  sessions: SessionStore;
  activity: ActivityLog;
  tools: ToolServer;
  settings(): Promise<HostedSessionSettings>;
  /** Makes the run context visible to the graph's nodes for the duration of a turn. */
  bind(threadId: string, context: RunContext): () => void;
  /** The card for an Activity row, as the host renders it. */
  toolEvent(row: ActivityRow): AgentEvent;
  now(): Date;
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

/** The graph thread a Session runs on: its id, suffixed once it switched Runtime. */
export function graphThreadId(sessionId: string, epoch: number): string {
  return epoch === 0 ? sessionId : `${sessionId}#${epoch}`;
}

export function createHostedSession(options: HostedSessionOptions): AgentSession {
  const { session, graph, sessions, activity, tools } = options;
  let context: SessionStartContext | null = null;
  let busy = false;

  const threadId = () => graphThreadId(session.id, context?.epoch ?? 0);

  /** Drives the graph for one turn or resume, translating what happens into events. */
  const drive = async (
    onEvent: (event: AgentEvent) => void,
    run: () => Promise<Awaited<ReturnType<AgentGraph["turn"]>>>,
  ): Promise<TurnOutcome> => {
    if (busy) throw new TurnBusyError(session.id);
    busy = true;
    const emit = (event: AgentEvent) => {
      onEvent(event);
      if (event.kind !== "delta") void sessions.append(session.id, event);
    };
    const settings = await options.settings();
    const ctx = context;
    if (!ctx) throw new Error(`session ${session.id} was not started`);
    let textId = crypto.randomUUID();
    const unbind = options.bind(threadId(), {
      workspaceId: session.workspaceId,
      sessionId: session.id,
      system: `${settings.systemPrompt}\n\nWorkspace: ${ctx.address}. Today is ${options.now().toISOString()}.`,
      pinned: ctx.pinned ?? [],
      maxSteps: settings.maxSteps,
      tools,
      onText: (delta) => onEvent({ kind: "delta", id: textId, text: delta }),
      onAssistant: (text) => {
        emit({ kind: "text", id: textId, text });
        textId = crypto.randomUUID();
      },
      onTool: (row) => emit(options.toolEvent(row)),
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
      unbind();
      busy = false;
      await sessions.touch(session.id);
    }
  };

  return {
    async start(next) {
      context = next;
    },

    async send(text, onEvent) {
      const ctx = context;
      if (!ctx) throw new Error(`session ${session.id} was not started`);
      const userEvent: AgentEvent = { kind: "user", id: crypto.randomUUID(), text };
      onEvent(userEvent);
      await sessions.append(session.id, userEvent);
      await sessions.touch(session.id, text.slice(0, 120));
      // A new epoch's first turn carries the transcript the previous runtime produced.
      const fresh = ctx.epoch > 0 && (await graph.messages(threadId())).length === 0;
      const prompt = fresh ? withHandover(text, ctx.transcript) : text;
      return drive(onEvent, () => graph.turn(threadId(), prompt));
    },

    async resume(activityId, decision: ApprovalDecision, onEvent) {
      const row = await activity.get(activityId);
      if (!row || row.sessionId !== session.id || row.status !== "waiting") {
        throw new SessionNotFoundError(activityId);
      }
      return drive(onEvent, () => graph.resume(threadId(), decision));
    },

    async cancel() {
      // The Hosted loop runs one model step at a time and pauses only inside a tool;
      // there is no process to kill. The next turn simply is not sent.
    },

    runtime() {
      return {
        runtime: session.runtime,
        model: session.runtime.kind === "hosted" ? session.runtime.model : null,
      };
    },
  };
}
