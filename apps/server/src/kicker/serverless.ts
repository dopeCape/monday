// The serverless kicker shared by Vercel and Netlify (research 22, sections 2
// and 6). There is no loop: a tick is one bounded pass over the jobs table
// that a platform cron triggers every minute, and a wake is a shorter pass a
// request starts after it queued a Job, handed to the platform's waitUntil so
// the response is not held. Every pass writes this Server's heartbeat first,
// so "the Cloud is alive" means "its kicker ran inside the stale window"
// (ADR 0005), sweeps expired leases, then claims and runs Jobs with a lease no
// longer than the time left. Ticks are idempotent: a missed or duplicated one
// is harmless because the table, not the trigger, is the truth.
//
// The budgets are Settings: server.cloud_tick_seconds, server.cloud_kick_seconds
// and server.job_lease_seconds, each capped by the platform's invocation limit.

import { type Context, Hono } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { writeHeartbeat } from "../heartbeat.ts";
import { readGlobalSettings } from "../settings/read.ts";
import type { Kicker, KickerOptions } from "./types.ts";

export interface ServerlessKickerOptions extends KickerOptions {
  /** The platform's hard limit for one invocation. */
  invocationLimitMs: number;
  /** Time kept back from every budget so the invocation ends cleanly. */
  marginMs?: number;
  /** A step is not started with less than this left. */
  minStepMs?: number;
  /** Where a background pass goes; absent, a wake runs the pass and the entry awaits it. */
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
  /** Whether a request may trigger a cron tick over HTTP. Defaults to refusing everything. */
  authorizeCron?: (req: Request) => boolean;
  now?: () => Date;
}

export interface TickSummary {
  ran: number;
  swept: number;
  elapsedMs: number;
  /** Why the pass ended: nothing claimable, or the budget ran out. */
  stopped: "empty" | "budget";
}

export interface ServerlessKicker extends Kicker {
  /** One bounded pass. Omit the budget to use the cloud tick Setting. */
  tick(budgetMs?: number): Promise<TickSummary>;
  /** GET or POST /cron/tick, verified by `authorizeCron`. Mount at the app root. */
  routes(): Hono<AppEnv>;
  /** The wake pass in flight, if any, so an entry without waitUntil can await it. */
  pending(): Promise<unknown> | null;
}

export function createServerlessKicker(options: ServerlessKickerOptions): ServerlessKicker {
  const {
    jobs,
    db,
    serverId,
    mode,
    canServe,
    invocationLimitMs,
    marginMs = 2_000,
    minStepMs = 1_000,
    waitUntil,
    authorizeCron = () => false,
    now = () => new Date(),
    log = () => {},
  } = options;

  let inFlight: Promise<TickSummary> | null = null;

  const budgets = async () => {
    const s = await readGlobalSettings(db, [
      "server.cloud_tick_seconds",
      "server.cloud_kick_seconds",
      "server.job_lease_seconds",
    ]);
    const cap = Math.max(minStepMs, invocationLimitMs - marginMs);
    return {
      tickMs: Math.min(s["server.cloud_tick_seconds"] * 1000, cap),
      kickMs: Math.min(s["server.cloud_kick_seconds"] * 1000, cap),
      leaseMs: Math.min(s["server.job_lease_seconds"] * 1000, cap),
    };
  };

  const pass = async (budgetMs: number, leaseMs: number): Promise<TickSummary> => {
    const started = now().getTime();
    const deadline = started + budgetMs;
    const remaining = () => deadline - now().getTime();
    await writeHeartbeat(db, serverId, mode, now());
    const swept = await jobs.sweepExpiredLeases();
    if (swept > 0) log(`swept ${swept} expired lease(s)`);
    let ran = 0;
    let stopped: TickSummary["stopped"] = "empty";
    while (remaining() >= minStepMs) {
      const budget = Math.min(leaseMs, remaining());
      const job = await jobs.claim(serverId, await canServe(), budget);
      if (!job) break;
      const result = await jobs.run(job, budget);
      ran += 1;
      log(`job ${job.id} (${job.class}) -> ${typeof result === "string" ? result : "sleep"}`);
    }
    if (remaining() < minStepMs) stopped = "budget";
    await writeHeartbeat(db, serverId, mode, now());
    return { ran, swept, elapsedMs: now().getTime() - started, stopped };
  };

  const EMPTY: TickSummary = { ran: 0, swept: 0, elapsedMs: 0, stopped: "empty" };

  /** One pass at a time per instance; a second caller shares the pass in flight. */
  const run = (kind: "tick" | "wake", budgetMs?: number): Promise<TickSummary> => {
    if (inFlight) return inFlight;
    const p = budgets()
      .then((b) => {
        const budget = kind === "tick" ? (budgetMs ?? b.tickMs) : b.kickMs;
        return budget > 0 ? pass(budget, b.leaseMs) : EMPTY;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = p;
    return p;
  };

  const api: ServerlessKicker = {
    async start() {
      // Nothing runs between requests; the cron and the wakes do the work.
    },
    async stop() {
      if (inFlight) await inFlight.catch(() => {});
    },
    wake() {
      const p = run("wake").catch((error) => {
        log(`wake failed: ${error instanceof Error ? error.message : String(error)}`);
        return EMPTY;
      });
      waitUntil?.(p);
    },
    tick: (budgetMs) => run("tick", budgetMs),
    pending: () => inFlight,
    routes() {
      const app = new Hono<AppEnv>();
      const handler = async (c: Context<AppEnv>) => {
        if (!authorizeCron(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
        return c.json(await api.tick());
      };
      app.get("/cron/tick", handler);
      app.post("/cron/tick", handler);
      return app;
    },
  };
  return api;
}

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; nothing else may tick over HTTP. */
export function bearerCronAuth(secret: string | undefined): (req: Request) => boolean {
  const expected = secret?.trim();
  if (!expected) return () => false;
  return (req) => {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim() === expected;
  };
}
