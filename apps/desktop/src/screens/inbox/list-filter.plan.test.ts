// The Filter menu's SQL on a Cache the size of a large Account (56,000
// Threads): each filtered page walks an index in the list's order, or reads
// its few matches through thread_senders, never a sort of the whole Cache;
// and a page, a total and a facet each answer quickly. EXPLAIN QUERY PLAN
// over bun:sqlite with the real schema.

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { threadPageSql } from "../../store/queries.ts";
import { RECOMMENDATIONS_SCHEMA_SQL } from "../../store/recommendations.ts";
import schemaSql from "../../store/schema.sql?raw";
import { SIGNALS_SCHEMA_SQL } from "../../store/signals.ts";
import { threadList } from "./folders.ts";
import {
  countSql,
  type FacetKind,
  type FilterChip,
  facetSql,
  filterListKey,
  resolveFilter,
} from "./list-filter.ts";

const THREADS = 56_000;
const NOW = new Date(2026, 8, 17, 9, 0);
let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(schemaSql);
  db.exec(SIGNALS_SCHEMA_SQL);
  db.exec(RECOMMENDATIONS_SCHEMA_SQL);
  // The search index is not what this test measures; its triggers only slow the seed.
  for (const t of [
    "threads_fts_ai",
    "threads_fts_ad",
    "threads_fts_au",
    "messages_fts_ai",
    "messages_fts_subject",
  ]) {
    db.exec(`drop trigger if exists ${t}`);
  }
  const thread = db.prepare(
    `insert into threads (id, subject, participants, last_activity, unread, starred, archived, deleted, has_attachments)
     values (?, ?, '[]', ?, ?, ?, ?, 0, ?)`,
  );
  const message = db.prepare(
    "insert into messages (id, thread_id, sender, date) values (?, ?, ?, ?)",
  );
  // 2,000 senders at 400 domains, a few very frequent; twelve years of mail.
  const start = new Date(2026, 8, 16).getTime();
  db.transaction(() => {
    for (let i = 0; i < THREADS; i++) {
      const at = new Date(start - i * 2 * 3_600_000).toISOString();
      const who = i % 7 === 0 ? i % 5 : (i * 7919) % 2000;
      const sender = JSON.stringify({ name: `Person ${who}`, email: `p${who}@d${who % 400}.com` });
      thread.run(
        `t${i}`,
        `Thread ${i}`,
        at,
        i % 50 === 0 ? 1 : 0,
        i % 97 === 0 ? 1 : 0,
        i % 3 === 0 ? 1 : 0,
        i % 11 === 0 ? 1 : 0,
      );
      message.run(`m${i}`, `t${i}`, sender, at);
      if (i % 4 === 0) {
        message.run(`r${i}`, `t${i}`, JSON.stringify({ name: "Me", email: "me@x.com" }), at);
      }
    }
  })();
  db.exec("analyze");
});

const listFor = (chips: FilterChip[]) =>
  threadList(filterListKey("inbox", resolveFilter(chips, NOW, true)), "me@x.com").query;

function plan(sql: string, params: unknown[]): string {
  const rows = db.query(`explain query plan ${sql}`).all(...(params as never[])) as {
    detail: string;
  }[];
  return rows.map((r) => r.detail).join("\n");
}

function timed<T>(run: () => T): { ms: number; value: T } {
  const at = performance.now();
  const value = run();
  return { ms: performance.now() - at, value };
}

const CASES: Array<[string, FilterChip[]]> = [
  ["a year", [{ kind: "year", year: 2021 }]],
  ["unread", [{ kind: "unread" }]],
  ["has attachments", [{ kind: "attachments" }]],
  ["starred", [{ kind: "starred" }]],
  ["this month", [{ kind: "range", range: "month" }]],
  ["a person", [{ kind: "person", email: "p1234@d34.com", name: "" }]],
  ["a frequent person", [{ kind: "person", email: "p1@d1.com", name: "" }]],
  ["a domain", [{ kind: "domain", domain: "d17.com" }]],
  [
    "a year, a domain and unread",
    [{ kind: "year", year: 2020 }, { kind: "domain", domain: "d0.com" }, { kind: "unread" }],
  ],
];

describe("filtered pages on a 56,000-Thread Cache", () => {
  for (const [name, chips] of CASES) {
    test(`${name}: an indexed page, no scan of the Cache and no sort of it`, () => {
      const list = listFor(chips);
      const { sql, params } = threadPageSql(list, null, 1500);
      const p = plan(sql, params);
      // Every read of `threads` goes through an index or the rowid.
      expect(p).not.toMatch(/SCAN t\b(?! USING)/);
      const run = timed(() => db.query(sql).all(...(params as never[])));
      expect(run.value.length).toBeGreaterThan(0);
      expect(run.ms).toBeLessThan(250);
      // The next page seeks past the last row read.
      const last = run.value.at(-1) as Record<string, unknown>;
      const next = threadPageSql(list, last, 1500);
      const again = timed(() => db.query(next.sql).all(...(next.params as never[])));
      expect(again.ms).toBeLessThan(250);
    });
  }

  test("the flags and the dates walk an index in the list's order", () => {
    // The page's rows are chosen by the inner select; only it may touch the whole Cache.
    const choose = (chips: FilterChip[]) => {
      const list = listFor(chips);
      const order = list.order.map((o) => `t.${o.column} ${o.desc ? "desc" : "asc"}`).join(", ");
      return plan(`select t.rid from threads t where (${list.where}) order by ${order} limit ?`, [
        ...list.params,
        1500,
      ]);
    };
    for (const chips of [
      [{ kind: "unread" }],
      [{ kind: "attachments" }],
      [{ kind: "starred" }],
      [{ kind: "year", year: 2021 }],
      [{ kind: "range", range: "month" }],
    ] as FilterChip[][]) {
      expect(choose(chips)).not.toContain("TEMP B-TREE");
    }
    expect(choose([{ kind: "unread" }])).toContain("threads_unread_idx");
    expect(choose([{ kind: "attachments" }])).toContain("threads_attachments_idx");
  });

  test("a person or a domain reads its Threads through thread_senders", () => {
    for (const chips of [
      [{ kind: "person", email: "p1234@d34.com", name: "" }],
      [{ kind: "domain", domain: "d17.com" }],
    ] as FilterChip[][]) {
      const { sql, params } = threadPageSql(listFor(chips), null, 1500);
      expect(plan(sql, params)).toMatch(/thread_senders_(email|domain)_idx/);
    }
  });

  test("a total counts through an index", () => {
    for (const [, chips] of CASES) {
      const { sql, params } = countSql(listFor(chips));
      expect(plan(sql, params)).not.toMatch(/SCAN t\b(?! USING)/);
      const run = timed(() => db.query(sql).all(...(params as never[])));
      expect(run.ms).toBeLessThan(250);
    }
  });

  test("the facets answer in time", () => {
    const inbox = threadList("inbox", "me@x.com").query;
    for (const [kind, needle] of [
      ["year", ""],
      ["person", ""],
      ["person", "person 12"],
      ["domain", ""],
      ["domain", "d3"],
    ] as Array<[FacetKind, string]>) {
      const { sql, params } = facetSql(kind, inbox, {
        needle,
        limit: 30,
        offsetMinutes: 330,
        owner: "me@x.com",
      });
      const run = timed(() => db.query(sql).all(...(params as never[])));
      expect(run.value.length).toBeGreaterThan(0);
      expect(run.ms).toBeLessThan(800);
    }
  });
});
