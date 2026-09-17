// Vercel entry (research 22, section 3): a Vercel Function with the Web
// signature, `export default (req: Request) => Response`, on the Node.js
// runtime under Fluid compute. api/index.ts re-exports this file so Vercel
// builds it as the one function, and vercel.json rewrites every path to it
// and schedules the Job tick.
//
// Project settings: root directory `apps/server`, framework "Other" (the Hono
// preset is not used because src/app.ts exports a factory, not an app).
//
// Environment, on top of entry/cloud.ts:
//   CRON_SECRET     required; Vercel Cron sends it as `Authorization: Bearer` to /cron/tick
//   MONDAY_MODE     vercel (default here)
//
// Cron: vercel.json schedules GET /cron/tick every minute. Hobby accounts
// allow one run per day, so change the schedule to `0 0 * * *` there; the
// per-request wakes carry scheduled sends between the daily sweeps only while
// requests arrive, which is why the Pro schedule is the shipped default.
//
// Pooled Postgres: DATABASE_URL should be the pooled string (Neon `-pooler`,
// Supabase 6543); DATABASE_URL_UNPOOLED the direct one for migrations. The
// guess from the URL can be forced with DATABASE_POOLED=1|0.

import { bootCloud, type CloudBoot } from "./cloud.ts";

export const config = {
  runtime: "nodejs",
  /** Fluid compute default and the Hobby maximum; Pro may raise it to 800. */
  maxDuration: 300,
};

let booted: Promise<CloudBoot> | null = null;

/** The boot, once per function instance; a failed boot is retried on the next request. */
export function boot(): Promise<CloudBoot> {
  booted ??= bootCloud("vercel").catch((error) => {
    booted = null;
    throw error;
  });
  return booted;
}

export default async function handler(req: Request): Promise<Response> {
  const cloud = await boot();
  // The Vercel kicker finds waitUntil on the request context itself.
  return cloud.fetch(req);
}
