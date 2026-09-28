// Routing routes (docs/spec/architecture.md "API shape": /groups, /routing/rerun, /routing/decisions).
//   GET    /groups?workspace=                    {groups: GroupView[]}  Groups with Examples, counts and Confidence
//   POST   /groups                               {workspace, ...GroupInput} -> GroupView
//   GET    /groups/:id                           GroupView, or 404
//   PATCH  /groups/:id                           Partial<GroupInput> -> GroupView
//   DELETE /groups/:id                           204; Sub-groups go with it, Threads fall back
//   GET    /routing/decisions?workspace=         {decisions: RoutingDecision[]}  Needs a decision, newest first
//   POST   /routing/decisions/:threadId          {group: id | null, at?} -> CorrectionResult  the user's choice
//   POST   /routing/rerun                        {workspace, recent? | scope?} -> RoutingPreview  a dry run, nothing moves;
//                                                 a scope over routing.rerun.preview_max is a sample (complete: false)
//                                                 (Accept: application/x-ndjson streams {type:progress|done|error} lines)
//   POST   /routing/rerun/apply                  {workspace, moves} -> RoutingApplied  the second call
//   GET    /routing/backlog?workspace=           {backlog: RoutingBacklog | null}  the Backlog sort
//   POST   /routing/backlog                      {workspace, scope, moves?, after?, done?} -> {backlog, applied} (202)
//                                                 applies a preview's sample, then sorts the rest of the scope
//   POST   /routing/backlog/{pause,resume,cancel} {workspace} -> {backlog}
//   POST   /threads/:id/route                    {workspace} -> {jobId}  enqueues the route Job (202)
//   GET    /threads/:id/route                    ThreadRoute, or 404 when never routed
//   POST   /threads/:id/classify                 {workspace} -> Scored  scores without moving, for the Agent
//   POST   /sections/judgments                   {workspace, threads} -> {judgments}  the judged Sections and
//                                                custom actions per Thread (slice 26): cached, plus the Judge for the rest

import type { GroupInput, Predicate } from "@monday/shared";
import { parseSortScope } from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { Intelligence } from "../intelligence/index.ts";
import { parseBody } from "./validate.ts";

const predicateShape = z.object({
  senders: z.array(z.string().min(1)).optional(),
  domains: z.array(z.string().min(1)).optional(),
  subjectPatterns: z.array(z.string().min(1)).optional(),
  listIds: z.array(z.string().min(1)).optional(),
  hasAttachment: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
const briefPolicy = z.enum(["always", "on_open", "never"]);
const groupFields = {
  parentId: z.string().min(1).nullable().optional(),
  sentence: z.string().max(4000).optional(),
  predicate: predicateShape.optional(),
  threshold: z.number().min(0).max(1).nullable().optional(),
  briefPolicy: briefPolicy.nullable().optional(),
};
const createGroupBody = z.object({
  workspace: z.string().min(1),
  name: z.string().min(1).max(200),
  ...groupFields,
});
const patchGroupBody = z.object({ name: z.string().min(1).max(200).optional(), ...groupFields });
const workspaceBody = z.object({ workspace: z.string().min(1) });
const decideBody = z.object({
  group: z.string().min(1).nullable(),
  at: z.iso.datetime({ offset: true }).optional(),
});
const scopeText = z
  .string()
  .min(1)
  .max(80)
  .refine((v) => parseSortScope(v) !== null, { message: "not a Sort scope" });
const rerunBody = z.object({
  workspace: z.string().min(1),
  recent: z.int().min(1).max(1000).optional(),
  /** A Sort scope ("latest 50", "last 3 months", "since 2026-01-01", "all"); the Setting when absent. */
  scope: scopeText.optional(),
});
const backlogBody = z.object({
  workspace: z.string().min(1),
  scope: scopeText,
  /** A preview's sample, moved first; the Backlog sort goes on below `after`. */
  moves: z
    .array(z.lazy(() => moveShape))
    .max(1000)
    .optional(),
  after: z
    .object({ at: z.iso.datetime({ offset: true }), id: z.string().min(1) })
    .nullable()
    .optional(),
  done: z.int().min(0).optional(),
});
/** POST /sections/judgments (slice 26): the judged Sections and custom actions per Thread. */
const judgmentsBody = z.object({
  workspace: z.string().min(1),
  threads: z.array(z.string().min(1)).min(1).max(500),
});
const candidate = z.object({ groupId: z.string().min(1), confidence: z.number().min(0).max(1) });
const moveShape = z.object({
  threadId: z.string().min(1),
  from: z.object({ name: z.string(), email: z.string() }).nullable(),
  subject: z.string(),
  current: z.object({ groupId: z.string().nullable(), subgroupId: z.string().nullable() }),
  proposed: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("route"),
      groupId: z.string().min(1),
      subgroupId: z.string().nullable(),
      confidence: z.number().min(0).max(1),
    }),
    z.object({ kind: z.literal("ask"), candidates: z.array(candidate) }),
    z.object({ kind: z.literal("none") }),
  ]),
});
const applyBody = z.object({ workspace: z.string().min(1), moves: z.array(moveShape).max(1000) });

type Fields = z.output<typeof patchGroupBody>;

/** Drops undefined optionals so exactOptionalPropertyTypes is honoured downstream. */
function compact(value: Fields): Partial<GroupInput> {
  const out: Partial<GroupInput> = {};
  if (value.name !== undefined) out.name = value.name;
  if (value.parentId !== undefined) out.parentId = value.parentId;
  if (value.sentence !== undefined) out.sentence = value.sentence;
  if (value.threshold !== undefined) out.threshold = value.threshold;
  if (value.briefPolicy !== undefined) out.briefPolicy = value.briefPolicy;
  if (value.predicate !== undefined) {
    const p: Predicate = {};
    if (value.predicate.senders) p.senders = value.predicate.senders;
    if (value.predicate.domains) p.domains = value.predicate.domains;
    if (value.predicate.subjectPatterns) p.subjectPatterns = value.predicate.subjectPatterns;
    if (value.predicate.listIds) p.listIds = value.predicate.listIds;
    if (value.predicate.hasAttachment !== undefined)
      p.hasAttachment = value.predicate.hasAttachment;
    if (value.predicate.headers) p.headers = value.predicate.headers;
    out.predicate = p;
  }
  return out;
}

export function routingRoutes(intelligence: Intelligence): Hono<AppEnv> {
  const { routing, backlog } = intelligence;
  const app = new Hono<AppEnv>();

  app.get("/groups", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    return c.json({ groups: await routing.listGroups(workspace) });
  });

  app.post("/groups", async (c) => {
    const body = await parseBody(c, createGroupBody);
    if (!body.ok) return body.response;
    const { workspace, ...input } = body.data;
    return c.json(
      await routing.createGroup(workspace, { ...compact(input), name: input.name }),
      201,
    );
  });

  app.get("/groups/:id", async (c) => {
    const group = await routing.getGroup(c.req.param("id"));
    if (!group) return c.json({ error: "not_found" }, 404);
    return c.json(group);
  });

  app.patch("/groups/:id", async (c) => {
    const body = await parseBody(c, patchGroupBody);
    if (!body.ok) return body.response;
    return c.json(await routing.updateGroup(c.req.param("id"), compact(body.data)));
  });

  app.delete("/groups/:id", async (c) => {
    await routing.deleteGroup(c.req.param("id"));
    return c.body(null, 204);
  });

  // The judged Sections and custom actions per Thread (slice 26): cached
  // answers, plus the Judge's for what was missing when it is available.
  app.post("/sections/judgments", async (c) => {
    const body = await parseBody(c, judgmentsBody);
    if (!body.ok) return body.response;
    const judgments = await intelligence.organize.judge(body.data.workspace, body.data.threads);
    return c.json({ judgments });
  });

  app.get("/routing/decisions", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    return c.json({ decisions: await routing.decisions(workspace) });
  });

  app.post("/routing/decisions/:threadId", async (c) => {
    const body = await parseBody(c, decideBody);
    if (!body.ok) return body.response;
    return c.json(await routing.decide(c.req.param("threadId"), body.data.group, body.data.at));
  });

  app.post("/routing/rerun", async (c) => {
    const body = await parseBody(c, rerunBody);
    if (!body.ok) return body.response;
    const scope = body.data.scope ? parseSortScope(body.data.scope) : null;
    const recent = scope
      ? { scope }
      : body.data.recent !== undefined
        ? { recent: body.data.recent }
        : {};
    // Asked for NDJSON, the re-run streams a line per Thread scored, then the preview.
    if ((c.req.header("accept") ?? "").includes("application/x-ndjson")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const line = (value: unknown) =>
            controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
          try {
            const preview = await routing.preview(body.data.workspace, {
              ...recent,
              onProgress: (progress) => line({ type: "progress", ...progress }),
            });
            line({ type: "done", preview });
          } catch (error) {
            line({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
      });
    }
    return c.json(await routing.preview(body.data.workspace, recent));
  });

  app.post("/routing/rerun/apply", async (c) => {
    const body = await parseBody(c, applyBody);
    if (!body.ok) return body.response;
    return c.json(await routing.apply(body.data.workspace, body.data.moves));
  });

  // The Backlog sort: what it is doing, starting one (after a preview's sample
  // moves), and pause, resume and stop. One per Workspace.
  app.get("/routing/backlog", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    return c.json({ backlog: await backlog.status(workspace) });
  });

  app.post("/routing/backlog", async (c) => {
    const body = await parseBody(c, backlogBody);
    if (!body.ok) return body.response;
    const { workspace, moves, after, done } = body.data;
    const scope = parseSortScope(body.data.scope);
    if (!scope) return c.json({ error: "bad_scope" }, 400);
    const applied = moves?.length ? await routing.apply(workspace, moves) : { moved: 0, asked: 0 };
    const started = await backlog.start(workspace, scope, {
      after: after ?? null,
      done: done ?? 0,
      moved: applied.moved,
      asked: applied.asked,
    });
    return c.json({ backlog: started, applied }, 202);
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/routing/backlog/${action}`, async (c) => {
      const body = await parseBody(c, workspaceBody);
      if (!body.ok) return body.response;
      const next = await backlog[action](body.data.workspace);
      if (!next) return c.json({ error: "not_found" }, 404);
      return c.json({ backlog: next });
    });
  }

  app.post("/threads/:id/route", async (c) => {
    const body = await parseBody(c, workspaceBody);
    if (!body.ok) return body.response;
    const jobId = await routing.enqueue(body.data.workspace, c.req.param("id"));
    return c.json({ jobId }, 202);
  });

  app.get("/threads/:id/route", async (c) => {
    const route = await routing.routeOf(c.req.param("id"));
    if (!route) return c.json({ error: "not_found" }, 404);
    return c.json(route);
  });

  app.post("/threads/:id/classify", async (c) => {
    const body = await parseBody(c, workspaceBody);
    if (!body.ok) return body.response;
    return c.json(await routing.classify(c.req.param("id")));
  });

  return app;
}
