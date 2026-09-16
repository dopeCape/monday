/// <reference types="bun-types" />
// Snooze presets against a fixed now: Wednesday 16 Sep 2026, 10:17 local.

import { describe, expect, test } from "bun:test";
import { defaultSettings } from "@monday/shared";
import { formatWake, type SnoozeKnobs, snoozeKnobs, snoozeUntil, toLocalInput } from "./snooze.ts";

const now = new Date(2026, 8, 16, 10, 17, 30);
const knobs: SnoozeKnobs = snoozeKnobs(defaultSettings());

describe("snoozeUntil", () => {
  test("the knobs come from Settings with the shipped defaults", () => {
    expect(knobs).toEqual({ laterTodayHours: 3, morningHour: 8, weekStart: 1 });
  });

  test("later today is a few hours on, rounded down to the hour first", () => {
    expect(snoozeUntil("later-today", now, knobs)).toEqual(new Date(2026, 8, 16, 13, 0, 0));
  });

  test("tomorrow morning is the morning hour on the next day", () => {
    expect(snoozeUntil("tomorrow-morning", now, knobs)).toEqual(new Date(2026, 8, 17, 8, 0, 0));
  });

  test("next week is the week start at the morning hour", () => {
    expect(snoozeUntil("next-week", now, knobs)).toEqual(new Date(2026, 8, 21, 8, 0, 0));
  });

  test("next week from the week start day is a full week on", () => {
    const monday = new Date(2026, 8, 14, 9, 0);
    expect(snoozeUntil("next-week", monday, knobs)).toEqual(new Date(2026, 8, 21, 8, 0, 0));
  });

  test("the knobs move the presets", () => {
    const custom: SnoozeKnobs = { laterTodayHours: 1, morningHour: 6, weekStart: 0 };
    expect(snoozeUntil("later-today", now, custom)).toEqual(new Date(2026, 8, 16, 11, 0, 0));
    expect(snoozeUntil("tomorrow-morning", now, custom)).toEqual(new Date(2026, 8, 17, 6, 0, 0));
    expect(snoozeUntil("next-week", now, custom)).toEqual(new Date(2026, 8, 20, 6, 0, 0));
  });

  test("pick a time has no preset value", () => {
    expect(snoozeUntil("pick-a-time", now, knobs)).toBeNull();
  });
});

describe("formatWake", () => {
  test("prints relative to now", () => {
    expect(formatWake(new Date(2026, 8, 16, 13, 0), now)).toBe("13:00");
    expect(formatWake(new Date(2026, 8, 17, 8, 0), now)).toBe("Tomorrow 08:00");
    expect(formatWake(new Date(2026, 8, 21, 8, 0), now)).toBe("Mon 08:00");
    expect(formatWake(new Date(2026, 9, 2, 9, 30), now)).toBe("Oct 2 09:30");
  });
});

describe("toLocalInput", () => {
  test("matches the datetime-local format", () => {
    expect(toLocalInput(new Date(2026, 8, 17, 8, 5))).toBe("2026-09-17T08:05");
  });
});
