// An Event being made or edited, as the quick create and the editor hold
// it: wall-clock dates and times in the Event's own zone (the Device's by
// default), turned into the instants the API takes only when saved, and
// the smallest patch that says what changed. Pure.

import type { EventInput, EventPatch, MeetingLinkKind, Person } from "@monday/shared";
import { utcToZoned, zonedToUtc } from "@monday/shared";
import type { Occurrence } from "./calendar-data.ts";
import { addDays, allDayDate, allDayIso, dayKey, deviceZone, fromDayKey } from "./dates.ts";

export interface Draft {
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** "2026-09-17" and "09:30" in `timeZone`; the end date is the last day for an all-day Event. */
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timeZone: string;
  calendarId: string | null;
  attendees: Person[];
  /** Absent: the meeting link Setting decides. */
  meetingLink: MeetingLinkKind | "default";
  customLink: string;
  recurrence: string | null;
  /** Null keeps the calendar's default reminder. */
  reminders: number[] | null;
}

const p2 = (n: number) => String(n).padStart(2, "0");

function wall(zone: string, at: Date): { date: string; time: string } {
  try {
    const z = utcToZoned(zone, at);
    return { date: `${z.y}-${p2(z.mo)}-${p2(z.d)}`, time: `${p2(z.h)}:${p2(z.mi)}` };
  } catch {
    return { date: dayKey(at), time: `${p2(at.getHours())}:${p2(at.getMinutes())}` };
  }
}

/** A new Draft over a slot the user picked. */
export function draftForSlot(
  slot: { start: Date; end: Date; allDay: boolean },
  calendarId: string | null,
  zone = deviceZone(),
): Draft {
  const s = wall(zone, slot.start);
  const e = wall(zone, slot.end);
  return {
    title: "",
    description: "",
    location: "",
    allDay: slot.allDay,
    startDate: slot.allDay ? dayKey(slot.start) : s.date,
    startTime: s.time,
    endDate: slot.allDay ? dayKey(addDays(slot.end, -1)) : e.date,
    endTime: e.time,
    timeZone: zone,
    calendarId,
    attendees: [],
    meetingLink: "default",
    customLink: "",
    recurrence: null,
    reminders: null,
  };
}

/** A Draft holding an Event as it is, for editing or duplicating. */
export function draftOf(o: Occurrence, zone = deviceZone()): Draft {
  const tz = o.timeZone || zone;
  const s = wall(tz, new Date(o.start));
  const e = wall(tz, new Date(o.end));
  return {
    title: o.title,
    description: o.description,
    location: o.location,
    allDay: o.allDay,
    startDate: o.allDay ? dayKey(allDayDate(o.start)) : s.date,
    startTime: o.allDay ? "09:00" : s.time,
    endDate: o.allDay ? dayKey(addDays(allDayDate(o.end), -1)) : e.date,
    endTime: o.allDay ? "10:00" : e.time,
    timeZone: tz,
    calendarId: o.calendarId,
    attendees: o.attendees
      .filter((a) => !a.self && !a.organizer)
      .map((a) => ({ name: a.name, email: a.email })),
    meetingLink: "default",
    customLink: o.link ?? "",
    recurrence: o.recurrence,
    reminders: o.reminders ?? null,
  };
}

function instant(zone: string, date: string, time: string): Date | null {
  const d = fromDayKey(date);
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d || !m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  try {
    return zonedToUtc(
      zone,
      d.getFullYear(),
      d.getMonth() + 1,
      d.getDate(),
      Number(m[1]),
      Number(m[2]),
      0,
    );
  } catch {
    return null;
  }
}

/** The instants a Draft names; null when a date or time is malformed. */
export function timesOf(d: Draft): { start: string; end: string } | null {
  if (d.allDay) {
    const a = fromDayKey(d.startDate);
    const b = fromDayKey(d.endDate);
    if (!a || !b) return null;
    return { start: allDayIso(a), end: allDayIso(addDays(b < a ? a : b, 1)) };
  }
  const a = instant(d.timeZone, d.startDate, d.startTime);
  const b = instant(d.timeZone, d.endDate, d.endTime);
  if (!a || !b) return null;
  return { start: a.toISOString(), end: b.toISOString() };
}

/** Why a Draft cannot be saved, as a strings key; null when it can. */
export function draftProblem(d: Draft): "bad_time" | "end_before_start" | null {
  const t = timesOf(d);
  if (!t) return "bad_time";
  if (Date.parse(t.end) <= Date.parse(t.start)) return "end_before_start";
  return null;
}

/** Moves the end with the start so the length stays, as calendars do when the start changes. */
export function withStart(d: Draft, date: string, time: string): Draft {
  const before = timesOf(d);
  const next = { ...d, startDate: date, startTime: time };
  if (!before) return next;
  if (d.allDay) {
    const a = fromDayKey(d.startDate);
    const b = fromDayKey(d.endDate);
    const n = fromDayKey(date);
    if (!a || !b || !n) return next;
    const days = Math.round((b.getTime() - a.getTime()) / 86_400_000);
    return { ...next, endDate: dayKey(addDays(n, days)) };
  }
  const length = Date.parse(before.end) - Date.parse(before.start);
  const start = instant(d.timeZone, date, time);
  if (!start) return next;
  const end = wall(d.timeZone, new Date(start.getTime() + length));
  return { ...next, endDate: end.date, endTime: end.time };
}

/** The input that makes a Draft. */
export function inputOf(d: Draft): EventInput | null {
  const t = timesOf(d);
  if (!t) return null;
  return {
    title: d.title.trim(),
    description: d.description,
    location: d.location,
    start: t.start,
    end: t.end,
    allDay: d.allDay,
    timeZone: d.allDay ? null : d.timeZone,
    calendarId: d.calendarId,
    attendees: d.attendees,
    recurrence: d.recurrence,
    reminders: d.reminders,
    ...(d.meetingLink === "default"
      ? {}
      : {
          meetingLink: d.meetingLink,
          customLink: d.meetingLink === "custom" ? d.customLink.trim() || null : null,
        }),
  };
}

function samePeople(a: readonly Person[], b: readonly Person[]): boolean {
  const key = (l: readonly Person[]) =>
    l
      .map((p) => p.email.toLowerCase())
      .sort()
      .join(",");
  return key(a) === key(b);
}

/** Only what a Draft changed against the Event it was made from. */
export function patchOf(d: Draft, from: Draft): EventPatch | null {
  const input = inputOf(d);
  const before = inputOf(from);
  if (!input || !before) return null;
  const patch: EventPatch = {};
  if (input.title !== before.title) patch.title = input.title;
  if (input.description !== before.description) patch.description = input.description;
  if (input.location !== before.location) patch.location = input.location;
  if (input.start !== before.start || input.allDay !== before.allDay) patch.start = input.start;
  if (input.end !== before.end || input.allDay !== before.allDay) patch.end = input.end;
  if (input.allDay !== before.allDay) patch.allDay = input.allDay;
  if (input.timeZone !== before.timeZone) patch.timeZone = input.timeZone;
  if (input.calendarId !== before.calendarId) patch.calendarId = input.calendarId;
  if (!samePeople(input.attendees ?? [], before.attendees ?? [])) patch.attendees = input.attendees;
  if ((input.recurrence ?? null) !== (before.recurrence ?? null))
    patch.recurrence = input.recurrence;
  if (JSON.stringify(input.reminders ?? null) !== JSON.stringify(before.reminders ?? null))
    patch.reminders = input.reminders;
  if (d.meetingLink !== "default") {
    patch.meetingLink = input.meetingLink;
    patch.customLink = input.customLink;
  }
  return patch;
}
