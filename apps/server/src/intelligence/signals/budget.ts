// The monthly background budget (docs/spec/signals.md, "Budget and rate";
// slice 31): what background walks (Signal backfills, the Backlog sort) spent
// on the judge this calendar month, from the Meter's estimates, against
// signals.budget.background_monthly_usd. Arrival requests are never capped.
// And the estimate a large backfill shows before it runs.

import type { Id, JudgeTask } from "@monday/shared";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { meter } from "../../db/schema.ts";

/** The judge tasks background walks are metered under. */
export const BACKGROUND_TASKS: readonly JudgeTask[] = ["judge.backfill", "judge.backlog"];

/** The Signal requests whose tokens make a Thread's average. */
const SIGNAL_TASKS: readonly JudgeTask[] = ["judge.signals", "judge.backfill", "judge.backlog"];

/** The first moment of the next calendar month, UTC. */
export function nextMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

const monthStart = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));

export interface BudgetState {
  spentMicros: number;
  budgetMicros: number;
  over: boolean;
  /** When the budget starts again. */
  resumesAt: Date;
}

/** This month's background spending against the budget. */
export async function backgroundBudget(
  db: Db,
  workspaceId: Id,
  budgetUsd: number,
  at: Date,
): Promise<BudgetState> {
  const [row] = await db
    .select({ micros: sql<number>`coalesce(sum(${meter.costMicros}), 0)::bigint` })
    .from(meter)
    .where(
      and(
        eq(meter.workspaceId, workspaceId),
        inArray(meter.task, [...BACKGROUND_TASKS]),
        gte(meter.createdAt, monthStart(at)),
        lt(meter.createdAt, nextMonth(at)),
      ),
    );
  const spentMicros = Number(row?.micros ?? 0);
  const budgetMicros = Math.round(Math.max(0, budgetUsd) * 1_000_000);
  return { spentMicros, budgetMicros, over: spentMicros >= budgetMicros, resumesAt: nextMonth(at) };
}

/** The recent average input tokens of one Thread's Signal request, or null with none metered yet. */
export async function averageTokensPerThread(
  db: Db,
  workspaceId: Id,
  window = 200,
): Promise<number | null> {
  const rows = await db
    .select({ tokens: meter.inputTokens })
    .from(meter)
    .where(and(eq(meter.workspaceId, workspaceId), inArray(meter.task, [...SIGNAL_TASKS])))
    .orderBy(desc(meter.createdAt))
    .limit(window);
  if (rows.length === 0) return null;
  return Math.round(rows.reduce((n, r) => n + Number(r.tokens), 0) / rows.length);
}

/** What reading `threads` Threads costs at `usdPerMillion` input tokens, in micro-dollars. */
export function estimateMicros(
  threads: number,
  tokensPerThread: number,
  usdPerMillion: number,
): number {
  return Math.round(threads * tokensPerThread * usdPerMillion);
}
