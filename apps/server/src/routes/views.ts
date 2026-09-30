// Views (docs/spec/views.md). Documents are sealed at rest and served
// decrypted here, like Templates; a locked Server answers 423. Every write is
// validated (the schema and the limits) before anything is saved, tells the
// feed, and tells the Signal store the Workspace's Views changed.
//   GET    /views?workspace=                  {views}   the Views not deleted, in nav order
//   GET    /views/:id                         View (deleted ones too, for Undo)
//   GET    /views/:id/versions/:version       {doc}      an older version, for Show the source
//   POST   /views                             {workspace, doc, checkBar?}  ->  View
//   PUT    /views/:id                         {doc}  ->  {view, previous}
//   POST   /views/:id/revert                  {version}  ->  View        (Undo of an edit)
//   POST   /views/:id/move                    {by: -1 | 1}  ->  {views}
//   POST   /views/:id/pin                     {pinned}  ->  View
//   DELETE /views/:id                         ->  View                    (with Undo)
//   POST   /views/:id/restore                 ->  View                    (Undo of a delete)
//   POST   /views/:id/place                   {threadId, lane | null}  ->  View   a correction on the View
//   POST   /views/:id/dismiss-check           ->  View
//   POST   /views/:id/done                    {threadId, done, messageCount}  ->  View   a checklist item
//   GET    /views/:id/values                  {values}   every value the View's Extractions picked, by Thread
//   POST   /views/values                      {workspace, threadIds}  ->  {values}   the values on these Threads
// The Agent's drafts (slice 40): the card reads and acts on them; only the user's click saves.
//   GET    /views/drafts/:id                  ViewDraft
//   POST   /views/drafts/:id/corrections      {threadId, lane?} | {threadId, signal, holds}  ->  ViewDraft
//   POST   /views/drafts/:id/pin              {factsOnly?}  ->  {view, draft}     Pin view
//   POST   /views/drafts/:id/apply            ->  {view, draft, previous}         Apply an edit
//   POST   /views/drafts/:id/discard          ->  ViewDraft                       Not now

import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { ViewIntelligence } from "../intelligence/views/index.ts";
import { ViewInvalidError, ViewLimitError, ViewNotFoundError } from "../views/index.ts";
import { parseBody } from "./validate.ts";

const workspaceQuery = z.object({ workspace: z.string().min(1) });
const createBody = z.object({
  workspace: z.string().min(1),
  doc: z.record(z.string(), z.unknown()),
  checkBar: z.boolean().optional(),
});
const updateBody = z.object({ doc: z.record(z.string(), z.unknown()) });
const revertBody = z.object({ version: z.number().int().min(1) });
const moveBody = z.object({ by: z.union([z.literal(-1), z.literal(1)]) });
const pinBody = z.object({ pinned: z.boolean() });
const correctionBody = z.object({
  threadId: z.string().min(1),
  lane: z.string().min(1).max(40).optional(),
  signal: z.string().min(1).max(80).optional(),
  holds: z.boolean().optional(),
  extraction: z.string().min(1).max(80).optional(),
  value: z.string().max(500).nullable().optional(),
});
const pinDraftBody = z.object({ factsOnly: z.boolean().optional() });
const valuesBody = z.object({
  workspace: z.string().min(1),
  threadIds: z.array(z.string().min(1)).min(1).max(1000),
});
const doneBody = z.object({
  threadId: z.string().min(1),
  done: z.boolean(),
  messageCount: z.number().int().min(0),
});
const placeBody = z.object({
  threadId: z.string().min(1),
  lane: z.string().min(1).max(40).nullable(),
});

/** The Views' own errors in plain words; anything else goes to the app's handler. */
export function viewRefused(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof ViewInvalidError) {
    return c.json({ error: "invalid_view", errors: error.errors }, 422);
  }
  if (error instanceof ViewLimitError) {
    return c.json({ error: "limit", reason: error.reason, message: error.message }, 409);
  }
  if (error instanceof ViewNotFoundError) return c.json({ error: "not_found" }, 404);
  throw error;
}

export function viewRoutes(views: ViewIntelligence): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const store = views.store;

  /** Runs a write, then lets the Signal store follow the Workspace's Views. */
  const wrote = async <T extends { workspaceId: string }>(
    c: Context<AppEnv>,
    run: () => Promise<T>,
    shape: (value: T) => unknown = (v) => v,
  ): Promise<Response> => {
    try {
      const value = await run();
      await views.changed(value.workspaceId);
      return c.json(shape(value) as object);
    } catch (error) {
      return viewRefused(c, error);
    }
  };

  const drafting = views.drafting;
  const draftAct = async (c: Context<AppEnv>, run: () => Promise<unknown>) => {
    try {
      return c.json((await run()) as object);
    } catch (error) {
      return viewRefused(c, error);
    }
  };

  app.get("/views/drafts/:id", (c) => draftAct(c, () => drafting.drafts.get(c.req.param("id"))));

  app.post("/views/drafts/:id/corrections", async (c) => {
    const body = await parseBody(c, correctionBody);
    if (!body.ok) return body.response;
    return draftAct(c, () => drafting.correct(c.req.param("id"), body.data));
  });

  app.post("/views/drafts/:id/pin", async (c) => {
    const body = await parseBody(c, pinDraftBody);
    if (!body.ok) return body.response;
    return draftAct(c, () =>
      drafting.pin(c.req.param("id"), {
        ...(body.data.factsOnly !== undefined ? { factsOnly: body.data.factsOnly } : {}),
      }),
    );
  });

  app.post("/views/drafts/:id/apply", (c) => draftAct(c, () => drafting.apply(c.req.param("id"))));

  app.post("/views/drafts/:id/discard", (c) =>
    draftAct(c, () => drafting.discard(c.req.param("id"))),
  );

  // The picked values, decrypted for the owner's Device (docs/spec/views.md, "Data and sync").
  app.post("/views/values", async (c) => {
    const body = await parseBody(c, valuesBody);
    if (!body.ok) return body.response;
    return c.json({ values: await views.valuesFor(body.data.workspace, body.data.threadIds) });
  });

  app.get("/views/:id/values", async (c) => {
    try {
      return c.json({ values: await views.values(c.req.param("id")) });
    } catch (error) {
      return viewRefused(c, error);
    }
  });

  app.post("/views/:id/done", async (c) => {
    const body = await parseBody(c, doneBody);
    if (!body.ok) return body.response;
    try {
      return c.json(
        await store.setDone(
          c.req.param("id"),
          body.data.threadId,
          body.data.done,
          body.data.messageCount,
        ),
      );
    } catch (error) {
      return viewRefused(c, error);
    }
  });

  app.get("/views", async (c) => {
    const q = workspaceQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query" }, 400);
    return c.json({ views: await store.list(q.data.workspace) });
  });

  app.get("/views/:id", async (c) => {
    const view = await store.get(c.req.param("id"));
    return view ? c.json(view) : c.json({ error: "not_found" }, 404);
  });

  app.get("/views/:id/versions/:version", async (c) => {
    try {
      const doc = await store.version(c.req.param("id"), Number(c.req.param("version")));
      return doc ? c.json({ doc }) : c.json({ error: "not_found" }, 404);
    } catch (error) {
      return viewRefused(c, error);
    }
  });

  app.post("/views", async (c) => {
    const body = await parseBody(c, createBody);
    if (!body.ok) return body.response;
    return wrote(c, () =>
      store.create(body.data.workspace, body.data.doc, {
        ...(body.data.checkBar !== undefined ? { checkBar: body.data.checkBar } : {}),
      }),
    );
  });

  app.put("/views/:id", async (c) => {
    const body = await parseBody(c, updateBody);
    if (!body.ok) return body.response;
    return wrote(
      c,
      async () => {
        const r = await store.update(c.req.param("id"), body.data.doc);
        return { ...r, workspaceId: r.view.workspaceId };
      },
      ({ view, previous }) => ({ view, previous }),
    );
  });

  app.post("/views/:id/revert", async (c) => {
    const body = await parseBody(c, revertBody);
    if (!body.ok) return body.response;
    return wrote(c, () => store.revert(c.req.param("id"), body.data.version));
  });

  app.post("/views/:id/move", async (c) => {
    const body = await parseBody(c, moveBody);
    if (!body.ok) return body.response;
    try {
      return c.json({ views: await store.move(c.req.param("id"), body.data.by) });
    } catch (error) {
      return viewRefused(c, error);
    }
  });

  app.post("/views/:id/pin", async (c) => {
    const body = await parseBody(c, pinBody);
    if (!body.ok) return body.response;
    return wrote(c, () => store.setPinned(c.req.param("id"), body.data.pinned));
  });

  app.delete("/views/:id", async (c) => wrote(c, () => store.remove(c.req.param("id"))));

  app.post("/views/:id/restore", async (c) => wrote(c, () => store.restore(c.req.param("id"))));

  app.post("/views/:id/place", async (c) => {
    const body = await parseBody(c, placeBody);
    if (!body.ok) return body.response;
    try {
      return c.json(await views.moveThread(c.req.param("id"), body.data.threadId, body.data.lane));
    } catch (error) {
      return viewRefused(c, error);
    }
  });

  app.post("/views/:id/dismiss-check", async (c) => {
    try {
      return c.json(await store.dismissCheck(c.req.param("id")));
    } catch (error) {
      return viewRefused(c, error);
    }
  });

  return app;
}
