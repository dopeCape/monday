// The browser dev server's calendar: two Accounts' calendars and a week of
// Events around the design fixture's day, so the Calendar renders on
// `?screen=calendar` with no Server. `&calstate=api-disabled` shows an
// Account whose Google Calendar API is off. Never loaded in the app.

import type {
  Attendee,
  Calendar,
  CalendarDraft,
  CalendarEvent,
  CalendarStatus,
} from "@monday/shared";
import { type CalendarAccount, fixtureCalendar, type StoreCalendar } from "./calendar-data.ts";
import { allDayIso } from "./dates.ts";

const me: Attendee = {
  name: "Tejas",
  email: "tejas@genai-labs.io",
  response: "accepted",
  self: true,
  organizer: true,
};

export function devCalendar(now: Date, state: string | null): StoreCalendar {
  const ws = "ws-genai";
  const other = "ws-personal";
  const accounts: CalendarAccount[] = [
    { workspaceId: ws, accountId: "acct-genai", address: "tejas@genai-labs.io", current: true },
    {
      workspaceId: other,
      accountId: "acct-home",
      address: "tejas.home@fastmail.test",
      current: false,
    },
  ];
  const cal = (
    id: string,
    workspaceId: string,
    name: string,
    color: string | null,
    extra: Partial<Calendar> = {},
  ): Calendar => ({
    id,
    workspaceId,
    source: workspaceId === ws ? "google" : "caldav",
    providerId: id,
    name,
    primary: false,
    writable: true,
    visible: true,
    color,
    ...extra,
  });
  const calendars = [
    cal("c-work", ws, "tejas@genai-labs.io", "#4f7cf0", { primary: true }),
    cal("c-team", ws, "Team", "#2a9fa8", {
      writable: false,
      access: "reader",
      sharedBy: { name: "Kenji Watanabe", email: "kenji@genai-labs.io" },
    }),
    cal("c-hiring", ws, "Hiring", "#b8479a"),
    cal("c-holidays", ws, "Holidays in Ireland", null, {
      writable: false,
      access: "reader",
      error: "403: The caller does not have permission",
    }),
    cal("c-home", other, "Personal", "#d4880f", { primary: true }),
  ];
  const day = (offset: number, h: number, m = 0) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, h, m);
    return d.toISOString();
  };
  const date = (offset: number) =>
    allDayIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  let n = 0;
  const ev = (
    over: Partial<CalendarEvent> & { title: string; start: string; end: string },
  ): CalendarEvent => {
    n += 1;
    return {
      id: `dev-${n}`,
      workspaceId: ws,
      calendarId: "c-work",
      providerId: `dev-${n}`,
      uid: null,
      description: "",
      location: "",
      allDay: false,
      timeZone: null,
      organizer: null,
      attendees: [],
      link: null,
      status: "confirmed",
      recurrence: null,
      recurringEventId: null,
      response: "accepted",
      createdByAgent: false,
      etag: null,
      updatedAt: now.toISOString(),
      ...over,
    };
  };
  const monday = -((now.getDay() + 6) % 7);
  const events: CalendarEvent[] = [
    ev({
      title: "Standup",
      start: day(monday, 9, 30),
      end: day(monday, 9, 45),
      recurrence: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      calendarId: "c-work",
      organizer: { name: "Kenji Watanabe", email: "kenji@genai-labs.io" },
      attendees: [
        {
          name: "Kenji Watanabe",
          email: "kenji@genai-labs.io",
          response: "accepted",
          organizer: true,
        },
        { ...me, organizer: false },
      ],
      link: "https://meet.google.com/abc-defg-hij",
    }),
    ev({
      title: "Term sheet call, Meridian",
      start: day(0, 11),
      end: day(0, 12),
      location: "Meridian offices, 4th floor",
      attendees: [
        me,
        { name: "Ravi Menon", email: "ravi@meridian.test", response: "accepted" },
        { name: "Kenji Watanabe", email: "kenji@genai-labs.io", response: "tentative" },
      ],
      organizer: { name: "Tejas", email: "tejas@genai-labs.io" },
      link: "https://meet.google.com/xyz-abcd-efg",
      description: "Walk through the revised cap table and the pro rata question.",
    }),
    ev({ title: "Focus: pricing page", start: day(0, 11, 30), end: day(0, 13, 30) }),
    ev({
      title: "Aoife Brennan, take-home review",
      calendarId: "c-hiring",
      start: day(0, 15),
      end: day(0, 15, 45),
      createdByAgent: true,
      organizer: { name: "Tejas", email: "tejas@genai-labs.io" },
      attendees: [
        me,
        { name: "Aoife Brennan", email: "aoife@northwind.test", response: "needs-action" },
      ],
      link: "https://meet.google.com/aoi-fe12-345",
    }),
    ev({
      title: "Podcast recording",
      start: day(1, 13),
      end: day(1, 14),
      status: "tentative",
      response: "needs-action",
      organizer: { name: "Sofia Lindqvist", email: "sofia@lindqvist.test" },
      attendees: [
        {
          name: "Sofia Lindqvist",
          email: "sofia@lindqvist.test",
          response: "accepted",
          organizer: true,
        },
        { ...me, organizer: false, response: "needs-action" },
      ],
    }),
    ev({
      title: "Icon review with Mateus",
      start: day(-1, 14),
      end: day(-1, 15),
      calendarId: "c-work",
    }),
    ev({ title: "Board prep", start: day(2, 10), end: day(2, 11, 30) }),
    ev({
      title: "Lunch with Ngozi",
      start: day(2, 12, 30),
      end: day(2, 13, 30),
      workspaceId: other,
      calendarId: "c-home",
      location: "Dishoom",
    }),
    ev({
      title: "Offsite",
      start: date(1),
      end: date(3),
      allDay: true,
      calendarId: "c-team",
      workspaceId: ws,
    }),
    ev({
      title: "Mum's birthday",
      start: date(-2),
      end: date(-1),
      allDay: true,
      calendarId: "c-home",
      workspaceId: other,
    }),
    ev({
      title: "Gym",
      start: day(-1, 7),
      end: day(-1, 8),
      workspaceId: other,
      calendarId: "c-home",
    }),
    ev({ title: "Interview loop", start: day(3, 14), end: day(3, 17), calendarId: "c-hiring" }),
    ev({ title: "1:1 Kenji", start: day(3, 14, 30), end: day(3, 15) }),
    ev({
      title: "Flight to Lisbon",
      start: day(4, 18, 10),
      end: day(4, 21, 5),
      timeZone: "Europe/Lisbon",
      location: "LHR T2",
    }),
  ];
  const statuses: CalendarStatus[] =
    state === "api-disabled"
      ? [
          {
            workspaceId: ws,
            accountId: "acct-genai",
            source: "google",
            problem: {
              kind: "api-disabled",
              message:
                "Google Calendar API has not been used in project 402113 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=402113 then retry.",
              fixUrl:
                "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=402113",
            },
            lastSync: null,
            checkedAt: now.toISOString(),
          },
        ]
      : [];
  const source = fixtureCalendar({
    calendars,
    events: state === "empty" ? [] : events,
    accounts,
    statuses,
  });
  return { ...source, close() {} };
}

/** A plan for the week the Agent might propose, for `&caldraft=1` on the dev server. */
export function devDraft(now: Date): CalendarDraft {
  const day = (offset: number, h: number, m = 0) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, h, m).toISOString();
  return {
    id: "dev-draft",
    workspaceId: "ws-genai",
    title: "Your week, planned",
    summary:
      "Focus blocks on the mornings you had free, prep before the board, the review moved off your focus time.",
    from: day(-3, 0),
    to: day(4, 0),
    createdAt: now.toISOString(),
    changes: [
      {
        id: "c1",
        kind: "create",
        before: null,
        after: {
          title: "Focus: pricing page",
          start: day(1, 9),
          end: day(1, 11, 30),
          allDay: false,
        },
        guests: [],
        reason: "Your Friday morning is free",
      },
      {
        id: "c2",
        kind: "create",
        before: null,
        after: { title: "Board prep", start: day(2, 8, 30), end: day(2, 9, 45), allDay: false },
        guests: [],
        reason: "Before Board prep at 10:00",
      },
      {
        id: "c3",
        kind: "update",
        eventId: "dev-6",
        before: {
          title: "Icon review with Mateus",
          start: day(-1, 14),
          end: day(-1, 15),
          allDay: false,
        },
        after: {
          title: "Icon review with Mateus",
          start: day(-1, 16),
          end: day(-1, 17),
          allDay: false,
        },
        guests: [{ name: "Mateus Silva", email: "mateus@genai-labs.io" }],
        reason: "Mateus asked for later in the day",
      },
      {
        id: "c4",
        kind: "delete",
        eventId: "dev-13",
        before: { title: "1:1 Kenji", start: day(3, 14, 30), end: day(3, 15), allDay: false },
        after: null,
        guests: [],
        reason: "Overlaps the interview loop",
      },
    ],
  };
}
