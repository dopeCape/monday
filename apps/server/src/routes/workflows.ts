// Workflow routes (ADR 0003; docs/spec/architecture.md "API shape").
//   GET    /workflows?workspace=                       {workflows: WorkflowView[]}
//   POST   /workflows                {workspace, ...WorkflowInput} -> WorkflowView (201), disabled
//   GET    /workflows/:id                              WorkflowView, or 404
//   GET    /workflows/:id/versions/:n                  the document of one version
//   PUT    /workflows/:id            WorkflowInput     -> WorkflowView, a new version
//   DELETE /workflows/:id                              204
//   POST   /workflows/:id/enable     {enabled}         -> WorkflowView
//   POST   /workflows/:id/dry-run    {recent?}         -> DryRunPreview, nothing applied
//   POST   /workflows/:id/run        {threadId?}       -> RunView (202), a manual Run
//   POST   /workflows/:id/approvals  {step, granted}   -> WorkflowView, a Standing approval
//   GET    /workflows/runs?workspace=&workflow=&status= {runs: RunView[]}, newest first
//   GET    /workflows/runs/:id                         RunView, or 404
//   GET    /workflows/runs/:id/activity                {activity: ActivityRecord[]}, oldest first
//   POST   /workflows/runs/:id/approvals {decision, standing?} -> RunView, resumes the Run

import { workflowInputSchema } from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { Workflows } from "../workflows/index.ts";
import { parseBody } from "./validate.ts";

const workspaceQuery = z.object({
  workspace: z.string().min(1),
  workflow: z.string().min(1).optional(),
  status: z.enum(["queued", "running", "paused", "done", "failed"]).optional(),
});
const createBody = z.object({ workspace: z.string().min(1) }).and(workflowInputSchema);
const enableBody = z.object({ enabled: z.boolean() });
const dryRunBody = z.object({ recent: z.int().min(1).max(200).optional() });
const runBody = z.object({ threadId: z.string().min(1).nullable().optional() });

/** A body that may be absent: an empty request reads as {}. */
async function optionalBody<S extends z.ZodType>(
  c: Parameters<typeof parseBody>[0],
  schema: S,
): Promise<ReturnType<typeof parseBody<S>>> {
  const text = await c.req.text();
  if (text.trim() === "") {
    const result = schema.safeParse({});
    return result.success
      ? { ok: true, data: result.data }
      : {
          ok: false,
          response: c.json({ error: "invalid_body", issues: result.error.issues }, 400),
        };
  }
  const result = schema.safeParse(JSON.parse(text));
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, response: c.json({ error: "invalid_body", issues: result.error.issues }, 400) };
}
const standingBody = z.object({ step: z.string().min(1), granted: z.boolean() });
const decisionBody = z.object({
  decision: z.enum(["approved", "declined"]),
  standing: z.boolean().optional(),
});

export function workflowRoutes(workflows: Workflows): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/workflows", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    return c.json({ workflows: await workflows.list(workspace) });
  });

  app.post("/workflows", async (c) => {
    const body = await parseBody(c, createBody);
    if (!body.ok) return body.response;
    const { workspace, ...input } = body.data;
    return c.json(await workflows.create(workspace, input), 201);
  });

  // Runs come before /:id so "runs" is never read as a Workflow id.
  app.get("/workflows/runs", async (c) => {
    const parsed = workspaceQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    }
    const q = parsed.data;
    return c.json({
      runs: await workflows.runs(q.workspace, {
        ...(q.workflow ? { workflowId: q.workflow } : {}),
        ...(q.status ? { status: q.status } : {}),
      }),
    });
  });

  app.get("/workflows/runs/:id", async (c) => {
    const run = await workflows.run(c.req.param("id"));
    if (!run) return c.json({ error: "not_found" }, 404);
    return c.json(run);
  });

  app.get("/workflows/runs/:id/activity", async (c) => {
    const run = await workflows.run(c.req.param("id"));
    if (!run) return c.json({ error: "not_found" }, 404);
    return c.json({ activity: await workflows.activityOf(run.id) });
  });

  app.post("/workflows/runs/:id/approvals", async (c) => {
    const body = await parseBody(c, decisionBody);
    if (!body.ok) return body.response;
    return c.json(
      await workflows.decide(c.req.param("id"), body.data.decision, {
        standing: body.data.standing === true,
      }),
    );
  });

  app.get("/workflows/:id", async (c) => {
    const found = await workflows.get(c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(found);
  });

  app.get("/workflows/:id/versions/:n", async (c) => {
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n) || n < 1) return c.json({ error: "not_found" }, 404);
    const doc = await workflows.version(c.req.param("id"), n);
    if (!doc) return c.json({ error: "not_found" }, 404);
    return c.json({ version: n, document: doc });
  });

  app.put("/workflows/:id", async (c) => {
    const body = await parseBody(c, workflowInputSchema);
    if (!body.ok) return body.response;
    return c.json(await workflows.update(c.req.param("id"), body.data));
  });

  app.delete("/workflows/:id", async (c) => {
    await workflows.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/workflows/:id/enable", async (c) => {
    const body = await parseBody(c, enableBody);
    if (!body.ok) return body.response;
    return c.json(await workflows.enable(c.req.param("id"), body.data.enabled));
  });

  app.post("/workflows/:id/dry-run", async (c) => {
    const body = await optionalBody(c, dryRunBody);
    if (!body.ok) return body.response;
    return c.json(await workflows.dryRun(c.req.param("id"), body.data.recent));
  });

  app.post("/workflows/:id/run", async (c) => {
    const body = await optionalBody(c, runBody);
    if (!body.ok) return body.response;
    return c.json(await workflows.start(c.req.param("id"), body.data.threadId ?? null), 202);
  });

  app.post("/workflows/:id/approvals", async (c) => {
    const body = await parseBody(c, standingBody);
    if (!body.ok) return body.response;
    return c.json(await workflows.standing(c.req.param("id"), body.data.step, body.data.granted));
  });

  return app;
}
