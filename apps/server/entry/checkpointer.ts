// LangGraph's checkpointer for paused Agent turns (ADR 0007): PostgresSaver
// over the same database, its tables kept apart under the `langgraph`
// schema. setup() is its migration runner: idempotent and versioned in
// langgraph.checkpoint_migrations, so every entry runs it right after our
// own migrations at boot. Runtime-neutral: node-postgres underneath runs on
// Bun, Node, Vercel and Netlify alike.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

/** Where the checkpointer keeps its tables, apart from ours. */
export const LANGGRAPH_SCHEMA = "langgraph";

export async function createCheckpointer(databaseUrl: string): Promise<PostgresSaver> {
  const checkpointer = PostgresSaver.fromConnString(databaseUrl, { schema: LANGGRAPH_SCHEMA });
  await checkpointer.setup();
  return checkpointer;
}
