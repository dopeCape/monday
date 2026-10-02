// A View whose scope is a full search (docs/spec/views.md, "Scope by a
// search"): its members. The Server keeps no plaintext index (ADR 0015), so a
// search scope cannot be SQL; code reads the mail in memory with the full
// search's own matcher and keeps only which Threads matched (view_members, ids
// and the Thread's version), and the Changes feed carries the same ids to the
// Device's Cache, where the View is read offline. Members are found three
// ways, all through here: the pinned View's walk (backfill.ts) a page at a
// time, an arriving or changed Thread (a Job per Thread version, tested
// against every pinned search View of its Workspace), and the Signal
// request's scope check, which tests a Thread it has not seen at this
// version. A locked Server finds none: the walk waits, the Job sleeps.

import type {
  Id,
  ViewContext,
  ViewMembersChange,
  ViewScopeFacts,
  ViewThread,
} from "@monday/shared";
import { memberFacts, memberKey, parseScopeQuery, scopeAdmits } from "@monday/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { LockedError } from "../../crypto/keys.ts";
import type { Db } from "../../db/client.ts";
import { viewMembers } from "../../db/schema.ts";
import type { Job, Jobs } from "../../jobs/index.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import type { ViewStore } from "../../views/index.ts";
import { loadViewThreads } from "../../views/threads.ts";

export const VIEW_MEMBERS_STEP = "views-members";

export interface ViewMembersPayload {
  workspaceId: Id;
  threadId: Id;
}

export interface ViewMembership {
  /** The View's members, newest match first. */
  list(viewId: Id): Promise<Id[]>;
  /** Empties the View's members (a new query, or no query any more) and tells the Device. */
  reset(workspaceId: Id, viewId: Id): Promise<void>;
  /**
   * Matches a page of the walk (Threads the View's other facts admit) and records
   * who joined or left; returns the ones that match. Throws LockedError when locked.
   */
  matchPage(
    workspaceId: Id,
    viewId: Id,
    facts: ViewScopeFacts,
    page: readonly ViewThread[],
  ): Promise<Set<Id>>;
  /**
   * One Thread against the Workspace's pinned search Views (or only `viewId`): matched
   * now and recorded; by View, whether it is a member.
   */
  test(workspaceId: Id, threadId: Id, viewId?: Id): Promise<Map<Id, boolean>>;
  /**
   * Whether a pinned search View's query admits a Thread: its member row at the
   * Thread's version, else matched now (and recorded).
   */
  admits(workspaceId: Id, threadId: Id, viewId: Id): Promise<boolean>;
  /** A Thread arrived or changed: a Job tests it against the pinned search Views. */
  threadReady(workspaceId: Id, threadId: Id): Promise<void>;
  registerSteps(jobs: Jobs): void;
}

export interface ViewMembershipOptions {
  db: Db;
  mailstore: Mailstore;
  store: ViewStore;
  context: (workspaceId: Id) => Promise<ViewContext>;
  /** routing.wait_seconds: how long a Job that met a locked Server sleeps. */
  waitSeconds: () => Promise<number>;
  now?: () => Date;
  log?: (message: string) => void;
}

export const viewMembersJobId = (threadId: Id, messageCount: number) =>
  `${VIEW_MEMBERS_STEP}:${threadId}:${messageCount}`;

export function createViewMembership(options: ViewMembershipOptions): ViewMembership {
  const { db, mailstore, store } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  let jobs: Jobs | null = null;

  /** The Workspace's pinned Views whose scope is a search. */
  const searchViews = async (workspaceId: Id) =>
    (await store.list(workspaceId)).filter(
      (v) => v.pinned && !v.deletedAt && Boolean(v.doc.scope.facts.query),
    );

  /** Who joined and who left, in one transaction with the feed row the Device reads. */
  const record = async (
    workspaceId: Id,
    viewId: Id,
    joined: ReadonlyArray<{ id: Id; messageCount: number }>,
    left: readonly Id[],
    reset = false,
  ) => {
    const at = now();
    const added: Id[] = [];
    await db.transaction(async (tx) => {
      if (reset) await tx.delete(viewMembers).where(eq(viewMembers.viewId, viewId));
      if (left.length) {
        await tx
          .delete(viewMembers)
          .where(and(eq(viewMembers.viewId, viewId), inArray(viewMembers.threadId, [...left])));
      }
      if (joined.length) {
        const was = reset
          ? new Set<Id>()
          : new Set(
              (
                await tx
                  .select({ threadId: viewMembers.threadId })
                  .from(viewMembers)
                  .where(
                    and(
                      eq(viewMembers.viewId, viewId),
                      inArray(
                        viewMembers.threadId,
                        joined.map((j) => j.id),
                      ),
                    ),
                  )
              ).map((r) => r.threadId),
            );
        for (const j of joined) if (!was.has(j.id)) added.push(j.id);
        await tx
          .insert(viewMembers)
          .values(
            joined.map((j) => ({
              viewId,
              threadId: j.id,
              workspaceId,
              messageCount: j.messageCount,
              matchedAt: at,
            })),
          )
          .onConflictDoUpdate({
            target: [viewMembers.viewId, viewMembers.threadId],
            set: { messageCount: sql.raw("excluded.message_count"), matchedAt: at },
          });
      }
      // The Device needs to hear only what changed: who joined, who left, or the reset.
      if (reset || added.length || left.length) {
        const payload: ViewMembersChange = {
          viewId,
          added,
          removed: [...left],
          ...(reset ? { reset: true } : {}),
        };
        await mailstore.recordChange(tx, {
          workspaceId,
          kind: "view_members",
          entityId: viewId,
          payload,
        });
      }
    });
  };

  /** The member rows among these Threads, by Thread. */
  const rowsOf = async (viewId: Id, threadIds: readonly Id[]) =>
    new Map(
      threadIds.length === 0
        ? []
        : (
            await db
              .select({ threadId: viewMembers.threadId, messageCount: viewMembers.messageCount })
              .from(viewMembers)
              .where(
                and(eq(viewMembers.viewId, viewId), inArray(viewMembers.threadId, [...threadIds])),
              )
          ).map((r) => [r.threadId, r.messageCount]),
    );

  /** Matches Threads the View's other facts admit; those they refuse are not members. */
  const matchAndRecord = async (
    workspaceId: Id,
    viewId: Id,
    facts: ViewScopeFacts,
    threads: readonly ViewThread[],
    ctx: Pick<ViewContext, "now" | "zone">,
  ): Promise<Set<Id>> => {
    const query = facts.query;
    if (!query) return new Set();
    const pre = memberFacts(facts);
    const candidates = threads.filter((t) => scopeAdmits(pre, t, ctx));
    const result = await mailstore.matchThreads(
      workspaceId,
      parseScopeQuery(query),
      candidates.map((t) => t.id),
    );
    const matched = new Set([...result].filter(([, m]) => m.matched).map(([id]) => id));
    const before = await rowsOf(
      viewId,
      threads.map((t) => t.id),
    );
    const joined = threads
      .filter((t) => matched.has(t.id) && before.get(t.id) !== t.messageCount)
      .map((t) => ({ id: t.id, messageCount: result.get(t.id)?.messageCount ?? t.messageCount }));
    const left = threads.filter((t) => !matched.has(t.id) && before.has(t.id)).map((t) => t.id);
    if (joined.length || left.length) await record(workspaceId, viewId, joined, left);
    return matched;
  };

  const test: ViewMembership["test"] = async (workspaceId, threadId, only) => {
    const out = new Map<Id, boolean>();
    const views = (await searchViews(workspaceId)).filter((v) => !only || v.id === only);
    if (views.length === 0) return out;
    const ctx = await options.context(workspaceId);
    const [thread] = await loadViewThreads(db, { workspaceId, ids: [threadId], limit: 1 });
    for (const v of views) {
      if (!thread || thread.deleted) {
        const had = await rowsOf(v.id, [threadId]);
        if (had.size) await record(workspaceId, v.id, [], [threadId]);
        out.set(v.id, false);
        continue;
      }
      const matched = await matchAndRecord(workspaceId, v.id, v.doc.scope.facts, [thread], ctx);
      out.set(v.id, matched.has(threadId));
    }
    return out;
  };

  const api: ViewMembership = {
    async list(viewId) {
      return (
        await db
          .select({ threadId: viewMembers.threadId })
          .from(viewMembers)
          .where(eq(viewMembers.viewId, viewId))
          .orderBy(viewMembers.matchedAt)
      ).map((r) => r.threadId);
    },

    async reset(workspaceId, viewId) {
      await record(workspaceId, viewId, [], [], true);
    },

    async matchPage(workspaceId, viewId, facts, page) {
      const ctx = await options.context(workspaceId);
      return matchAndRecord(workspaceId, viewId, facts, page, ctx);
    },

    test,

    async admits(workspaceId, threadId, viewId) {
      const [thread] = await loadViewThreads(db, { workspaceId, ids: [threadId], limit: 1 });
      if (!thread) return false;
      const row = (await rowsOf(viewId, [threadId])).get(threadId);
      if (row !== undefined && row === thread.messageCount) return true;
      return (await test(workspaceId, threadId, viewId)).get(viewId) ?? false;
    },

    async threadReady(workspaceId, threadId) {
      try {
        if (!jobs || memberKeyless(await searchViews(workspaceId))) return;
        const [thread] = await loadViewThreads(db, { workspaceId, ids: [threadId], limit: 1 });
        if (!thread) return;
        const payload: ViewMembersPayload = { workspaceId, threadId };
        await jobs.enqueue(VIEW_MEMBERS_STEP, payload, {
          id: viewMembersJobId(threadId, thread.messageCount),
        });
      } catch (error) {
        log(`view members ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    registerSteps(target) {
      jobs = target;
      target.registerStep<ViewMembersPayload>(
        VIEW_MEMBERS_STEP,
        async (job: Job<ViewMembersPayload>) => {
          try {
            await test(job.payload.workspaceId, job.payload.threadId);
            return "done";
          } catch (error) {
            // No root key: the mail cannot be read; look again later.
            if (error instanceof LockedError) {
              return { sleepMs: Math.max(1, await options.waitSeconds()) * 1000 };
            }
            throw error;
          }
        },
      );
    },
  };
  return api;
}

/** True when none of these Views has a search scope. */
function memberKeyless(views: ReadonlyArray<{ doc: { scope: { facts: ViewScopeFacts } } }>) {
  return views.every((v) => memberKey(v.doc.scope.facts) === null);
}
