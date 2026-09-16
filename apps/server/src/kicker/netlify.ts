// Netlify kicker: Async Workloads for durable steps plus a Scheduled Function
// every minute as the sweeper (research 22, sections 2.2 and 6). Stub until
// slice 21 (cloud modes).
//
// TODO(research 22): the scheduled function (30 s budget) sweeps expired
// leases and dispatches queued rows to an Async Workload or a Background
// Function (15 min budget) that calls jobs.claim/run. Polling only; no
// inbound WebSocket and no LISTEN/NOTIFY through the pooled database URL.

import type { Kicker, KickerOptions } from "./types.ts";

export function createNetlifyKicker(options: KickerOptions): Kicker {
  const log = options.log ?? (() => {});
  return {
    async start() {
      log("netlify kicker is a stub; jobs run only when a scheduled or background function runs");
    },
    async stop() {},
    wake() {},
  };
}
