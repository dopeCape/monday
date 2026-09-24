// The Month view: whole weeks from the one holding the 1st, each day listing
// its Events (all-day and multi-day first, then timed ones by start) up to
// the calendar.month_events_max Setting and "+N more" after. A press on a
// day's empty space makes an all-day Event there; its number opens the Day
// view; an Event opens its detail, and one of the user's own can be dragged
// to another day.

import type { Settings } from "@monday/shared";
import { clock, MONTH_SHORT, WEEKDAY_SHORT } from "@monday/ui";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Occurrence } from "./calendar-data.ts";
import { addDays, daysBetween, isoWeek, sameDay, startOfDay } from "./dates.ts";
import { eventsOnDay, inAllDayRow } from "./layout.ts";
import { toneOf } from "./model.ts";
import type { AnchorRect } from "./overlay.tsx";
import type { Slot } from "./TimeGrid.tsx";

export interface MonthGridProps {
  weeks: readonly (readonly Date[])[];
  month: Date;
  items: readonly Occurrence[];
  now: Date;
  s: Settings;
  colors: ReadonlyMap<string, string>;
  selectedKey: string | null;
  ghostDay: Date | null;
  editable: (o: Occurrence) => boolean;
  onCreate: (slot: Slot, rect: AnchorRect) => void;
  onOpen: (o: Occurrence, rect: AnchorRect) => void;
  onMoveDays: (o: Occurrence, days: number) => void;
  onPickDay: (day: Date) => void;
}

interface Drag {
  occ: Occurrence;
  el: HTMLElement;
  x: number;
  y: number;
  from: Date;
  over: Date | null;
  moved: boolean;
  locked: boolean;
}

function rect(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function MonthGrid({
  weeks,
  month,
  items,
  now,
  s,
  colors,
  selectedKey,
  ghostDay,
  editable,
  onCreate,
  onOpen,
  onMoveDays,
  onPickDay,
}: MonthGridProps) {
  const max = s["calendar.month_events_max"];
  const threshold = s["calendar.drag_threshold_px"];
  const weekNumbers = s["calendar.week_numbers"];
  const mondayFirst = s["calendar.week_starts_monday"];
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const fill = (t: string, vars: Record<string, string | number>) =>
    t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

  const dayUnder = (x: number, y: number): Date | null => {
    const el = document.elementFromPoint?.(x, y)?.closest<HTMLElement>("[data-day]");
    const key = el?.dataset.day;
    return key ? new Date(key) : null;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: bound once per drag; the handlers read the latest through the ref
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.locked) return;
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < threshold) return;
      setDrag({ ...d, over: dayUnder(e.clientX, e.clientY) ?? d.over, moved: true });
    };
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (!d.moved) {
        onOpen(d.occ, rect(d.el));
        return;
      }
      if (d.over) {
        const delta = daysBetween(d.from, d.over);
        if (delta !== 0) onMoveDays(d.occ, delta);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [drag !== null]);

  const press = (e: ReactPointerEvent<HTMLElement>, o: Occurrence, day: Date) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setDrag({
      occ: o,
      el: e.currentTarget,
      x: e.clientX,
      y: e.clientY,
      from: day,
      over: day,
      moved: false,
      locked: !editable(o),
    });
  };

  const heads = mondayFirst ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  return (
    <div
      className={`cal-month${weekNumbers ? " weeknos" : ""}${drag?.moved ? " dragging" : ""}`}
      style={{ "--weeks": weeks.length } as CSSProperties}
    >
      <div className="cal-month-head">
        {weekNumbers ? <span className="cal-mh cal-mh-wk" /> : null}
        {heads.map((d) => (
          <span key={d} className="cal-mh">
            {WEEKDAY_SHORT[d]}
          </span>
        ))}
      </div>
      {weeks.map((week) => (
        <div className="cal-month-week" key={week[0]?.toISOString()}>
          {weekNumbers && week[0] ? (
            <span className="cal-mwk">
              {fill(s["strings.calendar.week_short"], { n: isoWeek(week[0]) })}
            </span>
          ) : null}
          {week.map((day) => {
            const on = eventsOnDay(items, day);
            const shown = on.slice(0, on.length > max ? max - 1 : max);
            const more = on.length - shown.length;
            const outside = day.getMonth() !== month.getMonth();
            const target = drag?.moved && drag.over && sameDay(drag.over, day);
            return (
              <div
                key={day.toISOString()}
                data-day={day.toISOString()}
                className={`cal-mc${sameDay(day, now) ? " today" : ""}${outside ? " outside" : ""}${day < startOfDay(now) ? " past" : ""}${target ? " drop" : ""}${ghostDay && sameDay(ghostDay, day) ? " ghosted" : ""}`}
                onPointerDown={(e) => {
                  if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                  onCreate(
                    { start: startOfDay(day), end: addDays(startOfDay(day), 1), allDay: true },
                    rect(e.currentTarget),
                  );
                }}
              >
                <button
                  type="button"
                  className="cal-md"
                  onClick={() => onPickDay(day)}
                  title={s["strings.calendar.open_day"]}
                >
                  {day.getDate() === 1 ? `${MONTH_SHORT[day.getMonth()]} 1` : day.getDate()}
                </button>
                {shown.map((o) => {
                  const bar = inAllDayRow(o);
                  return (
                    <button
                      type="button"
                      key={o.key}
                      className={`cal-ev cal-me ${bar ? "bar" : "dot"} ${toneOf(o, now)}${selectedKey === o.key ? " on" : ""}${drag?.moved && drag.occ.key === o.key ? " moving" : ""}`}
                      style={
                        { "--ev": colors.get(o.calendarId) ?? "var(--fg-muted)" } as CSSProperties
                      }
                      onPointerDown={(e) => press(e, o, day)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onOpen(o, rect(e.currentTarget));
                        }
                      }}
                    >
                      {bar ? null : <em>{clock(new Date(o.start))}</em>}
                      <span>{o.title || s["strings.calendar.untitled"]}</span>
                    </button>
                  );
                })}
                {more > 0 ? (
                  <button type="button" className="cal-more" onClick={() => onPickDay(day)}>
                    {fill(s["strings.calendar.more"], { n: more })}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
