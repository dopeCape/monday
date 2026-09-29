// The people index (src/people/index.ts, migration 0022): who the composer
// suggests, over the whole mailbox. Through the Mailstore's writes, the
// delivered-send hook, the route, the migration's backfill and a large
// synthetic mailbox for speed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, PeopleSearchPage, Person } from "@monday/shared";
import { personScore, settingsSchema } from "@monday/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import type { Db } from "../src/db/client.ts";
import { loadMigrations } from "../src/db/migrate.ts";
import { people } from "../src/db/schema.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { peopleTsQuery, recordSend, searchPeople } from "../src/people/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const ranking = {
  weights: settingsSchema["people.weights"].default,
  halfLifeDays: settingsSchema["people.recency_half_life_days"].default,
};

const account = (id: string, address: string): Account => ({
  id,
  provider: "jmap",
  address,
  displayName: "Tejas",
  capabilities: {
    push: true,
    labels: true,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
});

const me: Person = { name: "Tejas", email: "tejas@genai-labs.io" };
const kenji: Person = { name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" };
const kelp: Person = { name: "Kelp Weekly", email: "news@kelp.io" };
const margarethe: Person = { name: "Margarethe Olde", email: "m.olde@archive.example" };
const aoife: Person = { name: "Aoife Brennan", email: "aoife@northlight.dev" };
const siobhan: Person = { name: "Siobhan Quinn", email: "siobhan@northlight.dev" };

/** The migration's backfill statement, exactly as it runs on an older mailbox. */
function backfillStatement(): string {
  for (const m of loadMigrations()) {
    const found = m.sql.find((s) => s.includes('INSERT INTO "people"'));
    if (found) return found;
  }
  throw new Error("no people backfill in the migrations");
}

describe("people index", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  let seq = 0;
  const SIDECAR_TOKEN = "people-token";

  /** One Message in a Thread of its own, stored the way sync stores it. */
  const mail = async (from: Person, to: Person[], date: string, cc: Person[] = []) => {
    seq += 1;
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: `t-${seq}`,
      subject: `Subject ${seq}`,
      participants: [from, ...to, ...cc],
      lastActivity: date,
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: `m-${seq}`,
      from,
      to,
      cc,
      date,
      headers: {},
      bodyText: "",
      bodyHtml: null,
      snippet: "",
    });
    return { threadId, providerMessageId: `m-${seq}` };
  };

  const search = (q: string, limit = 10) =>
    searchPeople(db.handle.db, workspaceId, me.email, { q, limit, ranking, now: NOW });
  const row = async (address: string) =>
    (
      await db.handle.db
        .select()
        .from(people)
        .where(and(eq(people.workspaceId, workspaceId), eq(people.address, address)))
    )[0];

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    store = createMailstore(db.handle.db, keys);
    await keys.unlock(randomKey());
    const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN, setupCode: "222222" });
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      keys,
      mailstore: store,
      remoteAddress: () => "127.0.0.1",
      now: () => NOW,
    });
    // The Account's address in mixed case: the owner is matched lowercased.
    workspaceId = (await store.createWorkspace(account("acct-people", "Tejas@GenAI-labs.io"))).id;

    // The user writes to Kenji often; Kenji wrote back once.
    for (let i = 0; i < 6; i++) await mail(me, [kenji], `2026-08-${10 + i}T09:00:00.000Z`);
    await mail(kenji, [me], "2026-08-20T09:00:00.000Z");
    // A newsletter writes far more often, and more recently.
    for (let i = 0; i < 40; i++) {
      await mail(kelp, [me], `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T07:00:00.000Z`);
    }
    // Someone only in mail from 2012, far outside any Cache window.
    await mail(me, [margarethe], "2012-03-04T10:00:00.000Z");
    // Aoife writes with a colleague on Cc and the user on To.
    await mail(aoife, [me], "2026-09-20T10:00:00.000Z", [siobhan]);
    await mail(aoife, [me], "2026-09-21T10:00:00.000Z");
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("the typed words become prefix lexemes; punctuation also matches piece by piece", () => {
    expect(peopleTsQuery("Kenji")).toBe("'kenji':*");
    expect(peopleTsQuery("kenji wat")).toBe("'kenji':* & 'wat':*");
    expect(peopleTsQuery("kenji.w@meri")).toBe(
      "('kenji.w@meri':* | ('kenji':* & 'w':* & 'meri':*))",
    );
    expect(peopleTsQuery("o'brien")).toBe("('o''brien':* | ('o':* & 'brien':*))");
    expect(peopleTsQuery("  , ")).toBe("");
    expect(peopleTsQuery("&|!:*")).toBe("");
  });

  test("a person the user sends to often ranks above a frequent sender", async () => {
    const hits = await search("k");
    expect(hits.map((h) => h.email)).toEqual([kenji.email, kelp.email]);
    const [k, n] = hits;
    expect(k).toMatchObject({ name: "Kenji Watanabe", sent: 6, received: 1 });
    expect(n).toMatchObject({ name: "Kelp Weekly", sent: 0, received: 40 });
    expect((k?.score ?? 0) > (n?.score ?? 0)).toBe(true);
  });

  test("finds a person present only in mail from years ago", async () => {
    const hits = await search("marg");
    expect(hits.map((h) => h.email)).toEqual([margarethe.email]);
    expect(hits[0]).toMatchObject({ sent: 1, lastAt: "2012-03-04T10:00:00.000Z" });
    expect((await search("archive")).map((h) => h.email)).toEqual([margarethe.email]);
  });

  test("the user's own address is never a person", async () => {
    expect(await search("tejas")).toEqual([]);
    expect(await search("genai")).toEqual([]);
    expect(await row("tejas@genai-labs.io")).toBeUndefined();
  });

  test("matches words of the name and the address, its local part, domain and pieces", async () => {
    const emails = async (q: string) => (await search(q)).map((h) => h.email);
    expect(await emails("wat")).toEqual([kenji.email]);
    expect(await emails("WATANABE")).toEqual([kenji.email]);
    expect(await emails("meridian")).toEqual([kenji.email]);
    expect(await emails("kenji.w")).toEqual([kenji.email]);
    expect(await emails("kenji.w@meri")).toEqual([kenji.email]);
    expect(await emails("kenji wat")).toEqual([kenji.email]);
    expect(await emails("w")).toContain(kenji.email);
    // Not a prefix of any word: no match.
    expect(await emails("ridian")).toEqual([]);
    expect(await emails("kenji brennan")).toEqual([]);
    // Both from northlight.dev: the one who writes first.
    expect(await emails("northlight")).toEqual([aoife.email, siobhan.email]);
  });

  test("someone only ever on Cc of another's mail is found, with nothing counted", async () => {
    expect(await search("siob")).toMatchObject([
      { email: siobhan.email, name: "Siobhan Quinn", sent: 0, received: 0 },
    ]);
  });

  test("new mail updates the counts and the name as last seen; a body landing later counts nothing", async () => {
    const before = await row(aoife.email);
    const m = await mail(
      { name: "Aoife B.", email: "AOIFE@northlight.dev" },
      [me],
      "2026-09-25T10:00:00.000Z",
    );
    let after = await row(aoife.email);
    expect(after?.receivedCount).toBe((before?.receivedCount ?? 0) + 1);
    expect(after?.name).toBe("Aoife B.");
    expect(after?.lastAt?.toISOString()).toBe("2026-09-25T10:00:00.000Z");

    // An older Message arriving late neither renames nor moves last_at back.
    await mail(aoife, [me], "2026-01-01T10:00:00.000Z");
    after = await row(aoife.email);
    expect(after?.name).toBe("Aoife B.");
    expect(after?.lastAt?.toISOString()).toBe("2026-09-25T10:00:00.000Z");
    const counted = after?.receivedCount ?? 0;

    // The body fetch re-upserts the same Message: no second count.
    const stored = await store.findMessage(
      (
        await db.handle.db.execute<{ id: string }>(
          sql`select id from messages where provider_message_id = ${m.providerMessageId}`,
        )
      )[0]?.id ?? "",
    );
    if (!stored) throw new Error("message not stored");
    await store.upsertMessage({
      threadId: m.threadId,
      providerMessageId: m.providerMessageId,
      from: { name: "Aoife B.", email: "AOIFE@northlight.dev" },
      to: [me],
      cc: [],
      date: "2026-09-25T10:00:00.000Z",
      headers: {},
      bodyText: "the body, now fetched",
      bodyHtml: null,
      snippet: "the body",
    });
    expect((await row(aoife.email))?.receivedCount).toBe(counted);
  });

  test("a delivered send counts at once and the sent copy settles it", async () => {
    const nadia: Person = { name: "Nadia Petrova", email: "nadia@orbital.space" };
    await db.handle.db.transaction(async (tx) => {
      await recordSend(tx, workspaceId, me.email, [nadia, me, { ...nadia, name: "" }], NOW);
    });
    expect(await search("nadia")).toMatchObject([{ email: nadia.email, sent: 1 }]);
    expect((await row(nadia.email))?.pendingSent).toBe(1);
    await mail(me, [nadia], NOW.toISOString());
    const settled = await row(nadia.email);
    expect(settled).toMatchObject({ sentCount: 1, pendingSent: 0, name: "Nadia Petrova" });
    expect(await search("nadia")).toMatchObject([{ sent: 1 }]);
  });

  test("the score in SQL is the shared personScore", async () => {
    const [hit] = await search("kenji");
    if (!hit) throw new Error("no hit");
    expect(hit.score).toBeCloseTo(personScore(hit, NOW, ranking), 6);
  });

  test("GET /people answers the index, validates and stays in its Workspace", async () => {
    const auth = { headers: { authorization: `Bearer ${SIDECAR_TOKEN}` } };
    const res = await app.request(
      `/people?${new URLSearchParams({ workspace: workspaceId, q: "k", limit: "1" })}`,
      auth,
    );
    expect(res.status).toBe(200);
    const page = (await res.json()) as PeopleSearchPage;
    expect(page.people.map((p) => p.email)).toEqual([kenji.email]);
    expect((await app.request("/people?q=k", auth)).status).toBe(400);
    const empty = await app.request(
      `/people?${new URLSearchParams({ workspace: workspaceId })}`,
      auth,
    );
    expect(((await empty.json()) as PeopleSearchPage).people).toEqual([]);
    const other = await app.request(
      `/people?${new URLSearchParams({ workspace: "nope", q: "k" })}`,
      auth,
    );
    expect(((await other.json()) as PeopleSearchPage).people).toEqual([]);
    expect((await app.request(`/people?workspace=${workspaceId}&q=k`)).status).toBe(401);
  });

  test("the migration's backfill rebuilds what the writes kept", async () => {
    const snapshot = async (h: Db) =>
      (
        await h
          .select({
            address: people.address,
            name: people.name,
            sent: people.sentCount,
            received: people.receivedCount,
            lastAt: people.lastAt,
          })
          .from(people)
          .where(eq(people.workspaceId, workspaceId))
          .orderBy(asc(people.address))
      ).map((r) => ({ ...r, lastAt: r.lastAt?.toISOString() ?? null }));
    const kept = await snapshot(db.handle.db);
    expect(kept.length).toBeGreaterThan(5);
    await db.handle.db.execute(sql`delete from people`);
    expect(await snapshot(db.handle.db)).toEqual([]);
    await db.handle.sql.unsafe(backfillStatement());
    // Nadia's send was delivered and synced; the backfill sees only the synced copy, the same count.
    expect(await snapshot(db.handle.db)).toEqual(kept);
  });
});

describe("people index at scale", () => {
  let db: TestDatabase;
  let workspaceId = "";
  const THREADS = 56_000;
  const PEOPLE = 20_000;
  const FIRST = [
    "anna",
    "ben",
    "carla",
    "dev",
    "elif",
    "farid",
    "grace",
    "hiro",
    "ines",
    "jonas",
    "kenji",
    "lena",
    "marco",
    "nadia",
    "omar",
    "priya",
  ];
  const LAST = [
    "adams",
    "brennan",
    "chen",
    "diaz",
    "evans",
    "fischer",
    "garcia",
    "haddad",
    "ivanova",
    "jensen",
    "kowalski",
    "lopez",
    "moreau",
    "nakamura",
    "okafor",
    "patel",
  ];
  const DOMAINS = [
    "gmail.com",
    "meridianfund.co",
    "northlight.dev",
    "orbital.space",
    "kelp.io",
    "example.org",
    "acme.com",
    "fastmail.fm",
  ];

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    const store = createMailstore(db.handle.db, keys);
    await keys.unlock(randomKey());
    workspaceId = (await store.createWorkspace(account("acct-scale", me.email))).id;
    const firsts = `ARRAY[${FIRST.map((f) => `'${f}'`).join(",")}]`;
    const lasts = `ARRAY[${LAST.map((f) => `'${f}'`).join(",")}]`;
    const domains = `ARRAY[${DOMAINS.map((f) => `'${f}'`).join(",")}]`;
    // Person n: a first and last name and a domain, all from n, so prefixes hit thousands.
    const person = (n: string) => `jsonb_build_object(
      'name', initcap((${firsts})[1 + (${n}) % ${FIRST.length}]) || ' ' || initcap((${lasts})[1 + ((${n}) / ${FIRST.length}) % ${LAST.length}]),
      'email', (${firsts})[1 + (${n}) % ${FIRST.length}] || '.' || (${lasts})[1 + ((${n}) / ${FIRST.length}) % ${LAST.length}] || (${n}) || '@' || (${domains})[1 + (${n}) % ${DOMAINS.length}])`;
    const ws = `'${workspaceId}'`;
    await db.handle.sql.unsafe(`
      insert into threads (id, workspace_id, provider_thread_id, subject_enc, subject_key, last_activity)
      select 't' || g, ${ws}, 'p' || g, '\\x00'::bytea, '\\x00'::bytea, timestamptz '2026-09-29' - (g || ' hours')::interval
      from generate_series(1, ${THREADS}) g`);
    // Three Messages a Thread: two from a person to the user, one reply from the user with a Cc.
    await db.handle.sql.unsafe(`
      insert into messages (id, thread_id, workspace_id, provider_message_id, "from", "to", cc, date, body_enc, body_key, snippet_enc, snippet_key)
      select 'm' || g || '-' || k, 't' || g, ${ws}, 'pm' || g || '-' || k,
        case when k = 3 then '{"name":"Tejas","email":"tejas@genai-labs.io"}'::jsonb else ${person(`(g * 7) % ${PEOPLE}`)} end,
        case when k = 3 then jsonb_build_array(${person(`(g * 7) % ${PEOPLE}`)}) else '[{"name":"Tejas","email":"tejas@genai-labs.io"}]'::jsonb end,
        case when k = 3 then jsonb_build_array(${person(`(g * 13) % ${PEOPLE}`)}) else '[]'::jsonb end,
        timestamptz '2026-09-29' - (g || ' hours')::interval + (k || ' minutes')::interval,
        '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea
      from generate_series(1, ${THREADS}) g, generate_series(1, 3) k`);
    await db.handle.sql.unsafe("analyze messages");
  }, 300_000);

  afterAll(async () => {
    await db.drop();
  });

  test("the backfill fills a 56k-Thread mailbox and a prefix query answers under 50 ms", async () => {
    const started = performance.now();
    await db.handle.sql.unsafe(backfillStatement());
    const backfillMs = performance.now() - started;
    await db.handle.sql.unsafe("analyze people");
    const [{ n } = { n: 0 }] = await db.handle.sql<
      { n: number }[]
    >`select count(*)::int as n from people`;
    expect(n).toBeGreaterThan(10_000);

    const queries = [
      "a",
      "k",
      "ke",
      "kenji",
      "nakamura",
      "gmail",
      "meridian",
      "anna.adams",
      "grace h",
      "x",
    ];
    const timings: Record<string, number> = {};
    for (const q of queries) {
      // One warm-up, then the best of three: the machine may be busy with other work.
      await searchPeople(db.handle.db, workspaceId, me.email, { q, limit: 8, ranking });
      const runs: number[] = [];
      let hits = 0;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        hits = (await searchPeople(db.handle.db, workspaceId, me.email, { q, limit: 8, ranking }))
          .length;
        runs.push(performance.now() - t);
      }
      timings[q] = Math.min(...runs);
      if (q !== "x") expect(hits).toBeGreaterThan(0);
    }
    console.error(
      `[people] ${THREADS} threads, ${THREADS * 3} messages, ${n} people; backfill ${backfillMs.toFixed(0)} ms; ` +
        Object.entries(timings)
          .map(([q, ms]) => `"${q}" ${ms.toFixed(1)} ms`)
          .join(", "),
    );
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(50);
  }, 300_000);
});
