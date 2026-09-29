// The Agent's Board drafts (docs/spec/boards.md, "Making a Board: the Agent
// must test it"): what create_board, revise_board and update_board proposed
// and tried, sealed under the Workspace key like the Boards themselves. A
// draft becomes a Board only on Pin board (Apply for an edit); Not now marks
// it discarded. The card reads the draft by id, so the user's corrections
// and the Agent's revisions show on it.

import type { BoardDoc, BoardDraft, BoardTest, Id } from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { boardDrafts } from "../db/schema.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { BoardNotFoundError } from "./index.ts";

interface Sealed {
  doc: BoardDoc;
  previous: BoardDoc | null;
  test: BoardTest | null;
  threadIds: Id[];
}

export interface DraftStore {
  create(
    workspaceId: Id,
    draft: Pick<BoardDraft, "boardId" | "doc" | "previous" | "test" | "threadIds">,
  ): Promise<BoardDraft>;
  /** Throws BoardNotFoundError. */
  get(id: Id): Promise<BoardDraft>;
  save(
    id: Id,
    change: Partial<Pick<BoardDraft, "doc" | "test" | "threadIds" | "status">>,
  ): Promise<BoardDraft>;
}

export function createDraftStore(options: {
  db: Db;
  mailstore: Mailstore;
  now?: () => Date;
  id?: () => string;
}): DraftStore {
  const { db, mailstore } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.id ?? (() => `bd_${crypto.randomUUID()}`);

  const seal = async (workspaceId: Id, value: Sealed) => {
    const ref = await mailstore.storeContent(workspaceId, "board", JSON.stringify(value));
    const enc = ref.chunks[0];
    if (!enc) throw new RangeError("board draft envelope missing");
    return { contentEnc: enc, contentKey: ref.key };
  };

  const toDraft = async (r: typeof boardDrafts.$inferSelect): Promise<BoardDraft> => {
    const sealed = JSON.parse(
      await mailstore.readText({
        workspaceId: r.workspaceId,
        kind: "board",
        key: r.contentKey,
        chunks: [r.contentEnc],
        size: -1,
      }),
    ) as Sealed;
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      boardId: r.boardId,
      status: r.status,
      doc: sealed.doc,
      previous: sealed.previous,
      test: sealed.test,
      threadIds: sealed.threadIds,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  };

  const store: DraftStore = {
    async create(workspaceId, draft) {
      const at = now();
      const [r] = await db
        .insert(boardDrafts)
        .values({
          id: newId(),
          workspaceId,
          boardId: draft.boardId,
          status: "open",
          ...(await seal(workspaceId, {
            doc: draft.doc,
            previous: draft.previous,
            test: draft.test,
            threadIds: draft.threadIds,
          })),
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!r) throw new Error("board draft insert failed");
      return toDraft(r);
    },

    async get(id) {
      const r = await db.query.boardDrafts.findFirst({ where: eq(boardDrafts.id, id) });
      if (!r) throw new BoardNotFoundError(id);
      return toDraft(r);
    },

    async save(id, change) {
      const current = await store.get(id);
      const next = { ...current, ...change };
      const [r] = await db
        .update(boardDrafts)
        .set({
          status: next.status,
          ...(await seal(current.workspaceId, {
            doc: next.doc,
            previous: next.previous,
            test: next.test,
            threadIds: next.threadIds,
          })),
          updatedAt: now(),
        })
        .where(eq(boardDrafts.id, id))
        .returning();
      if (!r) throw new BoardNotFoundError(id);
      return toDraft(r);
    },
  };
  return store;
}
