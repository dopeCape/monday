// Vercel kicker: Vercel Queues push consumer plus a Cron sweeper (research 22,
// sections 2.2 and 6). Stub until slice 21 (cloud modes).
//
// TODO(research 22): wire @vercel/queue as the push consumer that calls
// jobs.claim/run inside getDeadline() from @vercel/functions, and a
// vercel.json cron that sweeps expired leases and re-kicks queued rows.
// No LISTEN/NOTIFY here: pooled Neon does not pass it through the pooler.

import type { Kicker, KickerOptions } from "./types.ts";

export function createVercelKicker(options: KickerOptions): Kicker {
  const log = options.log ?? (() => {});
  return {
    async start() {
      log("vercel kicker is a stub; jobs run only when a queue or cron invocation arrives");
    },
    async stop() {},
    wake() {},
  };
}
