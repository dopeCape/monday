// "Jump to date" for the command palette: reads a typed date ("tomorrow",
// "fri", "next monday", "3 oct", "oct 3 2027", "2026-10-03", "3/10") into a
// local day, or null when the text is not a date. Pure: the palette offers
// the row and the Calendar opens on the day.

import { addDays, fromDayKey, startOfDay } from "./dates.ts";

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function monthOf(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return -1;
  if (w === "sept") return 8;
  return MONTHS.findIndex((m) => m.startsWith(w));
}

function weekdayOf(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 2) return -1;
  const found = WEEKDAYS.filter((d) => d.startsWith(w));
  return found.length === 1 ? WEEKDAYS.indexOf(found[0] as string) : -1;
}

function valid(y: number, m: number, d: number): Date | null {
  const out = new Date(y, m, d);
  return out.getMonth() === m && out.getDate() === d ? out : null;
}

/** A month and day without a year: this year, or next year once it has passed. */
function nearest(now: Date, m: number, d: number): Date | null {
  const today = startOfDay(now);
  const here = valid(now.getFullYear(), m, d);
  if (here && here.getTime() >= addDays(today, -31).getTime()) return here;
  return valid(now.getFullYear() + 1, m, d);
}

/**
 * The local day a text names, or null. Day-first for numeric dates
 * ("3/10" is 3 October) unless `monthFirst`.
 */
export function parseJumpDate(text: string, now: Date, monthFirst = false): Date | null {
  const t = text.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!t) return null;
  const today = startOfDay(now);
  if (t === "today" || t === "now") return today;
  if (t === "tomorrow" || t === "tmr") return addDays(today, 1);
  if (t === "yesterday") return addDays(today, -1);
  const iso = fromDayKey(t);
  if (iso) return iso;

  let m = /^(next|last|this)?\s?([a-z]+)$/.exec(t);
  if (m?.[2]) {
    const wd = weekdayOf(m[2]);
    if (wd >= 0) {
      let diff = (wd - today.getDay() + 7) % 7;
      if (m[1] === "next" && diff === 0) diff = 7;
      if (m[1] === "last") diff = diff === 0 ? -7 : diff - 7;
      return addDays(today, diff);
    }
    const mo = monthOf(m[2]);
    if (mo >= 0 && !m[1]) return nearest(now, mo, 1);
  }

  m = /^in (\d{1,3}) (day|days|week|weeks)$/.exec(t);
  if (m) return addDays(today, Number(m[1]) * (m[2]?.startsWith("week") ? 7 : 1));

  // "3 oct", "3 oct 2027", "oct 3", "october 3 2027"
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z.]+)(?: (\d{4}))?$/.exec(t);
  if (m) {
    const mo = monthOf(m[2] ?? "");
    if (mo < 0) return null;
    return m[3] ? valid(Number(m[3]), mo, Number(m[1])) : nearest(now, mo, Number(m[1]));
  }
  m = /^([a-z.]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(t);
  if (m) {
    const mo = monthOf(m[1] ?? "");
    if (mo < 0) return null;
    return m[3] ? valid(Number(m[3]), mo, Number(m[2])) : nearest(now, mo, Number(m[2]));
  }
  // "oct 2027"
  m = /^([a-z.]+) (\d{4})$/.exec(t);
  if (m) {
    const mo = monthOf(m[1] ?? "");
    return mo < 0 ? null : valid(Number(m[2]), mo, 1);
  }
  // "3/10", "3/10/2027", "3.10.27"
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [d, mo] = monthFirst ? [b, a - 1] : [a, b - 1];
    if (!m[3]) return nearest(now, mo, d);
    const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    return valid(y, mo, d);
  }
  return null;
}
