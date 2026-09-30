// Reading a pinned View (docs/spec/views.md, "Reading a pinned View"): when a
// View is pinned, or a new version changes what it asks or where it looks,
// code walks the View's own scope (archived and older Threads too, newest
// first, up to its limit and views.scope.max_threads) and asks each Thread only
// the View's questions it lacks at their current version: its own Signals and
// Extractions, many values, per-Message and per-row questions included, one
// Thread per request, several at once through the judge's pool and the
// limiter at background priority, under the monthly background budget. One
// walk per View in view_backfills, its cursor saved after every page, so a
// restart resumes; its progress rides the Changes feed (`view_reading`) so the
// View's bar says "Reading N of M" live. Picked values reach the Device the
// way arrival's do (view_values).

import type { AiLevel, Id, ViewContext, ViewReadingChange } from "@monday/shared";
import { scopeAdmits, scopeSince } from "@monday/shared";
import { eq } from "drizzle-orm";
import { LockedError } from "../../crypto/keys.ts";
import type { Db } from "../../db/client.ts";
import { viewBackfills } from "../../db/schema.ts";
import type { Job, Jobs, StepContext } from "../../jobs/index.ts";
import { type Mailstore, NotFoundError } from "../../mailstore/index.ts";
import type { ViewStore } from "../../views/index.ts";
import { countViewThreads, loadViewThreads } from "../../views/threads.ts";
import { AiOffError, NoJudgeError } from "../runtime/index.ts";
import { backgroundBudget } from "../signals/budget.ts";
import type { Signals } from "../signals/index.ts";
import { mapPool } from "../signals/pool.ts";

export const VIEW_BACKFILL_STEP = "views-backfill";

export interface ViewBackfillPayload {
  workspaceId: Id;
  viewId: Id;
  runId: string;
}

export interface ViewBackfillSettings {
  /** views.backfill.enabled */
  enabled: boolean;
  /** views.backfill.page_size */
  pageSize: number;
  /** signals.backfill.concurrency */
  concurrency: number;
  /** views.scope.max_threads: the most a View reads, whatever its limit. */
  maxThreads: number;
  /** signals.budget.background_monthly_usd */
  budgetUsd: number;
  /** routing.wait_seconds: how long a waiting walk sleeps before it looks again. */
  waitSeconds: number;
}

export interface ViewReading extends ViewReadingChange {
  asked: number;
  calls: number;
  version: number;
  signals: string[];
  lastError: string | null;
}

export interface ViewBackfills {
  /** Starts the View's walk for these of its stored Signal ids, or widens the one running. */
  request(workspaceId: Id, viewId: Id, signalIds: readonly string[]): Promise<ViewReading | null>;
  status(viewId: Id): Promise<ViewReading | null>;
  pause(viewId: Id): Promise<ViewReading | null>;
  resume(viewId: Id): Promise<ViewReading | null>;
  cancel(viewId: Id): Promise<ViewReading | null>;
  /**
   * Holds the View's walk from starting until the returned release runs (Pin
   * view writes the tried Threads' answers first, so the walk skips them).
   */
  hold(viewId: Id): () => Promise<void>;
  registerSteps(jobs: Jobs): void;
}

export interface ViewBackfillOptions {
  db: Db;
  mailstore: Mailstore;
  signals: Signals;
  store: ViewStore;
  context: (workspaceId: Id) => Promise<ViewContext>;
  settings: () => Promise<ViewBackfillSettings>;
  /** Whether anything can answer now. */
  canAnswer: () => Promise<boolean>;
  level?: () => Promise<AiLevel>;
  now?: () => Date;
  log?: (message: string) => void;
}

type Row = typeof viewBackfills.$inferSelect;

export const viewBackfillJobId = (viewId: Id, runId: string) =>
  `${VIEW_BACKFILL_STEP}:${viewId}:${runId}`;

function project(row: Row): ViewReading {
  return {
    viewId: row.viewId,
    status: row.status,
    reason: row.reason ?? null,
    done: Math.min(row.done, row.total),
    total: row.total,
    asked: row.asked,
    calls: row.calls,
    version: row.version,
    signals: row.signalIds,
    lastError: row.lastError ?? null,
  };
}

export function createViewBackfills(options: ViewBackfillOptions): ViewBackfills {
  const { db, signals, store } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const level = options.level ?? (async (): Promise<AiLevel> => "automate");
  let jobs: Jobs | null = null;
  const held = new Map<Id, number>();

  const read = async (viewId: Id): Promise<Row | null> =>
    (await db.query.viewBackfills.findFirst({ where: eq(viewBackfills.viewId, viewId) })) ?? null;

  /** Tells the Device where the walk is: counts only. */
  const announce = async (row: Row | null) => {
    if (!row) return;
    const payload: ViewReadingChange = {
      viewId: row.viewId,
      status: row.status,
      reason: row.reason ?? null,
      done: Math.min(row.done, row.total),
      total: row.total,
    };
    await options.mailstore.recordChange(db, {
      workspaceId: row.workspaceId,
      kind: "view_reading",
      entityId: row.viewId,
      payload,
    });
  };

  const patch = async (viewId: Id, values: Partial<Row>, tell = true): Promise<Row | null> => {
    const [row] = await db
      .update(viewBackfills)
      .set({ ...values, updatedAt: now() })
      .where(eq(viewBackfills.viewId, viewId))
      .returning();
    if (tell) await announce(row ?? null);
    return row ?? null;
  };

  const enqueue = async (row: Row) => {
    if (!jobs || held.has(row.viewId) || row.status !== "running") return;
    const payload: ViewBackfillPayload = {
      workspaceId: row.workspaceId,
      viewId: row.viewId,
      runId: row.runId,
    };
    await jobs.enqueue(VIEW_BACKFILL_STEP, payload, {
      id: viewBackfillJobId(row.viewId, row.runId),
    });
  };

  /** How many Threads the walk covers: the scope, at most its limit and the Setting. */
  const totalOf = async (workspaceId: Id, viewId: Id, s: ViewBackfillSettings) => {
    const view = await store.get(viewId);
    if (!view) return 0;
    const ctx = await options.context(workspaceId);
    const facts = view.doc.scope.facts;
    const cap = Math.min(view.doc.scope.limit, s.maxThreads);
    return countViewThreads(
      db,
      {
        workspaceId,
        since: scopeSince(facts, ctx.now, ctx.zone),
        scope: { facts, now: ctx.now, zone: ctx.zone },
      },
      cap,
    );
  };

  const wait = async (row: Row, reason: "budget" | "no_judge" | "level", ms: number) => {
    if (row.status !== "waiting" || row.reason !== reason)
      await patch(row.viewId, { status: "waiting", reason });
    return { sleepMs: Math.max(1000, ms) };
  };

  const step = async (
    job: Job<ViewBackfillPayload>,
    ctx?: StepContext,
  ): Promise<"done" | "again" | { sleepMs: number }> => {
    const { workspaceId, viewId, runId } = job.payload;
    const row = await read(viewId);
    if (!row || row.runId !== runId) return "done";
    if (row.status !== "running" && row.status !== "waiting") return "done";
    const s = await options.settings();
    const waitMs = Math.max(1, s.waitSeconds) * 1000;
    if ((await level()) !== "automate") return wait(row, "level", waitMs);
    const budget = await backgroundBudget(db, workspaceId, s.budgetUsd, now());
    if (budget.over)
      return wait(row, "budget", Math.min(waitMs, budget.resumesAt.getTime() - now().getTime()));
    if (!(await options.canAnswer())) return wait(row, "no_judge", waitMs);
    const view = await store.get(viewId);
    if (!view || view.deletedAt || !view.pinned) {
      await patch(viewId, { status: "cancelled", reason: null, finishedAt: now() });
      return "done";
    }
    if (row.status === "waiting") await patch(viewId, { status: "running", reason: null });
    const vctx = await options.context(workspaceId);
    const facts = view.doc.scope.facts;
    const budgetAtStart = ctx?.remainingMs() ?? Number.POSITIVE_INFINITY;
    const outOfTime = () => (ctx ? ctx.remainingMs() < budgetAtStart / 2 : false);
    let current: Row = row;
    for (;;) {
      if (current.done >= current.total) {
        await patch(viewId, { status: "done", reason: null, finishedAt: now() });
        return "done";
      }
      const page = await loadViewThreads(db, {
        workspaceId,
        owner: vctx.owner,
        since: scopeSince(facts, vctx.now, vctx.zone),
        scope: { facts, now: vctx.now, zone: vctx.zone },
        before:
          current.cursorAt && current.cursorId
            ? { at: current.cursorAt, id: current.cursorId }
            : null,
        limit: Math.min(Math.max(1, s.pageSize), current.total - current.done),
      });
      if (page.length === 0) {
        await patch(viewId, {
          status: "done",
          reason: null,
          done: current.total,
          finishedAt: now(),
        });
        return "done";
      }
      let stop: "no_judge" | null = null;
      let asked = 0;
      let calls = 0;
      // One Thread per request, several at once; the limiter keeps background behind arrival.
      const results = await mapPool(page, s.concurrency, async (t) => {
        if (stop || !scopeAdmits(facts, t, vctx)) return;
        try {
          const r = await signals.ask(workspaceId, t.id, {
            reason: "background",
            only: current.signalIds,
            jobId: job.id,
          });
          if (r.calls > 0) asked += 1;
          calls += r.calls;
        } catch (error) {
          if (error instanceof NotFoundError) return;
          if (
            error instanceof NoJudgeError ||
            error instanceof AiOffError ||
            error instanceof LockedError
          ) {
            stop = "no_judge";
            return;
          }
          throw error;
        }
      });
      for (const r of results) if (r.status === "failed") throw r.error;
      const latest = await read(viewId);
      if (!latest || latest.runId !== runId) return "done";
      if (stop) return wait(latest, stop, waitMs);
      const last = page[page.length - 1];
      const next = await patch(viewId, {
        cursorAt: last ? new Date(last.lastActivity) : latest.cursorAt,
        cursorId: last?.id ?? latest.cursorId,
        done: latest.done + page.length,
        asked: latest.asked + asked,
        calls: latest.calls + calls,
        lastError: null,
      });
      if (!next) return "done";
      // Paused or stopped while this page ran: its place is kept, nothing more is read.
      if (next.status !== "running") return "done";
      current = next;
      if ((await backgroundBudget(db, workspaceId, s.budgetUsd, now())).over)
        return wait(current, "budget", waitMs);
      if (outOfTime()) return "again";
    }
  };

  const api: ViewBackfills = {
    async status(viewId) {
      const row = await read(viewId);
      return row ? project(row) : null;
    },

    async request(workspaceId, viewId, signalIds) {
      const s = await options.settings();
      if (!s.enabled || signalIds.length === 0) return api.status(viewId);
      const view = await store.get(viewId);
      if (!view || view.deletedAt || !view.pinned) return api.status(viewId);
      const total = await totalOf(workspaceId, viewId, s);
      const existing = await read(viewId);
      const at = now();
      if (existing && ["running", "waiting", "paused"].includes(existing.status)) {
        // Widen the walk: the new questions join and it starts again from the top; Threads
        // that already have every answer cost nothing.
        const row = await patch(viewId, {
          signalIds: [...new Set([...existing.signalIds, ...signalIds])],
          version: view.version,
          cursorAt: null,
          cursorId: null,
          done: 0,
          total,
        });
        if (row) await enqueue(row);
        return row ? project(row) : null;
      }
      const values = {
        viewId,
        workspaceId,
        runId: crypto.randomUUID(),
        status: "running" as const,
        reason: null,
        version: view.version,
        signalIds: [...new Set(signalIds)],
        cursorAt: null,
        cursorId: null,
        done: 0,
        total,
        asked: 0,
        calls: 0,
        lastError: null,
        startedAt: at,
        updatedAt: at,
        finishedAt: null,
      };
      const [row] = await db
        .insert(viewBackfills)
        .values(values)
        .onConflictDoUpdate({ target: viewBackfills.viewId, set: values })
        .returning();
      if (!row) return null;
      await announce(row);
      await enqueue(row);
      return project(row);
    },

    async pause(viewId) {
      const row = await read(viewId);
      if (!row || (row.status !== "running" && row.status !== "waiting")) return api.status(viewId);
      const next = await patch(viewId, { status: "paused", reason: null });
      return next ? project(next) : null;
    },

    async resume(viewId) {
      const row = await read(viewId);
      if (!row || (row.status !== "paused" && row.status !== "waiting")) return api.status(viewId);
      // A new run: the job of the old one, if it sleeps, finds a different run and ends.
      const next = await patch(viewId, {
        status: "running",
        reason: null,
        runId: crypto.randomUUID(),
      });
      if (next) await enqueue(next);
      return next ? project(next) : null;
    },

    async cancel(viewId) {
      const row = await read(viewId);
      if (!row || row.status === "done" || row.status === "cancelled") return api.status(viewId);
      const next = await patch(viewId, { status: "cancelled", reason: null, finishedAt: now() });
      return next ? project(next) : null;
    },

    hold(viewId) {
      held.set(viewId, (held.get(viewId) ?? 0) + 1);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const n = (held.get(viewId) ?? 1) - 1;
        if (n > 0) held.set(viewId, n);
        else held.delete(viewId);
        const row = await read(viewId);
        if (row) await enqueue(row);
      };
    },

    registerSteps(target) {
      jobs = target;
      target.registerStep<ViewBackfillPayload>(VIEW_BACKFILL_STEP, async (job, ctx) => {
        await ctx.extend();
        try {
          return await step(job, ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`view reading ${job.payload.viewId}: ${message}`);
          await patch(job.payload.viewId, { lastError: message.slice(0, 500) }, false);
          const s = await options.settings();
          return { sleepMs: Math.max(1, s.waitSeconds) * 1000 };
        }
      });
    },
  };
  return api;
}
