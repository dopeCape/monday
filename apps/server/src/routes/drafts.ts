// Drafts, scheduled sends, compose uploads and the Voice profile (ADR 0010).
//   GET    /drafts?workspace=              every open Draft, decrypted (423 when locked)
//   GET    /drafts/:id                     one Draft
//   PUT    /drafts/:id                     {at?, actor?, updatedBy?, content}  last-writer-wins by `at`
//   DELETE /drafts/:id                     {at?, actor?} in the body is optional
//   POST   /drafts/:id/send                {sendId?, delaySeconds?, at?}  ->  {sendId, runAt}
//   GET    /sends?workspace=
//   POST   /sends/:id/cancel               only before run_at; reopens the Draft
//   POST   /blobs                          {workspace, name, mediaType, size}  ->  {id, chunkSize, chunkCount}
//   PUT    /blobs/:id/chunks/:index        raw bytes of one chunk (application/octet-stream)
//   GET    /blobs/:id                      the upload's state
//   GET    /voice?workspace=
//   PUT    /voice                          {workspace, description?, excerpts?, enabled?}

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { Drafts } from "../drafts/index.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { parseBody } from "./validate.ts";

const person = z.object({ name: z.string().default(""), email: z.string().min(1) });
const draftAttachment = z.object({
  blobId: z.string().min(1),
  name: z.string(),
  size: z.number().int().min(0),
  mediaType: z.string(),
});
const content = z.object({
  threadId: z.string().min(1).nullable().default(null),
  kind: z.enum(["new", "reply", "forward"]).default("new"),
  inReplyToMessageId: z.string().min(1).nullable().default(null),
  to: z.array(person).default([]),
  cc: z.array(person).default([]),
  bcc: z.array(person).default([]),
  subject: z.string().default(""),
  bodyHtml: z.string().default(""),
  bodyText: z.string().default(""),
  attachments: z.array(draftAttachment).default([]),
});
const stamp = z.object({
  at: z.iso.datetime({ offset: true }).optional(),
  actor: z.enum(["user", "automation"]).default("user"),
});
const saveBody = stamp.extend({
  workspace: z.string().min(1),
  updatedBy: z.string().min(1).max(200).optional(),
  content,
});
const sendBody = z.object({
  sendId: z.string().min(1).optional(),
  delaySeconds: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600 * 30)
    .optional(),
  at: z.iso.datetime({ offset: true }).optional(),
});
const workspaceQuery = z.object({ workspace: z.string().min(1) });
const blobStart = z.object({
  workspace: z.string().min(1),
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200).default("application/octet-stream"),
  size: z
    .number()
    .int()
    .min(0)
    .max(200 * 1024 * 1024),
});
const voiceBody = z.object({
  workspace: z.string().min(1),
  description: z.string().max(20_000).optional(),
  excerpts: z.array(z.string().max(20_000)).max(50).optional(),
  enabled: z.boolean().optional(),
});

export function draftsRoutes(drafts: Drafts, mailstore: Mailstore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/drafts", async (c) => {
    const q = workspaceQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", issues: q.error.issues }, 400);
    return c.json({ drafts: await drafts.list(q.data.workspace) });
  });

  app.get("/drafts/:id", async (c) => c.json(await drafts.get(c.req.param("id"))));

  app.put("/drafts/:id", async (c) => {
    const body = await parseBody(c, saveBody);
    if (!body.ok) return body.response;
    const { workspace, content: draftContent, ...rest } = body.data;
    const result = await drafts.save({
      id: c.req.param("id"),
      workspaceId: workspace,
      content: draftContent,
      ...(rest.at ? { at: rest.at } : {}),
      actor: rest.actor,
      ...(rest.updatedBy ? { updatedBy: rest.updatedBy } : {}),
    });
    return c.json(result);
  });

  app.delete("/drafts/:id", async (c) => {
    const raw = await c.req.text();
    let parsed: z.output<typeof stamp> = { actor: "user" };
    if (raw.trim() !== "") {
      const result = stamp.safeParse(JSON.parse(raw));
      if (!result.success)
        return c.json({ error: "invalid_body", issues: result.error.issues }, 400);
      parsed = result.data;
    }
    return c.json(
      await drafts.remove(c.req.param("id"), {
        ...(parsed.at ? { at: parsed.at } : {}),
        actor: parsed.actor,
      }),
    );
  });

  app.post("/drafts/:id/send", async (c) => {
    const body = await parseBody(c, sendBody);
    if (!body.ok) return body.response;
    return c.json(await drafts.schedule(c.req.param("id"), body.data));
  });

  app.get("/sends", async (c) => {
    const q = workspaceQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", issues: q.error.issues }, 400);
    return c.json({ sends: await drafts.listSends(q.data.workspace) });
  });

  app.get("/sends/:id", async (c) => c.json(await drafts.getSend(c.req.param("id"))));

  app.post("/sends/:id/cancel", async (c) => c.json(await drafts.cancel(c.req.param("id"))));

  app.post("/blobs", async (c) => {
    const body = await parseBody(c, blobStart);
    if (!body.ok) return body.response;
    const { workspace, ...rest } = body.data;
    return c.json(await mailstore.startBlob(workspace, rest), 201);
  });

  app.put("/blobs/:id/chunks/:index", async (c) => {
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index) || index < 0) return c.json({ error: "invalid_index" }, 400);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    try {
      return c.json(await mailstore.putBlobChunk(c.req.param("id"), index, bytes));
    } catch (error) {
      if (error instanceof RangeError)
        return c.json({ error: "bad_chunk", message: error.message }, 400);
      throw error;
    }
  });

  app.get("/blobs/:id", async (c) => {
    const blob = await mailstore.findBlob(c.req.param("id"));
    if (!blob) return c.json({ error: "not_found" }, 404);
    return c.json(blob);
  });

  app.get("/voice", async (c) => {
    const q = workspaceQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", issues: q.error.issues }, 400);
    return c.json(await drafts.getVoice(q.data.workspace));
  });

  app.put("/voice", async (c) => {
    const body = await parseBody(c, voiceBody);
    if (!body.ok) return body.response;
    const { workspace, ...patch } = body.data;
    return c.json(await drafts.putVoice(workspace, patch));
  });

  return app;
}
