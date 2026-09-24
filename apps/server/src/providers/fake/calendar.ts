// The fake calendar (slice 18): the CalendarSession the fake Provider hands
// out when a test asks for one, playing Google or Graph. An in-memory
// calendar with a change log for sync tokens, a Meet or Teams link minted on
// create, and a ledger of the invitations the "Provider" mailed, so a test
// can assert that Google sent the invite and monday did not.

import type { CalendarInfo, IsoDate, MeetingLinkKind, RsvpResponse } from "@monday/shared";
import { parseRRule } from "@monday/shared";
import { parseICalendar } from "../../calendar/ical.ts";
import {
  type CalendarSession,
  type CalendarSyncEvent,
  type CreateEventInput,
  type EventWindow,
  type ProviderCalendar,
  ProviderError,
  type ProviderEvent,
} from "../types.ts";

export interface FakeCalendarOptions {
  /** Which Provider the fake plays; sets the link kinds and whether invites are mailed by it. */
  source?: "google" | "graph" | "caldav";
  /** False for a CalDAV server without calendar-auto-schedule. */
  providerSendsInvites?: boolean;
  now?: () => Date;
}

/** One invitation, update or reply the fake "Provider" mailed on the user's behalf. */
export interface MailedNotice {
  kind: "invite" | "update" | "cancel" | "reply";
  eventId: string;
  to: string[];
  /** The reply the attendee gave, on a "reply". */
  response?: RsvpResponse;
}

interface LogEntry {
  seq: number;
  id: string;
  removed: boolean;
}

export interface FakeCalendar extends CalendarSession {
  /** Another client (the organizer's own calendar app) put an Event on the calendar. */
  place(
    event: Omit<ProviderEvent, "calendarId" | "etag" | "updatedAt"> & { calendarId?: string },
  ): ProviderEvent;
  remove(id: string): void;
  /** Drops the change log so any stored token becomes uncontinuable. */
  forgetHistory(): void;
  snapshot(): ProviderEvent[];
  /** What the Provider mailed, in order. */
  mailed: MailedNotice[];
  calls: Record<string, number>;
  /** The calendars the Provider lists; a test may add, change or remove one. */
  calendars: ProviderCalendar[];
  /** Calendar ids whose sync the Provider refuses, with the words it refuses with. */
  failing: Map<string, string>;
}

const LINKS: Record<"google" | "graph" | "caldav", MeetingLinkKind[]> = {
  google: ["google-meet"],
  graph: ["teams"],
  caldav: [],
};

export function createFakeCalendar(
  address: string,
  options: FakeCalendarOptions = {},
): FakeCalendar {
  const source = options.source ?? "google";
  const now = options.now ?? (() => new Date());
  const providerSendsInvites = options.providerSendsInvites ?? source !== "caldav";
  const expands = source !== "caldav";
  const events = new Map<string, ProviderEvent>();
  let log: LogEntry[] = [];
  let seq = 0;
  let counter = 0;
  const mailed: MailedNotice[] = [];
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const record = (id: string, removed: boolean) => {
    seq += 1;
    log.push({ seq, id, removed });
  };
  const calendars: ProviderCalendar[] = [
    {
      id: "primary",
      name: address,
      primary: true,
      writable: true,
      color: null,
      access: "owner",
      sharedBy: null,
    },
    {
      id: "team",
      name: "Team (shared)",
      primary: false,
      writable: false,
      color: "#4a7",
      access: "reader",
      sharedBy: { name: "Team", email: "team@northwind.test" },
    },
  ];
  const failing = new Map<string, string>();
  const require = (id: string) => {
    const e = events.get(id);
    if (!e) throw new ProviderError(`event ${id} not found`, "not-found");
    return e;
  };
  const mint = (kind: MeetingLinkKind, id: string): string | null => {
    if (kind === "google-meet") return `https://meet.google.com/fake-${id}`;
    if (kind === "teams") return `https://teams.microsoft.com/l/meetup-join/fake-${id}`;
    return null;
  };
  const others = (e: ProviderEvent) =>
    e.attendees.map((a) => a.email).filter((email) => email !== address.toLowerCase());

  /**
   * What Google does to a series' instances when its master changes: a moved
   * master moves them by the same amount, an UNTIL drops those after it.
   */
  const followSeries = (before: ProviderEvent, after: ProviderEvent) => {
    const shift = Date.parse(after.start) - Date.parse(before.start);
    const length = Date.parse(after.end) - Date.parse(after.start);
    const until = after.recurrence ? parseRRule(after.recurrence)?.until : null;
    for (const i of [...events.values()]) {
      if (i.recurringEventId !== before.id) continue;
      const start = Date.parse(i.start) + shift;
      if (until && start > until.getTime()) {
        events.delete(i.id);
        record(i.id, true);
        continue;
      }
      events.set(i.id, {
        ...i,
        title: after.title,
        start: new Date(start).toISOString(),
        end: new Date(start + length).toISOString(),
        updatedAt: now().toISOString(),
      });
      record(i.id, false);
    }
  };

  const session: FakeCalendar = {
    mailed,
    calls,
    calendars,
    failing,
    info(): CalendarInfo {
      count("info");
      return {
        source,
        providerSendsInvites,
        meetingLinks: LINKS[source],
        defaultMeetingLink: LINKS[source][0] ?? "none",
        push: source !== "caldav",
      };
    },
    async listCalendars() {
      count("listCalendars");
      return calendars.map((c) => ({ ...c }));
    },
    async *syncEvents(
      calendarId: string,
      state: string | null,
      window: EventWindow,
    ): AsyncIterable<CalendarSyncEvent> {
      count("syncEvents");
      const refusal = failing.get(calendarId);
      if (refusal) throw new ProviderError(refusal, "unsupported");
      // Google and Graph expand series: the master itself never comes through a sync.
      const hidden = (e: ProviderEvent) => expands && e.recurrence !== null && !e.recurringEventId;
      const inCalendar = () =>
        [...events.values()].filter(
          (e) =>
            e.calendarId === calendarId &&
            !hidden(e) &&
            e.end >= window.from &&
            e.start < window.to,
        );
      const since = state ? Number(JSON.parse(state).seq) : null;
      const oldest = log[0]?.seq ?? seq + 1;
      if (since === null || since < oldest - 1) {
        if (since !== null) yield { type: "reset" };
        for (const e of inCalendar()) yield { type: "upserted", event: { ...e } };
        yield { type: "state", state: JSON.stringify({ seq }), complete: true };
        return;
      }
      const touched = new Set<string>();
      for (const entry of log) if (entry.seq > since) touched.add(entry.id);
      for (const id of touched) {
        const e = events.get(id);
        if (!e || e.calendarId !== calendarId) yield { type: "removed", id };
        else if (!hidden(e)) yield { type: "upserted", event: { ...e } };
      }
      yield { type: "state", state: JSON.stringify({ seq }), complete: true };
    },
    async createEvent(calendarId: string, input: CreateEventInput) {
      count("createEvent");
      const calendar = calendars.find((c) => c.id === calendarId);
      if (!calendar) throw new ProviderError(`calendar ${calendarId} not found`, "not-found");
      if (!calendar.writable) throw new ProviderError("calendar is read-only", "unsupported");
      counter += 1;
      const id = `ev${String(counter).padStart(2, "0")}`;
      const link =
        input.meetingLink === "custom"
          ? (input.customLink ?? null)
          : LINKS[source].includes(input.meetingLink)
            ? mint(input.meetingLink, id)
            : null;
      const event: ProviderEvent = {
        id,
        calendarId,
        uid: `${id}@fake.monday`,
        title: input.title,
        description: input.description ?? "",
        location: input.location ?? "",
        start: input.start,
        end: input.end,
        allDay: input.allDay ?? false,
        timeZone: input.timeZone ?? null,
        organizer: input.organizer,
        attendees: [
          { ...input.organizer, response: "accepted", self: true, organizer: true },
          ...(input.attendees ?? []).map((p) => ({ ...p, response: "needs-action" as const })),
        ],
        link,
        status: "confirmed",
        recurrence: input.recurrence ?? null,
        recurringEventId: null,
        response: "accepted",
        reminders: input.reminders ?? null,
        etag: `"${seq + 1}"`,
        updatedAt: now().toISOString(),
      };
      events.set(id, event);
      record(id, false);
      if (providerSendsInvites && others(event).length > 0) {
        mailed.push({ kind: "invite", eventId: id, to: others(event) });
      }
      return { ...event };
    },
    async updateEvent(calendarId, eventId, input, etag) {
      count("updateEvent");
      const e = require(eventId);
      if (etag && e.etag && etag !== e.etag) {
        throw new ProviderError("event changed on the server", "protocol");
      }
      const next: ProviderEvent = {
        ...e,
        calendarId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.start !== undefined ? { start: input.start } : {}),
        ...(input.end !== undefined ? { end: input.end } : {}),
        ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
        ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
        ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
        ...(input.reminders !== undefined ? { reminders: input.reminders } : {}),
        ...(input.attendees !== undefined
          ? {
              attendees: [
                ...e.attendees.filter((a) => a.self),
                ...input.attendees.map((p) => ({
                  ...p,
                  response:
                    e.attendees.find((a) => a.email === p.email)?.response ?? "needs-action",
                })),
              ],
            }
          : {}),
        etag: `"${seq + 1}"`,
        updatedAt: now().toISOString(),
      };
      events.set(eventId, next);
      record(eventId, false);
      if (expands && next.recurrence !== null && !next.recurringEventId) followSeries(e, next);
      if (providerSendsInvites && others(next).length > 0) {
        mailed.push({ kind: "update", eventId, to: others(next) });
      }
      return { ...next };
    },
    async readEvent(_calendarId, eventId) {
      count("readEvent");
      return { ...require(eventId) };
    },
    async deleteEvent(_calendarId, eventId) {
      count("deleteEvent");
      const e = events.get(eventId);
      if (!e) return;
      events.delete(eventId);
      record(eventId, true);
      if (expands) {
        for (const i of [...events.values()]) {
          if (i.recurringEventId !== eventId) continue;
          events.delete(i.id);
          record(i.id, true);
        }
      }
      if (providerSendsInvites && others(e).length > 0) {
        mailed.push({ kind: "cancel", eventId, to: others(e) });
      }
    },
    async rsvp(_calendarId, eventId, response) {
      count("rsvp");
      const e = require(eventId);
      const next: ProviderEvent = {
        ...e,
        response,
        attendees: e.attendees.map((a) => (a.self ? { ...a, response } : a)),
        etag: `"${seq + 1}"`,
        updatedAt: now().toISOString(),
      };
      events.set(eventId, next);
      record(eventId, false);
      if (providerSendsInvites && e.organizer) {
        mailed.push({ kind: "reply", eventId, to: [e.organizer.email], response });
      }
      return { ...next };
    },
    ...(source === "caldav"
      ? {
          async importInvite(calendarId: string, ical: string): Promise<ProviderEvent> {
            count("importInvite");
            const [parsed] = parseICalendar(ical).events;
            if (!parsed) throw new ProviderError("no VEVENT in the invitation", "protocol");
            const existing = [...events.values()].find((e) => e.uid === parsed.uid);
            const self = parsed.attendees.find((a) => a.email === address.toLowerCase());
            return session.place({
              id: existing?.id ?? "",
              calendarId,
              uid: parsed.uid,
              title: parsed.title,
              description: parsed.description,
              location: parsed.location,
              start: parsed.start.toISOString(),
              end: parsed.end.toISOString(),
              allDay: parsed.allDay,
              timeZone: parsed.zone,
              organizer: parsed.organizer,
              attendees: parsed.attendees.map((a) =>
                a.email === address.toLowerCase() ? { ...a, self: true } : a,
              ),
              link: parsed.link,
              status: parsed.status,
              recurrence: parsed.recurrence,
              recurringEventId: null,
              response: self?.response ?? null,
            });
          },
        }
      : {}),
    async subscribe(calendarId, _address, _token) {
      count("subscribe");
      const expiresAt: IsoDate = new Date(now().getTime() + 7 * 86_400_000).toISOString();
      return { id: `chan-${calendarId}`, expiresAt };
    },
    async unsubscribe() {
      count("unsubscribe");
    },
    async close() {
      count("close");
    },
    place(event) {
      counter += 1;
      const id = event.id || `ev${String(counter).padStart(2, "0")}`;
      const placed: ProviderEvent = {
        ...event,
        id,
        calendarId: event.calendarId ?? "primary",
        etag: `"${seq + 1}"`,
        updatedAt: now().toISOString(),
      };
      events.set(id, placed);
      record(id, false);
      return { ...placed };
    },
    remove(id) {
      if (!events.delete(id)) return;
      record(id, true);
    },
    forgetHistory() {
      log = [];
      seq += 1;
      log.push({ seq, id: "", removed: false });
    },
    snapshot() {
      return [...events.values()].map((e) => ({ ...e }));
    },
  };
  return session;
}
