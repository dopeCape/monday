// The Agent's View drafts (docs/spec/views.md, "Making a View: the Agent
// must test it"): what create_view, revise_view and update_view proposed
// and tried, sealed under the Workspace key like the Views themselves. A
// draft becomes a View only on Pin view (Apply for an edit); Not now marks
// it discarded. The card reads the draft by id, so the user's corrections
// and the Agent's revisions show on it.

import type { Id, ViewDoc, ViewDraft, ViewTest } from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { viewDrafts } from "../db/schema.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { ViewNotFoundError } from "./index.ts";

interface Sealed {
  doc: ViewDoc;
  previous: ViewDoc | null;
  test: ViewTest | null;
  threadIds: Id[];
}

export interface DraftStore {
  create(
    workspaceId: Id,
    draft: Pick<ViewDraft, "viewId" | "doc" | "previous" | "test" | "threadIds">,
  ): Promise<ViewDraft>;
  /** Throws ViewNotFoundError. */
  get(id: Id): Promise<ViewDraft>;
  save(
    id: Id,
    change: Partial<Pick<ViewDraft, "doc" | "test" | "threadIds" | "status">>,
  ): Promise<ViewDraft>;
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
    if (!enc) throw new RangeError("view draft envelope missing");
    return { contentEnc: enc, contentKey: ref.key };
  };

  const toDraft = async (r: typeof viewDrafts.$inferSelect): Promise<ViewDraft> => {
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
      viewId: r.viewId,
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
        .insert(viewDrafts)
        .values({
          id: newId(),
          workspaceId,
          viewId: draft.viewId,
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
      if (!r) throw new Error("view draft insert failed");
      return toDraft(r);
    },

    async get(id) {
      const r = await db.query.viewDrafts.findFirst({ where: eq(viewDrafts.id, id) });
      if (!r) throw new ViewNotFoundError(id);
      return toDraft(r);
    },

    async save(id, change) {
      const current = await store.get(id);
      const next = { ...current, ...change };
      const [r] = await db
        .update(viewDrafts)
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
        .where(eq(viewDrafts.id, id))
        .returning();
      if (!r) throw new ViewNotFoundError(id);
      return toDraft(r);
    },
  };
  return store;
}
