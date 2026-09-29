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
  DEFAULT_SIGNAL_RULES,
  defaultSettings,
  laneView,
  SUPPORT_TODAY_VIEW,
  scopeSince,
  viewSignalId,
} from "@monday/shared";
import { navModel } from "../shell/nav.ts";
import { bunDriver } from "../store/bun-driver.ts";
import { createFakeStore } from "../store/fake.ts";
import { type CachedViewThread, rowToViewThread, viewThreadsSql } from "../store/views.ts";
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
});
