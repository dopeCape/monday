// The Meter (ADR 0007): the per-Workspace record of tokens and estimated cost
// for every Hosted call, by Task and provider. Meter only: it records and
// sums, never budgets or stops.

import type { MeterEntry, MeterLine, MeterMonth } from "@monday/shared";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { meter } from "../db/schema.ts";
import type { MeterInput } from "./runtime/index.ts";

export interface Meter {
  record(entry: MeterInput): Promise<MeterEntry>;
  /** One month, "YYYY-MM" in UTC, grouped by Task and provider. */
  month(workspaceId: string, month: string): Promise<MeterMonth>;
}

export interface MeterOptions {
  now?: () => Date;
}

/** "YYYY-MM" of a moment, in UTC. */
export function monthOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** The UTC bounds of a month: inclusive start, exclusive end. */
export function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export function createMeter(db: Db, options: MeterOptions = {}): Meter {
  const now = options.now ?? (() => new Date());
  return {
    async record(entry) {
      const id = crypto.randomUUID();
      const createdAt = now();
      await db.insert(meter).values({ id, ...entry, createdAt });
      return { id, createdAt: createdAt.toISOString(), ...entry };
    },

    async month(workspaceId, month) {
      const { start, end } = monthBounds(month);
      const rows = await db
        .select({
          task: meter.task,
          provider: meter.provider,
          calls: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${meter.inputTokens}), 0)::bigint`,
          outputTokens: sql<number>`coalesce(sum(${meter.outputTokens}), 0)::bigint`,
          cachedTokens: sql<number>`coalesce(sum(${meter.cachedTokens}), 0)::bigint`,
          costMicros: sql<number>`coalesce(sum(${meter.costMicros}), 0)::bigint`,
        })
        .from(meter)
        .where(
          and(
            eq(meter.workspaceId, workspaceId),
            gte(meter.createdAt, start),
            lt(meter.createdAt, end),
          ),
        )
        .groupBy(meter.task, meter.provider)
        .orderBy(meter.task, meter.provider);
      const lines: MeterLine[] = rows.map((r) => ({
        task: r.task,
        provider: r.provider,
        calls: Number(r.calls),
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
        cachedTokens: Number(r.cachedTokens),
        costMicros: Number(r.costMicros),
      }));
      return {
        workspaceId,
        month,
        lines,
        costMicros: lines.reduce((sum, l) => sum + l.costMicros, 0),
      };
    },
  };
}
