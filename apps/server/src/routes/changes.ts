// The Changes feed (docs/spec/architecture.md, "API shape"; ADR 0005).
//   GET /changes?workspace=&since=<seq>&limit=   {changes: [...], cursor}, ordered by seq
//   GET /changes/sse?workspace=                  text/event-stream of `{seq}` wake messages
// The wake carries only a seq; the client fetches from its own cursor. SSE is
// the transport for Vercel (research 22); WebSocket lives in the Bun entry
// because upgrades are a Bun.serve matter, and polling needs nothing here.
// Besides the bus, the SSE stream polls the table so a process without a
// LISTEN connection still wakes its clients.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { ChangeBus } from "../changes/bus.ts";
import type { Mailstore } from "../mailstore/index.ts";

const feedQuery = z.object({
  workspace: z.string().min(1),
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

const sseQuery = z.object({ workspace: z.string().min(1) });

export interface ChangesRouteOptions {
  bus: ChangeBus;
  /** SSE keepalive comment interval. */
  heartbeatMs?: number;
  /** SSE table poll interval, the fallback when no LISTEN feeds the bus. */
  pollMs?: number;
}

export function changesRoutes(mailstore: Mailstore, options: ChangesRouteOptions): Hono<AppEnv> {
  const { bus, heartbeatMs = 25_000, pollMs = 15_000 } = options;
  const app = new Hono<AppEnv>();

  app.get("/changes", async (c) => {
    const parsed = feedQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    }
    const q = parsed.data;
    return c.json(await mailstore.listChanges(q.workspace, { since: q.since, limit: q.limit }));
  });

  app.get("/changes/sse", async (c) => {
    const parsed = sseQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    }
    const { workspace } = parsed.data;

    return streamSSE(c, async (stream) => {
      let sent = await mailstore.latestSeq(workspace);
      let closed = false;
      let wake: (() => void) | null = null;
      let pending = false;
      const notify = () => {
        if (wake) {
          const w = wake;
          wake = null;
          w();
        } else {
          pending = true;
        }
      };
      const unsubscribe = bus.subscribe(workspace, (notice) => {
        if (notice.seq > sent) notify();
      });
      stream.onAbort(() => {
        closed = true;
        notify();
      });

      // The first event tells the client where the feed is, so it syncs once on connect.
      await stream.writeSSE({ event: "wake", data: JSON.stringify({ seq: sent }) });

      let lastBeat = Date.now();
      while (!closed) {
        const waitMs = Math.max(50, Math.min(pollMs, heartbeatMs - (Date.now() - lastBeat)));
        await new Promise<void>((resolve) => {
          if (pending) {
            pending = false;
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            if (wake === finish) wake = null;
            resolve();
          }, waitMs);
          const finish = () => {
            clearTimeout(timer);
            resolve();
          };
          wake = finish;
        });
        if (closed) break;
        const now = await mailstore.latestSeq(workspace);
        if (now > sent) {
          sent = now;
          await stream.writeSSE({ event: "wake", data: JSON.stringify({ seq: sent }) });
          lastBeat = Date.now();
        } else if (Date.now() - lastBeat >= heartbeatMs) {
          await stream.write(": keepalive\n\n");
          lastBeat = Date.now();
        }
      }
      unsubscribe();
    });
  });

  return app;
}
