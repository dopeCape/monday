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
//
// A View whose scope is a full search (docs/spec/views.md, "Scope by a
// search") has members to find first, and the same walk finds them: it pages
// newest first through the Threads its other facts admit (the folder aside,
// views.query.page_size at a time, at most views.query.scan_max), matches each
// page with the full search's matcher (members.ts), records who matched, and
// asks the members its questions in the same pass. Finding members needs no
// judge and no budget, only an unlocked Server: when it may not ask (no judge,
// the budget, the AI level) it keeps finding them and holds the questions,
// then walks the members alone to ask them. Once every Thread was searched the
// members stand in for the query, and later walks (a reworded question) read
// only them.

import type { AiLevel, Id, View, ViewContext, ViewReadingChange } from "@monday/shared";
import {
  memberFacts,
  memberKey,
  scopeAdmits,
  scopeSince,
  viewExtractionDefs,
  viewSignalDefs,
} from "@monday/shared";
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
import type { ViewMembership } from "./members.ts";

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
  /** views.query.page_size: Threads a search scope's walk matches per page. */
  queryPageSize?: number | undefined;
  /** views.query.scan_max: the most Threads a search scope's walk looks through. */
  queryScanMax?: number | undefined;
}

export interface ViewReading extends ViewReadingChange {
  asked: number;
  calls: number;
  version: number;
  signals: string[];
  lastError: string | null;
}

export interface ViewBackfills {
  /**
   * Starts the View's walk for these of its stored Signal ids, or widens the one running.
   * A search scope whose members are not found yet for its query walks even with none.
   */
  request(workspaceId: Id, viewId: Id, signalIds: readonly string[]): Promise<ViewReading | null>;
  /**
   * After a View changed: a search scope whose query or facts moved finds its members
   * again (they are emptied first); one that lost its query loses its members.
   */
  ensure(workspaceId: Id, viewId: Id): Promise<void>;
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
  /** A search scope's members; without it a `query` scope's walk asks nothing. */
  members?: ViewMembership | undefined;
  now?: () => Date;
  log?: (message: string) => void;
}

type Row = typeof viewBackfills.$inferSelect;

export const viewBackfillJobId = (viewId: Id, runId: string) =>
  `${VIEW_BACKFILL_STEP}:${viewId}:${runId}`;

/** Where a search scope's walk is: finding the members, or asking them. */
const phaseOf = (row: Row): ViewReadingChange["phase"] =>
  row.membersKey ? (row.membersDone ? "read" : "search") : undefined;

function project(row: Row): ViewReading {
  const phase = phaseOf(row);
  return {
    viewId: row.viewId,
    status: row.status,
    reason: row.reason ?? null,
    done: Math.min(row.done, row.total),
    total: row.total,
    ...(phase ? { phase, found: row.found } : {}),
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
    const phase = phaseOf(row);
    const payload: ViewReadingChange = {
      viewId: row.viewId,
      status: row.status,
      reason: row.reason ?? null,
      done: Math.min(row.done, row.total),
      total: row.total,
      ...(phase ? { phase, found: row.found } : {}),
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

  /**
   * How many Threads the walk covers: the scope, at most its limit and the Setting; for
   * a search scope still finding its members, the Threads its other facts admit, at most
   * views.query.scan_max.
   */
  const totalOf = async (
    workspaceId: Id,
    view: View,
    s: ViewBackfillSettings,
    searching: boolean,
  ) => {
    const ctx = await options.context(workspaceId);
    const facts = searching ? memberFacts(view.doc.scope.facts) : view.doc.scope.facts;
    const cap = searching
      ? (s.queryScanMax ?? 20_000)
      : Math.min(view.doc.scope.limit, s.maxThreads);
    return countViewThreads(
      db,
      {
        workspaceId,
        since: scopeSince(facts, ctx.now, ctx.zone),
        scope: { facts, now: ctx.now, zone: ctx.zone },
        ...(facts.query ? { members: view.id } : {}),
      },
      cap,
    );
  };

  /** The stored ids of every question a View asks of its own: its Signals and Extractions. */
  const ownIds = (view: View) => [
    ...viewSignalDefs(view.doc).map((d) => d.id),
    ...viewExtractionDefs(view.doc).map((d) => d.id),
  ];

  /** Whether the walk may ask now: the AI level, the budget and a judge; the reason when not. */
  const mayAsk = async (
    workspaceId: Id,
    s: ViewBackfillSettings,
    waitMs: number,
  ): Promise<{ reason: "budget" | "no_judge" | "level"; ms: number } | null> => {
    if ((await level()) !== "automate") return { reason: "level", ms: waitMs };
    const budget = await backgroundBudget(db, workspaceId, s.budgetUsd, now());
    if (budget.over)
      return {
        reason: "budget",
        ms: Math.min(waitMs, budget.resumesAt.getTime() - now().getTime()),
      };
    if (!(await options.canAnswer())) return { reason: "no_judge", ms: waitMs };
    return null;
  };

  const wait = async (row: Row, reason: "budget" | "no_judge" | "level" | "locked", ms: number) => {
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
    const view = await store.get(viewId);
    if (!view || view.deletedAt || !view.pinned) {
      await patch(viewId, { status: "cancelled", reason: null, finishedAt: now() });
      return "done";
    }
    const facts = view.doc.scope.facts;
    const key = options.members ? memberKey(facts) : null;
    if (key !== (row.membersKey ?? null)) {
      // The View changed under the walk: its members are found again first.
      await api.ensure(workspaceId, viewId);
      return "again";
    }
    const searching = key !== null && !row.membersDone;
    const asks = row.signalIds.length > 0;
    const blocked = asks ? await mayAsk(workspaceId, s, waitMs) : null;
    // Asking waits for its judge, budget and level; finding members does not.
    if (!searching && blocked) return wait(row, blocked.reason, blocked.ms);
    if (row.status === "waiting") await patch(viewId, { status: "running", reason: null });
    const vctx = await options.context(workspaceId);
    const pageFacts = searching ? memberFacts(facts) : facts;
    const budgetAtStart = ctx?.remainingMs() ?? Number.POSITIVE_INFINITY;
    const outOfTime = () => (ctx ? ctx.remainingMs() < budgetAtStart / 2 : false);
    const memberCap = Math.min(view.doc.scope.limit, s.maxThreads);
    let canAsk = asks && !blocked;
    let current: Row = row;

    /** The end of a pass: a search becomes a walk of the members when it held questions. */
    const finish = async (at: Row): Promise<"done" | "again"> => {
      if (searching && asks && at.asksHeld) {
        const total = await totalOf(workspaceId, view, s, false);
        await patch(viewId, {
          membersDone: true,
          asksHeld: false,
          cursorAt: null,
          cursorId: null,
          done: 0,
          total,
          status: "running",
          reason: null,
        });
        return "again";
      }
      await patch(viewId, {
        ...(searching ? { membersDone: true, asksHeld: false } : {}),
        status: "done",
        reason: null,
        done: at.total,
        finishedAt: now(),
      });
      return "done";
    };

    for (;;) {
      if (current.done >= current.total) return finish(current);
      if (!searching && !asks) return finish(current);
      const page = await loadViewThreads(db, {
        workspaceId,
        owner: vctx.owner,
        since: scopeSince(pageFacts, vctx.now, vctx.zone),
        scope: { facts: pageFacts, now: vctx.now, zone: vctx.zone },
        // Once found, the members stand in for the query.
        ...(key !== null && !searching ? { members: viewId } : {}),
        before:
          current.cursorAt && current.cursorId
            ? { at: current.cursorAt, id: current.cursorId }
            : null,
        limit: Math.min(
          Math.max(1, searching ? (s.queryPageSize ?? 200) : s.pageSize),
          current.total - current.done,
        ),
      });
      if (page.length === 0) return finish(current);
      let matched: Set<Id> | null = null;
      if (searching && options.members) {
        try {
          matched = await options.members.matchPage(workspaceId, viewId, facts, page);
        } catch (error) {
          // No root key: nothing can be read to find the members.
          if (error instanceof LockedError) return wait(current, "locked", waitMs);
          throw error;
        }
      }
      const candidates = matched
        ? page.filter((t) => matched.has(t.id)).map((t) => ({ ...t, inQuery: true }))
        : page;
      let stop: "no_judge" | null = null;
      let asked = 0;
      let calls = 0;
      if (canAsk) {
        // One Thread per request, several at once; the limiter keeps background behind arrival.
        const results = await mapPool(candidates, s.concurrency, async (t) => {
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
      }
      const latest = await read(viewId);
      if (!latest || latest.runId !== runId) return "done";
      if (stop && !searching) return wait(latest, stop, waitMs);
      // Searching on while it may not ask: the members' questions wait for a walk of their own.
      if (stop) canAsk = false;
      const held = asks && !canAsk && candidates.length > 0;
      const last = page[page.length - 1];
      const next = await patch(viewId, {
        cursorAt: last ? new Date(last.lastActivity) : latest.cursorAt,
        cursorId: last?.id ?? latest.cursorId,
        done: latest.done + page.length,
        asked: latest.asked + asked,
        calls: latest.calls + calls,
        lastError: null,
        ...(matched ? { found: latest.found + matched.size } : {}),
        ...(held ? { asksHeld: true } : {}),
      });
      if (!next) return "done";
      // Paused or stopped while this page ran: its place is kept, nothing more is read.
      if (next.status !== "running") return "done";
      current = next;
      // As many members as the View reads: the search ends there.
      if (searching && current.found >= memberCap)
        return finish({ ...current, done: current.total });
      if (canAsk && (await backgroundBudget(db, workspaceId, s.budgetUsd, now())).over) {
        if (!searching) return wait(current, "budget", waitMs);
        canAsk = false;
      }
      if (outOfTime()) return "again";
    }
  };

  const api: ViewBackfills = {
    async status(viewId) {
      const row = await read(viewId);
      return row ? project(row) : null;
    },

    async request(workspaceId, viewId, wanted) {
      const s = await options.settings();
      // Off, a pinned View asks nothing of its own; a search scope still finds its members.
      const signalIds = s.enabled ? wanted : [];
      const view = await store.get(viewId);
      if (!view || view.deletedAt || !view.pinned) return api.status(viewId);
      const key = options.members ? memberKey(view.doc.scope.facts) : null;
      const existing = await read(viewId);
      // A new query (or new facts around it) finds its members from nothing.
      const fresh = key !== null && existing?.membersKey !== key;
      if (signalIds.length === 0 && !fresh) return api.status(viewId);
      if (fresh) await options.members?.reset(workspaceId, viewId);
      const membersDone = key !== null && !fresh && (existing?.membersDone ?? false);
      const searching = key !== null && !membersDone;
      const total = await totalOf(workspaceId, view, s, searching);
      const members = {
        membersKey: key,
        membersDone,
        found: fresh ? 0 : (existing?.found ?? 0),
        asksHeld: false,
      };
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
          ...members,
          ...(fresh ? { status: "running" as const, reason: null } : {}),
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
        ...members,
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

    async ensure(workspaceId, viewId) {
      if (!options.members) return;
      const view = await store.get(viewId);
      if (!view || view.deletedAt || !view.pinned) return;
      const key = memberKey(view.doc.scope.facts);
      const row = await read(viewId);
      if (key === null) {
        // The query went: its members go with it, and the View reads its facts again.
        if (row?.membersKey) {
          await options.members.reset(workspaceId, viewId);
          await patch(viewId, { membersKey: null, membersDone: false, found: 0 });
        }
        return;
      }
      if (row?.membersKey === key) return;
      await api.request(workspaceId, viewId, ownIds(view));
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
          const s = await options.settings();
          const sleepMs = Math.max(1, s.waitSeconds) * 1000;
          // No root key: the View itself is sealed, so the walk waits for an unlock and says so.
          if (error instanceof LockedError) {
            const row = await read(job.payload.viewId);
            if (row && row.runId === job.payload.runId && row.status === "running")
              return wait(row, "locked", sleepMs);
            return { sleepMs };
          }
          const message = error instanceof Error ? error.message : String(error);
          log(`view reading ${job.payload.viewId}: ${message}`);
          await patch(job.payload.viewId, { lastError: message.slice(0, 500) }, false);
          return { sleepMs };
        }
      });
    },
  };
  return api;
}
