// The FakeStore: a real Store over an in-memory SQLite plus a fake Server that
// keeps the same rules (per-field last-writer-wins, the Changes feed, wakes).
// Tests drive it with `server.offline` and `server.write`; the browser dev
// server (the fakePlatform path) seeds it from the design fixtures.

import type {
  Actor,
  Change,
  ChangesPage,
  FieldWrites,
  Id,
  Intent,
  IntentResult,
  IsoDate,
  ThreadChange,
} from "@monday/shared";
import { FIELD_GROUP_OF, resolveWrite } from "@monday/shared";
import { ApiError } from "../platform/api.ts";
import type { SqlDriver } from "./driver.ts";
import { fixtureSeed, type SeedData, seedStatements } from "./seed.ts";
import { createStore, type Store, type StoreOptions } from "./store.ts";
import type { StoreTransport, WakeHandlers } from "./transport.ts";

interface ServerThread extends ThreadChange {
  writes: FieldWrites;
}

/** A server-side write outside any client intent: a Provider sync or a Workflow. */
export interface ServerWrite {
  threadId: Id;
  actor: Actor;
  at: IsoDate;
  patch: Partial<
    Pick<
      ThreadChange,
      "archived" | "starred" | "unread" | "snoozedUntil" | "group" | "subgroup" | "deleted" | "tags"
    >
  >;
}

export interface FakeServer {
  /** While true every request fails like a dropped connection. */
  offline: boolean;
  threads: Map<Id, ServerThread>;
  changes: Change[];
  /** How many intents arrived, in order, for assertions on replay order. */
  received: Intent[];
  applyIntent(intent: Intent): IntentResult;
  /** Appends any change to the feed with the next seq and wakes the sockets. */
  record(change: Omit<Change, "seq" | "workspaceId" | "at">): number;
  /** Applies a write as the Server would from a sync or a Workflow and records the change. */
  write(write: ServerWrite): void;
  list(since: number, limit: number): ChangesPage;
  /** Drops every open wake connection, as a restart would. */
  dropConnections(): void;
  connections(): number;
  /** Open wake connections; fakeTransport adds and removes them. */
  sockets: Set<WakeHandlers>;
}

export function createFakeServer(workspaceId: Id, seed?: SeedData): FakeServer {
  const threads = new Map<Id, ServerThread>();
  const changes: Change[] = [];
  const sockets = new Set<WakeHandlers>();
  let seq = 0;

  if (seed) {
    for (const t of seed.threads) threads.set(t.id, { ...t, deleted: false, writes: {} });
  }

  const record = (change: Omit<Change, "seq" | "workspaceId" | "at">): number => {
    seq += 1;
    changes.push({ ...change, seq, workspaceId, at: new Date().toISOString() } as Change);
    for (const s of [...sockets]) s.onWake(seq);
    return seq;
  };

  const threadOf = (threadId: Id): ServerThread => {
    const existing = threads.get(threadId);
    if (existing) return existing;
    const created: ServerThread = {
      id: threadId,
      workspaceId,
      subject: "",
      participants: [],
      lastActivity: new Date(0).toISOString(),
      messageCount: 0,
      unread: false,
      starred: false,
      archived: false,
      deleted: false,
      snoozedUntil: null,
      section: null,
      group: null,
      subgroup: null,
      tags: [],
      labels: [],
      hasAttachments: false,
      snippet: "",
      writes: {},
    };
    threads.set(threadId, created);
    return created;
  };

  const project = (t: ServerThread): ThreadChange => {
    const { writes: _w, ...rest } = t;
    return rest;
  };

  const server: FakeServer = {
    offline: false,
    threads,
    changes,
    received: [],
    record,

    applyIntent(intent) {
      server.received.push(intent);
      const t = threadOf(intent.threadId);
      const group = FIELD_GROUP_OF[intent.kind];
      const resolution = resolveWrite(intent, t.writes[group]);
      if (!resolution.wins) return { applied: false, reason: resolution.reason };
      t.writes[group] = { at: intent.at, by: intent.actor };
      switch (intent.kind) {
        case "archive":
          t.archived = true;
          break;
        case "unarchive":
          t.archived = false;
          break;
        case "star":
          t.starred = true;
          break;
        case "unstar":
          t.starred = false;
          break;
        case "read":
          t.unread = false;
          break;
        case "unread":
          t.unread = true;
          break;
        case "snooze":
          t.snoozedUntil = intent.until;
          t.archived = true;
          break;
        case "unsnooze":
          t.snoozedUntil = null;
          t.archived = false;
          break;
        case "move":
          t.group = intent.group;
          t.subgroup = intent.subgroup;
          break;
        case "delete":
          t.deleted = true;
          break;
        case "tags":
          t.tags = [...new Set(intent.tags)];
          record({
            kind: "thread_tags",
            entityId: t.id,
            payload: { threadId: t.id, ids: t.tags },
          });
          return { applied: true };
      }
      record({ kind: "thread", entityId: t.id, payload: project(t) });
      return { applied: true };
    },

    write({ threadId, actor, at, patch }) {
      const t = threadOf(threadId);
      const stamp = { at, by: actor };
      if (patch.archived !== undefined) {
        t.archived = patch.archived;
        t.writes.archived = stamp;
      }
      if (patch.starred !== undefined) {
        t.starred = patch.starred;
        t.writes.starred = stamp;
      }
      if (patch.unread !== undefined) {
        t.unread = patch.unread;
        t.writes.unread = stamp;
      }
      if (patch.snoozedUntil !== undefined) {
        t.snoozedUntil = patch.snoozedUntil;
        t.writes.snoozed = stamp;
      }
      if (patch.group !== undefined || patch.subgroup !== undefined) {
        t.group = patch.group ?? t.group;
        t.subgroup = patch.subgroup ?? t.subgroup;
        t.writes.placement = stamp;
      }
      if (patch.deleted !== undefined) {
        t.deleted = patch.deleted;
        t.writes.deleted = stamp;
      }
      if (patch.tags !== undefined) {
        t.tags = [...patch.tags];
        t.writes.tags = stamp;
      }
      record({ kind: "thread", entityId: t.id, payload: project(t) });
    },

    list(since, limit) {
      const page = changes.filter((c) => c.seq > since).slice(0, limit);
      const last = page[page.length - 1];
      return { changes: page, cursor: last ? last.seq : since };
    },

    dropConnections() {
      for (const s of [...sockets]) {
        sockets.delete(s);
        s.onClose();
      }
    },

    connections: () => sockets.size,
    sockets,
  };
  return server;
}

export function fakeTransport(server: FakeServer): StoreTransport {
  const { sockets } = server;
  const offline = () => new ApiError(0, "connection refused");
  return {
    async changes(_workspaceId, since, limit) {
      if (server.offline) throw offline();
      return server.list(since, limit);
    },
    async intent(intent) {
      if (server.offline) throw offline();
      return server.applyIntent(intent);
    },
    connect(_workspaceId, handlers) {
      if (server.offline) {
        queueMicrotask(handlers.onClose);
        return { close() {} };
      }
      sockets.add(handlers);
      queueMicrotask(() => {
        if (sockets.has(handlers)) handlers.onOpen();
      });
      return {
        close() {
          sockets.delete(handlers);
        },
      };
    },
  };
}

export interface FakeStoreOptions extends Partial<Omit<StoreOptions, "driver" | "transport">> {
  workspaceId?: Id;
  driver: SqlDriver;
  /** Fixture data for the Cache and the fake Server; the design fixtures by default, `null` for empty. */
  seed?: SeedData | null;
}

export interface FakeStore {
  store: Store;
  server: FakeServer;
}

/** A Store over `driver` whose Server is in memory, seeded on both sides. */
export async function createFakeStore(options: FakeStoreOptions): Promise<FakeStore> {
  const { driver, seed: seedOption, workspaceId = "ws-genai", ...rest } = options;
  const seed = seedOption === undefined ? fixtureSeed() : seedOption;
  const server = createFakeServer(workspaceId, seed ?? undefined);
  const store = await createStore({
    ...rest,
    workspaceId,
    driver,
    transport: fakeTransport(server),
  });
  if (seed) {
    const [row] = await store.query<{ n: number }>("select count(*) as n from threads");
    if ((row?.n ?? 0) === 0) await driver.batch(seedStatements(seed));
  }
  return { store, server };
}
