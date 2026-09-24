// The column beside the Calendar: the mini month for picking a day (the
// days on screen marked, days with Events dotted), the Today panel, the
// invites still waiting for an answer, and the calendars of every Account
// shown, grouped as the open Account's own, each other Account's and
// those shared with the Account; each is a coloured switch (what this
// Workspace shows, the calendar.shown Setting) with hover actions to show
// only it, hide it and pick its colour (calendar.colors), and a warning
// on a calendar or an Account whose calendar cannot be read.

import type { Calendar, Settings } from "@monday/shared";
import { Btn, clock, cx, formatMonth, Icon, SideCard, WEEKDAY_SHORT } from "@monday/ui";
import {
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  EyeIcon,
  EyeSlashIcon,
  LockSimpleIcon,
  PaletteIcon,
  WarningIcon,
} from "@phosphor-icons/react";
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
  /** The open Workspace, whose own calendars head the list. */
  workspaceId: string;
  /** Accounts whose calendar cannot be read, by Workspace. */
  problems: ReadonlySet<string>;
  s: Settings;
  onToggle: (c: Calendar, visible: boolean) => void;
  onOnly: (c: Calendar) => void;
  onShowAll: () => void;
  onColor: (c: Calendar, color: string | null) => void;
  /** Shown instead of the list while nothing has arrived yet. */
  loading: boolean;
}

interface Group {
  key: string;
  title: string;
  problem: boolean;
  calendars: Calendar[];
}

/** The groups the list shows: the open Workspace's own, each other Account's, then shared ones. */
export function calendarGroups(
  calendars: readonly Calendar[],
  accounts: readonly CalendarAccount[],
  workspaceId: string,
  problems: ReadonlySet<string>,
  words: { mine: string; shared: string },
): Group[] {
  const address = (ws: string) => accounts.find((a) => a.workspaceId === ws)?.address ?? ws;
  const out: Group[] = [];
  const mine = calendars.filter((c) => c.workspaceId === workspaceId && !c.sharedBy);
  if (mine.length)
    out.push({
      key: "mine",
      title: words.mine,
      problem: problems.has(workspaceId),
      calendars: mine,
    });
  const others = new Map<string, Calendar[]>();
  for (const c of calendars) {
    if (c.workspaceId === workspaceId || c.sharedBy) continue;
    others.set(c.workspaceId, [...(others.get(c.workspaceId) ?? []), c]);
  }
  for (const [ws, list] of others)
    out.push({ key: ws, title: address(ws), problem: problems.has(ws), calendars: list });
  const shared = calendars.filter((c) => c.sharedBy);
  if (shared.length)
    out.push({ key: "shared", title: words.shared, problem: false, calendars: shared });
  return out;
}

/** The calendars in groups: each a coloured switch, hover actions to show only it, hide it and colour it. */
export function CalendarList({
  calendars,
  accounts,
  colors,
  workspaceId,
  problems,
  s,
  onToggle,
  onOnly,
  onShowAll,
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
  const fill = (t: string, vars: Record<string, string | number>) =>
    t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
  const groups = calendarGroups(calendars, accounts, workspaceId, problems, {
    mine: s["strings.calendar.list.mine"],
    shared: s["strings.calendar.list.shared"],
  });
  const address = (ws: string) => accounts.find((a) => a.workspaceId === ws)?.address ?? "";
  const hidden = calendars.some((c) => !c.visible);
  return (
    <div className="cal-list">
      {groups.map((g) => (
        <div key={g.key} className="cal-list-group">
          <div className="cal-list-account">
            <span>{g.title}</span>
            {g.problem ? (
              <span className="cal-list-warn" title={s["strings.calendar.list.account_problem"]}>
                <Icon icon={WarningIcon} />
              </span>
            ) : null}
          </div>
          {g.calendars.map((c) => {
            const color = colors.get(c.id) ?? "var(--fg-muted)";
            const busyOnly = c.access === "free-busy";
            const readOnly = !c.writable || c.access === "reader";
            const sub = c.sharedBy
              ? fill(s["strings.calendar.list.shared_by"], {
                  name: c.sharedBy.name || c.sharedBy.email,
                })
              : null;
            return (
              <div
                key={c.id}
                className={cx("cal-list-row", !c.visible && "off", c.error && "err")}
                style={{ "--ev": color } as CSSProperties}
              >
                <label
                  title={
                    c.error
                      ? fill(s["strings.calendar.list.cant_read"], { message: c.error })
                      : c.name
                  }
                >
                  <input
                    type="checkbox"
                    checked={c.visible}
                    onChange={(e) => onToggle(c, e.currentTarget.checked)}
                  />
                  <span className="cal-check" aria-hidden="true">
                    {c.visible ? <Icon icon={CheckIcon} /> : null}
                  </span>
                  <span className="cal-list-text">
                    <span className="cal-list-name">{c.name}</span>
                    {sub || (c.sharedBy && accounts.length > 1) ? (
                      <span className="cal-list-sub">
                        {[sub, c.sharedBy && accounts.length > 1 ? address(c.workspaceId) : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    ) : null}
                  </span>
                </label>
                {c.error ? (
                  <span
                    className="cal-list-warn"
                    title={fill(s["strings.calendar.list.cant_read"], { message: c.error })}
                  >
                    <Icon icon={WarningIcon} />
                  </span>
                ) : busyOnly ? (
                  <span className="cal-list-tag">{s["strings.calendar.list.free_busy"]}</span>
                ) : readOnly ? (
                  <span className="cal-list-tag" title={s["strings.calendar.read_only"]}>
                    <Icon icon={LockSimpleIcon} />
                  </span>
                ) : null}
                <span className="cal-list-acts">
                  <button
                    type="button"
                    title={s["strings.calendar.list.only"]}
                    aria-label={s["strings.calendar.list.only"]}
                    onClick={() => onOnly(c)}
                  >
                    <Icon icon={EyeIcon} />
                  </button>
                  <button
                    type="button"
                    title={s["strings.calendar.color"]}
                    aria-label={s["strings.calendar.color"]}
                    aria-expanded={picking === c.id}
                    onClick={() => setPicking(picking === c.id ? null : c.id)}
                  >
                    <Icon icon={PaletteIcon} />
                  </button>
                  <button
                    type="button"
                    title={
                      c.visible ? s["strings.calendar.list.hide"] : s["strings.calendar.list.show"]
                    }
                    aria-label={
                      c.visible ? s["strings.calendar.list.hide"] : s["strings.calendar.list.show"]
                    }
                    onClick={() => onToggle(c, !c.visible)}
                  >
                    <Icon icon={c.visible ? EyeSlashIcon : EyeIcon} />
                  </button>
                </span>
                {picking === c.id ? (
                  <div className="cal-swatches" role="menu">
                    {CALENDAR_TOKENS.map((t) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={t}
                        aria-label={t}
                        className={colors.get(c.id) === cssColor(t) ? "on" : ""}
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
      {hidden ? (
        <button type="button" className="cal-list-all" onClick={onShowAll}>
          {s["strings.calendar.list.show_all"]}
        </button>
      ) : null}
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
  workspaceId: string;
  problems: ReadonlySet<string>;
  loading: boolean;
  s: Settings;
  onPick: (day: Date) => void;
  onOpen: (o: Occurrence, el: HTMLElement) => void;
  onJoin: (o: Occurrence) => void;
  onToggle: (c: Calendar, visible: boolean) => void;
  onOnly: (c: Calendar) => void;
  onShowAll: () => void;
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
          workspaceId={p.workspaceId}
          problems={p.problems}
          s={s}
          onToggle={p.onToggle}
          onOnly={p.onOnly}
          onShowAll={p.onShowAll}
          onColor={p.onColor}
          loading={p.loading}
        />
      </SideCard>
    </aside>
  );
}
