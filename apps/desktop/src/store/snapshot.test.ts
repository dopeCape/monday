/// <reference types="bun-types" />
// Newest first (ChangesSnapshot): a new Cache takes the newest Threads as they
// are now before the Changes feed, then runs the feed from 0 and skips every
// row the snapshot already said. Over a scripted Server whose snapshot follows
// the same rules as the real one: the newest row per full-state kind and
// entity, every row of the kinds that add answers.

import { describe, expect, test } from "bun:test";
import {
  ADDITIVE_THREAD_KINDS,
  type Change,
  type ChangesSnapshot,
  changeKey,
  type ThreadChange,
} from "@monday/shared";
import { bunDriver } from "./bun-driver.ts";
import type { SqlDriver } from "./driver.ts";
import { createStore, type Store } from "./store.ts";
import type { StoreTransport } from "./transport.ts";

const WS = "ws-snapshot";
const day = (d: number) => `2026-09-${String(d).padStart(2, "0")}T10:00:00.000Z`;

function thread(id: string, d: number, extra: Partial<ThreadChange> = {}): ThreadChange {
  return {
    id,
    workspaceId: WS,
    subject: "",
    participants: [{ name: "Kenji", email: "kenji@example.test" }],
    lastActivity: day(d),
    messageCount: 1,
    unread: true,
    starred: false,
    archived: false,
    snoozedUntil: null,
    section: null,
    group: null,
    subgroup: null,
    tags: [],
    labels: [],
    hasAttachments: false,
    snippet: "",
    deleted: false,
    ...extra,
  };
}

const answer = (signalId: string, noul: number) => ({
  signalId,
  version: 1,
  noul,
  choice: null,
  score: null,
  confidence: null,
  stale: false,
  lowTrust: null,
  judgedAt: day(1),
});

/** A Server's feed: rows appended in seq order, a snapshot over them as the real one makes it. */
function scriptedServer() {
  const rows: Change[] = [];
  const add = (c: Omit<Change, "seq" | "workspaceId" | "at">) => {
    const row = { ...c, seq: rows.length + 1, workspaceId: WS, at: day(1) } as Change;
    rows.push(row);
    return row.seq;
  };
  const threadOf = (c: Change): string | null =>
    c.kind === "thread"
      ? c.payload.id
      : "threadId" in c.payload
        ? (c.payload.threadId as string)
        : null;
  const snapshot = (before: string | null, limit: number): ChangesSnapshot => {
    const head = rows.length;
    const latest = new Map<string, Change>();
    for (const r of rows) latest.set(changeKey(r), r);
    const threads = [...latest.values()]
      .filter((c): c is Change & { kind: "thread" } => c.kind === "thread")
      .map((c) => ({ id: c.payload.id, at: c.payload.lastActivity }))
      .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));
    const start = before ? threads.findIndex((t) => t.id === before) + 1 : 0;
    const page = threads.slice(start, start + limit);
    const ids = new Set(page.map((t) => t.id));
    const out = rows.filter((r) => {
      const t = threadOf(r);
      if (!t || !ids.has(t))
        return (
          !before && (r.kind === "tag" || r.kind === "label") && latest.get(changeKey(r)) === r
        );
      return ADDITIVE_THREAD_KINDS.has(r.kind) || latest.get(changeKey(r)) === r;
    });
    const last = page[page.length - 1];
    return {
      head,
      changes: out,
      threads: page.map((t) => t.id),
      before: last && start + limit < threads.length ? last.id : null,
    };
  };
  return { rows, add, snapshot };
}

interface Opened {
  store: Store;
  driver: SqlDriver;
  feedCalls: number[];
  snapshotCalls: number;
}

async function open(
  server: ReturnType<typeof scriptedServer>,
  options: {
    seed: number;
    pageSize?: number;
    snapshot?: boolean;
    beforeFeed?: () => Promise<void>;
  } = {
    seed: 100,
  },
): Promise<Opened> {
  const driver = bunDriver();
  const opened: Opened = {
    store: null as unknown as Store,
    driver,
    feedCalls: [],
    snapshotCalls: 0,
  };
  const transport: StoreTransport = {
    async changes(_ws, since, limit) {
      if (opened.feedCalls.length === 0) await options.beforeFeed?.();
      opened.feedCalls.push(since);
      const page = server.rows.filter((c) => c.seq > since).slice(0, limit);
      const last = page[page.length - 1];
      return { changes: page, cursor: last ? last.seq : since };
    },
    ...(options.snapshot === false
      ? {}
      : {
          async snapshot(_ws: string, before: string | null, limit: number) {
            opened.snapshotCalls += 1;
            return server.snapshot(before, limit);
          },
        }),
    intent: async () => ({ applied: true }),
    draftIntent: async () => ({ applied: true }),
    inviteIntent: async () => ({ applied: true }),
    connect: () => ({ close() {} }),
  };
  opened.store = await createStore({
    workspaceId: WS,
    driver,
    transport,
    changesPageSize: options.pageSize ?? 2,
    seedThreads: () => options.seed,
    seedPageSize: () => 2,
  });
  return opened;
}

const dump = async (driver: SqlDriver) => ({
  threads: await driver.query(
    "select id, unread, starred, archived, deleted, last_activity from threads order by id",
  ),
  messages: await driver.query("select id, thread_id from messages order by id"),
  tags: await driver.query("select thread_id, tag_id from thread_tags order by thread_id, tag_id"),
  signals: await driver.query(
    "select thread_id, signal_id, noul from thread_signals order by thread_id, signal_id",
  ),
});

/** Ten Threads over ten days, each with a Message, the newest with history. */
function mailbox() {
  const server = scriptedServer();
  server.add({ kind: "tag", entityId: "tag1", payload: { id: "tag1", name: "investor" } });
  for (let d = 1; d <= 10; d++) {
    server.add({ kind: "thread", entityId: `t${d}`, payload: thread(`t${d}`, d) });
    server.add({
      kind: "message",
      entityId: `m${d}`,
      payload: {
        id: `m${d}`,
        threadId: `t${d}`,
        from: { name: "Kenji", email: "kenji@example.test" },
        to: [],
        cc: [],
        date: day(d),
        hasAttachments: false,
      },
    });
  }
  // The newest Thread was read later, tagged, and answered twice.
  server.add({ kind: "thread", entityId: "t10", payload: thread("t10", 10, { unread: false }) });
  server.add({
    kind: "thread_tags",
    entityId: "t10",
    payload: { threadId: "t10", ids: ["tag1"] },
  });
  server.add({
    kind: "signals",
    entityId: "t10",
    payload: { threadId: "t10", answers: [answer("needs_reply", 0.9)] },
  });
  server.add({
    kind: "signals",
    entityId: "t10",
    payload: { threadId: "t10", answers: [answer("urgency", 0.4)] },
  });
  // An older Thread's answers, which only the feed brings.
  server.add({
    kind: "signals",
    entityId: "t1",
    payload: { threadId: "t1", answers: [answer("needs_reply", 0.1)] },
  });
  return server;
}

describe("newest first", () => {
  test("a new device holds the newest Threads, as they are now, before the feed runs", async () => {
    const server = mailbox();
    let before: Awaited<ReturnType<typeof dump>> | null = null;
    const opened = await open(server, {
      seed: 4,
      beforeFeed: async () => {
        before = await dump(opened.driver);
      },
    });
    await opened.store.sync();
    const seen = before as unknown as Awaited<ReturnType<typeof dump>>;
    expect((seen.threads as Array<{ id: string }>).map((t) => t.id).sort()).toEqual([
      "t10",
      "t7",
      "t8",
      "t9",
    ]);
    expect(seen.threads.find((t) => t.id === "t10")).toMatchObject({ unread: 0 });
    expect(seen.tags).toEqual([{ thread_id: "t10", tag_id: "tag1" }]);
    expect(seen.signals).toHaveLength(2);
    expect(opened.snapshotCalls).toBe(2);
    // Then the feed from the start fills the rest.
    expect(opened.feedCalls[0]).toBe(0);
    const after = await dump(opened.driver);
    expect(after.threads).toHaveLength(10);
  });

  test("the feed's older rows never overwrite what the snapshot said", async () => {
    const server = mailbox();
    const opened = await open(server, { seed: 100, pageSize: 1 });
    const states: unknown[] = [];
    opened.store.onWrite(() => {
      void opened.driver
        .query("select unread from threads where id = 't10'")
        .then((r) => states.push(r[0]?.unread));
    });
    await opened.store.sync();
    await new Promise((r) => setTimeout(r, 20));
    // Read from the first write on: the older unread row was skipped, never applied.
    expect(states.filter((s) => s !== undefined).every((s) => s === 0)).toBe(true);
    expect(await opened.store.query("select key from applied_seq")).toEqual([]);
  });

  test("a change newer than the snapshot wins, and answers added later all apply", async () => {
    const server = mailbox();
    const opened = await open(server, {
      seed: 100,
      beforeFeed: async () => {
        // Arrive after the snapshot was read: deleted, untagged, one more answer.
        server.add({
          kind: "thread",
          entityId: "t10",
          payload: thread("t10", 10, { unread: false, deleted: true }),
        });
        server.add({ kind: "thread_tags", entityId: "t10", payload: { threadId: "t10", ids: [] } });
        server.add({
          kind: "signals",
          entityId: "t10",
          payload: { threadId: "t10", answers: [answer("waiting_on_others", 0.7)] },
        });
      },
    });
    await opened.store.sync();
    const after = await dump(opened.driver);
    expect(after.threads.find((t) => t.id === "t10")).toMatchObject({ deleted: 1 });
    expect(after.tags).toEqual([]);
    expect(after.signals.filter((s) => s.thread_id === "t10").map((s) => s.signal_id)).toEqual([
      "needs_reply",
      "urgency",
      "waiting_on_others",
    ]);
    expect(after.signals.filter((s) => s.thread_id === "t1")).toHaveLength(1);
  });

  test("ends where the feed alone ends, and without a snapshot the feed alone runs", async () => {
    const seeded = await open(mailbox(), { seed: 3 });
    await seeded.store.sync();
    const plain = await open(mailbox(), { seed: 3, snapshot: false });
    await plain.store.sync();
    expect(plain.snapshotCalls).toBe(0);
    expect(await dump(seeded.driver)).toEqual(await dump(plain.driver));
    const off = await open(mailbox(), { seed: 0 });
    await off.store.sync();
    expect(off.snapshotCalls).toBe(0);
    expect(await dump(off.driver)).toEqual(await dump(plain.driver));
  });

  test("once per catch-up: a second sync does not fill again", async () => {
    const opened = await open(mailbox(), { seed: 4 });
    await opened.store.sync();
    const calls = opened.snapshotCalls;
    await opened.store.sync();
    expect(opened.snapshotCalls).toBe(calls);
  });
});
