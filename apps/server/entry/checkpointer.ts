// LangGraph's checkpointer for paused Agent turns (ADR 0007): PostgresSaver
// over the same database, its tables kept apart under the `langgraph`
// schema, every blob sealed under the Workspace key of the thread it belongs
// to (src/intelligence/agent/checkpointer.ts). setup() is its migration
// runner: idempotent and versioned in langgraph.checkpoint_migrations, so
// every entry runs it right after our own migrations at boot. Runtime-neutral:
// node-postgres underneath runs on Bun, Node, Vercel and Netlify alike.

import type { Db } from "../src/db/client.ts";
import {
  createSealedCheckpointer,
  graphThreadWorkspaces,
  LANGGRAPH_SCHEMA,
  type SealedPostgresSaver,
} from "../src/intelligence/agent/checkpointer.ts";
import type { ContentStore } from "../src/mailstore/content.ts";

export { LANGGRAPH_SCHEMA };

export async function createCheckpointer(
  databaseUrl: string,
  db: Db,
  content: ContentStore,
): Promise<SealedPostgresSaver> {
  return createSealedCheckpointer(
    databaseUrl,
    { content, workspaceOf: graphThreadWorkspaces(db) },
    { schema: LANGGRAPH_SCHEMA },
  );
}
