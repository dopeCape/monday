// The Store's Inbox seam over a Cache bigger than what it holds: each list
// holds its newest rows (inbox.memory_window) and reads the next page on
// more(), a Thread outside every list is read by id, and the totals the nav
// shows are counted over the whole Cache.

import { describe, expect, test } from "bun:test";
import type { Thread } from "@monday/shared";
import { threads as fixtureThreads } from "@monday/ui/fixtures";
import { bunDriver } from "../../store/bun-driver.ts";
import { createFakeStore } from "../../store/fake.ts";
import { fixtureSeed } from "../../store/seed.ts";
import { createStoreInbox, type StoreInbox } from "./store-inbox.ts";

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error("seam did not settle");
}

const TOTAL = 30;
const id = (i: number) => `b${String(i).padStart(2, "0")}`;
/** Thirty Inbox Threads, b00 newest: every other one unread, every third in Investors, every second starred. */
function bigThreads(): Thread[] {
  const base = fixtureThreads[0] as Thread;
  return Array.from({ length: TOTAL }, (_, i) => ({
    ...base,
    id: id(i),
    subject: `Thread ${i}`,
    lastActivity: new Date(Date.UTC(2026, 8, 16, 12, 0) - i * 60_000).toISOString(),
    unread: i % 2 === 0,
    starred: i % 2 === 1,
    archived: false,
    snoozedUntil: null,
    section: "fyi",
    group: i % 3 === 0 ? "investors" : null,
    subgroup: null,
    tags: [],
    labels: [],
  }));
}

async function openBig(
  window: number,
  lookups = 200,
): Promise<{
  inbox: StoreInbox;
  fake: Awaited<ReturnType<typeof createFakeStore>>;
  sqls: string[];
}> {
  const seed = fixtureSeed();
  seed.threads = bigThreads();
  seed.messages = [];
  seed.briefs = [];
  seed.drafts = [];
  seed.decisions = [];
  seed.decisionThreads = [];
  const fake = await createFakeStore({
    driver: bunDriver(),
    seed,
    backoff: { minMs: 5, maxMs: 20 },
  });
  const sqls: string[] = [];
  const query = fake.store.query.bind(fake.store);
  fake.store.query = ((sql: string, params?: never[]) => {
    sqls.push(sql);
    return query(sql, params);
  }) as typeof fake.store.query;
  const inbox = await createStoreInbox(fake.store, {
    memoryWindow: () => window,
    memoryLookups: () => lookups,
  });
  return { inbox, fake, sqls };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => id(from + i));

describe("storeInbox holds a window of the Cache", () => {
  test("with a window of N only the newest N rows are held, and the reads are bounded", async () => {
    const { inbox, sqls } = await openBig(10);
    expect(inbox.threads().map((t) => t.id)).toEqual(range(0, 10));
    expect(inbox.held()).toBe(10);
    // No read of every Thread: each list read carries a limit.
    const listReads = sqls.filter((q) => q.includes("from threads t") && !q.includes("count(*)"));
    expect(listReads.length).toBeGreaterThan(0);
    expect(listReads.every((q) => q.includes("limit ?") || q.includes("where t.id in"))).toBe(true);
    inbox.close();
  });

  test("more() reads the next window, in order, until every Thread is in reach", async () => {
    const { inbox } = await openBig(10);
    inbox.more("inbox");
    await settled(() => inbox.threads().length === 20);
    expect(inbox.threads().map((t) => t.id)).toEqual(range(0, 20));
    inbox.more("inbox");
    await settled(() => inbox.threads().length === TOTAL);
    expect(inbox.threads().map((t) => t.id)).toEqual(range(0, TOTAL));
    // Nothing left: another ask reads nothing.
    inbox.more("inbox");
    await tick(20);
    expect(inbox.threads().length).toBe(TOTAL);
    inbox.close();
  });

  test("a Thread outside the window resolves by id, and is let go once nothing shows it", async () => {
    const { inbox, fake } = await openBig(10, 1);
    expect(inbox.thread("b25")).toBeUndefined();
    // The miss asked for it; it lands for the subscribers.
    await settled(() => inbox.thread("b25") !== undefined);
    expect(inbox.thread("b25")?.subject).toBe("Thread 25");
    expect(inbox.threads().map((t) => t.id)).not.toContain("b25");
    expect((await inbox.resolve("b27"))?.subject).toBe("Thread 27");
    expect(await inbox.resolve("nope")).toBeUndefined();
    // An open (watched) Thread stays; the others go past the Setting's one.
    const stop = inbox.watchMessages("b27", () => {});
    await inbox.resolve("b26");
    await inbox.resolve("b28");
    await fake.store.write([{ sql: "update threads set subject = subject where id = 'b00'" }]);
    await tick(20);
    expect(inbox.held()).toBeLessThanOrEqual(10 + 2);
    expect(inbox.thread("b27")).toBeDefined();
    stop();
    inbox.close();
  });

  test("counts are over the whole Cache, follow an action at once, and after the Cache", async () => {
    const { inbox } = await openBig(10);
    const all = bigThreads();
    const unread = all.filter((t) => t.unread);
    expect(inbox.counts().inbox).toBe(TOTAL);
    expect(inbox.counts().unread.inbox).toBe(unread.length);
    expect(inbox.counts().unread.starred ?? 0).toBe(unread.filter((t) => t.starred).length);
    expect(inbox.counts().unread.investors).toBe(
      unread.filter((t) => t.group === "investors").length,
    );
    // A Thread no list holds: the action reads it first, then counts it at once.
    const pending = inbox.markRead(["b28"]);
    await pending;
    expect(inbox.counts().unread.inbox).toBe(unread.length - 1);
    await settled(() => inbox.thread("b28")?.unread === false);
    await tick(20);
    expect(inbox.counts().unread.inbox).toBe(unread.length - 1);
    // Archiving one in the window takes it out of the Inbox's total.
    await inbox.archive(["b02"]);
    await settled(() => inbox.counts().inbox === TOTAL - 1);
    expect(inbox.counts().unread.inbox).toBe(unread.length - 2);
    inbox.close();
  });

  test("a re-read Thread newer than the window's oldest enters it; an older one stays out", async () => {
    const { inbox } = await openBig(10);
    const token = await inbox.archive(["b03"]);
    await settled(() => !inbox.threads().some((t) => t.id === "b03"));
    expect(inbox.threads()).toHaveLength(9);
    await inbox.undo(token);
    await settled(() => inbox.threads().some((t) => t.id === "b03"));
    expect(inbox.threads().map((t) => t.id)).toEqual(range(0, 10));
    // A flag change on a Thread past the window leaves the window as it was.
    await inbox.star(["b24"]);
    await tick(30);
    expect(inbox.threads().map((t) => t.id)).toEqual(range(0, 10));
    inbox.close();
  });

  test("new activity on an old Thread brings it to the top, and the window stays its size", async () => {
    const { inbox, fake } = await openBig(10);
    await fake.store.write([
      {
        sql: "update threads set last_activity = ? where id = 'b29'",
        params: ["2026-09-17T09:00:00.000Z"],
      },
    ]);
    await settled(() => inbox.threads()[0]?.id === "b29");
    expect(inbox.threads().map((t) => t.id)).toEqual(["b29", ...range(0, 9)]);
    inbox.close();
  });

  test("a folder and a Group read their own bounded lists and grow the same way", async () => {
    const { inbox } = await openBig(10);
    const starred = bigThreads().filter((t) => t.starred);
    inbox.folder("starred");
    await settled(() => inbox.folder("starred").length === 10);
    expect(inbox.folder("starred").map((t) => t.id)).toEqual(starred.slice(0, 10).map((t) => t.id));
    inbox.more("starred");
    await settled(() => inbox.folder("starred").length === starred.length);
    const investors = bigThreads().filter((t) => t.group === "investors");
    inbox.group("investors");
    await settled(() => inbox.group("investors").length === investors.length);
    expect(inbox.group("investors").map((t) => t.id)).toEqual(investors.map((t) => t.id));
    inbox.close();
  });

  test("a list no screen shows is let go", async () => {
    const { inbox } = await openBig(10);
    const stop = inbox.watchList("archive", () => {});
    const stopStarred = inbox.watchList("starred", () => {});
    await settled(() => inbox.folder("starred").length === 10);
    expect(inbox.held()).toBe(10 + 5);
    stopStarred();
    stop();
    await tick(20);
    expect(inbox.held()).toBe(10);
    inbox.close();
  });
});
