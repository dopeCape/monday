// Boards (docs/spec/boards.md). Documents are sealed at rest and served
// decrypted here, like Templates; a locked Server answers 423. Every write is
// validated (the schema and the limits) before anything is saved, tells the
// feed, and tells the Signal store the Workspace's Boards changed.
//   GET    /boards?workspace=                  {boards}   the Boards not deleted, in nav order
//   GET    /boards/:id                         Board (deleted ones too, for Undo)
//   GET    /boards/:id/versions/:version       {doc}      an older version, for Show the source
//   POST   /boards                             {workspace, doc, checkBar?}  ->  Board
//   PUT    /boards/:id                         {doc}  ->  {board, previous}
//   POST   /boards/:id/revert                  {version}  ->  Board        (Undo of an edit)
//   POST   /boards/:id/move                    {by: -1 | 1}  ->  {boards}
//   POST   /boards/:id/pin                     {pinned}  ->  Board
//   DELETE /boards/:id                         ->  Board                    (with Undo)
//   POST   /boards/:id/restore                 ->  Board                    (Undo of a delete)
//   POST   /boards/:id/place                   {threadId, lane | null}  ->  Board   a correction on the Board
//   POST   /boards/:id/dismiss-check           ->  Board

import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { BoardInvalidError, BoardLimitError, BoardNotFoundError } from "../boards/index.ts";
import type { BoardIntelligence } from "../intelligence/boards/index.ts";
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
const placeBody = z.object({
  threadId: z.string().min(1),
  lane: z.string().min(1).max(40).nullable(),
});

/** The Boards' own errors in plain words; anything else goes to the app's handler. */
export function boardRefused(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof BoardInvalidError) {
    return c.json({ error: "invalid_board", errors: error.errors }, 422);
  }
  if (error instanceof BoardLimitError) {
    return c.json({ error: "limit", reason: error.reason, message: error.message }, 409);
  }
  if (error instanceof BoardNotFoundError) return c.json({ error: "not_found" }, 404);
  throw error;
}

export function boardRoutes(boards: BoardIntelligence): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const store = boards.store;

  /** Runs a write, then lets the Signal store follow the Workspace's Boards. */
  const wrote = async <T extends { workspaceId: string }>(
    c: Context<AppEnv>,
    run: () => Promise<T>,
    shape: (value: T) => unknown = (v) => v,
  ): Promise<Response> => {
    try {
      const value = await run();
      await boards.changed(value.workspaceId);
      return c.json(shape(value) as object);
    } catch (error) {
      return boardRefused(c, error);
    }
  };

  app.get("/boards", async (c) => {
    const q = workspaceQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query" }, 400);
    return c.json({ boards: await store.list(q.data.workspace) });
  });

  app.get("/boards/:id", async (c) => {
    const board = await store.get(c.req.param("id"));
    return board ? c.json(board) : c.json({ error: "not_found" }, 404);
  });

  app.get("/boards/:id/versions/:version", async (c) => {
    try {
      const doc = await store.version(c.req.param("id"), Number(c.req.param("version")));
      return doc ? c.json({ doc }) : c.json({ error: "not_found" }, 404);
    } catch (error) {
      return boardRefused(c, error);
    }
  });

  app.post("/boards", async (c) => {
    const body = await parseBody(c, createBody);
    if (!body.ok) return body.response;
    return wrote(c, () =>
      store.create(body.data.workspace, body.data.doc, {
        ...(body.data.checkBar !== undefined ? { checkBar: body.data.checkBar } : {}),
      }),
    );
  });

  app.put("/boards/:id", async (c) => {
    const body = await parseBody(c, updateBody);
    if (!body.ok) return body.response;
    return wrote(
      c,
      async () => {
        const r = await store.update(c.req.param("id"), body.data.doc);
        return { ...r, workspaceId: r.board.workspaceId };
      },
      ({ board, previous }) => ({ board, previous }),
    );
  });

  app.post("/boards/:id/revert", async (c) => {
    const body = await parseBody(c, revertBody);
    if (!body.ok) return body.response;
    return wrote(c, () => store.revert(c.req.param("id"), body.data.version));
  });

  app.post("/boards/:id/move", async (c) => {
    const body = await parseBody(c, moveBody);
    if (!body.ok) return body.response;
    try {
      return c.json({ boards: await store.move(c.req.param("id"), body.data.by) });
    } catch (error) {
      return boardRefused(c, error);
    }
  });

  app.post("/boards/:id/pin", async (c) => {
    const body = await parseBody(c, pinBody);
    if (!body.ok) return body.response;
    return wrote(c, () => store.setPinned(c.req.param("id"), body.data.pinned));
  });

  app.delete("/boards/:id", async (c) => wrote(c, () => store.remove(c.req.param("id"))));

  app.post("/boards/:id/restore", async (c) => wrote(c, () => store.restore(c.req.param("id"))));

  app.post("/boards/:id/place", async (c) => {
    const body = await parseBody(c, placeBody);
    if (!body.ok) return body.response;
    try {
      return c.json(await boards.moveThread(c.req.param("id"), body.data.threadId, body.data.lane));
    } catch (error) {
      return boardRefused(c, error);
    }
  });

  app.post("/boards/:id/dismiss-check", async (c) => {
    try {
      return c.json(await store.dismissCheck(c.req.param("id")));
    } catch (error) {
      return boardRefused(c, error);
    }
  });

  return app;
}
