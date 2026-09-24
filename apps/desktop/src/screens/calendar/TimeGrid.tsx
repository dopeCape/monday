// The Day and Week views: a sticky row of day heads, the all-day row with
// multi-day bars in lanes, and the 24-hour grid under them with working
// hours left clear and the rest shaded, the current-time line, overlapping
// Events side by side, and an optional second time zone. Press and drag on
// empty time to make an Event; drag an Event to move it (across days too);
// drag its bottom edge to resize it; everything snaps to the
// calendar.snap_minutes Setting. A press that never moves past the
// calendar.drag_threshold_px Setting is a click: it opens the Event or makes
// one of the default length.

import type { Settings } from "@monday/shared";
import { clock, WEEKDAY_SHORT } from "@monday/ui";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Occurrence } from "./calendar-data.ts";
import {
  addDays,
  addMinutes,
  atMinutes,
  clockIn,
  isoWeek,
  minutesOfDay,
  sameDay,
  snap,
  startOfDay,
  WEEKDAY_KEYS,
  zoneLabel,
} from "./dates.ts";
import { allDayLanes, inAllDayRow, layoutDay } from "./layout.ts";
import { type AddressOf, toneOf, whoOf } from "./model.ts";
import type { AnchorRect } from "./overlay.tsx";

export interface Slot {
  start: Date;
  end: Date;
  allDay: boolean;
}

export interface TimeGridProps {
  days: readonly Date[];
  items: readonly Occurrence[];
  now: Date;
  s: Settings;
  colors: ReadonlyMap<string, string>;
  /** The Event whose detail is open, outlined. */
  selectedKey: string | null;
  /** The slot a quick create is open on, drawn as a ghost Event. */
  ghost: Slot | null;
  addressOf: AddressOf;
  editable: (o: Occurrence) => boolean;
  onCreate: (slot: Slot, rect: AnchorRect) => void;
  onOpen: (o: Occurrence, rect: AnchorRect) => void;
  onMove: (o: Occurrence, start: Date, end: Date) => void;
  onPickDay: (day: Date) => void;
  /** Changes when the view or its days do, so the grid scrolls to the working day again. */
  scrollKey: string;
}

type Drag =
  | { kind: "create"; day: number; min: number; curDay: number; curMin: number; moved: boolean }
  | {
      kind: "move";
      occ: Occurrence;
      el: HTMLElement;
      day: number;
      min: number;
      start: Date;
      end: Date;
      moved: boolean;
      allDay: boolean;
      /** Not the user's to move: a press only opens it. */
      locked: boolean;
    }
  | { kind: "resize"; occ: Occurrence; start: Date; end: Date; moved: boolean };

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function TimeGrid({
  days,
  items,
  now,
  s,
  colors,
  selectedKey,
  ghost,
  addressOf,
  editable,
  onCreate,
  onOpen,
  onMove,
  onPickDay,
  scrollKey,
}: TimeGridProps) {
  const hour = s["calendar.hour_height"];
  const step = s["calendar.snap_minutes"];
  const threshold = s["calendar.drag_threshold_px"];
  const workStart = s["calendar.day_start_hour"];
  const workEnd = Math.max(workStart + 1, s["calendar.day_end_hour"]);
  const workDays = new Set<string>(s["calendar.work_days"]);
  const second = s["calendar.secondary_time_zone"].trim();
  const secondOk = second !== "" && clockIn(second, now) !== null;
  const scroller = useRef<HTMLDivElement | null>(null);
  const cols = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const origin = useRef<{ x: number; y: number } | null>(null);

  const timed = useMemo(() => days.map((d) => layoutDay(items, d)), [days, items]);
  const lanes = useMemo(() => allDayLanes(items, days), [items, days]);
  const laneCount = lanes.reduce((n, l) => Math.max(n, l.lane + 1), 0);

  // Open on the working day, or on now when it falls outside it today.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the days or the view change, not on every tick of the clock
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const showsToday = days.some((d) => sameDay(d, now));
    const nowHour = now.getHours();
    const target =
      showsToday && (nowHour < workStart || nowHour >= workEnd)
        ? Math.max(0, nowHour - 2)
        : workStart;
    el.scrollTop = Math.max(0, target * hour - 8);
  }, [scrollKey, hour]);

  /** The day column and minutes under a pointer. */
  const pointAt = (x: number, y: number): { day: number; min: number } | null => {
    const root = cols.current;
    if (!root) return null;
    const columns = [...root.querySelectorAll<HTMLElement>(":scope > .cal-tg-col")];
    if (columns.length === 0) return null;
    let day = columns.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return x >= r.left && x < r.right;
    });
    const first = columns[0]?.getBoundingClientRect();
    const last = columns[columns.length - 1]?.getBoundingClientRect();
    if (day < 0) day = first && x < first.left ? 0 : columns.length - 1;
    const top = (first ?? last)?.top ?? 0;
    const min = Math.min(24 * 60, Math.max(0, ((y - top) / hour) * 60));
    return { day, min };
  };

  const colRect = (day: number, fromMin: number, toMin: number): AnchorRect => {
    const col = cols.current?.querySelectorAll<HTMLElement>(":scope > .cal-tg-col")[day];
    const r = col?.getBoundingClientRect();
    if (!r) return { left: 0, top: 0, width: 0, height: 0 };
    return {
      left: r.left,
      top: r.top + (fromMin / 60) * hour,
      width: r.width,
      height: Math.max(12, ((toMin - fromMin) / 60) * hour),
    };
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: bound once per drag; the handlers read the latest drag through the ref
  useEffect(() => {
    if (!drag) return;
    const onMovePointer = (e: PointerEvent) => {
      const d = dragRef.current;
      const o = origin.current;
      if (!d || !o) return;
      const far = Math.hypot(e.clientX - o.x, e.clientY - o.y) >= threshold;
      const p = pointAt(e.clientX, e.clientY);
      if (!p) return;
      if (d.kind === "create") {
        if (!far && !d.moved) return;
        setDrag({ ...d, curDay: p.day, curMin: p.min, moved: true });
      } else if (d.kind === "move") {
        if (d.locked || (!far && !d.moved)) return;
        const dDay = p.day - d.day;
        const dMin = d.allDay ? 0 : snap(p.min - d.min, step);
        const base = new Date(Date.parse(d.occ.start));
        const start = addMinutes(addDays(base, dDay), dMin);
        const length = Date.parse(d.occ.end) - Date.parse(d.occ.start);
        setDrag({ ...d, start, end: new Date(start.getTime() + length), moved: true });
      } else {
        if (!far && !d.moved) return;
        const day = days[p.day];
        if (!day) return;
        const at = atMinutes(day, snap(p.min, step));
        const min = addMinutes(d.start, step);
        setDrag({ ...d, end: at.getTime() < min.getTime() ? min : at, moved: true });
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      origin.current = null;
      if (!d) return;
      if (d.kind === "create") {
        const day = days[d.day];
        if (!day) return;
        if (!d.moved) {
          const from = Math.floor(d.min / step) * step;
          const start = atMinutes(day, from);
          const length = s["calendar.default_duration_minutes"];
          onCreate(
            { start, end: addMinutes(start, length), allDay: false },
            colRect(d.day, from, from + length),
          );
          return;
        }
        const a = Math.floor(Math.min(d.min, d.curMin) / step) * step;
        const b = Math.max(a + step, Math.ceil(Math.max(d.min, d.curMin) / step) * step);
        onCreate(
          { start: atMinutes(day, a), end: atMinutes(day, b), allDay: false },
          colRect(d.day, a, b),
        );
        return;
      }
      if (d.kind === "move") {
        if (!d.moved) {
          const r = d.el.getBoundingClientRect();
          onOpen(d.occ, { left: r.left, top: r.top, width: r.width, height: r.height });
          return;
        }
        if (d.start.getTime() !== Date.parse(d.occ.start)) onMove(d.occ, d.start, d.end);
        return;
      }
      if (d.moved && d.end.getTime() !== Date.parse(d.occ.end)) onMove(d.occ, d.start, d.end);
    };
    window.addEventListener("pointermove", onMovePointer);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMovePointer);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag !== null]);

  const pressGrid = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".cal-ev")) return;
    const p = pointAt(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    origin.current = { x: e.clientX, y: e.clientY };
    setDrag({ kind: "create", day: p.day, min: p.min, curDay: p.day, curMin: p.min, moved: false });
  };

  const pressEvent = (e: ReactPointerEvent<HTMLElement>, o: Occurrence, allDay: boolean) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget;
    origin.current = { x: e.clientX, y: e.clientY };
    const resize = (e.target as HTMLElement).classList.contains("cal-ev-resize");
    const locked = !editable(o);
    e.preventDefault();
    if (resize && !locked) {
      setDrag({
        kind: "resize",
        occ: o,
        start: new Date(o.start),
        end: new Date(o.end),
        moved: false,
      });
      return;
    }
    const p = allDay ? allDayPoint(e.clientX) : pointAt(e.clientX, e.clientY);
    setDrag({
      kind: "move",
      occ: o,
      el,
      day: p?.day ?? 0,
      min: p?.min ?? 0,
      start: new Date(o.start),
      end: new Date(o.end),
      moved: false,
      allDay,
      locked,
    });
  };

  /** The day under a pointer in the all-day row (the grid's columns line up with it). */
  const allDayPoint = (x: number) => pointAt(x, 0);

  const pressAllDay = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".cal-ev")) return;
    const p = pointAt(e.clientX, 0);
    const day = p ? days[p.day] : undefined;
    if (!p || !day) return;
    const cell = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const width = cell.width / days.length;
    onCreate(
      { start: startOfDay(day), end: addDays(startOfDay(day), 1), allDay: true },
      { left: cell.left + p.day * width, top: cell.top, width, height: cell.height },
    );
  };

  // What the drag shows in place of the Event it moves.
  const moving = drag && drag.kind !== "create" && drag.moved ? drag : null;
  const shownItems = moving
    ? items.map((o) =>
        o.key === moving.occ.key
          ? { ...o, start: moving.start.toISOString(), end: moving.end.toISOString() }
          : o,
      )
    : items;
  const shownTimed = moving ? days.map((d) => layoutDay(shownItems, d)) : timed;
  const shownLanes = moving ? allDayLanes(shownItems, days) : lanes;

  const creating =
    drag && drag.kind === "create" && drag.moved
      ? (() => {
          const a = Math.floor(Math.min(drag.min, drag.curMin) / step) * step;
          const b = Math.max(a + step, Math.ceil(Math.max(drag.min, drag.curMin) / step) * step);
          return { day: drag.day, from: a, to: b };
        })()
      : null;
  const ghostTimed =
    creating ??
    (ghost && !ghost.allDay
      ? (() => {
          const day = days.findIndex((d) => sameDay(d, ghost.start));
          if (day < 0) return null;
          const to = sameDay(ghost.end, ghost.start) ? minutesOfDay(ghost.end) : 24 * 60;
          return { day, from: minutesOfDay(ghost.start), to };
        })()
      : null);
  const ghostAllDay = ghost?.allDay ? days.findIndex((d) => sameDay(d, ghost.start)) : -1;

  const gutter = secondOk ? 112 : 56;
  const style = {
    "--hour": `${hour}px`,
    "--days": days.length,
    "--gutter": `${gutter}px`,
  } as CSSProperties;
  const weekNo = s["calendar.week_numbers"] && days[0] ? isoWeek(days[0]) : null;
  const nowMin = minutesOfDay(now);
  const fill = (t: string, vars: Record<string, string | number>) =>
    t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

  return (
    <div className={`cal-tg${drag?.moved ? " dragging" : ""}`} style={style} ref={scroller}>
      <div className="cal-tg-head">
        <div className="cal-tg-corner">
          {weekNo !== null ? (
            <span className="cal-weekno">
              {fill(s["strings.calendar.week_short"], { n: weekNo })}
            </span>
          ) : null}
          {secondOk ? (
            <span className="cal-tz-heads">
              <i>{zoneLabel(second, now)}</i>
              <i>{zoneLabel(Intl.DateTimeFormat().resolvedOptions().timeZone, now)}</i>
            </span>
          ) : null}
        </div>
        {days.map((d) => (
          <button
            type="button"
            key={d.toISOString()}
            className={`cal-tg-dh${sameDay(d, now) ? " today" : ""}${d < startOfDay(now) ? " past" : ""}`}
            onClick={() => onPickDay(d)}
            title={s["strings.calendar.open_day"]}
          >
            <span>{WEEKDAY_SHORT[d.getDay()]}</span>
            <b>{d.getDate()}</b>
          </button>
        ))}
      </div>
      <div className="cal-tg-allday">
        <div className="cal-tg-corner cal-allday-label">{s["strings.calendar.all_day"]}</div>
        <div
          className="cal-allday-cells"
          style={{ "--lanes": Math.max(1, laneCount) } as CSSProperties}
          onPointerDown={pressAllDay}
        >
          {days.map((d, i) => (
            <div
              key={d.toISOString()}
              className={`cal-allday-cell${sameDay(d, now) ? " today" : ""}${ghostAllDay === i ? " ghosted" : ""}`}
              style={{ gridColumn: i + 1 }}
            />
          ))}
          {shownLanes.map((l) => (
            <button
              type="button"
              key={l.occ.key}
              className={`cal-ev cal-bar ${toneOf(l.occ, now)}${selectedKey === l.occ.key ? " on" : ""}${moving?.occ.key === l.occ.key ? " moving" : ""}${l.continuesBefore ? " cont-l" : ""}${l.continuesAfter ? " cont-r" : ""}`}
              style={
                {
                  "--ev": colors.get(l.occ.calendarId) ?? "var(--fg-muted)",
                  gridColumn: `${l.from + 1} / ${l.to + 2}`,
                  gridRow: l.lane + 1,
                } as CSSProperties
              }
              onPointerDown={(e) => pressEvent(e, l.occ, true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  onOpen(l.occ, { left: r.left, top: r.top, width: r.width, height: r.height });
                }
              }}
            >
              {!l.occ.allDay ? <em>{clock(new Date(l.occ.start))}</em> : null}
              {l.occ.title || s["strings.calendar.untitled"]}
            </button>
          ))}
        </div>
      </div>
      <div className="cal-tg-body" onPointerDown={pressGrid}>
        <div className="cal-tg-gutter" aria-hidden="true">
          {HOURS.map((h) => (
            <div key={h} className="cal-tg-hour">
              {h === 0 ? null : (
                <>
                  {secondOk ? <i>{clockIn(second, atMinutes(days[0] ?? now, h * 60))}</i> : null}
                  <span>{`${String(h).padStart(2, "0")}:00`}</span>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="cal-tg-cols" ref={cols}>
          {days.map((d, i) => {
            const working = workDays.has(WEEKDAY_KEYS[d.getDay()] ?? "");
            const today = sameDay(d, now);
            return (
              <div
                key={d.toISOString()}
                className={`cal-tg-col${today ? " today" : ""}${working ? "" : " off"}`}
                data-day={i}
              >
                {working ? (
                  <>
                    <div className="cal-off" style={{ top: 0, height: workStart * hour }} />
                    <div
                      className="cal-off"
                      style={{ top: workEnd * hour, height: (24 - workEnd) * hour }}
                    />
                  </>
                ) : null}
                {shownTimed[i]?.map((p) => {
                  const o = p.occ;
                  const top = (p.top / 60) * hour;
                  const height = Math.max(hour / 4 - 2, ((p.bottom - p.top) / 60) * hour - 2);
                  const short = height < 34;
                  const who = whoOf(o, addressOf);
                  const selected = selectedKey === o.key;
                  return (
                    <button
                      type="button"
                      key={o.key}
                      aria-label={`${o.title || s["strings.calendar.untitled"]}, ${clock(new Date(o.start))} ${s["strings.calendar.to"]} ${clock(new Date(o.end))}`}
                      className={`cal-ev cal-block ${toneOf(o, now)}${selected ? " on" : ""}${short ? " short" : ""}${moving?.occ.key === o.key ? " moving" : ""}${p.clippedStart ? " cut-t" : ""}${p.clippedEnd ? " cut-b" : ""}`}
                      style={
                        {
                          "--ev": colors.get(o.calendarId) ?? "var(--fg-muted)",
                          top,
                          height,
                          left: `calc(${p.left * 100}% + 2px)`,
                          width: `calc(${p.width * 100}% - 4px)`,
                          zIndex: selected || moving?.occ.key === o.key ? 5 : 1 + p.column,
                        } as CSSProperties
                      }
                      onPointerDown={(e) => pressEvent(e, o, false)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          const r = e.currentTarget.getBoundingClientRect();
                          onOpen(o, { left: r.left, top: r.top, width: r.width, height: r.height });
                        }
                      }}
                    >
                      <b>{o.title || s["strings.calendar.untitled"]}</b>
                      <span className="cal-ev-time">
                        {clock(new Date(o.start))}
                        {short ? "" : ` ${s["strings.calendar.to"]} ${clock(new Date(o.end))}`}
                      </span>
                      {!short && height >= 56 ? (
                        <span className="cal-ev-more">
                          {o.createdByAgent ? s["strings.calendar.by_agent"] : o.location || who}
                        </span>
                      ) : null}
                      {editable(o) && !p.clippedEnd ? <span className="cal-ev-resize" /> : null}
                    </button>
                  );
                })}
                {ghostTimed && ghostTimed.day === i ? (
                  <div
                    className="cal-ghost"
                    style={{
                      top: (ghostTimed.from / 60) * hour,
                      height:
                        Math.max(hour / 4, ((ghostTimed.to - ghostTimed.from) / 60) * hour) - 2,
                    }}
                  >
                    <span>
                      {clock(atMinutes(d, ghostTimed.from))} {s["strings.calendar.to"]}{" "}
                      {clock(atMinutes(d, ghostTimed.to))}
                    </span>
                  </div>
                ) : null}
                {today ? (
                  <div
                    className="cal-now"
                    style={{ top: (nowMin / 60) * hour }}
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export { inAllDayRow };
