// The seam between the Calendar screen, the Today panel, the invite bar and
// the data under them: calendars, Events and Invites as the Cache
// holds them (the feed keeps them current, the Store warms titles), handed
// out as one stable external store, plus the writes: visibility through the
// API, an Event made by hand through the API, an Invite's answer through the
// Store's Outbox so it is undoable and works offline. The Server expands
// nothing: recurring masters are expanded here with the shared expander.
// fixtureCalendar() is the in-memory implementation for tests and the mock.

import type { Calendar, CalendarEvent, EventInput, Id, Invite, RsvpResponse } from "@monday/shared";
import { expandRecurrence } from "@monday/shared";
import type { Api } from "../../platform/api.ts";
import type { Row, Store } from "../../store/index.ts";

/** One thing on a view: an Event, or one instance of a recurring one. */
export interface Occurrence extends CalendarEvent {
  /** The instance's own key: the Event id, or id plus the instance start for a recurrence. */
  key: string;
}

export interface CalendarSource {
  calendars(): readonly Calendar[];
  /** Every Event the Cache holds, masters included, newest window first. Stable between changes. */
  events(): readonly CalendarEvent[];
  /** The Invites of a Thread, oldest first. */
  invitesOf(threadId: Id): readonly Invite[];
  subscribe(listener: () => void): () => void;
  setVisible(calendarId: Id, visible: boolean): Promise<void>;
  create(input: EventInput): Promise<CalendarEvent>;
  remove(eventId: Id): Promise<void>;
  /** The Workspace's answer on an Event straight from a view (an Agenda row's Accept). */
  respond(eventId: Id, response: "accepted" | "tentative" | "declined"): Promise<void>;
  /** The invite bar's answer: an Outbox intent. */
  rsvp(inviteId: Id, response: RsvpResponse): Promise<void>;
}

export interface StoreCalendar extends CalendarSource {
  close(): void;
}

const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
const bool = (v: unknown) => v === 1 || v === true;
const text = (v: unknown) => (typeof v === "string" ? v : "");
const nullable = (v: unknown) => (typeof v === "string" ? v : null);

export const CALENDARS_SQL = 'select * from calendars order by "primary" desc, name';
export const EVENTS_SQL = 'select * from events order by start, "end", id';
export const INVITES_SQL = "select * from invites order by received_at, id";

export function rowToCalendar(r: Row, workspaceId: string): Calendar {
  return {
    id: text(r.id),
    workspaceId,
    source: text(r.source) as Calendar["source"],
    providerId: text(r.provider_id),
    name: text(r.name),
    primary: bool(r.primary),
    writable: bool(r.writable),
    visible: bool(r.visible),
    color: nullable(r.color),
  };
}

export function rowToEvent(r: Row, workspaceId: string): CalendarEvent {
  return {
    id: text(r.id),
    workspaceId,
    calendarId: text(r.calendar_id),
    providerId: text(r.provider_id),
    uid: nullable(r.uid),
    title: text(r.title),
    description: text(r.description),
    location: text(r.location),
    start: text(r.start),
    end: text(r.end),
    allDay: bool(r.all_day),
    timeZone: nullable(r.time_zone),
    organizer: json(r.organizer, null),
    attendees: json(r.attendees, []),
    link: nullable(r.link),
    status: (text(r.status) || "confirmed") as CalendarEvent["status"],
    recurrence: nullable(r.recurrence),
    recurringEventId: nullable(r.recurring_event_id),
    response: nullable(r.response) as CalendarEvent["response"],
    createdByAgent: bool(r.created_by_agent),
    etag: null,
    updatedAt: text(r.updated_at),
  };
}

export function rowToInvite(r: Row, workspaceId: string): Invite {
  return {
    id: text(r.id),
    workspaceId,
    messageId: text(r.message_id),
    threadId: text(r.thread_id),
    eventId: nullable(r.event_id),
    method: (text(r.method) || "REQUEST") as Invite["method"],
    uid: text(r.uid),
    sequence: Number(r.sequence ?? 0),
    title: text(r.title),
    start: text(r.start),
    end: text(r.end),
    allDay: bool(r.all_day),
    organizer: json(r.organizer, null),
    attendees: json(r.attendees, []),
    response: (text(r.response) || "needs-action") as RsvpResponse,
    byMail: bool(r.by_mail),
    senderMismatch: bool(r.sender_mismatch),
    receivedAt: text(r.received_at),
  };
}

/**
 * The instances inside a window from every Event the source holds: single
 * Events as they are, recurring masters expanded (Google and Graph hand
 * instances over already; CalDAV and the Local calendar hand masters).
 * Hidden calendars and declined Events (unless asked for) are left out.
 */
export function occurrencesIn(
  events: readonly CalendarEvent[],
  calendars: readonly Calendar[],
  window: { from: Date; to: Date },
  options: { showDeclined?: boolean } = {},
): Occurrence[] {
  const hidden = new Set(calendars.filter((c) => !c.visible).map((c) => c.id));
  const out: Occurrence[] = [];
  for (const e of events) {
    if (hidden.has(e.calendarId)) continue;
    if (e.status === "cancelled") continue;
    if (e.response === "declined" && !options.showDeclined) continue;
    if (e.recurrence && !e.recurringEventId) {
      for (const o of expandRecurrence(
        e.recurrence,
        new Date(e.start),
        new Date(e.end),
        e.timeZone,
        window,
      )) {
        out.push({
          ...e,
          key: `${e.id}@${o.start.toISOString()}`,
          start: o.start.toISOString(),
          end: o.end.toISOString(),
        });
      }
      continue;
    }
    const s = Date.parse(e.start);
    const en = Date.parse(e.end);
    if (en <= window.from.getTime() || s >= window.to.getTime()) continue;
    out.push({ ...e, key: e.id });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

const NO_INVITES: readonly Invite[] = [];

/** Invites grouped by Thread, so `invitesOf` hands back one stable array per Thread. */
function byThread(invites: readonly Invite[]): Map<string, Invite[]> {
  const out = new Map<string, Invite[]>();
  for (const i of invites) {
    const list = out.get(i.threadId);
    if (list) list.push(i);
    else out.set(i.threadId, [i]);
  }
  return out;
}

/** Opens the seam over the Store's live queries; resolves once the three have rows. */
export async function createStoreCalendar(store: Store, api: Api): Promise<StoreCalendar> {
  const listeners = new Set<() => void>();
  let calendars: readonly Calendar[] = [];
  let events: readonly CalendarEvent[] = [];
  let invites: Map<string, Invite[]> = new Map();
  const emit = () => {
    for (const l of [...listeners]) l();
  };
  const calendarsLive = store.live<Row>(CALENDARS_SQL);
  const eventsLive = store.live<Row>(EVENTS_SQL);
  const invitesLive = store.live<Row>(INVITES_SQL);
  const ready = (
    live: { subscribe(l: (rows: Row[]) => void): () => void },
    apply: (rows: Row[]) => void,
  ) =>
    new Promise<void>((resolve) => {
      live.subscribe((rows) => {
        apply(rows);
        emit();
        resolve();
      });
    });
  await Promise.all([
    ready(calendarsLive, (rows) => {
      calendars = rows.map((r) => rowToCalendar(r, store.workspaceId));
    }),
    ready(eventsLive, (rows) => {
      events = rows.map((r) => rowToEvent(r, store.workspaceId));
    }),
    ready(invitesLive, (rows) => {
      invites = byThread(rows.map((r) => rowToInvite(r, store.workspaceId)));
    }),
  ]);
  return {
    calendars: () => calendars,
    events: () => events,
    invitesOf: (threadId) => invites.get(threadId) ?? NO_INVITES,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setVisible(calendarId, visible) {
      await api.calendar.setVisible(calendarId, visible);
      // The feed row follows; the Cache shows the choice at once.
      await store.write([
        { sql: "update calendars set visible = ? where id = ?", params: [visible, calendarId] },
      ]);
    },
    async create(input) {
      const event = await api.calendar.create(store.workspaceId, input);
      await store.write([
        {
          sql: `insert into events (id, calendar_id, provider_id, uid, title, description, location, start, "end", all_day,
                  time_zone, organizer, attendees, link, status, recurrence, recurring_event_id, response, created_by_agent, content_stale, updated_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                on conflict (id) do update set title = excluded.title, description = excluded.description,
                  location = excluded.location, content_stale = 0`,
          params: [
            event.id,
            event.calendarId,
            event.providerId,
            event.uid,
            event.title,
            event.description,
            event.location,
            event.start,
            event.end,
            event.allDay,
            event.timeZone,
            event.organizer,
            event.attendees,
            event.link,
            event.status,
            event.recurrence,
            event.recurringEventId,
            event.response,
            event.createdByAgent,
            event.updatedAt,
          ],
        },
      ]);
      return event;
    },
    async remove(eventId) {
      await api.calendar.remove(eventId);
      await store.write([{ sql: "delete from events where id = ?", params: [eventId] }]);
    },
    async respond(eventId, response) {
      await api.calendar.respond(eventId, response);
      await store.write([
        { sql: "update events set response = ? where id = ?", params: [response, eventId] },
      ]);
    },
    async rsvp(inviteId, response) {
      await store.intent({ kind: "invite.rsvp", inviteId, response });
    },
    close() {
      calendarsLive.close();
      eventsLive.close();
      invitesLive.close();
      listeners.clear();
    },
  };
}

/** An in-memory source over given rows, for tests and the browser mock. */
export function fixtureCalendar(seed: {
  calendars?: Calendar[];
  events?: CalendarEvent[];
  invites?: Invite[];
}): CalendarSource & { log: string[] } {
  const listeners = new Set<() => void>();
  let calendars = seed.calendars ?? [];
  let events = seed.events ?? [];
  let invites = seed.invites ?? [];
  let grouped = byThread(invites);
  const log: string[] = [];
  const emit = () => {
    grouped = byThread(invites);
    for (const l of [...listeners]) l();
  };
  return {
    log,
    calendars: () => calendars,
    events: () => events,
    invitesOf: (threadId) => grouped.get(threadId) ?? NO_INVITES,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setVisible(calendarId, visible) {
      log.push(`visible ${calendarId} ${visible}`);
      calendars = calendars.map((c) => (c.id === calendarId ? { ...c, visible } : c));
      emit();
    },
    async create(input) {
      const event: CalendarEvent = {
        id: `ev-${events.length + 1}`,
        workspaceId: calendars[0]?.workspaceId ?? "ws",
        calendarId: input.calendarId ?? calendars[0]?.id ?? "cal",
        providerId: `p-${events.length + 1}`,
        uid: null,
        title: input.title,
        description: input.description ?? "",
        location: input.location ?? "",
        start: input.start,
        end: input.end,
        allDay: input.allDay ?? false,
        timeZone: input.timeZone ?? null,
        organizer: null,
        attendees: (input.attendees ?? []).map((p) => ({ ...p, response: "needs-action" })),
        link: null,
        status: "confirmed",
        recurrence: input.recurrence ?? null,
        recurringEventId: null,
        response: "accepted",
        createdByAgent: false,
        etag: null,
        updatedAt: new Date().toISOString(),
      };
      log.push(`create ${event.title}`);
      events = [...events, event];
      emit();
      return event;
    },
    async remove(eventId) {
      log.push(`remove ${eventId}`);
      events = events.filter((e) => e.id !== eventId);
      emit();
    },
    async respond(eventId, response) {
      log.push(`respond ${eventId} ${response}`);
      events = events.map((e) => (e.id === eventId ? { ...e, response } : e));
      emit();
    },
    async rsvp(inviteId, response) {
      log.push(`rsvp ${inviteId} ${response}`);
      invites = invites.map((i) => (i.id === inviteId ? { ...i, response } : i));
      const eventId = invites.find((i) => i.id === inviteId)?.eventId;
      if (eventId) events = events.map((e) => (e.id === eventId ? { ...e, response } : e));
      emit();
    },
  };
}
