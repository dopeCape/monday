// Microsoft Graph v1.0 calendars behind the CalendarSession seam (slice 18;
// research 6, "Microsoft Graph v1.0"): GET /me/calendars, calendarView/delta
// per calendar for the window (occurrences expanded; @removed entries
// outside the range filtered), POST /me/calendars/{id}/events with
// isOnlineMeeting for a Teams link (Graph mails the invitations, always),
// PATCH for updates, DELETE, the accept/tentativelyAccept/decline actions
// for the own answer, and a change notification subscription for push.

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
import { GRAPH_BASE, type GraphApiError, type GraphClient } from "./client.ts";

interface GraphCalendar {
  id: string;
  name?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
  hexColor?: string;
  allowedOnlineMeetingProviders?: string[];
  defaultOnlineMeetingProvider?: string;
}

interface GraphDateTime {
  dateTime: string;
  timeZone?: string;
}

interface GraphAttendee {
  emailAddress?: { address?: string; name?: string };
  type?: "required" | "optional" | "resource";
  status?: { response?: string };
}

export interface GraphEvent {
  id: string;
  "@removed"?: { reason?: string };
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  location?: { displayName?: string };
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  organizer?: { emailAddress?: { address?: string; name?: string } };
  attendees?: GraphAttendee[];
  isOrganizer?: boolean;
  responseStatus?: { response?: string };
  onlineMeeting?: { joinUrl?: string };
  onlineMeetingUrl?: string;
  seriesMasterId?: string;
  type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  changeKey?: string;
  lastModifiedDateTime?: string;
  originalStartTimeZone?: string;
  isReminderOn?: boolean;
  reminderMinutesBeforeStart?: number;
}

interface GraphState {
  v: 1;
  link: string;
  kind: "next" | "delta";
}

const RESPONSE_OF: Record<string, RsvpResponse> = {
  none: "needs-action",
  notResponded: "needs-action",
  organizer: "accepted",
  accepted: "accepted",
  tentativelyAccepted: "tentative",
  declined: "declined",
};

/** Graph dateTime values carry no offset; the timeZone beside them says which zone (UTC when asked for). */
function instantOf(value: GraphDateTime | undefined, allDay: boolean): IsoDate {
  if (!value?.dateTime) return new Date(0).toISOString();
  const text = value.dateTime.replace(/(\.\d{3})\d+$/, "$1");
  const zone = value.timeZone ?? "UTC";
  if (allDay) return new Date(`${text.slice(0, 10)}T00:00:00Z`).toISOString();
  if (zone === "UTC") return new Date(`${text}Z`).toISOString();
  return new Date(`${text}Z`).toISOString();
}

function attendeeOf(a: GraphAttendee, me: string, organizerEmail: string | null): Attendee {
  const email = (a.emailAddress?.address ?? "").toLowerCase();
  return {
    name: a.emailAddress?.name ?? "",
    email,
    response: RESPONSE_OF[a.status?.response ?? "none"] ?? "needs-action",
    ...(email === me ? { self: true } : {}),
    ...(a.type === "optional" ? { optional: true } : {}),
    ...(organizerEmail && email === organizerEmail ? { organizer: true } : {}),
  };
}

function textOfBody(body: GraphEvent["body"], preview: string | undefined): string {
  if (!body?.content) return preview ?? "";
  if (body.contentType === "html") {
    return body.content
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
  }
  return body.content;
}

export function eventOfGraph(calendarId: string, me: string, e: GraphEvent): ProviderEvent {
  const organizerEmail = e.organizer?.emailAddress?.address?.toLowerCase() ?? null;
  const attendees = (e.attendees ?? []).map((a) => attendeeOf(a, me, organizerEmail));
  const allDay = e.isAllDay ?? false;
  const description = textOfBody(e.body, e.bodyPreview);
  const own = e.isOrganizer
    ? "accepted"
    : (RESPONSE_OF[e.responseStatus?.response ?? "none"] ?? null);
  return {
    id: e.id,
    calendarId,
    uid: e.iCalUId ?? null,
    title: e.subject ?? "",
    description,
    location: e.location?.displayName ?? "",
    start: instantOf(e.start, allDay),
    end: instantOf(e.end, allDay),
    allDay,
    timeZone:
      e.originalStartTimeZone && e.originalStartTimeZone !== "UTC" ? e.originalStartTimeZone : null,
    organizer: organizerEmail
      ? { name: e.organizer?.emailAddress?.name ?? "", email: organizerEmail }
      : null,
    attendees,
    link:
      e.onlineMeeting?.joinUrl ??
      e.onlineMeetingUrl ??
      meetingLinkIn(e.location?.displayName) ??
      meetingLinkIn(description) ??
      null,
    status: e.isCancelled ? "cancelled" : e.showAs === "tentative" ? "tentative" : "confirmed",
    recurrence: null,
    recurringEventId: e.seriesMasterId ?? null,
    response: own,
    ...(e.isReminderOn === false
      ? { reminders: [] }
      : typeof e.reminderMinutesBeforeStart === "number"
        ? { reminders: [e.reminderMinutesBeforeStart] }
        : {}),
    etag: e.changeKey ?? null,
    updatedAt: e.lastModifiedDateTime
      ? new Date(e.lastModifiedDateTime).toISOString()
      : new Date().toISOString(),
  };
}

function graphDate(at: IsoDate, allDay: boolean): GraphDateTime {
  return allDay
    ? { dateTime: `${at.slice(0, 10)}T00:00:00.0000000`, timeZone: "UTC" }
    : { dateTime: at.replace("Z", ""), timeZone: "UTC" };
}

/** Graph keeps one reminder per Event: the first minutes, off for an empty list, the default for null. */
export function graphReminder(minutes: readonly number[] | null): Record<string, unknown> {
  if (minutes === null) return { isReminderOn: true, reminderMinutesBeforeStart: 15 };
  const first = minutes[0];
  return first === undefined
    ? { isReminderOn: false }
    : { isReminderOn: true, reminderMinutesBeforeStart: first };
}

function graphAttendees(people: readonly Person[]): GraphAttendee[] {
  return people.map((p) => ({
    emailAddress: { address: p.email, ...(p.name ? { name: p.name } : {}) },
    type: "required" as const,
  }));
}

export interface GraphCalendarOptions {
  now?: () => Date;
}

export function createGraphCalendar(
  client: GraphClient,
  address: string,
  options: GraphCalendarOptions = {},
): CalendarSession {
  const now = options.now ?? (() => new Date());
  const me = address.toLowerCase();
  let teamsAllowed: boolean | null = null;
  const utc = { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' };

  const eventsPath = (calendarId: string) =>
    `me/calendars/${encodeURIComponent(calendarId)}/events`;

  const session: CalendarSession = {
    info(): CalendarInfo {
      return {
        source: "graph",
        providerSendsInvites: true,
        meetingLinks: teamsAllowed === false ? ["custom"] : ["teams", "custom"],
        defaultMeetingLink: teamsAllowed === false ? "none" : "teams",
        push: true,
      };
    },

    async listCalendars() {
      const out: ProviderCalendar[] = [];
      let url: string | null = "me/calendars";
      while (url) {
        const page: { value: GraphCalendar[]; "@odata.nextLink"?: string } = await client.request(
          url,
          { query: { $top: "100" } },
        );
        for (const c of page.value) {
          if (c.isDefaultCalendar) {
            teamsAllowed = (c.allowedOnlineMeetingProviders ?? []).includes("teamsForBusiness");
          }
          out.push({
            id: c.id,
            name: c.name ?? "Calendar",
            primary: c.isDefaultCalendar ?? false,
            writable: c.canEdit ?? true,
            color: c.hexColor || null,
          });
        }
        url = page["@odata.nextLink"] ?? null;
      }
      return out;
    },

    async *syncEvents(
      calendarId: string,
      state: string | null,
      window: EventWindow,
    ): AsyncIterable<CalendarSyncEvent> {
      let stored: GraphState | null = null;
      try {
        stored = state ? (JSON.parse(state) as GraphState) : null;
      } catch {
        stored = null;
      }
      const initial = `${GRAPH_BASE}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?startDateTime=${encodeURIComponent(window.from)}&endDateTime=${encodeURIComponent(window.to)}`;
      let page: { value: GraphEvent[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
      try {
        page = await client.request(stored?.link ?? initial, {
          headers: { ...utc, prefer: `${utc.prefer}, odata.maxpagesize=100` },
        });
      } catch (error) {
        const code = (error as GraphApiError).odataCode;
        if (
          stored &&
          (code === "SyncStateNotFound" ||
            code === "SyncStateInvalid" ||
            (error as GraphApiError).status === 410)
        ) {
          yield { type: "reset" };
          yield* session.syncEvents(calendarId, null, window);
          return;
        }
        throw error;
      }
      const from = Date.parse(window.from);
      const to = Date.parse(window.to);
      for (const e of page.value) {
        if (e["@removed"]) {
          yield { type: "removed", id: e.id };
          continue;
        }
        if (e.type === "seriesMaster") continue;
        const event = eventOfGraph(calendarId, me, e);
        // Delta lists out-of-range changes too (research 6): keep the window.
        const s = Date.parse(event.start);
        const en = Date.parse(event.end);
        if (en < from || s >= to) {
          yield { type: "removed", id: e.id };
          continue;
        }
        if (event.status === "cancelled") yield { type: "removed", id: e.id };
        else yield { type: "upserted", event };
      }
      const next = page["@odata.nextLink"];
      const link = next ?? page["@odata.deltaLink"] ?? initial;
      yield {
        type: "state",
        state: JSON.stringify({ v: 1, link, kind: next ? "next" : "delta" } satisfies GraphState),
        complete: !next,
      };
    },

    async createEvent(calendarId, input: CreateEventInput) {
      const teams = input.meetingLink === "teams";
      const custom = input.meetingLink === "custom" ? input.customLink : null;
      const description = [input.description ?? "", custom ?? ""].filter(Boolean).join("\n\n");
      const body = {
        subject: input.title,
        body: { contentType: "text", content: description },
        ...(input.location || custom
          ? { location: { displayName: input.location || custom } }
          : {}),
        start: graphDate(input.start, input.allDay ?? false),
        end: graphDate(input.end, input.allDay ?? false),
        isAllDay: input.allDay ?? false,
        attendees: graphAttendees(input.attendees ?? []),
        ...(teams ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
        ...(input.reminders !== undefined ? graphReminder(input.reminders) : {}),
        transactionId: crypto.randomUUID(),
      };
      const created = await client.request<GraphEvent>(eventsPath(calendarId), {
        method: "POST",
        body,
        headers: utc,
      });
      return eventOfGraph(calendarId, me, created);
    },

    async updateEvent(calendarId, eventId, input: UpdateEventInput, _etag) {
      const body: Record<string, unknown> = {};
      if (input.title !== undefined) body.subject = input.title;
      if (input.description !== undefined) {
        body.body = { contentType: "text", content: input.description };
      }
      if (input.location !== undefined) body.location = { displayName: input.location };
      if (input.start !== undefined) body.start = graphDate(input.start, input.allDay ?? false);
      if (input.end !== undefined) body.end = graphDate(input.end, input.allDay ?? false);
      if (input.allDay !== undefined) body.isAllDay = input.allDay;
      if (input.attendees !== undefined) body.attendees = graphAttendees(input.attendees);
      if (input.reminders !== undefined) Object.assign(body, graphReminder(input.reminders));
      if (input.meetingLink === "teams") {
        body.isOnlineMeeting = true;
        body.onlineMeetingProvider = "teamsForBusiness";
      }
      const updated = await client.request<GraphEvent>(`me/events/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        body,
        headers: utc,
      });
      return eventOfGraph(calendarId, me, updated);
    },

    async readEvent(calendarId, eventId) {
      const e = await client.request<GraphEvent>(`me/events/${encodeURIComponent(eventId)}`, {
        headers: utc,
      });
      return eventOfGraph(calendarId, me, e);
    },

    async deleteEvent(_calendarId, eventId) {
      try {
        await client.request(`me/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
      } catch (error) {
        if ((error as GraphApiError).code !== "not-found") throw error;
      }
    },

    async rsvp(calendarId, eventId, response) {
      const action =
        response === "accepted"
          ? "accept"
          : response === "tentative"
            ? "tentativelyAccept"
            : response === "declined"
              ? "decline"
              : null;
      if (!action) {
        throw new ProviderError("Graph cannot set an Event back to needs-action", "unsupported");
      }
      await client.request(`me/events/${encodeURIComponent(eventId)}/${action}`, {
        method: "POST",
        body: { sendResponse: true },
      });
      const fresh = await client.request<GraphEvent>(`me/events/${encodeURIComponent(eventId)}`, {
        headers: utc,
      });
      return eventOfGraph(calendarId, me, fresh);
    },

    async subscribe(_calendarId, webhookAddress, token) {
      const expiresAt = new Date(now().getTime() + 6 * 86_400_000).toISOString();
      const result = await client.request<{ id: string; expirationDateTime?: string }>(
        "subscriptions",
        {
          method: "POST",
          body: {
            changeType: "created,updated,deleted",
            notificationUrl: webhookAddress,
            resource: "/me/events",
            expirationDateTime: expiresAt,
            clientState: token,
          },
        },
      );
      return { id: result.id, expiresAt: result.expirationDateTime ?? expiresAt };
    },

    async unsubscribe(subscription) {
      await client
        .request(`subscriptions/${encodeURIComponent(subscription.id)}`, { method: "DELETE" })
        .catch(() => {});
    },

    async close() {
      // The Graph client is the mail Session's; nothing to release here.
    },
  };
  return session;
}
