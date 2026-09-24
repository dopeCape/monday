// The free-slot computation find_free_time answers from: working hours on
// working days, read in a zone, stepping on the snap, clear of busy spans.

import { describe, expect, test } from "bun:test";
import type { CalendarEvent } from "@monday/shared";
import {
  type EventInstance,
  eventMatches,
  freeSlots,
  instancesIn,
} from "../src/intelligence/agent/tools/calendar.ts";

const base = {
  durationMinutes: 30,
  busy: [],
  dayStartHour: 9,
  dayEndHour: 17,
  workDays: ["mon", "tue", "wed", "thu", "fri"] as const,
  stepMinutes: 15,
  timeZone: "UTC",
  limit: 10,
};

describe("freeSlots", () => {
  test("starts on the step, keeps clear of busy spans, does not overlap itself", () => {
    // Wednesday 2026-09-16, from 09:07.
    const slots = freeSlots({
      ...base,
      from: new Date("2026-09-16T09:07:00Z"),
      to: new Date("2026-09-16T17:00:00Z"),
      busy: [
        { start: "2026-09-16T10:00:00Z", end: "2026-09-16T11:10:00Z" },
        { start: "2026-09-16T11:30:00Z", end: "2026-09-16T16:00:00Z" },
      ],
      limit: 10,
    });
    expect(slots).toEqual([
      { start: "2026-09-16T09:15:00.000Z", end: "2026-09-16T09:45:00.000Z" },
      // 09:45 clashes; after the first busy span, 11:15 would run into the second.
      { start: "2026-09-16T16:00:00.000Z", end: "2026-09-16T16:30:00.000Z" },
      { start: "2026-09-16T16:30:00.000Z", end: "2026-09-16T17:00:00.000Z" },
    ]);
  });

  test("leaves out days that are not working days, and stops at the limit", () => {
    // Friday 2026-09-18 to Tuesday 2026-09-22.
    const slots = freeSlots({
      ...base,
      durationMinutes: 480,
      from: new Date("2026-09-18T00:00:00Z"),
      to: new Date("2026-09-22T23:00:00Z"),
      limit: 2,
    });
    expect(slots.map((s) => s.start)).toEqual([
      "2026-09-18T09:00:00.000Z",
      "2026-09-21T09:00:00.000Z",
    ]);
    const weekend = freeSlots({
      ...base,
      from: new Date("2026-09-19T00:00:00Z"),
      to: new Date("2026-09-21T00:00:00Z"),
    });
    expect(weekend).toEqual([]);
  });

  test("working hours are wall-clock hours in the zone, across a DST change", () => {
    // Europe/Dublin leaves summer time on Sunday 2026-10-25.
    const slots = freeSlots({
      ...base,
      durationMinutes: 60,
      from: new Date("2026-10-23T00:00:00Z"),
      to: new Date("2026-10-27T00:00:00Z"),
      timeZone: "Europe/Dublin",
      busy: [
        { start: "2026-10-23T09:00:00Z", end: "2026-10-23T16:00:00Z" },
        { start: "2026-10-26T10:00:00Z", end: "2026-10-26T17:00:00Z" },
      ],
    });
    expect(slots).toEqual([
      // Friday: 09:00 Irish Summer Time is 08:00Z.
      { start: "2026-10-23T08:00:00.000Z", end: "2026-10-23T09:00:00.000Z" },
      // Monday: 09:00 GMT is 09:00Z.
      { start: "2026-10-26T09:00:00.000Z", end: "2026-10-26T10:00:00.000Z" },
    ]);
  });

  test("a day ending at 24 runs to midnight; nothing fits a day shorter than the slot", () => {
    const late = freeSlots({
      ...base,
      dayStartHour: 22,
      dayEndHour: 24,
      durationMinutes: 120,
      from: new Date("2026-09-16T00:00:00Z"),
      to: new Date("2026-09-17T00:00:00Z"),
    });
    expect(late).toEqual([{ start: "2026-09-16T22:00:00.000Z", end: "2026-09-17T00:00:00.000Z" }]);
    const none = freeSlots({
      ...base,
      durationMinutes: 600,
      from: new Date("2026-09-16T00:00:00Z"),
      to: new Date("2026-09-17T00:00:00Z"),
    });
    expect(none).toEqual([]);
  });
});

function event(fields: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e",
    workspaceId: "w",
    calendarId: "c",
    providerId: "p",
    uid: null,
    title: "",
    description: "",
    location: "",
    start: "2026-09-16T09:00:00.000Z",
    end: "2026-09-16T10:00:00.000Z",
    allDay: false,
    timeZone: "Etc/UTC",
    organizer: null,
    attendees: [],
    link: null,
    status: "confirmed",
    recurrence: null,
    recurringEventId: null,
    response: null,
    createdByAgent: false,
    etag: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...fields,
  };
}

describe("instancesIn and eventMatches", () => {
  test("a series kept here comes as its instances in the window, each with its occurrence", () => {
    const master = event({ id: "m", title: "Gym", recurrence: "FREQ=DAILY;COUNT=10" });
    const single = event({
      id: "s",
      start: "2026-09-18T12:00:00.000Z",
      end: "2026-09-18T13:00:00.000Z",
    });
    const outside = event({
      id: "o",
      start: "2026-10-18T12:00:00.000Z",
      end: "2026-10-18T13:00:00.000Z",
    });
    const found: EventInstance[] = instancesIn([master, single, outside], {
      from: new Date("2026-09-17T00:00:00Z"),
      to: new Date("2026-09-19T00:00:00Z"),
    });
    expect(found.map((i) => [i.event.id, i.start, i.occurrence])).toEqual([
      ["m", "2026-09-17T09:00:00.000Z", "2026-09-17T09:00:00.000Z"],
      ["m", "2026-09-18T09:00:00.000Z", "2026-09-18T09:00:00.000Z"],
      ["s", "2026-09-18T12:00:00.000Z", null],
    ]);
  });

  test("every word must be in the title, place, notes or people", () => {
    const e = event({
      title: "Quarterly review",
      location: "Room 4",
      attendees: [{ name: "Aoife Brennan", email: "aoife@northwind.test", response: "accepted" }],
    });
    expect(eventMatches(e, "review aoife")).toBe(true);
    expect(eventMatches(e, "northwind room")).toBe(true);
    expect(eventMatches(e, "review dentist")).toBe(false);
  });
});
