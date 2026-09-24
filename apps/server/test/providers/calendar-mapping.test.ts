// The Provider calendar adapters' resource mapping (slice 18): a Google
// event resource and a Graph event resource, as the APIs return them, to the
// one ProviderEvent shape the calendar module stores; the calendar lists,
// with the calendars others share and the access the Account has on each;
// and the CalDAV adapter's multistatus scanning.

import { describe, expect, test } from "bun:test";
import { hasTag, responsesOf, tagText } from "../../src/providers/caldav/index.ts";
import {
  calendarOfGoogle,
  createGoogleCalendar,
  eventOfGoogle,
  type GoogleEvent,
} from "../../src/providers/gmail/calendar.ts";
import type { GmailClient } from "../../src/providers/gmail/client.ts";
import {
  calendarOfGraph,
  createGraphCalendar,
  eventOfGraph,
  type GraphEvent,
} from "../../src/providers/graph/calendar.ts";
import type { GraphClient } from "../../src/providers/graph/client.ts";
import { ProviderError } from "../../src/providers/types.ts";

describe("Google Calendar resources", () => {
  test("a timed event with attendees and a Meet link", () => {
    const resource: GoogleEvent = {
      id: "abc123",
      status: "confirmed",
      iCalUID: "abc123@google.com",
      summary: "Call with Aoife",
      description: "Take-home review",
      start: { dateTime: "2026-09-17T15:00:00+01:00", timeZone: "Europe/Dublin" },
      end: { dateTime: "2026-09-17T15:30:00+01:00", timeZone: "Europe/Dublin" },
      organizer: { email: "tejas@genai-labs.io", displayName: "Tejas", self: true },
      attendees: [
        { email: "tejas@genai-labs.io", organizer: true, self: true, responseStatus: "accepted" },
        {
          email: "Aoife@northwind.test",
          displayName: "Aoife Brennan",
          responseStatus: "needsAction",
        },
      ],
      conferenceData: {
        entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
      },
      etag: '"3400"',
      updated: "2026-09-15T09:00:00.000Z",
    };
    const event = eventOfGoogle("primary", resource);
    expect(event).toMatchObject({
      id: "abc123",
      calendarId: "primary",
      uid: "abc123@google.com",
      title: "Call with Aoife",
      start: "2026-09-17T14:00:00.000Z",
      end: "2026-09-17T14:30:00.000Z",
      allDay: false,
      timeZone: "Europe/Dublin",
      link: "https://meet.google.com/abc-defg-hij",
      status: "confirmed",
      response: "accepted",
      etag: '"3400"',
    });
    expect(event.attendees[1]).toEqual({
      name: "Aoife Brennan",
      email: "aoife@northwind.test",
      response: "needs-action",
    });
    expect(event.attendees[0]?.self).toBe(true);
    expect(event.attendees[0]?.organizer).toBe(true);
  });

  test("an all-day event and a recurring master", () => {
    const event = eventOfGoogle("primary", {
      id: "d1",
      summary: "Offsite",
      start: { date: "2026-09-19" },
      end: { date: "2026-09-21" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    expect(event.allDay).toBe(true);
    expect(event.start).toBe("2026-09-19T00:00:00.000Z");
    expect(event.end).toBe("2026-09-21T00:00:00.000Z");
    expect(event.recurrence).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(event.response).toBeNull();
  });
});

describe("Graph event resources", () => {
  test("a Teams meeting the user was invited to, times in UTC as asked", () => {
    const resource: GraphEvent = {
      id: "AAMk1",
      iCalUId: "040000008200E00074C5B7101A82E008",
      subject: "Term sheet call",
      body: { contentType: "html", content: "<p>Walkthrough.<br>Bring questions.</p>" },
      location: { displayName: "Microsoft Teams Meeting" },
      start: { dateTime: "2026-07-21T18:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-07-21T19:00:00.0000000", timeZone: "UTC" },
      isAllDay: false,
      showAs: "tentative",
      organizer: { emailAddress: { address: "Kenji.W@meridianfund.co", name: "Kenji Watanabe" } },
      attendees: [
        {
          emailAddress: { address: "kenji.w@meridianfund.co", name: "Kenji Watanabe" },
          type: "required",
          status: { response: "organizer" },
        },
        {
          emailAddress: { address: "tejas@genai-labs.io", name: "Tejas" },
          type: "required",
          status: { response: "none" },
        },
      ],
      isOrganizer: false,
      responseStatus: { response: "notResponded" },
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc" },
      changeKey: "CQAAABYAAA",
      lastModifiedDateTime: "2026-07-15T16:00:00Z",
      originalStartTimeZone: "Pacific Standard Time",
    };
    const event = eventOfGraph("cal-1", "tejas@genai-labs.io", resource);
    expect(event).toMatchObject({
      id: "AAMk1",
      uid: "040000008200E00074C5B7101A82E008",
      title: "Term sheet call",
      description: "Walkthrough.\nBring questions.",
      start: "2026-07-21T18:00:00.000Z",
      end: "2026-07-21T19:00:00.000Z",
      status: "tentative",
      response: "needs-action",
      link: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc",
      etag: "CQAAABYAAA",
      timeZone: "Pacific Standard Time",
    });
    expect(event.organizer).toEqual({ name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" });
    expect(event.attendees[0]?.organizer).toBe(true);
    expect(event.attendees[0]?.response).toBe("accepted");
    expect(event.attendees[1]?.self).toBe(true);
  });
});

describe("CalDAV multistatus scanning", () => {
  const body = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/dav/calendars/user/tejas/Default/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
      <d:displayname>Default &amp; more</d:displayname>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/calendars/user/tejas/Default/abc.ics</d:href>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:response>
</d:multistatus>`;

  test("responses, tag text with entities decoded, and empty-element detection", () => {
    const responses = responsesOf(body);
    expect(responses).toHaveLength(2);
    const [calendar, gone] = responses;
    expect(tagText(calendar ?? "", "href")).toBe("/dav/calendars/user/tejas/Default/");
    expect(tagText(calendar ?? "", "displayname")).toBe("Default & more");
    expect(hasTag(tagText(calendar ?? "", "resourcetype") ?? "", "calendar")).toBe(true);
    expect(hasTag(tagText(calendar ?? "", "resourcetype") ?? "", "addressbook")).toBe(false);
    expect(tagText(gone ?? "", "status")).toContain("404");
  });
});

describe("calendar lists: shared calendars and access", () => {
  const ME = "tejas@genai-labs.io";

  test("Google: the access role maps to access; a calendar the Account does not own is shared", () => {
    expect(
      calendarOfGoogle({ id: ME, summary: ME, primary: true, accessRole: "owner" }),
    ).toMatchObject({ id: ME, primary: true, writable: true, access: "owner", sharedBy: null });
    expect(
      calendarOfGoogle({
        id: "Aoife@northwind.test",
        summary: "Aoife Brennan",
        accessRole: "writer",
      }),
    ).toMatchObject({
      writable: true,
      access: "writer",
      sharedBy: { name: "Aoife Brennan", email: "aoife@northwind.test" },
    });
    expect(
      calendarOfGoogle({
        id: "abc@group.calendar.google.com",
        summary: "Team offsites",
        summaryOverride: "Offsites",
        accessRole: "writerWithoutPrivateAccess",
      }),
    ).toMatchObject({
      name: "Offsites",
      writable: true,
      access: "writer",
      sharedBy: { name: "Team offsites", email: "" },
    });
    expect(
      calendarOfGoogle({
        id: "en.irish#holiday@group.v.calendar.google.com",
        summary: "Holidays in Ireland",
        accessRole: "reader",
      }),
    ).toMatchObject({ writable: false, access: "reader", sharedBy: { email: "" } });
    expect(
      calendarOfGoogle({ id: "boss@northwind.test", accessRole: "freeBusyReader" }),
    ).toMatchObject({
      name: "boss@northwind.test",
      writable: false,
      access: "free-busy",
      sharedBy: { name: "boss@northwind.test", email: "boss@northwind.test" },
    });
    // An owned secondary calendar is the Account's own.
    expect(
      calendarOfGoogle({ id: "x@group.calendar.google.com", summary: "Side", accessRole: "owner" })
        .sharedBy,
    ).toBeNull();
  });

  test("Google: listCalendars keeps every calendarList entry but the deleted ones", async () => {
    const client = {
      raw: async (url: string) => {
        expect(url).toContain("/users/me/calendarList");
        return new Response(
          JSON.stringify({
            items: [
              { id: ME, summary: ME, primary: true, accessRole: "owner" },
              { id: "aoife@northwind.test", summary: "Aoife Brennan", accessRole: "reader" },
              { id: "gone@northwind.test", accessRole: "reader", deleted: true },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as GmailClient;
    const listed = await createGoogleCalendar(client, ME).listCalendars();
    expect(listed.map((c) => [c.id, c.access, c.sharedBy?.email ?? null])).toEqual([
      [ME, "owner", null],
      ["aoife@northwind.test", "reader", "aoife@northwind.test"],
    ]);
  });

  test("Graph: canEdit and the owner make access; another owner shares it", () => {
    expect(
      calendarOfGraph(
        {
          id: "c1",
          name: "Calendar",
          isDefaultCalendar: true,
          canEdit: true,
          owner: { name: "Tejas", address: "Tejas@genai-labs.io" },
        },
        ME,
      ),
    ).toMatchObject({ primary: true, writable: true, access: "owner", sharedBy: null });
    expect(
      calendarOfGraph(
        {
          id: "c2",
          name: "Aoife's calendar",
          canEdit: true,
          owner: { name: "Aoife Brennan", address: "Aoife@northwind.test" },
        },
        ME,
      ),
    ).toMatchObject({
      writable: true,
      access: "writer",
      sharedBy: { name: "Aoife Brennan", email: "aoife@northwind.test" },
    });
    expect(
      calendarOfGraph(
        { id: "c3", name: "Board", canEdit: false, owner: { address: "board@northwind.test" } },
        ME,
      ),
    ).toMatchObject({
      writable: false,
      access: "reader",
      sharedBy: { name: "", email: "board@northwind.test" },
    });
  });

  test("Graph: listCalendars adds the calendars in other calendar groups, once each", async () => {
    const seen: string[] = [];
    const pages: Record<string, unknown> = {
      "me/calendars": {
        value: [
          {
            id: "c1",
            name: "Calendar",
            isDefaultCalendar: true,
            canEdit: true,
            owner: { address: ME },
          },
        ],
      },
      "me/calendarGroups": { value: [{ id: "g1" }, { id: "g2" }] },
      "me/calendarGroups/g1/calendars": {
        value: [{ id: "c1", name: "Calendar", isDefaultCalendar: true, canEdit: true }],
      },
      "me/calendarGroups/g2/calendars": {
        value: [
          {
            id: "c2",
            name: "Aoife Brennan",
            canEdit: false,
            owner: { name: "Aoife Brennan", address: "aoife@northwind.test" },
          },
        ],
      },
    };
    const client = {
      request: async (url: string) => {
        seen.push(url);
        const page = pages[url];
        if (!page) throw new Error(`unexpected ${url}`);
        return page;
      },
    } as unknown as GraphClient;
    const listed = await createGraphCalendar(client, ME).listCalendars();
    expect(listed.map((c) => [c.id, c.access, c.sharedBy?.email ?? null])).toEqual([
      ["c1", "owner", null],
      ["c2", "reader", "aoife@northwind.test"],
    ]);
    expect(seen).toContain("me/calendarGroups/g2/calendars");

    // A tenant that refuses the groups keeps the default group's calendars.
    const refusing = {
      request: async (url: string) => {
        if (url === "me/calendars") return pages["me/calendars"];
        throw new ProviderError("forbidden", "unsupported");
      },
    } as unknown as GraphClient;
    const only = await createGraphCalendar(refusing, ME).listCalendars();
    expect(only.map((c) => c.id)).toEqual(["c1"]);
  });
});
