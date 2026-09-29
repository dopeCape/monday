// The judge's answers as a stored reading, and code turning that reading
// into times (the date-extraction pattern): the day from its parts counted
// from the date the Message was written (never from today), the clock time
// from the span the judge picked (never a number it typed), the zone the
// Message states or else the owner's, and the instant through the zone's
// rules so a DST change moves nothing. The lowest confidence among the parts
// used is the proposal's. Jev never compares dates; this file does. Pure.

import type { MeetingFlag, MeetingJudgedBy, MeetingProposal, PartOfDay } from "@monday/shared";
import { zonedToUtc, zoneOffsetMinutes } from "@monday/shared";
import { type ClockCandidate, parseClock } from "./extract.ts";
import { MONTH_OPTIONS, NONE, NOT_STATED, WEEKDAY_OPTIONS } from "./questions.ts";

/** One Choice answer as kept: the option and how peaked the distribution was. */
export interface PartAnswer {
  choice: string;
  confidence: number;
}

/** One proposed time's parts, as the judge read them. */
export interface ProposalParts {
  form: PartAnswer;
  relative: PartAnswer;
  weekday: PartAnswer;
  week: PartAnswer;
  month: PartAnswer;
  day: PartAnswer;
  /** Absent when code found no clock time to offer. */
  clock: PartAnswer | null;
  meridiem: PartAnswer | null;
  part: PartAnswer;
}

/**
 * What one meeting request learned about a Thread version, stored per Thread
 * with the Message it read. Nouls are probabilities; null when not asked
 * (the gate, or no judge).
 */
export interface MeetingReading {
  threadId: string;
  workspaceId: string;
  messageId: string;
  messageCount: number;
  judgedBy: MeetingJudgedBy;
  model: string;
  judgedAt: string;
  /** The owner wrote the newest Message. */
  ownerWroteNewest: boolean;
  /** When the newest Message was written: relative days count from here. */
  writtenAt: string;
  /** The sender's UTC offset from the Date header, when it was kept. */
  senderOffsetMinutes: number | null;
  notEnglish: boolean;
  asksToMeet: number | null;
  ownerAsked: number | null;
  proposesTime: number | null;
  recurring: number | null;
  length: PartAnswer | null;
  /** The zone picked among `zones`, with the IANA zone code mapped it to. */
  zone: (PartAnswer & { iana: string | null }) | null;
  clocks: ClockCandidate[];
  proposals: ProposalParts[];
}

export interface WorkingHours {
  startHour: number;
  endHour: number;
  /** "mon".."sun", as the calendar.work_days Setting holds them. */
  days: readonly string[];
}

export interface ResolveContext {
  /** The owner's zone: calendar.time_zone, else the Device's, else UTC. */
  ownerZone: string;
  weekStartsMonday: boolean;
  lengthMinutes: number;
  /** meetings.schedule.time_confidence: every part used must be read this confidently. */
  timeConfidence: number;
  work: WorkingHours;
  partsOfDay: Record<PartOfDay, { start: number; end: number }>;
  now: Date;
}

export interface ResolvedReading {
  proposals: MeetingProposal[];
  /** "Next week", no day: the Monday (or Sunday) it starts, in the zone. */
  nextWeek: { y: number; mo: number; d: number } | null;
  /** The zone the times were read in. */
  zone: string;
}

const DAY_MS = 86_400_000;
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

interface Civil {
  y: number;
  mo: number;
  d: number;
}

function civil(zone: string, at: Date): Civil {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), mo: get("month"), d: get("day") };
}

function addDays(c: Civil, n: number): Civil {
  const t = new Date(Date.UTC(c.y, c.mo - 1, c.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Monday 0 .. Sunday 6. */
function mondayIndex(c: Civil): number {
  return (new Date(Date.UTC(c.y, c.mo - 1, c.d)).getUTCDay() + 6) % 7;
}

function dayKey(c: Civil): string {
  return `${c.y}-${String(c.mo).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}

function validDate(y: number, mo: number, d: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** The first day of the week `base` is in. */
function weekStart(base: Civil, mondayFirst: boolean): Civil {
  const startIndex = mondayFirst ? 0 : 6;
  return addDays(base, -((mondayIndex(base) - startIndex + 7) % 7));
}

/**
 * The day a named weekday points to, by the stated convention: a bare
 * weekday is the next one on or after the day written; "this" is this week's;
 * "next" is the following week's.
 */
export function resolveWeekday(
  base: Civil,
  weekday: number,
  week: "this" | "next" | "bare",
  mondayFirst: boolean,
): Civil {
  if (week === "bare") return addDays(base, (weekday - mondayIndex(base) + 7) % 7);
  const start = weekStart(base, mondayFirst);
  const startIndex = mondayFirst ? 0 : 6;
  return addDays(start, ((weekday - startIndex + 7) % 7) + (week === "next" ? 7 : 0));
}

/** A month and day with no year: this year's, or next year's when this year's is well past. */
export function resolveYear(base: Civil, month: number, day: number): Civil | null {
  for (const y of [base.y, base.y + 1]) {
    if (!validDate(y, month, day)) continue;
    const at = Date.UTC(y, month - 1, day);
    // More than a week before the day it was written in: the writer means next year.
    if (at >= Date.UTC(base.y, base.mo - 1, base.d) - 7 * DAY_MS) return { y, mo: month, d: day };
  }
  return null;
}

const confident = (a: PartAnswer | null | undefined, floor: number) =>
  a !== null &&
  a !== undefined &&
  a.choice !== NONE &&
  a.choice !== NOT_STATED &&
  a.confidence >= floor;

/** The zone the Message's times are in: the one it states, when read confidently and known to code. */
export function statedZone(reading: MeetingReading, floor: number): string | null {
  const z = reading.zone;
  if (!z || z.choice === NOT_STATED || z.confidence < floor) return null;
  return z.iana;
}

/** Whether a wall-clock span sits inside working hours on a working day, in a zone. */
export function insideWorkingHours(
  start: Date,
  end: Date,
  zone: string,
  work: WorkingHours,
): boolean {
  const c = civil(zone, start);
  const dow = DOW[new Date(Date.UTC(c.y, c.mo - 1, c.d)).getUTCDay()] ?? "mon";
  if (!work.days.includes(dow)) return false;
  const open = zonedToUtc(zone, c.y, c.mo, c.d, work.startHour, 0, 0).getTime();
  const close = zonedToUtc(zone, c.y, c.mo, c.d, work.endHour, 0, 0).getTime();
  return start.getTime() >= open && end.getTime() <= close;
}

/** The hour a clock span means, in 24 hours, and the confidence that took; null when it stays open. */
function hourOf(
  clock: ClockCandidate,
  meridiem: PartAnswer | null,
  ctx: ResolveContext,
): { hour: number; confidence: number } | null {
  if (clock.hour24 !== null) return { hour: clock.hour24, confidence: 1 };
  if (meridiem && confident(meridiem, ctx.timeConfidence)) {
    const base = clock.hour % 12;
    return { hour: meridiem.choice === "pm" ? base + 12 : base, confidence: meridiem.confidence };
  }
  // Neither the span nor the judge says: working hours decide when only one reading fits them.
  const fits = [clock.hour % 12, (clock.hour % 12) + 12].filter(
    (h) =>
      h >= ctx.work.startHour && h * 60 + clock.minute + ctx.lengthMinutes <= ctx.work.endHour * 60,
  );
  return fits.length === 1 && fits[0] !== undefined ? { hour: fits[0], confidence: 1 } : null;
}

/**
 * Every proposed time the reading holds, resolved. A proposal whose parts do
 * not make a day (31 February, a weekday not read) comes back with
 * confidence 0 and the `unsure` flag, so the plan asks the user instead of
 * guessing.
 */
export function resolveReading(reading: MeetingReading, ctx: ResolveContext): ResolvedReading {
  const stated = statedZone(reading, ctx.timeConfidence);
  const zoneRead = reading.zone && reading.zone.choice !== NOT_STATED;
  const zone = stated ?? ctx.ownerZone;
  const written = new Date(reading.writtenAt);
  const base = civil(zone, written);
  const floor = ctx.timeConfidence;
  const out: MeetingProposal[] = [];
  let nextWeek: Civil | null = null;

  for (const parts of reading.proposals) {
    const form = parts.form.choice;
    if (form === NONE) continue;
    const used: number[] = [parts.form.confidence];
    const flags = new Set<MeetingFlag>();
    let day: Civil | null = null;
    if (form === "absolute") {
      if (confident(parts.month, 0) && confident(parts.day, 0)) {
        const month =
          MONTH_OPTIONS.indexOf(parts.month.choice as (typeof MONTH_OPTIONS)[number]) + 1;
        const d = Number(parts.day.choice);
        used.push(parts.month.confidence, parts.day.confidence);
        day = month > 0 ? resolveYear(base, month, d) : null;
      }
    } else if (form === "relative") {
      used.push(parts.relative.confidence);
      switch (parts.relative.choice) {
        case "today":
          day = base;
          break;
        case "tomorrow":
          day = addDays(base, 1);
          break;
        case "day_after":
          day = addDays(base, 2);
          break;
        case "next_week":
          if (parts.relative.confidence >= floor && parts.form.confidence >= floor) {
            nextWeek = addDays(weekStart(base, ctx.weekStartsMonday), 7);
          }
          continue;
        default:
          break;
      }
    } else if (form === "weekday") {
      if (confident(parts.weekday, 0)) {
        const w = WEEKDAY_OPTIONS.indexOf(parts.weekday.choice as (typeof WEEKDAY_OPTIONS)[number]);
        const week =
          parts.week.choice === "this" || parts.week.choice === "next" ? parts.week.choice : "bare";
        used.push(parts.weekday.confidence, parts.week.confidence);
        day = w >= 0 ? resolveWeekday(base, w, week, ctx.weekStartsMonday) : null;
      }
    } else if (form === "time_only") {
      // A time with no day: which day is meant is a guess, so it is never scheduled as read.
      day = base;
      flags.add("unsure");
    }

    const clockSpan = parts.clock && parts.clock.choice !== NONE ? parts.clock.choice : null;
    const clock = clockSpan
      ? (reading.clocks.find((c) => c.text === clockSpan) ?? parseClock(clockSpan))
      : null;
    if (clockSpan && parts.clock) used.push(parts.clock.confidence);

    if (!day) {
      out.push({
        start: null,
        end: null,
        day: dayKey(base),
        timeZone: zone,
        partOfDay: null,
        confidence: 0,
        free: null,
        busyWith: [],
        flags: ["unsure"],
      });
      continue;
    }

    let start: Date | null = null;
    let partOfDay: PartOfDay | null = null;
    if (clock) {
      const hour = hourOf(clock, parts.meridiem, ctx);
      if (hour) {
        used.push(hour.confidence);
        start = zonedToUtc(zone, day.y, day.mo, day.d, hour.hour, clock.minute, 0);
      } else {
        flags.add("unsure");
      }
      if (zoneRead && !stated) flags.add("unsure");
      if (
        start &&
        !stated &&
        reading.senderOffsetMinutes !== null &&
        !reading.ownerWroteNewest &&
        reading.senderOffsetMinutes !== zoneOffsetMinutes(zone, start)
      ) {
        flags.add("zone_unclear");
      }
    } else {
      flags.add("day_only");
      const part = parts.part.choice;
      if (
        (part === "morning" || part === "afternoon" || part === "evening") &&
        parts.part.confidence >= floor
      ) {
        partOfDay = part;
      }
    }

    const confidence = Math.min(...used);
    if (confidence < floor) flags.add("unsure");
    const end = start ? new Date(start.getTime() + ctx.lengthMinutes * 60_000) : null;
    if (start && end) {
      if (start.getTime() < ctx.now.getTime()) flags.add("past");
      if (!insideWorkingHours(start, end, ctx.ownerZone, ctx.work)) flags.add("outside_hours");
    } else {
      const endOfDay = zonedToUtc(zone, day.y, day.mo, day.d, 23, 59, 0);
      if (endOfDay.getTime() < ctx.now.getTime()) flags.add("past");
    }
    out.push({
      start: start ? start.toISOString() : null,
      end: end ? end.toISOString() : null,
      day: dayKey(day),
      timeZone: zone,
      partOfDay,
      confidence,
      free: null,
      busyWith: [],
      flags: [...flags],
    });
  }
  return { proposals: out, nextWeek, zone };
}
