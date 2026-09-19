// Calendar helpers shared by the Server and the client (slice 18): the
// Windows to IANA zone map Exchange invitations need, wall-clock to instant
// conversion through Intl, the meeting link extractor, and the recurrence
// expander for the masters CalDAV and the Local calendar hand back (Google
// and Graph expand instances themselves). Runtime-neutral: Intl only.

/* ------------------------------ Time zones ------------------------------ */

/**
 * The Windows zone names Exchange puts in TZID, to IANA (CLDR windowsZones,
 * the territory 001 entries the invitations use). Everything not listed is
 * assumed to already be IANA.
 */
export const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  "Dateline Standard Time": "Etc/GMT+12",
  "UTC-11": "Etc/GMT+11",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage",
  "Pacific Standard Time": "America/Los_Angeles",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time": "America/Denver",
  "Mountain Standard Time (Mexico)": "America/Mazatlan",
  "Central Standard Time": "America/Chicago",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina",
  "Central America Standard Time": "America/Guatemala",
  "Eastern Standard Time": "America/New_York",
  "US Eastern Standard Time": "America/Indianapolis",
  "SA Pacific Standard Time": "America/Bogota",
  "Atlantic Standard Time": "America/Halifax",
  "Venezuela Standard Time": "America/Caracas",
  "SA Western Standard Time": "America/La_Paz",
  "Pacific SA Standard Time": "America/Santiago",
  "Newfoundland Standard Time": "America/St_Johns",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires",
  "SA Eastern Standard Time": "America/Cayenne",
  "Greenland Standard Time": "America/Godthab",
  "Montevideo Standard Time": "America/Montevideo",
  "Azores Standard Time": "Atlantic/Azores",
  "Cape Verde Standard Time": "Atlantic/Cape_Verde",
  UTC: "Etc/UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "GTB Standard Time": "Europe/Bucharest",
  "Middle East Standard Time": "Asia/Beirut",
  "Egypt Standard Time": "Africa/Cairo",
  "E. Europe Standard Time": "Europe/Chisinau",
  "South Africa Standard Time": "Africa/Johannesburg",
  "FLE Standard Time": "Europe/Kiev",
  "Israel Standard Time": "Asia/Jerusalem",
  "Jordan Standard Time": "Asia/Amman",
  "Arabic Standard Time": "Asia/Baghdad",
  "Turkey Standard Time": "Europe/Istanbul",
  "Arab Standard Time": "Asia/Riyadh",
  "Belarus Standard Time": "Europe/Minsk",
  "Russian Standard Time": "Europe/Moscow",
  "E. Africa Standard Time": "Africa/Nairobi",
  "Iran Standard Time": "Asia/Tehran",
  "Arabian Standard Time": "Asia/Dubai",
  "Azerbaijan Standard Time": "Asia/Baku",
  "Mauritius Standard Time": "Indian/Mauritius",
  "Georgian Standard Time": "Asia/Tbilisi",
  "Caucasus Standard Time": "Asia/Yerevan",
  "Afghanistan Standard Time": "Asia/Kabul",
  "West Asia Standard Time": "Asia/Tashkent",
  "Pakistan Standard Time": "Asia/Karachi",
  "India Standard Time": "Asia/Calcutta",
  "Sri Lanka Standard Time": "Asia/Colombo",
  "Nepal Standard Time": "Asia/Katmandu",
  "Central Asia Standard Time": "Asia/Almaty",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Myanmar Standard Time": "Asia/Rangoon",
  "SE Asia Standard Time": "Asia/Bangkok",
  "North Asia Standard Time": "Asia/Krasnoyarsk",
  "China Standard Time": "Asia/Shanghai",
  "North Asia East Standard Time": "Asia/Irkutsk",
  "Singapore Standard Time": "Asia/Singapore",
  "W. Australia Standard Time": "Australia/Perth",
  "Taipei Standard Time": "Asia/Taipei",
  "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "Yakutsk Standard Time": "Asia/Yakutsk",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "West Pacific Standard Time": "Pacific/Port_Moresby",
  "Tasmania Standard Time": "Australia/Hobart",
  "Vladivostok Standard Time": "Asia/Vladivostok",
  "Central Pacific Standard Time": "Pacific/Guadalcanal",
  "New Zealand Standard Time": "Pacific/Auckland",
  "UTC+12": "Etc/GMT-12",
  "Fiji Standard Time": "Pacific/Fiji",
  "Tonga Standard Time": "Pacific/Tongatapu",
  "Samoa Standard Time": "Pacific/Apia",
};

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** Whether Intl knows the zone. */
export function isIanaZone(zone: string): boolean {
  try {
    zoneFormat(zone);
    return true;
  } catch {
    return false;
  }
}

function zoneFormat(zone: string): Intl.DateTimeFormat {
  let f = zoneFormats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormats.set(zone, f);
  }
  return f;
}

/** The zone's offset from UTC in minutes at an instant. */
export function zoneOffsetMinutes(zone: string, at: Date): number {
  const parts = zoneFormat(zone).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Resolves a TZID to an IANA zone: itself when Intl knows it, the Windows map otherwise, else null. */
export function ianaZoneOf(tzid: string | undefined | null): string | null {
  if (!tzid) return null;
  const trimmed = tzid.replace(/^\//, "");
  if (isIanaZone(trimmed)) return trimmed;
  const mapped = WINDOWS_ZONES[trimmed];
  if (mapped && isIanaZone(mapped)) return mapped;
  // Some servers prefix the Olson name with a vendor path: /mozilla.org/20050126_1/Europe/Dublin.
  const tail = trimmed.split("/").slice(-2).join("/");
  if (tail !== trimmed && isIanaZone(tail)) return tail;
  return null;
}

/** A wall-clock time in a zone as an instant. Two passes settle the offset across a transition. */
export function zonedToUtc(
  zone: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let offset = zoneOffsetMinutes(zone, new Date(guess));
  let result = guess - offset * 60_000;
  const again = zoneOffsetMinutes(zone, new Date(result));
  if (again !== offset) {
    offset = again;
    result = guess - offset * 60_000;
  }
  return new Date(result);
}

/** The wall-clock parts of an instant in a zone. */
export function utcToZoned(
  zone: string,
  at: Date,
): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = zoneFormat(zone).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour") % 24,
    mi: get("minute"),
    s: get("second"),
  };
}

/* ------------------------------ Meeting links ------------------------------ */

/** The first https URL that looks like a meeting link in a piece of text. */
export function meetingLinkIn(text: string | null | undefined): string | null {
  if (!text) return null;
  const m =
    /https?:\/\/(?:[\w.-]*\.)?(?:meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|zoom\.us|meet\.jit\.si|whereby\.com|webex\.com|meet\.[\w.-]+)\/[^\s<>"')\]]*/i.exec(
      text,
    );
  return m ? m[0].replace(/[.,;]+$/, "") : null;
}

/* ------------------------------ Recurrence ------------------------------ */

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** A DATE or UTC DATE-TIME value as an instant, for UNTIL; null when malformed. */
function basicDate(value: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/.exec(value.trim());
  if (!m) return null;
  return new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    ),
  );
}

export interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: Date | null;
  byDay: number[];
  byMonthDay: number[];
  byMonth: number[];
}

export function parseRRule(rrule: string): RecurrenceRule | null {
  const parts: Record<string, string> = {};
  for (const piece of rrule.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = piece.split("=");
    if (k && v !== undefined) parts[k.toUpperCase()] = v;
  }
  const freq = parts.FREQ?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const until = parts.UNTIL ? basicDate(parts.UNTIL) : null;
  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL ?? "1") || 1),
    count: parts.COUNT ? Number(parts.COUNT) || null : null,
    until,
    byDay: (parts.BYDAY ?? "")
      .split(",")
      .map((d) => WEEKDAYS.indexOf(d.replace(/^[+-]?\d+/, "").toUpperCase()))
      .filter((i) => i >= 0),
    byMonthDay: (parts.BYMONTHDAY ?? "")
      .split(",")
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n !== 0),
    byMonth: (parts.BYMONTH ?? "")
      .split(",")
      .map((v) => Number(v))
      .filter((n) => n >= 1 && n <= 12),
  };
}

export interface Occurrence {
  start: Date;
  end: Date;
}

/**
 * The instances of a recurring Event inside a window (RFC 5545 3.3.10, the
 * common subset: FREQ, INTERVAL, COUNT, UNTIL, BYDAY for weekly rules,
 * BYMONTHDAY and BYMONTH). Wall-clock arithmetic runs in the Event's zone so
 * a 09:00 meeting stays at 09:00 across a DST change. EXDATE instances are
 * left out. Capped so a malformed rule cannot spin.
 */
export function expandRecurrence(
  rrule: string,
  start: Date,
  end: Date,
  zone: string | null,
  window: { from: Date; to: Date },
  exdates: readonly Date[] = [],
  cap = 1000,
): Occurrence[] {
  const rule = parseRRule(rrule);
  if (!rule) return [];
  const duration = end.getTime() - start.getTime();
  const tz = zone ?? "Etc/UTC";
  const origin = utcToZoned(tz, start);
  const excluded = new Set(exdates.map((d) => d.getTime()));
  const out: Occurrence[] = [];
  let produced = 0;
  const emit = (at: Date): boolean => {
    produced += 1;
    if (rule.count !== null && produced > rule.count) return false;
    if (rule.until && at.getTime() > rule.until.getTime()) return false;
    if (at.getTime() >= window.to.getTime()) return false;
    const finish = new Date(at.getTime() + duration);
    if (finish.getTime() > window.from.getTime() && !excluded.has(at.getTime())) {
      out.push({ start: at, end: finish });
    }
    return true;
  };
  const make = (y: number, mo: number, d: number) =>
    zonedToUtc(tz, y, mo, d, origin.h, origin.mi, origin.s);
  const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

  if (rule.freq === "DAILY") {
    for (let i = 0; i < cap; i++) {
      const day = new Date(Date.UTC(origin.y, origin.mo - 1, origin.d + i * rule.interval));
      const at = make(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      if (rule.byDay.length > 0 && !rule.byDay.includes(day.getUTCDay())) continue;
      if (!emit(at)) break;
    }
    return out;
  }
  if (rule.freq === "WEEKLY") {
    const startDay = new Date(Date.UTC(origin.y, origin.mo - 1, origin.d));
    const weekdays = rule.byDay.length > 0 ? [...rule.byDay].sort() : [startDay.getUTCDay()];
    // Weeks start on Monday for the iteration; the first week is the one holding DTSTART.
    const weekStart = new Date(startDay.getTime() - ((startDay.getUTCDay() + 6) % 7) * 86_400_000);
    let stop = false;
    for (let w = 0; w < cap && !stop; w++) {
      const base = new Date(weekStart.getTime() + w * rule.interval * 7 * 86_400_000);
      for (const wd of weekdays) {
        const offset = (wd + 6) % 7;
        const day = new Date(base.getTime() + offset * 86_400_000);
        if (day.getTime() < startDay.getTime()) continue;
        const at = make(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
        if (!emit(at)) {
          stop = true;
          break;
        }
      }
    }
    return out;
  }
  if (rule.freq === "MONTHLY") {
    const monthDays = rule.byMonthDay.length > 0 ? rule.byMonthDay : [origin.d];
    let stop = false;
    for (let m = 0; m < cap && !stop; m++) {
      const first = new Date(Date.UTC(origin.y, origin.mo - 1 + m * rule.interval, 1));
      const y = first.getUTCFullYear();
      const mo = first.getUTCMonth() + 1;
      const days = daysInMonth(y, mo);
      for (const md of monthDays) {
        const d = md < 0 ? days + md + 1 : md;
        if (d < 1 || d > days) continue;
        const at = make(y, mo, d);
        if (at.getTime() < start.getTime()) continue;
        if (!emit(at)) {
          stop = true;
          break;
        }
      }
    }
    return out;
  }
  const months = rule.byMonth.length > 0 ? rule.byMonth : [origin.mo];
  let stop = false;
  for (let yr = 0; yr < cap && !stop; yr++) {
    const y = origin.y + yr * rule.interval;
    for (const mo of months) {
      const d = Math.min(origin.d, daysInMonth(y, mo));
      const at = make(y, mo, d);
      if (at.getTime() < start.getTime()) continue;
      if (!emit(at)) {
        stop = true;
        break;
      }
    }
  }
  return out;
}
