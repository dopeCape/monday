// The full search (ADR 0015) through the Mailstore, POST /search/full and the
// Agent's search tool: old encrypted bodies are found, the stream is progress
// then hits newest first then done, the limit stops it with a cursor that
// resumes, SQL filters run before anything is decrypted, and an aborted
// request stops the scan.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, FullSearchEvent, Person } from "@monday/shared";
import { parseQuery } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { createDrafts } from "../src/drafts/index.ts";
import { createServerToolHost } from "../src/intelligence/agent/host.ts";
import { TOOL_CATALOG, type ToolContext } from "../src/intelligence/agent/tools/catalog.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const account: Account = {
  id: "acct-full",
  provider: "jmap",
  address: "tejas@genai-labs.io",
  displayName: "Tejas",
  capabilities: {
    push: true,
    labels: true,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

const KENJI: Person = { name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" };
const AOIFE: Person = { name: "Aoife Brennan", email: "aoife@northlight.dev" };
const ME: Person = { name: "Tejas", email: "tejas@genai-labs.io" };
const TOKEN = "per-launch-token";

/** Day `n` of 2024, so every Thread is years past any Cache window. */
const day = (n: number) => new Date(Date.UTC(2024, 0, 1) + n * 86_400_000).toISOString();

describe("full search", () => {
  let db: TestDatabase;
  let keys: Keys;
  /** Envelopes opened through the full search's opener. */
  let opened = 0;
  let store: Mailstore;
  let app: Hono<AppEnv>;
  let ws = "";
  const IDS: Record<string, string> = {};
  const id = (key: string): string => {
    const v = IDS[key];
    if (!v) throw new Error(`no Thread ${key}`);
    return v;
  };
  const root = randomKey();

  const seed = async (
    key: string,
    subject: string,
    from: Person,
    date: string,
    body: string,
    extra: { unread?: boolean; archived?: boolean } = {},
  ) => {
    const threadId = await store.upsertThread({
      workspaceId: ws,
      providerThreadId: key,
      subject,
      participants: [from, ME],
      lastActivity: date,
      ...extra,
    });
    IDS[key] = threadId;
    await store.upsertMessage({
      threadId,
      providerMessageId: `${key}-0`,
      from,
      to: [ME],
      cc: [],
      date,
      headers: {},
      bodyText: body,
      bodyHtml: null,
      snippet: body.slice(0, 20),
    });
  };

  beforeAll(async () => {
    db = await testDatabase();
    const real = createKeys(db.handle.db);
    // The seam the scan decrypts through, counted.
    keys = {
      ...real,
      unwrapper: async (workspaceId) => {
        const unwrap = await real.unwrapper(workspaceId);
        return (wrapped) => {
          opened += 1;
          return unwrap(wrapped);
        };
      },
    };
    store = createMailstore(db.handle.db, keys);
    await keys.unlock(root);
    const auth = createAuth({ db: db.handle.db, sidecarToken: TOKEN, setupCode: "111111" });
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      keys,
      mailstore: store,
      remoteAddress: () => "127.0.0.1",
    });
    ws = (await store.createWorkspace(account)).id;

    await seed(
      "clause",
      "Board observer seat",
      KENJI,
      day(10),
      "The pro-rata clause is now capped.",
    );
    await seed("clause-2", "Re: side letter", AOIFE, day(5), "Aoife on the pro-rata question.", {
      archived: true,
    });
    await seed("subject", "Pro-rata rights memo", AOIFE, day(3), "See attached.");
    // Twelve Threads that all say zebra, newest first by day, from alternating senders.
    for (let i = 0; i < 12; i++) {
      await seed(
        `zebra-${i}`,
        `Migration ${i}`,
        i % 2 === 0 ? KENJI : AOIFE,
        day(100 + i),
        `the zebra migration step ${i}`,
        { unread: i % 3 === 0 },
      );
    }
    for (let i = 0; i < 20; i++) {
      await seed(`noise-${i}`, `Weekly notes ${i}`, AOIFE, day(200 + i), "nothing to see here");
    }
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  const collect = async (
    q: string,
    options: { limit?: number; cursor?: string | null; pageSize?: number } = {},
  ) => {
    const events: FullSearchEvent[] = [];
    const run = await store.searchFull(ws, {
      query: parseQuery(q),
      limit: options.limit ?? 100,
      cursor: options.cursor ?? null,
      pageSize: options.pageSize ?? 5,
      concurrency: 2,
    });
    for await (const e of run) events.push(e);
    const hits = events.flatMap((e) => (e.type === "hit" ? [e] : []));
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("no done line");
    return { events, hits, done, threadIds: hits.map((h) => h.thread.id) };
  };

  test("finds a word that exists only in old encrypted bodies, newest first, archived included", async () => {
    const r = await collect("pro-rata");
    // The body matches and the subject match, newest activity first.
    expect(r.threadIds).toEqual([id("clause"), id("clause-2"), id("subject")]);
    const first = r.hits[0];
    expect(first?.thread.subject).toBe("Board observer seat");
    expect(first?.snippet).toContain("pro-rata clause");
    expect(r.done).toMatchObject({ reason: "exhausted", cursor: null, hits: 3 });
    expect(r.done.total).toBe(35);
    expect(r.done.scanned).toBe(35);
    // Operators are the shared parser's: a phrase, a negation, a date.
    expect((await collect('"pro-rata clause"')).threadIds).toEqual([id("clause")]);
    expect((await collect("pro-rata -capped")).threadIds).toEqual([id("clause-2"), id("subject")]);
    expect((await collect("pro-rata before:2024-01-08")).threadIds).toEqual([
      id("clause-2"),
      id("subject"),
    ]);
    expect((await collect("subject:memo")).threadIds).toEqual([id("subject")]);
    expect((await collect("from:kenji pro-rata")).threadIds).toEqual([id("clause")]);
  });

  test("streams progress, then hits in order, then done, over POST /search/full", async () => {
    const res = await app.request("/search/full", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify({ workspace: ws, q: "zebra" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as FullSearchEvent);
    expect(lines[0]).toEqual({ type: "progress", scanned: 0, total: 35, cursor: null });
    expect(lines[lines.length - 1]?.type).toBe("done");
    const hitDates = lines.flatMap((l) => (l.type === "hit" ? [l.thread.lastActivity] : []));
    expect(hitDates.length).toBe(12);
    expect(hitDates).toEqual([...hitDates].sort().reverse());
    // Progress climbs and never passes the total.
    const scanned = lines.flatMap((l) => (l.type === "progress" ? [l.scanned] : []));
    expect(scanned).toEqual([...scanned].sort((a, b) => a - b));
    expect(Math.max(...scanned)).toBe(35);

    // Without the stream header the same search answers one JSON document.
    const plain = await app.request("/search/full", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: ws, q: "zebra", limit: 2 }),
    });
    const json = (await plain.json()) as { hits: unknown[]; done: { reason: string } };
    expect(json.hits.length).toBe(2);
    expect(json.done.reason).toBe("limit");

    const empty = await app.request("/search/full", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: ws, q: "   " }),
    });
    expect(empty.status).toBe(400);
  });

  test("stops at the limit with a cursor, and the cursor resumes where it stopped", async () => {
    const first = await collect("zebra", { limit: 5 });
    expect(first.hits.length).toBe(5);
    expect(first.done.reason).toBe("limit");
    expect(first.done.cursor).not.toBeNull();
    const second = await collect("zebra", { limit: 5, cursor: first.done.cursor });
    const third = await collect("zebra", { limit: 5, cursor: second.done.cursor });
    const all = [...first.threadIds, ...second.threadIds, ...third.threadIds];
    expect(new Set(all).size).toBe(12);
    expect(all).toEqual(Array.from({ length: 12 }, (_, i) => id(`zebra-${11 - i}`)));
    // Progress carries on across the resumes; the last one ends the mailbox.
    expect(second.done.scanned).toBeGreaterThan(first.done.scanned);
    expect(third.done.reason).toBe("exhausted");
    expect(third.done.cursor).toBeNull();
    expect(third.done.scanned).toBe(35);

    // A progress line's cursor resumes too, for a client that pressed Stop.
    const whole = await collect("zebra", { pageSize: 5 });
    const at = whole.events.findIndex(
      (e) => e.type === "progress" && e.cursor !== null && e.scanned === 20,
    );
    const mid = whole.events[at];
    if (mid?.type !== "progress" || !mid.cursor) throw new Error("no progress cursor");
    const before = whole.events.slice(0, at).flatMap((e) => (e.type === "hit" ? [e] : []));
    const after = await collect("zebra", { cursor: mid.cursor });
    expect([...before, ...after.hits].map((h) => h.thread.id)).toEqual(whole.threadIds);
    expect(after.done.scanned).toBe(35);
  });

  test("filters in SQL before decrypting: fewer envelopes are opened", async () => {
    const all = await collect("zebra");
    const fromKenji = await collect("zebra from:kenji");
    const unread = await collect("zebra is:unread");
    expect(fromKenji.threadIds).toEqual([10, 8, 6, 4, 2, 0].map((i) => id(`zebra-${i}`)));
    expect(unread.threadIds).toEqual([9, 6, 3, 0].map((i) => id(`zebra-${i}`) as string));
    expect(fromKenji.done.total).toBe(7);
    expect(unread.done.total).toBeLessThan(all.done.total);
    expect(fromKenji.done.decrypted).toBeLessThan(all.done.decrypted);
    expect(unread.done.decrypted).toBeLessThan(all.done.decrypted);
    // A query over clear headers alone opens nothing at all.
    opened = 0;
    const headersOnly = await collect("from:kenji is:unread");
    expect(headersOnly.done.decrypted).toBe(headersOnly.hits.length);
    expect(opened).toBe(headersOnly.hits.length);
    // The count on the line is the seam's count.
    opened = 0;
    const counted = await collect("zebra from:kenji");
    expect(opened).toBe(counted.done.decrypted);
  });

  test("an aborted request stops the scan", async () => {
    const controller = new AbortController();
    const res = await app.request("/search/full", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify({ workspace: ws, q: "nothing-matches-this" }),
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"progress"');
    opened = 0;
    await reader.cancel();
    controller.abort();
    const at = opened;
    await Bun.sleep(100);
    // Nothing more is decrypted once the client has gone; a full scan opens 70.
    expect(opened).toBe(at);
    expect(opened).toBeLessThan(70);

    // And through the Mailstore: an abort between Threads ends the iterator.
    const stop = new AbortController();
    const run = await store.searchFull(ws, {
      query: parseQuery("zebra"),
      limit: 100,
      pageSize: 2,
      concurrency: 1,
      signal: stop.signal,
    });
    const seen: FullSearchEvent[] = [];
    for await (const e of run) {
      seen.push(e);
      if (e.type === "hit") stop.abort();
    }
    expect(seen.filter((e) => e.type === "hit").length).toBe(1);
    expect(seen.some((e) => e.type === "done")).toBe(false);
  });

  test("answers 423 when locked, before any line", async () => {
    keys.lock();
    try {
      const res = await app.request("/search/full", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({ workspace: ws, q: "zebra" }),
      });
      expect(res.status).toBe(423);
    } finally {
      await keys.unlock(root);
    }
  });

  test("the Agent's search_threads reads bodies over the whole mailbox with full", async () => {
    const host = createServerToolHost({
      db: db.handle.db,
      mailstore: store,
      drafts: createDrafts({ db: db.handle.db, mailstore: store }),
      workspaceId: ws,
    });
    const tool = TOOL_CATALOG.find((t) => t.name === "search_threads");
    if (!tool) throw new Error("no search_threads");
    const ctx = {
      host,
      pinned: new Set<string>(),
      settings: { previewAbove: 10, alwaysAsk: [], searchLimit: 50 },
      now: () => new Date("2026-09-29T10:00:00Z"),
      latestUndoable: async () => null,
      undoActivity: async () => ({ text: "" }),
    } satisfies ToolContext;
    const run = async (args: Record<string, unknown>) => {
      const plan = await tool.run(tool.input.parse(args) as never, ctx);
      if (plan.kind !== "result") throw new Error(plan.kind);
      return (plan.data as { threads: { id: string }[] }).threads.map((t) => t.id);
    };
    // The headers index never sees the body.
    expect(await run({ query: "capped" })).toEqual([]);
    expect(await run({ query: "capped", full: true })).toEqual([id("clause")]);
    // Archived mail is part of the whole mailbox.
    expect(await run({ query: "pro-rata", full: true, limit: 2 })).toEqual([
      id("clause"),
      id("clause-2"),
    ]);
    expect(tool.summarize({ query: "capped", full: true } as never)).toContain("whole mailbox");
  });
});
