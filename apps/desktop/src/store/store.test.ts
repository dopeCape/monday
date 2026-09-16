// The Store through its interface over bun:sqlite, with the fake Server at
// the transport seam (ADR 0009): schema, live queries, intents, the Outbox,
// the Changes feed and the conflict rules from ADR 0005.

import { describe, expect, test } from "bun:test";
import type { Change, Thread } from "@monday/shared";
import { bunDriver } from "./bun-driver.ts";
import { createFakeStore, type FakeStore } from "./fake.ts";
import { INBOX_THREADS_SQL, rowToThread, THREAD_BY_ID_SQL } from "./queries.ts";
import { fixtureSeed } from "./seed.ts";
import { localStatements, tablesRead, tablesWritten } from "./store.ts";

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await tick();
  }
  throw new Error("condition not met");
}

async function open(seed: "fixtures" | "empty" = "fixtures"): Promise<FakeStore> {
  return createFakeStore({
    driver: bunDriver(),
    seed: seed === "fixtures" ? fixtureSeed() : null,
    backoff: { minMs: 5, maxMs: 20 },
    changesPageSize: 3,
  });
}

const threadRow = async (store: FakeStore["store"], id: string) =>
  rowToThread((await store.query(THREAD_BY_ID_SQL, [id]))[0] ?? {}, store.workspaceId);

describe("schema", () => {
  test("applies idempotently with every table and the FTS index", async () => {
    const driver = bunDriver();
    const { store } = await createFakeStore({ driver, seed: null });
    const names = (
      await store.query<{ name: string }>(
        "select name from sqlite_master where type in ('table', 'view') order by name",
      )
    ).map((r) => r.name);
    for (const t of [
      "threads",
      "messages",
      "attachments",
      "labels",
      "tags",
      "thread_tags",
      "thread_labels",
      "groups",
      "section_rules",
      "briefs",
      "settings",
      "outbox",
      "meta",
      "threads_fts",
    ]) {
      expect(names).toContain(t);
    }
    // A second open over the same file is a no-op.
    const again = await createFakeStore({ driver, seed: null });
    expect(again.store.workspaceId).toBe(store.workspaceId);
  });

  test("seeds the fixtures once and indexes subjects and participants", async () => {
    const { store } = await open();
    const fixtures = fixtureSeed();
    const [count] = await store.query<{ n: number }>("select count(*) as n from threads");
    expect(count?.n).toBe(fixtures.threads.length);
    const hits = await store.query<{ id: string }>(
      "select t.id from threads_fts f join threads t on t.rid = f.rowid where threads_fts match ?",
      ["redline"],
    );
    expect(hits.map((h) => h.id)).toEqual(["e2"]);
    const byPerson = await store.query<{ id: string }>(
      "select t.id from threads_fts f join threads t on t.rid = f.rowid where threads_fts match ?",
      ["participants: aoife"],
    );
    expect(byPerson.length).toBeGreaterThan(0);
    const inbox = (await store.query(INBOX_THREADS_SQL)).map((r) =>
      rowToThread(r, store.workspaceId),
    );
    expect(inbox.map((t) => t.id)).toEqual(fixtures.threads.map((t) => t.id));
    const e1 = inbox.find((t) => t.id === "e1") as Thread;
    const seed = fixtures.threads.find((t) => t.id === "e1") as Thread;
    expect(e1).toEqual({ ...seed, workspaceId: store.workspaceId });
  });
});

describe("table parsing", () => {
  test("reads come from FROM and JOIN, writes from INSERT, UPDATE and DELETE", () => {
    expect([...tablesRead(INBOX_THREADS_SQL)]).toEqual(["thread_tags", "thread_labels", "threads"]);
    expect([
      ...tablesRead("select * from messages m join attachments a on a.message_id = m.id"),
    ]).toEqual(["messages", "attachments"]);
    expect([...tablesWritten("update threads set archived = 1 where id = ?")]).toEqual([
      "threads",
      "threads_fts",
    ]);
    expect([...tablesWritten("insert or ignore into thread_tags (a, b) values (?, ?)")]).toEqual([
      "thread_tags",
    ]);
    expect([...tablesWritten("delete from outbox where seq = ?")]).toEqual(["outbox"]);
  });
});

describe("live queries", () => {
  test("re-run when a table they read changes and only then", async () => {
    const { store } = await open();
    const threads = store.live<{ id: string }>(
      "select id from threads where archived = 0 order by rid",
    );
    const tags = store.live<{ id: string }>("select id from tags order by id");
    const threadRuns: number[] = [];
    const tagRuns: number[] = [];
    threads.subscribe((rows) => threadRuns.push(rows.length));
    tags.subscribe((rows) => tagRuns.push(rows.length));
    await until(() => threadRuns.length === 1 && tagRuns.length === 1);
    expect(threads.rows?.length).toBe(11);

    await store.intent({ kind: "archive", threadId: "e1" });
    await until(() => threadRuns.length === 2);
    expect(threadRuns).toEqual([11, 10]);
    // Tags were not written: no re-run.
    await tick(20);
    expect(tagRuns).toEqual([10]);

    // A tags intent touches thread_tags, which neither query reads.
    await store.intent({ kind: "tags", threadId: "e2", tags: ["investor"] });
    await tick(20);
    expect(threadRuns).toEqual([11, 10]);
    expect(tagRuns).toEqual([10]);

    // Unchanged results do not notify.
    await store.intent({ kind: "star", threadId: "e2" });
    await tick(20);
    expect(threadRuns).toEqual([11, 10]);

    threads.close();
    await store.intent({ kind: "archive", threadId: "e2" });
    await tick(20);
    expect(threadRuns).toEqual([11, 10]);
  });
});

describe("intents", () => {
  test("apply locally and append to the outbox in order without touching the network", async () => {
    const { store, server } = await open();
    server.offline = true;
    const at = "2026-09-16T10:05:00.000Z";
    await store.intent({ kind: "archive", threadId: "e1", at });
    await store.intent({ kind: "snooze", threadId: "e3", until: "2026-09-17T08:00:00.000Z" });
    await store.intent({ kind: "tags", threadId: "e2", tags: ["investor", "review"] });
    await store.intent({ kind: "move", threadId: "e4", group: "finance", subgroup: null });

    expect((await threadRow(store, "e1")).archived).toBe(true);
    const e3 = await threadRow(store, "e3");
    expect(e3.archived).toBe(true);
    expect(e3.snoozedUntil).toBe("2026-09-17T08:00:00.000Z");
    expect((await threadRow(store, "e2")).tags).toEqual(["investor", "review"]);
    expect((await threadRow(store, "e4")).group).toBe("finance");

    const outbox = await store.query<{
      seq: number;
      kind: string;
      thread_id: string;
      payload: string;
      at: string;
      actor: string;
    }>("select * from outbox order by seq");
    expect(outbox.map((r) => [r.kind, r.thread_id])).toEqual([
      ["archive", "e1"],
      ["snooze", "e3"],
      ["tags", "e2"],
      ["move", "e4"],
    ]);
    expect(outbox[0]?.at).toBe(at);
    expect(outbox[0]?.actor).toBe("user");
    expect(JSON.parse(outbox[1]?.payload ?? "{}")).toEqual({ until: "2026-09-17T08:00:00.000Z" });
    expect(JSON.parse(outbox[2]?.payload ?? "{}")).toEqual({ tags: ["investor", "review"] });
    expect(server.received).toEqual([]);
  });

  test("every kind has a local statement", () => {
    const stamp = { threadId: "t", at: "2026-01-01T00:00:00.000Z", actor: "user" as const };
    for (const intent of [
      { kind: "archive" as const },
      { kind: "unarchive" as const },
      { kind: "star" as const },
      { kind: "unstar" as const },
      { kind: "read" as const },
      { kind: "unread" as const },
      { kind: "snooze" as const, until: "2026-01-02T00:00:00.000Z" },
      { kind: "unsnooze" as const },
      { kind: "move" as const, group: "g", subgroup: null },
      { kind: "delete" as const },
      { kind: "tags" as const, tags: ["a", "b"] },
    ]) {
      expect(localStatements({ ...intent, ...stamp }).length).toBeGreaterThan(0);
    }
  });
});

describe("sync", () => {
  test("drains the outbox in order and stops at the first network error, keeping the rest", async () => {
    const { store, server } = await open();
    server.offline = true;
    await store.intent({ kind: "archive", threadId: "e1" });
    await store.intent({ kind: "star", threadId: "e2" });
    await store.intent({ kind: "read", threadId: "e3" });

    const offline = await store.sync();
    expect(offline.pushed).toBe(0);
    expect(offline.pending).toBe(3);
    expect(offline.error?.message).toContain("connection refused");
    expect(server.received).toEqual([]);
    const attempts = await store.query<{ attempts: number; last_error: string }>(
      "select attempts, last_error from outbox order by seq",
    );
    expect(attempts[0]).toEqual({ attempts: 1, last_error: "connection refused" });
    expect(attempts[1]?.attempts).toBe(0);

    // The connection returns after the first intent goes through.
    server.offline = false;
    const original = server.applyIntent.bind(server);
    let calls = 0;
    server.applyIntent = (intent) => {
      calls += 1;
      if (calls === 2) {
        server.offline = true;
        throw new Error("socket hang up");
      }
      return original(intent);
    };
    const partial = await store.sync();
    expect(partial.pushed).toBe(1);
    expect(partial.pending).toBe(2);
    expect(server.received.map((i) => i.kind)).toEqual(["archive"]);
    expect(server.threads.get("e1")?.archived).toBe(true);
    expect(server.threads.get("e3")?.writes.unread).toBeUndefined();

    server.offline = false;
    server.applyIntent = original;
    const done = await store.sync();
    expect(done.error).toBeNull();
    expect(done.pushed).toBe(2);
    expect(done.pending).toBe(0);
    expect(server.received.map((i) => [i.kind, i.threadId])).toEqual([
      ["archive", "e1"],
      ["star", "e2"],
      ["read", "e3"],
    ]);
    expect(server.threads.get("e3")?.writes.unread?.by).toBe("user");
  });

  test("a permanent rejection drops the intent and continues", async () => {
    const { store, server } = await open();
    const { ApiError } = await import("../platform/api.ts");
    const original = server.applyIntent.bind(server);
    server.applyIntent = (intent) => {
      if (intent.threadId === "e1") throw new ApiError(404, "gone");
      return original(intent);
    };
    await store.intent({ kind: "archive", threadId: "e1" });
    await store.intent({ kind: "archive", threadId: "e2" });
    const result = await store.sync();
    expect(result.error).toBeNull();
    expect(result.pushed).toBe(1);
    expect(result.pending).toBe(0);
    expect(server.threads.get("e2")?.archived).toBe(true);
  });

  test("applies changes in pages and advances the cursor", async () => {
    const { store, server } = await open("empty");
    const meta = () =>
      store.query<{ value: string }>("select value from meta where key = 'cursor'");
    expect(await meta()).toEqual([]);

    const T = "2026-09-16T10:00:00.000Z";
    server.write({ threadId: "s1", actor: "automation", at: T, patch: { unread: true } });
    server.write({ threadId: "s2", actor: "automation", at: T, patch: { starred: true } });
    server.record({
      kind: "tag",
      entityId: "tag-1",
      payload: { id: "tag-1", name: "Investor" },
    });
    server.record({
      kind: "thread_tags",
      entityId: "s1",
      payload: { threadId: "s1", ids: ["tag-1"] },
    });
    server.record({
      kind: "message",
      entityId: "m1",
      payload: {
        id: "m1",
        threadId: "s1",
        from: { name: "Kenji", email: "kenji@example.test" },
        to: [],
        cc: [],
        date: T,
        hasAttachments: false,
      },
    });
    server.record({
      kind: "label",
      entityId: "l1",
      payload: { id: "l1", name: "Inbox", providerId: "INBOX" },
    });

    // Page size is 3 for this test: two pages, both applied, cursor at the end.
    const result = await store.sync();
    expect(result.error).toBeNull();
    expect(result.pulled).toBe(6);
    expect(result.cursor).toBe(6);
    expect(await meta()).toEqual([{ value: "6" }]);

    const s1 = await threadRow(store, "s1");
    expect(s1.unread).toBe(true);
    expect(s1.tags).toEqual(["tag-1"]);
    expect((await threadRow(store, "s2")).starred).toBe(true);
    expect(await store.query("select id, name from tags")).toEqual([
      { id: "tag-1", name: "Investor" },
    ]);
    expect(await store.query("select id, provider_id from labels")).toEqual([
      { id: "l1", provider_id: "INBOX" },
    ]);
    const messages = await store.query<{ id: string; body_text: string | null }>(
      "select id, body_text from messages",
    );
    expect(messages).toEqual([{ id: "m1", body_text: null }]);

    // Nothing new: the cursor holds, nothing is re-applied.
    const idle = await store.sync();
    expect(idle.pulled).toBe(0);
    expect(idle.cursor).toBe(6);

    // The next change is picked up from the stored cursor.
    server.write({ threadId: "s1", actor: "automation", at: T, patch: { unread: false } });
    const more = await store.sync();
    expect(more.pulled).toBe(1);
    expect(more.cursor).toBe(7);
    expect((await threadRow(store, "s1")).unread).toBe(false);
  });

  test("a feed row never clears a subject or a body the Cache already holds", async () => {
    const { store, server } = await open();
    const before = await threadRow(store, "e1");
    expect(before.subject.length).toBeGreaterThan(0);
    const onServer = server.threads.get("e1");
    if (!onServer) throw new Error("seed missing");
    onServer.subject = "re: senior rust";
    onServer.snippet = "";
    server.write({
      threadId: "e1",
      actor: "automation",
      at: "2026-09-16T10:00:00.000Z",
      patch: { unread: false },
    });
    await store.sync();
    const after = await threadRow(store, "e1");
    expect(after.unread).toBe(false);
    expect(after.subject).toBe(before.subject);
    expect(after.snippet).toBe(before.snippet);
  });
});

describe("conflicts (ADR 0005)", () => {
  test("archive while offline, then a server move: both land and the user's archive wins", async () => {
    const { store, server } = await open();
    const stream = store.live<{ id: string; archived: number; group_id: string | null }>(
      "select id, archived, group_id from threads where id = 'e1'",
    );
    const seen: Array<{ archived: number; group_id: string | null }> = [];
    stream.subscribe((rows) => {
      const r = rows[0];
      if (r) seen.push({ archived: r.archived, group_id: r.group_id });
    });
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ archived: 0, group_id: "hiring" });

    // 1. Offline: the user archives at T1. The row leaves the stream at once.
    server.offline = true;
    const T1 = "2026-09-16T10:01:00.000Z";
    await store.intent({ kind: "archive", threadId: "e1", at: T1 });
    await until(() => seen.length === 2);
    expect(seen[1]).toEqual({ archived: 1, group_id: "hiring" });
    expect((await store.sync()).pending).toBe(1);

    // 2. Meanwhile a Workflow on the Server moves the Thread and, by its own
    //    clock later than T1, puts it back in the inbox.
    const T2 = "2026-09-16T10:02:00.000Z";
    server.write({
      threadId: "e1",
      actor: "automation",
      at: T2,
      patch: { group: "finance", subgroup: null, archived: false },
    });
    expect(server.threads.get("e1")).toMatchObject({ archived: false, group: "finance" });

    // 3. Back online: the Outbox replays first, then the feed is pulled.
    server.offline = false;
    const result = await store.sync();
    expect(result.error).toBeNull();
    expect(result.pushed).toBe(1);
    expect(result.pending).toBe(0);

    // The Server applied the user's archive over automation's later write
    // (user beats automation) and kept the move (a different field group).
    const onServer = server.threads.get("e1");
    expect(onServer).toMatchObject({ archived: true, group: "finance" });
    expect(onServer?.writes.archived).toEqual({ at: T1, by: "user" });
    expect(onServer?.writes.placement).toEqual({ at: T2, by: "automation" });

    // The Cache agrees, and the row never came back into the stream on the way.
    const local = await threadRow(store, "e1");
    expect(local.archived).toBe(true);
    expect(local.group).toBe("finance");
    await until(() => seen.length === 3);
    expect(seen).toEqual([
      { archived: 0, group_id: "hiring" },
      { archived: 1, group_id: "hiring" },
      { archived: 1, group_id: "finance" },
    ]);
    expect(seen.some((s, i) => i > 0 && s.archived === 0)).toBe(false);
  });

  test("a feed row for a thread with pending intents keeps the pending state on screen", async () => {
    const { store, server } = await open();
    server.offline = true;
    await store.intent({ kind: "archive", threadId: "e2" });
    // A change for e2 arrives (new message bumped it) before the Outbox drains.
    server.write({
      threadId: "e2",
      actor: "automation",
      at: "2026-09-16T10:00:00.000Z",
      patch: { unread: true },
    });
    // Reads are possible, writes are not: simulate a feed pull with intents still queued.
    server.offline = false;
    const original = server.applyIntent.bind(server);
    server.applyIntent = () => {
      throw new Error("write path down");
    };
    const result = await store.sync();
    expect(result.pending).toBe(1);
    // The pull did not run because the drain failed; pull alone keeps the archive too.
    server.applyIntent = original;
    const changes: Change[] = server.list(0, 100).changes;
    expect(changes.length).toBe(1);
    const done = await store.sync();
    expect(done.pending).toBe(0);
    expect((await threadRow(store, "e2")).archived).toBe(true);
  });

  test("an intent that loses on the server is overwritten by the feed", async () => {
    const { store, server } = await open();
    // The user starred e3 at T2 on another Device; this Device un-stars it at T1, older.
    server.write({
      threadId: "e3",
      actor: "user",
      at: "2026-09-16T10:02:00.000Z",
      patch: { starred: true },
    });
    await store.sync();
    expect((await threadRow(store, "e3")).starred).toBe(true);
    await store.intent({ kind: "unstar", threadId: "e3", at: "2026-09-16T10:01:00.000Z" });
    expect((await threadRow(store, "e3")).starred).toBe(false);
    const result = await store.sync();
    expect(result.error).toBeNull();
    expect(result.pending).toBe(0);
    // The Server said applied: false; the row has no change of its own, so the
    // local state stands until the next change for that Thread arrives.
    server.write({
      threadId: "e3",
      actor: "automation",
      at: "2026-09-16T10:03:00.000Z",
      patch: { unread: false },
    });
    await store.sync();
    expect((await threadRow(store, "e3")).starred).toBe(true);
  });
});

describe("subscribe", () => {
  test("syncs on open and on every wake, and reconnects with backoff after a drop", async () => {
    const { store, server } = await open();
    const statuses: string[] = [];
    store.onStatus((s) => statuses.push(s));
    const unsubscribe = store.subscribe();
    await until(() => server.connections() === 1);
    await until(() => store.status() === "online");

    server.write({
      threadId: "e1",
      actor: "automation",
      at: "2026-09-16T10:00:00.000Z",
      patch: { unread: false },
    });
    await until(() => statuses.includes("syncing"));
    await tick(30);
    expect((await threadRow(store, "e1")).unread).toBe(false);

    server.dropConnections();
    await until(() => store.status() === "offline");
    await until(() => server.connections() === 1, 1_000);
    await until(() => store.status() === "online");

    // Intents made while subscribed reach the Server without an explicit sync.
    await store.intent({ kind: "star", threadId: "e2" });
    await until(() => server.threads.get("e2")?.starred === true);

    unsubscribe();
    expect(server.connections()).toBe(0);
    expect(store.status()).toBe("offline");
    await store.close();
  });
});
