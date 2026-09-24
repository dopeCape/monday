// Day arithmetic for the Calendar views, on the Device's own clock. Timed
// Events are instants shown in the Device's zone; an all-day Event is a run
// of dates, carried as UTC midnights (the Providers' convention: Google's
// `date`, Graph's all-day midnights), so its days are read from the UTC date
// and never shift with the Device's offset. Pure: no DOM.

export const DAY_MS = 86_400_000;
export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function addMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 60_000);
}

export function addMonths(d: Date, n: number): Date {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), days));
}

/** The first day of the week holding `d`. */
export function startOfWeek(d: Date, mondayFirst: boolean): Date {
  const day = startOfDay(d);
  const offset = mondayFirst ? (day.getDay() + 6) % 7 : day.getDay();
  return addDays(day, -offset);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Whole days from a to b, by calendar date (DST-safe). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

/** "2026-09-17": a local day as a key. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A "2026-09-17" key as the local midnight it names; null when malformed. */
export function fromDayKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

/** The ISO week number (weeks start Monday, week 1 holds the first Thursday). */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return (
    1 +
    Math.round(
      ((t.getTime() - firstThursday.getTime()) / DAY_MS -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    )
  );
}

/** Minutes since local midnight. */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** A local day at a number of minutes past its midnight (DST-safe through setHours). */
export function atMinutes(day: Date, minutes: number): Date {
  const out = startOfDay(day);
  out.setHours(0, minutes, 0, 0);
  return out;
}

/** Rounds minutes to the nearest step. */
export function snap(minutes: number, step: number): number {
  const s = Math.max(1, step);
  return Math.round(minutes / s) * s;
}

/** The next slot at or after `now`, on the step, for a new Event's default start. */
export function nextSlot(now: Date, step: number): Date {
  const s = Math.max(1, step);
  const m = minutesOfDay(now);
  return atMinutes(now, Math.ceil((m + 1) / s) * s);
}

/* ------------------------------ All-day dates ------------------------------ */

/** The local midnight of an all-day instant's UTC date. */
export function allDayDate(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** A local day as the UTC midnight an all-day Event carries. */
export function allDayIso(day: Date): string {
  return new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())).toISOString();
}

/**
 * The local days an Event covers, first and last inclusive. An all-day
 * Event ends at the midnight after its last date; a timed one ending at
 * midnight does not reach into the next day.
 */
export function coveredDays(e: { start: string; end: string; allDay: boolean }): {
  first: Date;
  last: Date;
} {
  if (e.allDay) {
    const first = allDayDate(e.start);
    const end = allDayDate(e.end);
    const last = end.getTime() > first.getTime() ? addDays(end, -1) : first;
    return { first, last };
  }
  const s = new Date(e.start);
  const en = new Date(e.end);
  const first = startOfDay(s);
  const lastInstant = en.getTime() > s.getTime() ? new Date(en.getTime() - 1) : s;
  return { first, last: startOfDay(lastInstant) };
}

/** Whether an Event touches a local day. */
export function touchesDay(e: { start: string; end: string; allDay: boolean }, day: Date): boolean {
  const { first, last } = coveredDays(e);
  const t = startOfDay(day).getTime();
  return first.getTime() <= t && last.getTime() >= t;
}

/** The Device's IANA zone. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "14:00" for an instant in a zone; null when the zone is unknown. */
export function clockIn(zone: string, at: Date): string | null {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
  } catch {
    return null;
  }
}

/** A short name for a zone at an instant ("GMT-4", "CEST"); the zone itself when Intl has none. */
export function zoneLabel(zone: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "short",
    }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? zone;
  } catch {
    return zone;
  }
}

/** The zone's offset from UTC in minutes at an instant; null for an unknown zone. */
export function offsetIn(zone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(at);
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"));
    return Math.round((wall - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
  } catch {
    return null;
  }
}

/** Every IANA zone the runtime knows, for the zone pickers. */
export function knownZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}
