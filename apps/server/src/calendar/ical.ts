// iCalendar in and out (RFC 5545, 5546, 6047; docs/research/calendar-apis.md,
// "Invites in mail"). One parser for the text/calendar parts in Messages and
// the objects a CalDAV server holds, one generator for the REQUEST, REPLY and
// CANCEL bodies monday mails where the Provider will not. Zones and the
// recurrence expander live in packages/shared (calendar.ts) so the client
// expands masters the same way. Runtime-neutral: Intl only.

import type { Attendee, EventStatus, InviteMethod, Person, RsvpResponse } from "@monday/shared";
import {
  ianaZoneOf,
  meetingLinkIn,
  utcToZoned,
  zonedToUtc,
  zoneOffsetMinutes,
} from "@monday/shared";

/* ------------------------------ Lines and properties ------------------------------ */

export interface ICalProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface ICalComponent {
  name: string;
  properties: ICalProperty[];
  components: ICalComponent[];
}

/** Joins folded lines (RFC 5545 3.1): a line starting with a space or tab continues the previous one. */
export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      out.push(raw);
    }
  }
  return out;
}

/** Folds a content line at 75 octets, as the generator must (3.1). */
export function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

function parseLine(line: string): ICalProperty | null {
  // NAME(;PARAM=value|"quoted")*:value
  let i = 0;
  let name = "";
  while (i < line.length && line[i] !== ";" && line[i] !== ":") name += line[i++];
  if (!name) return null;
  const params: Record<string, string> = {};
  while (i < line.length && line[i] === ";") {
    i++;
    let key = "";
    while (i < line.length && line[i] !== "=" && line[i] !== ":" && line[i] !== ";")
      key += line[i++];
    let value = "";
    if (line[i] === "=") {
      i++;
      if (line[i] === '"') {
        i++;
        while (i < line.length && line[i] !== '"') value += line[i++];
        i++;
      } else {
        while (i < line.length && line[i] !== ";" && line[i] !== ":") value += line[i++];
      }
    }
    params[key.toUpperCase()] = value;
  }
  if (line[i] !== ":") return { name: name.toUpperCase(), params, value: "" };
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** The component tree of an iCalendar text. Tolerant: stray lines are kept on the nearest component. */
export function parseComponents(text: string): ICalComponent[] {
  const roots: ICalComponent[] = [];
  const stack: ICalComponent[] = [];
  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const component: ICalComponent = {
        name: prop.value.toUpperCase(),
        properties: [],
        components: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.components.push(component);
      else roots.push(component);
      stack.push(component);
    } else if (prop.name === "END") {
      stack.pop();
    } else {
      stack[stack.length - 1]?.properties.push(prop);
    }
  }
  return roots;
}

export function propertyOf(component: ICalComponent, name: string): ICalProperty | null {
  return component.properties.find((p) => p.name === name) ?? null;
}

export function propertiesOf(component: ICalComponent, name: string): ICalProperty[] {
  return component.properties.filter((p) => p.name === name);
}

/** TEXT value unescaping (3.3.11). */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/* ------------------------------ Dates ------------------------------ */

export interface ICalDate {
  date: Date;
  allDay: boolean;
  /** The IANA zone the value was given in; null for UTC and floating values. */
  zone: string | null;
}

/**
 * A DATE or DATE-TIME value with its TZID (3.3.4, 3.3.5). An all-day value is
 * the UTC midnight of that day. A floating value with no zone is read as UTC;
 * a TZID Intl cannot resolve falls back to the offset the VTIMEZONE declares.
 */
export function parseDate(
  prop: ICalProperty,
  timezones: Map<string, number> = new Map(),
): ICalDate | null {
  const value = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
  if (!m) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : { date: parsed, allDay: false, zone: null };
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (m[4] === undefined || prop.params.VALUE === "DATE") {
    return { date: new Date(Date.UTC(y, mo - 1, d)), allDay: true, zone: null };
  }
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6] ?? "0");
  if (m[7] === "Z")
    return { date: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), allDay: false, zone: null };
  const tzid = prop.params.TZID;
  const zone = ianaZoneOf(tzid);
  if (zone) return { date: zonedToUtc(zone, y, mo, d, h, mi, s), allDay: false, zone };
  const declared = tzid ? timezones.get(tzid) : undefined;
  if (declared !== undefined) {
    return {
      date: new Date(Date.UTC(y, mo - 1, d, h, mi, s) - declared * 60_000),
      allDay: false,
      zone: null,
    };
  }
  return { date: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), allDay: false, zone: null };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** A DATE-TIME in UTC form (20260918T150000Z). */
export function formatUtc(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** A DATE (20260918) for an all-day value. */
export function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

/** A DATE-TIME as wall-clock in a zone, for DTSTART;TZID=... lines. */
export function formatZoned(zone: string, date: Date): string {
  const z = utcToZoned(zone, date);
  return `${z.y}${pad(z.mo)}${pad(z.d)}T${pad(z.h)}${pad(z.mi)}${pad(z.s)}`;
}

/** An ISO 8601 duration (3.3.6) in milliseconds; null when malformed. */
export function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const weeks = Number(m[2] ?? 0);
  const days = Number(m[3] ?? 0);
  const hours = Number(m[4] ?? 0);
  const minutes = Number(m[5] ?? 0);
  const seconds = Number(m[6] ?? 0);
  return sign * (((weeks * 7 + days) * 24 * 3600 + hours * 3600 + minutes * 60 + seconds) * 1000);
}

/**
 * The offsets a VTIMEZONE declares, by TZID, for zones Intl does not know:
 * the STANDARD offset, or the DAYLIGHT one when only that is present.
 */
export function declaredOffsets(calendar: ICalComponent): Map<string, number> {
  const out = new Map<string, number>();
  for (const tz of calendar.components.filter((c) => c.name === "VTIMEZONE")) {
    const tzid = propertyOf(tz, "TZID")?.value;
    if (!tzid) continue;
    const standard = tz.components.find((c) => c.name === "STANDARD");
    const daylight = tz.components.find((c) => c.name === "DAYLIGHT");
    const to = propertyOf(standard ?? daylight ?? tz, "TZOFFSETTO")?.value;
    if (!to) continue;
    const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(to.trim());
    if (!m) continue;
    const minutes = Number(m[2]) * 60 + Number(m[3]);
    out.set(tzid, m[1] === "-" ? -minutes : minutes);
  }
  return out;
}

/* ------------------------------ Events ------------------------------ */

/** A VEVENT as parsed: the fields the calendar module and the invite bar read. */
export interface ParsedEvent {
  uid: string;
  sequence: number;
  /** DTSTAMP, or null when absent. */
  stamp: Date | null;
  title: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** The IANA zone DTSTART was given in. */
  zone: string | null;
  organizer: Person | null;
  attendees: Attendee[];
  status: EventStatus;
  recurrence: string | null;
  /** RECURRENCE-ID, when the VEVENT addresses one instance. */
  recurrenceId: Date | null;
  exdates: Date[];
  /** CONFERENCE (RFC 7986), or a meeting URL found in LOCATION or DESCRIPTION. */
  link: string | null;
  /** Vendor properties kept as they came, for round trips. */
  extra: Record<string, string>;
}

export interface ParsedCalendar {
  method: InviteMethod | null;
  events: ParsedEvent[];
}

const PARTSTAT_OF: Record<string, RsvpResponse> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  "NEEDS-ACTION": "needs-action",
  DELEGATED: "needs-action",
};

const PARTSTAT_FOR: Record<RsvpResponse, string> = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
  "needs-action": "NEEDS-ACTION",
};

export function mailtoOf(value: string): string {
  return value
    .replace(/^mailto:/i, "")
    .trim()
    .toLowerCase();
}

function personOf(prop: ICalProperty): Person {
  return { name: prop.params.CN ?? "", email: mailtoOf(prop.value) };
}

function attendeeOf(prop: ICalProperty): Attendee {
  const partstat = (prop.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase();
  const role = (prop.params.ROLE ?? "REQ-PARTICIPANT").toUpperCase();
  return {
    ...personOf(prop),
    response: PARTSTAT_OF[partstat] ?? "needs-action",
    ...(role === "OPT-PARTICIPANT" || role === "NON-PARTICIPANT" ? { optional: true } : {}),
    ...(role === "CHAIR" ? { organizer: true } : {}),
  };
}

const STATUS_OF: Record<string, EventStatus> = {
  CONFIRMED: "confirmed",
  TENTATIVE: "tentative",
  CANCELLED: "cancelled",
};

const METHODS: readonly InviteMethod[] = ["REQUEST", "REPLY", "CANCEL", "PUBLISH"];

function parseEvent(
  vevent: ICalComponent,
  timezones: Map<string, number>,
  method: InviteMethod | null,
): ParsedEvent | null {
  const uid = propertyOf(vevent, "UID")?.value.trim();
  const dtstart = propertyOf(vevent, "DTSTART");
  if (!uid || !dtstart) return null;
  const start = parseDate(dtstart, timezones);
  if (!start) return null;
  const dtend = propertyOf(vevent, "DTEND");
  const duration = propertyOf(vevent, "DURATION");
  let end: Date;
  if (dtend) {
    const parsed = parseDate(dtend, timezones);
    end = parsed?.date ?? start.date;
  } else if (duration) {
    end = new Date(start.date.getTime() + (parseDuration(duration.value) ?? 0));
  } else {
    // 3.6.1: an all-day event with no end lasts one day; a timed one is instantaneous.
    end = start.allDay ? new Date(start.date.getTime() + 86_400_000) : start.date;
  }
  const organizerProp = propertyOf(vevent, "ORGANIZER");
  const attendees = propertiesOf(vevent, "ATTENDEE").map(attendeeOf);
  const organizer = organizerProp ? personOf(organizerProp) : null;
  if (organizer) {
    for (const a of attendees) if (a.email === organizer.email) a.organizer = true;
  }
  const description = unescapeText(propertyOf(vevent, "DESCRIPTION")?.value ?? "");
  const location = unescapeText(propertyOf(vevent, "LOCATION")?.value ?? "");
  const conference = propertyOf(vevent, "CONFERENCE")?.value ?? null;
  const url = propertyOf(vevent, "URL")?.value ?? null;
  const vendorLink =
    propertyOf(vevent, "X-GOOGLE-CONFERENCE")?.value ??
    propertyOf(vevent, "X-MICROSOFT-SKYPETEAMSMEETINGURL")?.value ??
    null;
  const status = propertyOf(vevent, "STATUS")?.value.toUpperCase() ?? "";
  const rrule = propertyOf(vevent, "RRULE")?.value ?? null;
  const recurrenceIdProp = propertyOf(vevent, "RECURRENCE-ID");
  const exdates = propertiesOf(vevent, "EXDATE").flatMap((p) =>
    p.value
      .split(",")
      .map((v) => parseDate({ ...p, value: v }, timezones)?.date)
      .filter((d): d is Date => d !== undefined),
  );
  const stampProp = propertyOf(vevent, "DTSTAMP");
  const extra: Record<string, string> = {};
  for (const p of vevent.properties) if (p.name.startsWith("X-")) extra[p.name] = p.value;
  return {
    uid,
    sequence: Number(propertyOf(vevent, "SEQUENCE")?.value ?? "0") || 0,
    stamp: stampProp ? (parseDate(stampProp, timezones)?.date ?? null) : null,
    title: unescapeText(propertyOf(vevent, "SUMMARY")?.value ?? ""),
    description,
    location,
    start: start.date,
    end,
    allDay: start.allDay,
    zone: start.zone,
    organizer,
    attendees,
    status: STATUS_OF[status] ?? (method === "CANCEL" ? "cancelled" : "confirmed"),
    recurrence: rrule,
    recurrenceId: recurrenceIdProp ? (parseDate(recurrenceIdProp, timezones)?.date ?? null) : null,
    exdates,
    link:
      conference ??
      vendorLink ??
      meetingLinkIn(location) ??
      meetingLinkIn(description) ??
      (url && meetingLinkIn(url) ? url : null),
    extra,
  };
}

/** Parses an iCalendar text into its method and VEVENTs; an empty list when it holds none. */
export function parseICalendar(text: string): ParsedCalendar {
  const roots = parseComponents(text);
  const calendar = roots.find((c) => c.name === "VCALENDAR") ?? roots[0];
  if (!calendar) return { method: null, events: [] };
  const methodValue = propertyOf(calendar, "METHOD")?.value.toUpperCase() ?? null;
  const method = METHODS.find((m) => m === methodValue) ?? null;
  const timezones = declaredOffsets(calendar);
  const events: ParsedEvent[] = [];
  for (const c of calendar.components) {
    if (c.name !== "VEVENT") continue;
    const parsed = parseEvent(c, timezones, method);
    if (parsed) events.push(parsed);
  }
  return { method, events };
}

/* ------------------------------ Generating ------------------------------ */

export interface EventToWrite {
  uid: string;
  sequence: number;
  stamp: Date;
  title: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** Wall-clock zone for timed values; UTC form when null. */
  zone: string | null;
  organizer: Person | null;
  attendees: Attendee[];
  status: EventStatus;
  recurrence: string | null;
  link: string | null;
  /** RECURRENCE-ID for a reply or cancel of one instance. */
  recurrenceId?: Date | null;
}

function dateLine(name: string, date: Date, allDay: boolean, zone: string | null): string {
  if (allDay) return `${name};VALUE=DATE:${formatDate(date)}`;
  if (zone) return `${name};TZID=${zone}:${formatZoned(zone, date)}`;
  return `${name}:${formatUtc(date)}`;
}

function personLine(name: string, p: Person, params: string[] = []): string {
  const all = [...(p.name ? [`CN=${p.name.replace(/[;:",]/g, " ")}`] : []), ...params];
  return `${name}${all.length > 0 ? `;${all.join(";")}` : ""}:mailto:${p.email}`;
}

/**
 * A VTIMEZONE for a zone, with the offsets in force at the Event (a fixed
 * STANDARD block, enough for the receiving side to place the wall-clock
 * value; RFC 5545 3.2.19 asks for the component to be present).
 */
function timezoneBlock(zone: string, at: Date): string[] {
  const offset = zoneOffsetMinutes(zone, at);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const text = `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
  return [
    "BEGIN:VTIMEZONE",
    `TZID:${zone}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    `TZOFFSETFROM:${text}`,
    `TZOFFSETTO:${text}`,
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
}

const STATUS_LINE: Record<EventStatus, string> = {
  confirmed: "CONFIRMED",
  tentative: "TENTATIVE",
  cancelled: "CANCELLED",
};

function eventLines(event: EventToWrite, method: InviteMethod | null): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${formatUtc(event.stamp)}`,
    `SEQUENCE:${event.sequence}`,
    dateLine("DTSTART", event.start, event.allDay, event.zone),
    dateLine("DTEND", event.end, event.allDay, event.zone),
    `SUMMARY:${escapeText(event.title)}`,
  ];
  if (event.recurrenceId) {
    lines.push(dateLine("RECURRENCE-ID", event.recurrenceId, event.allDay, event.zone));
  }
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.link) lines.push(`CONFERENCE;VALUE=URI;FEATURE=VIDEO:${event.link}`);
  if (event.recurrence) lines.push(`RRULE:${event.recurrence}`);
  lines.push(`STATUS:${STATUS_LINE[event.status]}`);
  if (event.organizer) lines.push(personLine("ORGANIZER", event.organizer));
  for (const a of event.attendees) {
    lines.push(
      personLine("ATTENDEE", a, [
        `ROLE=${a.optional ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT"}`,
        `PARTSTAT=${PARTSTAT_FOR[a.response]}`,
        ...(method === "REQUEST" ? ["RSVP=TRUE"] : []),
      ]),
    );
  }
  lines.push("END:VEVENT");
  return lines;
}

/** A complete VCALENDAR text for an Event, with METHOD when it travels by mail. */
export function writeICalendar(event: EventToWrite, method: InviteMethod | null): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//monday//calendar//EN"];
  if (method) lines.push(`METHOD:${method}`);
  if (event.zone && !event.allDay) lines.push(...timezoneBlock(event.zone, event.start));
  lines.push(...eventLines(event, method));
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/**
 * An iTIP REPLY (RFC 5546 3.2.3): the same UID and SEQUENCE, the organizer,
 * and exactly one ATTENDEE, the replier with the new PARTSTAT.
 */
export function writeReply(
  event: EventToWrite,
  replier: Person,
  response: RsvpResponse,
  stamp: Date,
): string {
  return writeICalendar(
    {
      ...event,
      stamp,
      attendees: [{ ...replier, response }],
    },
    "REPLY",
  );
}
