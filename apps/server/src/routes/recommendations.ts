// Recommended actions routes (docs/spec/actions.md; slices 34 and 35).
//   GET  /threads/:id/recommendations    the Thread's Recommended actions with their arguments (the feed's
//                                         `recommendations` row carries headers only), or 404
//   POST /threads/:id/recommendations    {workspace, zone?}  the reader opened the Thread: a Thread without
//                                         current answers is asked the Signal request once, then its actions
//                                         are worked out again. 200 ThreadRecommendations | 409 ai_off
//   POST /recommendations/events         RecommendationEventsRequest: the chips shown and what became of one;
//                                         200 {learned}: a threshold learning moved, with its Activity row
//   GET  /recommendations/stats?workspace=  per action, shown and used since its threshold was set
//   GET  /threads/:id/unsubscribe?workspace=  how the Thread's list is left (the card's exact request), or 404
//   POST /threads/:id/unsubscribe        {workspace, method, target}  the user approved that exact request on
//                                         the card: the unsubscribe tool runs with it (ADR 0002: the approval
//                                         is the tool's; a request that no longer matches is declined).
//                                         200 {ok, text} | 409 {ok: false, text}

import { RECOMMENDED_ACTIONS } from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { unsubscribeLine } from "../intelligence/agent/tools/recommended.ts";
import type { Intelligence } from "../intelligence/index.ts";
import { parseBody } from "./validate.ts";

const openBody = z.object({
  workspace: z.string().min(1),
  zone: z.string().max(64).optional(),
});

const action = z.enum(RECOMMENDED_ACTIONS);
const outcomeArgs = z
  .object({
    to: z.string().max(320).optional(),
    until: z.string().max(40).nullable().optional(),
    start: z.string().max(40).nullable().optional(),
    workflowId: z.string().max(200).optional(),
  })
  .strict();
const eventsBody = z.object({
  workspace: z.string().min(1),
  threadId: z.string().min(1),
  shown: z
    .array(z.object({ kind: action, fit: z.number().min(0).max(1), args: outcomeArgs.optional() }))
    .max(20)
    .optional(),
  outcome: z
    .object({
      kind: action,
      outcome: z.enum(["used", "dismissed", "ignored", "other_used"]),
      args: outcomeArgs.optional(),
    })
    .optional(),
});

const unsubscribeBody = z.object({
  workspace: z.string().min(1),
  method: z.enum(["one_click", "mailto"]),
  target: z.string().min(1).max(2000),
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

  app.post("/recommendations/events", async (c) => {
    const body = await parseBody(c, eventsBody);
    if (!body.ok) return body.response;
    return c.json(await recs.record(body.data));
  });

  app.get("/recommendations/stats", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    return c.json({ stats: await recs.stats(workspace) });
  });

  app.get("/threads/:id/unsubscribe", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    const exit = await recs.listExit(workspace, c.req.param("id"));
    if (!exit) return c.json({ error: "not_found" }, 404);
    return c.json(exit);
  });

  app.post("/threads/:id/unsubscribe", async (c) => {
    const body = await parseBody(c, unsubscribeBody);
    if (!body.ok) return body.response;
    const threadId = c.req.param("id");
    const exit = await recs.listExit(body.data.workspace, threadId);
    // The card showed this exact request; the tool asks, and the answer is yes only for it.
    const approved =
      exit && exit.method === body.data.method && exit.target === body.data.target
        ? unsubscribeLine(exit)
        : null;
    const outcome = await intelligence.agent.tools(body.data.workspace).call(
      {
        name: "unsubscribe",
        args: { thread_id: threadId },
        callId: `unsubscribe-${threadId}-${Date.now()}`,
        sessionId: null,
      },
      {
        ask: async (_row, preview) =>
          approved !== null && preview.kind === "text" && preview.text === approved
            ? "approved"
            : "declined",
      },
    );
    // Declined (the request changed since the card showed it) or failed: nothing was sent.
    const ok =
      !outcome.isError &&
      outcome.activity.status === "done" &&
      outcome.activity.decision !== "declined";
    return c.json({ ok, text: outcome.text }, ok ? 200 : 409);
  });

  return app;
}
