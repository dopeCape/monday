// The iCalendar parser and generator (slice 18, research 6 "Invites in
// mail"): a Google REQUEST as it arrives in a Message, an Exchange one with a
// Windows zone name, folding and escaping round trips, the REPLY body an
// IMAP-only Account mails back, and the recurrence expander over the masters
// a CalDAV server hands back.

import { describe, expect, test } from "bun:test";
import { expandRecurrence, ianaZoneOf, meetingLinkIn, zonedToUtc } from "@monday/shared";
import { fold, parseICalendar, unfold, writeICalendar, writeReply } from "../src/calendar/ical.ts";

const GOOGLE_REQUEST = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "CALSCALE:GREGORIAN",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "DTSTART:20260918T140000Z",
  "DTEND:20260918T144500Z",
  "DTSTAMP:20260915T091200Z",
  "ORGANIZER;CN=Aoife Brennan:mailto:aoife@northwind.test",
  "UID:7k2p9q1abc@google.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRU",
  " E;CN=tejas@genai-labs.io;X-NUM-GUESTS=0:mailto:tejas@genai-labs.io",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE",
  " ;CN=Aoife Brennan;X-NUM-GUESTS=0:mailto:aoife@northwind.test",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
  "CREATED:20260915T091100Z",
  "DESCRIPTION:Take-home review\\, 45 minutes.\\nJoin: https://meet.google.com/a",
  " bc-defg-hij",
  "LAST-MODIFIED:20260915T091200Z",
  "LOCATION:",
  "SEQUENCE:0",
  "STATUS:CONFIRMED",
  "SUMMARY:Aoife Brennan\\, take-home",
  "TRANSP:OPAQUE",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const EXCHANGE_REQUEST = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "PRODID:Microsoft Exchange Server 2010",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Pacific Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:-0700",
  "TZOFFSETTO:-0800",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010101T020000",
  "TZOFFSETFROM:-0800",
  "TZOFFSETTO:-0700",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "ORGANIZER;CN=Kenji Watanabe:mailto:kenji.w@meridianfund.co",
  "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Tejas:mailto:tejas@genai-labs.io",
  "DESCRIPTION;LANGUAGE=en-US:Term sheet walkthrough.\\n",
  "UID:040000008200E00074C5B7101A82E00800000000A0",
  "SUMMARY;LANGUAGE=en-US:Term sheet call",
  "DTSTART;TZID=Pacific Standard Time:20260721T110000",
  "DTEND;TZID=Pacific Standard Time:20260721T120000",
  "SEQUENCE:2",
  "DTSTAMP:20260715T160000Z",
  "STATUS:TENTATIVE",
  "X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("iCalendar parsing", () => {
  test("a Google REQUEST: method, UTC times, people, the Meet link, unescaped text", () => {
    const parsed = parseICalendar(GOOGLE_REQUEST);
    expect(parsed.method).toBe("REQUEST");
    const [event] = parsed.events;
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.uid).toBe("7k2p9q1abc@google.com");
    expect(event.title).toBe("Aoife Brennan, take-home");
    expect(event.start.toISOString()).toBe("2026-09-18T14:00:00.000Z");
    expect(event.end.toISOString()).toBe("2026-09-18T14:45:00.000Z");
    expect(event.allDay).toBe(false);
    expect(event.organizer).toEqual({ name: "Aoife Brennan", email: "aoife@northwind.test" });
    expect(event.attendees).toHaveLength(2);
    expect(event.attendees[0]?.response).toBe("needs-action");
    expect(event.attendees[1]?.response).toBe("accepted");
    expect(event.attendees[1]?.organizer).toBe(true);
    expect(event.link).toBe("https://meet.google.com/abc-defg-hij");
    expect(event.description).toContain("Take-home review, 45 minutes.\nJoin:");
    expect(event.status).toBe("confirmed");
    expect(event.sequence).toBe(0);
  });

  test("an Exchange REQUEST: the Windows zone maps to IANA and the wall clock lands at the right instant", () => {
    const parsed = parseICalendar(EXCHANGE_REQUEST);
    const [event] = parsed.events;
    if (!event) throw new Error("no event");
    expect(ianaZoneOf("Pacific Standard Time")).toBe("America/Los_Angeles");
    expect(event.zone).toBe("America/Los_Angeles");
    // 11:00 Pacific daylight time in July is 18:00 UTC.
    expect(event.start.toISOString()).toBe("2026-07-21T18:00:00.000Z");
    expect(event.end.toISOString()).toBe("2026-07-21T19:00:00.000Z");
    expect(event.sequence).toBe(2);
    expect(event.status).toBe("tentative");
    expect(event.link).toBe("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc");
    expect(event.extra["X-MICROSOFT-SKYPETEAMSMEETINGURL"]).toBeDefined();
  });

  test("an unknown TZID falls back to the VTIMEZONE's declared offset", () => {
    const text = EXCHANGE_REQUEST.replaceAll("Pacific Standard Time", "Somewhere Odd Time");
    const [event] = parseICalendar(text).events;
    if (!event) throw new Error("no event");
    expect(event.zone).toBeNull();
    // The STANDARD offset (-0800) is used: 11:00 wall clock is 19:00 UTC.
    expect(event.start.toISOString()).toBe("2026-07-21T19:00:00.000Z");
  });

  test("all-day values, DURATION, EXDATE and CANCEL", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "METHOD:CANCEL",
      "BEGIN:VEVENT",
      "UID:allday-1",
      "DTSTART;VALUE=DATE:20260920",
      "DURATION:P2D",
      "EXDATE;VALUE=DATE:20260921",
      "SUMMARY:Offsite",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const parsed = parseICalendar(text);
    expect(parsed.method).toBe("CANCEL");
    const [event] = parsed.events;
    if (!event) throw new Error("no event");
    expect(event.allDay).toBe(true);
    expect(event.start.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(event.end.toISOString()).toBe("2026-09-22T00:00:00.000Z");
    expect(event.exdates.map((d) => d.toISOString())).toEqual(["2026-09-21T00:00:00.000Z"]);
    expect(event.status).toBe("cancelled");
  });

  test("folding at 75 octets and unfolding are inverses", () => {
    const long = `DESCRIPTION:${"x".repeat(200)} ü ${"y".repeat(100)}`;
    const folded = fold(long);
    for (const line of folded.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(unfold(folded)).toEqual([long]);
  });
});

describe("iCalendar generation", () => {
  const event = {
    uid: "monday-1@genai-labs.io",
    sequence: 0,
    stamp: new Date("2026-09-15T09:00:00Z"),
    title: "Call with Aoife; agenda, next steps",
    description: "Line one\nLine two",
    location: "",
    start: new Date("2026-09-17T14:00:00Z"),
    end: new Date("2026-09-17T14:30:00Z"),
    allDay: false,
    zone: "Europe/Dublin",
    organizer: { name: "Tejas", email: "tejas@genai-labs.io" },
    attendees: [
      { name: "Aoife Brennan", email: "aoife@northwind.test", response: "needs-action" as const },
    ],
    status: "confirmed" as const,
    recurrence: null,
    link: "https://meet.jit.si/monday-aoife",
  };

  test("a REQUEST round-trips through the parser with the zone kept", () => {
    const text = writeICalendar(event, "REQUEST");
    const lines = unfold(text);
    expect(text).toContain("METHOD:REQUEST");
    expect(text).toContain("DTSTART;TZID=Europe/Dublin:20260917T150000");
    expect(text).toContain("SUMMARY:Call with Aoife\\; agenda\\, next steps");
    expect(lines.find((l) => l.startsWith("ATTENDEE"))).toContain("RSVP=TRUE");
    expect(lines).toContain("CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://meet.jit.si/monday-aoife");
    const back = parseICalendar(text);
    expect(back.method).toBe("REQUEST");
    const [parsed] = back.events;
    if (!parsed) throw new Error("no event");
    expect(parsed.title).toBe(event.title);
    expect(parsed.description).toBe(event.description);
    expect(parsed.start.toISOString()).toBe(event.start.toISOString());
    expect(parsed.zone).toBe("Europe/Dublin");
    expect(parsed.link).toBe(event.link);
    expect(parsed.attendees[0]?.email).toBe("aoife@northwind.test");
  });

  test("a REPLY carries exactly one ATTENDEE with the new PARTSTAT and the same UID and SEQUENCE", () => {
    const text = writeReply(
      { ...event, sequence: 3 },
      { name: "Tejas", email: "tejas@genai-labs.io" },
      "accepted",
      new Date("2026-09-16T08:00:00Z"),
    );
    expect(text).toContain("METHOD:REPLY");
    expect(text).toContain("UID:monday-1@genai-labs.io");
    expect(text).toContain("SEQUENCE:3");
    const attendees = unfold(text).filter((l) => l.startsWith("ATTENDEE"));
    expect(attendees).toHaveLength(1);
    expect(attendees[0]).toContain("PARTSTAT=ACCEPTED");
    expect(attendees[0]).toContain("mailto:tejas@genai-labs.io");
  });
});

describe("shared calendar helpers", () => {
  test("zonedToUtc settles across a DST transition", () => {
    // 01:30 on the day Europe/Dublin falls back (2026-10-25) exists twice; either instant is acceptable.
    const at = zonedToUtc("Europe/Dublin", 2026, 10, 25, 1, 30, 0);
    expect(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]).toContain(at.toISOString());
    // A plain summer time: 15:00 Dublin is 14:00 UTC.
    expect(zonedToUtc("Europe/Dublin", 2026, 9, 17, 15, 0, 0).toISOString()).toBe(
      "2026-09-17T14:00:00.000Z",
    );
  });

  test("the meeting link extractor finds Meet, Teams and Zoom and ignores plain URLs", () => {
    expect(meetingLinkIn("Join at https://meet.google.com/abc-defg-hij.")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(meetingLinkIn("https://zoom.us/j/123456?pwd=x see you")).toBe(
      "https://zoom.us/j/123456?pwd=x",
    );
    expect(meetingLinkIn("Docs at https://example.com/agenda")).toBeNull();
  });

  test("a weekly rule with BYDAY expands inside the window in the Event's zone, skipping EXDATE", () => {
    const start = new Date("2026-09-07T08:00:00Z"); // Monday 09:00 in Dublin
    const end = new Date("2026-09-07T08:30:00Z");
    const window = { from: new Date("2026-10-19T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
    const out = expandRecurrence("FREQ=WEEKLY;BYDAY=MO,WE", start, end, "Europe/Dublin", window, [
      new Date("2026-10-21T08:00:00Z"),
    ]);
    // Mon 19, Wed 21 (excluded), Mon 26, Wed 28 (after the clocks go back: 09:00 Dublin is 09:00 UTC).
    expect(out.map((o) => o.start.toISOString())).toEqual([
      "2026-10-19T08:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
      "2026-10-28T09:00:00.000Z",
    ]);
  });

  test("COUNT and UNTIL stop the series; monthly rules keep the day", () => {
    const start = new Date("2026-01-31T10:00:00Z");
    const out = expandRecurrence(
      "FREQ=MONTHLY;COUNT=4",
      start,
      new Date("2026-01-31T11:00:00Z"),
      null,
      { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2027-01-01T00:00:00Z") },
    );
    // January 31, March 31, May 31, July 31 (February, April, June have no 31st).
    expect(out.map((o) => o.start.toISOString().slice(0, 10))).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
      "2026-07-31",
    ]);
    const daily = expandRecurrence(
      "FREQ=DAILY;UNTIL=20260103T000000Z",
      new Date("2026-01-01T09:00:00Z"),
      new Date("2026-01-01T10:00:00Z"),
      null,
      { from: new Date("2025-12-01T00:00:00Z"), to: new Date("2026-02-01T00:00:00Z") },
    );
    expect(daily).toHaveLength(2);
  });
});
