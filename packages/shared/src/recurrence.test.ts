/// <reference types="bun-types" />
// The recurrence value helpers the calendar's "this event / this and
// following / all events" writes use: exclusions carried as EXDATE lines,
// a series cut before an instance, and the expander honouring both.

import { describe, expect, test } from "bun:test";
import {
  expandRecurrence,
  joinRecurrence,
  recurrenceFrom,
  recurrenceUntil,
  splitRecurrence,
  withExdate,
} from "./calendar.ts";

const start = new Date("2026-09-14T07:00:00Z");
const end = new Date("2026-09-14T07:30:00Z");
const window = { from: new Date("2026-09-13T00:00:00Z"), to: new Date("2026-09-21T00:00:00Z") };

describe("recurrence values", () => {
  test("a plain rule has no exclusions; an EXDATE line adds them and round-trips", () => {
    expect(splitRecurrence("FREQ=DAILY")).toEqual({ rule: "FREQ=DAILY", exdates: [] });
    const value = withExdate("FREQ=DAILY", new Date("2026-09-16T07:00:00Z"));
    expect(value).toBe("FREQ=DAILY\nEXDATE:20260916T070000Z");
    const split = splitRecurrence(value);
    expect(split.rule).toBe("FREQ=DAILY");
    expect(split.exdates.map((d) => d.toISOString())).toEqual(["2026-09-16T07:00:00.000Z"]);
    expect(joinRecurrence(split.rule, split.exdates)).toBe(value);
  });

  test("the expander leaves out the excluded instance", () => {
    const value = withExdate("FREQ=DAILY;COUNT=5", new Date("2026-09-16T07:00:00Z"));
    const out = expandRecurrence(value, start, end, "Etc/UTC", window);
    expect(out.map((o) => o.start.toISOString().slice(0, 10))).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-17",
      "2026-09-18",
    ]);
  });

  test("cutting a series before an instance drops COUNT for UNTIL and later exclusions", () => {
    const value = joinRecurrence("FREQ=DAILY;COUNT=10", [
      new Date("2026-09-15T07:00:00Z"),
      new Date("2026-09-19T07:00:00Z"),
    ]);
    const cut = recurrenceUntil(value, new Date("2026-09-17T07:00:00Z"));
    expect(cut).toBe("FREQ=DAILY;UNTIL=20260917T065959Z\nEXDATE:20260915T070000Z");
    const out = expandRecurrence(cut, start, end, "Etc/UTC", window);
    expect(out.map((o) => o.start.toISOString().slice(0, 10))).toEqual([
      "2026-09-14",
      "2026-09-16",
    ]);
    expect(recurrenceUntil("FREQ=WEEKLY", new Date("2026-09-17T00:00:00Z"), true)).toBe(
      "FREQ=WEEKLY;UNTIL=20260916",
    );
  });

  test("a series starting again keeps the rule without its end", () => {
    expect(recurrenceFrom("FREQ=WEEKLY;BYDAY=MO;COUNT=4\nEXDATE:20260921T070000Z")).toBe(
      "FREQ=WEEKLY;BYDAY=MO",
    );
  });
});
