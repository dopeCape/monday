// Vercel kicker (research 22, sections 3.5 and 3.6): a Cron sweeper that GETs
// /cron/tick every minute with `Authorization: Bearer $CRON_SECRET`, plus a
// wake after any request that queued a Job, handed to the request context's
// waitUntil so the response is not held. Fluid compute allows 300 s per
// invocation on Hobby and 800 s on Pro; the tick budget Setting stays inside
// that. No LISTEN/NOTIFY: pooled Neon does not pass it through the pooler.
//
// Vercel Hobby runs a cron once a day; per-minute schedules need Pro. On Hobby
// the wakes carry the load between the daily sweeps.

import { bearerCronAuth, createServerlessKicker, type ServerlessKicker } from "./serverless.ts";
import type { KickerOptions } from "./types.ts";

/** Fluid compute default and Hobby maximum (https://vercel.com/docs/functions/limitations). */
export const VERCEL_MAX_DURATION_MS = 300_000;

export interface VercelKickerOptions extends KickerOptions {
  cronSecret?: string | undefined;
  /** The function's configured maxDuration. */
  maxDurationMs?: number;
  now?: () => Date;
}

/**
 * The request context Vercel exposes to `@vercel/functions`' waitUntil: a
 * symbol on globalThis with a getter for the current invocation. Read directly
 * so the server carries no Vercel dependency; absent (local runs, tests) the
 * wake pass is awaited by the entry instead.
 */
export function vercelWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const holder = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
    | { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined }
    | undefined;
  const ctx = holder?.get?.();
  return ctx?.waitUntil ? (p) => ctx.waitUntil?.(p) : undefined;
}

export function createVercelKicker(options: VercelKickerOptions): ServerlessKicker {
  return createServerlessKicker({
    ...options,
    invocationLimitMs: options.maxDurationMs ?? VERCEL_MAX_DURATION_MS,
    authorizeCron: bearerCronAuth(options.cronSecret),
    // Resolved per wake: the context exists only inside an invocation.
    waitUntil: (p) => {
      const wait = vercelWaitUntil();
      if (wait) wait(p);
    },
  });
}
