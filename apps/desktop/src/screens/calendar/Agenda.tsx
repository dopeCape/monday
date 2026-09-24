// The Agenda view and the search results: Events grouped under their day,
// each a row with its time, calendar colour, title, place and people, a
// Join button on a linked one and the answer buttons on an unanswered
// invite. Empty, it says so and offers a new Event.

import type { Settings } from "@monday/shared";
import { Btn, clock, formatDayHeading, Icon } from "@monday/ui";
import { CalendarBlankIcon, VideoCameraIcon } from "@phosphor-icons/react";
import type { CSSProperties, ReactNode } from "react";
import type { Occurrence } from "./calendar-data.ts";
import { sameDay, startOfDay } from "./dates.ts";
import { inAllDayRow } from "./layout.ts";
import { type AddressOf, canAnswer, linkHost, toneOf, whoOf } from "./model.ts";
import { type AnchorRect, rectOf } from "./overlay.tsx";

export interface AgendaProps {
  groups: ReadonlyArray<readonly [Date, readonly Occurrence[]]>;
  now: Date;
  s: Settings;
  colors: ReadonlyMap<string, string>;
  selectedKey: string | null;
  addressOf: AddressOf;
  onOpen: (o: Occurrence, rect: AnchorRect) => void;
  onJoin: (link: string) => void;
  onRespond: (o: Occurrence, response: "accepted" | "tentative" | "declined") => void;
  /** Shown when there is nothing to list. */
  empty: ReactNode;
  /** Words to mark in titles (search). */
  className?: string | undefined;
}

export function Agenda({
  groups,
  now,
  s,
  colors,
  selectedKey,
  addressOf,
  onOpen,
  onJoin,
  onRespond,
  empty,
  className,
}: AgendaProps) {
  if (groups.length === 0)
    return <div className={`cal-agenda empty ${className ?? ""}`}>{empty}</div>;
  return (
    <div className={`cal-agenda ${className ?? ""}`}>
      {groups.map(([day, list]) => (
        <section key={day.toISOString()} className={sameDay(day, now) ? "today" : ""}>
          <h4 className={`cal-ag-day${day < startOfDay(now) ? " past" : ""}`}>
            {formatDayHeading(day, now)}
            <span>{day.getFullYear() !== now.getFullYear() ? ` ${day.getFullYear()}` : ""}</span>
          </h4>
          {list.map((o) => {
            const who = whoOf(o, addressOf);
            const meta = [
              o.location,
              o.link && !o.location ? linkHost(o.link) : "",
              who,
              o.createdByAgent ? s["strings.calendar.by_agent"] : "",
            ].filter(Boolean);
            const allDay = inAllDayRow(o);
            const answer = canAnswer(o, addressOf) && o.response === "needs-action";
            return (
              <div
                key={o.key}
                className={`cal-ag-row ${toneOf(o, now)}${selectedKey === o.key ? " on" : ""}`}
                style={{ "--ev": colors.get(o.calendarId) ?? "var(--fg-muted)" } as CSSProperties}
              >
                <span className="cal-ag-t">
                  {allDay ? (
                    s["strings.calendar.all_day"]
                  ) : (
                    <>
                      {clock(new Date(o.start))}
                      <i>{clock(new Date(o.end))}</i>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="cal-ag-b"
                  onClick={(e) => {
                    const r = rectOf(e.currentTarget);
                    if (r) onOpen(o, r);
                  }}
                >
                  <b>{o.title || s["strings.calendar.untitled"]}</b>
                  {meta.length ? <span>{meta.join(" · ")}</span> : null}
                </button>
                <span className="cal-ag-a">
                  {o.link && Date.parse(o.end) > now.getTime() ? (
                    <Btn sm onClick={() => onJoin(o.link as string)}>
                      <Icon icon={VideoCameraIcon} /> {s["strings.calendar.join"]}
                    </Btn>
                  ) : null}
                  {answer ? (
                    <>
                      <Btn sm onClick={() => onRespond(o, "accepted")}>
                        {s["strings.calendar.accept"]}
                      </Btn>
                      <Btn sm onClick={() => onRespond(o, "declined")}>
                        {s["strings.calendar.decline"]}
                      </Btn>
                    </>
                  ) : null}
                </span>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** The quiet empty state the Agenda and the search share. */
export function CalendarEmpty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <div className="cal-empty">
      <Icon icon={CalendarBlankIcon} />
      <b>{title}</b>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}
