// The calendar tools (slice 18, ADR 0002): what "set up a call with Aoife
// Thursday 15:00" runs. The reads (list_calendars, list_events,
// search_events, find_free_time, get_calendar_draft) run silently;
// schedule_event, update_event, move_event and rsvp leave the mailbox (an
// invitation, an update or a reply goes out, by the Provider or by monday)
// so they always ask first with the card that shows the slot, the people,
// the link and who will mail; delete_event is destructive. For work that
// touches several Events (planning a week, clearing an afternoon)
// propose_calendar_draft writes nothing: it hands the user one draft to
// review on the Calendar and apply, and applying asks before any guest is
// emailed. The tools see the calendar through a seam the tool server is
// handed (the calendar module on the Server); a host without one refuses.

import type {
  Calendar,
  CalendarDraft,
  CalendarDraftChange,
  CalendarEvent,
  CalendarInfo,
  DraftEventFields,
  EventInput,
  EventPatch,
  EventPreview,
  EventWriteOptions,
  IntentResult,
  Invite,
  InviteIntent,
  IsoDate,
  MeetingLinkKind,
  MeetingLinkSetting,
  Person,
  RecurrenceScope,
  RsvpResponse,
  ToolPreview,
} from "@monday/shared";
import {
  expandRecurrence,
  isIanaZone,
  settingsSchema,
  utcToZoned,
  zonedToUtc,
} from "@monday/shared";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolPlan } from "./catalog.ts";

/** What the calendar tools act through: the calendar module on the Server. */
export interface CalendarSeam {
  info(workspaceId: string): Promise<CalendarInfo>;
  /** Every calendar of the Workspace: its own, and the ones others share with it. */
  listCalendars(workspaceId: string): Promise<Calendar[]>;
  /** The Workspace Account's own address. */
  selfAddress(workspaceId: string): Promise<string>;
  listEvents(
    workspaceId: string,
    options: { from: IsoDate; to: IsoDate; calendarIds?: string[] },
  ): Promise<CalendarEvent[]>;
  busy(
    workspaceId: string,
    from: IsoDate,
    to: IsoDate,
  ): Promise<{ eventId: string; start: IsoDate; end: IsoDate; title: string }[]>;
  readEvent(eventId: string): Promise<CalendarEvent | null>;
  createEvent(
    workspaceId: string,
    input: EventInput,
    options?: { byAgent?: boolean },
  ): Promise<CalendarEvent>;
  updateEvent(
    eventId: string,
    patch: EventPatch,
    options?: EventWriteOptions,
  ): Promise<CalendarEvent>;
  deleteEvent(eventId: string, options?: EventWriteOptions): Promise<void>;
  respond(eventId: string, response: RsvpResponse): Promise<CalendarEvent>;
  invitesOfThread(threadId: string): Promise<Invite[]>;
  applyInviteIntent(intent: InviteIntent): Promise<IntentResult>;
}

const person = z.union([
  z.string().describe("An address, or Name <address>"),
  z.object({ name: z.string().default(""), email: z.string() }),
]);

function toPerson(value: string | { name: string; email: string }): Person {
  if (typeof value !== "string") return value;
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  return m ? { name: m[1] ?? "", email: m[2] ?? "" } : { name: "", email: value.trim() };
}

const meetingLink = z.enum(["none", "google-meet", "teams", "jitsi", "custom"]);
const rsvpValue = z.enum(["accepted", "tentative", "declined"]);
const isoDate = z.iso.datetime({ offset: true });
const scopeInput = z
  .enum(["this", "following", "all"])
  .optional()
  .describe(
    "On a repeating Event: this instance only (the default), this and the following ones, or the whole series",
  );
const occurrenceInput = isoDate
  .optional()
  .describe(
    "The instance's own start, as list_events gives it in `occurrence`, when the id names a repeating series",
  );
const remindersInput = z
  .array(z.int().min(0).max(40_320))
  .max(12)
  .nullable()
  .optional()
  .describe("Minutes before the start to remind; [] for none, null for the calendar's default");
const calendarIdsInput = z
  .array(z.string().min(1))
  .max(100)
  .optional()
  .describe("Only these calendars (ids from list_calendars); default every visible one");

function refused(text: string): ToolPlan {
  return { kind: "refused", text };
}

const NO_CALENDAR = "The calendar is not available from this host.";

/** An Event, or one instance of a repeating series, in a window. */
export interface EventInstance {
  event: CalendarEvent;
  start: IsoDate;
  end: IsoDate;
  /** The instance's own start when it was expanded from a series kept here; pass it back as `occurrence`. */
  occurrence: IsoDate | null;
}

/**
 * The instances inside a window, as the Calendar shows them: single Events
 * and the instances Google and Graph hand over as they are, and the series
 * CalDAV and the Local calendar keep expanded with the shared expander.
 */
export function instancesIn(
  events: readonly CalendarEvent[],
  window: { from: Date; to: Date },
): EventInstance[] {
  const out: EventInstance[] = [];
  for (const e of events) {
    if (e.recurrence && !e.recurringEventId) {
      for (const o of expandRecurrence(
        e.recurrence,
        new Date(e.start),
        new Date(e.end),
        e.timeZone,
        window,
      )) {
        out.push({
          event: e,
          start: o.start.toISOString(),
          end: o.end.toISOString(),
          occurrence: o.start.toISOString(),
        });
      }
      continue;
    }
    const s = Date.parse(e.start);
    const en = Date.parse(e.end);
    if (en <= window.from.getTime() || s >= window.to.getTime()) continue;
    out.push({ event: e, start: e.start, end: e.end, occurrence: null });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

/** Every word of the query in the Event's title, place, notes or people. */
export function eventMatches(e: CalendarEvent, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    e.title,
    e.location,
    e.description,
    e.organizer?.name ?? "",
    e.organizer?.email ?? "",
    ...e.attendees.flatMap((a) => [a.name, a.email]),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

function compact(
  e: CalendarEvent,
  at?: { start: IsoDate; end: IsoDate; occurrence: IsoDate | null },
) {
  return {
    id: e.id,
    calendarId: e.calendarId,
    title: e.title,
    start: at?.start ?? e.start,
    end: at?.end ?? e.end,
    ...(at?.occurrence ? { occurrence: at.occurrence } : {}),
    allDay: e.allDay,
    timeZone: e.timeZone,
    location: e.location,
    attendees: e.attendees.map((a) => ({ email: a.email, name: a.name, response: a.response })),
    organizer: e.organizer,
    link: e.link,
    status: e.status,
    response: e.response,
    recurrence: e.recurrence,
    recurringEventId: e.recurringEventId,
    reminders: e.reminders ?? null,
    createdByAgent: e.createdByAgent,
  };
}

function when(start: IsoDate, end: IsoDate, allDay: boolean): string {
  if (allDay) return start.slice(0, 10);
  return `${start.replace("T", " ").slice(0, 16)} to ${end.replace("T", " ").slice(0, 16)} UTC`;
}

/** One line per instance, as list_events and search_events answer. */
function instanceLine(i: EventInstance): string {
  const e = i.event;
  const others = e.attendees.filter((a) => !a.self).map((a) => a.name || a.email);
  return `- ${e.id}: ${e.title} (${when(i.start, i.end, e.allDay)})${
    i.occurrence ? ` occurrence ${i.occurrence}` : ""
  }${e.attendees.length > 1 ? ` with ${others.join(", ")}` : ""}${e.link ? ` ${e.link}` : ""}${
    e.response && e.response !== "accepted" ? ` [${e.response}]` : ""
  }`;
}

/** Overlapping own Events, leaving out the one being edited. */
async function conflictsFor(
  seam: CalendarSeam,
  workspaceId: string,
  start: IsoDate,
  end: IsoDate,
  exceptId?: string,
): Promise<string[]> {
  const busy = await seam.busy(workspaceId, start, end);
  return busy.filter((b) => b.eventId !== exceptId).map((b) => b.title);
}

/** The shared meeting link Setting resolved against the Provider, for the card. */
async function settingLink(ctx: ToolContext, info: CalendarInfo): Promise<MeetingLinkKind> {
  const shared = await ctx.host.readSetting("calendar.meeting_link");
  const kinds: readonly string[] = ["provider", "none", "google-meet", "teams", "jitsi", "custom"];
  const chosen: MeetingLinkSetting =
    typeof shared.value === "string" && kinds.includes(shared.value)
      ? (shared.value as MeetingLinkSetting)
      : settingsSchema["calendar.meeting_link"].default;
  return chosen === "provider" ? info.defaultMeetingLink : chosen;
}

function invitesBy(info: CalendarInfo, attendees: readonly Person[]): EventPreview["invitesBy"] {
  if (attendees.length === 0) return "none";
  return info.providerSendsInvites ? "provider" : "monday";
}

/* ------------------------------ Settings ------------------------------ */

async function numberSetting(ctx: ToolContext, key: string, fallback: number): Promise<number> {
  const read = await ctx.host.readSetting(key);
  return typeof read.value === "number" && Number.isFinite(read.value) ? read.value : fallback;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WorkDay = (typeof WEEKDAYS)[number];

async function workDaysSetting(ctx: ToolContext): Promise<WorkDay[]> {
  const read = await ctx.host.readSetting("calendar.work_days");
  if (Array.isArray(read.value)) {
    return read.value.filter((d): d is WorkDay => WEEKDAYS.includes(d as WorkDay));
  }
  return [...settingsSchema["calendar.work_days"].default];
}

/**
 * The zone working hours are read in: the tool's input, else the
 * calendar.time_zone Setting where one is set, else UTC.
 */
async function zoneFor(ctx: ToolContext, given: string | undefined): Promise<string | null> {
  if (given) return isIanaZone(given) ? given : null;
  const read = await ctx.host.readSetting("calendar.time_zone");
  if (typeof read.value === "string" && read.value && isIanaZone(read.value)) return read.value;
  return "UTC";
}

async function defaultDuration(ctx: ToolContext): Promise<number> {
  return numberSetting(
    ctx,
    "calendar.default_duration_minutes",
    settingsSchema["calendar.default_duration_minutes"].default,
  );
}

/** The window the Cache keeps, from the sync Settings: the default window a search looks through. */
async function syncedWindow(ctx: ToolContext): Promise<{ from: IsoDate; to: IsoDate }> {
  const past = await numberSetting(
    ctx,
    "calendar.window_past_days",
    settingsSchema["calendar.window_past_days"].default,
  );
  const future = await numberSetting(
    ctx,
    "calendar.window_future_days",
    settingsSchema["calendar.window_future_days"].default,
  );
  const now = ctx.now().getTime();
  return {
    from: new Date(now - past * 86_400_000).toISOString(),
    to: new Date(now + future * 86_400_000).toISOString(),
  };
}

/* ------------------------------ Free time ------------------------------ */

export interface FreeSlotOptions {
  from: Date;
  to: Date;
  durationMinutes: number;
  /** Busy spans to keep clear of. */
  busy: readonly { start: IsoDate | Date; end: IsoDate | Date }[];
  /** Working hours, in the zone: the first hour and the hour the day ends (24 for midnight). */
  dayStartHour: number;
  dayEndHour: number;
  workDays: readonly WorkDay[];
  /** Slots start on multiples of this many minutes from the start of the working day. */
  stepMinutes: number;
  /** The IANA zone working hours are read in. */
  timeZone: string;
  limit: number;
}

/**
 * Free slots of a length inside working hours on working days, clear of the
 * busy spans, earliest first, not overlapping one another. Wall-clock hours
 * are read in the zone, so a DST change keeps the working day at 09:00.
 */
export function freeSlots(o: FreeSlotOptions): { start: IsoDate; end: IsoDate }[] {
  const out: { start: IsoDate; end: IsoDate }[] = [];
  const from = o.from.getTime();
  const to = o.to.getTime();
  const duration = o.durationMinutes * 60_000;
  const step = Math.max(1, o.stepMinutes) * 60_000;
  if (duration <= 0 || to <= from || o.dayEndHour <= o.dayStartHour || o.limit <= 0) return out;
  const busy = o.busy
    .map((b) => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() }))
    .filter((b) => b.e > b.s)
    .sort((a, b) => a.s - b.s);
  const first = utcToZoned(o.timeZone, o.from);
  for (let i = 0; i < 800 && out.length < o.limit; i++) {
    const day = new Date(Date.UTC(first.y, first.mo - 1, first.d + i));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const open = zonedToUtc(o.timeZone, y, mo, d, o.dayStartHour, 0, 0).getTime();
    if (open >= to) break;
    const weekday = WEEKDAYS[day.getUTCDay()];
    if (!weekday || !o.workDays.includes(weekday)) continue;
    const close = zonedToUtc(o.timeZone, y, mo, d, o.dayEndHour, 0, 0).getTime();
    const lo = Math.max(open, from);
    const hi = Math.min(close, to);
    let t = open + Math.ceil((lo - open) / step) * step;
    while (t + duration <= hi && out.length < o.limit) {
      const end = t + duration;
      const clash = busy.find((b) => b.s < end && b.e > t);
      if (clash) {
        t = open + Math.ceil((clash.e - open) / step) * step;
        continue;
      }
      out.push({ start: new Date(t).toISOString(), end: new Date(end).toISOString() });
      t = open + Math.ceil((end - open) / step) * step;
    }
  }
  return out;
}

/** "2026-09-21 09:00" in a zone. */
function wallClock(zone: string, at: IsoDate): string {
  const z2 = (n: number) => String(n).padStart(2, "0");
  const p = utcToZoned(zone, new Date(at));
  return `${p.y}-${z2(p.mo)}-${z2(p.d)} ${z2(p.h)}:${z2(p.mi)}`;
}

/* ------------------------------ Instances and access ------------------------------ */

function isSeries(e: CalendarEvent): boolean {
  return Boolean(e.recurrence) && !e.recurringEventId;
}

/**
 * The times of the instance a write aims at: the Event's own, or, on a
 * series kept here, the instance that starts at `occurrence` (null when the
 * series has no instance there).
 */
function instanceTimes(
  e: CalendarEvent,
  occurrence: IsoDate | undefined,
): { start: IsoDate; end: IsoDate } | null {
  if (!occurrence || !isSeries(e) || !e.recurrence) return { start: e.start, end: e.end };
  const at = Date.parse(occurrence);
  const found = expandRecurrence(e.recurrence, new Date(e.start), new Date(e.end), e.timeZone, {
    from: new Date(at - 60_000),
    to: new Date(at + 60_000),
  }).find((o) => o.start.getTime() === at);
  return found ? { start: found.start.toISOString(), end: found.end.toISOString() } : null;
}

/** The write options a scope and an occurrence make; an occurrence alone means this instance. */
function writeOptions(
  e: CalendarEvent,
  scope: RecurrenceScope | undefined,
  occurrence: IsoDate | undefined,
): EventWriteOptions | undefined {
  if (!e.recurrence && !e.recurringEventId) return undefined;
  const chosen = scope ?? (occurrence || e.recurringEventId ? "this" : undefined);
  if (!chosen && !occurrence) return undefined;
  return {
    ...(chosen ? { scope: chosen } : {}),
    ...(occurrence ? { occurrence: new Date(occurrence).toISOString() } : {}),
  };
}

/** Why the user cannot change Events on a calendar, or null when they can. */
function unwritable(c: Calendar | undefined): string | null {
  if (!c) return null;
  if (c.access === "free-busy") return `the calendar "${c.name}" shows only free and busy times`;
  if (!c.writable || c.access === "reader") return `the calendar "${c.name}" is read-only`;
  return null;
}

function othersOf(people: readonly Person[], self: string): Person[] {
  const me = self.toLowerCase();
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const p of people) {
    const email = p.email.toLowerCase();
    if (!email || email === me || seen.has(email)) continue;
    seen.add(email);
    out.push({ name: p.name, email: p.email });
  }
  return out;
}

/* ------------------------------ list_calendars ------------------------------ */

const listCalendars: ToolDefinition<Record<string, never>> = {
  name: "list_calendars",
  description:
    "Every calendar of the user's Account: their own and the ones other people share with them. Each has an id (for calendar_ids and calendar_id), its name, the access the user has (owner, writer, reader, or free-busy which shows only busy times), who shares it, whether it is shown and whether it is the primary. Only owner and writer calendars take new or changed Events.",
  tier: "read",
  input: z.object({}),
  summarize: () => "calendars",
  async run(_input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    const calendars = await seam.listCalendars(ctx.host.workspaceId);
    const rows = calendars.map((c) => ({
      id: c.id,
      name: c.name,
      access: c.access ?? (c.writable ? "owner" : "reader"),
      sharedBy: c.sharedBy ?? null,
      visible: c.visible,
      primary: c.primary,
      writable: c.writable,
      error: c.error ?? null,
    }));
    return {
      kind: "result",
      text:
        rows.length === 0
          ? "No calendars yet; they appear after the first sync."
          : `${rows.length} calendar${rows.length === 1 ? "" : "s"}:\n${rows
              .map(
                (c) =>
                  `- ${c.id}: ${c.name} (${c.access}${c.primary ? ", primary" : ""}${
                    c.visible ? "" : ", hidden"
                  }${
                    c.sharedBy ? `, shared by ${c.sharedBy.name || c.sharedBy.email}` : ""
                  })${c.error ? ` cannot be read: ${c.error}` : ""}`,
              )
              .join("\n")}`,
      data: { calendars: rows },
    };
  },
};

/* ------------------------------ list_events ------------------------------ */

async function instancesFor(
  seam: CalendarSeam,
  workspaceId: string,
  window: { from: IsoDate; to: IsoDate },
  options: { calendarIds?: string[] | undefined; includeDeclined?: boolean | undefined },
): Promise<EventInstance[]> {
  const events = await seam.listEvents(workspaceId, {
    ...window,
    ...(options.calendarIds && options.calendarIds.length > 0
      ? { calendarIds: options.calendarIds }
      : {}),
  });
  return instancesIn(
    events.filter((e) => options.includeDeclined || e.response !== "declined"),
    { from: new Date(window.from), to: new Date(window.to) },
  );
}

const listEvents: ToolDefinition<{
  from?: string | undefined;
  to?: string | undefined;
  days?: number | undefined;
  calendar_ids?: string[] | undefined;
  query?: string | undefined;
  include_declined?: boolean | undefined;
}> = {
  name: "list_events",
  description:
    "Events on the user's calendars in a window: from and to as ISO dates with offsets, or the next N days from now (default 7). Repeating Events come as their instances; an instance of a series kept on this Server carries an `occurrence` to pass back with scope to change or cancel just it. Optional calendar_ids narrows to some calendars (default every shown one), query keeps Events whose title, place, notes or people hold every word, include_declined keeps Events the user declined. Returns ids to act on with rsvp, update_event, move_event, delete_event or propose_calendar_draft. Use find_free_time to look for a free slot.",
  tier: "read",
  input: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    days: z
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Days ahead from now when from/to are absent"),
    calendar_ids: calendarIdsInput,
    query: z.string().max(500).optional().describe("Words every listed Event must hold"),
    include_declined: z.boolean().optional(),
  }),
  summarize: (i) =>
    `${i.from && i.to ? `${i.from.slice(0, 10)} to ${i.to.slice(0, 10)}` : `next ${i.days ?? 7} days`}${
      i.query ? `, "${i.query}"` : ""
    }`,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    const now = ctx.now();
    const from = input.from
      ? new Date(input.from).toISOString()
      : new Date(now.getTime() - 3_600_000).toISOString();
    const to = input.to
      ? new Date(input.to).toISOString()
      : new Date(Date.parse(from) + (input.days ?? 7) * 86_400_000).toISOString();
    if (Date.parse(to) <= Date.parse(from)) return refused("The window ends before it starts.");
    let found = await instancesFor(
      seam,
      ctx.host.workspaceId,
      { from, to },
      { calendarIds: input.calendar_ids, includeDeclined: input.include_declined },
    );
    if (input.query) {
      const q = input.query;
      found = found.filter((i) => eventMatches(i.event, q));
    }
    const info = await seam.info(ctx.host.workspaceId);
    return {
      kind: "result",
      text:
        found.length === 0
          ? `No Events between ${from.slice(0, 16)} and ${to.slice(0, 16)}${input.query ? ` matching "${input.query}"` : ""}.`
          : `${found.length} Event${found.length === 1 ? "" : "s"}:\n${found.map(instanceLine).join("\n")}`,
      data: { events: found.map((i) => compact(i.event, i)), calendar: info },
    };
  },
};

/* ------------------------------ search_events ------------------------------ */

const searchEvents: ToolDefinition<{
  query: string;
  from?: string | undefined;
  to?: string | undefined;
  calendar_ids?: string[] | undefined;
  include_declined?: boolean | undefined;
}> = {
  name: "search_events",
  description:
    'Find Events by words in their title, place, notes or people (every word must match), across everything the calendar keeps (by default from the Calendar history Setting back to the Calendar horizon ahead) or between from and to. Use it to find "the dentist appointment" or "my last call with Aoife"; use list_events for what is on in a given window.',
  tier: "read",
  input: z.object({
    query: z.string().min(1).max(500),
    from: isoDate.optional(),
    to: isoDate.optional(),
    calendar_ids: calendarIdsInput,
    include_declined: z.boolean().optional(),
  }),
  summarize: (i) => `"${i.query}"`,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    const synced = await syncedWindow(ctx);
    const from = input.from ? new Date(input.from).toISOString() : synced.from;
    const to = input.to ? new Date(input.to).toISOString() : synced.to;
    if (Date.parse(to) <= Date.parse(from)) return refused("The window ends before it starts.");
    const all = await instancesFor(
      seam,
      ctx.host.workspaceId,
      { from, to },
      { calendarIds: input.calendar_ids, includeDeclined: input.include_declined },
    );
    const matched = all.filter((i) => eventMatches(i.event, input.query));
    const shown = matched.slice(0, ctx.settings.searchLimit);
    const more = matched.length - shown.length;
    return {
      kind: "result",
      text:
        matched.length === 0
          ? `No Events matching "${input.query}" between ${from.slice(0, 10)} and ${to.slice(0, 10)}.`
          : `${matched.length} Event${matched.length === 1 ? "" : "s"} matching "${input.query}":\n${shown
              .map(instanceLine)
              .join("\n")}${more > 0 ? `\n${more} more; narrow the words or the window.` : ""}`,
      data: { events: shown.map((i) => compact(i.event, i)), total: matched.length },
    };
  },
};

/* ------------------------------ find_free_time ------------------------------ */

const findFreeTime: ToolDefinition<{
  from?: string | undefined;
  to?: string | undefined;
  duration_minutes?: number | undefined;
  attendees?: Array<string | { name: string; email: string }> | undefined;
  time_zone?: string | undefined;
  limit?: number | undefined;
}> = {
  name: "find_free_time",
  description:
    "Free slots on the user's own calendars: within working hours on working days (the Working day and Working days Settings), starting on the Snap to step, clear of the user's own Events (declined, cancelled and all-day ones do not block). Default window the next 7 days, default length the Meeting length Setting, up to limit slots (default 10). Hours are read in time_zone (IANA), else the calendar's time zone Setting, else UTC. Other people's free time is not known: attendees are only noted.",
  tier: "read",
  input: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    duration_minutes: z
      .int()
      .min(5)
      .max(24 * 60)
      .optional(),
    attendees: z.array(person).max(100).optional(),
    time_zone: z.string().max(64).optional().describe("IANA zone the working hours are in"),
    limit: z.int().min(1).max(50).optional(),
  }),
  summarize: (i) =>
    `${i.duration_minutes ? `${i.duration_minutes} min` : "free time"}${
      i.from ? ` from ${i.from.slice(0, 10)}` : ""
    }`,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    const zone = await zoneFor(ctx, input.time_zone);
    if (!zone) return refused(`"${input.time_zone}" is not a time zone monday knows.`);
    const from = input.from ? new Date(input.from) : ctx.now();
    const to = input.to ? new Date(input.to) : new Date(from.getTime() + 7 * 86_400_000);
    if (to.getTime() <= from.getTime()) return refused("The window ends before it starts.");
    if (to.getTime() - from.getTime() > 92 * 86_400_000)
      return refused("Look at most three months at a time.");
    const duration = input.duration_minutes ?? (await defaultDuration(ctx));
    const dayStartHour = await numberSetting(
      ctx,
      "calendar.day_start_hour",
      settingsSchema["calendar.day_start_hour"].default,
    );
    const dayEndHour = await numberSetting(
      ctx,
      "calendar.day_end_hour",
      settingsSchema["calendar.day_end_hour"].default,
    );
    const stepMinutes = await numberSetting(
      ctx,
      "calendar.snap_minutes",
      settingsSchema["calendar.snap_minutes"].default,
    );
    const workDays = await workDaysSetting(ctx);
    // The user's own calendars only: someone else's shared calendar is not the user's time.
    const own = (await seam.listCalendars(ctx.host.workspaceId)).filter((c) => !c.sharedBy);
    const window = { from: from.toISOString(), to: to.toISOString() };
    const instances =
      own.length === 0
        ? []
        : (
            await instancesFor(seam, ctx.host.workspaceId, window, {
              calendarIds: own.map((c) => c.id),
            })
          ).filter((i) => i.event.status !== "cancelled");
    const allDay = instances.filter((i) => i.event.allDay);
    const slots = freeSlots({
      from,
      to,
      durationMinutes: duration,
      busy: instances.filter((i) => !i.event.allDay),
      dayStartHour,
      dayEndHour,
      workDays,
      stepMinutes,
      timeZone: zone,
      limit: input.limit ?? 10,
    });
    const notes: string[] = [];
    if (allDay.length > 0) {
      notes.push(
        `All-day Events in the window, not counted as busy: ${allDay
          .map((i) => `${i.event.title} (${i.start.slice(0, 10)})`)
          .join(", ")}.`,
      );
    }
    if (input.attendees && input.attendees.length > 0) {
      notes.push(
        `Only the user's own calendar was checked; ${input.attendees
          .map(toPerson)
          .map((p) => p.name || p.email)
          .join(", ")} may be busy in these slots.`,
      );
    }
    const hours = `${String(dayStartHour).padStart(2, "0")}:00 to ${String(dayEndHour).padStart(2, "0")}:00 ${zone}`;
    return {
      kind: "result",
      text: `${
        slots.length === 0
          ? `No free ${duration} minute slot within working hours (${hours}) between ${wallClock(zone, window.from)} and ${wallClock(zone, window.to)}.`
          : `${slots.length} free slot${slots.length === 1 ? "" : "s"} of ${duration} minutes (working hours ${hours}):\n${slots
              .map(
                (s) =>
                  `- ${wallClock(zone, s.start)} to ${wallClock(zone, s.end).slice(11)} (${s.start})`,
              )
              .join("\n")}`
      }${notes.length > 0 ? `\n${notes.join("\n")}` : ""}`,
      data: {
        slots,
        timeZone: zone,
        durationMinutes: duration,
        workingHours: { start: dayStartHour, end: dayEndHour, days: workDays },
      },
    };
  },
};

/* ------------------------------ schedule_event ------------------------------ */

const scheduleEvent: ToolDefinition<{
  title: string;
  start: string;
  end?: string | undefined;
  duration_minutes?: number | undefined;
  attendees?: Array<string | { name: string; email: string }> | undefined;
  description?: string | undefined;
  location?: string | undefined;
  meeting_link?: MeetingLinkKind | undefined;
  time_zone?: string | undefined;
  all_day?: boolean | undefined;
  calendar_id?: string | undefined;
  reminders?: number[] | null | undefined;
}> = {
  name: "schedule_event",
  description:
    "Create one Event on the user's calendar, with attendees and a meeting link, and send the invitations: for one clear Event the user asked for. To lay out several Events (planning a week, blocking focus time across days) use propose_calendar_draft instead. Give start (ISO with offset) and either end or duration_minutes (default: the Meeting length Setting). The meeting link defaults to the Account's Setting (Google Meet on Google, Teams on Microsoft 365, none or Jitsi elsewhere). calendar_id picks a calendar the user can write (from list_calendars); default the primary. Invitations go out from the Provider where it mails them itself (Google, Microsoft 365, Fastmail), otherwise monday mails them. Leaves the mailbox, so it always asks first with the slot, the people and any overlapping Event of the user's own. Undo cancels the Event.",
  tier: "leaves_mailbox",
  input: z.object({
    title: z.string().min(1).max(500),
    start: isoDate,
    end: isoDate.optional(),
    duration_minutes: z
      .int()
      .min(5)
      .max(24 * 60)
      .optional(),
    attendees: z.array(person).max(500).optional(),
    description: z.string().max(20_000).optional(),
    location: z.string().max(1000).optional(),
    meeting_link: meetingLink.optional(),
    time_zone: z.string().max(64).optional().describe("IANA zone the times were given in"),
    all_day: z.boolean().optional(),
    calendar_id: z.string().min(1).optional(),
    reminders: remindersInput,
  }),
  summarize: (i) =>
    `${i.title}, ${i.start.replace("T", " ").slice(0, 16)}${
      i.attendees?.length
        ? ` with ${i.attendees
            .map(toPerson)
            .map((p) => p.name || p.email)
            .join(", ")}`
        : ""
    }`,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    const workspaceId = ctx.host.workspaceId;
    const attendees = (input.attendees ?? []).map(toPerson);
    let durationMinutes = input.duration_minutes;
    if (!durationMinutes && !input.end) durationMinutes = await defaultDuration(ctx);
    const start = new Date(input.start).toISOString();
    const end = input.end
      ? new Date(input.end).toISOString()
      : new Date(Date.parse(start) + (durationMinutes ?? 30) * 60_000).toISOString();
    if (Date.parse(end) <= Date.parse(start))
      return refused("The Event would end before it starts.");
    if (input.calendar_id) {
      const calendars = await seam.listCalendars(workspaceId);
      const target = calendars.find((c) => c.id === input.calendar_id);
      if (!target) return refused(`Calendar ${input.calendar_id} not found.`);
      const why = unwritable(target);
      if (why) return refused(`Cannot add Events there: ${why}.`);
    }
    const info = await seam.info(workspaceId);
    // The card shows the kind the Setting names; the module resolves the
    // per-Account override and mints the URL when the Event is made.
    const linkKind: MeetingLinkKind | undefined = input.meeting_link;
    const shown: MeetingLinkKind = linkKind ?? (await settingLink(ctx, info));
    const link: EventPreview["link"] =
      shown === "none"
        ? null
        : info.meetingLinks.includes(shown) || shown === "jitsi" || shown === "custom"
          ? shown
          : null;
    const conflicts = await conflictsFor(seam, workspaceId, start, end);
    const preview: ToolPreview = {
      kind: "event",
      event: {
        action: "schedule",
        title: input.title,
        start,
        end,
        allDay: input.all_day ?? false,
        timeZone: input.time_zone ?? null,
        attendees,
        link,
        invitesBy: invitesBy(info, attendees),
        conflicts,
      },
    };
    return {
      kind: "action",
      preview,
      count: 1,
      apply: async () => {
        const event = await seam.createEvent(
          workspaceId,
          {
            title: input.title,
            start,
            end,
            ...(input.all_day !== undefined ? { allDay: input.all_day } : {}),
            ...(input.time_zone ? { timeZone: input.time_zone } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.location !== undefined ? { location: input.location } : {}),
            ...(input.calendar_id ? { calendarId: input.calendar_id } : {}),
            ...(input.reminders !== undefined ? { reminders: input.reminders } : {}),
            attendees,
            ...(linkKind ? { meetingLink: linkKind } : {}),
          },
          { byAgent: true },
        );
        const who = event.attendees.filter((a) => !a.self).map((a) => a.name || a.email);
        const sent =
          who.length === 0
            ? ""
            : info.providerSendsInvites
              ? ` Invitations to ${who.join(", ")} go out from your ${info.source === "google" ? "Google" : info.source === "graph" ? "Microsoft" : "calendar"} account.`
              : ` monday mailed invitations to ${who.join(", ")}.`;
        return {
          text: `Scheduled "${event.title}" ${when(event.start, event.end, event.allDay)}${event.link ? `, ${event.link}` : ""}.${sent}${conflicts.length > 0 ? ` Overlaps ${conflicts.join(", ")}.` : ""}`,
          data: { event: compact(event), conflicts },
          undo: { kind: "event", eventId: event.id },
        };
      },
    };
  },
};

/* ------------------------------ update_event and move_event ------------------------------ */

interface UpdateArgs {
  eventId: string;
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  durationMinutes?: number | undefined;
  attendees?: Person[] | undefined;
  description?: string | undefined;
  location?: string | undefined;
  meetingLink?: MeetingLinkKind | undefined;
  reminders?: number[] | null | undefined;
  scope?: RecurrenceScope | undefined;
  occurrence?: string | undefined;
}

/** The card and the write an update or a move makes, aimed at an instance where asked. */
async function planUpdate(
  ctx: ToolContext,
  seam: CalendarSeam,
  args: UpdateArgs,
): Promise<ToolPlan> {
  const current = await seam.readEvent(args.eventId);
  if (!current) return refused(`Event ${args.eventId} not found.`);
  const calendars = await seam.listCalendars(ctx.host.workspaceId);
  const why = unwritable(calendars.find((c) => c.id === current.calendarId));
  if (why) return refused(`Cannot change "${current.title}": ${why}.`);
  const at = instanceTimes(current, args.occurrence);
  if (!at) return refused(`"${current.title}" has no instance starting ${args.occurrence}.`);
  const start = args.start ? new Date(args.start).toISOString() : at.start;
  const end = args.end
    ? new Date(args.end).toISOString()
    : args.durationMinutes
      ? new Date(Date.parse(start) + args.durationMinutes * 60_000).toISOString()
      : args.start
        ? new Date(Date.parse(start) + (Date.parse(at.end) - Date.parse(at.start))).toISOString()
        : at.end;
  if (Date.parse(end) <= Date.parse(start)) return refused("The Event would end before it starts.");
  const moved = start !== at.start || end !== at.end;
  const attendees =
    args.attendees ??
    current.attendees.filter((a) => !a.self).map((a) => ({ name: a.name, email: a.email }));
  const info = await seam.info(ctx.host.workspaceId);
  const conflicts = await conflictsFor(seam, ctx.host.workspaceId, start, end, current.id);
  const options = writeOptions(current, args.scope, args.occurrence);
  const preview: ToolPreview = {
    kind: "event",
    event: {
      action: "update",
      title: args.title ?? current.title,
      start,
      end,
      allDay: current.allDay,
      timeZone: current.timeZone,
      attendees,
      link: args.meetingLink ?? current.link,
      invitesBy: invitesBy(info, attendees),
      conflicts,
    },
  };
  return {
    kind: "action",
    preview,
    count: 1,
    apply: async () => {
      const patch: EventPatch = {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(moved ? { start, end } : {}),
        ...(args.attendees !== undefined ? { attendees } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.location !== undefined ? { location: args.location } : {}),
        ...(args.meetingLink !== undefined ? { meetingLink: args.meetingLink } : {}),
        ...(args.reminders !== undefined ? { reminders: args.reminders } : {}),
      };
      const event = options
        ? await seam.updateEvent(current.id, patch, options)
        : await seam.updateEvent(current.id, patch);
      const reach =
        options?.scope === "all"
          ? " (the whole series)"
          : options?.scope === "following"
            ? " (this and the following instances)"
            : "";
      return {
        text: `Updated "${event.title}"${reach}: ${when(start, end, event.allDay)}${event.link ? `, ${event.link}` : ""}.`,
        data: { event: compact(event), scope: options?.scope ?? null },
        undo: null,
      };
    },
  };
}

const updateEvent: ToolDefinition<{
  event_id: string;
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  attendees?: Array<string | { name: string; email: string }> | undefined;
  description?: string | undefined;
  location?: string | undefined;
  meeting_link?: MeetingLinkKind | undefined;
  reminders?: number[] | null | undefined;
  scope?: RecurrenceScope | undefined;
  occurrence?: string | undefined;
}> = {
  name: "update_event",
  description:
    "Change one Event the user organizes, on a calendar they can write: move it, rename it, change who is invited, the link, the notes, the place or the reminders. On a repeating Event, scope says whether the change reaches this instance (the default), this and the following ones, or the whole series; occurrence names the instance when list_events gave one. For several changes at once use propose_calendar_draft. Attendees get an update from the Provider or from monday, so it always asks first.",
  tier: "leaves_mailbox",
  input: z.object({
    event_id: z.string().min(1),
    title: z.string().min(1).max(500).optional(),
    start: isoDate.optional(),
    end: isoDate.optional(),
    attendees: z.array(person).max(500).optional(),
    description: z.string().max(20_000).optional(),
    location: z.string().max(1000).optional(),
    meeting_link: meetingLink.optional(),
    reminders: remindersInput,
    scope: scopeInput,
    occurrence: occurrenceInput,
  }),
  summarize: (i) => i.event_id,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    return planUpdate(ctx, seam, {
      eventId: input.event_id,
      title: input.title,
      start: input.start,
      end: input.end,
      attendees: input.attendees?.map(toPerson),
      description: input.description,
      location: input.location,
      meetingLink: input.meeting_link,
      reminders: input.reminders,
      scope: input.scope,
      occurrence: input.occurrence,
    });
  },
};

const moveEvent: ToolDefinition<{
  event_id: string;
  start: string;
  end?: string | undefined;
  duration_minutes?: number | undefined;
  scope?: RecurrenceScope | undefined;
  occurrence?: string | undefined;
}> = {
  name: "move_event",
  description:
    "Move one Event to a new start: it keeps its length unless end or duration_minutes is given. On a repeating Event, scope says whether this instance moves (the default), this and the following ones, or the whole series; occurrence names the instance when list_events gave one. For moving several Events use propose_calendar_draft. Attendees get an update, so it always asks first with the new slot.",
  tier: "leaves_mailbox",
  input: z.object({
    event_id: z.string().min(1),
    start: isoDate,
    end: isoDate.optional(),
    duration_minutes: z
      .int()
      .min(5)
      .max(24 * 60)
      .optional(),
    scope: scopeInput,
    occurrence: occurrenceInput,
  }),
  summarize: (i) => `${i.event_id} to ${i.start.replace("T", " ").slice(0, 16)}`,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    return planUpdate(ctx, seam, {
      eventId: input.event_id,
      start: input.start,
      end: input.end,
      durationMinutes: input.duration_minutes,
      scope: input.scope,
      occurrence: input.occurrence,
    });
  },
};

/* ------------------------------ rsvp ------------------------------ */

const rsvp: ToolDefinition<{
  response: "accepted" | "tentative" | "declined";
  event_id?: string | undefined;
  thread_id?: string | undefined;
}> = {
  name: "rsvp",
  description:
    "Answer an invitation: accepted, tentative or declined, on an Event by id (from list_events) or on the Invite in a Thread by thread_id. The reply reaches the organizer through the Provider or by mail, so it always asks first.",
  tier: "leaves_mailbox",
  input: z.object({
    response: rsvpValue,
    event_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
  }),
  summarize: (i) => `${i.response} ${i.event_id ?? i.thread_id ?? ""}`.trim(),
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    let event: CalendarEvent | null = null;
    let invite: Invite | null = null;
    if (input.event_id) event = await seam.readEvent(input.event_id);
    else if (input.thread_id) {
      const invites = await seam.invitesOfThread(input.thread_id);
      invite = invites.filter((i) => i.method === "REQUEST").at(-1) ?? null;
      if (!invite) return refused("That Thread carries no invitation.");
      if (invite.eventId) event = await seam.readEvent(invite.eventId);
    } else return refused("Give an event_id or a thread_id.");
    if (!event && !invite) return refused("No such Event.");
    const info = await seam.info(ctx.host.workspaceId);
    const title = event?.title ?? invite?.title ?? "";
    const start = event?.start ?? invite?.start ?? "";
    const end = event?.end ?? invite?.end ?? "";
    const organizer = event?.organizer ?? invite?.organizer ?? null;
    const preview: ToolPreview = {
      kind: "event",
      event: {
        action: "rsvp",
        title,
        start,
        end,
        allDay: event?.allDay ?? invite?.allDay ?? false,
        timeZone: event?.timeZone ?? null,
        attendees: organizer ? [organizer] : [],
        link: event?.link ?? null,
        invitesBy: info.providerSendsInvites && event ? "provider" : "monday",
        conflicts: [],
        response: input.response,
      },
    };
    return {
      kind: "action",
      preview,
      count: 1,
      apply: async () => {
        if (invite) {
          await seam.applyInviteIntent({
            kind: "invite.rsvp",
            inviteId: invite.id,
            response: input.response,
            at: ctx.now().toISOString(),
            actor: "automation",
          });
        } else if (event) {
          await seam.respond(event.id, input.response);
        }
        return {
          text: `${input.response === "accepted" ? "Accepted" : input.response === "declined" ? "Declined" : "Tentatively accepted"} "${title}"${organizer ? `; ${organizer.name || organizer.email} will hear ${info.providerSendsInvites && event ? "from your calendar" : "by mail"}` : ""}.`,
          data: {
            response: input.response,
            eventId: event?.id ?? null,
            inviteId: invite?.id ?? null,
          },
          undo: null,
        };
      },
    };
  },
};

/* ------------------------------ delete_event ------------------------------ */

const deleteEvent: ToolDefinition<{
  event_id: string;
  scope?: RecurrenceScope | undefined;
  occurrence?: string | undefined;
}> = {
  name: "delete_event",
  description:
    "Cancel and remove one Event. On a repeating Event, scope says whether this instance goes (the default), this and the following ones, or the whole series; occurrence names the instance when list_events gave one. For clearing several Events use propose_calendar_draft. Attendees get a cancellation from the Provider or from monday. Asks the user first; cannot be undone.",
  tier: "destructive",
  input: z.object({
    event_id: z.string().min(1),
    scope: scopeInput,
    occurrence: occurrenceInput,
  }),
  summarize: (i) => i.event_id,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    const current = await seam.readEvent(input.event_id);
    if (!current) return refused(`Event ${input.event_id} not found.`);
    const at = instanceTimes(current, input.occurrence);
    if (!at) return refused(`"${current.title}" has no instance starting ${input.occurrence}.`);
    const options = writeOptions(current, input.scope, input.occurrence);
    const info = await seam.info(ctx.host.workspaceId);
    const attendees = current.attendees
      .filter((a) => !a.self)
      .map((a) => ({ name: a.name, email: a.email }));
    const preview: ToolPreview = {
      kind: "event",
      event: {
        action: "cancel",
        title: current.title,
        start: at.start,
        end: at.end,
        allDay: current.allDay,
        timeZone: current.timeZone,
        attendees,
        link: current.link,
        invitesBy: invitesBy(info, attendees),
        conflicts: [],
      },
    };
    return {
      kind: "action",
      preview,
      count: 1,
      apply: async () => {
        if (options) await seam.deleteEvent(current.id, options);
        else await seam.deleteEvent(current.id);
        const reach =
          options?.scope === "all"
            ? " and the rest of its series"
            : options?.scope === "following"
              ? " and the instances after it"
              : "";
        return {
          text: `Cancelled "${current.title}" (${when(at.start, at.end, current.allDay)})${reach}.`,
          data: { eventId: current.id, scope: options?.scope ?? null },
          undo: null,
        };
      },
    };
  },
};

/* ------------------------------ propose_calendar_draft ------------------------------ */

const draftFields = {
  title: z.string().min(1).max(500).optional(),
  start: isoDate.optional(),
  end: isoDate.optional(),
  duration_minutes: z
    .int()
    .min(5)
    .max(24 * 60)
    .optional(),
  all_day: z.boolean().optional(),
  time_zone: z.string().max(64).optional(),
  calendar_id: z.string().min(1).optional(),
  description: z.string().max(20_000).optional(),
  location: z.string().max(1000).optional(),
  attendees: z.array(person).max(500).optional(),
  recurrence: z.string().max(1000).optional().describe("An RRULE, such as FREQ=WEEKLY;BYDAY=MO"),
  meeting_link: meetingLink.optional(),
  reason: z.string().max(500).optional().describe("Why, in a line the user reads"),
};

const draftChange = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    ...draftFields,
    title: z.string().min(1).max(500),
    start: isoDate,
  }),
  z.object({
    kind: z.literal("update"),
    event_id: z.string().min(1),
    occurrence: occurrenceInput,
    scope: scopeInput,
    ...draftFields,
  }),
  z.object({
    kind: z.literal("delete"),
    event_id: z.string().min(1),
    occurrence: occurrenceInput,
    scope: scopeInput,
    reason: draftFields.reason,
  }),
]);

const draftInput = z.object({
  title: z.string().min(1).max(200).describe("A name for the draft, such as Week of 21 September"),
  summary: z.string().max(2000).describe("What the draft does and why, for the user"),
  changes: z.array(draftChange).min(1).max(100),
});

type DraftInput = z.infer<typeof draftInput>;

function fieldsOf(
  e: CalendarEvent,
  at: { start: IsoDate; end: IsoDate },
  self: string,
): DraftEventFields {
  return {
    title: e.title,
    start: at.start,
    end: at.end,
    allDay: e.allDay,
    timeZone: e.timeZone,
    calendarId: e.calendarId,
    description: e.description,
    location: e.location,
    attendees: othersOf(e.attendees, self),
    recurrence: e.recurrence,
  };
}

/** The draft a set of proposed changes makes, or why it cannot be one. */
async function buildDraft(
  input: DraftInput,
  ctx: ToolContext,
  seam: CalendarSeam,
): Promise<{ draft: CalendarDraft } | { refused: string }> {
  const workspaceId = ctx.host.workspaceId;
  const self = await seam.selfAddress(workspaceId);
  const calendars = await seam.listCalendars(workspaceId);
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const writable = calendars.filter((c) => !unwritable(c));
  const fallback = writable.find((c) => c.primary) ?? writable[0];
  const needDuration = input.changes.some(
    (c) => c.kind === "create" && !c.end && !c.duration_minutes,
  );
  const duration = needDuration ? await defaultDuration(ctx) : 0;
  const changes: CalendarDraftChange[] = [];
  const fail = (n: number, why: string) => ({ refused: `Change ${n}: ${why}` });

  for (const [index, c] of input.changes.entries()) {
    const n = index + 1;
    const id = `c${n}`;
    const reason = c.reason ? { reason: c.reason } : {};
    if (c.kind === "create") {
      const calendar = c.calendar_id ? byId.get(c.calendar_id) : fallback;
      if (c.calendar_id && !calendar) return fail(n, `calendar ${c.calendar_id} not found.`);
      if (!calendar) return fail(n, "the Account has no calendar the user can write.");
      const why = unwritable(calendar);
      if (why) return fail(n, `${why}.`);
      if (c.time_zone && !isIanaZone(c.time_zone))
        return fail(n, `"${c.time_zone}" is not a time zone monday knows.`);
      const start = new Date(c.start).toISOString();
      const end = c.end
        ? new Date(c.end).toISOString()
        : new Date(Date.parse(start) + (c.duration_minutes ?? duration) * 60_000).toISOString();
      if (Date.parse(end) <= Date.parse(start))
        return fail(n, `"${c.title}" would end before it starts.`);
      const attendees = othersOf((c.attendees ?? []).map(toPerson), self);
      changes.push({
        id,
        kind: "create",
        before: null,
        after: {
          title: c.title,
          start,
          end,
          allDay: c.all_day ?? false,
          timeZone: c.time_zone ?? null,
          calendarId: calendar.id,
          ...(c.description !== undefined ? { description: c.description } : {}),
          ...(c.location !== undefined ? { location: c.location } : {}),
          attendees,
          recurrence: c.recurrence ?? null,
          ...(c.meeting_link ? { meetingLink: c.meeting_link } : {}),
        },
        guests: attendees,
        ...reason,
      });
      continue;
    }
    const event = await seam.readEvent(c.event_id);
    if (!event) return fail(n, `Event ${c.event_id} not found.`);
    const why = unwritable(byId.get(event.calendarId));
    if (why) return fail(n, `cannot change "${event.title}": ${why}.`);
    const at = instanceTimes(event, c.occurrence);
    if (!at) return fail(n, `"${event.title}" has no instance starting ${c.occurrence}.`);
    const before = fieldsOf(event, at, self);
    const options = writeOptions(event, c.scope, c.occurrence);
    const aim = {
      eventId: event.id,
      ...(options?.scope ? { scope: options.scope } : {}),
      ...(options?.occurrence ? { occurrence: options.occurrence } : {}),
    };
    if (c.kind === "delete") {
      changes.push({
        id,
        kind: "delete",
        ...aim,
        before,
        after: null,
        guests: before.attendees ?? [],
        ...reason,
      });
      continue;
    }
    if (c.calendar_id && c.calendar_id !== event.calendarId) {
      return fail(
        n,
        "an Event cannot move to another calendar in a draft; remove it and add it there.",
      );
    }
    if (c.time_zone && !isIanaZone(c.time_zone))
      return fail(n, `"${c.time_zone}" is not a time zone monday knows.`);
    const start = c.start ? new Date(c.start).toISOString() : before.start;
    const end = c.end
      ? new Date(c.end).toISOString()
      : c.duration_minutes
        ? new Date(Date.parse(start) + c.duration_minutes * 60_000).toISOString()
        : c.start
          ? new Date(
              Date.parse(start) + (Date.parse(before.end) - Date.parse(before.start)),
            ).toISOString()
          : before.end;
    if (Date.parse(end) <= Date.parse(start))
      return fail(n, `"${c.title ?? event.title}" would end before it starts.`);
    const attendees = c.attendees
      ? othersOf(c.attendees.map(toPerson), self)
      : (before.attendees ?? []);
    changes.push({
      id,
      kind: "update",
      ...aim,
      before,
      after: {
        ...before,
        title: c.title ?? before.title,
        start,
        end,
        allDay: c.all_day ?? before.allDay,
        ...(c.time_zone ? { timeZone: c.time_zone } : {}),
        ...(c.description !== undefined ? { description: c.description } : {}),
        ...(c.location !== undefined ? { location: c.location } : {}),
        attendees,
        ...(c.recurrence !== undefined ? { recurrence: c.recurrence } : {}),
        ...(c.meeting_link ? { meetingLink: c.meeting_link } : {}),
      },
      // Everyone on the Event hears of a change: the ones staying, and the ones added or removed.
      guests: othersOf([...attendees, ...(before.attendees ?? [])], self),
      ...reason,
    });
  }

  const times = changes.flatMap((c) =>
    [c.before, c.after].flatMap((f) => (f ? [Date.parse(f.start), Date.parse(f.end)] : [])),
  );
  return {
    draft: {
      id: crypto.randomUUID(),
      workspaceId,
      title: input.title,
      summary: input.summary,
      from: new Date(Math.min(...times)).toISOString(),
      to: new Date(Math.max(...times)).toISOString(),
      changes,
      createdAt: ctx.now().toISOString(),
    },
  };
}

function draftText(draft: CalendarDraft): string {
  const count = (kind: CalendarDraftChange["kind"]) =>
    draft.changes.filter((c) => c.kind === kind).length;
  const lines = draft.changes.map((c) => {
    const f = c.after ?? c.before;
    const verb = c.kind === "create" ? "add" : c.kind === "update" ? "change" : "remove";
    const moved =
      c.kind === "update" && c.before && c.after && c.before.start !== c.after.start
        ? `, moved from ${when(c.before.start, c.before.end, c.before.allDay)}`
        : "";
    const guests =
      c.guests.length > 0 ? `; emails ${c.guests.map((g) => g.name || g.email).join(", ")}` : "";
    return `- ${c.id} ${verb} "${f?.title ?? ""}" ${f ? when(f.start, f.end, f.allDay) : ""}${moved}${guests}`;
  });
  return `Draft ${draft.id}: ${count("create")} to add, ${count("update")} to change, ${count("delete")} to remove; the user reviews it on the Calendar and applies it.\n${lines.join("\n")}`;
}

const proposeCalendarDraft: ToolDefinition<DraftInput> = {
  name: "propose_calendar_draft",
  description:
    "Propose a set of calendar changes as one draft the user reviews on the Calendar and applies, all of it or some: the way to plan a week, block focus time across days, reschedule an afternoon or clear a day. Writes nothing and emails no one; when the user applies it, the app asks before any guest is emailed. Each change is a create (title, start, end or duration_minutes, and optionally all_day, time_zone, calendar_id, description, location, attendees, recurrence, meeting_link), an update of an Event by event_id (with occurrence and scope on a repeating one, and the fields that change), or a delete by event_id; each may carry a reason. Read the calendar first (list_events, find_free_time) so the draft fits. To revise a draft, read it with get_calendar_draft and propose a new one. For one clear change the user asked for, use schedule_event, move_event, update_event or delete_event instead.",
  tier: "read",
  input: draftInput,
  summarize: (i) => `${i.title}: ${i.changes.length} change${i.changes.length === 1 ? "" : "s"}`,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    const built = await buildDraft(input, ctx, seam);
    if ("refused" in built) return refused(`${built.refused} Nothing was proposed.`);
    const { draft } = built;
    return {
      kind: "result",
      text: draftText(draft),
      data: { draft },
      preview: { kind: "calendar-draft", draft },
    };
  },
};

/* ------------------------------ get_calendar_draft ------------------------------ */

function draftOf(data: unknown): CalendarDraft | null {
  if (typeof data !== "object" || data === null || !("draft" in data)) return null;
  const draft = (data as { draft?: unknown }).draft;
  if (typeof draft !== "object" || draft === null || !("id" in draft) || !("changes" in draft))
    return null;
  return draft as CalendarDraft;
}

const getCalendarDraft: ToolDefinition<{ draft_id?: string | undefined }> = {
  name: "get_calendar_draft",
  description:
    "Read back a calendar draft proposed earlier in this conversation, by draft_id, or the latest one when no id is given: its changes with before and after, the guests each would email, and the window. Use it to revise a draft the user wants changed, then propose the revised draft with propose_calendar_draft.",
  tier: "read",
  input: z.object({ draft_id: z.string().min(1).optional() }),
  summarize: (i) => i.draft_id ?? "latest draft",
  async run(input, ctx) {
    if (!ctx.extensions?.calendar) return refused(NO_CALENDAR);
    if (!ctx.sessionResults) return refused("Drafts cannot be read back from this host.");
    const drafts = (await ctx.sessionResults("propose_calendar_draft"))
      .map(draftOf)
      .filter((d): d is CalendarDraft => d !== null);
    const draft = input.draft_id ? drafts.find((d) => d.id === input.draft_id) : drafts[0];
    if (!draft) {
      return refused(
        input.draft_id
          ? `No calendar draft ${input.draft_id} in this conversation.`
          : "No calendar draft in this conversation yet.",
      );
    }
    return {
      kind: "result",
      text: `${draft.title}. ${draft.summary}\n${draftText(draft)}`,
      data: { draft },
    };
  },
};

export const CALENDAR_TOOLS: readonly ToolDefinition<never>[] = [
  listCalendars,
  listEvents,
  searchEvents,
  findFreeTime,
  scheduleEvent,
  rsvp,
  updateEvent,
  moveEvent,
  deleteEvent,
  proposeCalendarDraft,
  getCalendarDraft,
] as unknown as readonly ToolDefinition<never>[];
