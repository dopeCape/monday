// Candidates for Placeholders (docs/spec/templates.md, "Filling Placeholders
// from the Thread", step 1; the pre-parsed value extraction cookbook). Code
// finds every span a Placeholder's type could take from the Thread's text and
// headers, tuned to over-find; the judge only picks among them, and code
// copies the pick verbatim and normalizes it by type. A value is never
// invented: it is always one of these spans.

import type { Person } from "../domain.ts";
import { ownWords, splitSentences } from "./text.ts";
import type { PlaceholderCandidate, PlaceholderType } from "./types.ts";

/** One Message of the Thread as the finders read it. */
export interface FillMessage {
  from: Person;
  to: Person[];
  cc: Person[];
  /** Plain text; quoted history is dropped by the finders. */
  text: string;
}

/** What candidates come from: the Thread's Messages oldest first, and who the owner is. */
export interface FillThread {
  subject: string;
  messages: FillMessage[];
  /** The owner's addresses, lowercased: never a candidate for a person, a name or an address. */
  owner: string[];
  /** Deadline spans a Signal request already found (deadline_* parts), when present. */
  deadlines?: string[] | undefined;
}

export interface NormalizeOptions {
  /** How a full date is written: "d MMMM", "MMMM d", "yyyy-MM-dd", "d/M/yyyy" or "M/d/yyyy". */
  dateFormat: string;
  /** How a time is written: "24h" (15:00) or "12h" (3:00 pm). */
  timeFormat: "24h" | "12h";
}

export const DEFAULT_NORMALIZE: NormalizeOptions = { dateFormat: "d MMMM", timeFormat: "24h" };

/* ------------------------------ Patterns ------------------------------ */

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
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const WEEKDAY = "(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?";
const ORD = "(?:st|nd|rd|th)?";

const DATE_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(?:${WEEKDAY},?\\s+)?\\d{1,2}${ORD}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+\\d{4})?\\b`,
    "gi",
  ),
  new RegExp(`\\b(?:${WEEKDAY},?\\s+)?${MONTH}\\s+\\d{1,2}${ORD}(?:,?\\s+\\d{4})?\\b`, "gi"),
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}[/.]\d{1,2}[/.](?:\d{4}|\d{2})\b/g,
  new RegExp(`\\b(?:next\\s+|this\\s+)?${WEEKDAY}\\b`, "gi"),
  /\b(?:today|tomorrow|tonight|next week|end of (?:the )?(?:day|week|month))\b/gi,
];

const TIME_PATTERNS: RegExp[] = [
  /\b(?:[01]?\d|2[0-3])[:.][0-5]\d(?:\s?(?:am|pm|a\.m\.|p\.m\.))?(?![\d.,])/gi,
  /\b(?:1[0-2]|0?[1-9])\s?(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/gi,
  /\b(?:noon|midday|midnight)\b/gi,
];

const CURRENCY_CODES = "USD|EUR|GBP|SEK|NOK|DKK|CHF|JPY|CAD|AUD|NZD|INR|kr";
const AMOUNT_PATTERNS: RegExp[] = [
  /[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?(?!\d)/g,
  new RegExp(`\\b(?:${CURRENCY_CODES})\\s?\\d[\\d,]*(?:\\.\\d{1,2})?(?!\\d)`, "g"),
  new RegExp(`\\b\\d[\\d,]*(?:\\.\\d{1,2})?\\s?(?:${CURRENCY_CODES})\\b`, "g"),
];

const REFERENCE_PATTERNS: RegExp[] = [
  /\b[A-Z]{2,6}[-_]?\d{2,}[A-Z0-9-]*\b/g,
  /#\d{3,}\b/g,
  /\b(?:invoice|order|ticket|ref(?:erence)?|case|booking|po)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,})\b/gi,
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LINK_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const NUMBER_PATTERN = /(?<![\w.,$€£¥#-])\d[\d,]*(?:\.\d+)?(?![\w%])/g;

interface Span {
  text: string;
  start: number;
  end: number;
}

/** Every match of every pattern, longest first where two overlap, in text order. */
function spans(text: string, patterns: readonly RegExp[], group = false): Span[] {
  const found: Span[] = [];
  for (const pattern of patterns) {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const whole = m[0];
      const inner = group && m[1] ? m[1] : whole;
      const start = (m.index ?? 0) + whole.indexOf(inner);
      found.push({ text: inner.trim(), start, end: start + inner.length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  for (const s of found) {
    if (kept.some((k) => s.start >= k.start && s.end <= k.end)) continue;
    for (let i = kept.length - 1; i >= 0; i--) {
      const k = kept[i];
      if (k && k.start >= s.start && k.end <= s.end) kept.splice(i, 1);
    }
    kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

const overlaps = (a: Span, others: readonly Span[]) =>
  others.some((o) => a.start < o.end && o.start < a.end);

/* ------------------------------ Normalizing ------------------------------ */

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  return MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
}

/** A written date's day, month and (when given) year, or null for a relative one. */
export function parseDateSpan(
  span: string,
): { day: number; month: number; year: number | null } | null {
  const s = span.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) };
  m = new RegExp(`(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MONTH})(?:,?\\s+(\\d{4}))?$`, "i").exec(s);
  if (m) {
    const month = monthIndex(m[2] ?? "");
    if (month >= 0) return { day: Number(m[1]), month, year: m[3] ? Number(m[3]) : null };
  }
  m = new RegExp(`(${MONTH})\\s+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?$`, "i").exec(s);
  if (m) {
    const month = monthIndex(m[1] ?? "");
    if (month >= 0) return { day: Number(m[2]), month, year: m[3] ? Number(m[3]) : null };
  }
  return null;
}

const cap = (w: string) => (w ? w[0]?.toUpperCase() + w.slice(1) : w);

function formatDate(
  d: { day: number; month: number; year: number | null },
  format: string,
): string | null {
  const needsYear = /y/.test(format);
  if (needsYear && d.year === null) return null;
  const month = MONTHS[d.month] ?? "";
  return format.replace(/yyyy|MMMM|MMM|MM|M|dd|d/g, (token) => {
    switch (token) {
      case "yyyy":
        return String(d.year ?? "");
      case "MMMM":
        return cap(month);
      case "MMM":
        return cap(month.slice(0, 3));
      case "MM":
        return String(d.month + 1).padStart(2, "0");
      case "M":
        return String(d.month + 1);
      case "dd":
        return String(d.day).padStart(2, "0");
      default:
        return String(d.day);
    }
  });
}

/** A written time as hours and minutes, or null for noon and friends it cannot read. */
export function parseTimeSpan(span: string): { hour: number; minute: number } | null {
  const s = span.trim().toLowerCase();
  if (s === "noon" || s === "midday") return { hour: 12, minute: 0 };
  if (s === "midnight") return { hour: 0, minute: 0 };
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const half = m[3]?.replaceAll(".", "");
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function formatTime(t: { hour: number; minute: number }, format: "24h" | "12h"): string {
  const mm = String(t.minute).padStart(2, "0");
  if (format === "24h") return `${String(t.hour).padStart(2, "0")}:${mm}`;
  const half = t.hour >= 12 ? "pm" : "am";
  const h = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${h}:${mm} ${half}`;
}

/** The first word of a display name, for `first_name`. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0]?.replace(/[,;]$/, "") ?? "";
}

/**
 * A picked span as the Message writes it (docs/spec/templates.md: "a date or
 * time in the user's format, an amount with its currency, a first_name as
 * the first word of a display name"). A span code cannot read stays verbatim.
 */
export function normalizeValue(
  type: PlaceholderType,
  span: string,
  options: NormalizeOptions = DEFAULT_NORMALIZE,
): string {
  const s = span.replace(/\s+/g, " ").trim();
  switch (type) {
    case "first_name":
      return firstNameOf(s);
    case "email":
      return s.toLowerCase();
    case "date": {
      const parsed = parseDateSpan(s);
      return (parsed && formatDate(parsed, options.dateFormat)) ?? s;
    }
    case "time": {
      const parsed = parseTimeSpan(s);
      return parsed ? formatTime(parsed, options.timeFormat) : s;
    }
    case "link":
      return s.replace(/[.,;:!?]+$/, "");
    default:
      return s;
  }
}

/* ------------------------------ Finding ------------------------------ */

function people(thread: FillThread): Person[] {
  const owner = new Set(thread.owner.map((a) => a.toLowerCase()));
  const seen = new Map<string, Person>();
  // Newest first, the sender before the recipients: the likeliest person comes first.
  for (const m of [...thread.messages].reverse()) {
    for (const p of [m.from, ...m.to, ...m.cc]) {
      const email = p.email.toLowerCase();
      if (!email || owner.has(email) || seen.has(email)) continue;
      seen.set(email, p);
    }
  }
  return [...seen.values()];
}

/** The people on the Thread other than the owner, newest sender first. */
export function otherPeople(thread: FillThread): Person[] {
  return people(thread);
}

function texts(thread: FillThread): string[] {
  // Newest first, so a recent mention outranks an old one.
  return [...thread.messages].reverse().map((m) => ownWords(m.text));
}

function newestFromOthers(thread: FillThread): FillMessage | undefined {
  const owner = new Set(thread.owner.map((a) => a.toLowerCase()));
  return (
    [...thread.messages].reverse().find((m) => !owner.has(m.from.email.toLowerCase())) ??
    thread.messages.at(-1)
  );
}

function fromPatterns(
  thread: FillThread,
  patterns: readonly RegExp[],
  options: { group?: boolean; exclude?: readonly RegExp[][] } = {},
): string[] {
  const out: string[] = [];
  for (const text of texts(thread)) {
    const excluded = (options.exclude ?? []).flatMap((p) => spans(text, p));
    for (const s of spans(text, patterns, options.group)) {
      if (excluded.length > 0 && overlaps(s, excluded)) continue;
      out.push(s.text);
    }
  }
  return out;
}

/**
 * Every candidate span for a Placeholder of this type, likeliest first, each
 * once, at most `max`. A type with no candidates in the Thread gets none, and
 * no question is spent on it.
 */
export function findCandidates(
  type: PlaceholderType,
  thread: FillThread,
  max: number,
  options: NormalizeOptions = DEFAULT_NORMALIZE,
): PlaceholderCandidate[] {
  let found: string[];
  switch (type) {
    case "person":
      found = people(thread).flatMap((p) => (p.name.trim() ? [p.name.trim()] : []));
      break;
    case "first_name":
      found = people(thread).flatMap((p) => (p.name.trim() ? [p.name.trim()] : []));
      break;
    case "email": {
      const owner = new Set(thread.owner.map((a) => a.toLowerCase()));
      found = [
        ...people(thread).map((p) => p.email),
        ...fromPatterns(thread, [EMAIL_PATTERN]),
      ].filter((e) => !owner.has(e.toLowerCase()));
      break;
    }
    case "date":
      found = [...fromPatterns(thread, DATE_PATTERNS), ...(thread.deadlines ?? [])];
      break;
    case "time":
      found = fromPatterns(thread, TIME_PATTERNS, {
        exclude: [AMOUNT_PATTERNS, [/\b\d{1,2}[/.]\d{1,2}[/.](?:\d{4}|\d{2})\b/g]],
      });
      break;
    case "amount":
      found = fromPatterns(thread, AMOUNT_PATTERNS);
      break;
    case "number":
      found = fromPatterns(thread, [NUMBER_PATTERN], {
        exclude: [AMOUNT_PATTERNS, TIME_PATTERNS, DATE_PATTERNS.slice(2, 4)],
      });
      break;
    case "reference":
      found = fromPatterns(thread, REFERENCE_PATTERNS, { group: true });
      break;
    case "link":
      found = fromPatterns(thread, [LINK_PATTERN]);
      break;
    case "text": {
      const newest = newestFromOthers(thread);
      found = newest ? splitSentences(ownWords(newest.text)).filter((s) => s.length <= 400) : [];
      break;
    }
  }
  const out: PlaceholderCandidate[] = [];
  const seen = new Set<string>();
  for (const span of found) {
    const key = span.toLowerCase();
    if (!span || seen.has(key)) continue;
    seen.add(key);
    out.push({ span, value: normalizeValue(type, span, options) });
    if (out.length >= max) break;
  }
  return out;
}
