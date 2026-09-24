// How Events sit on the views, as data: side-by-side columns for timed
// Events that overlap in a day, lanes for the all-day row of a week, the
// weeks of a month, the search over Events and each calendar's colour. Pure,
// so every placement is testable without a DOM.

import type { Calendar } from "@monday/shared";
import type { Occurrence } from "./calendar-data.ts";
import {
  addDays,
  coveredDays,
  DAY_MS,
  daysBetween,
  minutesOfDay,
  startOfDay,
  startOfWeek,
  touchesDay,
} from "./dates.ts";

/* ------------------------------ The time grid ------------------------------ */

/** Whether an Event belongs on the all-day row: all-day ones, and timed ones a full day or longer. */
export function inAllDayRow(o: { start: string; end: string; allDay: boolean }): boolean {
  if (o.allDay) return true;
  return Date.parse(o.end) - Date.parse(o.start) >= DAY_MS;
}

export interface Placed {
  occ: Occurrence;
  /** Minutes past the day's midnight, clipped to the day. */
  top: number;
  bottom: number;
  /** Starts before the day or ends after it. */
  clippedStart: boolean;
  clippedEnd: boolean;
  /** Left edge and width as fractions of the column. */
  left: number;
  width: number;
  /** Index in its overlap group, for stacking order. */
  column: number;
}

/**
 * The timed Events of one local day laid out side by side: overlapping
 * Events share the column in equal parts, and an Event widens into the
 * columns to its right that stay free for its whole span.
 */
export function layoutDay(items: readonly Occurrence[], day: Date, minMinutes = 15): Placed[] {
  const from = startOfDay(day).getTime();
  const next = addDays(startOfDay(day), 1).getTime();
  const dayMinutes = Math.round((next - from) / 60_000);
  const spans = items
    .filter((o) => !inAllDayRow(o))
    .map((o) => {
      const s = Date.parse(o.start);
      const e = Math.max(Date.parse(o.end), s);
      return { o, s, e };
    })
    .filter(({ s, e }) => (e > from || (e === s && s >= from)) && s < next)
    .map(({ o, s, e }) => {
      const top = s <= from ? 0 : minutesOfDay(new Date(s));
      const bottom = e >= next ? dayMinutes : Math.max(top, minutesOfDay(new Date(e)));
      return { o, top, bottom, clippedStart: s < from, clippedEnd: e > next };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.o.key.localeCompare(b.o.key));

  const out: Placed[] = [];
  // A zero-length Event still takes a sliver so it can be seen and picked.
  const end = (x: { top: number; bottom: number }) => Math.max(x.bottom, x.top + minMinutes);
  let group: Array<(typeof spans)[number] & { column: number }> = [];
  let groupEnd = -1;
  const flush = () => {
    if (group.length === 0) return;
    const columns = Math.max(...group.map((g) => g.column)) + 1;
    for (const g of group) {
      let span = 1;
      for (let c = g.column + 1; c < columns; c++) {
        const blocked = group.some(
          (other) => other.column === c && other.top < end(g) && end(other) > g.top,
        );
        if (blocked) break;
        span += 1;
      }
      out.push({
        occ: g.o,
        top: g.top,
        bottom: g.bottom,
        clippedStart: g.clippedStart,
        clippedEnd: g.clippedEnd,
        left: g.column / columns,
        width: span / columns,
        column: g.column,
      });
    }
    group = [];
    groupEnd = -1;
  };
  for (const sp of spans) {
    if (group.length > 0 && sp.top >= groupEnd) flush();
    const taken = new Set(group.filter((g) => end(g) > sp.top).map((g) => g.column));
    let column = 0;
    while (taken.has(column)) column += 1;
    group.push({ ...sp, column });
    groupEnd = Math.max(groupEnd, end(sp));
  }
  flush();
  return out;
}

export interface Lane {
  occ: Occurrence;
  /** Index of the first and last day it covers among the days shown. */
  from: number;
  to: number;
  lane: number;
  /** It began before the first day shown or runs past the last. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** The all-day row of a run of days: each Event a bar across the days it covers, stacked in lanes. */
export function allDayLanes(items: readonly Occurrence[], days: readonly Date[]): Lane[] {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return [];
  const bars = items
    .filter(inAllDayRow)
    .map((o) => {
      const c = coveredDays(o);
      return { o, c };
    })
    .filter(({ c }) => c.last.getTime() >= startOfDay(first).getTime() && c.first <= last)
    .map(({ o, c }) => ({
      o,
      from: Math.max(0, daysBetween(first, c.first)),
      to: Math.min(days.length - 1, daysBetween(first, c.last)),
      continuesBefore: c.first.getTime() < startOfDay(first).getTime(),
      continuesAfter: c.last.getTime() > startOfDay(last).getTime(),
    }))
    .sort(
      (a, b) =>
        a.from - b.from || b.to - b.from - (a.to - a.from) || a.o.key.localeCompare(b.o.key),
    );
  const lanes: number[][] = [];
  const out: Lane[] = [];
  for (const b of bars) {
    let lane = 0;
    for (;;) {
      const used = lanes[lane] ?? [];
      if (!used.some((d) => d >= b.from && d <= b.to)) break;
      lane += 1;
    }
    lanes[lane] = [...(lanes[lane] ?? []), ...range(b.from, b.to)];
    out.push({
      occ: b.o,
      from: b.from,
      to: b.to,
      lane,
      continuesBefore: b.continuesBefore,
      continuesAfter: b.continuesAfter,
    });
  }
  return out;
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/* ------------------------------ Month ------------------------------ */

/** The weeks a month view shows: whole weeks from the one holding the 1st to the one holding the last day. */
export function monthWeeks(anchor: Date, mondayFirst: boolean): Date[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const out: Date[][] = [];
  for (let w = startOfWeek(first, mondayFirst); w <= last; w = addDays(w, 7)) {
    out.push(Array.from({ length: 7 }, (_, i) => addDays(w, i)));
  }
  return out;
}

/** The Events touching a day: all-day and multi-day ones first, then timed ones by start. */
export function eventsOnDay(items: readonly Occurrence[], day: Date): Occurrence[] {
  return items
    .filter((o) => touchesDay(o, day))
    .sort(
      (a, b) =>
        Number(inAllDayRow(b)) - Number(inAllDayRow(a)) ||
        a.start.localeCompare(b.start) ||
        a.end.localeCompare(b.end),
    );
}

/* ------------------------------ Search ------------------------------ */

/** The occurrences a query names, by title, place, notes or people; every word must match. */
export function searchOccurrences(items: readonly Occurrence[], query: string): Occurrence[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return items.filter((o) => {
    const hay = [
      o.title,
      o.location,
      o.description,
      o.organizer?.name ?? "",
      o.organizer?.email ?? "",
      ...o.attendees.flatMap((a) => [a.name, a.email]),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/* ------------------------------ Colour ------------------------------ */

/** The palette tokens a calendar without its own colour cycles through. */
export const CALENDAR_TOKENS = ["tag-1", "tag-2", "tag-3", "tag-4", "tag-5"] as const;

/** A colour value as CSS: a token name ("tag-2") becomes its variable; anything else is used as is. */
export function cssColor(value: string): string {
  return /^[a-z][a-z0-9-]*$/.test(value) ? `var(--${value})` : value;
}

/**
 * Each calendar's colour: the user's choice (the calendar.colors Setting),
 * else the Provider's, else a palette token by its place in the list.
 */
export function calendarColors(
  calendars: readonly Pick<Calendar, "id" | "color">[],
  overrides: Readonly<Record<string, string>>,
): Map<string, string> {
  const out = new Map<string, string>();
  calendars.forEach((c, i) => {
    const chosen = overrides[c.id];
    const value = chosen ?? c.color ?? (CALENDAR_TOKENS[i % CALENDAR_TOKENS.length] as string);
    out.set(c.id, cssColor(value));
  });
  return out;
}
