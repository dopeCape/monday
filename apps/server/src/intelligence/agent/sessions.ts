// Sessions (CONTEXT.md: one conversation with the Agent, with its history)
// and their transcript: the persisted events the composer replays. The
// LangGraph checkpoint is the model's memory of the same conversation and
// lives in the checkpointer's tables under the Session id. Postgres in
// production, memory in tests.

import type { AgentEvent, Runtime, SessionSummary } from "@monday/shared";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { sessionEvents, sessions } from "../../db/schema.ts";

export interface SessionStore {
  create(workspaceId: string, runtime: Runtime): Promise<SessionSummary>;
  list(workspaceId: string, limit?: number): Promise<SessionSummary[]>;
  get(id: string): Promise<SessionSummary | null>;
  /** Marks activity; sets the title when the Session has none yet. */
  touch(id: string, title?: string): Promise<void>;
  /** A Runtime switch mid-Session (docs/spec/agent-composer.md, Sessions). */
  setRuntime(id: string, runtime: Runtime): Promise<void>;
  append(id: string, event: AgentEvent): Promise<void>;
  /** The transcript in order, with each tool card collapsed to its latest state. */
  events(id: string): Promise<AgentEvent[]>;
}

/** Every tool card once, at its first position, in its latest state. */
export function collapseEvents(events: readonly AgentEvent[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  const toolIndex = new Map<string, number>();
  for (const event of events) {
    if (event.kind === "delta") continue;
    if (event.kind === "tool") {
      const at = toolIndex.get(event.call.id);
      if (at !== undefined) {
        out[at] = event;
        continue;
      }
      toolIndex.set(event.call.id, out.length);
    }
    out.push(event);
  }
  return out;
}

type Row = typeof sessions.$inferSelect;

const project = (r: Row): SessionSummary => ({
  id: r.id,
  workspaceId: r.workspaceId,
  runtime: r.runtime,
  title: r.title,
  startedAt: r.startedAt.toISOString(),
  lastActivity: r.lastActivity.toISOString(),
});

export function createSessionStore(db: Db, options: { now?: () => Date } = {}): SessionStore {
  const now = options.now ?? (() => new Date());
  return {
    async create(workspaceId, runtime) {
      const [row] = await db
        .insert(sessions)
        .values({
          id: crypto.randomUUID(),
          workspaceId,
          runtime,
          startedAt: now(),
          lastActivity: now(),
        })
        .returning();
      if (!row) throw new Error("session insert returned nothing");
      return project(row);
    },
    async list(workspaceId, limit = 50) {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.workspaceId, workspaceId))
        .orderBy(desc(sessions.lastActivity))
        .limit(limit);
      return rows.map(project);
    },
    async get(id) {
      const row = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
      return row ? project(row) : null;
    },
    async touch(id, title) {
      const row = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
      if (!row) return;
      await db
        .update(sessions)
        .set({ lastActivity: now(), ...(title && !row.title ? { title } : {}) })
        .where(eq(sessions.id, id));
    },
    async setRuntime(id, runtime) {
      await db.update(sessions).set({ runtime, lastActivity: now() }).where(eq(sessions.id, id));
    },
    async append(id, event) {
      await db.insert(sessionEvents).values({ sessionId: id, event, at: now() });
    },
    async events(id) {
      const rows = await db
        .select({ event: sessionEvents.event })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, id))
        .orderBy(asc(sessionEvents.seq));
      return collapseEvents(rows.map((r) => r.event));
    },
  };
}

export function createMemorySessionStore(options: { now?: () => Date } = {}): SessionStore {
  const now = options.now ?? (() => new Date());
  const rows = new Map<string, SessionSummary>();
  const events = new Map<string, AgentEvent[]>();
  return {
    async create(workspaceId, runtime) {
      const session: SessionSummary = {
        id: crypto.randomUUID(),
        workspaceId,
        runtime,
        title: "",
        startedAt: now().toISOString(),
        lastActivity: now().toISOString(),
      };
      rows.set(session.id, session);
      events.set(session.id, []);
      return session;
    },
    async list(workspaceId, limit = 50) {
      return [...rows.values()]
        .filter((s) => s.workspaceId === workspaceId)
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
        .slice(0, limit);
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async touch(id, title) {
      const s = rows.get(id);
      if (!s) return;
      s.lastActivity = now().toISOString();
      if (title && !s.title) s.title = title;
    },
    async setRuntime(id, runtime) {
      const s = rows.get(id);
      if (!s) return;
      s.runtime = runtime;
      s.lastActivity = now().toISOString();
    },
    async append(id, event) {
      events.get(id)?.push(event);
    },
    async events(id) {
      return collapseEvents(events.get(id) ?? []);
    },
  };
}
