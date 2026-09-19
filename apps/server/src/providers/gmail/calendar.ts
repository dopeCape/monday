// Google Calendar API v3 behind the CalendarSession seam (slice 18; research
// 6, "Google Calendar API v3"): calendarList.list for the calendars,
// events.list with singleEvents and a syncToken for the window (full resync
// on 410), events.insert with sendUpdates=all and a Meet createRequest,
// events.patch for updates and the own responseStatus, events.delete with
// sendUpdates=all, and events.watch for a webhook channel. Google mails the
// invitations and the replies itself. Requests ride the Gmail client for
// auth, retries and backoff; calendar calls cost no Gmail quota.

import type { Attendee, CalendarInfo, IsoDate, Person, RsvpResponse } from "@monday/shared";
import { meetingLinkIn } from "@monday/shared";
import {
  type CalendarSession,
  type CalendarSyncEvent,
  type CreateEventInput,
  type EventWindow,
  type ProviderCalendar,
  ProviderError,
  type ProviderEvent,
  type UpdateEventInput,
} from "../types.ts";
import type { GmailApiError, GmailClient } from "./client.ts";

export const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

interface GoogleCalendarEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  accessRole?: "freeBusyReader" | "reader" | "writerWithoutPrivateAccess" | "writer" | "owner";
  backgroundColor?: string;
  deleted?: boolean;
  conferenceProperties?: { allowedConferenceSolutionTypes?: string[] };
}

interface GoogleDate {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleAttendee {
  email: string;
  displayName?: string;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
}

export interface GoogleEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleDate;
  end?: GoogleDate;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: GoogleAttendee[];
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
    createRequest?: { status?: { statusCode?: string } };
  };
  recurrence?: string[];
  recurringEventId?: string;
  etag?: string;
  updated?: string;
}

interface GoogleState {
  v: 1;
  syncToken?: string;
  pageToken?: string;
}

const RESPONSE_OF: Record<NonNullable<GoogleAttendee["responseStatus"]>, RsvpResponse> = {
  needsAction: "needs-action",
  declined: "declined",
  tentative: "tentative",
  accepted: "accepted",
};

const STATUS_FOR: Record<RsvpResponse, NonNullable<GoogleAttendee["responseStatus"]>> = {
  "needs-action": "needsAction",
  declined: "declined",
  tentative: "tentative",
  accepted: "accepted",
};

function dateOf(value: GoogleDate | undefined): {
  at: IsoDate;
  allDay: boolean;
  zone: string | null;
} {
  if (value?.dateTime) {
    return {
      at: new Date(value.dateTime).toISOString(),
      allDay: false,
      zone: value.timeZone ?? null,
    };
  }
  if (value?.date)
    return { at: new Date(`${value.date}T00:00:00Z`).toISOString(), allDay: true, zone: null };
  return { at: new Date(0).toISOString(), allDay: false, zone: null };
}

function attendeeOf(a: GoogleAttendee): Attendee {
  return {
    name: a.displayName ?? "",
    email: a.email.toLowerCase(),
    response: RESPONSE_OF[a.responseStatus ?? "needsAction"],
    ...(a.self ? { self: true } : {}),
    ...(a.optional ? { optional: true } : {}),
    ...(a.organizer ? { organizer: true } : {}),
  };
}

/** A ProviderEvent from Google's resource. Cancelled instances still come through so the engine removes them. */
export function eventOfGoogle(calendarId: string, e: GoogleEvent): ProviderEvent {
  const start = dateOf(e.start);
  const end = dateOf(e.end);
  const attendees = (e.attendees ?? []).map(attendeeOf);
  const self = attendees.find((a) => a.self);
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  return {
    id: e.id,
    calendarId,
    uid: e.iCalUID ?? null,
    title: e.summary ?? "",
    description: e.description ?? "",
    location: e.location ?? "",
    start: start.at,
    end: end.at,
    allDay: start.allDay,
    timeZone: start.zone,
    organizer: e.organizer?.email
      ? { name: e.organizer.displayName ?? "", email: e.organizer.email.toLowerCase() }
      : null,
    attendees,
    link:
      video ?? e.hangoutLink ?? meetingLinkIn(e.location) ?? meetingLinkIn(e.description) ?? null,
    status: e.status ?? "confirmed",
    recurrence: e.recurrence?.find((r) => r.startsWith("RRULE:"))?.slice(6) ?? null,
    recurringEventId: e.recurringEventId ?? null,
    response: self?.response ?? null,
    etag: e.etag ?? null,
    updatedAt: e.updated ? new Date(e.updated).toISOString() : new Date().toISOString(),
  };
}

function googleDate(at: IsoDate, allDay: boolean, zone: string | null): GoogleDate {
  if (allDay) return { date: at.slice(0, 10) };
  return { dateTime: at, ...(zone ? { timeZone: zone } : {}) };
}

function googleAttendees(people: readonly Person[]): GoogleAttendee[] {
  return people.map((p) => ({ email: p.email, ...(p.name ? { displayName: p.name } : {}) }));
}

export interface GoogleCalendarOptions {
  now?: () => Date;
  random?: () => number;
}

export function createGoogleCalendar(
  client: GmailClient,
  address: string,
  options: GoogleCalendarOptions = {},
): CalendarSession {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  let meetAllowed: boolean | null = null;

  async function api<T>(
    path: string,
    init: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      query?: Record<string, string | undefined>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const response = await client.raw(`${CALENDAR_API_BASE}/${path}`, {
      ...(init.method ? { method: init.method } : {}),
      ...(init.query ? { query: init.query } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const calendarPath = (id: string) => `calendars/${encodeURIComponent(id)}`;

  const session: CalendarSession = {
    info(): CalendarInfo {
      return {
        source: "google",
        providerSendsInvites: true,
        meetingLinks: meetAllowed === false ? ["custom"] : ["google-meet", "custom"],
        defaultMeetingLink: meetAllowed === false ? "none" : "google-meet",
        push: true,
      };
    },

    async listCalendars() {
      const out: ProviderCalendar[] = [];
      let pageToken: string | undefined;
      do {
        const page = await api<{ items?: GoogleCalendarEntry[]; nextPageToken?: string }>(
          "users/me/calendarList",
          { query: { maxResults: "250", pageToken } },
        );
        for (const c of page.items ?? []) {
          if (c.deleted) continue;
          if (c.primary) {
            const allowed = c.conferenceProperties?.allowedConferenceSolutionTypes;
            meetAllowed = allowed ? allowed.includes("hangoutsMeet") : true;
          }
          out.push({
            id: c.id,
            name: c.summaryOverride ?? c.summary ?? c.id,
            primary: c.primary ?? false,
            writable: c.accessRole === "writer" || c.accessRole === "owner",
            color: c.backgroundColor ?? null,
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },

    async *syncEvents(
      calendarId: string,
      state: string | null,
      window: EventWindow,
    ): AsyncIterable<CalendarSyncEvent> {
      let stored: GoogleState | null = null;
      try {
        stored = state ? (JSON.parse(state) as GoogleState) : null;
      } catch {
        stored = null;
      }
      const query: Record<string, string | undefined> = {
        maxResults: "250",
        singleEvents: "true",
        showDeleted: "true",
      };
      if (stored?.syncToken) query.syncToken = stored.syncToken;
      else {
        query.timeMin = window.from;
        query.timeMax = window.to;
      }
      if (stored?.pageToken) query.pageToken = stored.pageToken;
      let page: { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
      try {
        page = await api(`${calendarPath(calendarId)}/events`, { query });
      } catch (error) {
        if ((error as GmailApiError).status === 410 && stored?.syncToken) {
          // The token expired: full wipe and resync (Google's own instruction).
          yield { type: "reset" };
          yield* session.syncEvents(calendarId, null, window);
          return;
        }
        throw error;
      }
      for (const e of page.items ?? []) {
        if (e.status === "cancelled") yield { type: "removed", id: e.id };
        else yield { type: "upserted", event: eventOfGoogle(calendarId, e) };
      }
      const next: GoogleState = { v: 1 };
      const syncToken = page.nextSyncToken ?? stored?.syncToken;
      if (syncToken) next.syncToken = syncToken;
      if (page.nextPageToken && !page.nextSyncToken) next.pageToken = page.nextPageToken;
      yield { type: "state", state: JSON.stringify(next), complete: !page.nextPageToken };
    },

    async createEvent(calendarId, input: CreateEventInput) {
      const wantMeet = input.meetingLink === "google-meet";
      const body: Record<string, unknown> = {
        summary: input.title,
        description: input.description ?? "",
        location: input.location ?? "",
        start: googleDate(input.start, input.allDay ?? false, input.timeZone ?? null),
        end: googleDate(input.end, input.allDay ?? false, input.timeZone ?? null),
        attendees: googleAttendees(input.attendees ?? []),
        ...(input.recurrence ? { recurrence: [`RRULE:${input.recurrence}`] } : {}),
        ...(wantMeet
          ? {
              conferenceData: {
                createRequest: {
                  requestId: `monday-${Math.floor(random() * 1e12).toString(36)}`,
                  conferenceSolutionKey: { type: "hangoutsMeet" },
                },
              },
            }
          : {}),
      };
      if (input.meetingLink === "custom" && input.customLink) {
        body.location = input.location || input.customLink;
        body.description = [input.description ?? "", input.customLink].filter(Boolean).join("\n\n");
      }
      let created = await api<GoogleEvent>(`${calendarPath(calendarId)}/events`, {
        method: "POST",
        query: { sendUpdates: "all", conferenceDataVersion: wantMeet ? "1" : "0" },
        body,
      });
      // The Meet link may come back pending; one re-read usually has it.
      if (wantMeet && created.conferenceData?.createRequest?.status?.statusCode === "pending") {
        created = await api<GoogleEvent>(
          `${calendarPath(calendarId)}/events/${encodeURIComponent(created.id)}`,
          { query: { conferenceDataVersion: "1" } },
        );
      }
      return eventOfGoogle(calendarId, created);
    },

    async updateEvent(calendarId, eventId, input: UpdateEventInput, _etag) {
      const body: Record<string, unknown> = {};
      if (input.title !== undefined) body.summary = input.title;
      if (input.description !== undefined) body.description = input.description;
      if (input.location !== undefined) body.location = input.location;
      if (input.start !== undefined || input.allDay !== undefined || input.timeZone !== undefined) {
        const current = await api<GoogleEvent>(
          `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`,
        );
        const allDay = input.allDay ?? !!current.start?.date;
        const zone =
          input.timeZone === undefined ? (current.start?.timeZone ?? null) : input.timeZone;
        const start = input.start ?? dateOf(current.start).at;
        const end = input.end ?? dateOf(current.end).at;
        body.start = googleDate(start, allDay, zone);
        body.end = googleDate(end, allDay, zone);
      } else if (input.end !== undefined) {
        body.end = googleDate(input.end, false, input.timeZone ?? null);
      }
      if (input.attendees !== undefined) body.attendees = googleAttendees(input.attendees);
      if (input.recurrence !== undefined) {
        body.recurrence = input.recurrence ? [`RRULE:${input.recurrence}`] : [];
      }
      const updated = await api<GoogleEvent>(
        `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: "PATCH", query: { sendUpdates: "all", conferenceDataVersion: "1" }, body },
      );
      return eventOfGoogle(calendarId, updated);
    },

    async deleteEvent(calendarId, eventId) {
      try {
        await api(`${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`, {
          method: "DELETE",
          query: { sendUpdates: "all" },
        });
      } catch (error) {
        if ((error as GmailApiError).status !== 404 && (error as GmailApiError).status !== 410) {
          throw error;
        }
      }
    },

    async rsvp(calendarId, eventId, response) {
      const current = await api<GoogleEvent>(
        `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
      const me = address.toLowerCase();
      const attendees = (current.attendees ?? []).map((a) =>
        a.self || a.email.toLowerCase() === me ? { ...a, responseStatus: STATUS_FOR[response] } : a,
      );
      if (!attendees.some((a) => a.self || a.email.toLowerCase() === me)) {
        throw new ProviderError("the Account is not an attendee of that Event", "unsupported");
      }
      // patch overwrites array fields, so the whole list goes back (research 6).
      const updated = await api<GoogleEvent>(
        `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: "PATCH", query: { sendUpdates: "all" }, body: { attendees } },
      );
      return eventOfGoogle(calendarId, updated);
    },

    async subscribe(calendarId, webhookAddress, token) {
      const id = crypto.randomUUID();
      const result = await api<{ id: string; resourceId?: string; expiration?: string }>(
        `${calendarPath(calendarId)}/events/watch`,
        { method: "POST", body: { id, type: "web_hook", address: webhookAddress, token } },
      );
      const expiresAt = result.expiration
        ? new Date(Number(result.expiration)).toISOString()
        : new Date(now().getTime() + 7 * 86_400_000).toISOString();
      return { id: `${result.id}:${result.resourceId ?? ""}`, expiresAt };
    },

    async unsubscribe(subscription) {
      const [id, resourceId] = subscription.id.split(":");
      await api("channels/stop", {
        method: "POST",
        body: { id, resourceId: subscription.resourceId ?? resourceId },
      }).catch(() => {});
    },

    async close() {
      // The Gmail client is the mail Session's; nothing to release here.
    },
  };
  return session;
}
