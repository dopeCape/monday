// The composer's seam to the Agent host (docs/spec/agent-composer.md): one
// Session at a time, turns that stream events, approvals that resume a
// paused turn, Undo from a card. The Server implementation talks to the
// routes over the Api; the fake scripts a turn's events so the composer is
// tested without a Server.

import type {
  ActivityRecord,
  AgentEvent,
  ApprovalDecision,
  Id,
  SessionSummary,
  ToolCall,
  ToolPreview,
  TurnContext,
} from "@monday/shared";
import type { Api } from "../platform/api.ts";

export interface AgentClient {
  listSessions(workspaceId: Id): Promise<SessionSummary[]>;
  createSession(workspaceId: Id): Promise<SessionSummary>;
  load(sessionId: Id): Promise<{ session: SessionSummary; events: AgentEvent[] }>;
  /** Streams the turn's events; resolves when the turn ends or pauses for an approval. */
  turn(
    sessionId: Id,
    text: string,
    context: TurnContext,
    onEvent: (event: AgentEvent) => void,
  ): Promise<void>;
  approve(
    sessionId: Id,
    activityId: Id,
    decision: ApprovalDecision,
    context: TurnContext,
    onEvent: (event: AgentEvent) => void,
  ): Promise<void>;
  undo(activityId: Id, sessionId: Id | null): Promise<ActivityRecord>;
}

export function apiAgentClient(api: Api): AgentClient {
  return {
    listSessions: async (workspaceId) => (await api.agent.sessions(workspaceId)).sessions,
    createSession: (workspaceId) => api.agent.createSession(workspaceId),
    load: (sessionId) => api.agent.session(sessionId),
    turn: (sessionId, text, context, onEvent) => api.agent.turn(sessionId, text, context, onEvent),
    approve: (sessionId, activityId, decision, context, onEvent) =>
      api.agent.approve(sessionId, activityId, decision, context, onEvent),
    undo: (activityId, sessionId) => api.agent.undo(activityId, sessionId),
  };
}

/* ------------------------------ Fake ------------------------------ */

/** What the fake answers a user turn with: events, in order, after the user echo. */
export type FakeTurn = (text: string, context: TurnContext) => AgentEvent[];

export interface FakeAgentClientOptions {
  workspaceId?: string;
  /** Scripts, consumed one per turn; past the end the fake answers with a one-line text. */
  turns?: FakeTurn[];
  /** What an approval streams; defaults to the card as done, then done. */
  onApprove?: (call: ToolCall, decision: ApprovalDecision) => AgentEvent[];
  now?: () => Date;
}

export interface FakeAgentClient extends AgentClient {
  /** Every turn text sent, with its context. */
  sent: Array<{ sessionId: Id; text: string; context: TurnContext }>;
  approvals: Array<{ sessionId: Id; activityId: Id; decision: ApprovalDecision }>;
  undos: Id[];
  sessions: SessionSummary[];
}

let fakeSeq = 0;

/** A tool card event, the shape the fake and tests share. */
export function toolEvent(
  call: Partial<ToolCall> & Pick<ToolCall, "id" | "tool">,
  preview: ToolPreview | null = null,
): AgentEvent {
  return {
    kind: "tool",
    call: {
      sessionId: null,
      runId: null,
      tier: "read-only",
      inputSummary: "",
      status: "done",
      approvedBy: null,
      undoable: false,
      ...call,
    },
    preview,
  };
}

export function fakeAgentClient(options: FakeAgentClientOptions = {}): FakeAgentClient {
  const now = options.now ?? (() => new Date());
  const turns = [...(options.turns ?? [])];
  const transcripts = new Map<Id, AgentEvent[]>();
  const sessions: SessionSummary[] = [];
  const sent: FakeAgentClient["sent"] = [];
  const approvals: FakeAgentClient["approvals"] = [];
  const undos: Id[] = [];
  const waitingCalls = new Map<Id, ToolCall>();

  const record = (sessionId: Id, events: AgentEvent[], onEvent: (e: AgentEvent) => void) => {
    const transcript = transcripts.get(sessionId) ?? [];
    for (const event of events) {
      onEvent(event);
      if (event.kind === "tool" && event.call.status === "waiting") {
        waitingCalls.set(event.call.id, event.call);
      }
      if (event.kind !== "delta") transcript.push(event);
    }
    transcripts.set(sessionId, transcript);
  };

  return {
    sent,
    approvals,
    undos,
    sessions,
    async listSessions(workspaceId) {
      return sessions.filter((s) => s.workspaceId === workspaceId);
    },
    async createSession(workspaceId) {
      const session: SessionSummary = {
        id: `session-${++fakeSeq}`,
        workspaceId,
        runtime: { kind: "hosted", provider: "anthropic", model: "claude-sonnet-5" },
        title: "",
        startedAt: now().toISOString(),
        lastActivity: now().toISOString(),
      };
      sessions.unshift(session);
      transcripts.set(session.id, []);
      return session;
    },
    async load(sessionId) {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) throw new Error(`session ${sessionId} not found`);
      return { session, events: [...(transcripts.get(sessionId) ?? [])] };
    },
    async turn(sessionId, text, context, onEvent) {
      sent.push({ sessionId, text, context });
      const session = sessions.find((s) => s.id === sessionId);
      if (session && !session.title) session.title = text;
      const script = turns.shift();
      const events = script
        ? script(text, context)
        : [{ kind: "text" as const, id: `t-${++fakeSeq}`, text: `You said: ${text}` }];
      const waiting = [...events]
        .reverse()
        .find((e) => e.kind === "tool" && e.call.status === "waiting");
      record(
        sessionId,
        [
          { kind: "user", id: `u-${++fakeSeq}`, text },
          ...events,
          {
            kind: "done",
            id: `d-${++fakeSeq}`,
            waiting: waiting && waiting.kind === "tool" ? waiting.call.id : null,
          },
        ],
        onEvent,
      );
    },
    async approve(sessionId, activityId, decision, _context, onEvent) {
      approvals.push({ sessionId, activityId, decision });
      const call = waitingCalls.get(activityId);
      if (!call) throw new Error(`no waiting call ${activityId}`);
      waitingCalls.delete(activityId);
      const events = options.onApprove
        ? options.onApprove(call, decision)
        : decision === "approved"
          ? [
              toolEvent({
                ...call,
                status: "done",
                approvedBy: "user",
                undoable: true,
                result: "Applied",
              }),
              { kind: "text" as const, id: `t-${++fakeSeq}`, text: "Done." },
            ]
          : [
              toolEvent({ ...call, status: "done", approvedBy: null, undoable: false }),
              { kind: "text" as const, id: `t-${++fakeSeq}`, text: "Left as is." },
            ];
      record(
        sessionId,
        [...events, { kind: "done", id: `d-${++fakeSeq}`, waiting: null }],
        onEvent,
      );
    },
    async undo(activityId) {
      undos.push(activityId);
      return {
        id: `undo-${++fakeSeq}`,
        workspaceId: options.workspaceId ?? "ws",
        sessionId: null,
        runId: null,
        tool: "undo",
        tier: "reversible",
        inputSummary: activityId,
        status: "done",
        approvedBy: null,
        result: "Undone",
        undoable: false,
        undoneAt: null,
        actor: "user",
        callId: null,
        input: null,
        preview: null,
        decision: "auto",
        at: now().toISOString(),
      };
    },
  };
}
