// Mail reads over the Mailstore (docs/spec/architecture.md, "API shape").
// Header reads work on a locked server; content reads answer 423 Locked.
//   GET /threads?workspace=&section=&group=&limit=&cursor=   header projection, no decryption
//   GET /threads/:id/subject                                  {subject}
//   GET /messages/:id/body                                    {text, html, snippet}
//   GET /attachments/:id                                      the bytes, with name and media type
// Write intents (archive, snooze, tag) and content ingestion arrive with the
// Providers and the Changes feed in later slices.

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { Mailstore } from "../mailstore/index.ts";

const listQuery = z.object({
  workspace: z.string().min(1),
  section: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().min(1).optional(),
  archived: z.enum(["true", "false"]).optional(),
});

export function mailRoutes(mailstore: Mailstore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/threads", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    }
    const q = parsed.data;
    const page = await mailstore.listThreads(q.workspace, {
      ...(q.section !== undefined ? { section: q.section } : {}),
      ...(q.group !== undefined ? { group: q.group } : {}),
      limit: q.limit,
      cursor: q.cursor ?? null,
      includeArchived: q.archived === "true",
    });
    return c.json(page);
  });

  app.get("/threads/:id/subject", async (c) =>
    c.json({ subject: await mailstore.readThreadSubject(c.req.param("id")) }),
  );

  app.get("/messages/:id/body", async (c) =>
    c.json(await mailstore.readMessageBody(c.req.param("id"))),
  );

  app.get("/attachments/:id", async (c) => {
    const attachment = await mailstore.readAttachment(c.req.param("id"));
    const name = encodeURIComponent(attachment.name);
    const bytes = new Uint8Array(attachment.bytes);
    return c.body(bytes, 200, {
      "content-type": attachment.mediaType,
      "content-length": String(attachment.bytes.length),
      "content-disposition": `attachment; filename*=UTF-8''${name}`,
    });
  });

  return app;
}
