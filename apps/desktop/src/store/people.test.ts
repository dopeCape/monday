/// <reference types="bun-types" />
// The Cache's people table (store/people.ts): kept in step with `messages` by
// triggers, filled once for an older Cache, and searched by prefix with the
// shared rules, fast on a large Cache.

import { describe, expect, test } from "bun:test";
import type { Change } from "@monday/shared";
import { settingsSchema } from "@monday/shared";
import { bunDriver } from "./bun-driver.ts";
import type { SqlDriver } from "./driver.ts";
import { PEOPLE_FILL_SQL, peopleSearchQuery, rowsToPeople } from "./people.ts";
import { applySchema, changeStatements } from "./store.ts";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const ranking = {
  weights: settingsSchema["people.weights"].default,
  halfLifeDays: settingsSchema["people.recency_half_life_days"].default,
};
const ME = "tejas@genai-labs.io";
const me = { name: "Tejas", email: ME };
const kenji = { name: "Kenji Watanabe", email: "Kenji.W@meridianfund.co" };
const kelp = { name: "Kelp Weekly", email: "news@kelp.io" };
const aoife = { name: "Aoife Brennan", email: "aoife@northlight.dev" };

type P = { name: string; email: string };
let seq = 0;
const message = (from: P, to: P[], date: string, cc: P[] = []) => {
  seq += 1;
  return changeStatements({
    kind: "message",
    at: date,
    payload: {
      id: `m${seq}`,
      threadId: `t${seq}`,
      from,
      to,
      cc,
      date,
      hasAttachments: false,
    },
  } as unknown as Change);
};

const table = async (driver: SqlDriver) =>
  (
    await driver.query(
      "select email, name, name_at, wrote, addressed, last from people order by email",
    )
  ).map((r) => `${r.email} ${r.name} w${r.wrote} a${r.addressed} ${r.last}`);

const search = async (driver: SqlDriver, q: string, limit = 8) => {
  const query = peopleSearchQuery(q, ME, limit);
  if (!query) return [];
  return rowsToPeople(await driver.query(query.sql, query.params), q, ranking, NOW, limit);
};

describe("the Cache's people", () => {
  test("follow the Messages: insert, the feed's upsert again, a changed sender, a delete", async () => {
    const driver = bunDriver();
    await applySchema(driver);
    await driver.batch(message(kenji, [me], "2026-09-01T00:00:00.000Z"));
    await driver.batch(message(me, [kenji, aoife], "2026-09-02T00:00:00.000Z", [kenji]));
    const again = message(me, [aoife], "2026-09-03T00:00:00.000Z");
    await driver.batch(again);
    // The feed brings the same headers again: nothing changes.
    await driver.batch(again);
    expect(await table(driver)).toEqual([
      "aoife@northlight.dev Aoife Brennan w0 a2 2026-09-03T00:00:00.000Z",
      "kenji.w@meridianfund.co Kenji Watanabe w1 a1 2026-09-02T00:00:00.000Z",
      "tejas@genai-labs.io Tejas w2 a1 2026-09-03T00:00:00.000Z",
    ]);
    // A newer name wins; the sender changing moves the count.
    await driver.exec("update messages set sender = ? where id = ?", [
      JSON.stringify({ name: "Kelp", email: kelp.email }),
      `m${seq - 1}`,
    ]);
    expect((await table(driver)).find((r) => r.startsWith("news@"))).toBe(
      "news@kelp.io Kelp w1 a0 2026-09-02T00:00:00.000Z",
    );
    // The last Message with someone on it gone: so are they.
    await driver.exec("delete from messages where id = ?", [`m${seq - 1}`]);
    expect((await table(driver)).some((r) => r.startsWith("news@"))).toBe(false);
    await driver.close();
  });

  test("a Cache from before it is filled once, the same as the triggers keep it", async () => {
    const driver = bunDriver();
    await applySchema(driver);
    await driver.batch(message(kenji, [me], "2026-08-01T00:00:00.000Z", [aoife]));
    await driver.batch(message({ ...kenji, name: "Kenji W." }, [me], "2026-08-05T00:00:00.000Z"));
    await driver.batch(message(me, [kenji], "2026-08-06T00:00:00.000Z", [aoife, kenji]));
    await driver.batch(message(kelp, [me], "2026-08-07T00:00:00.000Z"));
    const kept = await table(driver);
    await driver.exec("delete from people");
    await driver.exec("delete from meta where key = 'people_format'");
    await applySchema(driver);
    expect(await table(driver)).toEqual(kept);
    await driver.batch(PEOPLE_FILL_SQL.map((sql) => ({ sql })));
    expect(await table(driver)).toEqual(kept);
    await driver.close();
  });

  test("match by prefix of a name word or an address part, never the user, best first", async () => {
    const driver = bunDriver();
    await applySchema(driver);
    for (let i = 0; i < 5; i++) {
      await driver.batch(message(me, [kenji], `2026-08-1${i}T00:00:00.000Z`));
    }
    for (let i = 0; i < 20; i++) {
      await driver.batch(
        message(kelp, [me], `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
      );
    }
    await driver.batch(message(aoife, [me], "2026-09-20T00:00:00.000Z"));
    const emails = async (q: string) => (await search(driver, q)).map((p) => p.email);
    expect(await emails("k")).toEqual(["kenji.w@meridianfund.co", "news@kelp.io"]);
    expect(await emails("wat")).toEqual(["kenji.w@meridianfund.co"]);
    expect(await emails("MERIDIAN")).toEqual(["kenji.w@meridianfund.co"]);
    expect(await emails("kenji.w@mer")).toEqual(["kenji.w@meridianfund.co"]);
    expect(await emails("kenji wat")).toEqual(["kenji.w@meridianfund.co"]);
    expect(await emails("ridian")).toEqual([]);
    expect(await emails("100%_")).toEqual([]);
    expect(await emails("tejas")).toEqual([]);
    expect(await emails("   ")).toEqual([]);
    const [k] = await search(driver, "kenji");
    expect(k).toMatchObject({ name: "Kenji Watanabe", sent: 5, received: 0 });
    await driver.close();
  });

  test("a prefix answers quickly over a large Cache", async () => {
    const driver = bunDriver();
    await applySchema(driver);
    const first = ["anna", "ben", "carla", "dev", "elif", "farid", "grace", "hiro"];
    const last = ["adams", "brennan", "chen", "diaz", "evans", "fischer", "garcia", "haddad"];
    const statements = [];
    for (let n = 0; n < 20_000; n++) {
      const f = first[n % first.length] ?? "x";
      const l = last[Math.floor(n / first.length) % last.length] ?? "y";
      statements.push({
        sql: "insert into people (email, name, name_at, wrote, addressed, last) values (?, ?, '', ?, ?, ?)",
        params: [
          `${f}.${l}${n}@example${n % 13}.com`,
          `${f} ${l}`,
          n % 7,
          n % 5,
          `2026-0${1 + (n % 9)}-01`,
        ],
      });
    }
    await driver.batch(statements);
    const timings: number[] = [];
    for (const q of ["a", "gr", "grace h", "example3", "carla.chen1"]) {
      await search(driver, q);
      const t = performance.now();
      const hits = await search(driver, q);
      timings.push(performance.now() - t);
      expect(hits.length).toBeGreaterThan(0);
    }
    console.error(
      `[people] Cache of 20000 people: ${timings.map((t) => t.toFixed(1)).join(", ")} ms`,
    );
    for (const t of timings) expect(t).toBeLessThan(50);
    await driver.close();
  });
});
