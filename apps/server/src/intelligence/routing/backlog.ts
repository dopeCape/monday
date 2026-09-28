// The Backlog sort (CONTEXT.md "Backlog sort", "Sort scope"; docs/spec/
// routing.md; ADR 0005): the background Job that routes the mail already
// there, inside a Sort scope, newest first, in batches of the judge's size.
//
// One per Workspace: the routing_backlogs row holds the scope, the cursor
// and the counts, and the route-backlog Job advances it one round at a time
// (a round is routing.backfill.concurrency batches of routing.backfill.
// batch_size Threads on TypeSafe, one prompt of routing.backfill.
// llm_batch_size on a language model), so a restart resumes where it was
// and the Routing page reads progress from the row. Starting another
// replaces it; pause, resume and cancel change the row, and a Job whose run
// id no longer matches stops.
//
// The walk starts at the Thread that was newest when it began (the top) and
// goes down to the scope's start date or count. When it runs out of Threads
// while the first sync is still bringing older mail inside the scope, it
// waits (routing.backfill.sync_wait_seconds) and goes on from its cursor, so
// mail that lands in scope during the run is sorted too. Then one catch-up
// pass takes Threads that landed above the top and that arrival routing did
// not place. Placement is routing's own (routeMany): the same Predicates,
// thresholds and Needs a decision; a Thread the user placed is left alone.
// With nothing that can sort (no TypeSafe key, no provider key, no coding
// agent) the Job waits (routing.wait_seconds) instead of failing.

import type {
  AiLevel,
  BacklogCursor,
  Id,
  RoutingBacklog,
  RoutingPreview,
  ScopeWords,
  SortScope,
} from "@monday/shared";
import { formatSortScope, parseSortScope } from "@monday/shared";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { groups, routingBacklogs, syncState, threadRoutes, threads } from "../../db/schema.ts";
import type { Job, Jobs } from "../../jobs/index.ts";
import { AiOffError, NoJudgeError, NoProviderKeyError } from "../runtime/index.ts";
import { LocalRuntimeTimeoutError } from "../runtime/local.ts";
import type { CandidateGroup, Routing } from "./index.ts";
import {
  above,
  below,
  type Cursor,
  countInScope,
  inboxInScope,
  newestInScope,
  pageInScope,
  type ResolvedScope,
  resolveScope,
} from "./scope-query.ts";

export const BACKLOG_STEP = "route-backlog";

export interface BacklogJobPayload {
  workspaceId: Id;
  runId: string;
}

/** What one round reads (routing.backfill.*, routing.wait_seconds). */
export interface BacklogStepSettings {
  batchSize: number;
  llmBatchSize: number;
  concurrency: number;
  /** Seconds to wait when nothing can sort. */
  waitSeconds: number;
  /** Seconds to wait for older mail from the first sync. */
  syncWaitSeconds: number;
}

export interface BacklogOptions {
  db: Db;
  routing: Routing;
  settings: () => Promise<BacklogStepSettings>;
  /** Whether TypeSafe answers now, which sets the round's size. */
  judgeAvailable: () => Promise<boolean>;
  /** Whether the language model that sorts is a coding agent on this computer (slow). */
  sorterIsLocal?: () => Promise<boolean>;
  /** Background sorting runs only at `automate`. Absent means `automate`. */
  level?: () => Promise<AiLevel>;
  now?: () => Date;
  log?: (message: string) => void;
}

/** Where a Backlog sort starts when a preview already moved the newest part of the scope. */
export interface BacklogStart {
  /** The oldest Thread the preview scored; the walk goes on below it. */
  after?: BacklogCursor | null | undefined;
  /** What the preview already did, so the counts read as one run. */
  done?: number | undefined;
  moved?: number | undefined;
  asked?: number | undefined;
}

export interface Backlog {
  /** The Workspace's Backlog sort, or null when none ever ran. */
  status(workspaceId: Id): Promise<RoutingBacklog | null>;
  /** Starts (or replaces) the Workspace's Backlog sort over a scope and queues its Job. */
  start(workspaceId: Id, scope: SortScope, from?: BacklogStart): Promise<RoutingBacklog>;
  pause(workspaceId: Id): Promise<RoutingBacklog | null>;
  resume(workspaceId: Id): Promise<RoutingBacklog | null>;
  cancel(workspaceId: Id): Promise<RoutingBacklog | null>;
  registerSteps(jobs: Jobs): void;
}

/**
 * What the Agent's organize tools act through (propose_groups,
 * organize_existing): the scope Settings, a sample dry run over a scope
 * with candidate Groups, and the Backlog sort itself.
 */
export interface BacklogSeam {
  /** routing.backfill.scope, routing.backfill.sample, and the words a scope is described with. */
  settings(): Promise<{ scope: string; sample: number; words: ScopeWords }>;
  /** Routing's dry run over the newest `sample` Threads of a scope, candidates beside the stored Groups. */
  preview(
    workspaceId: Id,
    scope: SortScope,
    sample: number,
    candidates?: readonly CandidateGroup[],
  ): Promise<RoutingPreview>;
  start(workspaceId: Id, scope: SortScope, from?: BacklogStart): Promise<RoutingBacklog>;
  cancel(workspaceId: Id): Promise<RoutingBacklog | null>;
}

type Row = typeof routingBacklogs.$inferSelect;

export function backlogJobId(workspaceId: Id, runId: string): string {
  return `${BACKLOG_STEP}:${workspaceId}:${runId}`;
}

function project(row: Row): RoutingBacklog {
  return {
    workspaceId: row.workspaceId,
    scope: row.scope,
    status: row.status,
    reason: row.reason ?? null,
    sorter: row.sorter ?? null,
    local: row.local,
    done: row.done,
    total: Math.max(row.total, row.done),
    moved: row.moved,
    asked: row.asked,
    skipped: row.skipped,
    batches: row.batches,
    batchSize: row.batchSize,
    calls: row.calls,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    lastError: row.lastError ?? null,
  };
}

/** Nothing can sort right now: the Job waits instead of failing. */
function nothingSorts(error: unknown): boolean {
  return (
    error instanceof NoProviderKeyError ||
    error instanceof LocalRuntimeTimeoutError ||
    error instanceof NoJudgeError ||
    error instanceof AiOffError
  );
}

export function createBacklog(options: BacklogOptions): Backlog {
  const { db, routing } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const level = options.level ?? (async (): Promise<AiLevel> => "automate");
  let jobs: Jobs | null = null;

  const read = async (workspaceId: Id): Promise<Row | null> =>
    (await db.query.routingBacklogs.findFirst({
      where: eq(routingBacklogs.workspaceId, workspaceId),
    })) ?? null;

  const patch = async (workspaceId: Id, values: Partial<Row>): Promise<Row | null> => {
    const [row] = await db
      .update(routingBacklogs)
      .set({ ...values, updatedAt: now() })
      .where(eq(routingBacklogs.workspaceId, workspaceId))
      .returning();
    return row ?? null;
  };

  const enqueue = async (workspaceId: Id, runId: string) => {
    if (!jobs) throw new Error("Backlog sorts need registerSteps first");
    const payload: BacklogJobPayload = { workspaceId, runId };
    await jobs.enqueue(BACKLOG_STEP, payload, { id: backlogJobId(workspaceId, runId) });
  };

  const resolvedOf = (row: Row): ResolvedScope => ({ since: row.since, limit: row.limit });

  /**
   * Whether the first sync may still bring older mail inside the scope: its
   * full pass has not finished, and nothing synced so far is older than a
   * date scope's start (sync fetches newest first, so once it went past the
   * start, what is still coming is out of scope).
   */
  const syncFilling = async (row: Row): Promise<boolean> => {
    const state = await db.query.syncState.findFirst({
      where: eq(syncState.workspaceId, row.workspaceId),
      columns: { lastFullSync: true, pending: true },
    });
    if (!state) return false;
    if (state.lastFullSync !== null && state.pending.length === 0) return false;
    if (row.since) {
      const [older] = await db
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(
            eq(threads.workspaceId, row.workspaceId),
            eq(threads.deleted, false),
            lt(threads.lastActivity, row.since),
          ),
        )
        .limit(1);
      if (older) return false;
    }
    return true;
  };

  /** Threads above the top that arrival routing has not placed since the run began. */
  const catchupRows = async (row: Row, limit: number) => {
    if (!row.topAt || !row.topId) return [];
    const top: Cursor = { at: row.topAt, id: row.topId };
    const conditions = [
      inboxInScope(row.workspaceId, row.since),
      above(top),
      or(isNull(threadRoutes.threadId), lt(threadRoutes.routedAt, row.startedAt)),
      sql`coalesce(${threads.writes}->'placement'->>'by', '') <> 'user'`,
    ];
    if (row.cursorAt && row.cursorId) {
      conditions.push(below({ at: row.cursorAt, id: row.cursorId }));
    }
    return db
      .select({ id: threads.id, lastActivity: threads.lastActivity })
      .from(threads)
      .leftJoin(threadRoutes, eq(threadRoutes.threadId, threads.id))
      .where(and(...conditions))
      .orderBy(desc(threads.lastActivity), desc(threads.id))
      .limit(limit);
  };

  const finish = (row: Row) =>
    patch(row.workspaceId, {
      status: "done",
      reason: null,
      finishedAt: now(),
      total: Math.max(row.total, row.done),
    });

  const wait = async (row: Row, reason: "no_judge" | "sync" | "level", seconds: number) => {
    await patch(row.workspaceId, { status: "waiting", reason });
    return { sleepMs: Math.max(1, seconds) * 1000 };
  };

  /** One round of a Backlog sort. */
  const step = async (
    job: Job<BacklogJobPayload>,
  ): Promise<"done" | "again" | { sleepMs: number }> => {
    const { workspaceId, runId } = job.payload;
    const row = await read(workspaceId);
    if (!row || row.runId !== runId) return "done";
    if (row.status === "paused" || row.status === "cancelled" || row.status === "done") {
      return "done";
    }
    const s = await options.settings();
    if ((await level()) !== "automate") return wait(row, "level", s.waitSeconds);
    const [anyGroup] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.workspaceId, workspaceId), isNull(groups.parentId)))
      .limit(1);
    if (!anyGroup) {
      await finish(row);
      return "done";
    }
    const judge = await options.judgeAvailable();
    const round = judge
      ? Math.max(1, s.batchSize) * Math.max(1, s.concurrency)
      : Math.max(1, s.llmBatchSize);
    const resolved = resolvedOf(row);

    // The walk: newest first from the top down to the scope's start or count.
    let phase = row.phase;
    let ids: Array<{ id: string; lastActivity: Date }> = [];
    if (phase === "walk") {
      const remaining = row.limit === null ? round : Math.max(0, row.limit - row.walked);
      const cursor: Cursor | null =
        row.cursorAt && row.cursorId ? { at: row.cursorAt, id: row.cursorId } : null;
      const top: Cursor | null = row.topAt && row.topId ? { at: row.topAt, id: row.topId } : null;
      if (remaining > 0 && (cursor || top)) {
        const page = await pageInScope(db, workspaceId, resolved, {
          limit: Math.min(round, remaining),
          below: cursor,
          atOrBelow: cursor ? null : top,
        });
        ids = page.map((r) => ({ id: r.id, lastActivity: r.lastActivity }));
      }
      if (ids.length === 0) {
        const countDone = row.limit !== null && row.walked >= row.limit;
        if (!countDone && (await syncFilling(row))) {
          return wait(row, "sync", s.syncWaitSeconds);
        }
        phase = "catchup";
        await patch(workspaceId, { phase, cursorAt: null, cursorId: null });
        row.cursorAt = null;
        row.cursorId = null;
      }
    }
    if (phase === "catchup") {
      ids = await catchupRows(row, round);
      if (ids.length === 0) {
        await finish(row);
        return "done";
      }
    }

    let result: Awaited<ReturnType<Routing["routeMany"]>>;
    try {
      result = await routing.routeMany(
        workspaceId,
        ids.map((r) => r.id),
        { jobId: job.id },
      );
    } catch (error) {
      if (nothingSorts(error)) {
        log(`backlog ${workspaceId}: waiting: ${(error as Error).message}`);
        return wait(row, "no_judge", s.waitSeconds);
      }
      const message = error instanceof Error ? error.message : String(error);
      log(`backlog ${workspaceId}: ${message}`);
      await patch(workspaceId, { lastError: message.slice(0, 500) });
      return { sleepMs: Math.max(1, s.waitSeconds) * 1000 };
    }

    const last = ids[ids.length - 1];
    const local =
      result.sorter === "llm" && options.sorterIsLocal ? await options.sorterIsLocal() : false;
    const total = await countInScope(db, workspaceId, resolved);
    // Pause or Stop may have landed while the round ran: the counts still count, the status stays.
    const current = await read(workspaceId);
    if (!current || current.runId !== runId) return "done";
    const keep = current.status === "paused" || current.status === "cancelled";
    await patch(workspaceId, {
      status: keep ? current.status : "running",
      reason: keep ? current.reason : null,
      phase,
      cursorAt: last?.lastActivity ?? current.cursorAt,
      cursorId: last?.id ?? current.cursorId,
      walked: current.walked + (phase === "walk" ? ids.length : 0),
      done: current.done + ids.length,
      total: Math.max(total, current.done + ids.length),
      moved: current.moved + result.moved,
      asked: current.asked + result.asked,
      skipped: current.skipped + result.skipped,
      calls: current.calls + result.calls,
      batches: current.batches + result.batches,
      batchSize: result.batchSize || current.batchSize,
      sorter: result.sorter ?? current.sorter,
      local,
      lastError: null,
    });
    return keep ? "done" : "again";
  };

  const api: Backlog = {
    async status(workspaceId) {
      const row = await read(workspaceId);
      return row ? project(row) : null;
    },

    async start(workspaceId, scope, from = {}) {
      const at = now();
      const resolved = resolveScope(scope, at);
      const runId = crypto.randomUUID();
      const top = await newestInScope(db, workspaceId, { since: null, limit: null });
      const after = from.after ? { at: new Date(from.after.at), id: from.after.id } : null;
      const done = Math.max(0, from.done ?? 0);
      const total = await countInScope(db, workspaceId, resolved);
      const values = {
        workspaceId,
        runId,
        scope: formatSortScope(scope),
        status: "running" as const,
        reason: null,
        sorter: null,
        local: false,
        since: resolved.since,
        limit: resolved.limit,
        phase: "walk" as const,
        topAt: top?.at ?? null,
        topId: top?.id ?? null,
        cursorAt: after?.at ?? null,
        cursorId: after?.id ?? null,
        walked: after ? done : 0,
        done,
        total: Math.max(total, done),
        moved: Math.max(0, from.moved ?? 0),
        asked: Math.max(0, from.asked ?? 0),
        skipped: 0,
        batches: 0,
        batchSize: 0,
        calls: 0,
        lastError: null,
        startedAt: at,
        updatedAt: at,
        finishedAt: null,
      };
      const [row] = await db
        .insert(routingBacklogs)
        .values(values)
        .onConflictDoUpdate({ target: routingBacklogs.workspaceId, set: values })
        .returning();
      if (!row) throw new Error("the Backlog sort was not stored");
      await enqueue(workspaceId, runId);
      return project(row);
    },

    async pause(workspaceId) {
      const row = await read(workspaceId);
      if (!row) return null;
      if (row.status !== "running" && row.status !== "waiting") return project(row);
      const next = await patch(workspaceId, { status: "paused" });
      return next ? project(next) : null;
    },

    async resume(workspaceId) {
      const row = await read(workspaceId);
      if (!row) return null;
      if (row.status !== "paused") return project(row);
      // A new run id: a Job still asleep from before the pause stops when it wakes.
      const runId = crypto.randomUUID();
      const next = await patch(workspaceId, { status: "running", reason: null, runId });
      await enqueue(workspaceId, runId);
      return next ? project(next) : null;
    },

    async cancel(workspaceId) {
      const row = await read(workspaceId);
      if (!row) return null;
      if (row.status === "done" || row.status === "cancelled") return project(row);
      const next = await patch(workspaceId, {
        status: "cancelled",
        reason: null,
        finishedAt: now(),
      });
      return next ? project(next) : null;
    },

    registerSteps(target) {
      jobs = target;
      target.registerStep<BacklogJobPayload>(BACKLOG_STEP, async (job, ctx) => {
        // A round may take a while on a language model: the lease is renewed first.
        await ctx.extend();
        return step(job);
      });
    },
  };
  return api;
}

/** A scope sentence parsed, for a route or a tool; null when it names none. */
export function scopeFrom(text: string | undefined | null): SortScope | null {
  return text ? parseSortScope(text) : null;
}
