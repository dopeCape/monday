// Hosted runtime routes (ADR 0007): shared provider keys, the Meter and the
// Brief Task.
//   GET    /keys                         {shared: KeyProvider[]}      which providers hold a shared key; never the key
//   PUT    /keys/:provider               {workspace, key}             stores the key under the envelope (423 when locked)
//   DELETE /keys/:provider               forgets the shared key
//   POST   /keys/:provider/validate      {key}                        live check of a pasted key from the Server (slice 24):
//                                          200 {ok: true, models}   the provider accepted it
//                                          200 {ok: false, reason}  refused, in plain words; the key is never stored
//                                          404 no_validator         the provider has no live check
//   GET    /meter?workspace=&month=      this month by Task and provider with cost; month "YYYY-MM", default now
//   POST   /threads/:id/brief            {workspace, trigger?}         asks for a Brief under the policy (slice 13):
//                                          202 {jobId}   the brief Job is queued (trigger "user", the default, always queues)
//                                          200 {fresh}   an open found a Brief for the current Thread version
//                                          409 no_shared_key   this Server holds no key for the brief Task
//   GET    /threads/:id/brief            the stored Brief, or 404
//   DELETE /threads/:id/brief            removes the Brief; the feed says so
//   POST   /judge/intent                 {workspace, text, now, contacts, groups, sections}  (slice 27)
//                                          200 IntentReading   one Judgment over the sentence; the Device assembles it
//                                          409 no_judge        no judge answers (no TypeSafe key, or Settings say the LLM)
//                                          409 ai_off

import { KEY_PROVIDERS } from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { Intelligence } from "../intelligence/index.ts";
import { isMonth, monthOf } from "../intelligence/meter.ts";
import { AiOffError, NoJudgeError } from "../intelligence/runtime/index.ts";
import { parseBody } from "./validate.ts";

const provider = z.enum(KEY_PROVIDERS);
const putKeyBody = z.object({ workspace: z.string().min(1), key: z.string().min(1).max(4000) });
const validateKeyBody = z.object({ key: z.string().min(1).max(4000) });
const briefBody = z.object({
  workspace: z.string().min(1),
  trigger: z.enum(["sync", "open", "user"]).default("user"),
});
const person = z.object({ name: z.string().max(200), email: z.string().max(320) });
const intentBody = z.object({
  workspace: z.string().min(1),
  text: z.string().trim().min(1).max(500),
  now: z.string().min(1).max(40),
  contacts: z.array(person).max(250).default([]),
  groups: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(120),
        sentence: z.string().max(2000).optional(),
      }),
    )
    .max(250)
    .default([]),
  sections: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1).max(120) }))
    .max(100)
    .default([]),
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

  app.post("/keys/:provider/validate", async (c) => {
    const p = provider.safeParse(c.req.param("provider"));
    if (!p.success) return c.json({ error: "unknown_provider" }, 400);
    const body = await parseBody(c, validateKeyBody);
    if (!body.ok) return body.response;
    const result = await intelligence.validateKey(p.data, body.data.key);
    if (!result) return c.json({ error: "no_validator" }, 404);
    return c.json(result);
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

  app.post("/judge/intent", async (c) => {
    const body = await parseBody(c, intentBody);
    if (!body.ok) return body.response;
    try {
      return c.json(await intelligence.intent(body.data));
    } catch (error) {
      if (error instanceof NoJudgeError)
        return c.json({ error: "no_judge", reason: error.reason }, 409);
      if (error instanceof AiOffError) return c.json({ error: "ai_off" }, 409);
      throw error;
    }
  });

  return app;
}
