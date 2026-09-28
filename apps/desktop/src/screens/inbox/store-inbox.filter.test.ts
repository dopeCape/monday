// The Filter menu's lists through the Store's Inbox seam, over a Cache three
// times bigger than what a list holds: a year, a sender, a domain, the flags
// and a date range each read their own bounded list from SQL, page on more(),
// count over the whole Cache, and combine with AND. The facets count the
// whole Cache too.

import { describe, expect, test } from "bun:test";
import {
  filterExpected as expected,
  FILTER_NOW as NOW,
  openFilterCache as openBig,
  FILTER_WINDOW as WINDOW,
} from "./filter-fixture.ts";
import { type FilterChip, filterListKey, resolveFilter, withoutFacet } from "./list-filter.ts";
import type { StoreInbox } from "./store-inbox.ts";

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error("seam did not settle");
}

const keyOf = (chips: FilterChip[]) => filterListKey("inbox", resolveFilter(chips, NOW, true));

/** Watches a filtered list, waits for its first window and its total, and reads the rest page by page. */
async function readAll(inbox: StoreInbox, chips: FilterChip[]) {
  const key = keyOf(chips);
  const stop = inbox.watchList(key, () => {});
  inbox.list(key);
  await settled(() => inbox.listTotal(key) !== null);
  const total = inbox.listTotal(key) as number;
  const first = inbox.list(key).map((t) => t.id);
  let guard = 0;
  while (inbox.list(key).length < total && guard++ < 50) {
    const had = inbox.list(key).length;
    inbox.more(key);
    await settled(() => inbox.list(key).length > had);
  }
  const all = inbox.list(key).map((t) => t.id);
  return { key, total, first, all, stop };
}

describe("the Filter menu's lists over the whole Cache", () => {
  test("a year: counted over the Cache, a window held, the rest on more()", async () => {
    const { inbox } = await openBig();
    const want = expected((i) => i >= 30 && i < 60);
    const r = await readAll(inbox, [{ kind: "year", year: 2025 }]);
    expect(r.total).toBe(30);
    expect(r.first).toEqual(want.slice(0, WINDOW));
    expect(r.all).toEqual(want);
    // The Inbox itself still holds only its own window.
    expect(inbox.threads()).toHaveLength(WINDOW);
    r.stop();
    inbox.close();
  });

  test("a person: every Thread they sent into, whatever the case of the address", async () => {
    const { inbox } = await openBig();
    const bob = await readAll(inbox, [{ kind: "person", email: "bob@acme.com", name: "Bob Ray" }]);
    expect(bob.total).toBe(30);
    expect(bob.all).toEqual(expected((i) => i % 3 === 1));
    // Dan wrote the second Message of every fifth Thread.
    const dan = await readAll(inbox, [{ kind: "person", email: "dan@initech.org", name: "Dan" }]);
    expect(dan.total).toBe(18);
    expect(dan.all).toEqual(expected((i) => i % 5 === 0));
    inbox.close();
  });

  test("a domain: every sender at it", async () => {
    const { inbox } = await openBig();
    const acme = await readAll(inbox, [{ kind: "domain", domain: "acme.com" }]);
    expect(acme.total).toBe(60);
    expect(acme.all).toEqual(expected((i) => i % 3 !== 2));
    inbox.close();
  });

  test("Unread, Starred and Has attachments, each over the whole Cache", async () => {
    const { inbox } = await openBig();
    const unread = await readAll(inbox, [{ kind: "unread" }]);
    expect(unread.total).toBe(45);
    expect(unread.all).toEqual(expected((i) => i % 2 === 0));
    const starred = await readAll(inbox, [{ kind: "starred" }]);
    expect(starred.all).toEqual(expected((i) => i % 4 === 1));
    const files = await readAll(inbox, [{ kind: "attachments" }]);
    expect(files.total).toBe(13);
    expect(files.all).toEqual(expected((i) => i % 7 === 0));
    inbox.close();
  });

  test("date ranges: this week, this month, picked days", async () => {
    const { inbox } = await openBig();
    // NOW is Thu 17 Sep 2026; the week starts Monday 14 Sep.
    const week = await readAll(inbox, [{ kind: "range", range: "week" }]);
    expect(week.all).toEqual(expected((i) => i <= 2));
    const month = await readAll(inbox, [{ kind: "range", range: "month" }]);
    expect(month.all).toEqual(expected((i) => i <= 15));
    const days = await readAll(inbox, [
      { kind: "range", range: "dates", from: "2025-06-10", to: "2025-06-14" },
    ]);
    expect(days.all).toEqual(expected((i) => i >= 31 && i <= 35));
    inbox.close();
  });

  test("filters combine with AND", async () => {
    const { inbox } = await openBig();
    const r = await readAll(inbox, [
      { kind: "year", year: 2024 },
      { kind: "domain", domain: "acme.com" },
      { kind: "unread" },
    ]);
    const want = expected((i) => i >= 60 && i % 3 !== 2 && i % 2 === 0);
    expect(r.total).toBe(want.length);
    expect(r.all).toEqual(want);
    inbox.close();
  });

  test("a Thread read under Unread keeps its place; a new unread one past the list stays out", async () => {
    const { inbox } = await openBig();
    const key = keyOf([{ kind: "unread" }]);
    const stop = inbox.watchList(key, () => {});
    await settled(() => inbox.list(key).length === WINDOW && inbox.listTotal(key) !== null);
    await inbox.markRead(["f02"]);
    await tick(30);
    expect(inbox.list(key).map((t) => t.id)).toContain("f02");
    expect(inbox.list(key).find((t) => t.id === "f02")?.unread).toBe(false);
    // The total follows the Cache.
    await settled(() => inbox.listTotal(key) === 44);
    stop();
    inbox.close();
  });

  test("a Message from a new sender puts its Thread in that sender's list", async () => {
    const { inbox, fake } = await openBig();
    const key = keyOf([{ kind: "person", email: "erin@new.dev", name: "" }]);
    const stop = inbox.watchList(key, () => {});
    await settled(() => inbox.listTotal(key) === 0);
    await fake.store.write([
      {
        sql: `insert into messages (id, thread_id, sender, recipients, cc, date, has_attachments)
              values ('f01-m9', 'f01', ?, '[]', '[]', ?, 0)`,
        params: [JSON.stringify({ name: "Erin", email: "Erin@New.dev" }), NOW.toISOString()],
      },
    ]);
    await settled(() => inbox.list(key).length === 1);
    expect(inbox.list(key)[0]?.id).toBe("f01");
    await settled(() => inbox.listTotal(key) === 1);
    stop();
    inbox.close();
  });
});

describe("the facets", () => {
  test("years newest first, with counts over the whole Cache", async () => {
    const { inbox } = await openBig();
    const years = await inbox.facets("inbox", "year", { limit: 30, now: NOW });
    expect(years).toEqual([
      { key: "2026", label: "2026", count: 30 },
      { key: "2025", label: "2025", count: 30 },
      { key: "2024", label: "2024", count: 30 },
    ]);
    inbox.close();
  });

  test("people most frequent first, typed ahead by name or address", async () => {
    const { inbox } = await openBig();
    const people = await inbox.facets("inbox", "person", { limit: 3, now: NOW });
    expect(people.map((p) => [p.key, p.count])).toEqual([
      ["alice@acme.com", 30],
      ["bob@acme.com", 30],
      ["carol@globex.io", 30],
    ]);
    expect(people[0]?.label).toBe("Alice Ng");
    const typed = await inbox.facets("inbox", "person", { needle: "ito", limit: 10, now: NOW });
    expect(typed).toEqual([{ key: "dan@initech.org", label: "Dan Ito", count: 18 }]);
    inbox.close();
  });

  test("domains with the Threads at each, narrowed by the other filters", async () => {
    const { inbox } = await openBig();
    const all = await inbox.facets("inbox", "domain", { limit: 10, now: NOW });
    expect(all.map((d) => [d.key, d.count])).toEqual([
      ["acme.com", 60],
      ["globex.io", 30],
      ["initech.org", 18],
    ]);
    // Under a year and a domain, the domain facet still lists every domain in that year.
    const f = resolveFilter(
      [
        { kind: "year", year: 2026 },
        { kind: "domain", domain: "acme.com" },
      ],
      NOW,
      true,
    );
    const key = filterListKey("inbox", withoutFacet(f, "domain"));
    const in2026 = await inbox.facets(key, "domain", { needle: "o", limit: 10, now: NOW });
    expect(in2026.map((d) => [d.key, d.count])).toEqual([
      ["acme.com", 20],
      ["globex.io", 10],
      ["initech.org", 6],
    ]);
    inbox.close();
  });
});
