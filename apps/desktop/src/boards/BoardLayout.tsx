// The component catalog (docs/spec/boards.md, "The component catalog"): the
// Board document names a component and fills its typed props; monday renders
// it, the Agent never writes markup. lanes (columns side by side, Unsure
// last), list (one list with a heading per Lane), counts (one line of Lane
// counts, each a button that filters), table (columns of Facts and Signals)
// and timeline (Threads placed by a date Fact, Lanes as colours). Rows are
// the Inbox's own Thread rows, so every row action, key and the multi-select
// work on them; a row can be dragged to another Lane or moved with Move to.

import type {
  BoardDoc,
  BoardLaneView,
  BoardView,
  Settings,
  TableColumn,
  Thread,
} from "@monday/shared";
import { BOARD_FACTS, readingOf, UNSURE_LANE } from "@monday/shared";
import { cx, formatListTime } from "@monday/ui";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react";
import { type DragEvent, type ReactNode, useState } from "react";
import { carriesThreads, readThreadDrag } from "../agent/aui/mentions.tsx";
import { Picker } from "../screens/inbox/Picker.tsx";
import type { CachedBoardThread } from "../store/boards.ts";

export interface BoardLayoutProps {
  doc: BoardDoc;
  view: BoardView<CachedBoardThread>;
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
export function orderedThreads(
  doc: BoardDoc,
  view: BoardView<CachedBoardThread>,
  countsLane?: string,
): Thread[] {
  const lanes = view.lanes;
  if (doc.layout.component === "counts") {
    const lane = lanes.find((l) => l.id === (countsLane ?? lanes[0]?.id)) ?? lanes[0];
    return (lane?.rows ?? []).map((r) => r.thread.thread);
  }
  if (doc.layout.component === "timeline") {
    return timelineRows(doc, view).map((r) => r.thread.thread);
  }
  return lanes.flatMap((l) => l.rows.map((r) => r.thread.thread));
}

function timelineRows(doc: BoardDoc, view: BoardView<CachedBoardThread>) {
  const layout = doc.layout;
  const field = layout.component === "timeline" ? layout.date : "last_activity_at";
  const dateOf = (t: CachedBoardThread) => {
    const v =
      field === "last_activity_at"
        ? t.lastActivity
        : field === "received_at"
          ? (t.receivedAt ?? t.lastActivity)
          : (t.facts?.deadline_at as string | undefined);
    return typeof v === "string" ? Date.parse(v) : Number.NaN;
  };
  return view.lanes
    .flatMap((l) => l.rows.map((r) => ({ ...r, lane: l, at: dateOf(r.thread) })))
    .filter((r) => !Number.isNaN(r.at))
    .sort((a, b) => a.at - b.at);
}

/** A Lane accepts a dragged Thread: the move is a correction (docs/spec/boards.md, "Correcting on the Board"). */
function dropTarget(lane: string, onMove: BoardLayoutProps["onMove"]) {
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
function BoardRow({
  props,
  thread,
  lane,
  byUser,
}: {
  props: BoardLayoutProps;
  thread: CachedBoardThread;
  lane: string;
  byUser: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const s = props.settings;
  const lanes = [
    ...props.doc.lanes.map((l) => ({ key: l.id, label: l.label })),
    { key: UNSURE_LANE, label: s["strings.boards.unsure"] },
  ].filter((l) => l.key !== lane);
  return (
    <div className={cx("board-row", byUser && "by-user")} data-thread={thread.id} data-lane={lane}>
      {props.row(thread.thread)}
      {props.onMove ? (
        <button
          type="button"
          className="board-move"
          title={s["strings.boards.move_to"]}
          aria-label={`${s["strings.boards.move_to"]}: ${thread.thread.subject}`}
          onClick={() => setPicking((p) => !p)}
        >
          <ArrowsLeftRightIcon />
        </button>
      ) : null}
      {picking && props.onMove ? (
        <Picker
          className="board-move-pop"
          label={s["strings.boards.move_to"]}
          title={s["strings.boards.move_to"]}
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

function LaneRows({
  props,
  lane,
}: {
  props: BoardLayoutProps;
  lane: BoardLaneView<CachedBoardThread>;
}) {
  const s = props.settings;
  if (lane.rows.length === 0)
    return <div className="board-empty">{s["strings.boards.lane_empty"]}</div>;
  const notRead = lane.id === UNSURE_LANE ? lane.rows.filter((r) => r.placement.notRead) : [];
  const unsure =
    lane.id === UNSURE_LANE ? lane.rows.filter((r) => !r.placement.notRead) : lane.rows;
  return (
    <>
      {unsure.map((r) => (
        <BoardRow
          key={r.thread.id}
          props={props}
          thread={r.thread}
          lane={lane.id}
          byUser={r.placement.byUser}
        />
      ))}
      {notRead.length ? (
        <>
          <div className="board-sub">{s["strings.boards.not_read"]}</div>
          {notRead.map((r) => (
            <BoardRow
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

function LaneHead({ lane }: { lane: BoardLaneView<CachedBoardThread> }) {
  return (
    <div className="board-lane-h" data-tone={lane.tone}>
      <span className="dot" aria-hidden="true" />
      <b>{lane.label}</b>
      <span className="n">{lane.rows.length}</span>
    </div>
  );
}

function cell(props: BoardLayoutProps, thread: CachedBoardThread, col: TableColumn): string {
  const { doc, now, settings: s } = props;
  if (col.signal) {
    const r = readingOf(doc, thread, col.signal);
    if (!r) return s["strings.boards.not_read"];
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
    const kind = BOARD_FACTS[col.fact];
    if (col.format === "date" || kind === "date") return formatListTime(String(v), now);
    if (col.format === "percent" && typeof v === "number") return `${Math.round(v * 100)}%`;
    if (typeof v === "boolean") return v ? "✓" : "";
    return String(v);
  }
  return "";
}

/** One Board, drawn by its component. */
export function BoardLayout(props: BoardLayoutProps) {
  const { doc, view, settings: s } = props;
  const layout = doc.layout;
  if (layout.component === "lanes") {
    return (
      <div className="board-lanes" data-component="lanes">
        {view.lanes.map((lane) => {
          const folded = layout.collapse_empty && lane.rows.length === 0;
          return (
            <section
              key={lane.id}
              className={cx("board-lane", folded && "folded")}
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
      <div className="board-list" data-component="list">
        {view.lanes.map((lane) => (
          <section
            key={lane.id}
            className="board-group"
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
      ? view.lanes.filter((l) => layout.lanes?.includes(l.id))
      : view.lanes;
    const current = shown.find((l) => l.id === props.countsLane) ?? shown[0];
    return (
      <div className="board-counts-view" data-component="counts">
        <div className="board-counts" role="tablist">
          {shown.map((lane) => (
            <button
              key={lane.id}
              type="button"
              role="tab"
              aria-selected={lane.id === current?.id}
              className={cx("board-count", lane.id === current?.id && "on")}
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
      <div className="board-table" data-component="table">
        <div className="board-tr head">
          <span>{s["strings.boards.column.thread"]}</span>
          {columns.map((c) => (
            <span key={c.label}>{c.label}</span>
          ))}
        </div>
        {view.lanes.flatMap((lane) =>
          lane.rows.map((r) => (
            <button
              key={r.thread.id}
              type="button"
              className={cx("board-tr", props.focus === r.thread.id && "focus")}
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
  const rows = timelineRows(doc, view);
  const days = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = new Date(r.at).toDateString();
    days.set(key, [...(days.get(key) ?? []), r]);
  }
  return (
    <div className="board-timeline" data-component="timeline">
      {[...days.entries()].map(([day, list]) => (
        <section key={day} className="board-day">
          <div className="board-day-h">
            {formatListTime(new Date(list[0]?.at ?? 0).toISOString(), props.now)}
          </div>
          {list.map((r) => (
            <button
              key={r.thread.id}
              type="button"
              className={cx("board-tr", props.focus === r.thread.id && "focus")}
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
      {rows.length === 0 ? (
        <div className="board-empty">{s["strings.boards.lane_empty"]}</div>
      ) : null}
    </div>
  );
}
