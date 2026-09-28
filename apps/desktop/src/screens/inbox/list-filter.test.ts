// The Filter menu as data: chips in, a resolved filter and its list key out;
// the row rule that keeps a read Thread under Unread; the search operators;
// and thread_senders, the Cache table Person and Domain read, kept in step
// with the Messages by triggers and filled once for an older Cache.

import { describe, expect, test } from "bun:test";
import type { Change } from "@monday/shared";
import { bunDriver } from "../../store/bun-driver.ts";
import { applySchema, changeStatements } from "../../store/store.ts";
import {
  chipSpan,
  type FilterChip,
  filterKeepsRow,
  filterListKey,
  filterSearchText,
  parseFilterListKey,
  resolveFilter,
  toggleFlag,
  withChip,
  withoutFacet,
} from "./list-filter.ts";

const NOW = new Date(2026, 8, 17, 9, 0);

describe("chips", () => {
  test("one chip per kind, the newest last; a flag toggles", () => {
    let chips: FilterChip[] = [];
    chips = withChip(chips, { kind: "year", year: 2025 });
    chips = toggleFlag(chips, "unread");
    chips = withChip(chips, { kind: "year", year: 2024 });
    expect(chips).toEqual([{ kind: "unread" }, { kind: "year", year: 2024 }]);
    expect(toggleFlag(chips, "unread")).toEqual([{ kind: "year", year: 2024 }]);
  });

  test("a year is the user's own calendar year, Jan 1 to Jan 1 local", () => {
    const span = chipSpan({ kind: "year", year: 2025 }, NOW, true);
    expect(span?.from.getTime()).toBe(new Date(2025, 0, 1).getTime());
    expect(span?.to.getTime()).toBe(new Date(2026, 0, 1).getTime());
  });

  test("this week starts on the Setting's day; picked days are inclusive in either order", () => {
    // NOW is a Thursday.
    expect(chipSpan({ kind: "range", range: "week" }, NOW, true)?.from.getDate()).toBe(14);
    expect(chipSpan({ kind: "range", range: "week" }, NOW, false)?.from.getDate()).toBe(13);
    const days = chipSpan(
      { kind: "range", range: "dates", from: "2026-09-10", to: "2026-09-02" },
      NOW,
      true,
    );
    expect(days?.from.getTime()).toBe(new Date(2026, 8, 2).getTime());
    expect(days?.to.getTime()).toBe(new Date(2026, 8, 11).getTime());
  });

  test("a year and a range keep only the days both allow", () => {
    const f = resolveFilter(
      [
        { kind: "year", year: 2026 },
        { kind: "range", range: "month" },
      ],
      NOW,
      true,
    );
    expect(f.from).toBe(new Date(2026, 8, 1).toISOString());
    expect(f.to).toBe(new Date(2026, 9, 1).toISOString());
  });

  test("a resolved filter round-trips through its list key, and a facet leaves out its own dimension", () => {
    const f = resolveFilter(
      [
        { kind: "person", email: " Kenji.W@Meridianfund.co ", name: "Kenji" },
        { kind: "domain", domain: "@stripe.com" },
        { kind: "starred" },
        { kind: "needs_reply" },
      ],
      NOW,
      true,
    );
    expect(f).toEqual({ person: "kenji.w@meridianfund.co", domain: "stripe.com", starred: true });
    const key = filterListKey("starred", f);
    expect(parseFilterListKey(key)).toEqual({ base: "starred", filter: f });
    expect(parseFilterListKey("inbox")).toBeNull();
    expect(parseFilterListKey("filter:{nope")).toBeNull();
    expect(withoutFacet(f, "person")).toEqual({ domain: "stripe.com", starred: true });
    expect(withoutFacet(f, "domain")).toEqual({ person: "kenji.w@meridianfund.co", starred: true });
  });

  test("the filter as search operators", () => {
    const f = resolveFilter(
      [
        { kind: "unread" },
        { kind: "attachments" },
        { kind: "year", year: 2025 },
        { kind: "domain", domain: "acme.com" },
      ],
      NOW,
      true,
    );
    expect(filterSearchText(f)).toBe(
      "is:unread has:attachment after:2025-01-01 before:2026-01-01 from:acme.com",
    );
  });
});

describe("a row under a filter", () => {
  const row = {
    unread: 0,
    starred: 1,
    has_attachments: 0,
    last_activity: new Date(2025, 5, 1).toISOString(),
    sender_emails: "alice@acme.com dan@initech.org",
  };
  const f = resolveFilter([{ kind: "unread" }, { kind: "year", year: 2025 }], NOW, true);

  test("a read row does not enter Unread, but one the list holds keeps its place", () => {
    expect(filterKeepsRow(f, row, false)).toBe(false);
    expect(filterKeepsRow(f, row, true)).toBe(true);
  });

  test("the dates, the person and the domain always hold", () => {
    const later = { ...row, last_activity: new Date(2026, 0, 2).toISOString() };
    expect(filterKeepsRow(f, later, true)).toBe(false);
    const dan = resolveFilter([{ kind: "person", email: "dan@initech.org", name: "" }], NOW, true);
    expect(filterKeepsRow(dan, row, false)).toBe(true);
    const globex = resolveFilter([{ kind: "domain", domain: "globex.io" }], NOW, true);
    expect(filterKeepsRow(globex, row, true)).toBe(false);
  });
});

describe("thread_senders", () => {
  const sender = (name: string, email: string) => JSON.stringify({ name, email });
  const senders = async (driver: ReturnType<typeof bunDriver>) =>
    (
      await driver.query(
        "select thread_id, email, domain, name from thread_senders order by thread_id, email",
      )
    ).map((r) => `${r.thread_id} ${r.email} ${r.domain} ${r.name}`);

  test("follows the Messages: insert, a changed sender, a moved Message, a delete", async () => {
    const driver = bunDriver();
    await applySchema(driver);
    const add = (id: string, thread: string, from: string) =>
      driver.exec(
        "insert into messages (id, thread_id, sender, date) values (?, ?, ?, '2026-01-01')",
        [id, thread, from],
      );
    await add("m1", "t1", sender("Aoife", "Aoife@Northwind.dev"));
    await add("m2", "t1", sender("", "aoife@northwind.dev"));
    await add("m3", "t1", sender("Kenji", "kenji@meridian.co"));
    await add("m4", "t2", "not json");
    // The feed's upsert of a Message the Cache holds (its headers again) is no conflict.
    const upsert = changeStatements({
      kind: "message",
      at: "2026-01-01",
      payload: {
        id: "m3",
        threadId: "t1",
        from: { name: "Kenji", email: "kenji@meridian.co" },
        to: [],
        cc: [],
        date: "2026-01-01",
        hasAttachments: false,
      },
    } as unknown as Change);
    await driver.batch(upsert);
    await driver.batch(upsert);
    expect(await senders(driver)).toEqual([
      "t1 aoife@northwind.dev northwind.dev Aoife",
      "t1 kenji@meridian.co meridian.co Kenji",
    ]);
    // Aoife still wrote m2, so dropping m1 keeps her; changing m2's sender drops her.
    await driver.exec("delete from messages where id = 'm1'");
    expect((await senders(driver)).length).toBe(2);
    await driver.exec("update messages set sender = ? where id = 'm2'", [
      sender("Sofia", "sofia@x.io"),
    ]);
    expect(await senders(driver)).toEqual([
      "t1 kenji@meridian.co meridian.co Kenji",
      "t1 sofia@x.io x.io Sofia",
    ]);
    await driver.exec("update messages set thread_id = 't3' where id = 'm3'");
    expect(await senders(driver)).toEqual([
      "t1 sofia@x.io x.io Sofia",
      "t3 kenji@meridian.co meridian.co Kenji",
    ]);
    await driver.close();
  });

  test("a Cache from before it is filled once from its Messages", async () => {
    const driver = bunDriver();
    await applySchema(driver);
    await driver.exec(
      "insert into messages (id, thread_id, sender, date) values ('m1', 't1', ?, '2026-01-01')",
      [sender("Ngozi", "ngozi@lagos.dev")],
    );
    // As an older Cache would be: the table empty and the fill never done.
    await driver.exec("delete from thread_senders");
    await driver.exec("delete from meta where key = 'senders_format'");
    await applySchema(driver);
    expect(await senders(driver)).toEqual(["t1 ngozi@lagos.dev lagos.dev Ngozi"]);
    await driver.close();
  });
});
