// Signals routes (docs/spec/signals.md; ADR 0014).
//   POST /intelligence/eval/batching      {workspace, sample?, seed?}   the batching measurement (slice 28),
//                                          Sidecar only, on loopback, with a Device or the Sidecar's token:
//                                          202 EvalStatus   started; poll the GET below
//                                          404 not_found    this Server is not a Sidecar
//                                          403 loopback_only | eval_disabled (ai.judge.eval_enabled is off)
//                                          409 no_judge     no TypeSafe key
//   GET  /intelligence/eval/batching/:id  EvalStatus: running with done and total, done with the report, or failed

import type { DeploymentMode } from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, LoopbackCheck } from "../auth/middleware.ts";
import type { Intelligence } from "../intelligence/index.ts";
import { EvalDisabledError } from "../intelligence/measure/index.ts";
import { NoJudgeError } from "../intelligence/runtime/index.ts";
import { parseBody } from "./validate.ts";

const evalBody = z.object({
  workspace: z.string().min(1),
  sample: z.number().int().min(3).max(3000).optional(),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31)
    .optional(),
});

export interface SignalsRouteOptions {
  mode: DeploymentMode;
  isLoopback: LoopbackCheck;
}

export function signalsRoutes(
  intelligence: Intelligence,
  options: SignalsRouteOptions,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("/intelligence/eval/*", async (c, next) => {
    if (options.mode !== "sidecar") return c.json({ error: "not_found" }, 404);
    if (!options.isLoopback(c)) return c.json({ error: "loopback_only" }, 403);
    return next();
  });

  app.post("/intelligence/eval/batching", async (c) => {
    const parsed = await parseBody(c, evalBody);
    if (!parsed.ok) return parsed.response;
    try {
      const status = await intelligence.batchingEval.start(parsed.data.workspace, {
        ...(parsed.data.sample !== undefined ? { sample: parsed.data.sample } : {}),
        ...(parsed.data.seed !== undefined ? { seed: parsed.data.seed } : {}),
      });
      return c.json(status, 202);
    } catch (error) {
      if (error instanceof EvalDisabledError) {
        return c.json({ error: error.code, message: error.message }, 403);
      }
      if (error instanceof NoJudgeError) {
        return c.json({ error: error.code, message: error.message }, 409);
      }
      throw error;
    }
  });

  app.get("/intelligence/eval/batching/:id", (c) => {
    const status = intelligence.batchingEval.status(c.req.param("id"));
    return status ? c.json(status) : c.json({ error: "not_found" }, 404);
  });

  return app;
}
