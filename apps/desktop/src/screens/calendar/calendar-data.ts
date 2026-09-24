// The seam between the Calendar screen, the Today panel, the invite bar and
// the data under them: calendars, Events and Invites as the Cache holds
// them (the feed keeps them current, the Store warms titles), handed out as
// one stable external store, plus the writes: visibility, Events made,
// changed and removed through the API (a recurring one aimed at one
// instance, it and the later ones, or the series), an Invite's answer
// through the Store's Outbox so it is undoable and works offline. The other
// Accounts' calendars (the calendar.other_accounts Setting) are read through
// the API for the window on screen and join the same lists. The Server
// expands nothing: recurring masters are expanded here with the shared
// expander. fixtureCalendar() is the in-memory implementation for tests and
// the mock.

import type {
  Calendar,
  CalendarEvent,
  CalendarStatus,
  EventInput,
  EventPatch,
  EventWriteOptions,
  Id,
  Invite,
  RsvpResponse,
} from "@monday/shared";
import { expandRecurrence, withExdate } from "@monday/shared";
import type { Api } from "../../platform/api.ts";
import type { Row, Statement, Store } from "../../store/index.ts";

/** One thing on a view: an Event, or one instance of a recurring one. */
export interface Occurrence extends CalendarEvent {
  /** The instance's own key: the Event id, or id plus the instance start for a recurrence. */
  key: string;
  /** The instance's own start when it was expanded here from a master; null otherwise. */
  instanceStart: string | null;
}

/** An Account whose calendars the views show. */
export interface CalendarAccount {
  workspaceId: Id;
  accountId: Id;
  address: string;
  /** The open Workspace; the others are read through the API. */
  current: boolean;
}

export interface CalendarSource {
  /** Every calendar shown: the open Workspace's first, then the other Accounts'. */
  calendars(): readonly Calendar[];
  /** Every Event held, masters included. Stable between changes. */
  events(): readonly CalendarEvent[];
  /** The Accounts the calendars belong to, the open one first. */
  accounts(): readonly CalendarAccount[];
  /** The Invites of a Thread, oldest first. */
  invitesOf(threadId: Id): readonly Invite[];
  subscribe(listener: () => void): () => void;
  setVisible(calendarId: Id, visible: boolean): Promise<void>;
  /** Makes an Event on `input.calendarId`'s Account (the open one when absent). */
  create(input: EventInput): Promise<CalendarEvent>;
  update(eventId: Id, patch: EventPatch, options?: EventWriteOptions): Promise<void>;
  remove(eventId: Id, options?: EventWriteOptions): Promise<void>;
  /** The Workspace's answer on an Event straight from a view (a detail's Yes, No, Maybe). */
  respond(eventId: Id, response: "accepted" | "tentative" | "declined"): Promise<void>;
  /** The invite bar's answer: an Outbox intent. */
  rsvp(inviteId: Id, response: RsvpResponse): Promise<void>;
  /** Whether each Account's calendar can be read, and why not. */
  status(): Promise<CalendarStatus[]>;
  /** Reads an Account's calendar again now ("Try again"). */
  retry(workspaceId: Id): Promise<CalendarStatus>;
  /** The window on screen: the other Accounts' Events around it are fetched and join `events()`. */
  cover(from: Date, to: Date): void;
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
    reminders: json<number[] | null>(r.reminders, null),
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
          instanceStart: o.start.toISOString(),
        });
      }
      continue;
    }
    const s = Date.parse(e.start);
    const en = Date.parse(e.end);
    if (en <= window.from.getTime() || s >= window.to.getTime()) {
      // A zero-length Event at the window's start still shows.
      if (!(s === en && s === window.from.getTime())) continue;
    }
    out.push({ ...e, key: e.id, instanceStart: null });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

/** Whether an occurrence belongs to a series, however the Provider carries it. */
export function isRecurring(o: Pick<CalendarEvent, "recurrence" | "recurringEventId">): boolean {
  return Boolean(o.recurrence || o.recurringEventId);
}

/** The write options that aim at one occurrence; the scope is the caller's. */
export function aimAt(o: Occurrence, scope: EventWriteOptions["scope"]): EventWriteOptions {
  if (!isRecurring(o)) return {};
  return {
    ...(scope ? { scope } : {}),
    ...(o.instanceStart ? { occurrence: o.instanceStart } : {}),
  };
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

/** The Cache row for an Event the API handed back, so the view shows it before the feed does. */
function eventRow(event: CalendarEvent): Statement {
  return {
    sql: `insert into events (id, calendar_id, provider_id, uid, title, description, location, start, "end", all_day,
            time_zone, organizer, attendees, link, status, recurrence, recurring_event_id, response, created_by_agent,
            reminders, content_stale, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          on conflict (id) do update set title = excluded.title, description = excluded.description,
            location = excluded.location, start = excluded.start, "end" = excluded."end",
            all_day = excluded.all_day, time_zone = excluded.time_zone, attendees = excluded.attendees,
            link = excluded.link, recurrence = excluded.recurrence, calendar_id = excluded.calendar_id,
            reminders = excluded.reminders, response = excluded.response, content_stale = 0,
            updated_at = excluded.updated_at`,
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
      event.reminders ?? null,
      event.updatedAt,
    ],
  };
}

export interface StoreCalendarOptions {
  /** The calendar.other_accounts Setting, read at each fetch. */
  otherAccounts?: () => boolean;
}

/** Opens the seam over the Store's live queries; resolves once the three have rows. */
export async function createStoreCalendar(
  store: Store,
  api: Api,
  options: StoreCalendarOptions = {},
): Promise<StoreCalendar> {
  const listeners = new Set<() => void>();
  let own: readonly Calendar[] = [];
  let ownEvents: readonly CalendarEvent[] = [];
  let invites: Map<string, Invite[]> = new Map();
  let accounts: readonly CalendarAccount[] = [];
  /** The other Accounts' calendars and Events, by Workspace. */
  const other = new Map<Id, { calendars: Calendar[]; events: CalendarEvent[] }>();
  let covered: { from: number; to: number } | null = null;
  let calendars: readonly Calendar[] = [];
  let events: readonly CalendarEvent[] = [];
  const merge = () => {
    const theirs = [...other.values()];
    calendars = theirs.length ? [...own, ...theirs.flatMap((o) => o.calendars)] : own;
    events = theirs.length ? [...ownEvents, ...theirs.flatMap((o) => o.events)] : ownEvents;
  };
  const emit = () => {
    merge();
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
      own = rows.map((r) => rowToCalendar(r, store.workspaceId));
    }),
    ready(eventsLive, (rows) => {
      ownEvents = rows.map((r) => rowToEvent(r, store.workspaceId));
    }),
    ready(invitesLive, (rows) => {
      invites = byThread(rows.map((r) => rowToInvite(r, store.workspaceId)));
    }),
  ]);

  const wantOthers = () => options.otherAccounts?.() ?? true;
  let accountsLoaded: Promise<void> | null = null;
  const loadAccounts = () => {
    accountsLoaded ??= api.accounts
      .list()
      .then((r) => {
        const mine = r.accounts.find((a) => a.workspaceId === store.workspaceId);
        accounts = [
          ...(mine
            ? [
                {
                  workspaceId: mine.workspaceId,
                  accountId: mine.id,
                  address: mine.address,
                  current: true,
                },
              ]
            : []),
          ...r.accounts
            .filter((a) => a.workspaceId !== store.workspaceId)
            .map((a) => ({
              workspaceId: a.workspaceId,
              accountId: a.id,
              address: a.address,
              current: false,
            })),
        ];
        emit();
      })
      .catch(() => {
        accountsLoaded = null;
      });
    return accountsLoaded;
  };
  void loadAccounts();

  let fetching = 0;
  const fetchOthers = async (from: number, to: number) => {
    await loadAccounts();
    if (!wantOthers()) {
      // Any fetch still on its way is stale now.
      fetching += 1;
      covered = null;
      if (other.size > 0) {
        other.clear();
        emit();
      }
      return;
    }
    const mine = ++fetching;
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    const results = await Promise.all(
      accounts
        .filter((a) => !a.current)
        .map(async (a) => {
          try {
            const [cals, evs] = await Promise.all([
              api.calendar.calendars(a.workspaceId),
              api.calendar.events(a.workspaceId, fromIso, toIso),
            ]);
            return [a.workspaceId, { calendars: cals, events: evs }] as const;
          } catch {
            // Locked, or that Account's calendar is refusing: its status says why.
            return null;
          }
        }),
    );
    if (mine !== fetching) return;
    other.clear();
    for (const r of results) if (r) other.set(r[0], r[1]);
    covered = { from, to };
    emit();
  };
  const refetchOthers = () => {
    if (covered) void fetchOthers(covered.from, covered.to);
  };
  const workspaceOf = (calendarId: Id | null | undefined): Id => {
    if (!calendarId) return store.workspaceId;
    return calendars.find((c) => c.id === calendarId)?.workspaceId ?? store.workspaceId;
  };
  const eventWorkspace = (eventId: Id): Id =>
    events.find((e) => e.id === eventId)?.workspaceId ?? store.workspaceId;

  return {
    calendars: () => calendars,
    events: () => events,
    accounts: () => accounts,
    invitesOf: (threadId) => invites.get(threadId) ?? NO_INVITES,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setVisible(calendarId, visible) {
      await api.calendar.setVisible(calendarId, visible);
      if (workspaceOf(calendarId) !== store.workspaceId) {
        for (const o of other.values()) {
          o.calendars = o.calendars.map((c) => (c.id === calendarId ? { ...c, visible } : c));
        }
        emit();
        refetchOthers();
        return;
      }
      // The feed row follows; the Cache shows the choice at once.
      await store.write([
        { sql: "update calendars set visible = ? where id = ?", params: [visible, calendarId] },
      ]);
    },
    async create(input) {
      const ws = workspaceOf(input.calendarId);
      const event = await api.calendar.create(ws, input);
      if (ws === store.workspaceId) await store.write([eventRow(event)]);
      else refetchOthers();
      return event;
    },
    async update(eventId, patch, opts = {}) {
      const ws = eventWorkspace(eventId);
      const event = await api.calendar.update(eventId, patch, opts);
      if (ws !== store.workspaceId) {
        refetchOthers();
        return;
      }
      // The Event the Server answers with is the one the change landed on; others follow on the feed.
      if (event.id === eventId || !opts.scope || opts.scope === "this") {
        await store.write([eventRow(event)]);
      }
    },
    async remove(eventId, opts = {}) {
      const ws = eventWorkspace(eventId);
      await api.calendar.remove(eventId, opts);
      if (ws !== store.workspaceId) {
        refetchOthers();
        return;
      }
      const master = ownEvents.find((e) => e.id === eventId);
      if (
        opts.scope === "this" &&
        opts.occurrence &&
        master?.recurrence &&
        !master.recurringEventId
      ) {
        // One instance of a master left out: the master's recurrence gains the exclusion.
        await store.write([
          {
            sql: "update events set recurrence = ? where id = ?",
            params: [withExdate(master.recurrence, new Date(opts.occurrence)), eventId],
          },
        ]);
        return;
      }
      if (opts.scope === "following") return; // The cut master arrives on the feed.
      await store.write([{ sql: "delete from events where id = ?", params: [eventId] }]);
    },
    async respond(eventId, response) {
      const ws = eventWorkspace(eventId);
      await api.calendar.respond(eventId, response);
      if (ws !== store.workspaceId) {
        refetchOthers();
        return;
      }
      await store.write([
        { sql: "update events set response = ? where id = ?", params: [response, eventId] },
      ]);
    },
    async rsvp(inviteId, response) {
      await store.intent({ kind: "invite.rsvp", inviteId, response });
    },
    async status() {
      await loadAccounts();
      const list = accounts.length
        ? accounts.filter((a) => a.current || wantOthers())
        : [{ workspaceId: store.workspaceId }];
      const out = await Promise.all(
        list.map((a) => api.calendar.status(a.workspaceId).catch(() => null)),
      );
      return out.filter((s): s is CalendarStatus => s !== null);
    },
    async retry(workspaceId) {
      const status = await api.calendar.sync(workspaceId);
      if (workspaceId !== store.workspaceId) refetchOthers();
      return status;
    },
    cover(from, to) {
      const f = from.getTime();
      const t = to.getTime();
      if (covered && covered.from <= f && covered.to >= t) return;
      // A margin either side, so stepping a week or a month rarely asks again.
      const margin = 31 * 86_400_000;
      void fetchOthers(f - margin, t + margin);
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
  accounts?: CalendarAccount[];
  statuses?: CalendarStatus[];
  /** A write that should fail, with the message it fails with. */
  fail?: { update?: string; create?: string; remove?: string; respond?: string };
}): CalendarSource & { log: string[] } {
  const listeners = new Set<() => void>();
  let calendars = seed.calendars ?? [];
  let events = seed.events ?? [];
  let invites = seed.invites ?? [];
  let statuses = seed.statuses ?? [];
  const accounts = seed.accounts ?? [];
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
    accounts: () => accounts,
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
      if (seed.fail?.create) throw new Error(seed.fail.create);
      const calendar = calendars.find((c) => c.id === input.calendarId) ?? calendars[0];
      const event: CalendarEvent = {
        id: `ev-${events.length + 1}`,
        workspaceId: calendar?.workspaceId ?? "ws",
        calendarId: input.calendarId ?? calendar?.id ?? "cal",
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
        link: input.meetingLink === "custom" ? (input.customLink ?? null) : null,
        status: "confirmed",
        recurrence: input.recurrence ?? null,
        recurringEventId: null,
        response: "accepted",
        createdByAgent: false,
        etag: null,
        updatedAt: new Date().toISOString(),
        reminders: input.reminders ?? null,
      };
      log.push(`create ${event.title}`);
      events = [...events, event];
      emit();
      return event;
    },
    async update(eventId, patch, opts = {}) {
      if (seed.fail?.update) throw new Error(seed.fail.update);
      const scope = opts.scope ? ` ${opts.scope}` : "";
      const at = opts.occurrence ? ` @${opts.occurrence}` : "";
      const fields = Object.keys(patch).sort().join(",");
      log.push(`update ${eventId}${scope}${at} ${fields}`);
      const clean = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ) as Partial<CalendarEvent>;
      events = events.map((e) => (e.id === eventId ? { ...e, ...clean } : e));
      emit();
    },
    async remove(eventId, opts = {}) {
      if (seed.fail?.remove) throw new Error(seed.fail.remove);
      const scope = opts.scope ? ` ${opts.scope}` : "";
      log.push(`remove ${eventId}${scope}`);
      const master = events.find((e) => e.id === eventId);
      if (opts.scope === "this" && opts.occurrence && master?.recurrence) {
        events = events.map((e) =>
          e.id === eventId
            ? {
                ...e,
                recurrence: withExdate(e.recurrence ?? "", new Date(opts.occurrence as string)),
              }
            : e,
        );
      } else {
        events = events.filter((e) => e.id !== eventId);
      }
      emit();
    },
    async respond(eventId, response) {
      if (seed.fail?.respond) throw new Error(seed.fail.respond);
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
    async status() {
      return statuses;
    },
    async retry(workspaceId) {
      log.push(`retry ${workspaceId}`);
      statuses = statuses.map((s) => (s.workspaceId === workspaceId ? { ...s, problem: null } : s));
      const found = statuses.find((s) => s.workspaceId === workspaceId);
      return (
        found ?? {
          workspaceId,
          accountId: workspaceId,
          source: "local",
          problem: null,
          lastSync: null,
          checkedAt: new Date().toISOString(),
        }
      );
    },
    cover() {},
  };
}
