// The search module through its interface over real FTS5 in bun:sqlite:
// ranking on a 50-thread fixture, prefix and trigram matching, the recency
// boost, chips, all accounts across two Caches, "search older mail", recent
// searches, index integrity under the triggers, and the 50,000-thread budget.

import { describe, expect, test } from "bun:test";
import type { MessageBodiesPage, MessageBodyRow } from "@monday/shared";
import { bunDriver } from "../store/bun-driver.ts";
import { createFakeStore, type FakeStore } from "../store/fake.ts";
import { FTS_MERGE_SQL } from "../store/store.ts";
import { AOIFE, generateMailbox, KENJI, ME, mailboxStatements, plant } from "./fixture.ts";
import { createSearch, DEFAULT_SEARCH_SETTINGS, type SearchSource } from "./index.ts";

const NOW = new Date("2026-09-16T10:00:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** Fifty generated Threads plus the planted ones the assertions name. */
function fixture() {
  const box = generateMailbox({ threads: 50, now: NOW, seed: 7 });
  plant(
    box,
    { id: "subj", subject: "Quarterly forecast", lastActivity: daysAgo(40) },
    {
      body: "numbers attached, nothing else to add",
    },
  );
  plant(
    box,
    { id: "body", subject: "Re: numbers", lastActivity: daysAgo(40) },
    {
      body: "here is the quarterly forecast you asked for, with the quarterly forecast notes",
    },
  );
  plant(
    box,
    { id: "kenji-old", subject: "Board observer seat", lastActivity: daysAgo(300) },
    { from: KENJI, body: "The pro-rata clause is now capped." },
  );
  plant(
    box,
    { id: "kenji-mention", subject: "Notes", lastActivity: daysAgo(1) },
    { from: AOIFE, body: "Kenji Watanabe said the term sheet lands Monday. kenji is on it." },
  );
  plant(
    box,
    { id: "fresh", subject: "Zebra migration plan", lastActivity: daysAgo(1) },
    {
      body: "the zebra migration plan is ready",
    },
  );
  plant(
    box,
    { id: "stale", subject: "Zebra migration plan", lastActivity: daysAgo(200) },
    {
      body: "the zebra migration plan is ready",
    },
  );
  plant(
    box,
    { id: "exact", subject: "Zebra migration plan", lastActivity: daysAgo(500) },
    { body: "nothing here" },
  );
  plant(box, { id: "nobody", subject: "Headers only", lastActivity: daysAgo(900) });
  return box;
}

async function open(workspaceId = "ws-a", box = fixture()): Promise<FakeStore> {
  const fake = await createFakeStore({ driver: bunDriver(), seed: null, workspaceId });
  await fake.store.write(mailboxStatements(box, NOW.toISOString()));
  await fake.store.query(FTS_MERGE_SQL);
  return fake;
}

function moduleOver(
  sources: SearchSource[],
  extra: Partial<Parameters<typeof createSearch>[0]> = {},
) {
  return createSearch({ sources: () => sources, now: () => NOW, ...extra });
}

const ids = (hits: { thread: { id: string } }[]) => hits.map((h) => h.thread.id);

describe("ranking", () => {
  test("a subject match outranks a body match for the same words", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const r = await search.search("quarterly forecast", { workspace: "ws-a" });
    expect(ids(r.hits).slice(0, 2)).toEqual(["subj", "body"]);
    expect(r.hits[1]?.snippet).toContain("quarterly forecast");
    expect(r.elapsedMs).toBeLessThan(50);
  });

  test("an exact sender is pinned first even when it is the oldest hit", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const r = await search.search("from:kenji.w@meridianfund.co", { workspace: "ws-a" });
    expect(ids(r.hits)).toEqual(["kenji-old"]);
    expect(r.hits[0]?.pinned).toBe(true);
    // A bare address pins the same way; a bare name does not.
    const bare = await search.search("kenji.w@meridianfund.co", { workspace: "ws-a" });
    expect(bare.hits[0]?.thread.id).toBe("kenji-old");
    expect(bare.hits[0]?.pinned).toBe(true);
    const name = await search.search("kenji", { workspace: "ws-a" });
    expect(ids(name.hits)).toContain("kenji-mention");
    expect(ids(name.hits)).toContain("kenji-old");
    expect(name.hits.find((h) => h.thread.id === "kenji-old")?.pinned).toBe(false);
  });

  test("an exact subject is pinned first", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const r = await search.search("zebra migration plan", { workspace: "ws-a" });
    const top = r.hits.slice(0, 3);
    expect(top.every((h) => h.pinned)).toBe(true);
    // Pinned hits keep newest first among themselves.
    expect(ids(top)).toEqual(["fresh", "stale", "exact"]);
  });

  test("the recency boost ranks the newer of two identical matches first", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const r = await search.search("zebra ready", { workspace: "ws-a" });
    expect(ids(r.hits)).toEqual(["fresh", "stale"]);
    expect((r.hits[0]?.score ?? 0) > (r.hits[1]?.score ?? 0)).toBe(true);
    // With no recency window the two tie on score and fall back to newest first.
    const flat = moduleOver([{ store, account: "a" }], {
      settings: () => ({ ...DEFAULT_SEARCH_SETTINGS, recencyDays: 1 }),
    });
    const f = await flat.search("zebra ready", { workspace: "ws-a" });
    expect(f.hits[0]?.score).toBeCloseTo(f.hits[1]?.score ?? -1, 5);
  });

  test("results are Threads, never two rows for one Thread", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const r = await search.search("the", { workspace: "ws-a", limit: 500 });
    const seen = new Set(ids(r.hits));
    expect(seen.size).toBe(r.hits.length);
    expect(r.hits.length).toBeGreaterThan(10);
  });

  test("deleted Threads never appear; archived ones do", async () => {
    const { store } = await open();
    await store.write([{ sql: "update threads set deleted = 1 where id = 'fresh'" }]);
    await store.write([{ sql: "update threads set archived = 1 where id = 'stale'" }]);
    const search = moduleOver([{ store, account: "a" }]);
    const r = await search.search("zebra ready", { workspace: "ws-a" });
    expect(ids(r.hits)).toEqual(["stale"]);
  });
});

describe("matching", () => {
  test("prefix matching answers as the user types", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    for (const typed of ["q", "qu", "quar", "quarterly", "quarterly fore"]) {
      const r = await search.search(typed, { workspace: "ws-a" });
      expect(ids(r.hits)).toContain("subj");
    }
    expect(ids((await search.search("subject:quart", { workspace: "ws-a" })).hits)).toEqual([
      "subj",
    ]);
  });

  test("a substring of an address or subject matches through the trigram index", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const r = await search.search("ridianfund", { workspace: "ws-a" });
    expect(ids(r.hits)).toEqual(["kenji-old"]);
    const s = await search.search("igration pl", { workspace: "ws-a" });
    expect(new Set(ids(s.hits))).toEqual(new Set(["fresh", "stale", "exact"]));
    // Two characters are below the trigram minimum and only prefix-match.
    const short = await search.search("ig", { workspace: "ws-a" });
    expect(ids(short.hits)).not.toContain("fresh");
  });

  test("phrases, negation and field operators combine", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    expect(ids((await search.search('"pro-rata clause"', { workspace: "ws-a" })).hits)).toEqual([
      "kenji-old",
    ]);
    expect(ids((await search.search("kenji -from:kenji", { workspace: "ws-a" })).hits)).toEqual([
      "kenji-mention",
    ]);
    expect(ids((await search.search("zebra -ready", { workspace: "ws-a" })).hits)).toEqual([
      "exact",
    ]);
    expect(
      ids((await search.search("zebra after:2026-09-01", { workspace: "ws-a" })).hits),
    ).toEqual(["fresh"]);
    expect(
      ids(
        (await search.search("zebra older_than:100d newer_than:400d", { workspace: "ws-a" })).hits,
      ),
    ).toEqual(["stale"]);
    expect(ids((await search.search("to:tejas zebra", { workspace: "ws-a" })).hits).length).toBe(3);
    expect(ids((await search.search("to:nobody zebra", { workspace: "ws-a" })).hits)).toEqual([]);
  });

  test("a pure filter lists newest first with nothing pinned", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const r = await search.search("is:starred in:hiring", { workspace: "ws-a" });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.thread.starred && h.thread.group === "hiring")).toBe(true);
    expect(r.hits.every((h) => !h.pinned)).toBe(true);
    const dates = r.hits.map((h) => h.thread.lastActivity);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  test("an empty query returns nothing and costs nothing", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const r = await search.search("   ", { workspace: "ws-a" });
    expect(r.hits).toEqual([]);
    expect(r.older).toEqual([]);
  });
});

describe("filter chips", () => {
  test("unread, attachments and group narrow a result set live", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const all = await search.search("the", { workspace: "ws-a", limit: 500 });
    const unread = await search.search("the", {
      workspace: "ws-a",
      limit: 500,
      chips: { unread: true },
    });
    const files = await search.search("the", {
      workspace: "ws-a",
      limit: 500,
      chips: { attachments: true },
    });
    const grouped = await search.search("the", {
      workspace: "ws-a",
      limit: 500,
      chips: { group: true },
    });
    expect(unread.hits.length).toBeLessThan(all.hits.length);
    expect(unread.hits.every((h) => h.thread.unread)).toBe(true);
    expect(files.hits.every((h) => h.thread.hasAttachments)).toBe(true);
    expect(grouped.hits.every((h) => h.thread.group !== null)).toBe(true);
    const both = await search.search("the", {
      workspace: "ws-a",
      limit: 500,
      chips: { unread: true, attachments: true },
    });
    expect(both.hits.every((h) => h.thread.unread && h.thread.hasAttachments)).toBe(true);
  });

  test("chips alone list the Cache without a query", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const r = await search.search("", { workspace: "ws-a", chips: { unread: true } });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.thread.unread)).toBe(true);
  });
});

describe("all accounts", () => {
  test("runs the same query across two Caches and labels each hit", async () => {
    const a = await open("ws-a");
    const boxB = generateMailbox({ threads: 10, now: NOW, seed: 99 });
    plant(
      boxB,
      { id: "b-zebra", subject: "Zebra sighting", lastActivity: daysAgo(0.5) },
      {
        body: "a zebra in the second account",
      },
    );
    const b = await open("ws-b", boxB);
    const search = moduleOver([
      { store: a.store, account: "tejas@genai-labs.io" },
      { store: b.store, account: "tejas@hey.com" },
    ]);
    const one = await search.search("zebra", { workspace: "ws-a" });
    expect(ids(one.hits)).not.toContain("b-zebra");
    expect(one.hits.every((h) => h.account === "tejas@genai-labs.io")).toBe(true);
    const all = await search.search("zebra", { workspace: "all" });
    expect(ids(all.hits)).toContain("b-zebra");
    expect(all.hits.find((h) => h.thread.id === "b-zebra")?.account).toBe("tejas@hey.com");
    expect(all.hits.find((h) => h.thread.id === "b-zebra")?.workspaceId).toBe("ws-b");
    expect(all.hits.filter((h) => h.account === "tejas@genai-labs.io").length).toBe(
      one.hits.length,
    );
  });
});

describe("search older mail", () => {
  /** A Server that holds every body the fixture has, paged newest first. */
  function fakeBodies(box: ReturnType<typeof fixture>, log: string[] = []) {
    return async (
      _workspaceId: string,
      range: { after: string | null; before: string | null; limit: number },
    ): Promise<MessageBodiesPage> => {
      log.push(`${range.after ?? "-"}..${range.before ?? "-"}/${range.limit}`);
      const inRange = box.messages
        .filter(
          (m) =>
            (range.after === null || m.date >= range.after) &&
            (range.before === null || m.date < range.before),
        )
        .sort((x, y) => y.date.localeCompare(x.date));
      const page = inRange.slice(0, range.limit);
      const bodies: MessageBodyRow[] = page.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        date: m.date,
        text: m.bodyText ?? "",
        html: null,
        snippet: (m.bodyText ?? "").slice(0, 40),
      }));
      const last = page[page.length - 1];
      return {
        bodies,
        cursor: inRange.length > page.length && last ? last.date : null,
        total: inRange.length,
      };
    };
  }

  test("is offered when the query has body terms and bodies are missing in range, and pulling them updates results", async () => {
    const full = fixture();
    // The Cache holds headers for everything but bodies only for the last 100 days.
    const cache = structuredClone(full);
    for (const m of cache.messages) if (m.date < daysAgo(100)) delete m.bodyText;
    const { store } = await open("ws-a", cache);
    const log: string[] = [];
    const search = moduleOver([{ store, account: "a" }], {
      fetchBodies: fakeBodies(full, log),
      settings: () => ({ ...DEFAULT_SEARCH_SETTINGS, olderBatch: 25 }),
    });

    const before = await search.search("pro-rata", { workspace: "ws-a" });
    expect(ids(before.hits)).toEqual([]);
    expect(before.older.length).toBe(1);
    expect(before.older[0]?.missing).toBeGreaterThan(0);

    // A header-only query never offers the pull; neither does a query whose range is covered.
    expect((await search.search("from:kenji", { workspace: "ws-a" })).older).toEqual([]);
    expect((await search.search("zebra newer_than:30d", { workspace: "ws-a" })).older).toEqual([]);

    const progress: number[] = [];
    const older = before.older[0];
    if (!older) throw new Error("no offer");
    const landed = await search.pullOlder(older, (p) => progress.push(p.done));
    expect(landed).toBe(older.missing);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toBe(older.missing);
    expect(log.length).toBeGreaterThan(1);

    const after = await search.search("pro-rata", { workspace: "ws-a" });
    expect(ids(after.hits)).toEqual(["kenji-old"]);
    expect(after.older).toEqual([]);
  });

  test("a date-bounded query only asks for bodies in its range", async () => {
    const full = fixture();
    const cache = structuredClone(full);
    for (const m of cache.messages) delete m.bodyText;
    const { store } = await open("ws-a", cache);
    const log: string[] = [];
    const search = moduleOver([{ store, account: "a" }], { fetchBodies: fakeBodies(full, log) });
    const r = await search.search("zebra older_than:100d newer_than:400d", { workspace: "ws-a" });
    const older = r.older[0];
    if (!older) throw new Error("no offer");
    expect(older.after).not.toBeNull();
    expect(older.before).not.toBeNull();
    // The offer spans the gap inside the asked range, never the whole mailbox.
    expect((older.after as string) >= daysAgo(400)).toBe(true);
    expect((older.before as string) <= daysAgo(99)).toBe(true);
    await search.pullOlder(older);
    expect(log[0]).toBe(`${older.after}..${older.before}/${DEFAULT_SEARCH_SETTINGS.olderBatch}`);
    const [row] = await store.query<{ n: number }>(
      "select count(*) as n from messages where body_text is not null",
    );
    expect(Number(row?.n)).toBeGreaterThan(0);
    expect(
      ids(
        (await search.search("zebra older_than:100d newer_than:400d", { workspace: "ws-a" })).hits,
      ),
    ).toEqual(["stale"]);
  });

  test("without a body route the offer is never made", async () => {
    const cache = fixture();
    for (const m of cache.messages) delete m.bodyText;
    const { store } = await open("ws-a", cache);
    const search = moduleOver([{ store, account: "a" }]);
    expect((await search.search("zebra", { workspace: "ws-a" })).older).toEqual([]);
  });
});

describe("recent searches and senders", () => {
  test("recent searches live in the Cache's meta table, newest first, deduplicated and capped", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }], {
      settings: () => ({ ...DEFAULT_SEARCH_SETTINGS, recentMax: 3 }),
    });
    expect(await search.recent()).toEqual([]);
    await search.remember("from:kenji");
    await search.remember("zebra");
    await search.remember("  ");
    await search.remember("from:kenji");
    await search.remember("quarterly");
    await search.remember("is:unread");
    expect(await search.recent()).toEqual(["is:unread", "quarterly", "from:kenji"]);
    const [row] = await store.query<{ value: string }>(
      "select value from meta where key = 'recent_searches'",
    );
    expect(JSON.parse(row?.value ?? "[]")).toEqual(["is:unread", "quarterly", "from:kenji"]);
  });

  test("senders come from the Cache's participants, most recent first, one per address", async () => {
    const { store } = await open();
    const search = moduleOver([{ store, account: "a" }]);
    const senders = await search.senders();
    const emails = senders.map((p) => p.email);
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails).toContain(KENJI.email);
    expect(emails).toContain(ME.email);
    expect(emails.slice(0, 2)).toContain(AOIFE.email);
  });
});

describe("index integrity", () => {
  test("the triggers keep both indexes consistent through inserts, updates, subject changes and deletes", async () => {
    const { store } = await open();
    const check = async () => {
      await store.query("insert into messages_fts (messages_fts) values ('integrity-check')");
      await store.query("insert into threads_fts (threads_fts) values ('integrity-check')");
      await store.query("insert into threads_trgm (threads_trgm) values ('integrity-check')");
    };
    await check();
    await store.write([
      { sql: "update threads set subject = 'Renamed thread about llamas' where id = 'fresh'" },
      { sql: "update messages set body_text = 'a body about alpacas' where id = 'staleM0'" },
      { sql: "update messages set body_text = 'a body about alpacas' where id = 'stalem0'" },
      { sql: "update threads set unread = 1 where id = 'exact'" },
      { sql: "delete from messages where id = 'exactm0'" },
      { sql: "delete from threads where id = 'nobody'" },
    ]);
    await check();
    const search = moduleOver([{ store, account: "a" }]);
    expect(ids((await search.search("llamas", { workspace: "ws-a" })).hits)).toEqual(["fresh"]);
    expect(ids((await search.search("alpacas", { workspace: "ws-a" })).hits)).toEqual(["stale"]);
    // The index is over Messages: a Thread whose last Message left is out of it.
    expect(ids((await search.search("subject:zebra", { workspace: "ws-a" })).hits)).toEqual([
      "stale",
    ]);
    expect(ids((await search.search("headers only", { workspace: "ws-a" })).hits)).toEqual([]);
  });

  test("applyBodies fills bodies for known Messages only and re-indexes them", async () => {
    const cache = fixture();
    for (const m of cache.messages) delete m.bodyText;
    const { store } = await open("ws-a", cache);
    const n = await store.applyBodies([
      {
        id: "freshm0",
        threadId: "fresh",
        date: daysAgo(1),
        text: "unicorn sighting",
        html: null,
        snippet: "unicorn",
      },
      {
        id: "ghost",
        threadId: "ghost",
        date: daysAgo(1),
        text: "unicorn",
        html: null,
        snippet: "",
      },
    ]);
    expect(n).toBe(1);
    const search = moduleOver([{ store, account: "a" }]);
    expect(ids((await search.search("unicorn", { workspace: "ws-a" })).hits)).toEqual(["fresh"]);
    expect((await search.search("unicorn", { workspace: "ws-a" })).hits[0]?.thread.snippet).toBe(
      "unicorn",
    );
  });
});

describe("budget", () => {
  const slow = process.env.RUN_SLOW_TESTS === "1";
  test("a search over 50,000 generated Threads answers under 50 ms", async () => {
    const box = generateMailbox({ threads: 50_000, now: NOW, seed: 3, bodyShare: 0.6 });
    plant(
      box,
      { id: "needle", subject: "Quarterly forecast", lastActivity: daysAgo(2) },
      {
        from: KENJI,
        body: "the pro-rata clause is capped",
      },
    );
    const built = performance.now();
    const fake = await createFakeStore({ driver: bunDriver(), seed: null, workspaceId: "big" });
    const statements = mailboxStatements(box, NOW.toISOString());
    for (let i = 0; i < statements.length; i += 5_000) {
      await fake.store.write(statements.slice(i, i + 5_000));
    }
    await fake.store.query(FTS_MERGE_SQL);
    const buildMs = performance.now() - built;
    const [count] = await fake.store.query<{ n: number }>("select count(*) as n from threads");
    expect(Number(count?.n)).toBe(50_001);
    if (buildMs > 10_000 && !slow) {
      console.warn(
        `[search] 50k fixture took ${buildMs.toFixed(0)} ms to build; set RUN_SLOW_TESTS=1 to assert the budget`,
      );
      return;
    }
    const search = moduleOver([{ store: fake.store, account: "a" }]);
    const queries = [
      "quarterly forecast",
      "from:kenji.w@meridianfund.co",
      "the",
      "ridianfund",
      "is:unread review",
      "pro-rata",
    ];
    // One warm-up pass compiles the statements; then every query must fit the budget.
    for (const q of queries) await search.search(q, { workspace: "big" });
    const timings: Record<string, number> = {};
    for (const q of queries) {
      const r = await search.search(q, { workspace: "big" });
      timings[q] = r.elapsedMs;
      expect(r.hits.length).toBeGreaterThan(0);
    }
    const r = await search.search("quarterly forecast", { workspace: "big" });
    expect(r.hits[0]?.thread.id).toBe("needle");
    console.info(
      `[search] 50k threads: build ${buildMs.toFixed(0)} ms; ${Object.entries(timings)
        .map(([q, ms]) => `${JSON.stringify(q)} ${ms.toFixed(1)} ms`)
        .join(", ")}`,
    );
    for (const [q, ms] of Object.entries(timings)) {
      expect(ms, `${q} took ${ms.toFixed(1)} ms`).toBeLessThan(50);
    }
  }, 120_000);
});
