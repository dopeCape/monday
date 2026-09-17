// The agent loop (ADR 0007): a ReAct-style LangGraph over the Hosted
// runtime's conversational seam with monday's tools bound. Two nodes: the
// model step, and the tools step that runs every call through the tool
// server. An approval is a LangGraph interrupt raised inside the tool
// server's `ask`, so the checkpoint holds the paused turn and a resume with
// the decision continues exactly there. A node re-executes on resume; the
// tool server's ledger keeps a finished call from running twice.
//
// The per-run pieces that cannot live in a checkpoint (event listeners, the
// Device's pinned keys) are looked up by the Session id the graph runs under.

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import {
  Annotation,
  Command,
  END,
  interrupt,
  isInterrupted,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { ApprovalDecision, ToolPreview } from "@monday/shared";
import type { AgentMessage, HostedRuntime } from "../runtime/index.ts";
import type { ActivityRow } from "./activity.ts";
import type { ToolServer } from "./tools/index.ts";

export const AgentState = Annotation.Root({
  messages: Annotation<AgentMessage[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  /** Model calls made in the current turn; reset to 0 by each new user turn. */
  steps: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
});

export type AgentStateType = typeof AgentState.State;

/** What an interrupt carries to the transport: which call waits, and the preview. */
export interface InterruptPayload {
  activityId: string;
  callId: string;
  tool: string;
  preview: ToolPreview;
}

/** Everything a run needs that is not graph state. */
export interface RunContext {
  workspaceId: string;
  sessionId: string;
  system: string;
  pinned: readonly string[];
  maxSteps: number;
  tools: ToolServer;
  onText(delta: string): void;
  onAssistant(text: string): void;
  onTool(row: ActivityRow): void;
}

export interface AgentGraphOptions {
  runtime: HostedRuntime;
  checkpointer: BaseCheckpointSaver;
  /** The run context for a Session id, set by the host for the duration of a turn. */
  contextFor(sessionId: string): RunContext;
}

export interface GraphRun {
  interrupted: InterruptPayload | null;
  state: AgentStateType;
}

export interface AgentGraph {
  /** Starts a turn with a user message; runs until the model stops or a tool asks. */
  turn(sessionId: string, text: string): Promise<GraphRun>;
  /** Resumes a paused turn with the user's decision. */
  resume(sessionId: string, decision: ApprovalDecision): Promise<GraphRun>;
  /** The transcript the checkpoint holds for a Session. */
  messages(sessionId: string): Promise<AgentMessage[]>;
}

function lastAssistant(state: AgentStateType) {
  const last = state.messages.at(-1);
  return last?.role === "assistant" ? last : null;
}

export function createAgentGraph(options: AgentGraphOptions): AgentGraph {
  const { runtime } = options;

  const sessionOf = (config: { configurable?: Record<string, unknown> | undefined }): string => {
    const id = config.configurable?.thread_id;
    if (typeof id !== "string") throw new Error("graph run without a thread_id");
    return id;
  };

  const graph = new StateGraph(AgentState)
    .addNode("model", async (state, config) => {
      const ctx = options.contextFor(sessionOf(config));
      const result = await runtime.converse(
        "composer",
        {
          system: ctx.system,
          messages: state.messages,
          tools: ctx.tools.specs(),
          onText: ctx.onText,
        },
        { workspaceId: ctx.workspaceId },
      );
      if (result.text) ctx.onAssistant(result.text);
      const message: AgentMessage = {
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls,
      };
      return { messages: [message], steps: state.steps + 1 };
    })
    .addNode("tools", async (state, config) => {
      const ctx = options.contextFor(sessionOf(config));
      const assistant = lastAssistant(state);
      if (!assistant) return { messages: [] };
      const results: AgentMessage[] = [];
      for (const call of assistant.toolCalls) {
        const outcome = await ctx.tools.call(
          {
            name: call.name,
            args: call.args,
            callId: call.id,
            sessionId: ctx.sessionId,
            pinned: ctx.pinned,
          },
          {
            ask: async (row, preview) => {
              const payload: InterruptPayload = {
                activityId: row.id,
                callId: call.id,
                tool: row.tool,
                preview,
              };
              return interrupt<InterruptPayload, ApprovalDecision>(payload);
            },
            onUpdate: ctx.onTool,
          },
        );
        results.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: outcome.text,
          ...(outcome.isError ? { isError: true } : {}),
        });
      }
      return { messages: results };
    })
    .addEdge(START, "model")
    .addConditionalEdges("model", (state) =>
      (lastAssistant(state)?.toolCalls.length ?? 0) > 0 ? "tools" : END,
    )
    .addConditionalEdges("tools", (state, config) =>
      state.steps < options.contextFor(sessionOf(config)).maxSteps ? "model" : END,
    )
    .compile({ checkpointer: options.checkpointer });

  const configFor = (sessionId: string) => ({ configurable: { thread_id: sessionId } });

  const finish = (result: unknown, state: AgentStateType): GraphRun => {
    if (isInterrupted<InterruptPayload>(result)) {
      const first = result.__interrupt__[0];
      if (first) return { interrupted: first.value as InterruptPayload, state };
    }
    return { interrupted: null, state };
  };

  return {
    async turn(sessionId, text) {
      const user: AgentMessage = { role: "user", content: text };
      const result = await graph.invoke({ messages: [user], steps: 0 }, configFor(sessionId));
      return finish(result, result as AgentStateType);
    },

    async resume(sessionId, decision) {
      const result = await graph.invoke(new Command({ resume: decision }), configFor(sessionId));
      return finish(result, result as AgentStateType);
    },

    async messages(sessionId) {
      const snapshot = await graph.getState(configFor(sessionId));
      return (snapshot.values as Partial<AgentStateType>).messages ?? [];
    },
  };
}
