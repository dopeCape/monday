// The calendar module (slice 18, docs/research/calendar-apis.md): one
// interface over every kind of calendar an Account can have. A Provider with
// a calendar API (Google, Graph) is read and written through the Session's
// CalendarSession; an Account with a linked CalDAV calendar through the
// CalDAV adapter; anything else through the Local calendar, rows in the
// events table that monday alone keeps. Invites are the text/calendar parts
// the sync engine hands over as bodies land; an RSVP goes through the
// calendar API where one exists and by an iMIP REPLY over the Account's mail
// Session otherwise, and never both. Nothing here sends an invitation on an
// Account whose Provider mails them itself.
//
// Jobs: calendar.sync (poll every calendar.poll_minutes; woken early by a
// webhook) and calendar.watch (webhook registration where a public URL
// exists, needs-public-url). Every write records an "event" or "invite" row
// on the Changes feed with the headers; titles stay behind the content routes.

import type {
  Calendar,
  CalendarEvent,
  CalendarInfo,
  CalendarSource,
  EventChange,
  EventInput,
  EventPatch,
  IntentResult,
  Invite,
  InviteChange,
  InviteIntent,
  IsoDate,
  MeetingLinkKind,
  MeetingLinkSetting,
  Person,
  RsvpResponse,
} from "@monday/shared";
import { resolveWrite, settingsSchema } from "@monday/shared";
import { and, asc, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { timingSafeEqual } from "../auth/index.ts";
import type { Db } from "../db/client.ts";
import {
  accounts,
  activity,
  calendars,
  events,
  invites,
  messages,
  workspaces,
} from "../db/schema.ts";
import type { Jobs } from "../jobs/index.ts";
import { type Mailstore, NotFoundError, subjectSearchOf } from "../mailstore/index.ts";
import { createCalDavSession } from "../providers/caldav/index.ts";
import type { CredentialStore } from "../providers/credentials.ts";
import { composeMime } from "../providers/mime.ts";
import type { SyncEngine } from "../providers/sync.ts";
import type {
  CalendarSession,
  CreateEventInput,
  ProviderError,
  ProviderEvent,
  RawMessage,
} from "../providers/types.ts";
import { readGlobalSettings } from "../settings/read.ts";
import { type EventToWrite, parseICalendar, writeICalendar, writeReply } from "./ical.ts";

export const CALENDAR_SYNC_STEP = "calendar.sync";
export const CALENDAR_WATCH_STEP = "calendar.watch";

/** How long the watch Job sleeps when this Server has no public URL. */
export const NO_PUBLIC_URL_SLEEP_MS = 30 * 60_000;
/** Renew a webhook registration when less than this remains. */
export const RENEW_MARGIN_MS = 24 * 3_600_000;
/** The Local calendar's Provider id. */
export const LOCAL_CALENDAR_ID = "local";

export interface CalendarSettings {
  pollMinutes: number;
  meetingLink: MeetingLinkSetting;
  meetingLinks: Record<string, MeetingLinkSetting>;
  customLink: string;
  defaultDurationMinutes: number;
  windowPastDays: number;
  windowFutureDays: number;
}

export const CALENDAR_SETTING_KEYS = [
  "calendar.poll_minutes",
  "calendar.meeting_link",
  "calendar.meeting_links",
  "calendar.custom_link",
  "calendar.default_duration_minutes",
  "calendar.window_past_days",
  "calendar.window_future_days",
] as const;

export function defaultCalendarSettings(): CalendarSettings {
  return {
    pollMinutes: settingsSchema["calendar.poll_minutes"].default,
    meetingLink: settingsSchema["calendar.meeting_link"].default,
    meetingLinks: {},
    customLink: settingsSchema["calendar.custom_link"].default,
    defaultDurationMinutes: settingsSchema["calendar.default_duration_minutes"].default,
    windowPastDays: settingsSchema["calendar.window_past_days"].default,
    windowFutureDays: settingsSchema["calendar.window_future_days"].default,
  };
}

export async function readCalendarSettings(db: Db): Promise<CalendarSettings> {
  const s = await readGlobalSettings(db, CALENDAR_SETTING_KEYS);
  return {
    pollMinutes: s["calendar.poll_minutes"],
    meetingLink: s["calendar.meeting_link"],
    meetingLinks: s["calendar.meeting_links"],
    customLink: s["calendar.custom_link"],
    defaultDurationMinutes: s["calendar.default_duration_minutes"],
    windowPastDays: s["calendar.window_past_days"],
    windowFutureDays: s["calendar.window_future_days"],
  };
}

export interface CalendarSyncReport {
  accountId: string;
  calendars: number;
  upserted: number;
  removed: number;
}

export interface ListEventsOptions {
  from: IsoDate;
  to: IsoDate;
  /** Only these calendars; default every visible one. */
  calendarIds?: string[];
  includeCancelled?: boolean;
}

/** A slot the Workspace is busy in, for the free/busy check before scheduling. */
export interface BusySlot {
  eventId: string;
  start: IsoDate;
  end: IsoDate;
  title: string;
}

export interface EventContent {
  id: string;
  title: string;
  description: string;
  location: string;
}

export interface CreateEventOptions {
  /** True when the Agent's scheduling tool made it; the views mark those. */
  byAgent?: boolean;
}

export interface CalendarModule {
  /** Which calendar the Workspace's Account has and who mails invitations. */
  info(workspaceId: string): Promise<CalendarInfo>;
  listCalendars(workspaceId: string): Promise<Calendar[]>;
  setCalendarVisible(calendarId: string, visible: boolean): Promise<Calendar>;
  /** Links or unlinks a CalDAV calendar on an Account without a calendar API; re-syncs. */
  linkCalDav(
    accountId: string,
    link: { url: string; user: string; password: string } | null,
  ): Promise<CalendarInfo>;
  /** Events in a window, decrypted, masters included (the client expands recurrences). Throws LockedError when locked. */
  listEvents(workspaceId: string, options: ListEventsOptions): Promise<CalendarEvent[]>;
  readEvent(eventId: string): Promise<CalendarEvent | null>;
  /** The content of many Events at once, for the Cache. Unknown ids are left out. */
  eventsContent(workspaceId: string, ids: readonly string[]): Promise<EventContent[]>;
  createEvent(
    workspaceId: string,
    input: EventInput,
    options?: CreateEventOptions,
  ): Promise<CalendarEvent>;
  updateEvent(eventId: string, patch: EventPatch): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<void>;
  /** The Workspace's own answer on an Event; through the Provider or by mail. */
  respond(eventId: string, response: RsvpResponse): Promise<CalendarEvent>;
  /** The Outbox intent from the invite bar: last-writer-wins on the Invite, then `respond`. */
  applyInviteIntent(intent: InviteIntent): Promise<IntentResult>;
  readInvite(inviteId: string): Promise<Invite | null>;
  invitesOfThread(threadId: string): Promise<Invite[]>;
  /** Own busy slots overlapping a window; never waits on a Provider. */
  busy(workspaceId: string, from: IsoDate, to: IsoDate): Promise<BusySlot[]>;
  /** The sync engine's body hook: parses text/calendar parts into Invites. Never throws. */
  observeBody(
    account: { id: string; workspaceId: string; address: string },
    messageId: string,
    threadId: string,
    raw: RawMessage,
  ): Promise<void>;
  syncAccount(accountId: string): Promise<CalendarSyncReport>;
  /** A webhook delivery for an Account; true when the token matched a registration. */
  webhook(accountId: string, token: string | null): Promise<boolean>;
  registerSteps(jobs: Jobs): void;
  startAccount(jobs: Jobs, accountId: string): Promise<void>;
  close(): Promise<void>;
}

export interface CalendarModuleOptions {
  db: Db;
  mailstore: Mailstore;
  sync: SyncEngine;
  credentials: CredentialStore;
  serverId?: string;
  /** The HTTPS origin the internet reaches this Server at, or null. */
  publicUrl?: () => Promise<string | null>;
  settings?: () => Promise<CalendarSettings>;
  now?: () => Date;
  log?: (message: string) => void;
  /** Test seam: the CalDAV adapter to use for a link. */
  caldav?: typeof createCalDavSession;
}

export class CalendarUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CalendarUnavailableError";
  }
}

interface AccountRow {
  id: string;
  workspaceId: string;
  address: string;
  displayName: string;
}

type CalendarRow = typeof calendars.$inferSelect;
type EventRow = typeof events.$inferSelect;
type InviteRow = typeof invites.$inferSelect;

interface Content {
  title: string;
  description: string;
  location: string;
}

const LOCAL_INFO: CalendarInfo = {
  source: "local",
  providerSendsInvites: false,
  meetingLinks: ["jitsi", "custom"],
  defaultMeetingLink: "none",
  push: false,
};

const stringify = (value: unknown) => JSON.stringify(value);

function projectCalendar(row: CalendarRow): Calendar {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    source: row.source,
    providerId: row.providerId,
    name: row.name,
    primary: row.primary,
    writable: row.writable,
    visible: row.visible,
    color: row.color,
  };
}

function eventChangeOf(row: EventRow): EventChange {
  return {
    id: row.id,
    calendarId: row.calendarId,
    providerId: row.providerId,
    uid: row.uid,
    start: row.start.toISOString(),
    end: row.end.toISOString(),
    allDay: row.allDay,
    timeZone: row.timeZone,
    organizer: row.organizer ?? null,
    attendees: row.attendees,
    link: row.link,
    status: row.status,
    recurrence: row.recurrence,
    recurringEventId: row.recurringEventId,
    response: row.response ?? null,
    createdByAgent: row.createdByAgent,
    updatedAt: row.updatedAt.toISOString(),
    deleted: row.deleted,
  };
}

function inviteChangeOf(row: InviteRow): InviteChange {
  return {
    id: row.id,
    messageId: row.messageId,
    threadId: row.threadId,
    eventId: row.eventId,
    method: row.method,
    uid: row.uid,
    sequence: row.sequence,
    start: row.start.toISOString(),
    end: row.end.toISOString(),
    allDay: row.allDay,
    organizer: row.organizer ?? null,
    attendees: row.attendees,
    response: row.response,
    byMail: row.byMail,
    senderMismatch: row.senderMismatch,
    receivedAt: row.receivedAt.toISOString(),
    deleted: false,
  };
}

function emailOfHeader(value: string | undefined): string | null {
  if (!value) return null;
  const m = /<([^>]+)>/.exec(value);
  return (m?.[1] ?? value).trim().toLowerCase() || null;
}

/** A Jitsi room name that reveals nothing about the meeting. */
function jitsiRoom(): string {
  return `monday-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function createCalendar(options: CalendarModuleOptions): CalendarModule {
  const { db, mailstore, sync, credentials } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const readSettings = options.settings ?? (() => readCalendarSettings(db));
  const serverId = options.serverId ?? "server";
  const publicUrl = options.publicUrl ?? (async () => null);
  const caldavFactory = options.caldav ?? createCalDavSession;
  /** CalDAV Sessions per Account; Provider ones are the mail Session's. */
  const caldavSessions = new Map<string, Promise<CalendarSession>>();
  let jobsRef: Jobs | null = null;

  /* ------------------------------ Accounts and Sessions ------------------------------ */

  async function account(accountId: string): Promise<AccountRow> {
    const [row] = await db
      .select({
        id: accounts.id,
        address: accounts.address,
        displayName: accounts.displayName,
        workspaceId: workspaces.id,
      })
      .from(accounts)
      .innerJoin(workspaces, eq(workspaces.accountId, accounts.id))
      .where(eq(accounts.id, accountId));
    if (!row) throw new NotFoundError("workspace", accountId);
    return row;
  }

  async function accountOfWorkspace(workspaceId: string): Promise<AccountRow> {
    const [row] = await db
      .select({
        id: accounts.id,
        address: accounts.address,
        displayName: accounts.displayName,
        workspaceId: workspaces.id,
      })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    if (!row) throw new NotFoundError("workspace", workspaceId);
    return row;
  }

  /**
   * The CalendarSession for an Account: the Provider's own, a CalDAV link,
   * or null for the Local calendar.
   */
  async function sessionFor(acct: AccountRow): Promise<CalendarSession | null> {
    const own = await sync
      .withSession(acct.id, async (s) => s.calendar?.() ?? null)
      .catch((error) => {
        log(`calendar session for ${acct.id}: ${error instanceof Error ? error.message : error}`);
        return null;
      });
    if (own) return own;
    const creds = await credentials.load(acct.id).catch(() => null);
    if (!creds?.caldav) return null;
    let pending = caldavSessions.get(acct.id);
    if (!pending) {
      const link = creds.caldav;
      pending = caldavFactory({ ...link, address: acct.address });
      caldavSessions.set(acct.id, pending);
      pending.catch(() => caldavSessions.delete(acct.id));
    }
    return pending;
  }

  async function infoFor(acct: AccountRow): Promise<CalendarInfo> {
    const s = await sessionFor(acct);
    return s ? s.info() : LOCAL_INFO;
  }

  /* ------------------------------ Calendars ------------------------------ */

  async function upsertCalendar(
    workspaceId: string,
    input: {
      source: CalendarSource;
      providerId: string;
      name: string;
      primary: boolean;
      writable: boolean;
      color: string | null;
    },
  ): Promise<CalendarRow> {
    const existing = await db.query.calendars.findFirst({
      where: and(
        eq(calendars.workspaceId, workspaceId),
        eq(calendars.providerId, input.providerId),
      ),
    });
    if (existing) {
      const changed =
        existing.name !== input.name ||
        existing.primary !== input.primary ||
        existing.writable !== input.writable ||
        existing.color !== input.color ||
        existing.source !== input.source;
      if (!changed) return existing;
      const [row] = await db
        .update(calendars)
        .set({
          name: input.name,
          primary: input.primary,
          writable: input.writable,
          color: input.color,
          source: input.source,
        })
        .where(eq(calendars.id, existing.id))
        .returning();
      if (!row) throw new Error("calendar update returned no row");
      await recordCalendar(row);
      return row;
    }
    const [row] = await db
      .insert(calendars)
      .values({ id: crypto.randomUUID(), workspaceId, ...input })
      .returning();
    if (!row) throw new Error("calendar insert returned no row");
    await recordCalendar(row);
    return row;
  }

  async function recordCalendar(row: CalendarRow): Promise<void> {
    await mailstore.recordChange(db, {
      workspaceId: row.workspaceId,
      kind: "calendar",
      entityId: row.id,
      payload: projectCalendar(row),
    });
  }

  /** The Local calendar row of a Workspace, made on first use. */
  async function localCalendar(acct: AccountRow): Promise<CalendarRow> {
    return upsertCalendar(acct.workspaceId, {
      source: "local",
      providerId: LOCAL_CALENDAR_ID,
      name: acct.address,
      primary: true,
      writable: true,
      color: null,
    });
  }

  async function calendarRows(workspaceId: string): Promise<CalendarRow[]> {
    return db
      .select()
      .from(calendars)
      .where(eq(calendars.workspaceId, workspaceId))
      .orderBy(asc(calendars.createdAt));
  }

  async function requireCalendar(calendarId: string): Promise<CalendarRow> {
    const row = await db.query.calendars.findFirst({ where: eq(calendars.id, calendarId) });
    if (!row) throw new NotFoundError("calendar", calendarId);
    return row;
  }

  /** The calendar a new Event lands on: the one asked for, else the primary writable one. */
  async function targetCalendar(acct: AccountRow, calendarId: string | null | undefined) {
    if (calendarId) {
      const row = await requireCalendar(calendarId);
      if (row.workspaceId !== acct.workspaceId) throw new NotFoundError("calendar", calendarId);
      if (!row.writable) throw new CalendarUnavailableError("that calendar is read-only");
      return row;
    }
    const rows = await calendarRows(acct.workspaceId);
    const writable = rows.filter((r) => r.writable);
    const primary = writable.find((r) => r.primary) ?? writable[0];
    if (primary) return primary;
    const s = await sessionFor(acct);
    if (!s) return localCalendar(acct);
    // The first pass has not run yet: list once so the primary exists.
    await syncCalendarList(acct, s);
    const again = (await calendarRows(acct.workspaceId)).filter((r) => r.writable);
    const found = again.find((r) => r.primary) ?? again[0];
    if (!found) throw new CalendarUnavailableError("the Account has no writable calendar");
    return found;
  }

  async function syncCalendarList(acct: AccountRow, s: CalendarSession): Promise<CalendarRow[]> {
    const listed = await s.listCalendars();
    const source = s.info().source;
    const out: CalendarRow[] = [];
    for (const c of listed) {
      out.push(
        await upsertCalendar(acct.workspaceId, {
          source,
          providerId: c.id,
          name: c.name,
          primary: c.primary,
          writable: c.writable,
          color: c.color,
        }),
      );
    }
    // Calendars the Provider no longer lists go, with their Events.
    const keep = new Set(out.map((c) => c.providerId));
    const stale = (await calendarRows(acct.workspaceId)).filter(
      (r) => r.source === source && !keep.has(r.providerId),
    );
    for (const r of stale) {
      const gone = await db.select().from(events).where(eq(events.calendarId, r.id));
      await db.delete(calendars).where(eq(calendars.id, r.id));
      for (const e of gone) await recordEvent({ ...e, deleted: true });
      await mailstore.recordChange(db, {
        workspaceId: r.workspaceId,
        kind: "calendar",
        entityId: r.id,
        payload: { ...projectCalendar(r), deleted: true },
      });
    }
    return out;
  }

  /* ------------------------------ Events ------------------------------ */

  async function readContent(row: EventRow): Promise<Content> {
    const text = await mailstore.readText({
      workspaceId: row.workspaceId,
      kind: "event",
      key: row.contentKey,
      chunks: [row.contentEnc],
      size: -1,
    });
    return JSON.parse(text) as Content;
  }

  async function projectEvent(row: EventRow, content?: Content): Promise<CalendarEvent> {
    const c = content ?? (await readContent(row));
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      calendarId: row.calendarId,
      providerId: row.providerId,
      uid: row.uid,
      title: c.title,
      description: c.description,
      location: c.location,
      start: row.start.toISOString(),
      end: row.end.toISOString(),
      allDay: row.allDay,
      timeZone: row.timeZone,
      organizer: row.organizer ?? null,
      attendees: row.attendees,
      link: row.link,
      status: row.status,
      recurrence: row.recurrence,
      recurringEventId: row.recurringEventId,
      response: row.response ?? null,
      createdByAgent: row.createdByAgent,
      etag: row.etag,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function recordEvent(row: EventRow): Promise<void> {
    await mailstore.recordChange(db, {
      workspaceId: row.workspaceId,
      kind: "event",
      entityId: row.id,
      payload: eventChangeOf(row),
    });
  }

  async function requireEvent(eventId: string): Promise<EventRow> {
    const row = await db.query.events.findFirst({ where: eq(events.id, eventId) });
    if (!row || row.deleted) throw new NotFoundError("event", eventId);
    return row;
  }

  /**
   * Writes what a Provider (or the Local calendar) holds for an Event: the
   * content under a fresh envelope, everything else in the clear, one feed
   * row. Keys on (calendar, provider id); an Invite with the same UID is
   * linked to it.
   */
  async function applyProviderEvent(
    calendar: CalendarRow,
    ev: ProviderEvent,
    extra: { createdByAgent?: boolean; sequence?: number } = {},
  ): Promise<EventRow> {
    const content: Content = {
      title: ev.title,
      description: ev.description,
      location: ev.location,
    };
    const ref = await mailstore.storeContent(calendar.workspaceId, "event", stringify(content));
    const envelope = ref.chunks[0];
    if (!envelope) throw new RangeError("event envelope missing");
    const existing = await db.query.events.findFirst({
      where: and(eq(events.calendarId, calendar.id), eq(events.providerId, ev.id)),
    });
    const values = {
      uid: ev.uid,
      contentEnc: envelope,
      contentKey: ref.key,
      titleSearch: subjectSearchOf(ev.title),
      start: new Date(ev.start),
      end: new Date(ev.end),
      allDay: ev.allDay,
      timeZone: ev.timeZone,
      organizer: ev.organizer,
      attendees: ev.attendees,
      link: ev.link,
      status: ev.status,
      recurrence: ev.recurrence,
      recurringEventId: ev.recurringEventId,
      response: ev.response,
      etag: ev.etag,
      deleted: false,
      stale: false,
      updatedAt: new Date(ev.updatedAt),
      ...(extra.sequence !== undefined ? { sequence: extra.sequence } : {}),
    };
    let row: EventRow | undefined;
    if (existing) {
      [row] = await db
        .update(events)
        .set({
          ...values,
          createdByAgent: extra.createdByAgent ?? existing.createdByAgent,
        })
        .where(eq(events.id, existing.id))
        .returning();
    } else {
      [row] = await db
        .insert(events)
        .values({
          id: crypto.randomUUID(),
          workspaceId: calendar.workspaceId,
          calendarId: calendar.id,
          providerId: ev.id,
          createdByAgent: extra.createdByAgent ?? false,
          ...values,
        })
        .returning();
    }
    if (!row) throw new Error("event write returned no row");
    await recordEvent(row);
    if (row.uid) await linkInvites(row);
    return row;
  }

  /** Invites carrying the Event's UID point at it; the answer on the Event is theirs too. */
  async function linkInvites(row: EventRow): Promise<void> {
    if (!row.uid) return;
    const rows = await db
      .select()
      .from(invites)
      .where(and(eq(invites.workspaceId, row.workspaceId), eq(invites.uid, row.uid)));
    for (const inv of rows) {
      const response = row.response ?? inv.response;
      if (inv.eventId === row.id && inv.response === response) continue;
      const [updated] = await db
        .update(invites)
        .set({ eventId: row.id, response })
        .where(eq(invites.id, inv.id))
        .returning();
      if (updated) await recordInvite(updated);
    }
  }

  async function markDeleted(row: EventRow): Promise<void> {
    const [updated] = await db
      .update(events)
      .set({ deleted: true, updatedAt: now() })
      .where(eq(events.id, row.id))
      .returning();
    if (updated) await recordEvent(updated);
  }

  /* ------------------------------ Invites ------------------------------ */

  async function recordInvite(row: InviteRow): Promise<void> {
    await mailstore.recordChange(db, {
      workspaceId: row.workspaceId,
      kind: "invite",
      entityId: row.id,
      payload: inviteChangeOf(row),
    });
  }

  async function projectInvite(row: InviteRow): Promise<Invite> {
    const title = await mailstore.readText({
      workspaceId: row.workspaceId,
      kind: "event",
      key: row.titleKey,
      chunks: [row.titleEnc],
      size: -1,
    });
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      messageId: row.messageId,
      threadId: row.threadId,
      eventId: row.eventId,
      method: row.method,
      uid: row.uid,
      sequence: row.sequence,
      title,
      start: row.start.toISOString(),
      end: row.end.toISOString(),
      allDay: row.allDay,
      organizer: row.organizer ?? null,
      attendees: row.attendees,
      response: row.response,
      byMail: row.byMail,
      senderMismatch: row.senderMismatch,
      receivedAt: row.receivedAt.toISOString(),
    };
  }

  async function inviteIcal(row: InviteRow): Promise<string> {
    return mailstore.readText({
      workspaceId: row.workspaceId,
      kind: "event",
      key: row.icalKey,
      chunks: [row.icalEnc],
      size: -1,
    });
  }

  /* ------------------------------ iMIP ------------------------------ */

  function toWrite(row: EventRow, content: Content, sequence: number): EventToWrite {
    return {
      uid: row.uid ?? `${row.id}@monday`,
      sequence,
      stamp: now(),
      title: content.title,
      description: content.description,
      location: content.location,
      start: row.start,
      end: row.end,
      allDay: row.allDay,
      zone: row.timeZone,
      organizer: row.organizer ?? null,
      attendees: row.attendees,
      status: row.status,
      recurrence: row.recurrence,
      link: row.link,
    };
  }

  /** Mails an iTIP part over the Account's own Session: the only path on a Local calendar. */
  async function mailItip(
    acct: AccountRow,
    to: Person[],
    subject: string,
    text: string,
    method: "REQUEST" | "REPLY" | "CANCEL",
    ical: string,
  ): Promise<void> {
    if (to.length === 0) return;
    const mime = await composeMime({
      from: { name: acct.displayName, email: acct.address },
      to,
      subject,
      text,
      messageId: `${crypto.randomUUID()}@monday`,
      date: now(),
      icalEvent: { method, content: ical },
    });
    await sync.withSession(acct.id, (s) => s.send(mime, { to: to.map((p) => p.email) }));
  }

  function whenLine(row: EventRow): string {
    return row.allDay
      ? row.start.toISOString().slice(0, 10)
      : `${row.start.toISOString().replace("T", " ").slice(0, 16)} to ${row.end.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }

  /* ------------------------------ Meeting links ------------------------------ */

  async function resolveLink(
    acct: AccountRow,
    info: CalendarInfo,
    wanted: MeetingLinkKind | undefined,
    customLink: string | null | undefined,
  ): Promise<{ meetingLink: MeetingLinkKind; customLink: string | null }> {
    const settings = await readSettings();
    const chosen: MeetingLinkSetting =
      wanted ?? settings.meetingLinks[acct.address] ?? settings.meetingLink ?? "provider";
    const kind: MeetingLinkKind = chosen === "provider" ? info.defaultMeetingLink : chosen;
    if (kind === "none") return { meetingLink: "none", customLink: null };
    if (kind === "jitsi") {
      return {
        meetingLink: "custom",
        customLink: customLink || `https://meet.jit.si/${jitsiRoom()}`,
      };
    }
    if (kind === "custom") {
      const url = customLink || settings.customLink;
      return url
        ? { meetingLink: "custom", customLink: url }
        : { meetingLink: "none", customLink: null };
    }
    if (info.meetingLinks.includes(kind)) return { meetingLink: kind, customLink: null };
    // The Provider cannot mint that kind: fall back to no link rather than guess.
    return { meetingLink: "none", customLink: null };
  }

  /* ------------------------------ Sync ------------------------------ */

  async function syncCalendarEvents(
    s: CalendarSession,
    calendar: CalendarRow,
    report: CalendarSyncReport,
  ): Promise<void> {
    const settings = await readSettings();
    const at = now();
    const window = {
      from: new Date(at.getTime() - settings.windowPastDays * 86_400_000).toISOString(),
      to: new Date(at.getTime() + settings.windowFutureDays * 86_400_000).toISOString(),
    };
    let state = calendar.syncToken;
    let reset = false;
    for (;;) {
      let complete = true;
      for await (const ev of s.syncEvents(calendar.providerId, state, window)) {
        switch (ev.type) {
          case "reset":
            reset = true;
            await db
              .update(events)
              .set({ stale: true })
              .where(and(eq(events.calendarId, calendar.id), eq(events.deleted, false)));
            break;
          case "upserted":
            await applyProviderEvent(calendar, ev.event);
            report.upserted += 1;
            break;
          case "removed": {
            const row = await db.query.events.findFirst({
              where: and(eq(events.calendarId, calendar.id), eq(events.providerId, ev.id)),
            });
            if (row && !row.deleted) {
              await markDeleted(row);
              report.removed += 1;
            }
            break;
          }
          case "state":
            state = ev.state;
            complete = ev.complete;
            await db
              .update(calendars)
              .set({ syncToken: ev.state })
              .where(eq(calendars.id, calendar.id));
            break;
        }
      }
      if (complete) break;
    }
    if (reset) {
      const gone = await db
        .select()
        .from(events)
        .where(and(eq(events.calendarId, calendar.id), eq(events.stale, true)));
      for (const row of gone) {
        await markDeleted(row);
        report.removed += 1;
      }
    }
    await db
      .update(calendars)
      .set({ lastSync: now(), lastError: null })
      .where(eq(calendars.id, calendar.id));
  }

  async function enqueueSync(accountId: string): Promise<void> {
    if (!jobsRef) return;
    await jobsRef.enqueue(
      CALENDAR_SYNC_STEP,
      { accountId },
      { id: `${CALENDAR_SYNC_STEP}:${accountId}:wake:${Math.floor(now().getTime() / 5_000)}` },
    );
  }

  /* ------------------------------ Webhooks ------------------------------ */

  async function registerWebhooks(acct: AccountRow): Promise<{ sleepMs: number }> {
    const base = await publicUrl();
    if (!base) return { sleepMs: NO_PUBLIC_URL_SLEEP_MS };
    const s = await sessionFor(acct);
    if (!s?.subscribe || !s.info().push) return { sleepMs: NO_PUBLIC_URL_SLEEP_MS };
    let soonest = Number.POSITIVE_INFINITY;
    for (const calendar of await calendarRows(acct.workspaceId)) {
      if (calendar.source === "local") continue;
      const current = calendar.subscription;
      const remaining = current ? Date.parse(current.expiresAt) - now().getTime() : 0;
      if (current && remaining > RENEW_MARGIN_MS) {
        soonest = Math.min(soonest, remaining - RENEW_MARGIN_MS);
        continue;
      }
      const token = crypto.randomUUID();
      try {
        const registered = await s.subscribe(
          calendar.providerId,
          `${base}/webhooks/calendar/${encodeURIComponent(acct.id)}?token=${token}`,
          token,
        );
        await db
          .update(calendars)
          .set({
            subscription: {
              id: registered.id,
              token,
              expiresAt: registered.expiresAt,
              registeredBy: serverId,
            },
          })
          .where(eq(calendars.id, calendar.id));
        soonest = Math.min(
          soonest,
          Math.max(60_000, Date.parse(registered.expiresAt) - now().getTime() - RENEW_MARGIN_MS),
        );
      } catch (error) {
        log(
          `calendar webhook for ${acct.id}/${calendar.providerId}: ${error instanceof Error ? error.message : error}`,
        );
        soonest = Math.min(soonest, NO_PUBLIC_URL_SLEEP_MS);
      }
    }
    return { sleepMs: Number.isFinite(soonest) ? soonest : NO_PUBLIC_URL_SLEEP_MS };
  }

  /* ------------------------------ The module ------------------------------ */

  const module: CalendarModule = {
    async info(workspaceId) {
      return infoFor(await accountOfWorkspace(workspaceId));
    },

    async listCalendars(workspaceId) {
      const acct = await accountOfWorkspace(workspaceId);
      let rows = await calendarRows(workspaceId);
      if (rows.length === 0) {
        const s = await sessionFor(acct);
        rows = s ? await syncCalendarList(acct, s) : [await localCalendar(acct)];
      }
      return rows.map(projectCalendar);
    },

    async setCalendarVisible(calendarId, visible) {
      const [row] = await db
        .update(calendars)
        .set({ visible })
        .where(eq(calendars.id, calendarId))
        .returning();
      if (!row) throw new NotFoundError("calendar", calendarId);
      await recordCalendar(row);
      return projectCalendar(row);
    },

    async linkCalDav(accountId, link) {
      const acct = await account(accountId);
      const creds = await credentials.load(accountId);
      const pending = caldavSessions.get(accountId);
      caldavSessions.delete(accountId);
      if (pending) await pending.then((s) => s.close()).catch(() => {});
      if (link) {
        // Prove the link before storing it.
        const probe = await caldavFactory({ ...link, address: acct.address });
        await probe.listCalendars();
        await probe.close();
      }
      await credentials.store(acct.workspaceId, accountId, { ...creds, caldav: link });
      // Calendars of the old source go; the next sync lists the new ones.
      const old = (await calendarRows(acct.workspaceId)).filter((r) =>
        link ? r.source === "local" || r.source === "caldav" : r.source === "caldav",
      );
      for (const r of old) {
        const gone = await db.select().from(events).where(eq(events.calendarId, r.id));
        await db.delete(calendars).where(eq(calendars.id, r.id));
        for (const e of gone) await recordEvent({ ...e, deleted: true });
        await mailstore.recordChange(db, {
          workspaceId: r.workspaceId,
          kind: "calendar",
          entityId: r.id,
          payload: { ...projectCalendar(r), deleted: true },
        });
      }
      await enqueueSync(accountId);
      return infoFor(acct);
    },

    async listEvents(workspaceId, opts) {
      const conditions = [
        eq(events.workspaceId, workspaceId),
        eq(events.deleted, false),
        lt(events.start, new Date(opts.to)),
        gt(events.end, new Date(opts.from)),
      ];
      if (opts.calendarIds && opts.calendarIds.length > 0) {
        conditions.push(inArray(events.calendarId, opts.calendarIds));
      }
      if (!opts.includeCancelled) conditions.push(sql`${events.status} <> 'cancelled'`);
      const visible = new Set(
        (await calendarRows(workspaceId)).filter((c) => c.visible).map((c) => c.id),
      );
      // Recurring masters are kept regardless of their own dates: the client expands them.
      const rows = await db
        .select()
        .from(events)
        .where(
          or(
            and(...conditions),
            and(
              eq(events.workspaceId, workspaceId),
              eq(events.deleted, false),
              isNotNull(events.recurrence),
              lt(events.start, new Date(opts.to)),
            ),
          ),
        )
        .orderBy(asc(events.start));
      const out: CalendarEvent[] = [];
      for (const row of rows) {
        if (
          opts.calendarIds
            ? !opts.calendarIds.includes(row.calendarId)
            : !visible.has(row.calendarId)
        )
          continue;
        out.push(await projectEvent(row));
      }
      return out;
    },

    async readEvent(eventId) {
      const row = await db.query.events.findFirst({ where: eq(events.id, eventId) });
      return row && !row.deleted ? projectEvent(row) : null;
    },

    async eventsContent(workspaceId, ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .select()
        .from(events)
        .where(and(eq(events.workspaceId, workspaceId), inArray(events.id, [...ids])));
      const out: EventContent[] = [];
      for (const row of rows) out.push({ id: row.id, ...(await readContent(row)) });
      return out;
    },

    async createEvent(workspaceId, input, opts = {}) {
      const acct = await accountOfWorkspace(workspaceId);
      const info = await infoFor(acct);
      const calendar = await targetCalendar(acct, input.calendarId);
      const link = await resolveLink(acct, info, input.meetingLink, input.customLink);
      const organizer: Person = { name: acct.displayName, email: acct.address };
      const attendees = (input.attendees ?? []).filter(
        (p) => p.email.toLowerCase() !== acct.address.toLowerCase(),
      );
      const create: CreateEventInput = {
        ...input,
        organizer,
        meetingLink: link.meetingLink,
        customLink: link.customLink,
        attendees,
      };
      const s = await sessionFor(acct);
      if (s && calendar.source !== "local") {
        const made = await s.createEvent(calendar.providerId, create);
        const row = await applyProviderEvent(calendar, made, {
          createdByAgent: opts.byAgent ?? false,
        });
        if (!info.providerSendsInvites) await mailRequest(acct, row);
        return projectEvent(row);
      }
      const id = crypto.randomUUID();
      const ev: ProviderEvent = {
        id,
        calendarId: calendar.providerId,
        uid: `${id}@monday`,
        title: create.title,
        description: create.description ?? "",
        location: create.location ?? "",
        start: create.start,
        end: create.end,
        allDay: create.allDay ?? false,
        timeZone: create.timeZone ?? null,
        organizer,
        attendees: [
          { ...organizer, response: "accepted", self: true, organizer: true },
          ...attendees.map((p) => ({ ...p, response: "needs-action" as const })),
        ],
        link: link.customLink,
        status: "confirmed",
        recurrence: create.recurrence ?? null,
        recurringEventId: null,
        response: "accepted",
        etag: null,
        updatedAt: now().toISOString(),
      };
      const row = await applyProviderEvent(calendar, ev, {
        createdByAgent: opts.byAgent ?? false,
        sequence: 0,
      });
      await mailRequest(acct, row);
      return projectEvent(row);
    },

    async updateEvent(eventId, patch) {
      const row = await requireEvent(eventId);
      const calendar = await requireCalendar(row.calendarId);
      const acct = await accountOfWorkspace(row.workspaceId);
      const info = await infoFor(acct);
      const s = await sessionFor(acct);
      const link =
        patch.meetingLink !== undefined || patch.customLink !== undefined
          ? await resolveLink(acct, info, patch.meetingLink, patch.customLink)
          : null;
      if (s && calendar.source !== "local") {
        const made = await s.updateEvent(
          calendar.providerId,
          row.providerId,
          {
            ...patch,
            ...(patch.attendees
              ? {
                  attendees: patch.attendees.filter(
                    (p) => p.email.toLowerCase() !== acct.address.toLowerCase(),
                  ),
                }
              : {}),
            ...(link ?? {}),
          },
          row.etag,
        );
        const updated = await applyProviderEvent(calendar, made);
        if (!info.providerSendsInvites) await mailRequest(acct, updated);
        return projectEvent(updated);
      }
      const content = await readContent(row);
      const organizer: Person = { name: acct.displayName, email: acct.address };
      const ev: ProviderEvent = {
        id: row.providerId,
        calendarId: calendar.providerId,
        uid: row.uid,
        title: patch.title ?? content.title,
        description: patch.description ?? content.description,
        location: patch.location ?? content.location,
        start: patch.start ?? row.start.toISOString(),
        end: patch.end ?? row.end.toISOString(),
        allDay: patch.allDay ?? row.allDay,
        timeZone: patch.timeZone === undefined ? row.timeZone : patch.timeZone,
        organizer: row.organizer ?? organizer,
        attendees: patch.attendees
          ? [
              ...row.attendees.filter((a) => a.self || a.email === acct.address.toLowerCase()),
              ...patch.attendees
                .filter((p) => p.email.toLowerCase() !== acct.address.toLowerCase())
                .map((p) => ({
                  ...p,
                  response:
                    row.attendees.find((a) => a.email === p.email)?.response ?? "needs-action",
                })),
            ]
          : row.attendees,
        link: link ? link.customLink : row.link,
        status: row.status,
        recurrence: patch.recurrence === undefined ? row.recurrence : patch.recurrence,
        recurringEventId: row.recurringEventId,
        response: row.response,
        etag: null,
        updatedAt: now().toISOString(),
      };
      const timesChanged = ev.start !== row.start.toISOString() || ev.end !== row.end.toISOString();
      const updated = await applyProviderEvent(calendar, ev, {
        sequence: timesChanged ? row.sequence + 1 : row.sequence,
      });
      await mailRequest(acct, updated);
      return projectEvent(updated);
    },

    async deleteEvent(eventId) {
      const row = await requireEvent(eventId);
      const calendar = await requireCalendar(row.calendarId);
      const acct = await accountOfWorkspace(row.workspaceId);
      const info = await infoFor(acct);
      const s = await sessionFor(acct);
      if (s && calendar.source !== "local") {
        await s.deleteEvent(calendar.providerId, row.providerId);
        await markDeleted(row);
        if (!info.providerSendsInvites) await mailCancel(acct, row);
        return;
      }
      await markDeleted(row);
      await mailCancel(acct, row);
    },

    async respond(eventId, response) {
      const row = await requireEvent(eventId);
      return projectEvent(await respondRow(row, response));
    },

    async applyInviteIntent(intent) {
      const row = await db.query.invites.findFirst({ where: eq(invites.id, intent.inviteId) });
      if (!row) throw new NotFoundError("invite", intent.inviteId);
      const last = row.writes.rsvp ?? null;
      const resolution = resolveWrite({ at: intent.at, actor: intent.actor }, last);
      if (!resolution.wins) {
        await db.insert(activity).values({
          id: crypto.randomUUID(),
          workspaceId: row.workspaceId,
          actor: intent.actor,
          tool: "invite.rsvp",
          summary: `${intent.response} on invite ${row.id} not applied: ${resolution.reason}`,
          at: new Date(intent.at),
        });
        return { applied: false, reason: resolution.reason };
      }
      const [updated] = await db
        .update(invites)
        .set({
          response: intent.response,
          writes: { ...row.writes, rsvp: { at: intent.at, by: intent.actor } },
        })
        .where(eq(invites.id, row.id))
        .returning();
      if (updated) await recordInvite(updated);
      const event = row.eventId
        ? await db.query.events.findFirst({ where: eq(events.id, row.eventId) })
        : await db.query.events.findFirst({
            where: and(
              eq(events.workspaceId, row.workspaceId),
              eq(events.uid, row.uid),
              eq(events.deleted, false),
            ),
          });
      if (event && !event.deleted) {
        await respondRow(event, intent.response);
      } else if (updated) {
        // No Event on any calendar (a mail-only Account before the Invite was placed): answer by mail.
        await replyByMail(updated, intent.response);
      }
      return { applied: true };
    },

    async readInvite(inviteId) {
      const row = await db.query.invites.findFirst({ where: eq(invites.id, inviteId) });
      return row ? projectInvite(row) : null;
    },

    async invitesOfThread(threadId) {
      const rows = await db
        .select()
        .from(invites)
        .where(eq(invites.threadId, threadId))
        .orderBy(asc(invites.receivedAt));
      const out: Invite[] = [];
      for (const row of rows) out.push(await projectInvite(row));
      return out;
    },

    async busy(workspaceId, from, to) {
      const rows = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.workspaceId, workspaceId),
            eq(events.deleted, false),
            sql`${events.status} <> 'cancelled'`,
            lt(events.start, new Date(to)),
            gt(events.end, new Date(from)),
          ),
        )
        .orderBy(asc(events.start));
      const out: BusySlot[] = [];
      for (const row of rows) {
        if (row.response === "declined") continue;
        let title = row.titleSearch;
        try {
          title = (await readContent(row)).title;
        } catch {
          // Locked: the search prefix stands in.
        }
        out.push({
          eventId: row.id,
          start: row.start.toISOString(),
          end: row.end.toISOString(),
          title,
        });
      }
      return out;
    },

    async observeBody(acct, messageId, threadId, raw) {
      try {
        const part = raw.attachments.find(
          (a) =>
            a.mediaType.toLowerCase().startsWith("text/calendar") ||
            a.mediaType.toLowerCase() === "application/ics" ||
            a.name.toLowerCase().endsWith(".ics"),
        );
        if (!part) return;
        const chunks: Uint8Array[] = [];
        for await (const chunk of part.content()) chunks.push(chunk);
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const text = new TextDecoder().decode(bytes);
        const parsed = parseICalendar(text);
        const event = parsed.events[0];
        if (!event || !parsed.method) return;
        const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
        const from = emailOfHeader(raw.headers.from) ?? message?.from.email.toLowerCase() ?? null;
        if (parsed.method === "REPLY") {
          await applyReply(acct, event, from);
          return;
        }
        if (parsed.method === "PUBLISH") return;
        await applyRequest(
          acct,
          messageId,
          threadId,
          parsed.method,
          event,
          text,
          from,
          message?.date ?? now(),
        );
      } catch (error) {
        log(`invite in ${messageId}: ${error instanceof Error ? error.message : error}`);
      }
    },

    async syncAccount(accountId) {
      const acct = await account(accountId);
      const report: CalendarSyncReport = { accountId, calendars: 0, upserted: 0, removed: 0 };
      const s = await sessionFor(acct);
      if (!s) {
        await localCalendar(acct);
        report.calendars = 1;
        return report;
      }
      const list = await syncCalendarList(acct, s);
      report.calendars = list.length;
      for (const calendar of list) {
        try {
          await syncCalendarEvents(s, calendar, report);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`calendar sync ${acct.id}/${calendar.providerId}: ${message}`);
          await db
            .update(calendars)
            .set({ lastError: message })
            .where(eq(calendars.id, calendar.id));
          if ((error as ProviderError).code === "auth") throw error;
        }
      }
      return report;
    },

    async webhook(accountId, token) {
      if (!token) return false;
      const acct = await account(accountId).catch(() => null);
      if (!acct) return false;
      const rows = await calendarRows(acct.workspaceId);
      if (!rows.some((r) => r.subscription && timingSafeEqual(r.subscription.token, token))) {
        return false;
      }
      await enqueueSync(accountId);
      return true;
    },

    registerSteps(jobs) {
      jobsRef = jobs;
      jobs.registerStep<{ accountId: string }>(CALENDAR_SYNC_STEP, async (job) => {
        await module.syncAccount(job.payload.accountId);
        if (job.id.includes(":wake:")) return "done";
        const settings = await readSettings();
        return { sleepMs: settings.pollMinutes * 60_000 };
      });
      jobs.registerStep<{ accountId: string }>(CALENDAR_WATCH_STEP, async (job) => {
        const acct = await account(job.payload.accountId);
        return registerWebhooks(acct);
      });
    },

    async startAccount(jobs, accountId) {
      const payload = { accountId };
      await jobs.enqueue(CALENDAR_SYNC_STEP, payload, { id: `${CALENDAR_SYNC_STEP}:${accountId}` });
      await jobs.enqueue(CALENDAR_WATCH_STEP, payload, {
        id: `${CALENDAR_WATCH_STEP}:${accountId}`,
        needs: ["needs-public-url"],
      });
    },

    async close() {
      for (const [id, pending] of caldavSessions) {
        caldavSessions.delete(id);
        await pending.then((s) => s.close()).catch(() => {});
      }
    },
  };

  /* ------------------------------ Helpers that need the module ------------------------------ */

  /** The REQUEST monday mails for an Event it organizes where the Provider will not. */
  async function mailRequest(acct: AccountRow, row: EventRow): Promise<void> {
    const others = row.attendees.filter(
      (a) => !a.self && a.email.toLowerCase() !== acct.address.toLowerCase(),
    );
    if (others.length === 0) return;
    const content = await readContent(row);
    const ical = writeICalendar(toWrite(row, content, row.sequence), "REQUEST");
    await mailItip(
      acct,
      others.map((a) => ({ name: a.name, email: a.email })),
      `Invitation: ${content.title}`,
      `${acct.displayName || acct.address} invited you to "${content.title}"\n${whenLine(row)}${row.link ? `\n${row.link}` : ""}`,
      "REQUEST",
      ical,
    );
  }

  async function mailCancel(acct: AccountRow, row: EventRow): Promise<void> {
    const others = row.attendees.filter(
      (a) => !a.self && a.email.toLowerCase() !== acct.address.toLowerCase(),
    );
    if (others.length === 0) return;
    const content = await readContent(row);
    const ical = writeICalendar(
      { ...toWrite(row, content, row.sequence + 1), status: "cancelled" },
      "CANCEL",
    );
    await mailItip(
      acct,
      others.map((a) => ({ name: a.name, email: a.email })),
      `Cancelled: ${content.title}`,
      `"${content.title}" on ${whenLine(row)} was cancelled.`,
      "CANCEL",
      ical,
    );
  }

  /**
   * The Workspace's answer on an Event row. Through the Provider where the
   * Event lives on one (it mails the reply); on the Local calendar the row
   * changes and an iMIP REPLY goes to the organizer.
   */
  async function respondRow(row: EventRow, response: RsvpResponse): Promise<EventRow> {
    const calendar = await requireCalendar(row.calendarId);
    const acct = await accountOfWorkspace(row.workspaceId);
    const info = await infoFor(acct);
    const s = await sessionFor(acct);
    if (s && calendar.source !== "local") {
      const made = await s.rsvp(calendar.providerId, row.providerId, response);
      const updated = await applyProviderEvent(calendar, made);
      if (!info.providerSendsInvites) await replyForRow(acct, updated, response);
      return updated;
    }
    const [updated] = await db
      .update(events)
      .set({
        response,
        attendees: row.attendees.map((a) =>
          a.self || a.email.toLowerCase() === acct.address.toLowerCase() ? { ...a, response } : a,
        ),
        updatedAt: now(),
      })
      .where(eq(events.id, row.id))
      .returning();
    if (!updated) throw new NotFoundError("event", row.id);
    await recordEvent(updated);
    await linkInvites(updated);
    await replyForRow(acct, updated, response);
    return updated;
  }

  async function replyForRow(acct: AccountRow, row: EventRow, response: RsvpResponse) {
    const organizer = row.organizer;
    if (!organizer || organizer.email.toLowerCase() === acct.address.toLowerCase()) return;
    const content = await readContent(row);
    const ical = writeReply(
      toWrite(row, content, row.sequence),
      { name: acct.displayName, email: acct.address },
      response,
      now(),
    );
    await mailItip(
      acct,
      [organizer],
      `${replyWord(response)}: ${content.title}`,
      `${acct.displayName || acct.address} ${replyWord(response).toLowerCase()} "${content.title}" on ${whenLine(row)}.`,
      "REPLY",
      ical,
    );
  }

  /** An RSVP by mail straight from the Invite's own part, when no Event row exists. */
  async function replyByMail(row: InviteRow, response: RsvpResponse) {
    const acct = await accountOfWorkspace(row.workspaceId);
    if (!row.organizer) return;
    const [parsed] = parseICalendar(await inviteIcal(row)).events;
    if (!parsed) return;
    const title = (await projectInvite(row)).title;
    const ical = writeReply(
      {
        uid: parsed.uid,
        sequence: parsed.sequence,
        stamp: now(),
        title,
        description: "",
        location: "",
        start: parsed.start,
        end: parsed.end,
        allDay: parsed.allDay,
        zone: parsed.zone,
        organizer: parsed.organizer,
        attendees: [],
        status: parsed.status,
        recurrence: parsed.recurrence,
        link: null,
        recurrenceId: parsed.recurrenceId,
      },
      { name: acct.displayName, email: acct.address },
      response,
      now(),
    );
    await mailItip(
      acct,
      [row.organizer],
      `${replyWord(response)}: ${title}`,
      `${acct.displayName || acct.address} ${replyWord(response).toLowerCase()} "${title}".`,
      "REPLY",
      ical,
    );
  }

  function replyWord(response: RsvpResponse): string {
    return response === "accepted"
      ? "Accepted"
      : response === "declined"
        ? "Declined"
        : response === "tentative"
          ? "Tentative"
          : "Not answered";
  }

  /** A REQUEST or CANCEL landing in a Message becomes (or updates) an Invite and, where monday keeps the calendar, its Event. */
  async function applyRequest(
    acct: { id: string; workspaceId: string; address: string },
    messageId: string,
    threadId: string,
    method: "REQUEST" | "CANCEL",
    event: ReturnType<typeof parseICalendar>["events"][number],
    text: string,
    from: string | null,
    receivedAt: Date,
  ): Promise<void> {
    const acctRow = await account(acct.id);
    const info = await infoFor(acctRow);
    const s = await sessionFor(acctRow);
    const me = acct.address.toLowerCase();
    const self = event.attendees.find((a) => a.email === me);
    const senderMismatch = !!(from && event.organizer && from !== event.organizer.email);
    const titleRef = await mailstore.storeContent(acct.workspaceId, "event", event.title);
    const icalRef = await mailstore.storeContent(acct.workspaceId, "event", text);
    const titleEnc = titleRef.chunks[0];
    const icalEnc = icalRef.chunks[0];
    if (!titleEnc || !icalEnc) throw new RangeError("invite envelope missing");
    const existingEvent = await db.query.events.findFirst({
      where: and(
        eq(events.workspaceId, acct.workspaceId),
        eq(events.uid, event.uid),
        eq(events.deleted, false),
      ),
    });
    const previous = await db.query.invites.findFirst({
      where: and(eq(invites.workspaceId, acct.workspaceId), eq(invites.uid, event.uid)),
      orderBy: (t, { desc }) => [desc(t.receivedAt)],
    });
    // A higher SEQUENCE means the organizer changed something material: ask again (RFC 5546 2.1.4).
    const askAgain = previous ? event.sequence > previous.sequence : false;
    const response: RsvpResponse =
      method === "CANCEL"
        ? (previous?.response ?? "needs-action")
        : askAgain
          ? "needs-action"
          : (existingEvent?.response ?? previous?.response ?? self?.response ?? "needs-action");
    const values = {
      workspaceId: acct.workspaceId,
      messageId,
      threadId,
      eventId: existingEvent?.id ?? null,
      method,
      uid: event.uid,
      sequence: event.sequence,
      titleEnc,
      titleKey: titleRef.key,
      icalEnc,
      icalKey: icalRef.key,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      organizer: event.organizer,
      attendees: event.attendees.map((a) => (a.email === me ? { ...a, self: true } : a)),
      response,
      byMail: !info.providerSendsInvites,
      senderMismatch,
      receivedAt,
    };
    const [row] = await db
      .insert(invites)
      .values({ id: crypto.randomUUID(), ...values })
      .onConflictDoUpdate({ target: invites.messageId, set: values })
      .returning();
    if (!row) throw new Error("invite write returned no row");
    await recordInvite(row);

    if (method === "CANCEL") {
      if (
        existingEvent &&
        (!s || (await requireCalendar(existingEvent.calendarId)).source === "local")
      ) {
        const [updated] = await db
          .update(events)
          .set({ status: "cancelled", updatedAt: now() })
          .where(eq(events.id, existingEvent.id))
          .returning();
        if (updated) await recordEvent(updated);
      } else if (s) {
        await enqueueSync(acct.id);
      }
      return;
    }
    if (senderMismatch) return; // RFC 6047 2.3: shown with a warning, never acted on.
    if (s && !s.importInvite) {
      // Google and Graph placed it themselves (subject to the user's settings): fetch it.
      await enqueueSync(acct.id);
      return;
    }
    const calendar = s ? await targetCalendar(acctRow, null) : await localCalendar(acctRow);
    if (existingEvent && existingEvent.sequence >= event.sequence && !askAgain) return;
    if (s?.importInvite) {
      const placed = await s.importInvite(calendar.providerId, text);
      await applyProviderEvent(calendar, placed, { sequence: event.sequence });
      return;
    }
    const ev: ProviderEvent = {
      id: existingEvent?.providerId ?? crypto.randomUUID(),
      calendarId: calendar.providerId,
      uid: event.uid,
      title: event.title,
      description: event.description,
      location: event.location,
      start: event.start.toISOString(),
      end: event.end.toISOString(),
      allDay: event.allDay,
      timeZone: event.zone,
      organizer: event.organizer,
      attendees: values.attendees,
      link: event.link,
      status: event.status,
      recurrence: event.recurrence,
      recurringEventId: null,
      response,
      etag: null,
      updatedAt: now().toISOString(),
    };
    await applyProviderEvent(calendar, ev, { sequence: event.sequence });
  }

  /** A REPLY to an Event the Local calendar organizes: the one ATTENDEE's PARTSTAT lands on the row. */
  async function applyReply(
    acct: { id: string; workspaceId: string; address: string },
    event: ReturnType<typeof parseICalendar>["events"][number],
    from: string | null,
  ): Promise<void> {
    const attendee = event.attendees[0];
    if (!attendee) return;
    if (from && from !== attendee.email) return; // RFC 6047 2.3
    const row = await db.query.events.findFirst({
      where: and(
        eq(events.workspaceId, acct.workspaceId),
        eq(events.uid, event.uid),
        eq(events.deleted, false),
      ),
    });
    if (!row) return;
    const calendar = await requireCalendar(row.calendarId);
    if (calendar.source !== "local") return; // The Provider tracks replies itself.
    const [updated] = await db
      .update(events)
      .set({
        attendees: row.attendees.map((a) =>
          a.email === attendee.email ? { ...a, response: attendee.response } : a,
        ),
        updatedAt: now(),
      })
      .where(eq(events.id, row.id))
      .returning();
    if (updated) await recordEvent(updated);
  }

  return module;
}
