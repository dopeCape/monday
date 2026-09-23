// Small pure helpers the components share. No DOM, no React.

/** Joins class names, skipping falsy parts. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** "Aoife Brennan" to "AB". */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** A stable tag color for a name, as a CSS custom property reference. */
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `var(--tag-${1 + (h % 5)})`;
}

/** Who a person is, as far as a row knows: a name that may be empty, an address that may be missing. */
export interface NamedPerson {
  name?: string | null | undefined;
  email?: string | null | undefined;
}

const NAME_PART = /^\p{L}[\p{L}'’]*$/u;

/**
 * The name to show for a person, never empty while there is anything to
 * show: their own name; else the address's local part, prettified when it
 * reads like a name ("aoife.byrne@x.dev" is "Aoife Byrne") and as written
 * when it does not ("noreply", "j2"); else the full address. A name that is
 * just the address again counts as none. `fallback` covers a person with
 * neither.
 */
export function personName(person: NamedPerson | null | undefined, fallback = ""): string {
  const email = person?.email?.trim() ?? "";
  const name =
    person?.name
      ?.trim()
      .replace(/^["']+|["']+$/g, "")
      .trim() ?? "";
  if (name && name.toLowerCase() !== email.toLowerCase()) return name;
  const at = email.lastIndexOf("@");
  const local = (at >= 0 ? email.slice(0, at) : email).trim();
  if (!local) return email || fallback;
  const parts = local.replace(/\+.*$/, "").split(/[._-]+/);
  if (parts.length >= 2 && parts.every((w) => NAME_PART.test(w))) {
    return parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  }
  return local;
}

/**
 * Splits text around the places any of `terms` occurs, ignoring case, so a
 * row can mark what a search matched. Overlapping matches merge.
 */
export function highlightParts(
  text: string,
  terms: readonly string[] | undefined,
): Array<{ text: string; hit: boolean }> {
  const words = (terms ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!text || words.length === 0) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const hits = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    for (let at = lower.indexOf(w); at >= 0; at = lower.indexOf(w, at + 1)) {
      for (let i = at; i < at + w.length; i++) hits[i] = true;
    }
  }
  const out: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < text.length; ) {
    const hit = hits[i] as boolean;
    let j = i;
    while (j < text.length && hits[j] === hit) j++;
    out.push({ text: text.slice(i, j), hit });
    i = j;
  }
  return out;
}

export function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
}

export function clock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function dayLabel(d: Date, now: Date): string {
  const days = daysBetween(d, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return WEEKDAYS[d.getDay()] ?? "";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** List time: "09:41" today, "Yesterday", "Mon" this week, "Sep 5" otherwise. */
export function formatListTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const label = dayLabel(d, now);
  return label === "Today" ? clock(d) : label;
}

/** Reader time: "Today 09:41", "Yesterday 17:20", "Mon 14:02", "Sep 5 16:00". */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${dayLabel(d, now)} ${clock(d)}`;
}

/** 214 KB, 1.9 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Splits plain text into paragraphs on blank lines. */
export function paragraphs(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The first line of a body, for collapsed messages. */
export function preview(text: string | undefined): string {
  return paragraphs(text)[0]?.split("\n")[0] ?? "";
}

/** React keys for items that carry no id: the text, numbered when it repeats. */
export function uniqueKeys(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((t) => {
    const count = seen.get(t) ?? 0;
    seen.set(t, count + 1);
    return count ? `${t} ${count + 1}` : t;
  });
}

/** "search_mail" to "Search mail". */
export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Thu 18 Sep" for a day; "Thu 18 Sep, 15:00 to 15:45" for a timed span (slice 18). */
export function formatSpan(startIso: string, endIso: string, allDay: boolean): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime())) return "";
  const day = (d: Date) => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (allDay) {
    // An all-day span ends at midnight of the day after its last day.
    const last = new Date(e.getTime() - 1);
    const sameDay = Number.isNaN(e.getTime()) || startOfDay(s) === startOfDay(last);
    return sameDay ? day(s) : `${day(s)} to ${day(last)}`;
  }
  const sameDay = startOfDay(s) === startOfDay(e);
  return sameDay
    ? `${day(s)}, ${clock(s)} to ${clock(e)}`
    : `${day(s)} ${clock(s)} to ${day(e)} ${clock(e)}`;
}

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "September 2026". */
export function formatMonth(d: Date): string {
  return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Thursday 18" for the Agenda's day headings. */
export function formatDayHeading(d: Date, now: Date = new Date()): string {
  const long = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const days = daysBetween(now, d);
  const prefix = days === 0 ? "Today, " : days === 1 ? "Tomorrow, " : "";
  return `${prefix}${long[d.getDay()]} ${d.getDate()}`;
}

export const WEEKDAY_SHORT = WEEKDAYS;
export const MONTH_SHORT = MONTHS;
