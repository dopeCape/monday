// Netlify entry (research 22, section 4): Node.js Functions with the
// Web-standard signature `(req: Request, context) => Response`. Two functions
// live under entry/netlify/, which netlify.toml names as the functions
// directory: api.ts serves every path, tick.ts is the Scheduled Function that
// runs the Job tick every minute (30 s budget; scheduled functions cannot be
// reached by URL, so it calls the kicker in process). Bun is build-time only
// on Netlify; the runtime is Node 24, which is why this file and everything
// under src/ stays free of Bun APIs.
//
// Environment, on top of entry/cloud.ts:
//   MONDAY_MODE     netlify (default here)
//
// A request that queues a Job hands the kicker's pass to `context.waitUntil`
// so the response is not held; the scheduled tick sweeps whatever a frozen
// instance left behind.
//
// Pooled Postgres: DATABASE_URL should be the pooled string (Netlify DB,
// Neon `-pooler`, Supabase 6543); DATABASE_URL_UNPOOLED the direct one for
// migrations. DATABASE_POOLED=1|0 forces the guess.

import { bootCloud, type CloudBoot } from "./cloud.ts";

/** The subset of Netlify's Context the entry uses. */
export interface NetlifyContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

let booted: Promise<CloudBoot> | null = null;

/** The boot, once per function instance; a failed boot is retried on the next request. */
export function boot(): Promise<CloudBoot> {
  booted ??= bootCloud("netlify").catch((error) => {
    booted = null;
    throw error;
  });
  return booted;
}

export default async function handler(req: Request, context?: NetlifyContext): Promise<Response> {
  const cloud = await boot();
  return cloud.fetch(req, context?.waitUntil ? (p) => context.waitUntil?.(p) : undefined);
}

export const config = { path: "/*", preferStatic: false };

/** The scheduled tick: one bounded pass over the jobs table. */
export async function tick(): Promise<Response> {
  const cloud = await boot();
  const summary = await cloud.kicker.tick();
  return Response.json(summary);
}
