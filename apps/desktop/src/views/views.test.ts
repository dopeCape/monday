// Views in the Cache (slice 39; docs/spec/views.md): the feed's `view` row
// marks the mirror stale and the sync reads the documents whole; a View's
// Lanes are one query over threads, thread_signals and thread_facts in
// SQLite, computed on the Device; a new support Thread lands in its Lane as
// soon as its Signal answers arrive and the nav count follows without a
// reload (acceptance 4); an undecided Thread sits in Unsure, never Green
// (acceptance 2); the nav lists Views above Groups with their counts.

import { describe, expect, test } from "bun:test";
import type { LaneView, SignalsChange, View } from "@monday/shared";
import {
  AMAZON_ORDERS_VIEW,
  DEFAULT_SIGNAL_RULES,
  defaultSettings,
  laneView,
  SUPPORT_TODAY_VIEW,
  scopeSince,
  viewExtractionId,
  viewSignalId,
} from "@monday/shared";
import { navModel } from "../shell/nav.ts";
import { bunDriver } from "../store/bun-driver.ts";
import { createFakeStore } from "../store/fake.ts";
import {
  type CachedViewThread,
  rowToViewReading,
  rowToViewThread,
  VIEW_READING_SQL,
  viewThreadsSql,
  viewValuesStatements,
} from "../store/views.ts";
import { createViewSync } from "./cache.ts";

const NOW = new Date("2026-09-29T15:00:00Z");
const ctx = { rules: DEFAULT_SIGNAL_RULES, now: NOW, zone: "UTC", owner: "sam@acme.com" };
const own = (id: string) => viewSignalId(SUPPORT_TODAY_VIEW.id, id);

const VIEW: View = {
  id: SUPPORT_TODAY_VIEW.id,
  workspaceId: "ws",
  version: 1,
  pinned: true,
  position: 0,
  deletedAt: null,
  createdAt: "2026-09-29T08:00:00.000Z",
  updatedAt: "2026-09-29T08:00:00.000Z",
  doc: SUPPORT_TODAY_VIEW,
  placements: {},
  checkBar: false,
  done: {},
};

function answers(threadId: string, support: number, severity: number): SignalsChange {
  const a = (signalId: string, v: { noul?: number; score?: number }) => ({
    signalId,
    version: 1,
    noul: v.noul ?? null,
    choice: null,
    score: v.score ?? null,
    confidence: v.score !== undefined ? 0.9 : null,
    stale: false,
    lowTrust: null,
    judgedAt: "2026-09-29T10:00:00.000Z",
  });
  return {
    threadId,
    answers: [
      a(own("is_support_request"), { noul: support }),
      a(own("severity"), { score: severity }),
      a("frustrated", { score: 0 }),
    ],
  };
}

describe("Views over the Cache", () => {
  test("the mirror, the Lanes from SQL, a new Thread landing live, and the nav", async () => {
    const { store, server } = await createFakeStore({
      driver: bunDriver(),
      seed: null,
      workspaceId: "ws",
    });
    const addThread = (id: string, subject: string, from: string, to = "support@acme.com") => {
      server.record({
        kind: "thread",
        entityId: id,
        payload: {
          id,
          workspaceId: "ws",
          subject,
          participants: [{ name: "", email: from }],
          lastActivity: "2026-09-29T10:00:00.000Z",
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
          snippet: subject,
          deleted: false,
        },
      });
      server.record({
        kind: "message",
        entityId: `m-${id}`,
        payload: {
          id: `m-${id}`,
          threadId: id,
          from: { name: "", email: from },
          to: [{ name: "Support", email: to }],
          cc: [],
          date: "2026-09-29T10:00:00.000Z",
          hasAttachments: false,
        },
      });
    };

    // The feed says a View changed: the row is stale until the list is read.
    server.record({
      kind: "view",
      entityId: VIEW.id,
      payload: {
        id: VIEW.id,
        version: 1,
        pinned: true,
        position: 0,
        deleted: false,
        updatedAt: VIEW.updatedAt,
      },
    });
    await store.sync();
    expect(await store.query("select id, content_stale, doc from views")).toEqual([
      { id: VIEW.id, content_stale: 1, doc: null },
    ]);
    let listed = 0;
    const sync = createViewSync(store, async () => {
      listed += 1;
      return [VIEW];
    });
    expect(await sync.refresh()).toBe(true);
    expect(listed).toBe(1);
    const [row] = await store.query<{ content_stale: number; doc: string }>("select * from views");
    expect(row?.content_stale).toBe(0);
    expect(JSON.parse(row?.doc ?? "{}").name).toBe("Support today");

    addThread("t-broken", "The export is broken", "ana@customer.test");
    addThread("t-seats", "Question about seats", "bo@customer.test");
    addThread("t-lunch", "Lunch", "lee@friend.test", "sam@acme.com");
    server.record({ kind: "signals", entityId: "t-broken", payload: answers("t-broken", 0.95, 2) });
    server.record({ kind: "signals", entityId: "t-seats", payload: answers("t-seats", 0.5, 0) });
    await store.sync();

    const q = viewThreadsSql(
      SUPPORT_TODAY_VIEW.scope.facts,
      scopeSince(SUPPORT_TODAY_VIEW.scope.facts, NOW, "UTC"),
      1000,
    );
    const views: LaneView<CachedViewThread>[] = [];
    const live = store.live<Record<string, unknown>>(q.sql, q.params);
    const off = live.subscribe((rows) =>
      views.push(
        laneView(
          SUPPORT_TODAY_VIEW,
          rows.map((r) => rowToViewThread(r, "ws")),
          ctx,
        ),
      ),
    );
    await live.refresh();
    const first = views.at(-1);
    if (!first) throw new Error("no lanes");
    const lane = (v: LaneView<CachedViewThread>, id: string) =>
      v.lanes.find((l) => l.id === id)?.rows.map((r) => r.thread.id) ?? [];
    expect(lane(first, "red")).toEqual(["t-broken"]);
    // Undecided whether it is a support request: Unsure, never Green.
    expect(lane(first, "unsure")).toEqual(["t-seats"]);
    expect(lane(first, "green")).toEqual([]);
    // The lunch is not in the scope (not to support@).
    expect(first.total).toBe(2);
    expect(first.navCount).toBe(1);

    // A new support Thread arrives while the View is open: first not read yet, then its Lane.
    addThread("t-down", "Everything is down", "cy@customer.test");
    await store.sync();
    await live.refresh();
    const arrived = views.at(-1);
    if (!arrived) throw new Error("no lanes");
    expect(lane(arrived, "unsure")).toContain("t-down");
    expect(
      arrived.lanes.find((l) => l.id === "unsure")?.rows.find((r) => r.thread.id === "t-down")
        ?.placement.notRead,
    ).toBe(true);
    server.record({ kind: "signals", entityId: "t-down", payload: answers("t-down", 0.97, 2) });
    const before = views.length;
    await store.sync();
    await live.refresh();
    expect(views.length).toBeGreaterThan(before);
    const answered = views.at(-1);
    if (!answered) throw new Error("no lanes");
    expect(lane(answered, "red").sort()).toEqual(["t-broken", "t-down"]);
    expect(answered.navCount).toBe(2);
    off();
    live.close();

    // The nav: Views under their own heading above Groups, with the count, and in the rail.
    const nav = navModel({
      address: "sam@acme.com",
      status: "online",
      threads: [],
      groups: [],
      views: [{ id: VIEW.id, name: "Support today", icon: "lifebuoy" }],
      viewCounts: { [VIEW.id]: answered.navCount },
      viewsLabel: "Views",
      strings: defaultSettings(),
    });
    expect(nav.views).toEqual([
      expect.objectContaining({ key: `views:${VIEW.id}`, label: "Support today", count: 2 }),
    ]);
    expect(nav.labels.views).toBe("Views");
    expect(nav.rail.some((r) => r.key === `views:${VIEW.id}`)).toBe(true);

    // Deleted on the Server: the next read of the list drops it.
    server.record({
      kind: "view",
      entityId: VIEW.id,
      payload: {
        id: VIEW.id,
        version: 1,
        pinned: true,
        position: 0,
        deleted: true,
        updatedAt: "2026-09-29T11:00:00.000Z",
      },
    });
    await store.sync();
    const gone = createViewSync(store, async () => []);
    await gone.refresh();
    expect(await store.query("select deleted from views")).toEqual([{ deleted: 1 }]);
    sync.stop();
    gone.stop();
    await store.close();
  });

  test("picked values: read once per View, again for the Threads the feed names, and drawn from SQL", async () => {
    const { store, server } = await createFakeStore({
      driver: bunDriver(),
      seed: null,
      workspaceId: "ws",
    });
    const doc = AMAZON_ORDERS_VIEW;
    const amazonView: View = { ...VIEW, id: doc.id, doc };
    const total = viewExtractionId(doc.id, "order_total");
    server.record({
      kind: "thread",
      entityId: "o1",
      payload: {
        id: "o1",
        workspaceId: "ws",
        subject: "Your order of a lamp",
        participants: [{ name: "Amazon.com", email: "orders@amazon.com" }],
        lastActivity: "2026-10-02T09:00:00.000Z",
        messageCount: 1,
        unread: false,
        starred: false,
        archived: false,
        snoozedUntil: null,
        section: null,
        group: null,
        subgroup: null,
        tags: [],
        labels: [],
        hasAttachments: false,
        snippet: "Order total: $120.00",
        deleted: false,
      },
    });
    server.record({
      kind: "message",
      entityId: "m-o1",
      payload: {
        id: "m-o1",
        threadId: "o1",
        from: { name: "Amazon.com", email: "orders@amazon.com" },
        to: [{ name: "Sam", email: "sam@acme.com" }],
        cc: [],
        date: "2026-10-02T09:00:00.000Z",
        hasAttachments: false,
      },
    });
    server.record({
      kind: "signals",
      entityId: "o1",
      payload: {
        threadId: "o1",
        answers: [
          {
            signalId: total,
            version: 1,
            noul: null,
            choice: "picked",
            score: null,
            confidence: 0.9,
            stale: false,
            lowTrust: null,
            judgedAt: "2026-10-02T09:01:00.000Z",
          },
        ],
      },
    });
    await store.sync();
    let reads = 0;
    let latest = { value: 120, currency: "USD" };
    const sync = createViewSync(store, {
      list: async () => [amazonView],
      values: async () => {
        reads += 1;
        return { o1: { [total]: { text: "$120.00", value: latest, confidence: 0.9 } } };
      },
      valuesFor: async (_ws, ids) => {
        expect([...ids]).toEqual(["o1"]);
        return { o1: { [total]: { text: "$99.00", value: latest, confidence: 0.9 } } };
      },
    });
    await sync.refresh();
    await sync.refresh();
    // Read once for this View version, however often the list is read.
    expect(reads).toBe(1);
    const read = async () => {
      const q = viewThreadsSql(doc.scope.facts, null, 100, "sam@acme.com");
      const rows = await store.query<Record<string, unknown>>(q.sql, q.params);
      return rows.map((r) => rowToViewThread(r, "ws"));
    };
    const [first] = await read();
    expect(first?.values?.[total]?.text).toBe("$120.00");
    expect(first?.correspondent).toEqual({ name: "Amazon.com", email: "orders@amazon.com" });
    // The feed names the Thread: its values are read again.
    latest = { value: 99, currency: "USD" };
    server.record({ kind: "view_values", entityId: "o1", payload: { threadId: "o1" } });
    await store.sync();
    for (let i = 0; i < 20; i++) {
      const [t] = await read();
      if (t?.values?.[total]?.text === "$99.00") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const [again] = await read();
    expect(again?.values?.[total]).toEqual({
      text: "$99.00",
      value: { value: 99, currency: "USD" },
      confidence: 0.9,
    });
    expect(await store.query("select * from view_values_stale")).toEqual([]);
    sync.stop();
    await store.close();
  });
});

describe("A View's scope narrows in SQL before the limit", () => {
  test("the newest Threads of a few senders are found under many newer ones of others", async () => {
    const { store, server } = await createFakeStore({
      driver: bunDriver(),
      seed: null,
      workspaceId: "ws",
    });
    const add = (
      id: string,
      from: string,
      at: string,
      to = "sam@acme.com",
      cc: string[] = [],
      subject = id,
    ) => {
      server.record({
        kind: "thread",
        entityId: id,
        payload: {
          id,
          workspaceId: "ws",
          subject,
          participants: [{ name: "", email: from }],
          lastActivity: at,
          messageCount: 1,
          unread: false,
          starred: false,
          archived: true,
          snoozedUntil: null,
          section: null,
          group: null,
          subgroup: null,
          tags: [],
          labels: [],
          hasAttachments: false,
          snippet: id,
          deleted: false,
        },
      });
      server.record({
        kind: "message",
        entityId: `m-${id}`,
        payload: {
          id: `m-${id}`,
          threadId: id,
          from: { name: "", email: from },
          to: [{ name: "", email: to }],
          cc: cc.map((email) => ({ name: "", email })),
          date: at,
          hasAttachments: false,
        },
      });
    };
    // Three orders months ago, then 250 newer newsletters from someone else.
    add("o1", "Auto-Confirm@amazon.in", "2026-03-01T10:00:00.000Z");
    add("o2", "orders@myntra.com", "2026-04-01T10:00:00.000Z", "sam@acme.com", ["me@home.test"]);
    add("o3", "auto-confirm@amazon.in", "2026-05-01T10:00:00.000Z");
    for (let i = 0; i < 250; i++) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      add(`n${i}`, "digest@substack.com", `2026-09-${day}T0${i % 10}:00:00.000Z`);
    }
    await store.sync();
    const ids = async (facts: Parameters<typeof viewThreadsSql>[0]) => {
      const q = viewThreadsSql(facts, null, 20, "sam@acme.com");
      const rows = await store.query<Record<string, unknown>>(q.sql, q.params);
      return rows.map((r) => rowToViewThread(r, "ws").id);
    };
    expect(
      await ids({ folder: "any", from_any: ["auto-confirm@amazon.in", "orders@myntra.com"] }),
    ).toEqual(["o3", "o2", "o1"]);
    expect(await ids({ folder: "any", from_domain: ["amazon.in"] })).toEqual(["o3", "o1"]);
    expect(await ids({ folder: "any", to_any: ["me@home.test"] })).toEqual(["o2"]);
    expect((await ids({ folder: "any", from_domain_not: ["substack.com"] })).sort()).toEqual([
      "o1",
      "o2",
      "o3",
    ]);
    // The inbox holds none of them: every one is archived.
    expect(await ids({ folder: "inbox", from_domain: ["amazon.in"] })).toEqual([]);
    // Words in the subject narrow in SQL too, and the View code checks them exactly.
    add(
      "s1",
      "shop@flo.test",
      "2026-02-01T10:00:00.000Z",
      "sam@acme.com",
      [],
      "Your Order Confirmation #123",
    );
    await store.sync();
    expect(await ids({ folder: "any", subject_any: ["order confirmation"] })).toEqual(["s1"]);

    // Many values and per-row answers ride in view_values and come back whole.
    const items = [
      { key: "a", text: "1,250 INR", value: { value: 1250, currency: "INR" }, confidence: 0.95 },
      {
        key: "b",
        text: "830 INR",
        value: { value: 830, currency: "INR" },
        confidence: 0.5,
        unsure: true,
        message: "m-o3",
        at: "2026-05-01T10:00:00.000Z",
      },
    ];
    await store.write(
      viewValuesStatements(
        {
          o3: {
            "board:v:x_total": {
              text: "1,250 INR",
              value: items[0]?.value ?? null,
              confidence: 0.95,
              items,
            },
            "board:v:severity": {
              text: "each",
              value: null,
              confidence: 1,
              answers: { a: { choice: "critical", confidence: 0.9 } },
            },
            "board:v:x_one": { text: "#123", value: "123", confidence: 0.8 },
          },
        },
        ["o3"],
      ),
    );
    const q = viewThreadsSql(
      { folder: "any", from_domain: ["amazon.in"] },
      null,
      5,
      "sam@acme.com",
    );
    const [o3] = (await store.query<Record<string, unknown>>(q.sql, q.params)).map((r) =>
      rowToViewThread(r, "ws"),
    );
    expect(o3?.values?.["board:v:x_total"]?.items).toEqual(items);
    expect(o3?.values?.["board:v:severity"]?.answers).toEqual({
      a: { choice: "critical", confidence: 0.9 },
    });
    expect(o3?.values?.["board:v:x_one"]).toEqual({ text: "#123", value: "123", confidence: 0.8 });
    await store.close();
  });
});

describe("a pinned View's reading", () => {
  test("the feed's view_reading rows keep the View's bar live: N of M, then done", async () => {
    const { store, server } = await createFakeStore({
      driver: bunDriver(),
      seed: null,
      workspaceId: "ws",
    });
    const read = async () =>
      (await store.query<Record<string, unknown>>(VIEW_READING_SQL, ["v_orders"])).map(
        rowToViewReading,
      );
    expect(await read()).toEqual([]);
    const reading = (done: number, status: "running" | "waiting" | "done", reason = null) => ({
      kind: "view_reading" as const,
      entityId: "v_orders",
      payload: { viewId: "v_orders", status, reason, done, total: 40 },
    });
    server.record(reading(12, "running"));
    await store.sync();
    expect(await read()).toEqual([
      { viewId: "v_orders", status: "running", reason: null, done: 12, total: 40 },
    ]);
    server.record({
      kind: "view_reading",
      entityId: "v_orders",
      payload: { viewId: "v_orders", status: "waiting", reason: "budget", done: 24, total: 40 },
    });
    server.record(reading(40, "done"));
    await store.sync();
    expect(await read()).toEqual([
      { viewId: "v_orders", status: "done", reason: null, done: 40, total: 40 },
    ]);
    await store.close();
  });
});

describe("a View whose scope is a full search, over the Cache", () => {
  test("its members stand in for the search: read whole once, then kept by the feed, and read offline", async () => {
    const { store, server } = await createFakeStore({
      driver: bunDriver(),
      seed: null,
      workspaceId: "ws",
    });
    const add = (id: string, from: string, at: string) => {
      server.record({
        kind: "thread",
        entityId: id,
        payload: {
          id,
          workspaceId: "ws",
          subject: `Update ${id}`,
          participants: [{ name: "", email: from }],
          lastActivity: at,
          messageCount: 1,
          unread: false,
          starred: false,
          archived: true,
          snoozedUntil: null,
          section: null,
          group: null,
          subgroup: null,
          tags: [],
          labels: [],
          hasAttachments: false,
          snippet: id,
          deleted: false,
        },
      });
      server.record({
        kind: "message",
        entityId: `m-${id}`,
        payload: {
          id: `m-${id}`,
          threadId: id,
          from: { name: "", email: from },
          to: [{ name: "", email: "sam@acme.com" }],
          cc: [],
          date: at,
          hasAttachments: false,
        },
      });
    };
    // Two refunds months ago, under thirty newer newsletters; the words are only in their bodies.
    add("r1", "support@shop.test", "2026-04-01T10:00:00.000Z");
    add("r2", "support@shop.test", "2026-05-01T10:00:00.000Z");
    for (let i = 0; i < 30; i++)
      add(
        `n${i}`,
        "news@paper.test",
        `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T08:00:00.000Z`,
      );
    await store.sync();
    const doc = {
      ...AMAZON_ORDERS_VIEW,
      id: "v_refunds",
      scope: { facts: { query: '"refund approved"', folder: "any" as const }, limit: 100 },
      nav: { icon: "receipt", count: "total" },
    };
    const view: View = { ...VIEW, id: doc.id, doc };
    let online = true;
    let memberReads = 0;
    const sync = createViewSync(store, {
      list: async () => {
        if (!online) throw new Error("offline");
        return [view];
      },
      members: async () => {
        memberReads += 1;
        return ["r1"];
      },
    });
    await sync.refresh();
    await sync.refresh();
    expect(memberReads).toBe(1);
    const read = async () => {
      const q = viewThreadsSql(doc.scope.facts, null, 20, "sam@acme.com", doc.id);
      const rows = await store.query<Record<string, unknown>>(q.sql, q.params);
      return rows.map((r) => rowToViewThread(r, "ws"));
    };
    expect((await read()).map((t) => t.id)).toEqual(["r1"]);
    // The feed adds a member the walk found, and takes one out.
    server.record({
      kind: "view_members",
      entityId: doc.id,
      payload: { viewId: doc.id, added: ["r2"], removed: [] },
    });
    await store.sync();
    expect((await read()).map((t) => t.id)).toEqual(["r2", "r1"]);
    // Offline: the View still opens from the Cache, with its count.
    online = false;
    expect(await sync.refresh()).toBe(false);
    const threads = await read();
    expect(threads.map((t) => t.id)).toEqual(["r2", "r1"]);
    expect(laneView(doc, threads, ctx).navCount).toBe(2);
    // Another View's members are not this one's.
    const other = viewThreadsSql(doc.scope.facts, null, 20, "sam@acme.com", "v_other");
    expect(await store.query(other.sql, other.params)).toEqual([]);
    server.record({
      kind: "view_members",
      entityId: doc.id,
      payload: { viewId: doc.id, added: [], removed: ["r1"] },
    });
    await store.sync();
    expect((await read()).map((t) => t.id)).toEqual(["r2"]);
    // A new query: the reset empties it before its own members come.
    server.record({
      kind: "view_members",
      entityId: doc.id,
      payload: { viewId: doc.id, added: [], removed: [], reset: true },
    });
    await store.sync();
    expect(await read()).toEqual([]);
    // The bar while it searches: done of total, and how many match so far.
    server.record({
      kind: "view_reading",
      entityId: doc.id,
      payload: {
        viewId: doc.id,
        status: "running",
        reason: null,
        done: 200,
        total: 1200,
        phase: "search",
        found: 4,
      },
    });
    await store.sync();
    expect(
      (await store.query<Record<string, unknown>>(VIEW_READING_SQL, [doc.id])).map(
        rowToViewReading,
      ),
    ).toEqual([
      {
        viewId: doc.id,
        status: "running",
        reason: null,
        done: 200,
        total: 1200,
        phase: "search",
        found: 4,
      },
    ]);
    sync.stop();
    await store.close();
  });
});
