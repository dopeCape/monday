// The pre-warm Job through its interface with fakes at both seams: the body
// route and the platform's network and power readings.

import { describe, expect, test } from "bun:test";
import type { Change, MessageBodiesPage } from "@monday/shared";
import type { NetworkInfo, PowerInfo } from "../platform/tauri.ts";
import { bunDriver } from "../store/bun-driver.ts";
import { createFakeStore } from "../store/fake.ts";
import { changeStatements } from "../store/store.ts";
import { generateMailbox, mailboxStatements } from "./fixture.ts";
import { bodyBytes, createPrewarm, evictToCap, type PrewarmSettings } from "./prewarm.ts";

const NOW = new Date("2026-09-16T10:00:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** A Cache with headers for 200 Threads over 1,000 days and no bodies, plus the Server that has them. */
async function setup(threads = 200) {
  const full = generateMailbox({ threads, now: NOW, seed: 11, spanDays: 1_000 });
  const cache = structuredClone(full);
  for (const m of cache.messages) delete m.bodyText;
  const fake = await createFakeStore({ driver: bunDriver(), seed: null, workspaceId: "ws" });
  await fake.store.write(mailboxStatements(cache, NOW.toISOString()));
  const requests: Array<{ after: string | null; before: string | null; limit: number }> = [];
  const fetchBodies = async (
    _w: string,
    range: { after: string | null; before: string | null; limit: number },
  ): Promise<MessageBodiesPage> => {
    requests.push(range);
    const inRange = full.messages
      .filter(
        (m) =>
          (range.after === null || m.date >= range.after) &&
          (range.before === null || m.date < range.before),
      )
      .sort((x, y) => y.date.localeCompare(x.date));
    const page = inRange.slice(0, range.limit);
    const last = page[page.length - 1];
    return {
      bodies: page.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        date: m.date,
        text: m.bodyText ?? "",
        html: null,
        snippet: "",
      })),
      cursor: inRange.length > page.length && last ? last.date : null,
      total: inRange.length,
    };
  };
  return { fake, full, requests, fetchBodies };
}

const settings = (over: Partial<PrewarmSettings> = {}): PrewarmSettings => ({
  windowDays: 730,
  capGb: 2,
  onMetered: false,
  onBattery: false,
  batch: 50,
  ...over,
});

function conditions(network: Partial<NetworkInfo> = {}, power: Partial<PowerInfo> = {}) {
  const state = {
    network: { online: true, metered: false, ...network } as NetworkInfo,
    power: { mains: true, level: null, ...power } as PowerInfo,
  };
  return {
    state,
    network: async () => ({ ...state.network }),
    power: async () => ({ ...state.power }),
  };
}

async function drain(prewarm: ReturnType<typeof createPrewarm>, max = 100) {
  const steps = [];
  for (let i = 0; i < max; i++) {
    const s = await prewarm.step();
    steps.push(s);
    if (s.kind !== "fetched") break;
  }
  return steps;
}

describe("pre-warm", () => {
  test("fetches newest first down to the window and no further", async () => {
    const { fake, full, requests, fetchBodies } = await setup();
    const prewarm = createPrewarm({
      store: fake.store,
      fetchBodies,
      conditions: conditions(),
      settings: () => settings({ windowDays: 365 }),
      now: () => NOW,
    });
    const steps = await drain(prewarm);
    expect(steps[steps.length - 1]?.kind).toBe("done");
    expect(requests.length).toBeGreaterThan(1);
    // Every request is bounded by the window, and each one reaches back from the newest gap.
    for (const r of requests) expect(r.after).toBe(daysAgo(365));
    const befores = requests.map((r) => r.before ?? "");
    expect([...befores].sort().reverse()).toEqual(befores);
    const rows = await fake.store.query<{ id: string; date: string; has: number }>(
      "select id, date, body_text is not null as has from messages",
    );
    for (const r of rows) {
      const inWindow = r.date >= daysAgo(365);
      expect(Boolean(r.has), `${r.id} at ${r.date}`).toBe(inWindow);
    }
    expect(full.messages.length).toBe(rows.length);
  });

  test("stops at the size cap before the window is reached", async () => {
    const { fake, fetchBodies } = await setup();
    const capGb = 6_000 / 1024 ** 3;
    const prewarm = createPrewarm({
      store: fake.store,
      fetchBodies,
      conditions: conditions(),
      settings: () => settings({ capGb, batch: 10 }),
      now: () => NOW,
    });
    const steps = await drain(prewarm);
    expect(steps[steps.length - 1]?.kind).toBe("capped");
    expect(steps.length).toBeGreaterThan(1);
    const bytes = await bodyBytes(fake.store);
    // The Job stops short of the cap rather than landing past it; nothing was evicted.
    expect(bytes).toBeLessThanOrEqual(6_000);
    expect(steps.every((s) => s.kind === "paused" || s.evicted === 0)).toBe(true);
    const [missing] = await fake.store.query<{ n: number }>(
      "select count(*) as n from messages where body_text is null",
    );
    expect(Number(missing?.n)).toBeGreaterThan(0);
    // What it holds is the newest mail: every body is newer than every missing one.
    const [edge] = await fake.store.query<{ oldest_held: string; newest_missing: string }>(
      `select (select min(date) from messages where body_text is not null) as oldest_held,
              (select max(date) from messages where body_text is null) as newest_missing`,
    );
    expect((edge?.oldest_held ?? "") > (edge?.newest_missing ?? "")).toBe(true);
  });

  test("pauses on a metered connection or on battery, and the Settings override each", async () => {
    const { fake, fetchBodies, requests } = await setup();
    const c = conditions({ metered: true });
    const s = settings();
    const prewarm = createPrewarm({
      store: fake.store,
      fetchBodies,
      conditions: c,
      settings: () => s,
      now: () => NOW,
    });
    expect(await prewarm.step()).toEqual({ kind: "paused", reason: "metered" });
    expect(requests.length).toBe(0);
    s.onMetered = true;
    expect((await prewarm.step()).kind).toBe("fetched");
    c.state.power = { mains: false, level: 0.4 };
    expect(await prewarm.step()).toEqual({ kind: "paused", reason: "battery" });
    s.onBattery = true;
    expect((await prewarm.step()).kind).toBe("fetched");
    c.state.network = { online: false, metered: false };
    expect(await prewarm.step()).toEqual({ kind: "paused", reason: "offline" });
    expect(prewarm.status().last?.kind).toBe("paused");
  });

  test("resumes where it left off when the conditions return", async () => {
    const { fake, fetchBodies, requests } = await setup();
    const c = conditions();
    const prewarm = createPrewarm({
      store: fake.store,
      fetchBodies,
      conditions: c,
      settings: () => settings({ batch: 20 }),
      now: () => NOW,
    });
    await prewarm.step();
    const firstBefore = requests[0]?.before;
    c.state.power = { mains: false, level: 0.2 };
    expect((await prewarm.step()).kind).toBe("paused");
    c.state.power = { mains: true, level: null };
    await prewarm.step();
    expect(requests.length).toBe(2);
    expect((requests[1]?.before ?? "") < (firstBefore ?? "")).toBe(true);
  });

  test("the loop runs on its timer and stops when asked", async () => {
    const { fake, fetchBodies } = await setup(30);
    const prewarm = createPrewarm({
      store: fake.store,
      fetchBodies,
      conditions: conditions(),
      settings: () => settings({ batch: 10 }),
      now: () => NOW,
      timing: { betweenBatchesMs: 1, pausedMs: 5, idleMs: 5 },
    });
    const stop = prewarm.start();
    expect(prewarm.status().running).toBe(true);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && prewarm.status().last?.kind !== "done") {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(prewarm.status().last?.kind).toBe("done");
    stop();
    expect(prewarm.status().running).toBe(false);
  });

  test("a body the Server has not fetched yet is never cached as empty; the loop moves past it and a message change lets it try again", async () => {
    const { fake, full, fetchBodies } = await setup(20);
    const newest = [...full.messages].sort((x, y) => y.date.localeCompare(x.date))[0];
    if (!newest) throw new Error("empty mailbox");
    // The Server holds the newest Message's headers only: its sync has not fetched the body.
    const pending: typeof fetchBodies = async (w, range) => {
      const page = await fetchBodies(w, range);
      return {
        ...page,
        bodies: page.bodies.map((b) =>
          b.id === newest.id ? { ...b, text: "", bodyState: "pending" as const } : b,
        ),
      };
    };
    const prewarm = createPrewarm({
      store: fake.store,
      fetchBodies: pending,
      conditions: conditions(),
      settings: () => settings({ windowDays: 2_000 }),
      now: () => NOW,
    });
    const steps = await drain(prewarm);
    expect(steps[steps.length - 1]?.kind).toBe("done");
    const [row] = await fake.store.query<{ body_text: string | null; body_at: string | null }>(
      "select body_text, body_at from messages where id = ?",
      [newest.id],
    );
    // Missing, not empty: the reader shows Loading and asks the Server on open.
    expect(row?.body_text).toBeNull();
    expect(row?.body_at).not.toBeNull();
    const [held] = await fake.store.query<{ n: number }>(
      "select count(*) as n from messages where body_text is not null",
    );
    expect(Number(held?.n)).toBe(full.messages.length - 1);
    // The Server's news about the Message clears the mark; the next pass fetches it.
    await fake.store.write(
      changeStatements({
        seq: 1,
        workspaceId: "ws",
        kind: "message",
        entityId: newest.id,
        at: NOW.toISOString(),
        payload: {
          id: newest.id,
          threadId: newest.threadId,
          from: newest.from,
          to: newest.to,
          cc: newest.cc,
          date: newest.date,
          hasAttachments: false,
        },
      } as Change),
    );
    const again = createPrewarm({
      store: fake.store,
      fetchBodies,
      conditions: conditions(),
      settings: () => settings({ windowDays: 2_000 }),
      now: () => NOW,
    });
    await drain(again);
    const [after] = await fake.store.query<{ body_text: string | null }>(
      "select body_text from messages where id = ?",
      [newest.id],
    );
    expect(after?.body_text).toBe(newest.bodyText ?? "");
  });
});

describe("LRU eviction", () => {
  test("after an eviction the Job leaves the evicted range alone until the cap grows", async () => {
    const { fake, fetchBodies, requests } = await setup(60);
    const s = settings({ batch: 30, windowDays: 2_000 });
    const prewarm = createPrewarm({
      store: fake.store,
      fetchBodies,
      conditions: conditions(),
      settings: () => s,
      now: () => NOW,
    });
    await drain(prewarm);
    const before = requests.length;
    // Something else overfilled the Cache (a big "search older mail" pull): the next step evicts.
    await fake.store.write([
      {
        sql: "update messages set body_text = body_text || ?, body_at = ? where body_text is not null",
        params: ["x".repeat(2_000), "2026-09-16T11:00:00.000Z"],
      },
    ]);
    s.capGb = 50_000 / 1024 ** 3;
    const evictedStep = await prewarm.step();
    expect(evictedStep.kind === "paused" ? 0 : evictedStep.evicted).toBeGreaterThan(0);
    // The evicted bodies are missing again, but the Job leaves them alone.
    expect((await prewarm.step()).kind).toBe("done");
    expect(requests.length).toBe(before);
    // A larger cap clears the floor and the Job picks them up again.
    s.capGb = 2;
    expect((await prewarm.step()).kind).toBe("fetched");
    expect(requests.length).toBe(before + 1);
  });

  test("evicts the least recently used bodies first, until the Cache fits", async () => {
    const fake = await createFakeStore({ driver: bunDriver(), seed: null, workspaceId: "ws" });
    const rows = [
      { id: "a", at: "2026-09-01T00:00:00.000Z", body: "x".repeat(100) },
      { id: "b", at: "2026-09-03T00:00:00.000Z", body: "y".repeat(100) },
      { id: "c", at: "2026-09-02T00:00:00.000Z", body: "z".repeat(100) },
      { id: "d", at: "2026-09-04T00:00:00.000Z", body: "w".repeat(100) },
    ];
    await fake.store.write([
      {
        sql: "insert into threads (id, subject, last_activity) values ('t', 's', '2026-09-04T00:00:00.000Z')",
      },
      ...rows.map((r) => ({
        sql: "insert into messages (id, thread_id, sender, date, body_text, body_at) values (?, 't', '{}', ?, ?, ?)",
        params: [r.id, r.at, r.body, r.at],
      })),
    ]);
    expect(await bodyBytes(fake.store)).toBe(400);
    expect(await evictToCap(fake.store, 250)).toEqual({
      count: 2,
      newest: "2026-09-02T00:00:00.000Z",
    });
    const left = await fake.store.query<{ id: string }>(
      "select id from messages where body_text is not null order by id",
    );
    expect(left.map((r) => r.id)).toEqual(["b", "d"]);
    expect(await bodyBytes(fake.store)).toBe(200);
    expect(await evictToCap(fake.store, 250)).toEqual({ count: 0, newest: null });
    // A read that touches body_at keeps a body out of the next eviction.
    await fake.store.write([
      { sql: "update messages set body_at = '2026-09-09T00:00:00.000Z' where id = 'b'" },
    ]);
    expect((await evictToCap(fake.store, 150)).count).toBe(1);
    const kept = await fake.store.query<{ id: string }>(
      "select id from messages where body_text is not null",
    );
    expect(kept.map((r) => r.id)).toEqual(["b"]);
  });
});
