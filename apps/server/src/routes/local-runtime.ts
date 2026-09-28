// Background work for a Device's Local runtime (intelligence/runtime/local.ts;
// docs/spec/workflows.md, "Local runtime work"). Only the Sidecar has a bridge:
//   GET  /local-runtime/next?cli=&model=&wait=   {call: LocalCall} when there is work, 204 after
//                                                `wait` seconds with none; asking is what counts
//                                                the Device's command-line agent as connected
//   POST /local-runtime/calls/:id  {text, model?} | {error}   the answer to one call; 404 when the
//                                                call is unknown (timed out, answered)
// Both 404 `no_local_runtime` on a Server without a bridge (a Cloud).

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { LocalBridge } from "../intelligence/runtime/local.ts";
import { parseBody } from "./validate.ts";

const cli = z.enum(["claude-code", "codex", "opencode"]);
const answerBody = z.union([
  z.object({ text: z.string(), model: z.string().nullable().optional() }),
  z.object({ error: z.string().min(1) }),
]);

/** The longest a Device's request may stay open, in seconds (the Setting's own bound). */
const MAX_WAIT_SECONDS = 55;

export function localRuntimeRoutes(bridge: LocalBridge | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/local-runtime/next", async (c) => {
    if (!bridge) return c.json({ error: "no_local_runtime" }, 404);
    const parsed = cli.safeParse(c.req.query("cli"));
    if (!parsed.success) return c.json({ error: "cli_required" }, 400);
    const model = c.req.query("model") || null;
    const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(c.req.query("wait") ?? 25) || 0));
    const call = await bridge.next({ cli: parsed.data, model }, wait * 1000, c.req.raw.signal);
    if (!call) return c.body(null, 204);
    return c.json({ call });
  });

  app.post("/local-runtime/calls/:id", async (c) => {
    if (!bridge) return c.json({ error: "no_local_runtime" }, 404);
    const body = await parseBody(c, answerBody);
    if (!body.ok) return body.response;
    const known = bridge.answer(c.req.param("id"), body.data);
    return known ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

  return app;
}
