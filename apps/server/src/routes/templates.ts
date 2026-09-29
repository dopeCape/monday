// Templates (docs/spec/templates.md). Content is sealed at rest and served
// decrypted here, like Drafts; a locked Server answers 423.
//   GET    /templates?workspace=                 the Workspace's own Templates
//   GET    /templates/export?workspace=          {files: [{name, content}]}  Markdown, on request only
//   POST   /templates/import                     {workspace, files, scope?}  ->  {created, errors}
//   GET    /templates/:id                        one own Template or a built-in
//   POST   /templates                            {workspace, template, scope?, builtIn?}  ->  {templates}
//   PUT    /templates/:id                        {workspace, template, everywhere?}  ->  {templates}
//   DELETE /templates/:id?everywhere=1           ->  {removed}
//   POST   /templates/restore                    {ids}  ->  {templates}   (Undo of a delete)
//   POST   /templates/:id/fill                   {workspace, threadId?, to?}  ->  TemplateFillResult

import { PLACEHOLDER_TYPES } from "@monday/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { TemplateIntelligence } from "../intelligence/templates/index.ts";
import {
  BuiltinTemplateError,
  TemplateInvalidError,
  TemplateNotFoundError,
} from "../templates/index.ts";
import { parseBody } from "./validate.ts";

const person = z.object({ name: z.string().default(""), email: z.string().min(1) });
export const placeholderBody = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(PLACEHOLDER_TYPES),
  optional: z.boolean().default(false),
  hint: z.string().max(500).default(""),
});
export const templateBody = z.object({
  name: z.string().max(120),
  fitsWhen: z.string().max(500).default(""),
  kind: z.enum(["reply", "starter"]).default("reply"),
  subject: z.string().max(500).nullable().default(null),
  body: z.string().max(20_000),
  placeholders: z.array(placeholderBody).max(40).default([]),
});
const scope = z.enum(["workspace", "everywhere"]);
const createBody = z.object({
  workspace: z.string().min(1),
  template: templateBody,
  scope: scope.optional(),
});
const updateBody = z.object({
  workspace: z.string().min(1),
  template: templateBody,
  everywhere: z.boolean().default(false),
});
const restoreBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(100) });
const fillBody = z.object({
  workspace: z.string().min(1),
  threadId: z.string().min(1).nullable().default(null),
  to: z.array(person).default([]),
});
const file = z.object({ name: z.string().min(1).max(255), content: z.string().max(200_000) });
const importBody = z.object({
  workspace: z.string().min(1),
  files: z.array(file).max(500),
  scope: scope.optional(),
});
const workspaceQuery = z.object({ workspace: z.string().min(1) });

/** The Templates' own errors in plain words; anything else goes to the app's handler. */
function refused(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof TemplateInvalidError) {
    return c.json({ error: "invalid_template", errors: error.errors }, 422);
  }
  if (error instanceof TemplateNotFoundError) return c.json({ error: "not_found" }, 404);
  if (error instanceof BuiltinTemplateError) return c.json({ error: "builtin" }, 409);
  throw error;
}

export function templateRoutes(templates: TemplateIntelligence): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const store = templates.store;

  app.get("/templates", async (c) => {
    const q = workspaceQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query" }, 400);
    return c.json({ templates: await store.list(q.data.workspace) });
  });

  app.get("/templates/export", async (c) => {
    const q = workspaceQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query" }, 400);
    return c.json({ files: await store.exportFiles(q.data.workspace) });
  });

  app.post("/templates/import", async (c) => {
    const body = await parseBody(c, importBody);
    if (!body.ok) return body.response;
    return c.json(
      await store.importFiles(body.data.workspace, body.data.files, {
        ...(body.data.scope ? { scope: body.data.scope } : {}),
      }),
    );
  });

  app.post("/templates/restore", async (c) => {
    const body = await parseBody(c, restoreBody);
    if (!body.ok) return body.response;
    return c.json({ templates: await store.restore(body.data.ids) });
  });

  app.get("/templates/:id", async (c) => {
    const t = await store.get(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "not_found" }, 404);
  });

  app.post("/templates", async (c) => {
    const body = await parseBody(c, createBody);
    if (!body.ok) return body.response;
    try {
      const created = await store.create(body.data.workspace, body.data.template, {
        ...(body.data.scope ? { scope: body.data.scope } : {}),
      });
      return c.json({ templates: created }, 201);
    } catch (error) {
      return refused(c, error);
    }
  });

  app.put("/templates/:id", async (c) => {
    const body = await parseBody(c, updateBody);
    if (!body.ok) return body.response;
    try {
      const written = await store.update(c.req.param("id"), body.data.template, {
        everywhere: body.data.everywhere,
        workspaceId: body.data.workspace,
      });
      return c.json({ templates: written });
    } catch (error) {
      return refused(c, error);
    }
  });

  app.delete("/templates/:id", async (c) => {
    try {
      const removed = await store.remove(c.req.param("id"), {
        everywhere: c.req.query("everywhere") === "1",
      });
      return c.json({ removed });
    } catch (error) {
      return refused(c, error);
    }
  });

  app.post("/templates/:id/fill", async (c) => {
    const body = await parseBody(c, fillBody);
    if (!body.ok) return body.response;
    try {
      return c.json(
        await templates.fill(body.data.workspace, c.req.param("id"), {
          threadId: body.data.threadId,
          to: body.data.to,
        }),
      );
    } catch (error) {
      return refused(c, error);
    }
  });

  return app;
}
