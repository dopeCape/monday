// Recommended actions routes (docs/spec/actions.md; slices 34 and 35).
//   GET  /threads/:id/recommendations    the Thread's Recommended actions with their arguments (the feed's
//                                         `recommendations` row carries headers only), or 404
//   POST /threads/:id/recommendations    {workspace, zone?}  the reader opened the Thread: a Thread without
//                                         current answers is asked the Signal request once, then its actions
//                                         are worked out again. 200 ThreadRecommendations | 409 ai_off

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { Intelligence } from "../intelligence/index.ts";
import { parseBody } from "./validate.ts";

const openBody = z.object({
  workspace: z.string().min(1),
  zone: z.string().max(64).optional(),
});

export function recommendationsRoutes(intelligence: Intelligence): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const recs = intelligence.recommendations;

  app.get("/threads/:id/recommendations", async (c) => {
    const found = await recs.get(c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(found);
  });

  app.post("/threads/:id/recommendations", async (c) => {
    const body = await parseBody(c, openBody);
    if (!body.ok) return body.response;
    const found = await recs.open(body.data.workspace, c.req.param("id"), {
      ...(body.data.zone ? { zone: body.data.zone } : {}),
    });
    if (!found) return c.json({ error: "ai_off" }, 409);
    return c.json(found);
  });

  return app;
}
