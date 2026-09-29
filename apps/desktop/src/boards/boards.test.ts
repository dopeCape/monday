// Boards in the Cache (slice 39; docs/spec/boards.md): the feed's `board` row
// marks the mirror stale and the sync reads the documents whole; a Board's
// Lanes are one query over threads, thread_signals and thread_facts in
// SQLite, computed on the Device; a new support Thread lands in its Lane as
// soon as its Signal answers arrive and the nav count follows without a
// reload (acceptance 4); an undecided Thread sits in Unsure, never Green
// (acceptance 2); the nav lists Boards above Groups with their counts.

import { describe, expect, test } from "bun:test";
import type { Board, BoardView, SignalsChange } from "@monday/shared";
import {
  boardSignalId,
  boardView,
  DEFAULT_SIGNAL_RULES,
  defaultSettings,
  SUPPORT_TODAY_BOARD,
  scopeSince,
} from "@monday/shared";
import { navModel } from "../shell/nav.ts";
import { boardThreadsSql, type CachedBoardThread, rowToBoardThread } from "../store/boards.ts";
import { bunDriver } from "../store/bun-driver.ts";
import { createFakeStore } from "../store/fake.ts";
import { createBoardSync } from "./cache.ts";

const NOW = new Date("2026-09-29T15:00:00Z");
const ctx = { rules: DEFAULT_SIGNAL_RULES, now: NOW, zone: "UTC", owner: "sam@acme.com" };
const own = (id: string) => boardSignalId(SUPPORT_TODAY_BOARD.id, id);

const BOARD: Board = {
  id: SUPPORT_TODAY_BOARD.id,
  workspaceId: "ws",
  version: 1,
  pinned: true,
  position: 0,
  deletedAt: null,
  createdAt: "2026-09-29T08:00:00.000Z",
  updatedAt: "2026-09-29T08:00:00.000Z",
  doc: SUPPORT_TODAY_BOARD,
  placements: {},
  checkBar: false,
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

describe("Boards over the Cache", () => {
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

    // The feed says a Board changed: the row is stale until the list is read.
    server.record({
      kind: "board",
      entityId: BOARD.id,
      payload: {
        id: BOARD.id,
        version: 1,
        pinned: true,
        position: 0,
        deleted: false,
        updatedAt: BOARD.updatedAt,
      },
    });
    await store.sync();
    expect(await store.query("select id, content_stale, doc from boards")).toEqual([
      { id: BOARD.id, content_stale: 1, doc: null },
    ]);
    let listed = 0;
    const sync = createBoardSync(store, async () => {
      listed += 1;
      return [BOARD];
    });
    expect(await sync.refresh()).toBe(true);
    expect(listed).toBe(1);
    const [row] = await store.query<{ content_stale: number; doc: string }>("select * from boards");
    expect(row?.content_stale).toBe(0);
    expect(JSON.parse(row?.doc ?? "{}").name).toBe("Support today");

    addThread("t-broken", "The export is broken", "ana@customer.test");
    addThread("t-seats", "Question about seats", "bo@customer.test");
    addThread("t-lunch", "Lunch", "lee@friend.test", "sam@acme.com");
    server.record({ kind: "signals", entityId: "t-broken", payload: answers("t-broken", 0.95, 2) });
    server.record({ kind: "signals", entityId: "t-seats", payload: answers("t-seats", 0.5, 0) });
    await store.sync();

    const q = boardThreadsSql(
      SUPPORT_TODAY_BOARD.scope.facts,
      scopeSince(SUPPORT_TODAY_BOARD.scope.facts, NOW, "UTC"),
      1000,
    );
    const views: BoardView<CachedBoardThread>[] = [];
    const live = store.live<Record<string, unknown>>(q.sql, q.params);
    const off = live.subscribe((rows) =>
      views.push(
        boardView(
          SUPPORT_TODAY_BOARD,
          rows.map((r) => rowToBoardThread(r, "ws")),
          ctx,
        ),
      ),
    );
    await live.refresh();
    const first = views.at(-1);
    if (!first) throw new Error("no view");
    const lane = (v: BoardView<CachedBoardThread>, id: string) =>
      v.lanes.find((l) => l.id === id)?.rows.map((r) => r.thread.id) ?? [];
    expect(lane(first, "red")).toEqual(["t-broken"]);
    // Undecided whether it is a support request: Unsure, never Green.
    expect(lane(first, "unsure")).toEqual(["t-seats"]);
    expect(lane(first, "green")).toEqual([]);
    // The lunch is not in the scope (not to support@).
    expect(first.total).toBe(2);
    expect(first.navCount).toBe(1);

    // A new support Thread arrives while the Board is open: first not read yet, then its Lane.
    addThread("t-down", "Everything is down", "cy@customer.test");
    await store.sync();
    await live.refresh();
    const arrived = views.at(-1);
    if (!arrived) throw new Error("no view");
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
    if (!answered) throw new Error("no view");
    expect(lane(answered, "red").sort()).toEqual(["t-broken", "t-down"]);
    expect(answered.navCount).toBe(2);
    off();
    live.close();

    // The nav: Boards under their own heading above Groups, with the count, and in the rail.
    const nav = navModel({
      address: "sam@acme.com",
      status: "online",
      threads: [],
      groups: [],
      boards: [{ id: BOARD.id, name: "Support today", icon: "lifebuoy" }],
      boardCounts: { [BOARD.id]: answered.navCount },
      boardsLabel: "Boards",
      strings: defaultSettings(),
    });
    expect(nav.boards).toEqual([
      expect.objectContaining({ key: `board:${BOARD.id}`, label: "Support today", count: 2 }),
    ]);
    expect(nav.labels.boards).toBe("Boards");
    expect(nav.rail.some((r) => r.key === `board:${BOARD.id}`)).toBe(true);

    // Deleted on the Server: the next read of the list drops it.
    server.record({
      kind: "board",
      entityId: BOARD.id,
      payload: {
        id: BOARD.id,
        version: 1,
        pinned: true,
        position: 0,
        deleted: true,
        updatedAt: "2026-09-29T11:00:00.000Z",
      },
    });
    await store.sync();
    const gone = createBoardSync(store, async () => []);
    await gone.refresh();
    expect(await store.query("select deleted from boards")).toEqual([{ deleted: 1 }]);
    sync.stop();
    gone.stop();
    await store.close();
  });
});
