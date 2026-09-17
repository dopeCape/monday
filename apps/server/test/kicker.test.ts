import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cloudIsAlive, freshServers, writeHeartbeat } from "../src/heartbeat.ts";
import { createJobs } from "../src/jobs/index.ts";
import { createProcessKicker } from "../src/kicker/process.ts";
import { bearerCronAuth, createServerlessKicker } from "../src/kicker/serverless.ts";
import { type TestDatabase, testDatabase, waitFor } from "./harness.ts";

describe("heartbeats", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await testDatabase();
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("write, refresh and read fresh rows", async () => {
    const t0 = new Date("2026-09-16T10:00:00Z");
    await writeHeartbeat(db.handle.db, "sidecar-1", "sidecar", t0);
    await writeHeartbeat(db.handle.db, "vercel-1", "vercel", t0);
    await writeHeartbeat(db.handle.db, "vercel-1", "vercel", new Date(t0.getTime() + 30_000));

    const rows = await db.handle.sql`select id, mode, last_seen from servers order by id`;
    expect(rows).toHaveLength(2);
    // Raw postgres.js rows carry timestamps as text; drizzle maps them to Date.
    expect(new Date(String(rows[1]?.last_seen))).toEqual(new Date(t0.getTime() + 30_000));

    const at = new Date(t0.getTime() + 60_000);
    expect((await freshServers(db.handle.db, at)).map((s) => s.id).sort()).toEqual([
      "sidecar-1",
      "vercel-1",
    ]);
    expect(await cloudIsAlive(db.handle.db, "sidecar-1", at)).toBe(true);

    // Three missed beats later the cloud is considered gone.
    const later = new Date(t0.getTime() + 30_000 + 90_001);
    expect(await cloudIsAlive(db.handle.db, "sidecar-1", later)).toBe(false);
    // A server never counts itself as the cloud it is waiting for.
    expect(await cloudIsAlive(db.handle.db, "vercel-1", at)).toBe(false);
  });
});

describe("process kicker", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await testDatabase();
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("writes its heartbeat, runs jobs on NOTIFY, and removes the heartbeat on stop", async () => {
    const jobs = createJobs(db.handle.db);
    const ran: string[] = [];
    jobs.registerStep<{ n: number }>("ping", async (job) => {
      ran.push(`ping-${job.payload.n}`);
      return "done";
    });
    const kicker = createProcessKicker({
      jobs,
      db: db.handle.db,
      serverId: "test-kicker",
      mode: "container",
      canServe: () => ["needs-process", "needs-public-url"],
      listenUrl: db.url,
      pollMs: 60_000, // long, so a run inside the timeout proves NOTIFY woke it
      heartbeatMs: 100,
      budgetMs: 5_000,
    });
    await kicker.start();

    const beats = await db.handle.sql`select id, mode from servers where id = 'test-kicker'`;
    expect([...beats]).toEqual([{ id: "test-kicker", mode: "container" }]);

    const before = await db.handle.sql`select last_seen from servers where id = 'test-kicker'`;
    await waitFor(async () => {
      const after = await db.handle.sql`select last_seen from servers where id = 'test-kicker'`;
      return Date.parse(String(after[0]?.last_seen)) > Date.parse(String(before[0]?.last_seen));
    }, 3_000);

    await jobs.enqueue("ping", { n: 1 });
    await waitFor(() => ran.includes("ping-1"), 3_000);
    const id2 = await jobs.enqueue("ping", { n: 2 });
    await waitFor(async () => (await jobs.get(id2))?.status === "done", 3_000);
    expect(ran).toEqual(["ping-1", "ping-2"]);

    await kicker.stop();
    const gone = await db.handle.sql`select id from servers where id = 'test-kicker'`;
    expect(gone).toHaveLength(0);
  }, 20_000);

  test("does not claim jobs whose needs it cannot serve", async () => {
    const jobs = createJobs(db.handle.db);
    let served = 0;
    jobs.registerStep("webhook", async () => {
      served += 1;
      return "done";
    });
    const kicker = createProcessKicker({
      jobs,
      db: db.handle.db,
      serverId: "sidecar-kicker",
      mode: "sidecar",
      canServe: () => ["needs-process"],
      listenUrl: db.url,
      pollMs: 50,
      budgetMs: 5_000,
    });
    await kicker.start();
    const id = await jobs.enqueue("webhook", {}, { needs: ["needs-public-url"] });
    await new Promise((r) => setTimeout(r, 300));
    expect(served).toBe(0);
    expect((await jobs.get(id))?.status).toBe("queued");
    await kicker.stop();
  }, 20_000);
});

describe("serverless kicker", () => {
  let db: TestDatabase;

  function fakeClock(start = Date.parse("2026-09-17T09:00:00Z")) {
    let t = start;
    return {
      now: () => new Date(t),
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  beforeAll(async () => {
    db = await testDatabase();
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("a tick writes the heartbeat, sweeps, runs what fits the budget and stops", async () => {
    const clock = fakeClock();
    const jobs = createJobs(db.handle.db, { now: clock.now });
    const ran: number[] = [];
    // Each step "takes" 12 s of the fake clock.
    jobs.registerStep<{ n: number }>("work", async (job) => {
      ran.push(job.payload.n);
      clock.advance(12_000);
      return "done";
    });
    for (const n of [1, 2, 3, 4]) await jobs.enqueue("work", { n }, { runAt: clock.now() });
    // A lease another Server let expire is swept back before the pass claims.
    const stale = await jobs.enqueue("work", { n: 5 }, { runAt: clock.now() });
    const expired = new Date(clock.now().getTime() - 1).toISOString();
    await db.handle
      .sql`update jobs set status = 'running', lease_owner = 'gone', lease_until = ${expired} where id = ${stale}`;

    const kicker = createServerlessKicker({
      jobs,
      db: db.handle.db,
      serverId: "vercel-1",
      mode: "vercel",
      canServe: () => ["needs-public-url", "needs-always-on"],
      invocationLimitMs: 300_000,
      minStepMs: 2_000,
      now: clock.now,
    });
    // 25 s tick budget (the Setting's default): two 12 s steps fit; with 1 s
    // left, under the 2 s minimum, the third does not start.
    const summary = await kicker.tick();
    expect(summary.swept).toBe(1);
    expect(summary.ran).toBe(2);
    expect(summary.stopped).toBe("budget");
    expect(ran).toHaveLength(2);

    const beat = await db.handle.sql`select mode, last_seen from servers where id = 'vercel-1'`;
    expect(beat[0]?.mode).toBe("vercel");
    expect(new Date(String(beat[0]?.last_seen))).toEqual(clock.now());

    // The next ticks (the cron, minute by minute) finish the rest, two per tick.
    const next = await kicker.tick();
    expect(next).toMatchObject({ ran: 2, stopped: "budget" });
    const last = await kicker.tick();
    expect(last).toMatchObject({ ran: 1, stopped: "empty" });
    expect(ran.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test("the cron route needs the bearer secret and a wake runs a bounded pass", async () => {
    const clock = fakeClock();
    const own = await testDatabase();
    const db = own;
    const jobs = createJobs(db.handle.db, { now: clock.now });
    const ran: string[] = [];
    jobs.registerStep("ping", async (job) => {
      ran.push(job.id);
      return "done";
    });
    const kicked: Promise<unknown>[] = [];
    const kicker = createServerlessKicker({
      jobs,
      db: db.handle.db,
      serverId: "vercel-2",
      mode: "vercel",
      canServe: () => ["needs-public-url"],
      invocationLimitMs: 300_000,
      authorizeCron: bearerCronAuth("s3cret"),
      waitUntil: (p) => {
        kicked.push(p);
      },
      now: clock.now,
    });
    const app = kicker.routes();
    expect((await app.request("/cron/tick")).status).toBe(401);
    expect(
      (await app.request("/cron/tick", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    const ok = await app.request("/cron/tick", { headers: { authorization: "Bearer s3cret" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ran: 0, stopped: "empty" });

    // An enqueue wakes the kicker; the pass lands in waitUntil and runs the job.
    const woken = createJobs(db.handle.db, { now: clock.now, onEnqueue: () => kicker.wake() });
    woken.registerStep("ping", async () => "done");
    const id = await woken.enqueue("ping", {});
    expect(kicked).toHaveLength(1);
    await kicked[0];
    expect(ran).toEqual([id]);
    await own.drop();
  });
});
