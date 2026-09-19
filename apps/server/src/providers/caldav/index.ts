// The CalDAV adapter (slice 18; research 6, "CalDAV (RFC 4791) and
// Fastmail"): a CalendarSession over fetch for an Account whose Provider has
// no calendar API but whose user linked a CalDAV calendar. Discovery walks
// current-user-principal to calendar-home-set to the calendars (RFC 6764);
// reads use sync-collection (RFC 6578) with calendar-multiget, falling back
// to a time-range calendar-query on servers without sync tokens; writes are
// PUT with If-None-Match or If-Match and plain DELETE; an RSVP is a PUT of
// the object with the own PARTSTAT changed, which a scheduling server
// (calendar-auto-schedule in the DAV header) turns into the iTIP REPLY
// itself. XML is read with a small tag scanner; nothing here needs a
// namespace-aware parser.

import type { CalendarInfo, RsvpResponse } from "@monday/shared";
import {
  escapeText,
  type ParsedEvent,
  parseICalendar,
  unfold,
  writeICalendar,
} from "../../calendar/ical.ts";
import type { FetchLike } from "../jmap/client.ts";
import {
  type CalendarSession,
  type CalendarSyncEvent,
  type CreateEventInput,
  type EventWindow,
  type ProviderCalendar,
  ProviderError,
  type ProviderEvent,
} from "../types.ts";

export interface CalDavOptions {
  url: string;
  user: string;
  password: string;
  /** The Account's address; the ATTENDEE line that is "self". */
  address: string;
  fetch?: FetchLike;
  now?: () => Date;
}

const PARTSTAT_FOR: Record<RsvpResponse, string> = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
  "needs-action": "NEEDS-ACTION",
};

/* ------------------------------ XML scanning ------------------------------ */

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** The inner text of the first `<ns:name>` element in a fragment, or null. */
export function tagText(fragment: string, name: string): string | null {
  const m = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`,
    "i",
  ).exec(fragment);
  return m ? decodeXml(m[1] ?? "") : null;
}

/** Whether an empty or non-empty `<ns:name>` element appears in a fragment. */
export function hasTag(fragment: string, name: string): boolean {
  return new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?/?>`, "i").test(fragment);
}

/** The `<response>` fragments of a multistatus body. */
export function responsesOf(body: string): string[] {
  const out: string[] = [];
  const re = /<(?:[\w.-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
  for (const m of body.matchAll(re)) out.push(m[1] ?? "");
  return out;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBasic(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/* ------------------------------ The adapter ------------------------------ */

interface CalDavState {
  v: 1;
  syncToken: string | null;
}

export async function createCalDavSession(options: CalDavOptions): Promise<CalendarSession> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const me = options.address.toLowerCase();
  const authorization = `Basic ${btoa(`${options.user}:${options.password}`)}`;

  async function request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: { authorization, ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (error) {
      throw new ProviderError(
        `CalDAV ${init.method} ${url}: ${(error as Error).message}`,
        "network",
        {
          cause: error,
        },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(`CalDAV ${response.status} on ${url}`, "auth");
    }
    if (response.status === 404) throw new ProviderError(`CalDAV 404 on ${url}`, "not-found");
    if (response.status === 412) throw new ProviderError("CalDAV precondition failed", "protocol");
    if (response.status >= 400) {
      throw new ProviderError(`CalDAV ${response.status} on ${url}`, "protocol");
    }
    return response;
  }

  async function propfind(url: string, depth: "0" | "1", props: string): Promise<string> {
    const response = await request(url, {
      method: "PROPFIND",
      headers: { depth, "content-type": "application/xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"><d:prop>${props}</d:prop></d:propfind>`,
    });
    return response.text();
  }

  function resolve(base: string, href: string): string {
    return new URL(href, base).toString();
  }

  /* Discovery */

  let home: string | null = null;
  let calendarUrls = new Map<string, string>();
  let autoSchedule: boolean | null = null;

  async function discoverHome(): Promise<string> {
    if (home) return home;
    let base = options.url.replace(/\/?$/, "/");
    // A calendar collection or home given directly is used as is.
    const direct = await propfind(
      base,
      "0",
      "<d:resourcetype/><c:calendar-home-set/><d:current-user-principal/>",
    ).catch(() => "");
    const [first] = responsesOf(direct);
    if (first && hasTag(tagText(first, "resourcetype") ?? "", "calendar")) {
      home = base;
      return home;
    }
    const homeHref = first ? tagText(tagText(first, "calendar-home-set") ?? "", "href") : null;
    if (homeHref) {
      home = resolve(base, homeHref).replace(/\/?$/, "/");
      return home;
    }
    const principalHref = first
      ? tagText(tagText(first, "current-user-principal") ?? "", "href")
      : null;
    if (principalHref) base = resolve(base, principalHref);
    else {
      // Well-known redirect (RFC 6764 6).
      const wellKnown = new URL("/.well-known/caldav", base).toString();
      const probe = await propfind(wellKnown, "0", "<d:current-user-principal/>").catch(() => "");
      const [p] = responsesOf(probe);
      const href = p ? tagText(tagText(p, "current-user-principal") ?? "", "href") : null;
      if (!href) throw new ProviderError("CalDAV discovery found no principal", "protocol");
      base = resolve(wellKnown, href);
    }
    const principal = await propfind(base, "0", "<c:calendar-home-set/>");
    const [row] = responsesOf(principal);
    const href = row ? tagText(tagText(row, "calendar-home-set") ?? "", "href") : null;
    if (!href) throw new ProviderError("CalDAV principal has no calendar-home-set", "protocol");
    home = resolve(base, href).replace(/\/?$/, "/");
    return home;
  }

  async function capabilities(): Promise<boolean> {
    if (autoSchedule !== null) return autoSchedule;
    const base = await discoverHome();
    const response = await request(base, { method: "OPTIONS" }).catch(() => null);
    const dav = response?.headers.get("dav") ?? "";
    autoSchedule = /calendar-auto-schedule/i.test(dav);
    return autoSchedule;
  }

  /* Objects */

  function eventOf(href: string, etag: string | null, parsed: ParsedEvent): ProviderEvent {
    const self = parsed.attendees.find((a) => a.email === me);
    return {
      id: href,
      calendarId: href.slice(0, href.lastIndexOf("/") + 1),
      uid: parsed.uid,
      title: parsed.title,
      description: parsed.description,
      location: parsed.location,
      start: parsed.start.toISOString(),
      end: parsed.end.toISOString(),
      allDay: parsed.allDay,
      timeZone: parsed.zone,
      organizer: parsed.organizer,
      attendees: parsed.attendees.map((a) => (a.email === me ? { ...a, self: true } : a)),
      link: parsed.link,
      status: parsed.status,
      recurrence: parsed.recurrence,
      recurringEventId: null,
      response: self?.response ?? null,
      etag,
      updatedAt: (parsed.stamp ?? now()).toISOString(),
    };
  }

  async function getObject(href: string): Promise<{ text: string; etag: string | null }> {
    const response = await request(href, { method: "GET", headers: { accept: "text/calendar" } });
    return { text: await response.text(), etag: response.headers.get("etag") };
  }

  async function putObject(
    href: string,
    ical: string,
    precondition: { ifNoneMatch?: true; ifMatch?: string | null },
  ): Promise<string | null> {
    const response = await request(href, {
      method: "PUT",
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        ...(precondition.ifNoneMatch ? { "if-none-match": "*" } : {}),
        ...(precondition.ifMatch ? { "if-schedule-tag-match": precondition.ifMatch } : {}),
      },
      body: ical,
    });
    const etag = response.headers.get("etag");
    if (etag) return etag;
    // Servers that rewrite SCHEDULE-STATUS answer without an ETag: read it back.
    const head = await propfind(href, "0", "<d:getetag/>").catch(() => "");
    const [row] = responsesOf(head);
    return row ? tagText(row, "getetag") : null;
  }

  async function multiget(
    calendarUrl: string,
    hrefs: string[],
  ): Promise<Map<string, { etag: string | null; text: string }>> {
    const out = new Map<string, { etag: string | null; text: string }>();
    for (let i = 0; i < hrefs.length; i += 50) {
      const chunk = hrefs.slice(i, i + 50);
      const response = await request(calendarUrl, {
        method: "REPORT",
        headers: { depth: "1", "content-type": "application/xml; charset=utf-8" },
        body: `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>${chunk.map((h) => `<d:href>${escapeXml(new URL(h).pathname)}</d:href>`).join("")}</c:calendar-multiget>`,
      });
      for (const r of responsesOf(await response.text())) {
        const href = tagText(r, "href");
        const data = tagText(r, "calendar-data");
        if (!href || data === null) continue;
        out.set(resolve(calendarUrl, href), { etag: tagText(r, "getetag"), text: data });
      }
    }
    return out;
  }

  const session: CalendarSession = {
    info(): CalendarInfo {
      return {
        source: "caldav",
        providerSendsInvites: autoSchedule ?? false,
        meetingLinks: ["jitsi", "custom"],
        defaultMeetingLink: "none",
        push: false,
      };
    },

    async listCalendars() {
      const base = await discoverHome();
      await capabilities();
      const body = await propfind(
        base,
        "1",
        "<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><a:calendar-color/><d:current-user-privilege-set/>",
      );
      const out: ProviderCalendar[] = [];
      calendarUrls = new Map();
      for (const r of responsesOf(body)) {
        const href = tagText(r, "href");
        const type = tagText(r, "resourcetype") ?? "";
        if (!href || !hasTag(type, "calendar")) continue;
        const components = tagText(r, "supported-calendar-component-set");
        if (components && !/name="VEVENT"/i.test(components) && !/VEVENT/.test(components))
          continue;
        const url = resolve(base, href).replace(/\/?$/, "/");
        const privileges = tagText(r, "current-user-privilege-set") ?? "";
        const writable = privileges
          ? hasTag(privileges, "write") || hasTag(privileges, "all")
          : true;
        const color = tagText(r, "calendar-color");
        const id = url;
        calendarUrls.set(id, url);
        out.push({
          id,
          name: tagText(r, "displayname") || url.split("/").filter(Boolean).pop() || "Calendar",
          primary: out.length === 0,
          writable,
          color: color ? color.slice(0, 7) : null,
        });
      }
      if (out.length === 0)
        throw new ProviderError("no calendars found at the CalDAV URL", "not-found");
      return out;
    },

    async *syncEvents(
      calendarId: string,
      state: string | null,
      window: EventWindow,
    ): AsyncIterable<CalendarSyncEvent> {
      const calendarUrl = calendarId;
      let stored: CalDavState | null = null;
      try {
        stored = state ? (JSON.parse(state) as CalDavState) : null;
      } catch {
        stored = null;
      }
      const emit = async function* (hrefs: string[]): AsyncIterable<CalendarSyncEvent> {
        const objects = await multiget(calendarUrl, hrefs);
        for (const [href, { etag, text }] of objects) {
          const [parsed] = parseICalendar(text).events;
          if (!parsed) continue;
          yield { type: "upserted", event: eventOf(href, etag, parsed) };
        }
      };
      const full = async function* (): AsyncIterable<CalendarSyncEvent> {
        const response = await request(calendarUrl, {
          method: "REPORT",
          headers: { depth: "1", "content-type": "application/xml; charset=utf-8" },
          body: `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${formatBasic(new Date(window.from))}" end="${formatBasic(new Date(window.to))}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
        });
        const hrefs = responsesOf(await response.text())
          .map((r) => tagText(r, "href"))
          .filter((h): h is string => h !== null)
          .map((h) => resolve(calendarUrl, h));
        yield* emit(hrefs);
      };

      // sync-collection (RFC 6578) when the server has it; a stale token resets.
      let response: Response | null = null;
      try {
        response = await request(calendarUrl, {
          method: "REPORT",
          headers: { "content-type": "application/xml; charset=utf-8" },
          body: `<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${escapeXml(stored?.syncToken ?? "")}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
        });
      } catch (error) {
        const code = (error as ProviderError).code;
        if (code === "auth" || code === "network") throw error;
        if (stored?.syncToken) {
          // valid-sync-token failed: full resync.
          yield { type: "reset" };
          yield* full();
          yield {
            type: "state",
            state: JSON.stringify({ v: 1, syncToken: null } satisfies CalDavState),
            complete: true,
          };
          return;
        }
        response = null;
      }
      if (!response) {
        yield* full();
        yield {
          type: "state",
          state: JSON.stringify({ v: 1, syncToken: null } satisfies CalDavState),
          complete: true,
        };
        return;
      }
      const body = await response.text();
      const token = tagText(body, "sync-token");
      const changed: string[] = [];
      for (const r of responsesOf(body)) {
        const href = tagText(r, "href");
        if (!href) continue;
        const status = tagText(r, "status") ?? "";
        const url = resolve(calendarUrl, href);
        if (url === calendarUrl) continue;
        if (/\b404\b/.test(status)) yield { type: "removed", id: url };
        else changed.push(url);
      }
      if (!stored?.syncToken && changed.length === 0) {
        // Some servers answer an initial sync-collection with nothing: list by range instead.
        yield* full();
      } else {
        yield* emit(changed);
      }
      yield {
        type: "state",
        state: JSON.stringify({ v: 1, syncToken: token } satisfies CalDavState),
        complete: true,
      };
    },

    async createEvent(calendarId, input: CreateEventInput) {
      const uid = `${crypto.randomUUID()}@monday`;
      const href = `${calendarId}${uid}.ics`;
      const ical = writeICalendar(
        {
          uid,
          sequence: 0,
          stamp: now(),
          title: input.title,
          description: input.description ?? "",
          location: input.location ?? "",
          start: new Date(input.start),
          end: new Date(input.end),
          allDay: input.allDay ?? false,
          zone: input.timeZone ?? null,
          organizer: input.organizer,
          attendees: [
            { ...input.organizer, response: "accepted", organizer: true },
            ...(input.attendees ?? []).map((p) => ({ ...p, response: "needs-action" as const })),
          ],
          status: "confirmed",
          recurrence: input.recurrence ?? null,
          link: input.meetingLink === "custom" ? (input.customLink ?? null) : null,
        },
        null,
      );
      const etag = await putObject(href, ical, { ifNoneMatch: true });
      const { text } = await getObject(href).catch(() => ({ text: ical, etag }));
      const [parsed] = parseICalendar(text).events;
      if (!parsed) throw new ProviderError("the server returned no VEVENT", "protocol");
      return eventOf(href, etag, parsed);
    },

    async updateEvent(_calendarId, eventId, input, etag) {
      const { text, etag: current } = await getObject(eventId);
      const [parsed] = parseICalendar(text).events;
      if (!parsed) throw new ProviderError("the server returned no VEVENT", "protocol");
      const timesChanged =
        (input.start !== undefined && input.start !== parsed.start.toISOString()) ||
        (input.end !== undefined && input.end !== parsed.end.toISOString());
      const next = writeICalendar(
        {
          uid: parsed.uid,
          sequence: parsed.sequence + (timesChanged ? 1 : 0),
          stamp: now(),
          title: input.title ?? parsed.title,
          description: input.description ?? parsed.description,
          location: input.location ?? parsed.location,
          start: input.start ? new Date(input.start) : parsed.start,
          end: input.end ? new Date(input.end) : parsed.end,
          allDay: input.allDay ?? parsed.allDay,
          zone: input.timeZone === undefined ? parsed.zone : input.timeZone,
          organizer: parsed.organizer ?? input.organizer ?? null,
          attendees: input.attendees
            ? [
                ...parsed.attendees.filter((a) => a.organizer),
                ...input.attendees.map((p) => ({
                  ...p,
                  response:
                    parsed.attendees.find((a) => a.email === p.email.toLowerCase())?.response ??
                    ("needs-action" as const),
                })),
              ]
            : parsed.attendees,
          status: parsed.status,
          recurrence: input.recurrence === undefined ? parsed.recurrence : input.recurrence,
          link:
            input.meetingLink === "custom"
              ? (input.customLink ?? parsed.link)
              : input.meetingLink === "none"
                ? null
                : parsed.link,
        },
        null,
      );
      const written = await putObject(eventId, next, { ifMatch: etag ?? current });
      const [again] = parseICalendar(next).events;
      if (!again) throw new ProviderError("the server returned no VEVENT", "protocol");
      return eventOf(eventId, written, again);
    },

    async deleteEvent(_calendarId, eventId) {
      await request(eventId, { method: "DELETE" }).catch((error) => {
        if ((error as ProviderError).code !== "not-found") throw error;
      });
    },

    async rsvp(_calendarId, eventId, response) {
      const { text, etag } = await getObject(eventId);
      const lines = unfold(text);
      let found = false;
      const next = lines.map((line) => {
        if (!/^ATTENDEE[;:]/i.test(line) || !line.toLowerCase().includes(`mailto:${me}`))
          return line;
        found = true;
        const [head, value] = [
          line.slice(0, line.lastIndexOf(":")),
          line.slice(line.lastIndexOf(":")),
        ];
        const withoutPartstat = head.replace(/;PARTSTAT=[^;:]*/i, "").replace(/;RSVP=[^;:]*/i, "");
        return `${withoutPartstat};PARTSTAT=${PARTSTAT_FOR[response]}${value}`;
      });
      if (!found)
        throw new ProviderError("the Account is not an attendee of that Event", "unsupported");
      const body = `${next.join("\r\n")}\r\n`;
      const written = await putObject(eventId, body, { ifMatch: etag });
      const [parsed] = parseICalendar(body).events;
      if (!parsed) throw new ProviderError("the server returned no VEVENT", "protocol");
      return eventOf(eventId, written, parsed);
    },

    async importInvite(calendarId, ical) {
      const [parsed] = parseICalendar(ical).events;
      if (!parsed) throw new ProviderError("no VEVENT in the invitation", "protocol");
      // The object goes in without METHOD, as a plain calendar object (RFC 4791 4.1).
      const lines = unfold(ical).filter((l) => !/^METHOD:/i.test(l));
      const body = `${lines.join("\r\n")}\r\n`;
      const href = `${calendarId}${encodeURIComponent(parsed.uid)}.ics`;
      let etag: string | null;
      try {
        etag = await putObject(href, body, { ifNoneMatch: true });
      } catch (error) {
        if ((error as ProviderError).code !== "protocol") throw error;
        // Already there (a re-sent REQUEST): replace it.
        etag = await putObject(href, body, {});
      }
      return eventOf(href, etag, parsed);
    },

    async close() {
      // Nothing held open.
    },
  };
  return session;
}

/** For tests: the ATTENDEE line an RSVP writes. */
export function attendeeLine(email: string, name: string, response: RsvpResponse): string {
  return `ATTENDEE;CN=${escapeText(name)};PARTSTAT=${PARTSTAT_FOR[response]}:mailto:${email}`;
}
