import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cloudIsAlive, freshServers, writeHeartbeat } from "../src/heartbeat.ts";
import { createJobs } from "../src/jobs/index.ts";
import { createProcessKicker } from "../src/kicker/process.ts";
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
