// The Today panel (the catalog's): today's Events with the current one
// marked and Join on the linked ones. Shown beside the Calendar and at the
// top of the inbox stream; the invite bar shares the answer words.

import type { CalendarEvent, Settings } from "@monday/shared";
import { Btn, clock } from "@monday/ui";
import type { Occurrence } from "./calendar-data.ts";

type Strings = Settings;

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
  /** Opens an Event's detail; absent, the rows are plain. */
  onOpen?: ((o: Occurrence, el: HTMLElement) => void) | undefined;
}

/** Today's Events as the catalog's Today panel lists them: the current one marked, Join on the linked ones. */
export function TodayPanel({ items, now, strings, onJoin, onOpen }: TodayPanelProps) {
  if (items.length === 0)
    return <p className="faint">{strings["strings.calendar.nothing_today"]}</p>;
  return (
    <div className="today-panel">
      {items.map((o) => {
        const current = Date.parse(o.start) <= now.getTime() && Date.parse(o.end) > now.getTime();
        const past = Date.parse(o.end) <= now.getTime();
        const title = <b>{o.title || strings["strings.calendar.untitled"]}</b>;
        return (
          <div key={o.key} className={`tp-row${current ? " now" : ""}${past ? " past" : ""}`}>
            <span>{o.allDay ? strings["strings.calendar.all_day"] : clock(new Date(o.start))}</span>
            {onOpen ? (
              <button type="button" className="tp-open" onClick={(e) => onOpen(o, e.currentTarget)}>
                {title}
              </button>
            ) : (
              title
            )}
            {o.link && onJoin && !past ? (
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
