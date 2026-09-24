// The editor's "Repeat" choices and the words a detail shows for a rule:
// each preset is an RRULE value built from the Event's start, and any rule
// is read back into the preset it matches, or "custom". Words come from the
// strings.calendar.repeat.* Settings. Pure.

import type { Settings } from "@monday/shared";
import { parseRRule, splitRecurrence } from "@monday/shared";
import { MONTH_SHORT, WEEKDAY_SHORT } from "@monday/ui";

export type RepeatPreset =
  | "none"
  | "daily"
  | "weekdays"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "yearly"
  | "custom";

export const REPEAT_PRESETS: readonly RepeatPreset[] = [
  "none",
  "daily",
  "weekdays",
  "weekly",
  "biweekly",
  "monthly",
  "yearly",
  "custom",
];

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** The RRULE value a preset makes for an Event starting at `start`; null for none, the given rule for custom. */
export function ruleFor(preset: RepeatPreset, start: Date, custom = ""): string | null {
  switch (preset) {
    case "none":
      return null;
    case "daily":
      return "FREQ=DAILY";
    case "weekdays":
      return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
    case "weekly":
      return `FREQ=WEEKLY;BYDAY=${BYDAY[start.getDay()]}`;
    case "biweekly":
      return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${BYDAY[start.getDay()]}`;
    case "monthly":
      return `FREQ=MONTHLY;BYMONTHDAY=${start.getDate()}`;
    case "yearly":
      return "FREQ=YEARLY";
    case "custom":
      return custom.trim().replace(/^RRULE:/i, "") || null;
  }
}

/** The preset a rule matches for an Event starting at `start`. */
export function presetOf(value: string | null, start: Date): RepeatPreset {
  if (!value) return "none";
  const { rule } = splitRecurrence(value);
  const parsed = parseRRule(rule);
  if (!parsed || parsed.count !== null || parsed.until !== null) return "custom";
  for (const p of REPEAT_PRESETS) {
    if (p === "none" || p === "custom") continue;
    const made = ruleFor(p, start);
    if (made && sameRule(made, rule)) return p;
  }
  // A weekly rule without BYDAY repeats on the start's weekday.
  if (sameRule(rule, "FREQ=WEEKLY")) return "weekly";
  if (sameRule(rule, `FREQ=MONTHLY`)) return "monthly";
  return "custom";
}

function sameRule(a: string, b: string): boolean {
  const norm = (r: string) =>
    r
      .toUpperCase()
      .split(";")
      .filter((p) => p && p !== "INTERVAL=1")
      .sort()
      .join(";");
  return norm(a) === norm(b);
}

/** A rule in words: "Every weekday", "Every 2 weeks on Mon, Wed", "Monthly on day 3, 5 times". */
export function describeRule(value: string, s: Settings): string {
  const { rule } = splitRecurrence(value);
  const r = parseRRule(rule);
  if (!r) return s["strings.calendar.repeat.custom"];
  const fill = (t: string, vars: Record<string, string | number>) =>
    t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
  let base: string;
  const days = r.byDay.map((d) => WEEKDAY_SHORT[d]).join(", ");
  const weekdays = r.byDay.length === 5 && [1, 2, 3, 4, 5].every((d) => r.byDay.includes(d));
  if (r.freq === "DAILY") {
    if (weekdays && r.interval === 1) base = s["strings.calendar.repeat.weekdays"];
    else if (r.byDay.length > 0 && r.interval === 1)
      base = fill(s["strings.calendar.repeat.weekly_on"], { days });
    else
      base =
        r.interval > 1
          ? fill(s["strings.calendar.repeat.every_n_days"], { n: r.interval })
          : s["strings.calendar.repeat.daily"];
  } else if (r.freq === "WEEKLY") {
    if (weekdays && r.interval === 1) base = s["strings.calendar.repeat.weekdays"];
    else if (r.interval > 1)
      base = fill(s["strings.calendar.repeat.every_n_weeks_on"], {
        n: r.interval,
        days: days || "",
      });
    else
      base = days
        ? fill(s["strings.calendar.repeat.weekly_on"], { days })
        : s["strings.calendar.repeat.weekly"];
  } else if (r.freq === "MONTHLY") {
    base = r.byMonthDay.length
      ? fill(s["strings.calendar.repeat.monthly_on"], { day: r.byMonthDay.join(", ") })
      : s["strings.calendar.repeat.monthly"];
  } else {
    base = s["strings.calendar.repeat.yearly"];
  }
  if (r.count !== null) return fill(s["strings.calendar.repeat.times"], { rule: base, n: r.count });
  if (r.until) {
    const u = r.until;
    return fill(s["strings.calendar.repeat.until"], {
      rule: base,
      date: `${u.getUTCDate()} ${MONTH_SHORT[u.getUTCMonth()]} ${u.getUTCFullYear()}`,
    });
  }
  return base;
}
