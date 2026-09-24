// Mail reads over the Mailstore (docs/spec/architecture.md, "API shape").
// Header reads work on a locked server; content reads answer 423 Locked.
//   GET /threads?workspace=&section=&group=&limit=&cursor=   header projection, no decryption
//   GET /threads/:id/subject                                  {subject}
//   GET /threads/:id/messages                                 {messages: [header + attachments + bodyState]}
//   GET /messages/:id/body?images=                            {text, html, snippet, bodyState, display: {html, quoted, blockedImages}}
//   GET /messages/bodies?workspace=&after=&before=&limit=     fetched bodies by date range, newest first, html sanitised (423 locked)
//   GET /search/headers?workspace=&q=&limit=                  the headers-only index (ADR 0011), no decryption
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
import type { BodyState } from "../db/schema.ts";
import { displayBody } from "../mail/index.ts";
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

const bodiesQuery = z.object({
  workspace: z.string().min(1),
  after: z.iso.datetime({ offset: true }).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

const headersQuery = z.object({
  workspace: z.string().min(1),
  q: z.string().max(500).default(""),
  limit: z.coerce.number().int().min(1).max(200).default(50),
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

export interface MailRouteOptions {
  /** Per Message id, whether the body is fetched, pending or deferred (the sync mirror knows). */
  bodyStates?: (messageIds: string[]) => Promise<Map<string, BodyState>>;
  /**
   * Fetches one body from the Provider now, for a reader that opened a Thread
   * the sync has not reached yet; the sync engine's own pacing applies. A
   * failure leaves the body as it was and the route answers what it has.
   */
  fetchBody?: (messageId: string) => Promise<void>;
  /**
   * Called after a move intent lands, with where the Thread was. Routing
   * learns from it (slice 12: a user move is a correction). Runs after the
   * answer is decided; a failure is logged, never surfaced to the client.
   */
  onMove?: (
    intent: Extract<Intent, { kind: "move" }>,
    previous: { group: string | null; subgroup: string | null },
  ) => Promise<unknown>;
  /** Where a Thread is before a move, for `onMove`; null when unknown. */
  placement?: (
    threadId: string,
  ) => Promise<{ group: string | null; subgroup: string | null } | null>;
  /** The reader.load_remote_images Setting, for a body asked for without ?images. */
  remoteImages?: () => Promise<boolean>;
  /** The reader.tracker_hosts Setting: images from these hosts never load. */
  trackerHosts?: () => Promise<readonly string[]>;
  log?: (message: string) => void;
}

export function mailRoutes(mailstore: Mailstore, options: MailRouteOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const trackers = async (): Promise<readonly string[]> =>
    (await options.trackerHosts?.().catch(() => [])) ?? [];
  /** ?images=1 or 0 when the client says; the reader.load_remote_images Setting otherwise. */
  const remoteImages = async (query: string | undefined): Promise<boolean> => {
    if (query === "1") return true;
    if (query === "0") return false;
    return (await options.remoteImages?.().catch(() => false)) ?? false;
  };

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
    const intent = { kind: "move" as const, threadId: c.req.param("id"), ...body.data };
    const before =
      options.onMove && options.placement ? await options.placement(intent.threadId) : null;
    const result = await mailstore.applyIntent(intent);
    if (result.applied && options.onMove && before) {
      await options
        .onMove(intent, before)
        .catch((error) =>
          options.log?.(`move hook: ${error instanceof Error ? error.message : String(error)}`),
        );
    }
    return c.json(result);
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

  // Header projections with attachment headers and each Message's body state,
  // so the reader knows what to fetch. Works locked.
  app.get("/threads/:id/messages", async (c) => {
    const threadId = c.req.param("id");
    const list = await mailstore.listMessages(threadId);
    const states = await options.bodyStates?.(list.map((m) => m.id));
    return c.json({
      messages: list.map((m) => ({ ...m, bodyState: states?.get(m.id) ?? "fetched" })),
    });
  });

  // Before /messages/:id/body, so "bodies" is never read as an id.
  app.get("/messages/bodies", async (c) => {
    const parsed = bodiesQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    }
    const q = parsed.data;
    const page = await mailstore.listBodies(q.workspace, {
      after: q.after ?? null,
      before: q.before ?? null,
      limit: q.limit,
    });
    // A body the sync has not fetched is not a body: it goes out marked, so
    // the Cache skips it and asks again later instead of keeping an empty
    // one for good. What goes out is what the reader renders, sanitised like
    // the single route.
    const states = await options.bodyStates?.(page.bodies.map((b) => b.id));
    const allowRemoteImages = await remoteImages(c.req.query("images"));
    const bodies = [];
    for (const b of page.bodies) {
      const bodyState = states?.get(b.id) ?? "fetched";
      if (bodyState !== "fetched") {
        bodies.push({ ...b, text: "", html: null, bodyState });
        continue;
      }
      const header = await mailstore.findMessage(b.id);
      const display = displayBody(b, header?.attachments ?? [], {
        allowRemoteImages,
        trackerHosts: await trackers(),
      });
      bodies.push({ ...b, html: display.html, bodyState });
    }
    return c.json({ ...page, bodies });
  });

  // The body as stored plus what the reader shows: sanitised HTML (or the
  // text part converted), cid: images resolved to /attachments/:id, quoted
  // history wrapped so it can be folded, remote images blocked by default.
  app.get("/messages/:id/body", async (c) => {
    const messageId = c.req.param("id");
    // A body the sync has not fetched yet is fetched on demand, so an open
    // Thread never waits for the pass to come around to it.
    let bodyState: BodyState = "fetched";
    if (options.bodyStates) {
      bodyState = (await options.bodyStates([messageId])).get(messageId) ?? "fetched";
      if ((bodyState === "pending" || bodyState === "deferred") && options.fetchBody) {
        await options.fetchBody(messageId).catch((error) => {
          options.log?.(
            `body ${messageId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        bodyState = (await options.bodyStates([messageId])).get(messageId) ?? "fetched";
      }
    }
    const body = await mailstore.readMessageBody(messageId);
    const header = await mailstore.findMessage(messageId);
    const allowRemoteImages = await remoteImages(c.req.query("images"));
    // bodyState tells the Message's body from the empty stand-in a
    // header-only sync leaves: a client caches only a fetched one.
    return c.json({
      ...body,
      bodyState,
      display: displayBody(body, header?.attachments ?? [], {
        allowRemoteImages,
        trackerHosts: await trackers(),
      }),
    });
  });

  app.get("/search/headers", async (c) => {
    const parsed = headersQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
    }
    const q = parsed.data;
    return c.json(await mailstore.searchHeaders(q.workspace, { q: q.q, limit: q.limit }));
  });

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
