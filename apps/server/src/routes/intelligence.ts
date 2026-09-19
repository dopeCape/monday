// Hosted runtime routes (ADR 0007): shared provider keys, the Meter and the
// Brief Task.
//   GET    /keys                         {shared: HostedProvider[]}   which providers hold a shared key; never the key
//   PUT    /keys/:provider               {workspace, key}             stores the key under the envelope (423 when locked)
//   DELETE /keys/:provider               forgets the shared key
//   GET    /meter?workspace=&month=      this month by Task and provider with cost; month "YYYY-MM", default now
//   POST   /threads/:id/brief            {workspace, trigger?}         asks for a Brief under the policy (slice 13):
//                                          202 {jobId}   the brief Job is queued (trigger "user", the default, always queues)
//                                          200 {fresh}   an open found a Brief for the current Thread version
//                                          409 no_shared_key   this Server holds no key for the brief Task
//   GET    /threads/:id/brief            the stored Brief, or 404
//   DELETE /threads/:id/brief            removes the Brief; the feed says so

import { HOSTED_PROVIDERS } from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { Intelligence } from "../intelligence/index.ts";
import { isMonth, monthOf } from "../intelligence/meter.ts";
import { parseBody } from "./validate.ts";

const provider = z.enum(HOSTED_PROVIDERS);
const putKeyBody = z.object({ workspace: z.string().min(1), key: z.string().min(1).max(4000) });
const briefBody = z.object({
  workspace: z.string().min(1),
  trigger: z.enum(["sync", "open", "user"]).default("user"),
});

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
    const body = await parseBody(c, briefBody);
    if (!body.ok) return body.response;
    const result = await intelligence.briefs.request(
      body.data.workspace,
      c.req.param("id"),
      body.data.trigger,
    );
    if (result.status === "queued") return c.json({ jobId: result.jobId }, 202);
    if (result.status === "fresh") return c.json({ fresh: true }, 200);
    if (result.status === "ai_off") return c.json({ error: "ai_off" }, 409);
    const choice = await intelligence.runtime.resolve("brief");
    return c.json({ error: "no_shared_key", provider: choice.provider }, 409);
  });

  app.get("/threads/:id/brief", async (c) => {
    const brief = await intelligence.briefs.get(c.req.param("id"));
    if (!brief) return c.json({ error: "not_found" }, 404);
    return c.json(brief);
  });

  app.delete("/threads/:id/brief", async (c) => {
    await intelligence.briefs.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
