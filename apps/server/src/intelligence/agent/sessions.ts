// Sessions (CONTEXT.md: one conversation with the Agent, with its history)
// and their transcript: the persisted events the composer replays. The
// LangGraph checkpoint is the model's memory of the same conversation and
// lives in the checkpointer's tables under the Session id. Postgres in
// production, memory in tests.
//
// A transcript quotes mail (what the user pasted, what the Agent read back,
// the previews on the tool cards), so every event is sealed under the
// Workspace's envelope as the "transcript" kind before it is stored, and
// reading one back needs the root key: a locked Server answers 423 for a
// Session's history. Rows written before migration 0014 carry the event in
// the clear; they read as they are, and sealLegacy() moves them under the
// envelope once the Server is unlocked.

import type { AgentEvent, Runtime, SessionSummary } from "@monday/shared";
import { asc, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { sessionEvents, sessions } from "../../db/schema.ts";
import type { ContentStore } from "../../mailstore/content.ts";

export interface SessionStore {
  create(workspaceId: string, runtime: Runtime): Promise<SessionSummary>;
  list(workspaceId: string, limit?: number): Promise<SessionSummary[]>;
  get(id: string): Promise<SessionSummary | null>;
  /** Marks activity; sets the title when the Session has none yet. */
  touch(id: string, title?: string): Promise<void>;
  /** A Runtime switch mid-Session (docs/spec/agent-composer.md, Sessions). */
  setRuntime(id: string, runtime: Runtime): Promise<void>;
  append(id: string, event: AgentEvent): Promise<void>;
  /**
   * The transcript in order, with each tool card collapsed to its latest
   * state. With `at`, a user or text event carries when it was stored, for
   * the composer's timestamps; the transcript a runtime reads leaves it out.
   */
  events(id: string, options?: EventsOptions): Promise<AgentEvent[]>;
  /**
   * Seals the transcript rows written before migration 0014, up to `limit`
   * of them, and returns how many it moved. Needs the root key; the entry
   * runs it at boot and after an unlock until it returns 0.
   */
  sealLegacy(limit?: number): Promise<number>;
}

export interface EventsOptions {
  at?: boolean | undefined;
}

/** A user or text event with the time it was stored, unless it already says. */
export function stampEvent(event: AgentEvent, at: Date): AgentEvent {
  if ((event.kind === "user" || event.kind === "text") && !event.at) {
    return { ...event, at: at.toISOString() };
  }
  return event;
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

export interface SessionStoreOptions {
  /** Seals and opens the transcript events; the Mailstore in production. */
  content: ContentStore;
  now?: () => Date;
}

export function createSessionStore(db: Db, options: SessionStoreOptions): SessionStore {
  const { content } = options;
  const now = options.now ?? (() => new Date());
  const workspaceOf = async (sessionId: string): Promise<string | null> => {
    const row = await db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
      columns: { workspaceId: true },
    });
    return row?.workspaceId ?? null;
  };
  const seal = async (workspaceId: string, event: AgentEvent) => {
    const ref = await content.storeContent(workspaceId, "transcript", JSON.stringify(event));
    const eventEnc = ref.chunks[0];
    if (!eventEnc) throw new RangeError("transcript envelope missing");
    return { eventEnc, eventKey: ref.key };
  };
  const open = async (
    workspaceId: string,
    row: { event: AgentEvent | null; eventEnc: Uint8Array | null; eventKey: Uint8Array | null },
  ): Promise<AgentEvent | null> => {
    if (row.eventEnc && row.eventKey) {
      const text = await content.readText({
        workspaceId,
        kind: "transcript",
        key: row.eventKey,
        chunks: [row.eventEnc],
        size: -1,
      });
      return JSON.parse(text) as AgentEvent;
    }
    return row.event;
  };
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
      const workspaceId = await workspaceOf(id);
      if (!workspaceId) return;
      const sealed = await seal(workspaceId, event);
      await db.insert(sessionEvents).values({ sessionId: id, event: null, ...sealed, at: now() });
    },
    async events(id, options = {}) {
      const workspaceId = await workspaceOf(id);
      if (!workspaceId) return [];
      const rows = await db
        .select({
          event: sessionEvents.event,
          eventEnc: sessionEvents.eventEnc,
          eventKey: sessionEvents.eventKey,
          at: sessionEvents.at,
        })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, id))
        .orderBy(asc(sessionEvents.seq));
      const out: AgentEvent[] = [];
      for (const row of rows) {
        const event = await open(workspaceId, row);
        if (event) out.push(options.at ? stampEvent(event, row.at) : event);
      }
      return collapseEvents(out);
    },
    async sealLegacy(limit = 500) {
      const rows = await db
        .select({
          seq: sessionEvents.seq,
          event: sessionEvents.event,
          workspaceId: sessions.workspaceId,
        })
        .from(sessionEvents)
        .innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
        .where(isNotNull(sessionEvents.event))
        .orderBy(asc(sessionEvents.seq))
        .limit(Math.max(1, limit));
      let moved = 0;
      for (const row of rows) {
        if (!row.event) continue;
        const sealed = await seal(row.workspaceId, row.event);
        await db
          .update(sessionEvents)
          .set({ event: null, ...sealed })
          .where(eq(sessionEvents.seq, row.seq));
        moved += 1;
      }
      return moved;
    },
  };
}

export function createMemorySessionStore(options: { now?: () => Date } = {}): SessionStore {
  const now = options.now ?? (() => new Date());
  const rows = new Map<string, SessionSummary>();
  const events = new Map<string, { event: AgentEvent; at: Date }[]>();
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
      events.get(id)?.push({ event, at: now() });
    },
    async events(id, options = {}) {
      const rows = events.get(id) ?? [];
      return collapseEvents(rows.map((r) => (options.at ? stampEvent(r.event, r.at) : r.event)));
    },
    async sealLegacy() {
      return 0;
    },
  };
}
