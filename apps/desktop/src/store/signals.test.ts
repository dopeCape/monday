// The Cache's Signals (slice 30): a Cache from before the Signal store moves
// its thread_judgments into thread_signals once and drops the table; the
// feed's `signals` and `signal_def` changes land as rows; a newer Question
// version reads as stale; and a money-and-Waiting query is plain SQL.

import { describe, expect, test } from "bun:test";
import { bunDriver } from "./bun-driver.ts";
import { rowSignals, threadsByIdsSql } from "./queries.ts";
import { applySchema, changeStatements } from "./store.ts";

describe("the Cache's Signals", () => {
  test("a Cache from slice 25 keeps its Judgments as shipped Signals and loses the old table", async () => {
    const driver = bunDriver();
    await applySchema(driver);
    // A slice 25 Cache: thread_judgments with a row, and no signals format yet.
    await driver.exec(`create table thread_judgments (
      thread_id text primary key, needs_reply real not null default 0, waiting_on_others real not null default 0,
      newsletter real not null default 0, automated real not null default 0, brief_worth real not null default 0,
      urgency real not null default 0, chips text not null default '{}', model text not null default '',
      judged_at text not null default '')`);
    await driver.exec(
      `insert into thread_judgments values ('t1', 0.8, 0.1, 0.05, 0.02, 2, 1.5, '{"reply":0.9,"review_link":0.4}', 'jev-1.13.0', '2026-09-16T10:00:00.000Z')`,
    );
    await driver.exec("delete from meta where key = 'signals_format'");
    await applySchema(driver);
    const rows = await driver.query(
      "select signal_id, noul, score from thread_signals where thread_id = 't1' order by signal_id",
    );
    expect(rows).toEqual([
      { signal_id: "automated", noul: 0.02, score: null },
      { signal_id: "brief_worth", noul: null, score: 2 },
      { signal_id: "chip_reply", noul: 0.9, score: null },
      { signal_id: "needs_reply", noul: 0.8, score: null },
      { signal_id: "newsletter", noul: 0.05, score: null },
      { signal_id: "urgency", noul: null, score: 1.5 },
      { signal_id: "waiting_on_others", noul: 0.1, score: null },
    ]);
    expect(
      await driver.query("select name from sqlite_master where name = 'thread_judgments'"),
    ).toEqual([]);
    // Applying again moves nothing twice.
    await applySchema(driver);
    expect(await driver.query("select count(*) as n from thread_signals")).toEqual([{ n: 7 }]);
    await driver.close();
  });

  test("feed rows land, a newer version reads stale, and a Signal query is one SQL statement", async () => {
    const driver = bunDriver();
    await applySchema(driver);
    await driver.exec(
      "insert into threads (id, subject, participants, last_activity, message_count) values ('t1', 's', '[]', '2026-09-16T10:00:00.000Z', 1)",
    );
    const at = "2026-09-16T10:00:00.000Z";
    await driver.batch(
      changeStatements({
        seq: 1,
        workspaceId: "w",
        entityId: "t1",
        at,
        kind: "signals",
        payload: {
          threadId: "t1",
          answers: [
            {
              signalId: "money_involved",
              version: 1,
              noul: 0.93,
              choice: null,
              score: null,
              confidence: null,
              stale: false,
              lowTrust: null,
              judgedAt: at,
            },
            {
              signalId: "frustrated",
              version: 1,
              noul: null,
              choice: null,
              score: 2.1,
              confidence: 0.8,
              stale: false,
              lowTrust: null,
              judgedAt: at,
            },
          ],
        },
      }),
    );
    const read = async () => rowSignals((await driver.query(threadsByIdsSql(1), ["t1"]))[0] ?? {});
    expect((await read()).money_involved).toMatchObject({ noul: 0.93, stale: false, version: 1 });
    expect((await read()).frustrated).toMatchObject({ score: 2.1, confidence: 0.8 });
    await driver.batch(
      changeStatements({
        seq: 2,
        workspaceId: "w",
        entityId: "frustrated",
        at,
        kind: "signal_def",
        payload: {
          id: "frustrated",
          kind: "score",
          version: 2,
          ownerKind: "shipped",
          ownerId: null,
          active: true,
          label: "How frustrated",
        },
      }),
    );
    expect((await read()).frustrated?.stale).toBe(true);
    expect((await read()).money_involved?.stale).toBe(false);
    expect(
      await driver.query(
        "select thread_id from thread_signals where signal_id = 'money_involved' and noul >= 0.7",
      ),
    ).toEqual([{ thread_id: "t1" }]);
    // The Facts land beside them; "money involved and a deadline before Friday" is one SQL query, offline.
    await driver.batch(
      changeStatements({
        seq: 5,
        workspaceId: "w",
        entityId: "t1",
        at,
        kind: "facts",
        payload: {
          threadId: "t1",
          facts: {
            deadline_at: "2026-10-01T23:59:00.000Z",
            deadline_unclear: false,
            from_domain: "hetzner.com",
            amount_count: 2,
            language: "en",
          },
        },
      }),
    );
    const friday = "2026-10-02T00:00:00.000Z";
    expect(
      await driver.query(
        `select s.thread_id from thread_signals s join thread_facts f on f.thread_id = s.thread_id
         where s.signal_id = 'money_involved' and s.noul >= 0.7 and f.deadline_at < ?`,
        [friday],
      ),
    ).toEqual([{ thread_id: "t1" }]);
    expect(await driver.query("select from_domain, amount_count from thread_facts")).toEqual([
      { from_domain: "hetzner.com", amount_count: 2 },
    ]);
    // A removed answer goes; a deleted Thread's answers all go.
    await driver.batch(
      changeStatements({
        seq: 3,
        workspaceId: "w",
        entityId: "t1",
        at,
        kind: "signals",
        payload: { threadId: "t1", answers: [], removed: ["frustrated"] },
      }),
    );
    expect(Object.keys(await read())).toEqual(["money_involved"]);
    await driver.batch(
      changeStatements({
        seq: 4,
        workspaceId: "w",
        entityId: "t1",
        at,
        kind: "signals",
        payload: { threadId: "t1", answers: [], deleted: true },
      }),
    );
    expect(await read()).toEqual({});
    await driver.close();
  });
});
