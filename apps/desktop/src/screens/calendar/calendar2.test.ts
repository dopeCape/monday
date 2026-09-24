/// <reference types="bun-types" />
// The Calendar's second batch of pure pieces: typed times and lengths for
// the time field, which calendars a Workspace shows (calendar.shown), the
// calendar list's groups, and a calendar draft laid over the views.

import { describe, expect, test } from "bun:test";
import type { Calendar, CalendarDraft, CalendarEvent } from "@monday/shared";
import type { Occurrence } from "./calendar-data.ts";
import { lengthLabel, parseTime } from "./controls.tsx";
import { calendarShown, draftOverlay, withShown } from "./layout.ts";
import { calendarGroups } from "./Sidebar.tsx";

const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m).toISOString();

function occ(key: string, title: string, start: string, end: string): Occurrence {
  const e: CalendarEvent = {
    id: key,
    workspaceId: "ws",
    calendarId: "cal",
    providerId: key,
    uid: null,
    title,
    description: "",
    location: "",
    start,
    end,
    allDay: false,
    timeZone: null,
    organizer: null,
    attendees: [],
    link: null,
    status: "confirmed",
    recurrence: null,
    recurringEventId: null,
    response: null,
    createdByAgent: false,
    etag: null,
    updatedAt: "",
  };
  return { ...e, key, instanceStart: null };
}

describe("the time field", () => {
  test("typed times, and the length an end time adds", () => {
    expect(parseTime("9")).toBe("09:00");
    expect(parseTime("930")).toBe("09:30");
    expect(parseTime("9.30pm")).toBe("21:30");
    expect(parseTime("12am")).toBe("00:00");
    expect(parseTime("21h05")).toBe("21:05");
    expect(parseTime("25")).toBeNull();
    expect(parseTime("soon")).toBeNull();
    const words = { minutes: "{n} min", hours: "{h} h{m}" };
    expect(lengthLabel("09:00", "09:45", words)).toBe("45 min");
    expect(lengthLabel("09:00", "10:30", words)).toBe("1 h 30");
    expect(lengthLabel("09:00", "11:00", words)).toBe("2 h");
  });
});

describe("which calendars a Workspace shows", () => {
  test("the Server's flag, other Accounts, then the Setting, the Workspace's own choice first", () => {
    const own = { id: "a", workspaceId: "ws1", visible: true };
    const theirs = { id: "b", workspaceId: "ws2", visible: true };
    expect(calendarShown({}, "ws1", own, true)).toBe(true);
    expect(calendarShown({}, "ws1", { ...own, visible: false }, true)).toBe(false);
    expect(calendarShown({}, "ws1", theirs, false)).toBe(false);
    expect(calendarShown({ "*": { b: false } }, "ws1", theirs, true)).toBe(false);
    expect(calendarShown({ "*": { b: false }, ws1: { b: true } }, "ws1", theirs, true)).toBe(true);
    expect(withShown({ ws1: { a: false } }, "ws1", { b: false })).toEqual({
      ws1: { a: false, b: false },
    });
  });

  test("the calendar list's groups: mine, each other Account's, then shared", () => {
    const c = (id: string, workspaceId: string, shared = false): Calendar => ({
      id,
      workspaceId,
      source: "google",
      providerId: id,
      name: id,
      primary: false,
      writable: true,
      visible: true,
      color: null,
      ...(shared ? { sharedBy: { name: "Team", email: "" }, access: "reader" as const } : {}),
    });
    const groups = calendarGroups(
      [c("mine", "ws1"), c("team", "ws1", true), c("home", "ws2")],
      [
        { workspaceId: "ws1", accountId: "a1", address: "me@work.test", current: true },
        { workspaceId: "ws2", accountId: "a2", address: "me@home.test", current: false },
      ],
      "ws1",
      new Set(["ws2"]),
      { mine: "My calendars", shared: "Shared with me" },
    );
    expect(groups.map((g) => [g.title, g.problem, g.calendars.map((x) => x.id)])).toEqual([
      ["My calendars", false, ["mine"]],
      ["me@home.test", true, ["home"]],
      ["Shared with me", false, ["team"]],
    ]);
  });
});

describe("a draft over the views", () => {
  test("added and moved-to ghosts, the moved-from and removed marked, left-out changes gone", () => {
    const items = [
      occ("review", "Review", at(22, 13), at(22, 14)),
      occ("sync", "Sync", at(23, 10), at(23, 11)),
    ];
    const d: CalendarDraft = {
      id: "d",
      workspaceId: "ws",
      title: "t",
      summary: "",
      from: at(21, 0),
      to: at(24, 0),
      createdAt: "",
      changes: [
        {
          id: "c1",
          kind: "create",
          before: null,
          after: { title: "Focus", start: at(21, 9), end: at(21, 11), allDay: false },
          guests: [],
        },
        {
          id: "c2",
          kind: "update",
          eventId: "review",
          before: { title: "Review", start: at(22, 13), end: at(22, 14), allDay: false },
          after: { title: "Review", start: at(22, 15), end: at(22, 16), allDay: false },
          guests: [],
        },
        { id: "c3", kind: "delete", eventId: "sync", before: null, after: null, guests: [] },
      ],
    };
    const shown = draftOverlay(items, d, new Set());
    expect(shown.map((o) => [o.title, o.draft?.kind ?? "", o.start === at(22, 15)])).toEqual([
      ["Focus", "add", false],
      ["Review", "before", false],
      ["Review", "after", true],
      ["Sync", "delete", false],
    ]);
    expect(draftOverlay(items, d, new Set(["c1", "c2", "c3"])).map((o) => o.draft)).toEqual([
      undefined,
      undefined,
    ]);
  });
});
