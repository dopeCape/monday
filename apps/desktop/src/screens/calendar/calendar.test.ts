/// <reference types="bun-types" />
// The Calendar's pure modules through their interfaces: overlapping Events
// laid out side by side, the all-day lanes, all-day dates that never shift
// with the Device's offset, month weeks, search, colours, the palette's
// date reading, the Draft's instants and patches, and repeat rules in words.

import { describe, expect, test } from "bun:test";
import type { CalendarEvent } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import type { Occurrence } from "./calendar-data.ts";
import { aimAt } from "./calendar-data.ts";
import { allDayIso, coveredDays, isoWeek, nextSlot, touchesDay } from "./dates.ts";
import { draftForSlot, draftOf, draftProblem, inputOf, patchOf, withStart } from "./draft.ts";
import { parseJumpDate } from "./jump.ts";
import {
  allDayLanes,
  calendarColors,
  inAllDayRow,
  layoutDay,
  monthWeeks,
  searchOccurrences,
} from "./layout.ts";
import { canAnswer, guestsOf, isOwn, parsePeople } from "./model.ts";
import { describeRule, presetOf, ruleFor } from "./repeat.ts";

const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m).toISOString();

function occ(over: Partial<Occurrence> & { key: string; start: string; end: string }): Occurrence {
  const base: CalendarEvent = {
    id: over.key,
    workspaceId: "ws",
    calendarId: "cal",
    providerId: over.key,
    uid: null,
    title: over.key,
    description: "",
    location: "",
    start: over.start,
    end: over.end,
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
  return { ...base, instanceStart: null, ...over };
}

describe("layout", () => {
  test("overlapping Events share the column; a free one keeps it whole; one widens into free columns", () => {
    const day = new Date(2026, 8, 17);
    const placed = layoutDay(
      [
        occ({ key: "a", start: at(17, 9), end: at(17, 11) }),
        occ({ key: "b", start: at(17, 9, 30), end: at(17, 10) }),
        occ({ key: "c", start: at(17, 10, 30), end: at(17, 11, 30) }),
        occ({ key: "d", start: at(17, 14), end: at(17, 15) }),
      ],
      day,
    );
    const by = Object.fromEntries(placed.map((p) => [p.occ.key, p]));
    expect(by.a?.left).toBe(0);
    expect(by.a?.width).toBe(0.5);
    expect(by.b?.left).toBe(0.5);
    expect(by.c?.left).toBe(0.5);
    expect(by.d?.width).toBe(1);
    expect(by.a?.top).toBe(9 * 60);
    expect(by.a?.bottom).toBe(11 * 60);
  });

  test("an Event crossing midnight is clipped on each day it touches", () => {
    const late = occ({ key: "late", start: at(17, 22), end: at(18, 2) });
    const first = layoutDay([late], new Date(2026, 8, 17))[0];
    const second = layoutDay([late], new Date(2026, 8, 18))[0];
    expect(first?.bottom).toBe(24 * 60);
    expect(first?.clippedEnd).toBe(true);
    expect(second?.top).toBe(0);
    expect(second?.bottom).toBe(120);
    expect(second?.clippedStart).toBe(true);
  });

  test("all-day and day-long Events go on the all-day row, stacked in lanes across the days they cover", () => {
    const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 14 + i));
    const trip = occ({
      key: "trip",
      start: allDayIso(new Date(2026, 8, 13)),
      end: allDayIso(new Date(2026, 8, 16)),
      allDay: true,
    });
    const offsite = occ({
      key: "offsite",
      start: allDayIso(new Date(2026, 8, 15)),
      end: allDayIso(new Date(2026, 8, 16)),
      allDay: true,
    });
    const conf = occ({ key: "conf", start: at(16, 9), end: at(18, 17) });
    expect(inAllDayRow(conf)).toBe(true);
    const lanes = allDayLanes([trip, offsite, conf], days);
    const by = Object.fromEntries(lanes.map((l) => [l.occ.key, l]));
    expect(by.trip).toMatchObject({ from: 0, to: 1, lane: 0, continuesBefore: true });
    expect(by.offsite).toMatchObject({ from: 1, to: 1, lane: 1 });
    expect(by.conf).toMatchObject({ from: 2, to: 4, lane: 0 });
  });

  test("an all-day Event covers its dates whatever the Device's offset", () => {
    const e = { start: "2026-09-19T00:00:00.000Z", end: "2026-09-20T00:00:00.000Z", allDay: true };
    const { first, last } = coveredDays(e);
    expect(first.getDate()).toBe(19);
    expect(last.getDate()).toBe(19);
    expect(touchesDay(e, new Date(2026, 8, 18))).toBe(false);
    expect(touchesDay(e, new Date(2026, 8, 19))).toBe(true);
  });

  test("month weeks run whole weeks from the one holding the 1st; ISO week numbers", () => {
    const weeks = monthWeeks(new Date(2026, 8, 17), true);
    expect(weeks[0]?.[0]?.getDate()).toBe(31);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks.length).toBe(5);
    expect(isoWeek(new Date(2026, 8, 17))).toBe(38);
    expect(isoWeek(new Date(2027, 0, 1))).toBe(53);
  });

  test("search matches every word across title, place and people", () => {
    const list = [
      occ({
        key: "podcast",
        start: at(18, 13),
        end: at(18, 14),
        title: "Podcast",
        location: "Studio B",
        attendees: [{ name: "Sofia Lindqvist", email: "sofia@x.test", response: "accepted" }],
      }),
      occ({ key: "focus", start: at(17, 13), end: at(17, 15), title: "Focus" }),
    ];
    expect(searchOccurrences(list, "sofia studio").map((o) => o.key)).toEqual(["podcast"]);
    expect(searchOccurrences(list, "")).toEqual([]);
  });

  test("colours: the user's choice, else the Provider's, else a palette token by place", () => {
    const colors = calendarColors(
      [
        { id: "a", color: "#9fe1e7" },
        { id: "b", color: null },
        { id: "c", color: "#123456" },
      ],
      { c: "tag-4" },
    );
    expect(colors.get("a")).toBe("#9fe1e7");
    expect(colors.get("b")).toBe("var(--tag-2)");
    expect(colors.get("c")).toBe("var(--tag-4)");
  });
});

describe("jump to date", () => {
  const now = new Date(2026, 8, 17, 14, 20); // a Thursday
  const key = (d: Date | null) =>
    d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : null;
  test("words, weekdays, day and month in either order, numbers day first", () => {
    expect(key(parseJumpDate("today", now))).toBe("2026-9-17");
    expect(key(parseJumpDate("tomorrow", now))).toBe("2026-9-18");
    expect(key(parseJumpDate("fri", now))).toBe("2026-9-18");
    expect(key(parseJumpDate("thursday", now))).toBe("2026-9-17");
    expect(key(parseJumpDate("next thu", now))).toBe("2026-9-24");
    expect(key(parseJumpDate("3 oct", now))).toBe("2026-10-3");
    expect(key(parseJumpDate("October 3 2027", now))).toBe("2027-10-3");
    expect(key(parseJumpDate("2026-12-01", now))).toBe("2026-12-1");
    expect(key(parseJumpDate("3/10", now))).toBe("2026-10-3");
    expect(key(parseJumpDate("3/10", now, true))).toBe("2027-3-10");
    expect(key(parseJumpDate("jan 5", now))).toBe("2027-1-5");
    expect(key(parseJumpDate("in 2 weeks", now))).toBe("2026-10-1");
  });
  test("text that is not a date is left alone", () => {
    expect(parseJumpDate("archive", now)).toBeNull();
    expect(parseJumpDate("decide on budget", now)).toBeNull();
    expect(parseJumpDate("31/2", now)).toBeNull();
    expect(parseJumpDate("t", now)).toBeNull();
  });
});

describe("the Draft", () => {
  test("a slot in a zone becomes instants; the start carries the end along", () => {
    const d = draftForSlot(
      { start: new Date(2026, 8, 17, 15), end: new Date(2026, 8, 17, 15, 45), allDay: false },
      "cal",
      "Europe/Dublin",
    );
    const input = inputOf({ ...d, title: "Call" });
    expect(input?.timeZone).toBe("Europe/Dublin");
    expect(Date.parse(input?.end ?? "") - Date.parse(input?.start ?? "")).toBe(45 * 60_000);
    const later = withStart(d, d.startDate, "08:00");
    expect(later.endTime).toBe("08:45");
    const t = inputOf(later);
    expect(Date.parse(t?.end ?? "") - Date.parse(t?.start ?? "")).toBe(45 * 60_000);
    expect(draftProblem({ ...d, endTime: "14:00", endDate: d.startDate, startTime: "15:00" })).toBe(
      "end_before_start",
    );
    expect(draftProblem({ ...d, startTime: "25:99" })).toBe("bad_time");
  });

  test("an all-day Draft ends at the midnight after its last day", () => {
    const d = draftForSlot(
      { start: new Date(2026, 8, 19), end: new Date(2026, 8, 20), allDay: true },
      "cal",
    );
    const input = inputOf(d);
    expect(input?.start).toBe("2026-09-19T00:00:00.000Z");
    expect(input?.end).toBe("2026-09-20T00:00:00.000Z");
    expect(input?.timeZone).toBeNull();
  });

  test("the patch holds only what changed", () => {
    const o = occ({
      key: "e",
      start: at(17, 9),
      end: at(17, 10),
      title: "Review",
      timeZone: "Europe/Dublin",
      attendees: [{ name: "K", email: "k@x.test", response: "accepted" }],
    });
    const before = draftOf(o, "Europe/Dublin");
    expect(patchOf(before, before)).toEqual({});
    const after = {
      ...before,
      title: "Design review",
      attendees: [...before.attendees, { name: "", email: "m@x.test" }],
    };
    const patch = patchOf(after, before);
    expect(Object.keys(patch ?? {}).sort()).toEqual(["attendees", "title"]);
  });
});

describe("repeat", () => {
  const s = defaultSettings();
  const thu = new Date(2026, 8, 17);
  test("presets make rules from the start and read them back", () => {
    expect(ruleFor("weekly", thu)).toBe("FREQ=WEEKLY;BYDAY=TH");
    expect(ruleFor("monthly", thu)).toBe("FREQ=MONTHLY;BYMONTHDAY=17");
    expect(presetOf("FREQ=WEEKLY;BYDAY=TH", thu)).toBe("weekly");
    expect(presetOf("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", thu)).toBe("weekdays");
    expect(presetOf("FREQ=DAILY;COUNT=3", thu)).toBe("custom");
    expect(presetOf(null, thu)).toBe("none");
  });
  test("rules in words", () => {
    expect(describeRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", s)).toBe("Every 2 weeks on Mon, Wed");
    expect(describeRule("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", s)).toBe("Every weekday");
    expect(describeRule("FREQ=MONTHLY;BYMONTHDAY=3;COUNT=5", s)).toBe(
      "Every month on day 3, 5 times",
    );
    expect(describeRule("FREQ=YEARLY;UNTIL=20300101T000000Z", s)).toBe(
      "Every year, until 1 Jan 2030",
    );
  });
});

describe("whose Event", () => {
  const addressOf = () => "tejas@genai-labs.io";
  test("own, guests, and who may answer", () => {
    const mine = occ({
      key: "m",
      start: at(17, 9),
      end: at(17, 10),
      organizer: { name: "Tejas", email: "tejas@genai-labs.io" },
      attendees: [
        { name: "Tejas", email: "tejas@genai-labs.io", response: "accepted", self: true },
        { name: "Aoife", email: "aoife@x.test", response: "needs-action" },
      ],
    });
    expect(isOwn(mine, addressOf)).toBe(true);
    expect(guestsOf(mine, addressOf).map((p) => p.email)).toEqual(["aoife@x.test"]);
    expect(canAnswer(mine, addressOf)).toBe(false);
    const theirs = {
      ...mine,
      organizer: { name: "Sofia", email: "sofia@x.test" },
      response: "needs-action" as const,
    };
    expect(isOwn(theirs, addressOf)).toBe(false);
    expect(canAnswer(theirs, addressOf)).toBe(true);
  });
  test("people from typed text", () => {
    expect(
      parsePeople('Kenji <kenji@m.test>, bob@y.test; not-an-address, "Bob" <BOB@y.test>'),
    ).toEqual([
      { name: "Kenji", email: "kenji@m.test" },
      { name: "", email: "bob@y.test" },
    ]);
  });
  test("a write aims at an instance: the scope, and the instance start for an expanded master", () => {
    const master = occ({
      key: "s@x",
      start: at(17, 9),
      end: at(17, 10),
      recurrence: "FREQ=DAILY",
      instanceStart: at(17, 9),
    });
    expect(aimAt(master, "this")).toEqual({ scope: "this", occurrence: at(17, 9) });
    const single = occ({ key: "one", start: at(17, 9), end: at(17, 10) });
    expect(aimAt(single, "all")).toEqual({});
    expect(nextSlot(new Date(2026, 8, 17, 14, 20), 15).getMinutes()).toBe(30);
  });
});
