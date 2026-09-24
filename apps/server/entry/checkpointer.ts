// LangGraph's checkpointer for paused Agent turns (ADR 0007): PostgresSaver
// over the same database, its tables kept apart under the `langgraph`
// schema, every blob sealed under the Workspace key of the thread it belongs
// to (src/intelligence/agent/checkpointer.ts). setup() is its migration
// runner: idempotent and versioned in langgraph.checkpoint_migrations.
// Runtime-neutral: node-postgres underneath runs on Bun, Node, Vercel and
// Netlify alike.
//
// The checkpoint package, LangGraph and node-postgres load on the first
// Hosted turn, not at boot: `load` imports them, opens the pool and runs
// setup() once, and every later turn reuses that saver. A Server whose Agent
// never runs a Hosted turn never loads them.

import type { Db } from "../src/db/client.ts";
import type { SealedPostgresSaver } from "../src/intelligence/agent/checkpointer.ts";
import { lazy } from "../src/lazy.ts";
import type { ContentStore } from "../src/mailstore/content.ts";

export interface Checkpointer {
  /** The saver, loaded and set up by the first call; the Agent host's checkpointer loader. */
  load(): Promise<SealedPostgresSaver>;
  /** Closes the saver's pool when one was opened. */
  end(): Promise<void>;
}

export function createCheckpointer(
  databaseUrl: string,
  db: Db,
  content: ContentStore,
): Checkpointer {
  let loaded: SealedPostgresSaver | null = null;
  // A database down at the first turn: the next turn tries again.
  const load = lazy(async () => {
    const { createSealedCheckpointer, graphThreadWorkspaces } = await import(
      "../src/intelligence/agent/checkpointer.ts"
    );
    // Its tables go under the `langgraph` schema (LANGGRAPH_SCHEMA), the default.
    loaded = await createSealedCheckpointer(databaseUrl, {
      content,
      workspaceOf: graphThreadWorkspaces(db),
    });
    return loaded;
  });
  return {
    load,
    async end() {
      await loaded?.end();
    },
  };
}
