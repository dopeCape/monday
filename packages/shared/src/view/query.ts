// Queries (docs/spec/views.md, "Queries"): code only. The Threads in a
// View's scope, placed in their Lanes, become rows; a Block's query keeps
// the rows its `where` holds on (three-valued: an unknown row is counted as
// Unsure, never dropped silently or guessed in), merges the rows sharing a
// dedupe value, groups them by a Field or a time bucket in the Workspace's
// zone, adds them up (money per currency, never converted), sorts and caps
// them. Pure and runtime-neutral: the Device draws every Block from this,
// the Server draws the card's preview from it.

import { utcToZoned } from "../calendar.ts";
import {
  evaluateLaneCondition,
  type LanePlacement,
  type LaneView,
  laneView,
  OTHERS_LANE,
  placeThread,
  scopeAdmits,
  type ViewContext,
  type ViewThread,
  validZone,
} from "./core.ts";
import { type FieldValue, keyOf, numeric, readField } from "./fields.ts";
import type {
  AggregateOp,
  ExtractedValue,
  GroupBy,
  TimeBucket,
  ViewDoc,
  ViewPlacement,
  ViewQuery,
  ViewSort,
} from "./types.ts";

/** One row of a Block: a Thread (or several merged by dedupe) and its Lane. */
export interface ViewRow<T extends ViewThread = ViewThread> {
  /** The newest Thread, carrying the merged answers when the row merges several. */
  thread: T;
  /** Every Thread in the row, newest first. */
  threads: readonly T[];
  /** Its Lane: a Lane id, `unsure`, `others`, or null in a View with no Lanes. */
  lane: string | null;
  placement: LanePlacement | null;
}

/** An aggregate over rows: a number, or money in its main currency with the others beside it. */
export interface Aggregate {
  op: AggregateOp;
  value: number | null;
  /** Set when the Field is money: the currency most rows use. */
  currency: string | null;
  /** Sums in the other currencies, never converted. */
  others: Array<{ currency: string; value: number }>;
  /** Rows counted (count), or rows with a value (the rest). */
  count: number;
  /** Rows whose value was Unsure or not read yet, left out. */
  unsure: number;
}

export interface QueryGroup<T extends ViewThread = ViewThread> {
  key: string;
  label: string;
  rows: ViewRow<T>[];
  value: Aggregate;
  /** A second grouping inside this one (the stacks of a stacked bar), in the same order everywhere. */
  series: Array<{ key: string; label: string; value: Aggregate }>;
}

export interface QueryResult<T extends ViewThread = ViewThread> {
  /** The rows kept, sorted and capped. */
  rows: ViewRow<T>[];
  /** Rows the `where` could not decide. */
  unsure: ViewRow<T>[];
  /** Rows kept before the cap. */
  total: number;
  groups: QueryGroup<T>[] | null;
  /** The aggregate over every kept row (for a stat: the current period only). */
  value: Aggregate | null;
  /** The same over the previous period, for a stat's comparison. */
  previous: Aggregate | null;
}

/** The View's Threads, placed: what every Block's query starts from. */
export interface ViewBase<T extends ViewThread = ViewThread> {
  doc: ViewDoc;
  ctx: ViewContext;
  /** Every Thread in scope, newest first, with its Lane; hidden `others` left out. */
  rows: ViewRow<T>[];
  lanes: LaneView<T>;
}

export interface BaseOptions {
  previous?: ReadonlyMap<string, string> | undefined;
  placements?: Readonly<Record<string, ViewPlacement>> | undefined;
  unsureLabel?: string | undefined;
  othersLabel?: string | undefined;
  sort?: ViewSort | undefined;
}

/** Places every Thread in scope once; each Block's query reads the result. */
export function viewBase<T extends ViewThread>(
  doc: ViewDoc,
  threads: readonly T[],
  ctx: ViewContext,
  options: BaseOptions = {},
): ViewBase<T> {
  const lanes = laneView(doc, threads, ctx, options);
  const hasLanes = doc.lanes.length > 0;
  const rows: ViewRow<T>[] = [];
  for (const column of lanes.lanes) {
    for (const r of column.rows) {
      rows.push({
        thread: r.thread,
        threads: [r.thread],
        lane: hasLanes ? r.placement.lane : null,
        placement: hasLanes ? r.placement : null,
      });
    }
  }
  const at = (r: ViewRow<T>) => Date.parse(r.thread.lastActivity) || 0;
  rows.sort((a, b) => at(b) - at(a));
  return { doc, ctx, rows, lanes };
}

/* ------------------------------ Dedupe ------------------------------ */

/**
 * Threads merged into one row, newest first: the newest Thread's row with
 * each answer, value and Fact taken from the newest Thread that has it
 * (the total from the confirmation, the status from the delivery notice).
 */
export function mergeThreads<T extends ViewThread>(threads: readonly T[]): T {
  const [newest] = threads;
  if (!newest) throw new RangeError("nothing to merge");
  if (threads.length === 1) return newest;
  const readings: Record<string, (typeof newest.readings)[string]> = {};
  const values: Record<string, ExtractedValue> = {};
  const facts: Record<string, unknown> = {};
  for (const t of [...threads].reverse()) {
    for (const [k, v] of Object.entries(t.facts ?? {}))
      if (v !== null && v !== undefined) facts[k] = v;
    for (const [k, v] of Object.entries(t.values ?? {})) values[k] = v;
  }
  for (const t of threads) {
    for (const [k, r] of Object.entries(t.readings)) {
      if (readings[k]) continue;
      // An Extraction's answer comes from the Thread whose value is kept.
      if (values[k] && !t.values?.[k]) continue;
      if (r.choice === "none" && threads.some((o) => o.values?.[k])) continue;
      readings[k] = r;
    }
  }
  return {
    ...newest,
    readings,
    values,
    facts: newest.facts || Object.keys(facts).length ? facts : null,
    merged: threads.map((t) => t.id),
  };
}

function dedupe<T extends ViewThread>(
  base: ViewBase<T>,
  rows: readonly ViewRow<T>[],
  ref: string,
): ViewRow<T>[] {
  const { doc, ctx } = base;
  const byKey = new Map<string, ViewRow<T>[]>();
  const out: Array<ViewRow<T> | string> = [];
  for (const r of rows) {
    const key = keyOf(readField(doc, r.thread, ref, ctx, r.lane));
    if (key === null) {
      out.push(r);
      continue;
    }
    const list = byKey.get(key);
    if (list) list.push(r);
    else {
      byKey.set(key, [r]);
      out.push(key);
    }
  }
  const hasLanes = doc.lanes.length > 0;
  return out.map((entry) => {
    if (typeof entry !== "string") return entry;
    const group = byKey.get(entry) ?? [];
    if (group.length === 1) return group[0] as ViewRow<T>;
    const threads = group.map((g) => g.thread);
    const merged = mergeThreads(threads);
    const placement = hasLanes ? placeThread(doc, merged, ctx) : null;
    return { thread: merged, threads, lane: placement?.lane ?? null, placement };
  });
}

/* ------------------------------ Time buckets ------------------------------ */

const DAY = 86_400_000;
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
}

/** A date's calendar parts in the zone; a bare `YYYY-MM-DD` is that day. */
function partsOf(value: string, zone: string): Parts | null {
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) return { y: Number(plain[1]), mo: Number(plain[2]), d: Number(plain[3]), h: 12 };
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  if (validZone(zone)) {
    const z = utcToZoned(zone, at);
    return { y: z.y, mo: z.mo, d: z.d, h: z.h };
  }
  return { y: at.getFullYear(), mo: at.getMonth() + 1, d: at.getDate(), h: at.getHours() };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const dayKey = (p: { y: number; mo: number; d: number }) => `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
const weekdayOf = (p: Parts) => (new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() + 6) % 7;

function addDays(p: { y: number; mo: number; d: number }, n: number) {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d) + n * DAY);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: 12 };
}

/** The bucket a date falls in: `2026-10-03`, the week's Monday, `2026-10`, `2026`, a weekday `0` (Monday) to `6`, an hour `00` to `23`. */
export function bucketKey(value: string, bucket: TimeBucket, zone: string): string | null {
  const p = partsOf(value, zone);
  if (!p) return null;
  switch (bucket) {
    case "day":
      return dayKey(p);
    case "week":
      return dayKey(addDays(p, -weekdayOf(p)));
    case "month":
      return `${p.y}-${pad(p.mo)}`;
    case "year":
      return String(p.y);
    case "weekday":
      return String(weekdayOf(p));
    case "hour":
      return pad(p.h);
  }
}

/** The bucket before this one (the previous period of a stat). */
export function previousBucket(key: string, bucket: TimeBucket): string {
  if (bucket === "year") return String(Number(key) - 1);
  if (bucket === "month") {
    const [y, mo] = key.split("-").map(Number) as [number, number];
    return mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`;
  }
  const [y, mo, d] = key.split("-").map(Number) as [number, number, number];
  return dayKey(addDays({ y, mo, d }, bucket === "week" ? -7 : -1));
}

function nextBucket(key: string, bucket: TimeBucket): string {
  if (bucket === "year") return String(Number(key) + 1);
  if (bucket === "month") {
    const [y, mo] = key.split("-").map(Number) as [number, number];
    return mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
  }
  const [y, mo, d] = key.split("-").map(Number) as [number, number, number];
  return dayKey(addDays({ y, mo, d }, bucket === "week" ? 7 : 1));
}

/** A bucket in words: "Oct 3", "Oct", "Oct 2025", "2026", "Mon", "09:00". */
export function bucketLabel(key: string, bucket: TimeBucket, withYear = false): string {
  switch (bucket) {
    case "year":
      return key;
    case "weekday":
      return WEEKDAY_LABELS[Number(key)] ?? key;
    case "hour":
      return `${key}:00`;
    case "month": {
      const [y, mo] = key.split("-").map(Number) as [number, number];
      return withYear ? `${MONTH_LABELS[mo - 1]} ${y}` : (MONTH_LABELS[mo - 1] ?? key);
    }
    default: {
      const [y, mo, d] = key.split("-").map(Number) as [number, number, number];
      return `${MONTH_LABELS[mo - 1]} ${d}${withYear ? ` ${y}` : ""}`;
    }
  }
}

/* ------------------------------ Aggregates ------------------------------ */

/** Adds up rows: a count, or a sum, average, minimum or maximum of a Field (money per currency). */
export function aggregate<T extends ViewThread>(
  base: Pick<ViewBase<T>, "doc" | "ctx">,
  rows: readonly ViewRow<T>[],
  spec: { op: AggregateOp; field?: string | undefined } | undefined,
): Aggregate {
  const op = spec?.op ?? "count";
  const empty: Aggregate = { op, value: null, currency: null, others: [], count: 0, unsure: 0 };
  if (op === "count" || !spec?.field) {
    return { ...empty, op: "count", value: rows.length, count: rows.length };
  }
  const byCurrency = new Map<string, number[]>();
  const plain: number[] = [];
  let unsure = 0;
  let money = false;
  for (const r of rows) {
    const v = readField(base.doc, r.thread, spec.field, base.ctx, r.lane);
    if (v.state === "unsure" || v.state === "not_read") {
      unsure += 1;
      continue;
    }
    if (v.state !== "value") continue;
    const x = v.value;
    if (x && typeof x === "object" && "currency" in x) {
      money = true;
      const list = byCurrency.get(x.currency) ?? [];
      list.push(x.value);
      byCurrency.set(x.currency, list);
      continue;
    }
    const n = numeric(v);
    if (n !== null) plain.push(n);
  }
  const reduce = (list: number[]): number | null => {
    if (list.length === 0) return null;
    switch (op) {
      case "sum":
        return round(list.reduce((a, b) => a + b, 0));
      case "avg":
        return round(list.reduce((a, b) => a + b, 0) / list.length);
      case "min":
        return Math.min(...list);
      case "max":
        return Math.max(...list);
    }
  };
  if (!money) return { ...empty, value: reduce(plain), count: plain.length, unsure };
  const ranked = [...byCurrency.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const [main, ...rest] = ranked;
  return {
    op,
    value: main ? reduce(main[1]) : null,
    currency: main?.[0] ?? null,
    others: rest.map(([currency, list]) => ({ currency, value: reduce(list) ?? 0 })),
    count: ranked.reduce((n, [, l]) => n + l.length, 0),
    unsure,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------ Grouping and sorting ------------------------------ */

interface GroupKey {
  key: string;
  label: string;
}

/** Where a row goes when grouped by a Field; null when its value is Unsure or not read (counted, not placed). */
function groupKeyOf<T extends ViewThread>(
  base: ViewBase<T>,
  row: ViewRow<T>,
  by: GroupBy,
  laneLabel: (id: string) => string,
  noneLabel: string,
): GroupKey | null | "unsure" {
  const v = readField(base.doc, row.thread, by.field, base.ctx, row.lane, laneLabel);
  if (v.state === "unsure" || v.state === "not_read") return "unsure";
  if (v.state === "empty") return { key: "_none", label: noneLabel };
  if (by.bucket) {
    const raw = typeof v.value === "string" ? v.value : null;
    const key = raw ? bucketKey(raw, by.bucket, base.ctx.zone) : null;
    return key ? { key, label: key } : null;
  }
  const key = keyOf(v);
  if (key === null) return null;
  return { key, label: v.type === "lane" ? laneLabel(String(v.value)) : v.text };
}

function sortValue<T extends ViewThread>(base: ViewBase<T>, row: ViewRow<T>, by: string) {
  const v = readField(base.doc, row.thread, by, base.ctx, row.lane);
  const n = numeric(v);
  return { v, n, text: v.state === "value" ? v.text.toLowerCase() : "" };
}

/** Rows by a Field: numbers, money and dates by value, text alphabetically; empty and Unsure last. */
export function sortRowsBy<T extends ViewThread>(
  base: ViewBase<T>,
  rows: readonly ViewRow<T>[],
  by: string,
  dir: "asc" | "desc" = "asc",
): ViewRow<T>[] {
  const keyed = rows.map((r) => ({ r, s: sortValue(base, r, by) }));
  const rank = (v: FieldValue) => (v.state === "value" ? 0 : v.state === "empty" ? 1 : 2);
  keyed.sort((a, b) => {
    const ra = rank(a.s.v);
    const rb = rank(b.s.v);
    if (ra !== rb) return ra - rb;
    let c = 0;
    if (a.s.n !== null && b.s.n !== null) c = a.s.n - b.s.n;
    else c = a.s.text.localeCompare(b.s.text);
    if (c === 0)
      c = (Date.parse(b.r.thread.lastActivity) || 0) - (Date.parse(a.r.thread.lastActivity) || 0);
    else if (dir === "desc") c = -c;
    return c;
  });
  return keyed.map((k) => k.r);
}

/** A Board's old sort names as a Field sort. */
export function legacySort(sort: ViewSort | undefined): { by: string; dir: "asc" | "desc" } | null {
  if (sort === "newest_first") return { by: "last_activity_at", dir: "desc" };
  if (sort === "oldest_first") return { by: "last_activity_at", dir: "asc" };
  if (sort === "deadline_first") return { by: "deadline_at", dir: "asc" };
  return null;
}

export interface QueryOptions {
  /** The grouping when the query names none (a list's own `group_by`, a chart's). */
  groupBy?: GroupBy | undefined;
  /** A second grouping inside each group (a stacked bar's series). */
  series?: GroupBy | undefined;
  /** Groups past this fold into one "Other" group. */
  maxGroups?: number | undefined;
  /** The most rows (views.query.max_rows) when the query names no limit. */
  maxRows?: number | undefined;
  /** How a Lane id reads. */
  laneLabel?: ((id: string) => string) | undefined;
  /** Words for the group of rows with no value, and for the folded groups. */
  none?: string | undefined;
  other?: string | undefined;
  /** A Board's old sort, when the query names none. */
  sort?: ViewSort | undefined;
}

/**
 * One Block's query over the View's rows: dedupe, then the three-valued
 * `where` and the Lane filter, then the period, groups, aggregates, sort
 * and cap.
 */
export function runQuery<T extends ViewThread>(
  base: ViewBase<T>,
  query: ViewQuery | undefined,
  options: QueryOptions = {},
): QueryResult<T> {
  const { doc, ctx } = base;
  const q = query ?? {};
  const laneLabel =
    options.laneLabel ?? ((id: string) => doc.lanes.find((l) => l.id === id)?.label ?? id);
  const hideOthers = doc.lanes.length > 0 && doc.others === "hide";
  let rows = base.rows.filter((r) => !(hideOthers && r.lane === OTHERS_LANE));
  if (q.dedupe) rows = dedupe(base, rows, q.dedupe);
  const unsure: ViewRow<T>[] = [];
  if (q.where) {
    const kept: ViewRow<T>[] = [];
    for (const r of rows) {
      const v = evaluateLaneCondition(q.where, doc, r.thread, ctx, 0, {
        notRead: false,
        lane: r.lane,
      });
      if (v === true) kept.push(r);
      else if (v === null) unsure.push(r);
    }
    rows = kept;
  }
  if (q.lanes) rows = rows.filter((r) => r.lane !== null && q.lanes?.includes(r.lane));

  let previous: Aggregate | null = null;
  if (q.period) {
    const { field, bucket } = q.period;
    const nowKey = bucketKey(ctx.now.toISOString(), bucket, ctx.zone);
    const before = nowKey ? previousBucket(nowKey, bucket) : null;
    const keyOfRow = (r: ViewRow<T>) => {
      const v = readField(doc, r.thread, field, ctx, r.lane);
      return v.state === "value" && typeof v.value === "string"
        ? bucketKey(v.value, bucket, ctx.zone)
        : null;
    };
    const keyed = rows.map((r) => ({ r, k: keyOfRow(r) }));
    previous = aggregate(
      base,
      keyed.filter((x) => x.k === before).map((x) => x.r),
      q.aggregate,
    );
    rows = keyed.filter((x) => x.k === nowKey).map((x) => x.r);
  }

  const by = q.group_by ?? options.groupBy;
  let groups: QueryGroup<T>[] | null = null;
  if (by) {
    const map = new Map<string, QueryGroup<T>>();
    for (const r of rows) {
      const g = groupKeyOf(base, r, by, laneLabel, options.none ?? "None");
      if (g === "unsure") {
        unsure.push(r);
        continue;
      }
      if (!g) continue;
      const found = map.get(g.key);
      if (found) found.rows.push(r);
      else map.set(g.key, { key: g.key, label: g.label, rows: [r], value: EMPTY_AGG, series: [] });
    }
    // Time buckets between the first and the last show as zero, so a chart has no gaps.
    if (by.bucket && ["day", "week", "month", "year"].includes(by.bucket) && map.size > 1) {
      const keys = [...map.keys()].filter((k) => k !== "_none").sort();
      const first = keys[0] as string;
      const last = keys[keys.length - 1] as string;
      let k = first;
      for (let i = 0; i < 400 && k < last; i++) {
        k = nextBucket(k, by.bucket);
        if (!map.has(k)) map.set(k, { key: k, label: k, rows: [], value: EMPTY_AGG, series: [] });
      }
    }
    groups = [...map.values()];
    const multiYear =
      by.bucket === "month" || by.bucket === "day" || by.bucket === "week"
        ? new Set(groups.map((g) => g.key.slice(0, 4))).size > 1
        : false;
    for (const g of groups) {
      g.value = aggregate(base, g.rows, q.aggregate);
      if (by.bucket && g.key !== "_none") g.label = bucketLabel(g.key, by.bucket, multiYear);
    }
    const byKey = by.bucket !== undefined;
    const sortBy = q.sort?.by ?? (byKey ? "key" : "value");
    const dir = q.sort?.dir ?? (sortBy === "key" ? "asc" : "desc");
    groups.sort((a, b) => {
      if (a.key === "_none") return 1;
      if (b.key === "_none") return -1;
      const c =
        sortBy === "key"
          ? a.key.localeCompare(b.key, undefined, { numeric: true })
          : (a.value.value ?? 0) - (b.value.value ?? 0);
      return dir === "asc" ? c : -c;
    });
    const cap = q.limit ?? options.maxGroups;
    if (cap && groups.length > cap) {
      const kept = groups.slice(0, Math.max(1, cap - 1));
      const rest = groups.slice(kept.length);
      const restRows = rest.flatMap((g) => g.rows);
      kept.push({
        key: "_other",
        label: options.other ?? "Other",
        rows: restRows,
        value: aggregate(base, restRows, q.aggregate),
        series: [],
      });
      groups = kept;
    }
    const series = options.series;
    if (series) {
      const seriesKeys = new Map<string, string>();
      for (const g of groups) {
        const inner = new Map<string, ViewRow<T>[]>();
        for (const r of g.rows) {
          const s = groupKeyOf(base, r, series, laneLabel, options.none ?? "None");
          if (!s || s === "unsure") continue;
          seriesKeys.set(s.key, series.bucket ? bucketLabel(s.key, series.bucket) : s.label);
          inner.set(s.key, [...(inner.get(s.key) ?? []), r]);
        }
        g.series = [...inner.entries()].map(([key, list]) => ({
          key,
          label: "",
          value: aggregate(base, list, q.aggregate),
        }));
      }
      const order = [...seriesKeys.keys()].sort();
      for (const g of groups) {
        g.series = order.map((key) => ({
          key,
          label: seriesKeys.get(key) ?? key,
          value: g.series.find((s) => s.key === key)?.value ?? { ...EMPTY_AGG, value: 0 },
        }));
      }
    }
  }

  const sort = q.sort && !by ? q.sort : legacySort(options.sort);
  if (sort) rows = sortRowsBy(base, rows, sort.by, sort.dir);
  const total = rows.length;
  const cap = by ? (options.maxRows ?? 500) : (q.limit ?? options.maxRows ?? 500);
  const value = q.aggregate || q.period ? aggregate(base, rows, q.aggregate) : null;
  return {
    rows: rows.slice(0, cap),
    unsure,
    total,
    groups,
    value,
    previous: q.period ? previous : null,
  };
}

const EMPTY_AGG: Aggregate = {
  op: "count",
  value: 0,
  currency: null,
  others: [],
  count: 0,
  unsure: 0,
};

/** Whether a Thread is in the View's scope at all (the Device narrows by SQL first). */
export function inScope(doc: ViewDoc, t: ViewThread, ctx: ViewContext): boolean {
  return scopeAdmits(doc.scope.facts, t, ctx);
}
