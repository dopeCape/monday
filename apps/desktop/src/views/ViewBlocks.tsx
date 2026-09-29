// The component catalog (docs/spec/views.md, "The component catalog"): the
// View document names a component and fills its typed props; monday renders
// it, the Agent never writes markup. lanes (columns side by side, Unsure
// last), list (one list with a heading per Lane), counts (one line of Lane
// counts, each a button that filters), table (columns of Facts and Signals)
// and timeline (Threads placed by a date Fact, Lanes as colours). Rows are
// the Inbox's own Thread rows, so every row action, key and the multi-select
// work on them; a row can be dragged to another Lane or moved with Move to.

import type {
  LaneColumn,
  LaneLayout,
  LaneView,
  RowField,
  Settings,
  TableColumn,
  Thread,
  ViewDoc,
  ViewFact,
} from "@monday/shared";
import { laneBlockOf, readingOf, UNSURE_LANE, VIEW_FACTS } from "@monday/shared";
import { cx, formatListTime } from "@monday/ui";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react";
import { type DragEvent, type ReactNode, useState } from "react";
import { carriesThreads, readThreadDrag } from "../agent/aui/mentions.tsx";
import { Picker } from "../screens/inbox/Picker.tsx";
import type { CachedViewThread } from "../store/views.ts";

export interface ViewBlocksProps {
  doc: ViewDoc;
  result: LaneView<CachedViewThread>;
  settings: Settings;
  now: Date;
  /** The Inbox's row for a Thread. */
  row(thread: Thread): ReactNode;
  focus: string | null;
  open(threadId: string): void;
  /** A Thread moved to another Lane by hand; null takes the user's placement back. */
  onMove?: ((threadId: string, lane: string | null) => void) | undefined;
  /** The Lane the counts component filters to. */
  countsLane?: string | undefined;
  onCountsLane?: ((lane: string) => void) | undefined;
}

/** The Threads the component shows, in its order: what the keyboard walks. */
/** The View's Lane Block as the old layout shape these components draw. */
export function layoutOf(doc: ViewDoc): LaneLayout {
  const b = laneBlockOf(doc);
  switch (b?.type) {
    case "list":
      return {
        component: "list",
        ...(b.row ? { row: b.row as { fields: RowField[] } } : {}),
        ...(b.sort ? { sort: b.sort } : {}),
      };
    case "counts":
      return { component: "counts", ...(b.lanes ? { lanes: b.lanes } : {}) };
    case "table":
      return {
        component: "table",
        columns: b.columns.map((c) =>
          c.field.startsWith("signal:")
            ? { label: c.label, signal: c.field.slice("signal:".length) }
            : c.field in VIEW_FACTS
              ? { label: c.label, fact: c.field as ViewFact }
              : { label: c.label, field: c.field as RowField },
        ),
      };
    case "timeline":
      return {
        component: "timeline",
        date: (["deadline_at", "received_at"].includes(b.date) ? b.date : "last_activity_at") as
          | "deadline_at"
          | "received_at"
          | "last_activity_at",
      };
    case "lanes":
      return {
        component: "lanes",
        ...(b.row ? { row: b.row as { fields: RowField[] } } : {}),
        ...(b.sort ? { sort: b.sort } : {}),
        ...(b.collapse_empty !== undefined ? { collapse_empty: b.collapse_empty } : {}),
      };
    default:
      return { component: "list" };
  }
}

export function orderedThreads(
  doc: ViewDoc,
  result: LaneView<CachedViewThread>,
  countsLane?: string,
): Thread[] {
  const lanes = result.lanes;
  if (layoutOf(doc).component === "counts") {
    const lane = lanes.find((l) => l.id === (countsLane ?? lanes[0]?.id)) ?? lanes[0];
    return (lane?.rows ?? []).map((r) => r.thread.thread);
  }
  if (layoutOf(doc).component === "timeline") {
    return timelineRows(doc, result).map((r) => r.thread.thread);
  }
  return lanes.flatMap((l) => l.rows.map((r) => r.thread.thread));
}

function timelineRows(doc: ViewDoc, result: LaneView<CachedViewThread>) {
  const layout = layoutOf(doc);
  const field = layout.component === "timeline" ? layout.date : "last_activity_at";
  const dateOf = (t: CachedViewThread) => {
    const v =
      field === "last_activity_at"
        ? t.lastActivity
        : field === "received_at"
          ? (t.receivedAt ?? t.lastActivity)
          : (t.facts?.deadline_at as string | undefined);
    return typeof v === "string" ? Date.parse(v) : Number.NaN;
  };
  return result.lanes
    .flatMap((l) => l.rows.map((r) => ({ ...r, lane: l, at: dateOf(r.thread) })))
    .filter((r) => !Number.isNaN(r.at))
    .sort((a, b) => a.at - b.at);
}

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

/** One row with its Move to: the Inbox's row, and a small button that picks another Lane. */
function ViewRow({
  props,
  thread,
  lane,
  byUser,
}: {
  props: ViewBlocksProps;
  thread: CachedViewThread;
  lane: string;
  byUser: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const s = props.settings;
  const lanes = [
    ...props.doc.lanes.map((l) => ({ key: l.id, label: l.label })),
    { key: UNSURE_LANE, label: s["strings.views.unsure"] },
  ].filter((l) => l.key !== lane);
  return (
    <div className={cx("view-row", byUser && "by-user")} data-thread={thread.id} data-lane={lane}>
      {props.row(thread.thread)}
      {props.onMove ? (
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

function LaneRows({ props, lane }: { props: ViewBlocksProps; lane: LaneColumn<CachedViewThread> }) {
  const s = props.settings;
  if (lane.rows.length === 0)
    return <div className="view-empty">{s["strings.views.lane_empty"]}</div>;
  const notRead = lane.id === UNSURE_LANE ? lane.rows.filter((r) => r.placement.notRead) : [];
  const unsure =
    lane.id === UNSURE_LANE ? lane.rows.filter((r) => !r.placement.notRead) : lane.rows;
  return (
    <>
      {unsure.map((r) => (
        <ViewRow
          key={r.thread.id}
          props={props}
          thread={r.thread}
          lane={lane.id}
          byUser={r.placement.byUser}
        />
      ))}
      {notRead.length ? (
        <>
          <div className="view-sub">{s["strings.views.not_read"]}</div>
          {notRead.map((r) => (
            <ViewRow
              key={r.thread.id}
              props={props}
              thread={r.thread}
              lane={lane.id}
              byUser={false}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

function LaneHead({ lane }: { lane: LaneColumn<CachedViewThread> }) {
  return (
    <div className="view-lane-h" data-tone={lane.tone}>
      <span className="dot" aria-hidden="true" />
      <b>{lane.label}</b>
      <span className="n">{lane.rows.length}</span>
    </div>
  );
}

function cell(props: ViewBlocksProps, thread: CachedViewThread, col: TableColumn): string {
  const { doc, now, settings: s } = props;
  if (col.signal) {
    const r = readingOf(doc, thread, col.signal);
    if (!r) return s["strings.views.not_read"];
    if (r.noul !== undefined && r.noul !== null) return `${Math.round(r.noul * 100)}%`;
    if (r.choice) return r.choice;
    if (r.score !== undefined && r.score !== null) return r.score.toFixed(1);
    return "";
  }
  if (col.field) {
    switch (col.field) {
      case "sender":
        return thread.thread.participants[0]?.name || thread.from || "";
      case "subject":
        return thread.thread.subject;
      case "snippet":
        return thread.thread.snippet;
      case "age":
      case "time":
        return formatListTime(thread.lastActivity, now);
      case "group":
        return thread.group ?? "";
      case "deadline": {
        const d = thread.facts?.deadline_at;
        return typeof d === "string" ? formatListTime(d, now) : "";
      }
      default:
        return "";
    }
  }
  if (col.fact) {
    const v =
      col.fact === "message_count"
        ? thread.messageCount
        : col.fact === "last_activity_at"
          ? thread.lastActivity
          : col.fact === "received_at"
            ? (thread.receivedAt ?? thread.lastActivity)
            : thread.facts?.[col.fact];
    if (v === undefined || v === null) return "";
    const kind = VIEW_FACTS[col.fact];
    if (col.format === "date" || kind === "date") return formatListTime(String(v), now);
    if (col.format === "percent" && typeof v === "number") return `${Math.round(v * 100)}%`;
    if (typeof v === "boolean") return v ? "✓" : "";
    return String(v);
  }
  return "";
}

/** One View, drawn by its component. */
export function ViewBlocks(props: ViewBlocksProps) {
  const { doc, result, settings: s } = props;
  const layout = layoutOf(doc);
  if (layout.component === "lanes") {
    return (
      <div className="view-lanes" data-component="lanes">
        {result.lanes.map((lane) => {
          const folded = layout.collapse_empty && lane.rows.length === 0;
          return (
            <section
              key={lane.id}
              className={cx("view-lane", folded && "folded")}
              data-lane={lane.id}
              data-tone={lane.tone}
              aria-label={lane.label}
              {...dropTarget(lane.id, props.onMove)}
            >
              <LaneHead lane={lane} />
              {folded ? null : <LaneRows props={props} lane={lane} />}
            </section>
          );
        })}
      </div>
    );
  }
  if (layout.component === "list") {
    return (
      <div className="view-list" data-component="list">
        {result.lanes.map((lane) => (
          <section
            key={lane.id}
            className="view-group"
            data-lane={lane.id}
            data-tone={lane.tone}
            aria-label={lane.label}
            {...dropTarget(lane.id, props.onMove)}
          >
            <LaneHead lane={lane} />
            <LaneRows props={props} lane={lane} />
          </section>
        ))}
      </div>
    );
  }
  if (layout.component === "counts") {
    const shown = layout.lanes?.length
      ? result.lanes.filter((l) => layout.lanes?.includes(l.id))
      : result.lanes;
    const current = shown.find((l) => l.id === props.countsLane) ?? shown[0];
    return (
      <div className="view-counts-result" data-component="counts">
        <div className="view-counts" role="tablist">
          {shown.map((lane) => (
            <button
              key={lane.id}
              type="button"
              role="tab"
              aria-selected={lane.id === current?.id}
              className={cx("view-count", lane.id === current?.id && "on")}
              data-tone={lane.tone}
              data-lane={lane.id}
              onClick={() => props.onCountsLane?.(lane.id)}
            >
              <span className="dot" aria-hidden="true" />
              {lane.label}
              <b>{lane.rows.length}</b>
            </button>
          ))}
        </div>
        {current ? <LaneRows props={props} lane={current} /> : null}
      </div>
    );
  }
  if (layout.component === "table") {
    const columns: TableColumn[] = layout.columns;
    return (
      <div className="view-table" data-component="table">
        <div className="view-tr head">
          <span>{s["strings.views.column.thread"]}</span>
          {columns.map((c) => (
            <span key={c.label}>{c.label}</span>
          ))}
        </div>
        {result.lanes.flatMap((lane) =>
          lane.rows.map((r) => (
            <button
              key={r.thread.id}
              type="button"
              className={cx("view-tr", props.focus === r.thread.id && "focus")}
              data-thread={r.thread.id}
              data-tone={lane.tone}
              onClick={() => props.open(r.thread.id)}
            >
              <span className="t">
                <span className="dot" aria-hidden="true" />
                <b>{r.thread.thread.subject}</b>
                <span className="who">
                  {r.thread.thread.participants[0]?.name || r.thread.from}
                </span>
              </span>
              {columns.map((c) => (
                <span key={c.label}>{cell(props, r.thread, c)}</span>
              ))}
            </button>
          )),
        )}
      </div>
    );
  }
  // timeline
  const rows = timelineRows(doc, result);
  const days = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = new Date(r.at).toDateString();
    days.set(key, [...(days.get(key) ?? []), r]);
  }
  return (
    <div className="view-timeline" data-component="timeline">
      {[...days.entries()].map(([day, list]) => (
        <section key={day} className="view-day">
          <div className="view-day-h">
            {formatListTime(new Date(list[0]?.at ?? 0).toISOString(), props.now)}
          </div>
          {list.map((r) => (
            <button
              key={r.thread.id}
              type="button"
              className={cx("view-tr", props.focus === r.thread.id && "focus")}
              data-thread={r.thread.id}
              data-tone={r.lane.tone}
              title={r.lane.label}
              onClick={() => props.open(r.thread.id)}
            >
              <span className="t">
                <span className="dot" aria-hidden="true" />
                <b>{r.thread.thread.subject}</b>
                <span className="who">
                  {r.thread.thread.participants[0]?.name || r.thread.from}
                </span>
              </span>
              <span className="lane">{r.lane.label}</span>
            </button>
          ))}
        </section>
      ))}
      {rows.length === 0 ? <div className="view-empty">{s["strings.views.lane_empty"]}</div> : null}
    </div>
  );
}
