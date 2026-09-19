// The Provider calendar adapters' resource mapping (slice 18): a Google
// event resource and a Graph event resource, as the APIs return them, to the
// one ProviderEvent shape the calendar module stores; and the CalDAV
// adapter's multistatus scanning.

import { describe, expect, test } from "bun:test";
import { hasTag, responsesOf, tagText } from "../../src/providers/caldav/index.ts";
import { eventOfGoogle, type GoogleEvent } from "../../src/providers/gmail/calendar.ts";
import { eventOfGraph, type GraphEvent } from "../../src/providers/graph/calendar.ts";

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
