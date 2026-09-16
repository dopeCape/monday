// Mail reads over the Mailstore (docs/spec/architecture.md, "API shape").
// Header reads work on a locked server; content reads answer 423 Locked.
//   GET /threads?workspace=&section=&group=&limit=&cursor=   header projection, no decryption
//   GET /threads/:id/subject                                  {subject}
//   GET /messages/:id/body                                    {text, html, snippet}
//   GET /attachments/:id                                      the bytes, with name and media type
// Write intents, the ones the Outbox replays (ADR 0005). Each body carries
// `at` (the actor's clock) and `actor`; the Mailstore applies last-writer-wins
// per field group and answers 200 either way, with `applied: false` and a
// reason when the row's last write beat the intent.
//   POST /threads/:id/archive | unarchive | star | unstar | read | unread | unsnooze | delete | undelete   {at, actor}
//   POST /threads/:id/snooze    {at, actor, until}
//   POST /threads/:id/move      {at, actor, group, subgroup?}
//   PUT  /threads/:id/tags      {at, actor, tags: [id]}
// Content ingestion arrives with the Providers.

import type { Intent, IntentKind } from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { parseBody } from "./validate.ts";

const listQuery = z.object({
  workspace: z.string().min(1),
  section: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().min(1).optional(),
  archived: z.enum(["true", "false"]).optional(),
});

const stamp = z.object({
  at: z.iso.datetime({ offset: true }),
  actor: z.enum(["user", "automation"]).default("user"),
});
const snoozeBody = stamp.extend({ until: z.iso.datetime({ offset: true }) });
const moveBody = stamp.extend({
  group: z.string().min(1).nullable(),
  subgroup: z.string().min(1).nullable().default(null),
});
const tagsBody = stamp.extend({ tags: z.array(z.string().min(1)).max(100) });

const SIMPLE_INTENTS: readonly Exclude<IntentKind, "snooze" | "move" | "tags">[] = [
  "archive",
  "unarchive",
  "star",
  "unstar",
  "read",
  "unread",
  "unsnooze",
  "delete",
  "undelete",
];

export function mailRoutes(mailstore: Mailstore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  for (const kind of SIMPLE_INTENTS) {
    app.post(`/threads/:id/${kind}`, async (c) => {
      const body = await parseBody(c, stamp);
      if (!body.ok) return body.response;
      const intent: Intent = { kind, threadId: c.req.param("id"), ...body.data };
      return c.json(await mailstore.applyIntent(intent));
    });
  }

  app.post("/threads/:id/snooze", async (c) => {
    const body = await parseBody(c, snoozeBody);
    if (!body.ok) return body.response;
    return c.json(
      await mailstore.applyIntent({ kind: "snooze", threadId: c.req.param("id"), ...body.data }),
    );
  });

  app.post("/threads/:id/move", async (c) => {
    const body = await parseBody(c, moveBody);
    if (!body.ok) return body.response;
    return c.json(
      await mailstore.applyIntent({ kind: "move", threadId: c.req.param("id"), ...body.data }),
    );
  });

  app.put("/threads/:id/tags", async (c) => {
    const body = await parseBody(c, tagsBody);
    if (!body.ok) return body.response;
    return c.json(
      await mailstore.applyIntent({ kind: "tags", threadId: c.req.param("id"), ...body.data }),
    );
  });

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
