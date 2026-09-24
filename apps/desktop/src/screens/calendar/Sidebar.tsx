// The column beside the Calendar: the mini month for picking a day (the
// days on screen marked, days with Events dotted), the Today panel, the
// invites still waiting for an answer, and the calendars of every Account
// shown, each with its colour as a switch for whether it shows and a
// swatch menu to pick another colour (the calendar.colors Setting).

import type { Calendar, Settings } from "@monday/shared";
import { Btn, clock, formatMonth, Icon, SideCard, Tag, WEEKDAY_SHORT } from "@monday/ui";
import { CaretLeftIcon, CaretRightIcon, CheckIcon } from "@phosphor-icons/react";
import { type CSSProperties, useEffect, useState } from "react";
import type { CalendarAccount, Occurrence } from "./calendar-data.ts";
import { addMonths, dayKey, isoWeek, sameDay, startOfDay, startOfMonth } from "./dates.ts";
import { CALENDAR_TOKENS, cssColor, monthWeeks } from "./layout.ts";
import { TodayPanel } from "./TodayPanel.tsx";

export interface MiniMonthProps {
  anchor: Date;
  now: Date;
  /** The first and last day on screen, marked. */
  shown: { from: Date; to: Date };
  /** Days holding at least one Event, as dayKey()s. */
  busy: ReadonlySet<string>;
  s: Settings;
  onPick: (day: Date) => void;
}

export function MiniMonth({ anchor, now, shown, busy, s, onPick }: MiniMonthProps) {
  const [month, setMonth] = useState(() => startOfMonth(anchor));
  // The month follows the views when they step out of it.
  useEffect(() => setMonth(startOfMonth(anchor)), [anchor]);
  const mondayFirst = s["calendar.week_starts_monday"];
  const weekNumbers = s["calendar.week_numbers"];
  const weeks = monthWeeks(month, mondayFirst);
  const heads = mondayFirst ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const from = startOfDay(shown.from).getTime();
  const to = shown.to.getTime();
  return (
    <div className={`cal-mini${weekNumbers ? " weeknos" : ""}`}>
      <div className="cal-mini-head">
        <b>{formatMonth(month)}</b>
        <Btn
          icon
          sm
          title={s["strings.calendar.previous_month"]}
          onClick={() => setMonth(addMonths(month, -1))}
        >
          <Icon icon={CaretLeftIcon} />
        </Btn>
        <Btn
          icon
          sm
          title={s["strings.calendar.next_month"]}
          onClick={() => setMonth(addMonths(month, 1))}
        >
          <Icon icon={CaretRightIcon} />
        </Btn>
      </div>
      <div className="cal-mini-grid">
        {weekNumbers ? <span className="cal-mini-wk" /> : null}
        {heads.map((d) => (
          <span key={d} className="cal-mini-h">
            {WEEKDAY_SHORT[d]?.slice(0, 2)}
          </span>
        ))}
        {weeks.flatMap((week) => [
          ...(weekNumbers && week[0]
            ? [
                <span key={`wk-${week[0].toISOString()}`} className="cal-mini-wk">
                  {isoWeek(week[0])}
                </span>,
              ]
            : []),
          ...week.map((d) => {
            const t = d.getTime();
            const inShown = t >= from && t < to;
            return (
              <button
                type="button"
                key={d.toISOString()}
                className={`cal-mini-d${sameDay(d, now) ? " today" : ""}${d.getMonth() !== month.getMonth() ? " outside" : ""}${inShown ? " shown" : ""}${busy.has(dayKey(d)) ? " busy" : ""}`}
                onClick={() => onPick(d)}
                aria-label={d.toDateString()}
              >
                {d.getDate()}
              </button>
            );
          }),
        ])}
      </div>
    </div>
  );
}

export interface CalendarListProps {
  calendars: readonly Calendar[];
  accounts: readonly CalendarAccount[];
  colors: ReadonlyMap<string, string>;
  s: Settings;
  onToggle: (c: Calendar, visible: boolean) => void;
  onColor: (c: Calendar, color: string | null) => void;
  /** Shown instead of the list while nothing has arrived yet. */
  loading: boolean;
}

/** The calendars grouped by Account, each a coloured switch with a colour menu. */
export function CalendarList({
  calendars,
  accounts,
  colors,
  s,
  onToggle,
  onColor,
  loading,
}: CalendarListProps) {
  const [picking, setPicking] = useState<string | null>(null);
  if (calendars.length === 0) {
    return (
      <p className="faint cal-side-note">
        {loading ? s["strings.calendar.loading"] : s["strings.calendar.no_calendars"]}
      </p>
    );
  }
  const groups = new Map<string, Calendar[]>();
  for (const c of calendars) groups.set(c.workspaceId, [...(groups.get(c.workspaceId) ?? []), c]);
  const label = (workspaceId: string) =>
    accounts.find((a) => a.workspaceId === workspaceId)?.address ?? "";
  const many = groups.size > 1;
  return (
    <div className="cal-list">
      {[...groups.entries()].map(([ws, list]) => (
        <div key={ws} className="cal-list-group">
          {many && label(ws) ? <div className="cal-list-account">{label(ws)}</div> : null}
          {list.map((c) => {
            const color = colors.get(c.id) ?? "var(--fg-muted)";
            return (
              <div key={c.id} className="cal-list-row" style={{ "--ev": color } as CSSProperties}>
                <label>
                  <input
                    type="checkbox"
                    checked={c.visible}
                    onChange={(e) => onToggle(c, e.currentTarget.checked)}
                  />
                  <span className="cal-check" aria-hidden="true">
                    {c.visible ? <Icon icon={CheckIcon} /> : null}
                  </span>
                  <span className="cal-list-name">{c.name}</span>
                </label>
                {!c.writable ? <Tag>{s["strings.calendar.read_only"]}</Tag> : null}
                <button
                  type="button"
                  className="cal-swatch"
                  aria-label={s["strings.calendar.color"]}
                  aria-expanded={picking === c.id}
                  onClick={() => setPicking(picking === c.id ? null : c.id)}
                />
                {picking === c.id ? (
                  <div className="cal-swatches" role="menu">
                    {CALENDAR_TOKENS.map((t) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={t}
                        aria-label={t}
                        style={{ "--ev": cssColor(t) } as CSSProperties}
                        onClick={() => {
                          setPicking(null);
                          onColor(c, t);
                        }}
                      />
                    ))}
                    <button
                      type="button"
                      role="menuitem"
                      className="reset"
                      onClick={() => {
                        setPicking(null);
                        onColor(c, null);
                      }}
                    >
                      {s["strings.calendar.color_reset"]}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export interface SidebarProps {
  anchor: Date;
  now: Date;
  shown: { from: Date; to: Date };
  busy: ReadonlySet<string>;
  today: readonly Occurrence[];
  waiting: readonly Occurrence[];
  calendars: readonly Calendar[];
  accounts: readonly CalendarAccount[];
  colors: ReadonlyMap<string, string>;
  loading: boolean;
  s: Settings;
  onPick: (day: Date) => void;
  onOpen: (o: Occurrence, el: HTMLElement) => void;
  onJoin: (o: Occurrence) => void;
  onToggle: (c: Calendar, visible: boolean) => void;
  onColor: (c: Calendar, color: string | null) => void;
}

export function Sidebar(p: SidebarProps) {
  const s = p.s;
  return (
    <aside className="cal-side" aria-label={s["strings.calendar.sidebar"]}>
      {s["calendar.mini_month"] ? (
        <MiniMonth
          anchor={p.anchor}
          now={p.now}
          shown={p.shown}
          busy={p.busy}
          s={s}
          onPick={p.onPick}
        />
      ) : null}
      {s["calendar.today_panel"] ? (
        <SideCard title={s["strings.calendar.today_panel"]}>
          <TodayPanel items={p.today} now={p.now} strings={s} onJoin={p.onJoin} onOpen={p.onOpen} />
        </SideCard>
      ) : null}
      {p.waiting.length > 0 ? (
        <SideCard title={s["strings.calendar.waiting"]}>
          <div className="cal-waiting">
            {p.waiting.map((o) => (
              <button
                type="button"
                key={o.key}
                style={{ "--ev": p.colors.get(o.calendarId) ?? "var(--fg-muted)" } as CSSProperties}
                onClick={(e) => p.onOpen(o, e.currentTarget)}
              >
                <b>{o.title || s["strings.calendar.untitled"]}</b>
                <span>
                  {WEEKDAY_SHORT[new Date(o.start).getDay()]} {new Date(o.start).getDate()}
                  {o.allDay ? "" : `, ${clock(new Date(o.start))}`}
                </span>
              </button>
            ))}
          </div>
        </SideCard>
      ) : null}
      <SideCard title={s["strings.calendar.calendars"]}>
        <CalendarList
          calendars={p.calendars}
          accounts={p.accounts}
          colors={p.colors}
          s={s}
          onToggle={p.onToggle}
          onColor={p.onColor}
          loading={p.loading}
        />
      </SideCard>
    </aside>
  );
}
