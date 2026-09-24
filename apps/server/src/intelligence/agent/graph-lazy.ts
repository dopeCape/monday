// The agent loop, built on the first turn. LangGraph and the Postgres
// checkpointer cost tens of megabytes once evaluated; a Server whose Agent
// never runs a Hosted turn should not carry them. The host holds this
// stand-in from the start; the first turn, resume or transcript read imports
// graph.ts, resolves the checkpointer (a saver, or a loader the entry passes
// so the checkpoint package loads here too) and compiles the graph once.

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { lazy } from "../../lazy.ts";
import type { AgentGraph, AgentGraphOptions } from "./graph.ts";

/** A checkpointer, or how to get one on first use. Absent: checkpoints stay in memory. */
export type CheckpointerSource = BaseCheckpointSaver | (() => Promise<BaseCheckpointSaver>);

async function resolveCheckpointer(
  source: CheckpointerSource | undefined,
): Promise<BaseCheckpointSaver> {
  if (!source) {
    const { MemorySaver } = await import("@langchain/langgraph");
    return new MemorySaver();
  }
  return typeof source === "function" ? source() : source;
}

export interface LazyAgentGraphOptions extends Omit<AgentGraphOptions, "checkpointer"> {
  checkpointer?: CheckpointerSource | undefined;
}

export function createLazyAgentGraph(options: LazyAgentGraphOptions): AgentGraph {
  // A failed load (a database down at the first turn) is tried again by the next one.
  const graph = lazy(async (): Promise<AgentGraph> => {
    const [{ createAgentGraph }, checkpointer] = await Promise.all([
      import("./graph.ts"),
      resolveCheckpointer(options.checkpointer),
    ]);
    return createAgentGraph({ ...options, checkpointer });
  });
  return {
    turn: async (sessionId, text) => (await graph()).turn(sessionId, text),
    resume: async (sessionId, decision) => (await graph()).resume(sessionId, decision),
    messages: async (sessionId) => (await graph()).messages(sessionId),
  };
}
