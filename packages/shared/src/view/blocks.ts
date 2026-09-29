// Blocks (docs/spec/views.md, "The Block catalog"): each Block of a View
// drawn from its query over the View's rows. Code computes what a Block
// shows (Lane columns, table cells, a stat and its change, a chart's
// groups, calendar days, cards, people, checklist items, a heatmap); the
// Device renders it with monday's own components, the Server writes the
// card's small preview of it. Also here: a Board's old layout read as a
// Block, "Show as" between the Lane Blocks, and which actions an item shows.

import {
  ALL_LANE,
  evaluateLaneCondition,
  OTHERS_LANE,
  UNSURE_LANE,
  type ViewContext,
  type ViewThread,
} from "./core.ts";
import {
  DEFAULT_VALUE_WORDS,
  type FieldValue,
  formatFieldValue,
  formatMoney,
  formatNumber,
  personOf,
  readField,
  type ValueWords,
} from "./fields.ts";
import {
  type Aggregate,
  aggregate,
  bucketKey,
  type QueryGroup,
  type QueryResult,
  runQuery,
  type ViewBase,
  type ViewRow,
} from "./query.ts";
import type {
  BlockOf,
  BlockPreview,
  LaneComponent,
  LaneLayout,
  LaneTone,
  ValueFormat,
  ViewAction,
  ViewBlock,
  ViewDoc,
  ViewDone,
} from "./types.ts";

/* ------------------------------ A Board's layout as a Block ------------------------------ */

/** A Board's old table column as a Field reference and format. */
function columnOf(c: {
  label: string;
  fact?: string | undefined;
  signal?: string | undefined;
  field?: string | undefined;
  format?: string | undefined;
}): { label: string; field: string; format?: ValueFormat } {
  const format = c.format as ValueFormat | undefined;
  if (c.fact) return { label: c.label, field: c.fact, ...(format ? { format } : {}) };
  if (c.signal)
    return { label: c.label, field: `signal:${c.signal}`, ...(format ? { format } : {}) };
  const f = c.field ?? "subject";
  if (f === "age")
    return { label: c.label, field: "last_activity_at", format: format ?? "relative" };
  if (f === "time") return { label: c.label, field: "last_activity_at", format: format ?? "date" };
  if (f === "deadline") return { label: c.label, field: "deadline_at", format: format ?? "date" };
  return { label: c.label, field: f, ...(format ? { format } : {}) };
}

/** A Board's old layout as the one Block it becomes. */
export function blockFromLayout(layout: LaneLayout): ViewBlock {
  switch (layout.component) {
    case "lanes":
      return {
        id: "lanes",
        type: "lanes",
        ...(layout.row ? { row: layout.row } : {}),
        ...(layout.sort ? { sort: layout.sort } : {}),
        ...(layout.collapse_empty !== undefined ? { collapse_empty: layout.collapse_empty } : {}),
      };
    case "list":
      return {
        id: "list",
        type: "list",
        ...(layout.row ? { row: layout.row } : {}),
        ...(layout.sort ? { sort: layout.sort } : {}),
      };
    case "counts":
      return { id: "counts", type: "counts", ...(layout.lanes ? { lanes: layout.lanes } : {}) };
    case "table":
      return {
        id: "table",
        type: "table",
        columns: layout.columns.map(columnOf),
        ...(layout.sort ? { sort: layout.sort } : {}),
      };
    case "timeline":
      return {
        id: "timeline",
        type: "timeline",
        date: layout.date,
        ...(layout.range ? { range: layout.range } : {}),
      };
  }
}

/**
 * A stored document as a View: a Board's (with `layout` and no `blocks`)
 * gets one Block of its old component. Anything else is returned as it is.
 */
export function upgradeView(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const doc = raw as Record<string, unknown>;
  if (doc.blocks !== undefined || doc.layout === undefined) return raw;
  const { layout, ...rest } = doc;
  const component = (layout as { component?: unknown } | null)?.component;
  if (typeof component !== "string") return raw;
  return { ...rest, blocks: [blockFromLayout(layout as LaneLayout)] };
}

/** The Lane Blocks "Show as" switches between. */
export function isLaneBlock(b: ViewBlock): boolean {
  return (
    b.type === "lanes" ||
    b.type === "list" ||
    b.type === "counts" ||
    (b.type === "table" && b.id === "table") ||
    (b.type === "timeline" && b.id === "timeline")
  );
}

/** The Block a "Show as" change gives: its own defaults, the row, sort, query and actions kept where they fit. */
export function blockForComponent(component: LaneComponent, current: ViewBlock): ViewBlock {
  const keep = {
    id: current.id,
    ...(current.title ? { title: current.title } : {}),
    ...(current.width ? { width: current.width } : {}),
    ...(current.query ? { query: current.query } : {}),
    ...(current.actions ? { actions: current.actions } : {}),
  };
  const row = "row" in current ? current.row : undefined;
  const sort = "sort" in current ? current.sort : undefined;
  switch (component) {
    case "lanes":
      return { ...keep, type: "lanes", ...(row ? { row } : {}), ...(sort ? { sort } : {}) };
    case "list":
      return { ...keep, type: "list", ...(row ? { row } : {}), ...(sort ? { sort } : {}) };
    case "counts":
      return { id: current.id, type: "counts" };
    case "table":
      return {
        ...keep,
        type: "table",
        columns:
          current.type === "table"
            ? current.columns
            : [
                { label: "Received", field: "received_at", format: "date" },
                { label: "Messages", field: "message_count", format: "number" },
              ],
      };
    case "timeline":
      return { ...keep, type: "timeline", date: "last_activity_at" };
  }
}

/** The View's first Block that draws its Lanes, which "Show as" changes. */
export function laneBlockOf(doc: ViewDoc): ViewBlock | null {
  return doc.blocks.find(isLaneBlock) ?? null;
}

/** "Show as": the View with its Lane Block drawn by another component (added first when it has none). */
export function showAs(doc: ViewDoc, component: LaneComponent): ViewDoc {
  const current = laneBlockOf(doc);
  if (!current) {
    return {
      ...doc,
      blocks: [blockForComponent(component, { id: "lanes", type: "lanes" }), ...doc.blocks],
    };
  }
  return {
    ...doc,
    blocks: doc.blocks.map((b) => (b === current ? blockForComponent(component, b) : b)),
  };
}

/* ------------------------------ The Fields a Block reads ------------------------------ */

function conditionRefs(c: unknown, out: string[]): void {
  if (!c || typeof c !== "object") return;
  const o = c as Record<string, unknown>;
  if (Array.isArray(o.all)) for (const x of o.all) conditionRefs(x, out);
  if (Array.isArray(o.any)) for (const x of o.any) conditionRefs(x, out);
  if (o.not) conditionRefs(o.not, out);
  if (typeof o.signal === "string") out.push(`signal:${o.signal}`);
  if (typeof o.extract === "string") out.push(`x:${o.extract}`);
  if (typeof o.fact === "string") out.push(o.fact);
  if (o.lane !== undefined) out.push("lane");
}

/** Every Field reference a Block reads, in its props and its query. */
export function blockRefs(b: ViewBlock): string[] {
  const out: string[] = [];
  const q = b.query;
  if (q) {
    conditionRefs(q.where, out);
    if (q.dedupe) out.push(q.dedupe);
    if (q.group_by) out.push(q.group_by.field);
    if (q.aggregate?.field) out.push(q.aggregate.field);
    if (q.sort && q.sort.by !== "value" && q.sort.by !== "key") out.push(q.sort.by);
    if (q.period) out.push(q.period.field);
    if (q.lanes) out.push("lane");
  }
  switch (b.type) {
    case "lanes":
    case "list":
      for (const f of b.row?.fields ?? []) out.push(f);
      if (b.type === "list" && b.group_by) out.push(b.group_by.field);
      break;
    case "table":
      for (const c of b.columns) out.push(c.field);
      break;
    case "chart":
      if (b.series) out.push(b.series.field);
      break;
    case "timeline":
    case "calendar":
    case "heatmap":
      out.push(b.date);
      break;
    case "cards":
      for (const f of [b.card_title, b.subtitle, b.value, ...(b.badges ?? [])]) if (f) out.push(f);
      break;
    case "checklist":
      if (b.item) out.push(b.item);
      break;
  }
  return [...new Set(out)];
}

/** Every Field reference an action reads. */
export function actionRefs(a: ViewAction): string[] {
  const out: string[] = [];
  conditionRefs(a.when, out);
  const d = a.do;
  if (d.kind === "run_workflow") out.push(...Object.values(d.inputs ?? {}));
  if (d.kind === "snooze" && !["tomorrow", "next_week", "weekend"].includes(d.until))
    out.push(d.until);
  if (d.kind === "forward" && !d.to.includes("@")) out.push(d.to);
  if (d.kind === "open_link") out.push(d.link);
  if (d.kind === "add_to_calendar") out.push(d.date, ...(d.title ? [d.title] : []));
  return [...new Set(out)];
}

/* ------------------------------ Drawing a Block ------------------------------ */

export interface LaneGroupData<T extends ViewThread> {
  id: string;
  label: string;
  tone: LaneTone;
  rows: ViewRow<T>[];
}

export type BlockData<T extends ViewThread = ViewThread> =
  | {
      type: "lanes" | "list" | "counts";
      block: ViewBlock;
      groups: LaneGroupData<T>[];
      unsure: number;
    }
  | {
      type: "table";
      block: BlockOf<"table">;
      rows: Array<{ row: ViewRow<T>; cells: FieldValue[] }>;
      total: number;
      unsure: number;
    }
  | {
      type: "stat";
      block: BlockOf<"stat">;
      value: Aggregate;
      previous: Aggregate | null;
      /** The change from the previous period as a fraction (0.12 is up 12%); null when there is none to compare. */
      change: number | null;
      unsure: number;
    }
  | { type: "chart"; block: BlockOf<"chart">; groups: QueryGroup<T>[]; unsure: number }
  | {
      type: "timeline" | "calendar";
      block: BlockOf<"timeline"> | BlockOf<"calendar">;
      items: Array<{ row: ViewRow<T>; date: string }>;
      unsure: number;
    }
  | {
      type: "cards";
      block: BlockOf<"cards">;
      cards: Array<{
        row: ViewRow<T>;
        title: FieldValue;
        subtitle: FieldValue | null;
        badges: FieldValue[];
        value: FieldValue | null;
      }>;
      unsure: number;
    }
  | {
      type: "people";
      block: BlockOf<"people">;
      people: Array<{
        key: string;
        label: string;
        count: number;
        last: string;
        rows: ViewRow<T>[];
      }>;
      unsure: number;
    }
  | {
      type: "checklist";
      block: BlockOf<"checklist">;
      items: Array<{ row: ViewRow<T>; item: FieldValue; done: boolean }>;
      unsure: number;
    }
  | {
      type: "heatmap";
      block: BlockOf<"heatmap">;
      rowLabels: string[];
      colLabels: string[];
      cells: number[][];
      max: number;
      unsure: number;
    }
  | { type: "text"; block: BlockOf<"text"> };

export interface BlockOptions {
  /** Checklist items checked, by Thread. */
  done?: Readonly<Record<string, ViewDone>> | undefined;
  maxRows?: number | undefined;
  maxGroups?: number | undefined;
  unsureLabel?: string | undefined;
  othersLabel?: string | undefined;
  none?: string | undefined;
  other?: string | undefined;
}

function laneGroups<T extends ViewThread>(
  base: ViewBase<T>,
  result: QueryResult<T>,
  options: BlockOptions,
  only?: readonly string[],
): LaneGroupData<T>[] {
  const { doc } = base;
  if (doc.lanes.length === 0) {
    return [{ id: ALL_LANE, label: doc.name, tone: "muted", rows: result.rows }];
  }
  const order: LaneGroupData<T>[] = doc.lanes.map((l) => ({
    id: l.id,
    label: l.label,
    tone: l.tone,
    rows: [],
  }));
  order.push({
    id: UNSURE_LANE,
    label: options.unsureLabel ?? doc.unsure.label,
    tone: "muted",
    rows: [],
  });
  if (doc.others !== "hide") {
    order.push({
      id: OTHERS_LANE,
      label: options.othersLabel ?? doc.others.label,
      tone: "muted",
      rows: [],
    });
  }
  const byId = new Map(order.map((g) => [g.id, g]));
  for (const r of result.rows) if (r.lane) byId.get(r.lane)?.rows.push(r);
  return only?.length ? order.filter((g) => only.includes(g.id)) : order;
}

/** A Block over the View's rows: what it shows, computed by code. */
export function computeBlock<T extends ViewThread>(
  base: ViewBase<T>,
  block: ViewBlock,
  options: BlockOptions = {},
): BlockData<T> {
  const { doc, ctx } = base;
  const laneLabel = (id: string) =>
    id === UNSURE_LANE
      ? (options.unsureLabel ?? doc.unsure.label)
      : id === OTHERS_LANE
        ? (options.othersLabel ?? (doc.others === "hide" ? id : doc.others.label))
        : (doc.lanes.find((l) => l.id === id)?.label ?? id);
  const qopts = {
    laneLabel,
    maxRows: options.maxRows,
    maxGroups: options.maxGroups,
    none: options.none,
    other: options.other,
  };
  switch (block.type) {
    case "lanes":
    case "counts": {
      const result = runQuery(base, block.query, {
        ...qopts,
        ...(block.type === "lanes" && block.sort ? { sort: block.sort } : {}),
      });
      return {
        type: block.type,
        block,
        groups: laneGroups(
          base,
          result,
          options,
          block.type === "counts" ? block.lanes : undefined,
        ),
        unsure: result.unsure.length,
      };
    }
    case "list": {
      if (block.group_by || block.query?.group_by) {
        const result = runQuery(base, block.query, {
          ...qopts,
          groupBy: block.group_by,
          ...(block.sort ? { sort: block.sort } : {}),
        });
        return {
          type: "list",
          block,
          groups: (result.groups ?? []).map((g) => ({
            id: g.key,
            label: g.label,
            tone: "muted",
            rows: g.rows,
          })),
          unsure: result.unsure.length,
        };
      }
      const result = runQuery(base, block.query, {
        ...qopts,
        ...(block.sort ? { sort: block.sort } : {}),
      });
      return {
        type: "list",
        block,
        groups: laneGroups(base, result, options),
        unsure: result.unsure.length,
      };
    }
    case "table": {
      const result = runQuery(base, block.query, {
        ...qopts,
        ...(block.sort ? { sort: block.sort } : {}),
      });
      return {
        type: "table",
        block,
        rows: result.rows.map((row) => ({
          row,
          cells: block.columns.map((c) =>
            readField(doc, row.thread, c.field, ctx, row.lane, laneLabel),
          ),
        })),
        total: result.total,
        unsure: result.unsure.length,
      };
    }
    case "stat": {
      const result = runQuery(base, block.query, qopts);
      const value = result.value ?? aggregate(base, result.rows, block.query?.aggregate);
      const previous = block.compare === "previous" ? result.previous : null;
      const change =
        previous?.value && value.value !== null && previous.currency === value.currency
          ? (value.value - previous.value) / Math.abs(previous.value)
          : null;
      return {
        type: "stat",
        block,
        value,
        previous,
        change,
        unsure: result.unsure.length + value.unsure,
      };
    }
    case "chart": {
      const result = runQuery(base, block.query, {
        ...qopts,
        maxGroups: options.maxGroups ?? 12,
        ...(block.series ? { series: block.series } : {}),
      });
      const unsure =
        result.unsure.length + (result.groups ?? []).reduce((n, g) => n + g.value.unsure, 0);
      return { type: "chart", block, groups: result.groups ?? [], unsure };
    }
    case "timeline":
    case "calendar": {
      const result = runQuery(base, block.query, qopts);
      let unsure = result.unsure.length;
      const items: Array<{ row: ViewRow<T>; date: string }> = [];
      for (const row of result.rows) {
        const v = readField(doc, row.thread, block.date, ctx, row.lane);
        if (v.state === "value" && typeof v.value === "string") items.push({ row, date: v.value });
        else if (v.state === "unsure" || v.state === "not_read") unsure += 1;
      }
      items.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      if (block.type === "timeline" && block.range) {
        const end = ctx.now.getTime() + block.range.days * 86_400_000;
        const start = ctx.now.getTime() - block.range.days * 86_400_000;
        return {
          type: "timeline",
          block,
          items: items.filter((i) => {
            const at = Date.parse(i.date);
            return at >= start && at <= end;
          }),
          unsure,
        };
      }
      return { type: block.type, block, items, unsure } as BlockData<T>;
    }
    case "cards": {
      const result = runQuery(base, block.query, qopts);
      const read = (ref: string | undefined, row: ViewRow<T>) =>
        ref ? readField(doc, row.thread, ref, ctx, row.lane, laneLabel) : null;
      return {
        type: "cards",
        block,
        cards: result.rows.map((row) => ({
          row,
          title: read(block.card_title ?? "subject", row) as FieldValue,
          subtitle: read(block.subtitle, row),
          badges: (block.badges ?? []).map((b) => read(b, row) as FieldValue),
          value: read(block.value, row),
        })),
        unsure: result.unsure.length,
      };
    }
    case "people": {
      const result = runQuery(base, block.query, {
        ...qopts,
        maxRows: Number.MAX_SAFE_INTEGER,
      });
      const map = new Map<
        string,
        { key: string; label: string; count: number; last: string; rows: ViewRow<T>[] }
      >();
      for (const row of result.rows) {
        const v = readField(doc, row.thread, block.by, ctx, row.lane);
        if (v.state !== "value") continue;
        const p = personOf(row.thread);
        const key =
          block.by === "person" ? (p?.email ?? "") : typeof v.value === "string" ? v.value : v.text;
        if (!key) continue;
        const label = v.text;
        const g = map.get(key) ?? { key, label, count: 0, last: "", rows: [] };
        g.count += 1;
        g.rows.push(row);
        if (row.thread.lastActivity > g.last) g.last = row.thread.lastActivity;
        if (!g.label.includes(" ") && label.includes(" ")) g.label = label;
        map.set(key, g);
      }
      const people = [...map.values()].sort(
        (a, b) => b.count - a.count || b.last.localeCompare(a.last),
      );
      const cap = block.query?.limit ?? options.maxGroups ?? 12;
      return { type: "people", block, people: people.slice(0, cap), unsure: result.unsure.length };
    }
    case "checklist": {
      const result = runQuery(base, block.query, qopts);
      return {
        type: "checklist",
        block,
        items: result.rows.map((row) => {
          const d = options.done?.[row.thread.id];
          return {
            row,
            item: readField(doc, row.thread, block.item ?? "subject", ctx, row.lane, laneLabel),
            done: d !== undefined && d.messageCount === row.thread.messageCount,
          };
        }),
        unsure: result.unsure.length,
      };
    }
    case "heatmap": {
      const result = runQuery(base, block.query, { ...qopts, maxRows: Number.MAX_SAFE_INTEGER });
      const grid = block.grid ?? "weekday_hour";
      const weekdayHour = grid === "weekday_hour";
      const rowsN = 7;
      const colsN = weekdayHour ? 24 : 12;
      const cells = Array.from({ length: rowsN }, () => Array.from({ length: colsN }, () => 0));
      let unsure = result.unsure.length;
      const weekStart = startOfWeekMs(ctx.now);
      for (const row of result.rows) {
        const v = readField(doc, row.thread, block.date, ctx, row.lane);
        if (v.state !== "value" || typeof v.value !== "string") {
          if (v.state === "unsure" || v.state === "not_read") unsure += 1;
          continue;
        }
        const at = new Date(v.value);
        if (Number.isNaN(at.getTime())) continue;
        const wd = Number(bucketKey(v.value, "weekday", ctx.zone) ?? 0);
        if (weekdayHour) {
          const h = Number(bucketKey(v.value, "hour", ctx.zone) ?? 0);
          const rowCells = cells[wd];
          if (rowCells) rowCells[h] = (rowCells[h] ?? 0) + 1;
        } else {
          const weeksAgo = Math.floor((weekStart - at.getTime()) / (7 * 86_400_000)) + 1;
          const col = colsN - 1 - weeksAgo;
          const rowCells = cells[wd];
          if (col >= 0 && col < colsN && rowCells) rowCells[col] = (rowCells[col] ?? 0) + 1;
        }
      }
      const max = Math.max(0, ...cells.flat());
      return {
        type: "heatmap",
        block,
        rowLabels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        colLabels: weekdayHour
          ? Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))
          : Array.from({ length: colsN }, (_, i) => String(i - colsN + 1)),
        cells,
        max,
        unsure,
      };
    }
    case "text":
      return { type: "text", block };
  }
}

function startOfWeekMs(now: Date): number {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000;
}

/** Every Block of the View, in order. */
export function computeBlocks<T extends ViewThread>(
  base: ViewBase<T>,
  options: BlockOptions = {},
): Array<BlockData<T>> {
  return base.doc.blocks.map((b) => computeBlock(base, b, options));
}

/* ------------------------------ Numbers in words ------------------------------ */

/** An aggregate in words: "$1,315.50", "12", "$40.00 + EUR 12.00". */
export function formatAggregate(a: Aggregate, format?: ValueFormat): string {
  if (a.value === null) return "";
  if (a.currency && format !== "number") {
    const main = formatMoney({ value: a.value, currency: a.currency });
    return a.others.length ? `${main} + ${a.others.map((o) => formatMoney(o)).join(" + ")}` : main;
  }
  if (format === "percent") return `${Math.round(a.value * 100)}%`;
  return formatNumber(a.value);
}

/** A change in words: "up 12%", "down 3%", "no change". */
export function formatChange(
  change: number | null,
  words: { up: string; down: string; same: string } = {
    up: "up {pct}",
    down: "down {pct}",
    same: "no change",
  },
): string | null {
  if (change === null || !Number.isFinite(change)) return null;
  const pct = `${Math.round(Math.abs(change) * 100)}%`;
  if (Math.round(change * 100) === 0) return words.same;
  return (change > 0 ? words.up : words.down).replace("{pct}", pct);
}

/* ------------------------------ The card's preview ------------------------------ */

const subjectOf = (t: ViewThread) => t.subject || personOf(t)?.email || t.id;

/** A Block drawn small for the View card: its title, its number, its rows or groups in words. */
export function previewBlock<T extends ViewThread>(
  data: BlockData<T>,
  ctx: Pick<ViewContext, "now" | "zone">,
  words: ValueWords = DEFAULT_VALUE_WORDS,
  take = 5,
): BlockPreview {
  const b = data.block;
  const base = {
    id: b.id,
    type: b.type,
    title: b.title ?? "",
    value: null as string | null,
    change: null as string | null,
    unsure: "unsure" in data ? data.unsure : 0,
  };
  switch (data.type) {
    case "lanes":
    case "list":
    case "counts":
      return {
        ...base,
        items: data.groups.map((g) => ({
          label: g.label,
          count: g.rows.length,
          tone: g.tone,
          sub: g.rows
            .slice(0, 3)
            .map((r) => subjectOf(r.thread))
            .join(" · "),
        })),
      };
    case "table":
      return {
        ...base,
        value: String(data.total),
        items: data.rows.slice(0, take).map((r) => ({
          label: subjectOf(r.row.thread),
          value: data.block.columns
            .map((c, i) => {
              const cell = r.cells[i];
              return cell ? formatFieldValue(cell, c.format, ctx, words) : "";
            })
            .join(" · "),
        })),
      };
    case "stat":
      return {
        ...base,
        value: formatAggregate(data.value, data.block.format) || "0",
        change: formatChange(data.change),
        items: [],
      };
    case "chart":
      return {
        ...base,
        items: data.groups.map((g) => ({
          label: g.label,
          count: g.value.value ?? 0,
          value: formatAggregate(g.value, data.block.format),
        })),
      };
    case "timeline":
    case "calendar":
      return {
        ...base,
        items: data.items.slice(0, take).map((i) => ({
          label: subjectOf(i.row.thread),
          value: formatFieldValue(
            { state: "value", type: "date", value: i.date, text: i.date },
            "date",
            ctx,
            words,
          ),
        })),
      };
    case "cards":
      return {
        ...base,
        items: data.cards.slice(0, take).map((c) => ({
          label: formatFieldValue(c.title, undefined, ctx, words) || subjectOf(c.row.thread),
          ...(c.value
            ? { value: formatFieldValue(c.value, data.block.value_format, ctx, words) }
            : {}),
          ...(c.subtitle ? { sub: formatFieldValue(c.subtitle, undefined, ctx, words) } : {}),
        })),
      };
    case "people":
      return {
        ...base,
        items: data.people.slice(0, take).map((p) => ({ label: p.label, count: p.count })),
      };
    case "checklist":
      return {
        ...base,
        items: data.items.slice(0, take).map((i) => ({
          label: formatFieldValue(i.item, undefined, ctx, words) || subjectOf(i.row.thread),
          ...(i.done ? { value: words.yes } : {}),
        })),
      };
    case "heatmap": {
      const flat = data.cells.flatMap((row, r) =>
        row.map((n, c) => ({ n, label: `${data.rowLabels[r]} ${data.colLabels[c]}` })),
      );
      return {
        ...base,
        value: String(flat.reduce((n, x) => n + x.n, 0)),
        items: flat
          .filter((x) => x.n > 0)
          .sort((a, b) => b.n - a.n)
          .slice(0, take)
          .map((x) => ({ label: x.label, count: x.n })),
      };
    }
    case "text":
      return { ...base, value: data.block.text, items: [] };
  }
}

/* ------------------------------ Actions on items ------------------------------ */

/** The View's actions a Block's items carry, by the Block's list. */
export function blockActions(doc: ViewDoc, block: ViewBlock): ViewAction[] {
  return (block.actions ?? []).flatMap((id) => doc.actions.find((a) => a.id === id) ?? []);
}

/**
 * Whether an action shows on one row: it is a row action, and its `when`
 * holds (three-valued: false or unknown hides it).
 */
export function actionShows<T extends ViewThread>(
  base: Pick<ViewBase<T>, "doc" | "ctx">,
  action: ViewAction,
  row: ViewRow<T>,
  where: "row" | "group" = "row",
): boolean {
  if (where === "row" && action.on === "group") return false;
  if (where === "group" && action.on === "row") return false;
  if (!action.when) return true;
  return (
    evaluateLaneCondition(action.when, base.doc, row.thread, base.ctx, 0, {
      notRead: false,
      lane: row.lane,
    }) === true
  );
}
