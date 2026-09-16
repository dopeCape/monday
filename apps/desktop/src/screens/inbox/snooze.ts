// Snooze presets to wake times. Pure: takes "now" so tests pin it.
// The presets and their knobs are Settings (docs/spec/inbox.md, ADR 0004).

import type { Settings } from "@monday/shared";

export type SnoozePreset = Settings["inbox.snooze_presets"][number];

export interface SnoozeKnobs {
  laterTodayHours: number;
  morningHour: number;
  weekStart: number;
}

export function snoozeKnobs(settings: Settings): SnoozeKnobs {
  return {
    laterTodayHours: settings["inbox.snooze.later_today_hours"],
    morningHour: settings["inbox.snooze.morning_hour"],
    weekStart: settings["inbox.snooze.week_start"],
  };
}

/** The wake time a preset means, relative to now. "pick-a-time" has none. */
export function snoozeUntil(preset: SnoozePreset, now: Date, knobs: SnoozeKnobs): Date | null {
  switch (preset) {
    case "later-today": {
      const d = new Date(now.getTime());
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() + knobs.laterTodayHours);
      return d;
    }
    case "tomorrow-morning": {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      d.setHours(knobs.morningHour, 0, 0, 0);
      return d;
    }
    case "next-week": {
      const days = (knobs.weekStart - now.getDay() + 7) % 7 || 7;
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
      d.setHours(knobs.morningHour, 0, 0, 0);
      return d;
    }
    case "pick-a-time":
      return null;
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "18:00" today, "Tomorrow 08:00", "Mon 08:00" within a week, "Sep 30 08:00" beyond. */
export function formatWake(until: Date, now: Date): string {
  const hh = String(until.getHours()).padStart(2, "0");
  const mm = String(until.getMinutes()).padStart(2, "0");
  const time = `${hh}:${mm}`;
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(until) - start(now)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[until.getDay()]} ${time}`;
  return `${MONTHS[until.getMonth()]} ${until.getDate()} ${time}`;
}

/** A Date as the value a datetime-local input takes: "2026-09-16T18:00". */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
