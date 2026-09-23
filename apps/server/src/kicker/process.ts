// The in-process kicker for the Sidecar and the container: a loop that claims
// and runs steps, woken by Postgres LISTEN/NOTIFY on an unpooled connection
// and by a poll interval, plus the 30 s heartbeat writer (ADR 0005, research
// 22 section 2.2). Up to `workers` steps run at once, so one slow step (a big
// mailbox paced by its Provider) never holds up the rest, and expired leases
// are swept on their own timer rather than between claims. No Bun-only APIs
// here; it runs on Node too.

import { settingsSchema } from "@monday/shared";
import postgres, { type Sql } from "postgres";
import { HEARTBEAT_INTERVAL_MS, removeHeartbeat, writeHeartbeat } from "../heartbeat.ts";
import { JOBS_CHANNEL } from "../jobs/index.ts";
import type { Kicker, KickerOptions } from "./types.ts";

const DEFAULT_LEASE_MS = settingsSchema["server.job_lease_seconds"].default * 1000;

export interface ProcessKickerOptions extends KickerOptions {
  /** Direct (unpooled) connection string for LISTEN. Omit to rely on polling only. */
  listenUrl?: string | undefined;
  /** How long to wait for a wake before checking the table anyway. */
  pollMs?: number;
  /** How often expired leases are swept back to the queue. */
  sweepMs?: number;
  heartbeatMs?: number;
}

export function createProcessKicker(options: ProcessKickerOptions): Kicker {
  const {
    jobs,
    db,
    serverId,
    mode,
    canServe,
    listenUrl,
    budgetMs: budget = DEFAULT_LEASE_MS,
    pollMs = 5_000,
    sweepMs = 30_000,
    heartbeatMs = HEARTBEAT_INTERVAL_MS,
    workers = 1,
    log = () => {},
  } = options;

  let running = false;
  let loop: Promise<void> | null = null;
  let wakeResolve: (() => void) | null = null;
  let pending = false;
  let listener: Sql | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const wake = () => {
    if (wakeResolve) {
      const resolve = wakeResolve;
      wakeResolve = null;
      resolve();
    } else {
      pending = true;
    }
  };

  const waitForWake = (ms: number) =>
    new Promise<void>((resolve) => {
      if (pending) {
        pending = false;
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (wakeResolve === finish) wakeResolve = null;
        resolve();
      }, ms);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      wakeResolve = finish;
    });

  const active = new Set<Promise<void>>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const sweep = async () => {
    try {
      const swept = await jobs.sweepExpiredLeases();
      if (swept > 0) log(`swept ${swept} expired lease(s)`);
    } catch (error) {
      log(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCount = async () => {
    const n = typeof workers === "function" ? await workers() : workers;
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  };

  const runLoop = async () => {
    await sweep();
    while (running) {
      try {
        // Claim while a worker is free; each finished step wakes the loop.
        while (running && active.size < (await workerCount())) {
          const serve = await canServe();
          const budgetMs = typeof budget === "function" ? await budget() : budget;
          const job = await jobs.claim(serverId, serve, budgetMs);
          if (!job) break;
          const run = jobs
            .run(job, budgetMs)
            .then((result) => {
              log(
                `job ${job.id} (${job.class}) -> ${typeof result === "string" ? result : "sleep"}`,
              );
            })
            .catch((error: unknown) => {
              log(
                `job ${job.id} crashed: ${error instanceof Error ? error.message : String(error)}`,
              );
            })
            .finally(() => {
              active.delete(run);
              wake();
            });
          active.add(run);
        }
      } catch (error) {
        log(`kicker error: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (running) await waitForWake(pollMs);
    }
    await Promise.allSettled([...active]);
  };

  return {
    async start() {
      if (running) return;
      running = true;
      await writeHeartbeat(db, serverId, mode);
      heartbeatTimer = setInterval(() => {
        writeHeartbeat(db, serverId, mode).catch((error) =>
          log(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      }, heartbeatMs);
      sweepTimer = setInterval(() => void sweep(), sweepMs);
      if (listenUrl) {
        listener = postgres(listenUrl, { max: 1, onnotice: () => {} });
        await listener.listen(JOBS_CHANNEL, () => wake());
      }
      loop = runLoop();
    },

    async stop() {
      if (!running) return;
      running = false;
      wake();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      await loop;
      loop = null;
      if (listener) await listener.end({ timeout: 2 }).catch(() => {});
      listener = null;
      await removeHeartbeat(db, serverId).catch(() => {});
    },

    wake,
  };
}
