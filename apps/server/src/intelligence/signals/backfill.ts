// The Signal backfill (docs/spec/signals.md, "Backfill"; ADR 0005; slice
// 31): when a Signal is created or gets a new Question version, or the judge
// model changes, the signals-backfill Job walks signals.backfill.scope newest
// first and asks each Thread only the Signals it lacks at their current
// version, one Thread per request, under the limiter and the monthly
// background budget. One walk per Workspace in signal_backfills (the cursor
// shape of routing_backlogs), so a restart resumes; a second change while one
// runs widens the running walk instead of starting another. Above
// signals.backfill.confirm_above Threads it waits for the owner's yes, with
// the count and an estimate from the recent average tokens per Thread.

import type { AiLevel, Id, SignalBackfill } from "@monday/shared";
import { formatSortScope, parseSortScope } from "@monday/shared";
import { eq } from "drizzle-orm";
import { LockedError } from "../../crypto/keys.ts";
import type { Db } from "../../db/client.ts";
import { signalBackfills } from "../../db/schema.ts";
import type { Job, Jobs } from "../../jobs/index.ts";
import { NotFoundError } from "../../mailstore/index.ts";
import {
  type Cursor,
  countInScope,
  newestInScope,
  pageInScope,
  resolveScope,
} from "../routing/scope-query.ts";
import { AiOffError, NoJudgeError } from "../runtime/index.ts";
import { averageTokensPerThread, backgroundBudget, estimateMicros } from "./budget.ts";
import type { Signals } from "./index.ts";

export const SIGNALS_BACKFILL_STEP = "signals-backfill";

export interface SignalBackfillPayload {
  workspaceId: Id;
  runId: string;
}

export interface SignalBackfillSettings {
  /** signals.backfill.scope */
  scope: string;
  /** signals.backfill.concurrency */
  concurrency: number;
  /** signals.backfill.confirm_above */
  confirmAbove: number;
  /** signals.budget.background_monthly_usd */
  budgetUsd: number;
  /** routing.wait_seconds: how long a waiting walk sleeps before it looks again. */
  waitSeconds: number;
  /** TypeSafe's price for the judge model, USD per million input tokens. */
  usdPerMillion: number;
  /** The tokens a Thread is assumed to take before any has been metered. */
  tokensPerThread: number;
}

export interface SignalBackfills {
  status(workspaceId: Id): Promise<SignalBackfill | null>;
  /** Starts a walk for these Signals, or widens the one running; asks first above the threshold. */
  request(workspaceId: Id, signalIds: readonly string[]): Promise<SignalBackfill | null>;
  /** The owner said yes to a walk waiting for confirmation. */
  confirm(workspaceId: Id): Promise<SignalBackfill | null>;
  pause(workspaceId: Id): Promise<SignalBackfill | null>;
  resume(workspaceId: Id): Promise<SignalBackfill | null>;
  cancel(workspaceId: Id): Promise<SignalBackfill | null>;
  registerSteps(jobs: Jobs): void;
}

export interface SignalBackfillOptions {
  db: Db;
  signals: Signals;
  settings: () => Promise<SignalBackfillSettings>;
  /** Whether anything can answer now (TypeSafe, or the language model the fallback allows). */
  canAnswer: () => Promise<boolean>;
  level?: () => Promise<AiLevel>;
  now?: () => Date;
  log?: (message: string) => void;
}

type Row = typeof signalBackfills.$inferSelect;

export const backfillJobId = (workspaceId: Id, runId: string) =>
  `${SIGNALS_BACKFILL_STEP}:${workspaceId}:${runId}`;

function project(
  row: Row,
  budget: { spentMicros: number; budgetMicros: number } | null,
): SignalBackfill {
  return {
    workspaceId: row.workspaceId,
    status: row.status,
    reason: row.reason ?? null,
    signals: row.signalIds,
    scope: row.scope,
    done: row.done,
    total: Math.max(row.total, row.done),
    asked: row.asked,
    calls: row.calls,
    estimate:
      row.estimateThreads !== null
        ? { threads: row.estimateThreads, costMicros: row.estimateMicros ?? 0 }
        : null,
    budget: budget ? { spentMicros: budget.spentMicros, budgetMicros: budget.budgetMicros } : null,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    lastError: row.lastError ?? null,
  };
}

async function inPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export function createSignalBackfills(options: SignalBackfillOptions): SignalBackfills {
  const { db, signals } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const level = options.level ?? (async (): Promise<AiLevel> => "automate");
  let jobs: Jobs | null = null;

  const read = async (workspaceId: Id): Promise<Row | null> =>
    (await db.query.signalBackfills.findFirst({
      where: eq(signalBackfills.workspaceId, workspaceId),
    })) ?? null;

  const patch = async (workspaceId: Id, values: Partial<Row>): Promise<Row | null> => {
    const [row] = await db
      .update(signalBackfills)
      .set({ ...values, updatedAt: now() })
      .where(eq(signalBackfills.workspaceId, workspaceId))
      .returning();
    return row ?? null;
  };

  const budgetOf = async (workspaceId: Id) => {
    const s = await options.settings();
    return backgroundBudget(db, workspaceId, s.budgetUsd, now());
  };

  const view = async (row: Row | null) =>
    row ? project(row, await budgetOf(row.workspaceId)) : null;

  const enqueue = async (workspaceId: Id, runId: string) => {
    if (!jobs) return;
    const payload: SignalBackfillPayload = { workspaceId, runId };
    await jobs.enqueue(SIGNALS_BACKFILL_STEP, payload, { id: backfillJobId(workspaceId, runId) });
  };

  /** The Threads the scope holds and what reading them would cost now. */
  const estimate = async (workspaceId: Id, s: SignalBackfillSettings) => {
    const scope = parseSortScope(s.scope) ?? {
      kind: "last" as const,
      amount: 3,
      unit: "months" as const,
    };
    const resolved = resolveScope(scope, now());
    const total = await countInScope(db, workspaceId, resolved);
    const tokens = (await averageTokensPerThread(db, workspaceId)) ?? s.tokensPerThread;
    return { scope, resolved, total, costMicros: estimateMicros(total, tokens, s.usdPerMillion) };
  };

  const wait = async (row: Row, reason: "budget" | "no_judge" | "level", ms: number) => {
    await patch(row.workspaceId, { status: "waiting", reason });
    return { sleepMs: Math.max(1000, ms) };
  };

  const step = async (
    job: Job<SignalBackfillPayload>,
  ): Promise<"done" | "again" | { sleepMs: number }> => {
    const { workspaceId, runId } = job.payload;
    const row = await read(workspaceId);
    if (!row || row.runId !== runId) return "done";
    if (row.status !== "running" && row.status !== "waiting") return "done";
    const s = await options.settings();
    const waitMs = Math.max(1, s.waitSeconds) * 1000;
    if ((await level()) !== "automate") return wait(row, "level", waitMs);
    const budget = await budgetOf(workspaceId);
    if (budget.over) {
      // Paused with the reason; it looks again in a while (a raised budget) and at the new month.
      return wait(row, "budget", Math.min(waitMs, budget.resumesAt.getTime() - now().getTime()));
    }
    if (!(await options.canAnswer())) return wait(row, "no_judge", waitMs);
    const resolved = { since: row.since, limit: row.limit };
    const cursor: Cursor | null =
      row.cursorAt && row.cursorId ? { at: row.cursorAt, id: row.cursorId } : null;
    const top: Cursor | null = row.topAt && row.topId ? { at: row.topAt, id: row.topId } : null;
    const remaining =
      row.limit === null ? Number.POSITIVE_INFINITY : Math.max(0, row.limit - row.walked);
    const round = Math.max(1, s.concurrency) * 4;
    const page =
      remaining > 0 && (cursor || top)
        ? await pageInScope(db, workspaceId, resolved, {
            limit: Math.min(round, remaining),
            below: cursor,
            atOrBelow: cursor ? null : top,
          })
        : [];
    if (page.length === 0) {
      await patch(workspaceId, { status: "done", reason: null, finishedAt: now() });
      return "done";
    }
    let asked = 0;
    let calls = 0;
    let stop: "no_judge" | null = null;
    await inPool(page, s.concurrency, async (t) => {
      if (stop) return;
      try {
        const r = await signals.ask(workspaceId, t.id, {
          reason: "background",
          only: row.signalIds,
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
    const current = await read(workspaceId);
    if (!current || current.runId !== runId) return "done";
    if (stop) return wait(current, stop, waitMs);
    const last = page[page.length - 1];
    const keep = current.status === "paused" || current.status === "cancelled";
    await patch(workspaceId, {
      status: keep ? current.status : "running",
      reason: keep ? current.reason : null,
      cursorAt: last?.lastActivity ?? current.cursorAt,
      cursorId: last?.id ?? current.cursorId,
      walked: current.walked + page.length,
      done: current.done + page.length,
      asked: current.asked + asked,
      calls: current.calls + calls,
      lastError: null,
    });
    return keep ? "done" : "again";
  };

  const api: SignalBackfills = {
    status: async (workspaceId) => view(await read(workspaceId)),

    async request(workspaceId, signalIds) {
      if (signalIds.length === 0) return view(await read(workspaceId));
      const s = await options.settings();
      const existing = await read(workspaceId);
      const at = now();
      const { scope, resolved, total, costMicros } = await estimate(workspaceId, s);
      const top = await newestInScope(db, workspaceId, { since: null, limit: null });
      if (existing && ["running", "waiting", "confirm", "paused"].includes(existing.status)) {
        // Widen the walk: the new Signals join, and it goes over the scope again from the top;
        // Threads that already have every answer cost nothing.
        const ids = [...new Set([...existing.signalIds, ...signalIds])];
        const row = await patch(workspaceId, {
          signalIds: ids,
          topAt: top?.at ?? null,
          topId: top?.id ?? null,
          cursorAt: null,
          cursorId: null,
          walked: 0,
          total,
          estimateThreads: total,
          estimateMicros: costMicros,
        });
        return view(row);
      }
      const confirm = total > s.confirmAbove;
      const runId = crypto.randomUUID();
      const values = {
        workspaceId,
        runId,
        status: (confirm ? "confirm" : "running") as Row["status"],
        reason: null,
        signalIds: [...new Set(signalIds)],
        scope: formatSortScope(scope),
        since: resolved.since,
        limit: resolved.limit,
        topAt: top?.at ?? null,
        topId: top?.id ?? null,
        cursorAt: null,
        cursorId: null,
        walked: 0,
        done: 0,
        total,
        asked: 0,
        calls: 0,
        estimateThreads: total,
        estimateMicros: costMicros,
        lastError: null,
        startedAt: at,
        updatedAt: at,
        finishedAt: null,
      };
      const [row] = await db
        .insert(signalBackfills)
        .values(values)
        .onConflictDoUpdate({ target: signalBackfills.workspaceId, set: values })
        .returning();
      if (!row) return null;
      if (!confirm) await enqueue(workspaceId, runId);
      return view(row);
    },

    async confirm(workspaceId) {
      const row = await read(workspaceId);
      if (row?.status !== "confirm") return view(row);
      const runId = crypto.randomUUID();
      const next = await patch(workspaceId, { status: "running", reason: null, runId });
      await enqueue(workspaceId, runId);
      return view(next);
    },

    async pause(workspaceId) {
      const row = await read(workspaceId);
      if (!row || (row.status !== "running" && row.status !== "waiting")) return view(row);
      return view(await patch(workspaceId, { status: "paused" }));
    },

    async resume(workspaceId) {
      const row = await read(workspaceId);
      if (!row || (row.status !== "paused" && row.status !== "waiting")) return view(row);
      const runId = crypto.randomUUID();
      const next = await patch(workspaceId, { status: "running", reason: null, runId });
      await enqueue(workspaceId, runId);
      return view(next);
    },

    async cancel(workspaceId) {
      const row = await read(workspaceId);
      if (!row || row.status === "done" || row.status === "cancelled") return view(row);
      return view(
        await patch(workspaceId, { status: "cancelled", reason: null, finishedAt: now() }),
      );
    },

    registerSteps(target) {
      jobs = target;
      target.registerStep<SignalBackfillPayload>(SIGNALS_BACKFILL_STEP, async (job, ctx) => {
        await ctx.extend();
        try {
          return await step(job);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`signals backfill ${job.payload.workspaceId}: ${message}`);
          await patch(job.payload.workspaceId, { lastError: message.slice(0, 500) });
          const s = await options.settings();
          return { sleepMs: Math.max(1, s.waitSeconds) * 1000 };
        }
      });
    },
  };
  return api;
}
