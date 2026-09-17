// The "both" mode failover (ADR 0005): a Sidecar and a Cloud share one jobs
// table; a scheduled send carries needs-always-on so a live Cloud claims it,
// and the Sidecar claims it once the Cloud's heartbeat is stale. A fake clock
// drives heartbeats, leases and run_at, so nothing here waits on real time.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ALWAYS_ON_NEED,
  claimableNeeds,
  needsServedBy,
  PROCESS_NEED,
  PUBLIC_URL_NEED,
} from "../src/capabilities.ts";
import {
  cloudIsAlive,
  currentTopology,
  HEARTBEAT_STALE_MS,
  removeHeartbeat,
  writeHeartbeat,
} from "../src/heartbeat.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

function fakeClock(start = Date.parse("2026-09-17T09:00:00Z")) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("need tags by mode", () => {
  test("a Cloud serves the public URL and always-on classes; the Sidecar the process class", () => {
    expect(needsServedBy("sidecar")).toEqual([PROCESS_NEED]);
    expect(needsServedBy("container")).toEqual([PROCESS_NEED, PUBLIC_URL_NEED, ALWAYS_ON_NEED]);
    expect(needsServedBy("vercel")).toEqual([PUBLIC_URL_NEED, ALWAYS_ON_NEED]);
    expect(needsServedBy("netlify")).toEqual([PUBLIC_URL_NEED, ALWAYS_ON_NEED]);
  });

  test("the Sidecar takes the Cloud's classes only while no Cloud is alive", () => {
    expect(claimableNeeds("sidecar", true)).toEqual([PROCESS_NEED]);
    expect(claimableNeeds("sidecar", false).sort()).toEqual(
      [PROCESS_NEED, PUBLIC_URL_NEED, ALWAYS_ON_NEED].sort(),
    );
    // A Cloud never widens its own set on the Sidecar's account.
    expect(claimableNeeds("vercel", false)).toEqual([PUBLIC_URL_NEED, ALWAYS_ON_NEED]);
  });
});

describe("both mode failover with heartbeats", () => {
  let db: TestDatabase;
  const clock = fakeClock();
  const SIDECAR = "sidecar-laptop";
  const CLOUD = "vercel-prod";
  let sidecarJobs: Jobs;
  let cloudJobs: Jobs;
  const ran: Array<{ owner: string; id: string }> = [];

  /** What each worker may claim right now, by the rule in capabilities.ts. */
  const serve = async (id: string, mode: "sidecar" | "vercel") =>
    claimableNeeds(mode, await cloudIsAlive(db.handle.db, id, clock.now()));

  const attempt = async (jobs: Jobs, id: string, mode: "sidecar" | "vercel") => {
    const job = await jobs.claim(id, await serve(id, mode), 60_000);
    if (job) await jobs.run(job, 60_000);
    return job;
  };

  beforeAll(async () => {
    db = await testDatabase();
    const step = (owner: string) => async (job: { id: string }) => {
      ran.push({ owner, id: job.id });
      return "done" as const;
    };
    sidecarJobs = createJobs(db.handle.db, { now: clock.now });
    sidecarJobs.registerStep("send.deliver", step(SIDECAR));
    cloudJobs = createJobs(db.handle.db, { now: clock.now });
    cloudJobs.registerStep("send.deliver", step(CLOUD));
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("a live Cloud claims the scheduled send and the Sidecar leaves it alone", async () => {
    await writeHeartbeat(db.handle.db, SIDECAR, "sidecar", clock.now());
    await writeHeartbeat(db.handle.db, CLOUD, "vercel", clock.now());
    const id = await sidecarJobs.enqueue(
      "send.deliver",
      { sendId: "s1" },
      { id: "send-1", needs: [ALWAYS_ON_NEED], runAt: clock.now() },
    );

    // The Sidecar polls first and sees a fresh Cloud heartbeat: not its class.
    expect(await attempt(sidecarJobs, SIDECAR, "sidecar")).toBeNull();
    expect((await sidecarJobs.get(id))?.status).toBe("queued");

    const claimed = await attempt(cloudJobs, CLOUD, "vercel");
    expect(claimed?.id).toBe(id);
    expect(ran).toEqual([{ owner: CLOUD, id }]);
    expect((await cloudJobs.get(id))?.status).toBe("done");
  });

  test("a Cloud silent past the stale window leaves the send to the Sidecar", async () => {
    ran.length = 0;
    const id = await sidecarJobs.enqueue(
      "send.deliver",
      { sendId: "s2" },
      { id: "send-2", needs: [ALWAYS_ON_NEED], runAt: clock.now() },
    );
    // Still fresh: the Sidecar waits.
    expect(await attempt(sidecarJobs, SIDECAR, "sidecar")).toBeNull();

    // The Cloud stops beating (the deployment is paused, the cron is off).
    clock.advance(HEARTBEAT_STALE_MS + 1);
    await writeHeartbeat(db.handle.db, SIDECAR, "sidecar", clock.now());
    expect(await cloudIsAlive(db.handle.db, SIDECAR, clock.now())).toBe(false);

    const claimed = await attempt(sidecarJobs, SIDECAR, "sidecar");
    expect(claimed?.id).toBe(id);
    expect(ran).toEqual([{ owner: SIDECAR, id }]);
  });

  test("a Cloud that dies mid-send loses its lease and the Sidecar finishes the send", async () => {
    ran.length = 0;
    await writeHeartbeat(db.handle.db, CLOUD, "vercel", clock.now());
    const id = await sidecarJobs.enqueue(
      "send.deliver",
      { sendId: "s3" },
      { id: "send-3", needs: [ALWAYS_ON_NEED], runAt: clock.now() },
    );
    // The Cloud claims but never reports back (the function was frozen).
    const held = await cloudJobs.claim(CLOUD, await serve(CLOUD, "vercel"), 60_000);
    expect(held?.id).toBe(id);
    expect(await attempt(sidecarJobs, SIDECAR, "sidecar")).toBeNull();

    // Past the lease and past the stale window: the sweep requeues it and the Sidecar takes it.
    clock.advance(Math.max(60_000, HEARTBEAT_STALE_MS) + 1);
    await writeHeartbeat(db.handle.db, SIDECAR, "sidecar", clock.now());
    expect(await sidecarJobs.sweepExpiredLeases()).toBe(1);
    const claimed = await attempt(sidecarJobs, SIDECAR, "sidecar");
    expect(claimed?.id).toBe(id);
    expect(ran).toEqual([{ owner: SIDECAR, id }]);
  });

  test("the topology follows the heartbeats: both, then sidecar once the Cloud is gone", async () => {
    await writeHeartbeat(db.handle.db, SIDECAR, "sidecar", clock.now());
    await writeHeartbeat(db.handle.db, CLOUD, "vercel", clock.now());
    const both = await currentTopology(db.handle.db, { id: SIDECAR, mode: "sidecar" }, clock.now());
    expect(both.topology).toBe("both");
    expect(both.modes).toEqual(["sidecar", "vercel"]);
    expect(both.servers.map((s) => s.id)).toEqual([SIDECAR, CLOUD]);

    await removeHeartbeat(db.handle.db, CLOUD);
    const alone = await currentTopology(
      db.handle.db,
      { id: SIDECAR, mode: "sidecar" },
      clock.now(),
    );
    expect(alone.topology).toBe("sidecar");

    // Seen from the Cloud with no Sidecar beating: cloud.
    clock.advance(HEARTBEAT_STALE_MS + 1);
    const cloud = await currentTopology(db.handle.db, { id: CLOUD, mode: "vercel" }, clock.now());
    expect(cloud.topology).toBe("cloud");
    expect(cloud.servers.map((s) => s.id)).toEqual([CLOUD]);
  });
});
