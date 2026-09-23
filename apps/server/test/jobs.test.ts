import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

/** A clock the tests move by hand so backoff and leases need no real waiting. */
function fakeClock(start = Date.parse("2026-09-16T10:00:00Z")) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("jobs", () => {
  let db: TestDatabase;
  let jobs: Jobs;
  const clock = fakeClock();
  const ANY: string[] = ["needs-process", "needs-public-url"];

  beforeAll(async () => {
    db = await testDatabase();
    jobs = createJobs(db.handle.db, { now: clock.now, backoffMs: (attempt) => attempt * 1000 });
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("enqueue, claim, complete", async () => {
    const id = await jobs.enqueue("sync", { account: "a1" });
    const claimed = await jobs.claim("server-a", ANY, 30_000);
    expect(claimed?.id).toBe(id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.leaseOwner).toBe("server-a");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.payload).toEqual({ account: "a1" });
    expect(claimed?.leaseUntil?.getTime()).toBe(clock.now().getTime() + 30_000);

    // Nobody else can claim it while the lease is held.
    expect(await jobs.claim("server-b", ANY, 30_000)).toBeNull();

    await jobs.complete(id, "server-a");
    const done = await jobs.get(id);
    expect(done?.status).toBe("done");
    expect(done?.leaseOwner).toBeNull();
  });

  test("enqueue with an id is idempotent", async () => {
    const id = `fixed-${crypto.randomUUID()}`;
    await jobs.enqueue("dedupe", { n: 1 }, { id });
    await jobs.enqueue("dedupe", { n: 2 }, { id });
    const rows = await db.handle.sql`select payload from jobs where id = ${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ n: 1 });
    const claimed = await jobs.claim("server-a", ANY, 1000);
    await jobs.complete(claimed?.id ?? "", "server-a");
  });

  test("a job scheduled for later is not claimable until run_at", async () => {
    const runAt = new Date(clock.now().getTime() + 60_000);
    const id = await jobs.enqueue("later", {}, { runAt });
    expect(await jobs.claim("server-a", ANY, 1000)).toBeNull();
    clock.advance(60_000);
    const claimed = await jobs.claim("server-a", ANY, 1000);
    expect(claimed?.id).toBe(id);
    await jobs.complete(id, "server-a");
  });

  test("fail backs off and gives up after three attempts", async () => {
    const id = await jobs.enqueue("flaky", {});

    // Attempt 1
    let claimed = await jobs.claim("server-a", ANY, 1000);
    expect(claimed?.id).toBe(id);
    await jobs.fail(id, "server-a", "boom 1");
    let row = await jobs.get(id);
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("boom 1");
    expect(row?.runAt.getTime()).toBe(clock.now().getTime() + 1000);
    expect(await jobs.claim("server-a", ANY, 1000)).toBeNull();

    // Attempt 2
    clock.advance(1000);
    claimed = await jobs.claim("server-a", ANY, 1000);
    expect(claimed?.attempts).toBe(2);
    await jobs.fail(id, "server-a", "boom 2");
    row = await jobs.get(id);
    expect(row?.status).toBe("queued");
    expect(row?.runAt.getTime()).toBe(clock.now().getTime() + 2000);

    // Attempt 3, the last one
    clock.advance(2000);
    claimed = await jobs.claim("server-a", ANY, 1000);
    expect(claimed?.attempts).toBe(3);
    await jobs.fail(id, "server-a", "boom 3");
    row = await jobs.get(id);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("boom 3");
    expect(row?.leaseOwner).toBeNull();

    clock.advance(60_000);
    expect(await jobs.claim("server-a", ANY, 1000)).toBeNull();
  });

  test("fail by a non-owner is ignored", async () => {
    const id = await jobs.enqueue("owned", {});
    await jobs.claim("server-a", ANY, 1000);
    await jobs.fail(id, "server-b", "not mine");
    expect((await jobs.get(id))?.status).toBe("running");
    await jobs.complete(id, "server-a");
  });

  test("sweep returns expired leases to the queue and fails exhausted ones", async () => {
    const fresh = await jobs.enqueue("sweep-fresh", {});
    const stale = await jobs.enqueue("sweep-stale", {});
    await jobs.claim("server-a", ANY, 1000); // fresh, ordered first by run_at then created_at
    await jobs.claim("server-a", ANY, 1000); // stale
    expect((await jobs.get(fresh))?.status).toBe("running");
    expect((await jobs.get(stale))?.status).toBe("running");

    expect(await jobs.sweepExpiredLeases()).toBe(0);
    clock.advance(1001);
    expect(await jobs.sweepExpiredLeases()).toBe(2);
    for (const id of [fresh, stale]) {
      const row = await jobs.get(id);
      expect(row?.status).toBe("queued");
      expect(row?.leaseOwner).toBeNull();
      expect(row?.lastError).toBe("lease expired");
    }

    // A job whose lease keeps expiring is failed once its attempts are spent.
    for (let i = 0; i < 2; i++) {
      await jobs.claim("server-a", ANY, 1000);
      await jobs.claim("server-a", ANY, 1000);
      clock.advance(1001);
      await jobs.sweepExpiredLeases();
    }
    expect((await jobs.get(fresh))?.status).toBe("failed");
    expect((await jobs.get(stale))?.status).toBe("failed");
  });

  test("needs filtering: an owner claims only what it can serve", async () => {
    const webhook = await jobs.enqueue("register-webhook", {}, { needs: ["needs-public-url"] });
    const idle = await jobs.enqueue("imap-idle", {}, { needs: ["needs-process"] });
    const plain = await jobs.enqueue("brief", {});

    // A sidecar that cannot serve a public URL never sees the webhook job.
    const sidecarFirst = await jobs.claim("sidecar", ["needs-process"], 1000);
    expect(sidecarFirst?.id).toBe(idle);
    const sidecarSecond = await jobs.claim("sidecar", ["needs-process"], 1000);
    expect(sidecarSecond?.id).toBe(plain);
    expect(await jobs.claim("sidecar", ["needs-process"], 1000)).toBeNull();

    // A cloud server without a process picks up the webhook and nothing else.
    const cloud = await jobs.claim("vercel", ["needs-public-url"], 1000);
    expect(cloud?.id).toBe(webhook);

    // An owner that serves nothing special still gets untagged work.
    const untagged = await jobs.enqueue("brief-2", {});
    const anyone = await jobs.claim("netlify", [], 1000);
    expect(anyone?.id).toBe(untagged);

    for (const [id, owner] of [
      [idle, "sidecar"],
      [plain, "sidecar"],
      [webhook, "vercel"],
      [untagged, "netlify"],
    ] as const) {
      await jobs.complete(id, owner);
    }
  });

  test("run dispatches a registered step and records its result", async () => {
    const seen: string[] = [];
    jobs.registerStep<{ n: number }>("count", async (job, ctx) => {
      seen.push(`${job.payload.n}:${ctx.owner}`);
      expect(ctx.remainingMs()).toBeGreaterThan(0);
      expect(ctx.deadline).toBe(clock.now().getTime() + 5000);
      if (job.payload.n === 1) return "again";
      if (job.payload.n === 2) return { sleepMs: 30_000 };
      return "done";
    });

    const again = await jobs.enqueue("count", { n: 1 });
    const claimed1 = await jobs.claim("server-a", ANY, 5000);
    expect(await jobs.run(claimed1 as NonNullable<typeof claimed1>, 5000)).toBe("again");
    let row = await jobs.get(again);
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(0);
    expect(row?.runAt.getTime()).toBe(clock.now().getTime());
    await jobs.complete((await jobs.claim("server-a", ANY, 5000))?.id ?? "", "server-a");

    const sleepy = await jobs.enqueue("count", { n: 2 });
    const claimed2 = await jobs.claim("server-a", ANY, 5000);
    expect(await jobs.run(claimed2 as NonNullable<typeof claimed2>, 5000)).toEqual({
      sleepMs: 30_000,
    });
    row = await jobs.get(sleepy);
    expect(row?.status).toBe("queued");
    expect(row?.runAt.getTime()).toBe(clock.now().getTime() + 30_000);
    expect(await jobs.claim("server-a", ANY, 5000)).toBeNull();
    clock.advance(30_000);

    const finish = await jobs.enqueue("count", { n: 3 });
    // The sleepy one is claimable again now, ahead of the new one by run_at.
    const claimed3 = await jobs.claim("server-a", ANY, 5000);
    expect(claimed3?.id).toBe(sleepy);
    await jobs.complete(sleepy, "server-a");
    const claimed4 = await jobs.claim("server-a", ANY, 5000);
    expect(claimed4?.id).toBe(finish);
    expect(await jobs.run(claimed4 as NonNullable<typeof claimed4>, 5000)).toBe("done");
    expect((await jobs.get(finish))?.status).toBe("done");

    expect(seen).toEqual(["1:server-a", "2:server-a", "3:server-a"]);
  });

  test("a long step renews its lease, so the sweeper leaves it alone and its deadline moves", async () => {
    let extended = false;
    jobs.registerStep("slow", async (_job, ctx) => {
      const before = ctx.deadline;
      // Halfway through the lease, the step is still working.
      clock.advance(3_000);
      expect(await ctx.extend()).toBe(true);
      extended = true;
      expect(ctx.deadline).toBe(clock.now().getTime() + 5_000);
      expect(ctx.deadline).toBeGreaterThan(before);
      // Past the original lease: without the renewal this job would be swept and run twice.
      clock.advance(3_000);
      expect(await jobs.sweepExpiredLeases()).toBe(0);
      return "done";
    });
    const id = await jobs.enqueue("slow", {});
    const claimed = await jobs.claim("server-a", ANY, 5_000);
    expect(await jobs.run(claimed as NonNullable<typeof claimed>, 5_000)).toBe("done");
    expect(extended).toBe(true);
    expect((await jobs.get(id))?.status).toBe("done");
    // Extending a job another Server owns, or one that is not running, changes nothing.
    expect(await jobs.extend(id, "server-a", 5_000)).toBe(false);
    const other = await jobs.enqueue("slow-other", {});
    await jobs.claim("server-b", ANY, 5_000);
    expect(await jobs.extend(other, "server-a", 5_000)).toBe(false);
    expect(await jobs.extend(other, "server-b", 5_000)).toBe(true);
    await jobs.complete(other, "server-b");
  });

  test("a step that throws fails the job; a missing step fails it too", async () => {
    jobs.registerStep("explode", async () => {
      throw new Error("kaboom");
    });
    const boom = await jobs.enqueue("explode", {});
    const claimed = await jobs.claim("server-a", ANY, 1000);
    expect(await jobs.run(claimed as NonNullable<typeof claimed>, 1000)).toBe("failed");
    let row = await jobs.get(boom);
    expect(row?.status).toBe("queued");
    expect(row?.lastError).toBe("kaboom");
    clock.advance(60_000);
    await jobs.complete((await jobs.claim("server-a", ANY, 1000))?.id ?? "", "server-a");

    const orphan = await jobs.enqueue("no-such-step", {});
    const c2 = await jobs.claim("server-a", ANY, 1000);
    expect(await jobs.run(c2 as NonNullable<typeof c2>, 1000)).toBe("failed");
    row = await jobs.get(orphan);
    expect(row?.lastError).toContain("no step registered");
    clock.advance(60_000);
    await jobs.complete((await jobs.claim("server-a", ANY, 1000))?.id ?? "", "server-a");
  });

  test("a shutdown hands running jobs back without spending an attempt", async () => {
    clock.advance(60_000);
    const id = await jobs.enqueue("long-sync", {}, { id: "long-sync:1" });
    const claimed = await jobs.claim("server-stop", ANY, 60_000);
    expect(claimed?.id).toBe(id);
    expect(claimed?.attempts).toBe(1);
    expect(await jobs.release("server-stop")).toBe(1);
    const row = await jobs.get(id);
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(0);
    expect(row?.leaseOwner).toBeNull();
    // Another server's jobs are not touched.
    const other = await jobs.claim("server-other", ANY, 60_000);
    expect(await jobs.release("server-stop")).toBe(0);
    expect((await jobs.get(other?.id ?? ""))?.status).toBe("running");
    await jobs.complete(other?.id ?? "", "server-other");
  });

  test("revive queues a failed standing job again with fresh attempts; a plain enqueue leaves it", async () => {
    clock.advance(60_000);
    const id = await jobs.enqueue("standing", {}, { id: "standing:1" });
    for (let i = 0; i < jobs.maxAttempts; i++) {
      clock.advance(600_000);
      const c = await jobs.claim("server-a", ANY, 1000);
      expect(c?.id).toBe(id);
      await jobs.fail(id, "server-a", "boom");
    }
    expect((await jobs.get(id))?.status).toBe("failed");
    await jobs.enqueue("standing", {}, { id });
    expect((await jobs.get(id))?.status).toBe("failed");
    await jobs.enqueue("standing", {}, { id, revive: true });
    const row = await jobs.get(id);
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(0);
    const again = await jobs.claim("server-a", ANY, 1000);
    expect(again?.id).toBe(id);
    await jobs.complete(id, "server-a");
  });
});
