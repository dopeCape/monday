// The Block catalog on the Device (docs/spec/views.md, "The Block
// catalog"): a View's Blocks in document order, side by side by their width
// on a wide list area and stacked on a narrow one, each drawn from what
// code computed for it (computeBlocks over the View's base): the Agent
// never writes markup. lanes, list and counts keep the Inbox's own Thread
// rows (every row action, key and the multi-select work on them; a row can
// be dragged to another Lane or moved with Move to); a table, a stat, a
// chart, a timeline, a calendar, cards, people, a checklist, a heatmap and
// a short note draw with monday's own components. Every row, card, cell and
// calendar entry opens its Thread. A View's action buttons show on the
// items they fit (a false or unknown `when` hides them) and in a Lane's or
// group's header for all its Threads.

import type {
  ActionIcon,
  BlockData,
  LaneGroupData,
  Settings,
  Thread,
  ValueWords,
  View,
  ViewAction,
  ViewBase,
  ViewBlock,
  ViewRow,
} from "@monday/shared";
import {
  actionShows,
  blockActions,
  computeBlocks,
  formatAggregate,
  formatChange,
  formatFieldValue,
  rowKey,
  UNSURE_LANE,
} from "@monday/shared";
import {
  BarChart,
  type ChartItem,
  cx,
  DonutChart,
  formatListTime,
  Heatmap,
  LineChart,
  MonthGrid,
  StackedBarChart,
  StatTile,
} from "@monday/ui";
import {
  ArchiveIcon,
  ArrowRightIcon,
  ArrowsLeftRightIcon,
  ArrowUUpLeftIcon,
  CalendarPlusIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  CurrencyDollarIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  FlowArrowIcon,
  FolderIcon,
  LinkIcon,
  PackageIcon,
  PaperPlaneTiltIcon,
  type Icon as PhosphorIcon,
  PlayIcon,
  ReceiptIcon,
  ShareIcon,
  SparkleIcon,
  StarIcon,
  TagIcon,
  TruckIcon,
} from "@phosphor-icons/react";
import { type DragEvent, type ReactNode, useMemo, useState } from "react";
import { carriesThreads, readThreadDrag } from "../agent/aui/mentions.tsx";
import { Picker } from "../screens/inbox/Picker.tsx";
import type { CachedViewThread } from "../store/views.ts";

type Row = ViewRow<CachedViewThread>;
type Data = BlockData<CachedViewThread>;
/** What the lanes, list and counts Blocks draw: groups of the Inbox's own rows. */
type LaneData = Extract<Data, { type: "lanes" | "list" | "counts" }>;

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** The Phosphor icon for each name an action may carry. */
export const ACTION_ICON_COMPONENTS: Record<ActionIcon, PhosphorIcon> = {
  archive: ArchiveIcon,
  clock: ClockIcon,
  truck: TruckIcon,
  package: PackageIcon,
  "arrow-u-up-left": ArrowUUpLeftIcon,
  share: ShareIcon,
  "paper-plane-tilt": PaperPlaneTiltIcon,
  link: LinkIcon,
  "calendar-plus": CalendarPlusIcon,
  check: CheckIcon,
  "check-circle": CheckCircleIcon,
  tag: TagIcon,
  "envelope-open": EnvelopeOpenIcon,
  envelope: EnvelopeIcon,
  folder: FolderIcon,
  play: PlayIcon,
  "flow-arrow": FlowArrowIcon,
  sparkle: SparkleIcon,
  "currency-dollar": CurrencyDollarIcon,
  receipt: ReceiptIcon,
  "arrow-right": ArrowRightIcon,
  star: StarIcon,
};

/** How values are written, from the Settings. */
export function valueWords(s: Settings): ValueWords {
  return {
    unsure: s["strings.views.unsure"],
    notRead: s["strings.views.not_read"],
    yes: s["strings.views.value.yes"],
    no: s["strings.views.value.no"],
    today: s["strings.views.value.today"],
    tomorrow: s["strings.views.value.tomorrow"],
    yesterday: s["strings.views.value.yesterday"],
    inDays: s["strings.views.value.in_days"],
    daysAgo: s["strings.views.value.days_ago"],
  };
}

/** Every Block of the View as code computes it, with the Settings' limits and words. */
export function viewBlockData(view: View, base: ViewBase<CachedViewThread>, s: Settings): Data[] {
  return computeBlocks(base, {
    done: view.done,
    maxRows: s["views.query.max_rows"],
    maxGroups: s["views.chart.max_groups"],
    unsureLabel: s["strings.views.unsure"],
    othersLabel: s["strings.views.everything_else"],
    none: s["strings.views.none"],
    other: s["strings.views.other"],
  });
}

/** The Threads the Blocks show, in the order they show them: what the keyboard walks. */
export function orderedThreads(data: readonly Data[], countsLane?: string): Thread[] {
  const out: Thread[] = [];
  const seen = new Set<string>();
  const add = (r: Row) => {
    if (seen.has(r.thread.id)) return;
    seen.add(r.thread.id);
    out.push(r.thread.thread);
  };
  for (const d of data) {
    switch (d.type) {
      case "lanes":
      case "list":
        for (const g of d.groups) for (const r of g.rows) add(r);
        break;
      case "counts": {
        const g = d.groups.find((x) => x.id === countsLane) ?? d.groups[0];
        for (const r of g?.rows ?? []) add(r);
        break;
      }
      case "table":
        for (const r of d.rows) add(r.row);
        break;
      case "timeline":
      case "calendar":
        for (const i of d.items) add(i.row);
        break;
      case "cards":
        for (const c of d.cards) add(c.row);
        break;
      case "checklist":
        for (const i of d.items) add(i.row);
        break;
      default:
        break;
    }
  }
  return out;
}

export interface ViewBlocksProps {
  view: View;
  base: ViewBase<CachedViewThread>;
  data: readonly Data[];
  settings: Settings;
  now: Date;
  /** The Inbox's row for a Thread. */
  row(thread: Thread): ReactNode;
  focus: string | null;
  /** Opens the row's Thread, on its Message when the row is one Message. */
  open(threadId: string, messageId?: string | null): void;
  /** A Thread moved to another Lane by hand; null takes the user's placement back. */
  onMove?: ((threadId: string, lane: string | null) => void) | undefined;
  /** The Lane the counts Block filters to. */
  countsLane?: string | undefined;
  onCountsLane?: ((lane: string) => void) | undefined;
  /** An action button pressed: on one row, or on every row of a Lane or group. */
  onAction?:
    | ((action: ViewAction, rows: readonly Row[], where: "row" | "group") => void)
    | undefined;
  /** A checklist item checked or unchecked. */
  onDone?: ((threadId: string, done: boolean, messageCount: number) => void) | undefined;
}

/* ------------------------------ Shared pieces ------------------------------ */

/** A Lane accepts a dragged Thread: the move is a correction (docs/spec/views.md, "Correcting on the View"). */
function dropTarget(lane: string, onMove: ViewBlocksProps["onMove"]) {
  if (!onMove) return {};
  return {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!carriesThreads(e.dataTransfer)) return;
      e.preventDefault();
      e.currentTarget.setAttribute("data-drop", "true");
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => e.currentTarget.removeAttribute("data-drop"),
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.currentTarget.removeAttribute("data-drop");
      const dragged = readThreadDrag(e.dataTransfer);
      if (dragged.length === 0) return;
      e.preventDefault();
      for (const t of dragged) onMove(t.id, lane);
    },
  };
}

/** The action buttons one row carries. */
function RowActions({
  props,
  actions,
  row,
}: {
  props: ViewBlocksProps;
  actions: readonly ViewAction[];
  row: Row;
}) {
  if (!props.onAction) return null;
  const shown = actions.filter((a) => actionShows(props.base, a, row, "row"));
  if (shown.length === 0) return null;
  return (
    <span className="view-acts">
      {shown.map((a) => {
        const Icon = ACTION_ICON_COMPONENTS[a.icon];
        return (
          <button
            key={a.id}
            type="button"
            className="view-act"
            data-action={a.id}
            title={a.label}
            aria-label={a.label}
            onClick={(e) => {
              e.stopPropagation();
              props.onAction?.(a, [row], "row");
            }}
          >
            <Icon />
          </button>
        );
      })}
    </span>
  );
}

/** The actions a Lane's or group's header carries for all its Threads: "{label} ({count})". */
function GroupActions({
  props,
  actions,
  rows,
}: {
  props: ViewBlocksProps;
  actions: readonly ViewAction[];
  rows: readonly Row[];
}) {
  if (!props.onAction) return null;
  const s = props.settings;
  const out = actions.flatMap((a) => {
    if (a.on === "row") return [];
    const fits = rows.filter((r) => actionShows(props.base, a, r, "group"));
    return fits.length ? [{ a, fits }] : [];
  });
  if (out.length === 0) return null;
  return (
    <span className="view-group-acts">
      {out.map(({ a, fits }) => (
        <button
          key={a.id}
          type="button"
          className="view-group-act"
          data-action={a.id}
          onClick={() => props.onAction?.(a, fits, "group")}
        >
          {fill(s["strings.views.action.all"], { label: a.label, count: fits.length })}
        </button>
      ))}
    </span>
  );
}

/** One row with its Move to and its buttons: the Inbox's row, and a small button that picks another Lane. */
function LaneRow({
  props,
  row,
  lane,
  actions,
}: {
  props: ViewBlocksProps;
  row: Row;
  lane: string;
  actions: readonly ViewAction[];
}) {
  const [picking, setPicking] = useState(false);
  const s = props.settings;
  const doc = props.view.doc;
  const lanes = [
    ...doc.lanes.map((l) => ({ key: l.id, label: l.label })),
    { key: UNSURE_LANE, label: s["strings.views.unsure"] },
  ].filter((l) => l.key !== lane);
  const thread = row.thread;
  const movable = props.onMove && doc.lanes.length > 0;
  return (
    <div
      className={cx("view-row", row.placement?.byUser && "by-user")}
      data-thread={thread.id}
      data-lane={lane}
    >
      {props.row(thread.thread)}
      <RowActions props={props} actions={actions} row={row} />
      {movable ? (
        <button
          type="button"
          className="view-move"
          title={s["strings.views.move_to"]}
          aria-label={`${s["strings.views.move_to"]}: ${thread.thread.subject}`}
          onClick={() => setPicking((p) => !p)}
        >
          <ArrowsLeftRightIcon />
        </button>
      ) : null}
      {picking && props.onMove ? (
        <Picker
          className="view-move-pop"
          label={s["strings.views.move_to"]}
          title={s["strings.views.move_to"]}
          items={lanes}
          onPick={(key) => {
            setPicking(false);
            props.onMove?.(thread.id, key);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

function GroupRows({
  props,
  group,
  actions,
}: {
  props: ViewBlocksProps;
  group: LaneGroupData<CachedViewThread>;
  actions: readonly ViewAction[];
}) {
  const s = props.settings;
  if (group.rows.length === 0)
    return <div className="view-empty">{s["strings.views.lane_empty"]}</div>;
  const notRead = group.id === UNSURE_LANE ? group.rows.filter((r) => r.placement?.notRead) : [];
  const decided =
    group.id === UNSURE_LANE ? group.rows.filter((r) => !r.placement?.notRead) : group.rows;
  return (
    <>
      {decided.map((r) => (
        <LaneRow key={rowKey(r.thread)} props={props} row={r} lane={group.id} actions={actions} />
      ))}
      {notRead.length ? (
        <>
          <div className="view-sub">{s["strings.views.not_read"]}</div>
          {notRead.map((r) => (
            <LaneRow
              key={rowKey(r.thread)}
              props={props}
              row={r}
              lane={group.id}
              actions={actions}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

function GroupHead({
  props,
  group,
  actions,
}: {
  props: ViewBlocksProps;
  group: LaneGroupData<CachedViewThread>;
  actions: readonly ViewAction[];
}) {
  return (
    <div className="view-lane-h" data-tone={group.tone}>
      <span className="dot" aria-hidden="true" />
      <b>{group.label}</b>
      <GroupActions props={props} actions={actions} rows={group.rows} />
      <span className="n">{group.rows.length}</span>
    </div>
  );
}

/** A Thread outside the Inbox's rows: its subject, who, and a value; a click opens it. */
function ThreadLine({
  props,
  row,
  actions,
  value,
  tone,
}: {
  props: ViewBlocksProps;
  row: Row;
  actions: readonly ViewAction[];
  value?: string | undefined;
  tone?: string | undefined;
}) {
  const t = row.thread;
  return (
    <div
      className={cx("view-line", props.focus === t.id && "focus")}
      data-thread={t.id}
      data-tone={tone}
    >
      <button
        type="button"
        className="view-line-main"
        onClick={() => props.open(t.id, t.row?.message)}
      >
        {tone ? <span className="dot" aria-hidden="true" /> : null}
        <b>{t.thread.subject}</b>
        <span className="who">{t.thread.participants[0]?.name || t.from}</span>
        {value ? <span className="val">{value}</span> : null}
      </button>
      <RowActions props={props} actions={actions} row={row} />
    </div>
  );
}

const toneOf = (props: ViewBlocksProps, lane: string | null) =>
  props.view.doc.lanes.find((l) => l.id === lane)?.tone;

/* ------------------------------ Each Block ------------------------------ */

function LanesBlock({ props, d }: { props: ViewBlocksProps; d: LaneData }) {
  const actions = blockActions(props.view.doc, d.block);
  const collapse = d.block.type === "lanes" && d.block.collapse_empty;
  return (
    <div className="view-lanes" data-component="lanes">
      {d.groups.map((group) => {
        const folded = collapse && group.rows.length === 0;
        return (
          <section
            key={group.id}
            className={cx("view-lane", folded && "folded")}
            data-lane={group.id}
            data-tone={group.tone}
            aria-label={group.label}
            {...dropTarget(group.id, props.onMove)}
          >
            <GroupHead props={props} group={group} actions={actions} />
            {folded ? null : <GroupRows props={props} group={group} actions={actions} />}
          </section>
        );
      })}
    </div>
  );
}

function ListBlock({ props, d }: { props: ViewBlocksProps; d: LaneData }) {
  const actions = blockActions(props.view.doc, d.block);
  const byLane = !(d.block.type === "list" && (d.block.group_by || d.block.query?.group_by));
  return (
    <div className="view-list" data-component="list">
      {d.groups.map((group) => (
        <section
          key={group.id}
          className="view-group"
          data-lane={group.id}
          data-tone={group.tone}
          aria-label={group.label}
          {...(byLane ? dropTarget(group.id, props.onMove) : {})}
        >
          <GroupHead props={props} group={group} actions={actions} />
          <GroupRows props={props} group={group} actions={actions} />
        </section>
      ))}
    </div>
  );
}

function CountsBlock({ props, d }: { props: ViewBlocksProps; d: LaneData }) {
  const actions = blockActions(props.view.doc, d.block);
  const current = d.groups.find((g) => g.id === props.countsLane) ?? d.groups[0];
  return (
    <div className="view-counts-view" data-component="counts">
      <div className="view-counts" role="tablist">
        {d.groups.map((group) => (
          <button
            key={group.id}
            type="button"
            role="tab"
            aria-selected={group.id === current?.id}
            className={cx("view-count", group.id === current?.id && "on")}
            data-tone={group.tone}
            data-lane={group.id}
            onClick={() => props.onCountsLane?.(group.id)}
          >
            <span className="dot" aria-hidden="true" />
            {group.label}
            <b>{group.rows.length}</b>
          </button>
        ))}
      </div>
      {current ? <GroupRows props={props} group={current} actions={actions} /> : null}
    </div>
  );
}

function TableBlock({ props, d }: { props: ViewBlocksProps; d: Extract<Data, { type: "table" }> }) {
  const s = props.settings;
  const words = valueWords(s);
  const actions = blockActions(props.view.doc, d.block);
  const cols = d.block.columns;
  return (
    <div className="view-table" data-component="table">
      <div className="view-tr head">
        <span>{s["strings.views.column.thread"]}</span>
        {cols.map((c) => (
          <span key={c.label}>{c.label}</span>
        ))}
      </div>
      {d.rows.map(({ row, cells }) => {
        const tone = toneOf(props, row.lane);
        return (
          <div
            key={rowKey(row.thread)}
            className={cx("view-tr", props.focus === row.thread.id && "focus")}
            data-thread={row.thread.id}
            data-tone={tone}
          >
            <button
              type="button"
              className="t"
              onClick={() => props.open(row.thread.id, row.thread.row?.message)}
            >
              {tone ? <span className="dot" aria-hidden="true" /> : null}
              <b>{row.thread.thread.subject}</b>
              <span className="who">
                {row.thread.thread.participants[0]?.name || row.thread.from}
              </span>
            </button>
            {cols.map((c, i) => {
              const cell = cells[i];
              const text = cell ? formatFieldValue(cell, c.format, props.base.ctx, words) : "";
              const unsure = cell?.state === "unsure";
              const chip = c.format === "chip";
              return (
                <span
                  key={c.label}
                  className={cx("cell", unsure && "unsure", chip && "chip-cell")}
                  data-tone={chip && c.field === "lane" ? tone : undefined}
                >
                  {chip && text ? (
                    <span className="view-chip">
                      <span className="dot" aria-hidden="true" />
                      {text}
                    </span>
                  ) : (
                    text
                  )}
                </span>
              );
            })}
            <RowActions props={props} actions={actions} row={row} />
          </div>
        );
      })}
    </div>
  );
}

function StatBlock({ props, d }: { props: ViewBlocksProps; d: Extract<Data, { type: "stat" }> }) {
  const s = props.settings;
  const change = formatChange(d.change, {
    up: s["strings.views.change.up"],
    down: s["strings.views.change.down"],
    same: s["strings.views.change.same"],
  });
  const period = d.block.query?.period?.bucket;
  const previous = period
    ? fill(s["strings.views.change.previous"], { period: s[`strings.views.period.${period}`] })
    : "";
  const dir: "up" | "down" | "same" =
    d.change === null || Math.round(d.change * 100) === 0 ? "same" : d.change > 0 ? "up" : "down";
  return (
    <StatTile
      label={d.block.title ?? ""}
      value={formatAggregate(d.value, d.block.format) || "0"}
      change={change ? { text: previous ? `${change} ${previous}` : change, dir } : null}
    />
  );
}

function ChartBlock({ props, d }: { props: ViewBlocksProps; d: Extract<Data, { type: "chart" }> }) {
  const [picked, setPicked] = useState<string | null>(null);
  const actions = blockActions(props.view.doc, d.block);
  const items: ChartItem[] = d.groups.map((g) => ({
    key: g.key,
    label: g.label,
    value: g.value.value ?? 0,
    text: formatAggregate(g.value, d.block.format),
  }));
  const label = d.block.title ?? "";
  const pick = (key: string) => {
    const g = d.groups.find((x) => x.key === key);
    if (g && g.rows.length === 1 && g.rows[0]) {
      props.open(g.rows[0].thread.id);
      return;
    }
    setPicked((p) => (p === key ? null : key));
  };
  const chart =
    d.block.chart === "stacked_bar" ? (
      <StackedBarChart
        label={label}
        groups={d.groups.map((g) => ({
          key: g.key,
          label: g.label,
          values: g.series.map((x) => x.value.value ?? 0),
        }))}
        series={(d.groups[0]?.series ?? []).map((x) => ({ key: x.key, label: x.label }))}
        onPick={pick}
      />
    ) : d.block.chart === "line" || d.block.chart === "area" ? (
      <LineChart items={items} label={label} area={d.block.chart === "area"} onPick={pick} />
    ) : d.block.chart === "donut" ? (
      <DonutChart items={items} label={label} onPick={pick} />
    ) : (
      <BarChart items={items} label={label} picked={picked} onPick={pick} />
    );
  const rows = picked ? (d.groups.find((g) => g.key === picked)?.rows ?? []) : [];
  return (
    <div className="view-chart-block" data-chart={d.block.chart}>
      {chart}
      {rows.length ? (
        <div className="view-picked">
          {rows.map((r) => (
            <ThreadLine key={rowKey(r.thread)} props={props} row={r} actions={actions} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type Dated = Extract<Data, { type: "timeline" | "calendar" }>;

function TimelineBlock({ props, d }: { props: ViewBlocksProps; d: Dated }) {
  const actions = blockActions(props.view.doc, d.block);
  const days = new Map<string, Dated["items"]>();
  for (const i of d.items) {
    const key = i.date.slice(0, 10);
    days.set(key, [...(days.get(key) ?? []), i]);
  }
  return (
    <div className="view-timeline" data-component="timeline">
      {[...days.entries()].map(([day, list]) => (
        <section key={day} className="view-day">
          <div className="view-day-h">{formatListTime(list[0]?.date ?? day, props.now)}</div>
          {list.map((i) => (
            <ThreadLine
              key={rowKey(i.row.thread)}
              props={props}
              row={i.row}
              actions={actions}
              tone={toneOf(props, i.row.lane)}
            />
          ))}
        </section>
      ))}
      {d.items.length === 0 ? (
        <div className="view-empty">{props.settings["strings.views.block_empty"]}</div>
      ) : null}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

function CalendarBlock({ props, d }: { props: ViewBlocksProps; d: Dated }) {
  const s = props.settings;
  const now = props.now;
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const start = useMemo(() => {
    const has = d.items.some((i) => i.date.startsWith(thisMonth));
    const first = d.items.find((i) => i.date.slice(0, 7) >= thisMonth) ?? d.items[0];
    const key = has || !first ? thisMonth : first.date.slice(0, 7);
    return { y: Number(key.slice(0, 4)), m: Number(key.slice(5, 7)) };
  }, [d.items, thisMonth]);
  const [moved, setMoved] = useState(0);
  const at = (() => {
    const total = start.y * 12 + (start.m - 1) + moved;
    return { y: Math.floor(total / 12), m: (total % 12) + 1 };
  })();
  const title = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(at.y, at.m - 1, 1)));
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2024, 0, 1 + i)),
    ),
  );
  return (
    <MonthGrid
      year={at.y}
      month={at.m}
      title={title}
      weekdays={weekdays}
      prevLabel={s["strings.views.calendar.previous"]}
      nextLabel={s["strings.views.calendar.next"]}
      onPrev={() => setMoved((m) => m - 1)}
      onNext={() => setMoved((m) => m + 1)}
      today={`${thisMonth}-${pad(now.getDate())}`}
      items={d.items.map((i) => ({
        key: rowKey(i.row.thread),
        day: i.date.slice(0, 10),
        label: i.row.thread.thread.subject,
        tone: toneOf(props, i.row.lane),
      }))}
      onPick={(key) => {
        const i = d.items.find((x) => rowKey(x.row.thread) === key);
        if (i) props.open(i.row.thread.id, i.row.thread.row?.message);
      }}
    />
  );
}

function CardsBlock({ props, d }: { props: ViewBlocksProps; d: Extract<Data, { type: "cards" }> }) {
  const words = valueWords(props.settings);
  const ctx = props.base.ctx;
  const actions = blockActions(props.view.doc, d.block);
  return (
    <div className="view-cards" data-component="cards">
      {d.cards.map((c) => (
        <div
          key={rowKey(c.row.thread)}
          className={cx("view-card-item", props.focus === c.row.thread.id && "focus")}
          data-thread={c.row.thread.id}
          data-tone={toneOf(props, c.row.lane)}
        >
          <button
            type="button"
            className="main"
            onClick={() => props.open(c.row.thread.id, c.row.thread.row?.message)}
          >
            <b className="title">
              {formatFieldValue(c.title, undefined, ctx, words) || c.row.thread.thread.subject}
            </b>
            {c.subtitle ? (
              <span className="sub">{formatFieldValue(c.subtitle, undefined, ctx, words)}</span>
            ) : null}
            {c.badges.length ? (
              <span className="badges">
                {c.badges.map((b, i) => {
                  const text = formatFieldValue(b, undefined, ctx, words);
                  return text ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a badge is its column
                    <span key={i} className="view-chip">
                      {text}
                    </span>
                  ) : null;
                })}
              </span>
            ) : null}
            {c.value ? (
              <span className="val">
                {formatFieldValue(c.value, d.block.value_format, ctx, words)}
              </span>
            ) : null}
          </button>
          <RowActions props={props} actions={actions} row={c.row} />
        </div>
      ))}
      {d.cards.length === 0 ? (
        <div className="view-empty">{props.settings["strings.views.block_empty"]}</div>
      ) : null}
    </div>
  );
}

function PeopleBlock({
  props,
  d,
}: {
  props: ViewBlocksProps;
  d: Extract<Data, { type: "people" }>;
}) {
  const s = props.settings;
  const [picked, setPicked] = useState<string | null>(null);
  const person = d.people.find((p) => p.key === picked);
  return (
    <div className="view-people" data-component="people">
      {d.people.map((p) => (
        <button
          key={p.key}
          type="button"
          className={cx("view-person", picked === p.key && "on")}
          data-key={p.key}
          onClick={() => setPicked((c) => (c === p.key ? null : p.key))}
        >
          <b>{p.label}</b>
          <span className="n">{fill(s["strings.views.people.threads"], { count: p.count })}</span>
          <span className="when">{formatListTime(p.last, props.now)}</span>
        </button>
      ))}
      {person ? (
        <div className="view-picked">
          {person.rows.map((r) => (
            <ThreadLine key={rowKey(r.thread)} props={props} row={r} actions={[]} />
          ))}
        </div>
      ) : null}
      {d.people.length === 0 ? (
        <div className="view-empty">{s["strings.views.block_empty"]}</div>
      ) : null}
    </div>
  );
}

function ChecklistBlock({
  props,
  d,
}: {
  props: ViewBlocksProps;
  d: Extract<Data, { type: "checklist" }>;
}) {
  const s = props.settings;
  const words = valueWords(s);
  const [showDone, setShowDone] = useState(false);
  const actions = blockActions(props.view.doc, d.block);
  const open = d.items.filter((i) => !i.done);
  const done = d.items.filter((i) => i.done);
  const item = (i: (typeof d.items)[number]) => {
    const text =
      formatFieldValue(i.item, undefined, props.base.ctx, words) || i.row.thread.thread.subject;
    return (
      <div
        key={rowKey(i.row.thread)}
        className={cx("view-check", i.done && "done")}
        data-thread={i.row.thread.id}
      >
        <input
          type="checkbox"
          checked={i.done}
          aria-label={text}
          onChange={(e) =>
            props.onDone?.(i.row.thread.id, e.currentTarget.checked, i.row.thread.messageCount)
          }
        />
        <button
          type="button"
          className="txt"
          onClick={() => props.open(i.row.thread.id, i.row.thread.row?.message)}
        >
          {text}
          <span className="who">
            {i.row.thread.thread.participants[0]?.name || i.row.thread.from}
          </span>
        </button>
        <RowActions props={props} actions={actions} row={i.row} />
      </div>
    );
  };
  return (
    <div className="view-checklist" data-component="checklist">
      {open.map(item)}
      {done.length ? (
        <>
          <button
            type="button"
            className="view-done-toggle"
            aria-expanded={showDone}
            onClick={() => setShowDone((v) => !v)}
          >
            {fill(s["strings.views.checklist.done_count"], { count: done.length })}
          </button>
          {showDone ? done.map(item) : null}
        </>
      ) : null}
      {d.items.length === 0 ? (
        <div className="view-empty">{s["strings.views.block_empty"]}</div>
      ) : null}
    </div>
  );
}

function HeatmapBlock({
  props,
  d,
}: {
  props: ViewBlocksProps;
  d: Extract<Data, { type: "heatmap" }>;
}) {
  const s = props.settings;
  return (
    <Heatmap
      rows={d.rowLabels}
      cols={d.colLabels}
      cells={d.cells}
      max={d.max}
      label={d.block.title ?? ""}
      cellTitle={(r, c, n) =>
        fill(s["strings.views.heatmap.title"], {
          when: `${d.rowLabels[r] ?? ""} ${d.colLabels[c] ?? ""}`,
          count: n,
        })
      }
    />
  );
}

function blockBody(props: ViewBlocksProps, d: Data): ReactNode {
  switch (d.type) {
    case "lanes":
      return <LanesBlock props={props} d={d} />;
    case "list":
      return <ListBlock props={props} d={d} />;
    case "counts":
      return <CountsBlock props={props} d={d} />;
    case "table":
      return <TableBlock props={props} d={d} />;
    case "stat":
      return <StatBlock props={props} d={d} />;
    case "chart":
      return <ChartBlock props={props} d={d} />;
    case "timeline":
      return <TimelineBlock props={props} d={d} />;
    case "calendar":
      return <CalendarBlock props={props} d={d} />;
    case "cards":
      return <CardsBlock props={props} d={d} />;
    case "people":
      return <PeopleBlock props={props} d={d} />;
    case "checklist":
      return <ChecklistBlock props={props} d={d} />;
    case "heatmap":
      return <HeatmapBlock props={props} d={d} />;
    case "text":
      return (
        <p className="view-note" data-tone={d.block.tone}>
          {d.block.text}
        </p>
      );
  }
}

/** The View's Blocks, in document order, in a grid by their widths. */
export function ViewBlocks(props: ViewBlocksProps) {
  const s = props.settings;
  const only = props.data.length === 1;
  return (
    <div className={cx("view-grid", only && "only")}>
      {props.data.map((d) => {
        const b: ViewBlock = d.block;
        const unsure = "unsure" in d ? d.unsure : 0;
        const showTitle = Boolean(b.title) && d.type !== "stat" && d.type !== "text";
        return (
          <section
            key={b.id}
            className="view-block"
            data-block={b.id}
            data-type={d.type}
            data-width={b.width ?? (only ? "full" : d.type === "stat" ? "third" : "full")}
            aria-label={b.title || undefined}
          >
            {showTitle ? <h3 className="view-block-h">{b.title}</h3> : null}
            {blockBody(props, d)}
            {unsure > 0 ? (
              <div className="view-unsure">
                {fill(s["strings.views.unsure_count"], { count: unsure })}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
