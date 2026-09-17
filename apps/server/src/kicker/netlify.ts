// Netlify kicker (research 22, section 4.4): a Scheduled Function every
// minute calls tick() in process (scheduled functions cannot be reached by
// URL and run 30 s at most), and a wake after any request that queued a Job
// rides on `context.waitUntil` inside the 60 s synchronous limit. Polling
// only: no inbound WebSocket and no LISTEN/NOTIFY through the pooled URL.
// Async Workloads and Background Functions (15 min) are the place for a step
// that outgrows the synchronous limit; the tick budget Setting keeps every
// pass inside 30 s by default.

import { createServerlessKicker, type ServerlessKicker } from "./serverless.ts";
import type { KickerOptions } from "./types.ts";

/** Scheduled Functions stop at 30 s (https://docs.netlify.com/build/functions/configuration/). */
export const NETLIFY_SCHEDULED_LIMIT_MS = 30_000;
/** Synchronous Functions stop at 60 s. */
export const NETLIFY_SYNC_LIMIT_MS = 60_000;

export interface NetlifyKickerOptions extends KickerOptions {
  /** `context.waitUntil` of the current invocation, when the entry has one. */
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
  now?: () => Date;
}

export function createNetlifyKicker(options: NetlifyKickerOptions): ServerlessKicker {
  return createServerlessKicker({
    ...options,
    invocationLimitMs: NETLIFY_SCHEDULED_LIMIT_MS,
    // Netlify's scheduler invokes the function directly; nobody may tick over HTTP.
    authorizeCron: () => false,
  });
}
