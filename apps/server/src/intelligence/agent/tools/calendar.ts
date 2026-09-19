// The calendar tools (slice 18, ADR 0002): what "set up a call with Aoife
// Thursday 15:00" runs. list_events reads the window; schedule_event,
// update_event and rsvp leave the mailbox (an invitation or a reply goes out,
// by the Provider or by monday) so they always ask first with the card that
// shows the slot, the people, the link and who will mail; delete_event is
// destructive. The tools see the calendar through a seam the tool server is
// handed (the calendar module on the Server); a host without one refuses.

import type {
  CalendarEvent,
  CalendarInfo,
  EventInput,
  EventPatch,
  EventPreview,
  IntentResult,
  Invite,
  InviteIntent,
  IsoDate,
  MeetingLinkKind,
  MeetingLinkSetting,
  Person,
  RsvpResponse,
  ToolPreview,
} from "@monday/shared";
import { settingsSchema } from "@monday/shared";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolPlan } from "./catalog.ts";

/** What the calendar tools act through: the calendar module on the Server. */
export interface CalendarSeam {
  info(workspaceId: string): Promise<CalendarInfo>;
  listEvents(
    workspaceId: string,
    options: { from: IsoDate; to: IsoDate },
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
  updateEvent(eventId: string, patch: EventPatch): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<void>;
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

function refused(text: string): ToolPlan {
  return { kind: "refused", text };
}

const NO_CALENDAR = "The calendar is not available from this host.";

function compact(e: CalendarEvent) {
  return {
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    timeZone: e.timeZone,
    location: e.location,
    attendees: e.attendees.map((a) => ({ email: a.email, name: a.name, response: a.response })),
    organizer: e.organizer,
    link: e.link,
    status: e.status,
    response: e.response,
    recurrence: e.recurrence,
    createdByAgent: e.createdByAgent,
  };
}

function when(start: IsoDate, end: IsoDate, allDay: boolean): string {
  if (allDay) return start.slice(0, 10);
  return `${start.replace("T", " ").slice(0, 16)} to ${end.replace("T", " ").slice(0, 16)} UTC`;
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

/* ------------------------------ list_events ------------------------------ */

const listEvents: ToolDefinition<{
  from?: string | undefined;
  to?: string | undefined;
  days?: number | undefined;
}> = {
  name: "list_events",
  description:
    "Events on the user's calendar in a window: from and to as ISO dates with offsets, or the next N days from now (default 7). Returns ids to act on with rsvp, update_event and delete_event, plus each Event's link and who is attending. Use it to check for free time before scheduling.",
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
  }),
  summarize: (i) =>
    i.from && i.to ? `${i.from.slice(0, 10)} to ${i.to.slice(0, 10)}` : `next ${i.days ?? 7} days`,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    const now = ctx.now();
    const from = input.from ?? new Date(now.getTime() - 3_600_000).toISOString();
    const to =
      input.to ?? new Date(Date.parse(from) + (input.days ?? 7) * 86_400_000).toISOString();
    const events = await seam.listEvents(ctx.host.workspaceId, { from, to });
    const info = await seam.info(ctx.host.workspaceId);
    return {
      kind: "result",
      text:
        events.length === 0
          ? `No Events between ${from.slice(0, 16)} and ${to.slice(0, 16)}.`
          : `${events.length} Event${events.length === 1 ? "" : "s"}:\n${events
              .map(
                (e) =>
                  `- ${e.id}: ${e.title} (${when(e.start, e.end, e.allDay)})${
                    e.attendees.length > 1
                      ? ` with ${e.attendees
                          .filter((a) => !a.self)
                          .map((a) => a.name || a.email)
                          .join(", ")}`
                      : ""
                  }${e.link ? ` ${e.link}` : ""}${e.response && e.response !== "accepted" ? ` [${e.response}]` : ""}`,
              )
              .join("\n")}`,
      data: { events: events.map(compact), calendar: info },
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
}> = {
  name: "schedule_event",
  description:
    "Create an Event on the user's calendar, with attendees and a meeting link, and send the invitations. Give start (ISO with offset) and either end or duration_minutes (default: the Default meeting length Setting). The meeting link defaults to the Account's Setting (Google Meet on Google, Teams on Microsoft 365, none or Jitsi elsewhere). Invitations go out from the Provider where it mails them itself (Google, Microsoft 365, Fastmail), otherwise monday mails them. Leaves the mailbox, so it always asks first with the slot, the people and any overlapping Event of the user's own. Undo cancels the Event.",
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
    if (!durationMinutes && !input.end) {
      const setting = await ctx.host.readSetting("calendar.default_duration_minutes");
      durationMinutes =
        typeof setting.value === "number"
          ? setting.value
          : settingsSchema["calendar.default_duration_minutes"].default;
    }
    const start = new Date(input.start).toISOString();
    const end = input.end
      ? new Date(input.end).toISOString()
      : new Date(Date.parse(start) + (durationMinutes ?? 30) * 60_000).toISOString();
    if (Date.parse(end) <= Date.parse(start))
      return refused("The Event would end before it starts.");
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

/* ------------------------------ update_event ------------------------------ */

const updateEvent: ToolDefinition<{
  event_id: string;
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  attendees?: Array<string | { name: string; email: string }> | undefined;
  description?: string | undefined;
  location?: string | undefined;
  meeting_link?: MeetingLinkKind | undefined;
}> = {
  name: "update_event",
  description:
    "Change an Event the user organizes: move it, rename it, change who is invited or the link. Attendees get an update from the Provider or from monday, so it always asks first.",
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
  }),
  summarize: (i) => i.event_id,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    const current = await seam.readEvent(input.event_id);
    if (!current) return refused(`Event ${input.event_id} not found.`);
    const start = input.start ? new Date(input.start).toISOString() : current.start;
    const end = input.end
      ? new Date(input.end).toISOString()
      : input.start
        ? new Date(
            Date.parse(start) + (Date.parse(current.end) - Date.parse(current.start)),
          ).toISOString()
        : current.end;
    const attendees = input.attendees
      ? input.attendees.map(toPerson)
      : current.attendees.filter((a) => !a.self).map((a) => ({ name: a.name, email: a.email }));
    const info = await seam.info(ctx.host.workspaceId);
    const conflicts = await conflictsFor(seam, ctx.host.workspaceId, start, end, current.id);
    const preview: ToolPreview = {
      kind: "event",
      event: {
        action: "update",
        title: input.title ?? current.title,
        start,
        end,
        allDay: current.allDay,
        timeZone: current.timeZone,
        attendees,
        link: input.meeting_link ?? current.link,
        invitesBy: invitesBy(info, attendees),
        conflicts,
      },
    };
    return {
      kind: "action",
      preview,
      count: 1,
      apply: async () => {
        const event = await seam.updateEvent(current.id, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.start !== undefined || input.end !== undefined ? { start, end } : {}),
          ...(input.attendees !== undefined ? { attendees } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.meeting_link !== undefined ? { meetingLink: input.meeting_link } : {}),
        });
        return {
          text: `Updated "${event.title}": ${when(event.start, event.end, event.allDay)}${event.link ? `, ${event.link}` : ""}.`,
          data: { event: compact(event) },
          undo: null,
        };
      },
    };
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

const deleteEvent: ToolDefinition<{ event_id: string }> = {
  name: "delete_event",
  description:
    "Cancel and remove an Event. Attendees get a cancellation from the Provider or from monday. Asks the user first; cannot be undone.",
  tier: "destructive",
  input: z.object({ event_id: z.string().min(1) }),
  summarize: (i) => i.event_id,
  async run(input, ctx) {
    const seam = ctx.extensions?.calendar;
    if (!seam) return refused(NO_CALENDAR);
    const current = await seam.readEvent(input.event_id);
    if (!current) return refused(`Event ${input.event_id} not found.`);
    const info = await seam.info(ctx.host.workspaceId);
    const attendees = current.attendees
      .filter((a) => !a.self)
      .map((a) => ({ name: a.name, email: a.email }));
    const preview: ToolPreview = {
      kind: "event",
      event: {
        action: "cancel",
        title: current.title,
        start: current.start,
        end: current.end,
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
        await seam.deleteEvent(current.id);
        return {
          text: `Cancelled "${current.title}" (${when(current.start, current.end, current.allDay)}).`,
          data: { eventId: current.id },
          undo: null,
        };
      },
    };
  },
};

export const CALENDAR_TOOLS: readonly ToolDefinition<never>[] = [
  listEvents,
  scheduleEvent,
  rsvp,
  updateEvent,
  deleteEvent,
] as unknown as readonly ToolDefinition<never>[];
