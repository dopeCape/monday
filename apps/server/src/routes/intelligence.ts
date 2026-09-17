// Hosted runtime routes (ADR 0007): shared provider keys, the Meter and the
// Brief Task.
//   GET    /keys                         {shared: HostedProvider[]}   which providers hold a shared key; never the key
//   PUT    /keys/:provider               {workspace, key}             stores the key under the envelope (423 when locked)
//   DELETE /keys/:provider               forgets the shared key
//   GET    /meter?workspace=&month=      this month by Task and provider with cost; month "YYYY-MM", default now
//   POST   /threads/:id/brief            {workspace}  ->  {jobId}     enqueues the brief Job
//   GET    /threads/:id/brief            the stored Brief, or 404

import { HOSTED_PROVIDERS } from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { Intelligence } from "../intelligence/index.ts";
import { isMonth, monthOf } from "../intelligence/meter.ts";
import { parseBody } from "./validate.ts";

const provider = z.enum(HOSTED_PROVIDERS);
const putKeyBody = z.object({ workspace: z.string().min(1), key: z.string().min(1).max(4000) });
const workspaceBody = z.object({ workspace: z.string().min(1) });

export interface IntelligenceRoutesOptions {
  now?: () => Date;
}

export function intelligenceRoutes(
  intelligence: Intelligence,
  options: IntelligenceRoutesOptions = {},
): Hono<AppEnv> {
  const now = options.now ?? (() => new Date());
  const app = new Hono<AppEnv>();

  app.get("/keys", async (c) => c.json({ shared: await intelligence.keys.list() }));

  app.put("/keys/:provider", async (c) => {
    const p = provider.safeParse(c.req.param("provider"));
    if (!p.success) return c.json({ error: "unknown_provider" }, 400);
    const body = await parseBody(c, putKeyBody);
    if (!body.ok) return body.response;
    await intelligence.keys.put(body.data.workspace, p.data, body.data.key);
    return c.json({ provider: p.data, shared: true });
  });

  app.delete("/keys/:provider", async (c) => {
    const p = provider.safeParse(c.req.param("provider"));
    if (!p.success) return c.json({ error: "unknown_provider" }, 400);
    await intelligence.keys.remove(p.data);
    return c.body(null, 204);
  });

  app.get("/meter", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    const month = c.req.query("month") ?? monthOf(now());
    if (!isMonth(month)) return c.json({ error: "invalid_month" }, 400);
    return c.json(await intelligence.meter.month(workspace, month));
  });

  app.post("/threads/:id/brief", async (c) => {
    const body = await parseBody(c, workspaceBody);
    if (!body.ok) return body.response;
    const jobId = await intelligence.briefs.enqueue(body.data.workspace, c.req.param("id"));
    return c.json({ jobId }, 202);
  });

  app.get("/threads/:id/brief", async (c) => {
    const brief = await intelligence.briefs.get(c.req.param("id"));
    if (!brief) return c.json({ error: "not_found" }, 404);
    return c.json(brief);
  });

  return app;
}
