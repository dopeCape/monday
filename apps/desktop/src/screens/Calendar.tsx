// The Calendar screen (issue 15; design/js/screens/calendar.js): Week, Day,
// Month and Agenda over the Cache's Events, the Today panel and the calendar
// list beside them, an Event added by hand, and "Schedule" handing the
// composer a sentence so the scheduling tool does the rest. Recurring
// masters are expanded on the client. Every string is a Setting
// (strings.calendar.*); the hours shown, the first weekday and whether
// declined Events stay are Settings too.

import type { CalendarEvent, EventInput, Settings } from "@monday/shared";
import {
  AgentBar,
  AgentDock,
  Btn,
  ColHead,
  clock,
  formatDayHeading,
  formatMonth,
  formatSpan,
  Icon,
  Input,
  MONTH_SHORT,
  Seg,
  SideCard,
  Tag,
  Vr,
  WEEKDAY_SHORT,
} from "@monday/ui";
import { CalendarBlankIcon, CaretLeftIcon, CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { type FormEvent, useMemo, useState, useSyncExternalStore } from "react";
import { openExternal } from "../platform/open.ts";
import { useShell } from "../shell/Shell.tsx";
import { type CalendarSource, type Occurrence, occurrencesIn } from "./calendar/calendar-data.ts";
import { fill } from "./inbox/triage.ts";

export type CalendarView = "day" | "week" | "month" | "agenda";

export interface CalendarProps {
  source: CalendarSource;
  /** Opens a meeting link; the system browser by default. */
  onOpenLink?: ((href: string) => void) | undefined;
  /** Hands "Set up a call with ..." to the composer. */
  onAsk?: ((text: string) => void) | undefined;
  onNavigate?: ((target: string) => void) | undefined;
  now?: Date | undefined;
  initialView?: CalendarView | undefined;
}

type Strings = Settings;

const HOUR_PX = 48;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** The first day of the week holding `d`. */
function startOfWeek(d: Date, mondayFirst: boolean): Date {
  const day = startOfDay(d);
  const offset = mondayFirst ? (day.getDay() + 6) % 7 : day.getDay();
  return addDays(day, -offset);
}

function sameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

/** The Events touching a day, in start order. */
function onDay(items: readonly Occurrence[], day: Date): Occurrence[] {
  const from = startOfDay(day).getTime();
  const to = from + 86_400_000;
  return items.filter((o) => Date.parse(o.end) > from && Date.parse(o.start) < to);
}

function eventClass(o: Occurrence): string {
  if (o.createdByAgent) return "ev agent";
  if (o.status === "tentative" || o.response === "needs-action" || o.response === "tentative")
    return "ev tentative";
  if (o.attendees.length <= 1 && !o.link) return "ev busy";
  return "ev";
}

function whoOf(o: Occurrence): string {
  return o.attendees
    .filter((a) => !a.self)
    .map((a) => a.name || a.email)
    .join(", ");
}

/** A datetime-local value for an instant, in the Device's zone. */
function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function Calendar({
  source,
  onAsk,
  onNavigate,
  onOpenLink,
  now: nowProp,
  initialView,
}: CalendarProps) {
  const shell = useShell();
  const open = onOpenLink ?? ((href: string) => void openExternal(href));
  const s: Strings = shell.settings;
  // Just mail (CONTEXT.md "AI level"): no agent bar and no Schedule handoff; the calendar stays.
  const aiOff = s["ai.level"] === "off";
  const now = nowProp ?? new Date();
  const calendars = useSyncExternalStore(source.subscribe, source.calendars, source.calendars);
  const events = useSyncExternalStore(source.subscribe, source.events, source.events);
  const [view, setView] = useState<CalendarView>(initialView ?? "week");
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(now));
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last failed answer from a view, in plain words; cleared by the next answer. */
  const [answerError, setAnswerError] = useState<string | null>(null);
  const mondayFirst = s["calendar.week_starts_monday"];
  const dayStart = s["calendar.day_start_hour"];
  const dayEnd = Math.max(dayStart + 1, s["calendar.day_end_hour"]);
  const showDeclined = s["calendar.show_declined"];

  const range = useMemo(() => {
    if (view === "day") return { from: anchor, to: addDays(anchor, 1) };
    if (view === "week") {
      const from = startOfWeek(anchor, mondayFirst);
      return { from, to: addDays(from, 7) };
    }
    if (view === "month") {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const from = startOfWeek(first, mondayFirst);
      return { from, to: addDays(from, 42) };
    }
    return { from: anchor, to: addDays(anchor, 14) };
  }, [view, anchor, mondayFirst]);

  const items = useMemo(
    () => occurrencesIn(events, calendars, range, { showDeclined }),
    [events, calendars, range, showDeclined],
  );
  const todays = useMemo(
    () =>
      onDay(
        occurrencesIn(
          events,
          calendars,
          { from: startOfDay(now), to: addDays(startOfDay(now), 1) },
          { showDeclined },
        ),
        now,
      ),
    [events, calendars, now, showDeclined],
  );

  const step = (n: number) => {
    if (view === "day") setAnchor(addDays(anchor, n));
    else if (view === "week") setAnchor(addDays(anchor, 7 * n));
    else if (view === "month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
    else setAnchor(addDays(anchor, 14 * n));
  };

  const heading =
    view === "month"
      ? formatMonth(anchor)
      : view === "day"
        ? // One all-day span: it ends at the next midnight, as the calendar counts days.
          formatSpan(anchor.toISOString(), addDays(anchor, 1).toISOString(), true)
        : `${formatMonth(range.from)}${range.from.getMonth() !== addDays(range.to, -1).getMonth() ? ` to ${formatMonth(addDays(range.to, -1))}` : ""}`;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    const start = new Date(String(data.get("start") ?? ""));
    const end = new Date(String(data.get("end") ?? ""));
    if (!title || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    if (end.getTime() <= start.getTime()) {
      setError(s["strings.calendar.form.end_before_start"]);
      return;
    }
    const attendees = String(data.get("attendees") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(p);
        return m ? { name: m[1] ?? "", email: m[2] ?? "" } : { name: "", email: p };
      });
    const input: EventInput = {
      title,
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      attendees,
    };
    try {
      setError(null);
      await source.create(input);
      setAdding(false);
      form.reset();
    } catch (err) {
      setError(
        fill(s["strings.calendar.form.failed"], {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  const respond = (o: Occurrence, response: "accepted" | "tentative" | "declined") => {
    setAnswerError(null);
    source.respond(o.id, response).catch((err: unknown) => {
      setAnswerError(
        fill(s["strings.calendar.answer_failed"], {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  };

  const answerButtons = (o: Occurrence) =>
    o.organizer && !o.attendees.find((a) => a.self)?.organizer && o.response !== "accepted" ? (
      <>
        <Btn sm onClick={() => respond(o, "accepted")}>
          {s["strings.calendar.accept"]}
        </Btn>
        <Btn sm onClick={() => respond(o, "declined")}>
          {s["strings.calendar.decline"]}
        </Btn>
      </>
    ) : null;

  const joinButton = (o: Occurrence) =>
    o.link ? (
      <Btn sm onClick={() => open(o.link as string)}>
        {s["strings.calendar.join"]}
      </Btn>
    ) : null;

  const grid = (days: Date[]) => {
    const hours = Array.from({ length: dayEnd - dayStart }, (_, i) => dayStart + i);
    return (
      <div className="cal-grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <div className="cal-hours">
          {hours.map((h) => (
            <div key={h}>{`${String(h).padStart(2, "0")}:00`}</div>
          ))}
        </div>
        {days.map((day) => {
          const todaysItems = onDay(items, day);
          const allDay = todaysItems.filter((o) => o.allDay);
          const timed = todaysItems.filter((o) => !o.allDay);
          return (
            <div key={day.toISOString()} className={`cal-day${sameDay(day, now) ? " today" : ""}`}>
              <div className="cal-dh">
                {WEEKDAY_SHORT[day.getDay()]} {day.getDate()}
                {allDay.map((o) => (
                  <Tag key={o.key}>{o.title || s["strings.calendar.all_day"]}</Tag>
                ))}
              </div>
              <div className="cal-col">
                {hours.map((h) => (
                  <div key={h} className="cal-slot" />
                ))}
                {timed.map((o) => {
                  const st = new Date(o.start);
                  const en = new Date(o.end);
                  const startH = sameDay(st, day) ? st.getHours() + st.getMinutes() / 60 : dayStart;
                  const endH = sameDay(en, day) ? en.getHours() + en.getMinutes() / 60 : dayEnd;
                  const top = Math.max(0, (startH - dayStart) * HOUR_PX);
                  const height = Math.max(
                    18,
                    (Math.min(endH, dayEnd) - Math.max(startH, dayStart)) * HOUR_PX,
                  );
                  return (
                    <div
                      key={o.key}
                      className={eventClass(o)}
                      style={{ top: `${top}px`, height: `${height}px` }}
                      title={`${o.title} ${formatSpan(o.start, o.end, o.allDay)}`}
                    >
                      <b>{o.title}</b>
                      {o.createdByAgent ? (
                        <span>{s["strings.calendar.by_agent"]}</span>
                      ) : whoOf(o) ? (
                        <span>{whoOf(o)}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const month = () => {
    const days = Array.from({ length: 42 }, (_, i) => addDays(range.from, i));
    return (
      <div className="cal-month">
        {(mondayFirst ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6]).map((d) => (
          <div key={d} className="cal-mh">
            {WEEKDAY_SHORT[d]}
          </div>
        ))}
        {days.map((day) => {
          const on = onDay(items, day);
          const outside = day.getMonth() !== anchor.getMonth();
          return (
            <button
              type="button"
              key={day.toISOString()}
              className={`cal-mc${sameDay(day, now) ? " today" : ""}${outside ? " outside" : ""}`}
              onClick={() => {
                setAnchor(startOfDay(day));
                setView("day");
              }}
            >
              <span className="cal-md">
                {day.getDate() === 1 ? `${MONTH_SHORT[day.getMonth()]} ` : ""}
                {day.getDate()}
              </span>
              {on.slice(0, 3).map((o) => (
                <span key={o.key} className={`cal-me${o.createdByAgent ? " agent" : ""}`}>
                  {o.allDay ? "" : `${clock(new Date(o.start))} `}
                  {o.title}
                </span>
              ))}
              {on.length > 3 ? <span className="cal-more">+{on.length - 3}</span> : null}
            </button>
          );
        })}
      </div>
    );
  };

  const agenda = () => {
    const days: Date[] = [];
    for (let d = range.from; d < range.to; d = addDays(d, 1)) days.push(d);
    const withItems = days
      .map((day) => [day, onDay(items, day)] as const)
      .filter(([, on]) => on.length > 0);
    if (withItems.length === 0) {
      return (
        <div className="agenda">
          <p className="faint">{s["strings.calendar.no_events"]}</p>
        </div>
      );
    }
    return (
      <div className="agenda">
        {withItems.map(([day, on]) => (
          <div key={day.toISOString()}>
            <div className="sec">{formatDayHeading(day, now)}</div>
            {on.map((o) => (
              <div key={o.key} className="ag-row">
                <span className="ag-t">
                  {o.allDay ? s["strings.calendar.all_day"] : clock(new Date(o.start))}
                  <br />
                  <i>{o.allDay ? "" : clock(new Date(o.end))}</i>
                </span>
                <span className="ag-b">
                  <b>{o.title}</b>
                  <span>
                    {[
                      o.link ? linkHost(o.link) : "",
                      whoOf(o),
                      o.createdByAgent ? s["strings.calendar.by_agent"] : "",
                      o.response && o.response !== "accepted" ? answerLabel(s, o.response) : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="ag-a">
                  {joinButton(o)}
                  {answerButtons(o)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  const body =
    view === "agenda"
      ? agenda()
      : view === "month"
        ? month()
        : grid(
            view === "day" ? [anchor] : Array.from({ length: 7 }, (_, i) => addDays(range.from, i)),
          );

  return (
    <div className="main page">
      <div className="page-wrap cal-wrap">
        <ColHead title={s["strings.calendar.title"]} count={heading}>
          <Vr />
          <Btn icon title={s["strings.calendar.previous"]} onClick={() => step(-1)}>
            <Icon icon={CaretLeftIcon} />
          </Btn>
          <Btn onClick={() => setAnchor(startOfDay(now))}>{s["strings.calendar.today"]}</Btn>
          <Btn icon title={s["strings.calendar.next"]} onClick={() => step(1)}>
            <Icon icon={CaretRightIcon} />
          </Btn>
          <span className="sp" />
          <Seg
            value={view}
            onChange={setView}
            options={[
              { value: "day", label: s["strings.calendar.view.day"] },
              { value: "week", label: s["strings.calendar.view.week"] },
              { value: "month", label: s["strings.calendar.view.month"] },
              { value: "agenda", label: s["strings.calendar.view.agenda"] },
            ]}
          />
          <Btn
            onClick={() => {
              setError(null);
              setAdding((v) => !v);
            }}
            aria-expanded={adding}
          >
            <Icon icon={PlusIcon} /> {s["strings.calendar.new_event"]}
          </Btn>
          {onAsk && !aiOff ? (
            <Btn onClick={() => onAsk(s["strings.calendar.schedule_ask"])}>
              <Icon icon={CalendarBlankIcon} /> {s["strings.calendar.schedule"]}
            </Btn>
          ) : null}
        </ColHead>
        {adding ? (
          <form className="cal-form" onSubmit={submit} aria-label={s["strings.calendar.new_event"]}>
            <Input name="title" placeholder={s["strings.calendar.form.title"]} required autoFocus />
            <label htmlFor="cal-form-start">
              <span>{s["strings.calendar.form.start"]}</span>
              <Input
                id="cal-form-start"
                name="start"
                type="datetime-local"
                defaultValue={localInput(nextSlot(now))}
                required
              />
            </label>
            <label htmlFor="cal-form-end">
              <span>{s["strings.calendar.form.end"]}</span>
              <Input
                id="cal-form-end"
                name="end"
                type="datetime-local"
                defaultValue={localInput(
                  new Date(
                    nextSlot(now).getTime() + s["calendar.default_duration_minutes"] * 60_000,
                  ),
                )}
                required
              />
            </label>
            <Input name="attendees" placeholder={s["strings.calendar.form.attendees"]} />
            <Btn primary type="submit">
              {s["strings.calendar.form.save"]}
            </Btn>
            <Btn
              type="button"
              onClick={() => {
                setError(null);
                setAdding(false);
              }}
            >
              {s["strings.calendar.form.cancel"]}
            </Btn>
            {error ? <span className="cal-error">{error}</span> : null}
          </form>
        ) : null}
        {answerError ? (
          <p className="cal-error cal-answer-error" role="alert">
            {answerError}
          </p>
        ) : null}
        <div className="cal-body">
          <div className="cal-view" key={view}>
            {body}
          </div>
          <aside className="cal-side">
            {s["calendar.today_panel"] ? (
              <SideCard title={s["strings.calendar.today_panel"]}>
                <TodayPanel
                  items={todays}
                  now={now}
                  strings={s}
                  onJoin={(o) => open(o.link as string)}
                />
              </SideCard>
            ) : null}
            <SideCard title={s["strings.calendar.calendars"]}>
              <div className="cal-list">
                {calendars.map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      checked={c.visible}
                      onChange={(e) => void source.setVisible(c.id, e.currentTarget.checked)}
                    />
                    {c.name}
                    {!c.writable ? <Tag>{s["strings.calendar.read_only"]}</Tag> : null}
                  </label>
                ))}
              </div>
            </SideCard>
          </aside>
        </div>
      </div>
      {shell.layout.agent === "bottom" && !aiOff ? (
        <AgentDock>
          <AgentBar
            placeholder={s["strings.agent.placeholder"]}
            onFocus={() => onNavigate?.("agent")}
          />
        </AgentDock>
      ) : null}
    </div>
  );
}

/** The next quarter hour, for the form's default start. */
function nextSlot(now: Date): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15);
  return d;
}

function linkHost(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}

export function answerLabel(s: Strings, response: CalendarEvent["response"]): string {
  switch (response) {
    case "accepted":
      return s["strings.calendar.answered.accepted"];
    case "tentative":
      return s["strings.calendar.answered.tentative"];
    case "declined":
      return s["strings.calendar.answered.declined"];
    default:
      return s["strings.calendar.answered.needs_action"];
  }
}

export interface TodayPanelProps {
  items: readonly Occurrence[];
  now: Date;
  strings: Strings;
  onJoin?: ((o: Occurrence) => void) | undefined;
}

/** Today's Events as the catalog's Today panel lists them: the current one marked, Join on the linked ones. */
export function TodayPanel({ items, now, strings, onJoin }: TodayPanelProps) {
  if (items.length === 0)
    return <p className="faint">{strings["strings.calendar.nothing_today"]}</p>;
  return (
    <div className="today-panel">
      {items.map((o) => {
        const current = Date.parse(o.start) <= now.getTime() && Date.parse(o.end) > now.getTime();
        return (
          <div key={o.key} className={`tp-row${current ? " now" : ""}`}>
            <span>{o.allDay ? strings["strings.calendar.all_day"] : clock(new Date(o.start))}</span>
            <b>{o.title}</b>
            {o.link && onJoin ? (
              <Btn sm onClick={() => onJoin(o)}>
                {strings["strings.calendar.join"]}
              </Btn>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
