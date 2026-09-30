// Facts (CONTEXT.md "Fact"; docs/spec/signals.md "Facts"; slice 32): what
// code computes about a Thread without any model, when a Thread version is
// asked. Facts filter; Signals judge. Code owns dates, counts, senders and
// the spans a pattern finds; the judge only picks among what code found (the
// amount on a bill, the parts of a date), and code assembles the result.
// Pure, so every pattern and the date assembly are testable alone.

import type { ExtractedItem, Person, RowAnswer } from "@monday/shared";

export interface FactMessage {
  from: Person;
  to: Person[];
  cc: Person[];
  /** ISO date. */
  date: string;
  headers: Record<string, string>;
  text: string;
  /** Whether the HTML part carries an image (inline or remote). */
  hasImages?: boolean | undefined;
}

export interface SenderStats {
  /** Threads the newest sender started or wrote on. */
  threads: number;
  /** Of those, how many the owner wrote on. */
  ownerReplied: number;
  /** Of those, how many the owner archived without reading. */
  archivedUnread: number;
}

export interface FactsInput {
  owner: string;
  /** Oldest first. */
  messages: FactMessage[];
  attachmentNames: string[];
  participants: Person[];
  sender: SenderStats | null;
  hasInvite: boolean;
  candidatesMax: number;
}

/** The Facts kept in the clear: counts, headers, dates and flags. */
export interface ClearFacts {
  received_at: string | null;
  last_activity_at: string | null;
  message_count: number;
  participant_count: number;
  attachment_count: number;
  from_address: string | null;
  from_domain: string | null;
  to_me_directly: boolean;
  owner_wrote_last: boolean;
  owner_ever_wrote: boolean;
  known_sender: boolean;
  sender_threads: number;
  owner_replied_share: number | null;
  owner_archived_unread_share: number | null;
  list_id: string | null;
  list_unsubscribe: { mailto: boolean; https: boolean; one_click: boolean };
  precedence_bulk: boolean;
  has_invite: boolean;
  language: "en" | "other";
  image_only: boolean;
  amount_count: number;
  deadline_at: string | null;
  deadline_unclear: boolean;
}

/** The Facts drawn from the text: sealed under the Workspace key (ADR 0009). */
export interface SealedFacts {
  amounts: string[];
  addresses: string[];
  links: Array<{ url: string; domain: string }>;
  tracking_numbers: Array<{ carrier: string; number: string }>;
  /** The amount the judge picked among `amounts`, parsed by code. */
  amount: { span: string; value: number; currency: string } | null;
  /**
   * What the judge picked in the other per-Thread Choices, by Signal id: a
   * person's address, a link, a tracking number, verbatim, with the pick's
   * confidence (docs/spec/actions.md).
   */
  picks?:
    | Record<
        string,
        {
          value: string;
          confidence: number;
          probability?: number | undefined;
          /** A View's Extraction: the value normalized by code (money, a date, a link). */
          normalized?: unknown;
          /** A many-Extraction's values, or one per Message (docs/spec/views.md, "Many values"). */
          items?: ExtractedItem[] | undefined;
          /** A View Signal asked per row: its answer per row key. */
          answers?: Record<string, RowAnswer> | undefined;
        }
      >
    | undefined;
}

const lower = (s: string) => s.trim().toLowerCase();
const domainOf = (address: string) => lower(address.split("@")[1] ?? "") || null;

/* ------------------------------ Patterns ------------------------------ */

const CURRENCY = "(?:[$€£¥₹]|USD|EUR|GBP|CHF|CAD|AUD|JPY|INR)";
const NUMBER = "\\d{1,3}(?:[,.\\u00a0 ]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
// "Rs. 799" and "Rs 1,299" are rupees too (Indian receipts), only before the number.
const AMOUNT = new RegExp(
  `${CURRENCY}\\s?(?:${NUMBER})|\\bRs\\.?\\s?(?:${NUMBER})|(?:${NUMBER})\\s?${CURRENCY}`,
  "g",
);

/** Amounts with a currency, verbatim, deduplicated, in order of appearance, at most `max`. */
export function findAmounts(text: string, max: number): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const span = m[0].trim();
    if (!/\d/.test(span) || out.includes(span)) continue;
    out.push(span);
    if (out.length >= max) break;
  }
  return out;
}

const SYMBOL_CODE: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
};

/** A picked amount span as a number and a currency; null when it is not one. */
export function parseAmount(span: string): { value: number; currency: string } | null {
  const code = /USD|EUR|GBP|CHF|CAD|AUD|JPY|INR/.exec(span)?.[0];
  const symbol = /[$€£¥₹]/.exec(span)?.[0];
  const rupees = /^Rs\b/.test(span) ? "INR" : undefined;
  const currency = code ?? (symbol ? SYMBOL_CODE[symbol] : rupees);
  const digits = /[\d][\d,.  ]*/.exec(span)?.[0]?.trim();
  if (!currency || !digits) return null;
  // The last separator followed by one or two digits is the decimal mark.
  const compact = digits.replace(/[  ]/g, "");
  const decimal = /[.,](\d{1,2})$/.exec(compact);
  const whole = (decimal ? compact.slice(0, decimal.index) : compact).replace(/[.,]/g, "");
  const value = Number(`${whole}${decimal ? `.${decimal[1]}` : ""}`);
  return Number.isFinite(value) ? { value, currency } : null;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export function findAddresses(text: string, max: number): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EMAIL)) {
    const a = lower(m[0]);
    if (!out.includes(a)) out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

export function findLinks(text: string, max: number): Array<{ url: string; domain: string }> {
  const out: Array<{ url: string; domain: string }> = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (out.some((l) => l.url === url)) continue;
    try {
      out.push({ url, domain: new URL(url).hostname.toLowerCase() });
    } catch {
      continue;
    }
    if (out.length >= max) break;
  }
  return out;
}

const TRACKING: Array<{ carrier: string; pattern: RegExp }> = [
  { carrier: "ups", pattern: /\b1Z[0-9A-Z]{16}\b/g },
  { carrier: "usps", pattern: /\b(?:94|93|92|95)\d{20}\b/g },
  { carrier: "fedex", pattern: /\b\d{12}\b|\b\d{15}\b/g },
  { carrier: "dhl", pattern: /\b\d{10}\b(?=[^\n]{0,40}\bDHL\b)|\bJJD\d{18}\b/g },
];

export function findTracking(
  text: string,
  max: number,
): Array<{ carrier: string; number: string }> {
  const out: Array<{ carrier: string; number: string }> = [];
  // A tracking number is named as one nearby; a bare long number is an invoice or a phone.
  if (!/track|shipment|parcel|package|delivery|sendung|colis/i.test(text)) return out;
  for (const { carrier, pattern } of TRACKING) {
    for (const m of text.matchAll(pattern)) {
      if (out.some((t) => t.number === m[0])) continue;
      out.push({ carrier, number: m[0] });
      if (out.length >= max) return out;
    }
  }
  return out;
}

const STOP_WORDS = new Set(
  "the and to of a in is you that it for on with this be are as at your have we i can will not or from by if our me my please thanks thank would".split(
    " ",
  ),
);

/** English or not, from how many common English words the text holds. Short texts count as English. */
export function languageOf(text: string): "en" | "other" {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 8) return "en";
  const hits = words.filter((w) => STOP_WORDS.has(w)).length;
  return hits / words.length >= 0.08 ? "en" : "other";
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;

/** Next to no text, and images attached or inline: the model cannot read it. */
export function imageOnly(text: string, attachmentNames: string[], hasImages: boolean): boolean {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  return words < 6 && (hasImages || attachmentNames.some((n) => IMAGE_NAME.test(n)));
}

/** Whether the text may state a date the owner acts by: code's gate for the date parts. */
export function mayStateDeadline(text: string): boolean {
  return (
    /\b(by|before|until|due|deadline|no later than|expires?|until)\b/i.test(text) &&
    /\b(\d{1,2}[/.-]\d{1,2}|\d{1,2}(st|nd|rd|th)?\b|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|next week|end of|eod|eow|eom)/i.test(
      text,
    )
  );
}

/**
 * Whether the text may name a day or a time something happens: code's gate
 * for an event's date parts (a weekday, a month, a clock time, tomorrow).
 */
export function mayStateDate(text: string): boolean {
  return /\b(\d{1,2}[/.-]\d{1,2}|\d{1,2}(st|nd|rd|th)\b|\d{1,2}(:\d{2})?\s?(am|pm)\b|\d{1,2}:\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|next week|noon)/i.test(
    text,
  );
}

/* ------------------------------ The Facts ------------------------------ */

export function computeFacts(input: FactsInput): { clear: ClearFacts; sealed: SealedFacts } {
  const owner = lower(input.owner);
  const newest = input.messages[input.messages.length - 1] ?? null;
  const first = input.messages[0] ?? null;
  const fromAddress = newest ? lower(newest.from.email) : null;
  const text = input.messages.map((m) => m.text).join("\n\n");
  const newestText = newest?.text ?? "";
  const unsubscribe = lower(newest?.headers["list-unsubscribe"] ?? "");
  const stats = input.sender;
  const known = (stats?.ownerReplied ?? 0) > 0;
  const clear: ClearFacts = {
    received_at: first?.date ?? null,
    last_activity_at: newest?.date ?? null,
    message_count: input.messages.length,
    participant_count: new Set(input.participants.map((p) => lower(p.email))).size,
    attachment_count: input.attachmentNames.length,
    from_address: fromAddress,
    from_domain: fromAddress ? domainOf(fromAddress) : null,
    to_me_directly: newest ? newest.to.some((p) => lower(p.email) === owner) : false,
    owner_wrote_last: fromAddress !== null && fromAddress === owner,
    owner_ever_wrote: input.messages.some((m) => lower(m.from.email) === owner),
    known_sender: known,
    sender_threads: stats?.threads ?? 0,
    owner_replied_share: stats && stats.threads > 0 ? stats.ownerReplied / stats.threads : null,
    owner_archived_unread_share:
      stats && stats.threads > 0 ? stats.archivedUnread / stats.threads : null,
    list_id: newest?.headers["list-id"] ?? null,
    list_unsubscribe: {
      mailto: unsubscribe.includes("mailto:"),
      https: unsubscribe.includes("https:"),
      one_click: /one-click/i.test(newest?.headers["list-unsubscribe-post"] ?? ""),
    },
    precedence_bulk: /bulk|list/i.test(newest?.headers.precedence ?? ""),
    has_invite: input.hasInvite,
    language: languageOf(newestText || text),
    image_only: imageOnly(newestText, input.attachmentNames, newest?.hasImages ?? false),
    amount_count: 0,
    deadline_at: null,
    deadline_unclear: false,
  };
  const max = Math.max(1, input.candidatesMax);
  const sealed: SealedFacts = {
    amounts: findAmounts(text, max),
    addresses: findAddresses(text, max),
    links: findLinks(text, max),
    tracking_numbers: findTracking(text, max),
    amount: null,
  };
  clear.amount_count = sealed.amounts.length;
  return { clear, sealed };
}

/* ------------------------------ The deadline's date ------------------------------ */

export interface ChoicePart {
  choice: string;
  confidence: number;
}

export type DeadlineParts = Partial<
  Record<"form" | "month" | "day" | "year" | "anchor" | "weekday" | "week" | "hour", ChoicePart>
>;

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

/** The calendar date and weekday of a moment in a zone. */
function zoned(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase()),
  };
}

/** The UTC instant of a wall-clock time in a zone. */
function inZone(y: number, m: number, d: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d, hour);
  const tz = timeZone || "UTC";
  let offset = 0;
  try {
    const shown = new Date(new Date(guess).toLocaleString("en-US", { timeZone: tz }));
    const utc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" }));
    offset = shown.getTime() - utc.getTime();
  } catch {
    offset = 0;
  }
  return new Date(guess - offset);
}

const valid = (y: number, m: number, d: number) => {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
};

/**
 * Code turns the picked date parts into the deadline (docs/spec/signals.md):
 * relative dates count from the date of the Message that states them, in the
 * Workspace's zone; the lowest confidence among the parts used is the date's
 * confidence; below the floor, or when the parts make no date (31 February,
 * an `other` year), there is no date and it is unclear. The model never
 * compares dates. A time of day, when stated, sets the hour; else the end of
 * that day counts.
 */
export function assembleDeadline(
  parts: DeadlineParts,
  written: string,
  timeZone: string,
  minConfidence: number,
): { at: string | null; unclear: boolean; confidence: number } {
  const form = parts.form?.choice;
  if (!form || form === "none")
    return { at: null, unclear: false, confidence: parts.form?.confidence ?? 0 };
  const used: ChoicePart[] = [parts.form as ChoicePart];
  const pick = (k: keyof DeadlineParts) => {
    const p = parts[k];
    if (p && p.choice !== "none") used.push(p);
    return p && p.choice !== "none" ? p.choice : null;
  };
  const base = zoned(new Date(written), timeZone);
  let y: number | null = null;
  let m: number | null = null;
  let d: number | null = null;
  if (form === "absolute") {
    const month = pick("month");
    const day = pick("day");
    const year = pick("year");
    if (!month || !day || year === "other") return { at: null, unclear: true, confidence: 0 };
    m = MONTHS.indexOf(month) + 1;
    d = Number(day);
    y = year ? Number(year) : base.year;
    // A date with no year that has passed by the time it was written means next year.
    if (!year && (m < base.month || (m === base.month && d < base.day))) y += 1;
  } else if (form === "relative") {
    const anchor = pick("anchor");
    if (!anchor) return { at: null, unclear: true, confidence: 0 };
    const start = new Date(Date.UTC(base.year, base.month - 1, base.day));
    const addDays = (n: number) => {
      const t = new Date(start.getTime() + n * 86_400_000);
      return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
    };
    let target: { y: number; m: number; d: number } | null = null;
    if (anchor === "today") target = addDays(0);
    else if (anchor === "tomorrow") target = addDays(1);
    else if (anchor === "end_of_week") target = addDays((5 - base.weekday + 7) % 7);
    else if (anchor === "next_week") target = addDays(((1 - base.weekday + 7) % 7 || 7) + 4);
    else if (anchor === "end_of_month") {
      const last = new Date(Date.UTC(base.year, base.month, 0));
      target = { y: last.getUTCFullYear(), m: last.getUTCMonth() + 1, d: last.getUTCDate() };
    } else if (anchor === "weekday") {
      const weekday = pick("weekday");
      if (!weekday) return { at: null, unclear: true, confidence: 0 };
      const want = WEEKDAYS.indexOf(weekday);
      let ahead = (want - base.weekday + 7) % 7 || 7;
      if (pick("week") === "next") ahead += 7;
      target = addDays(ahead);
    }
    if (!target) return { at: null, unclear: true, confidence: 0 };
    ({ y, m, d } = target);
  } else {
    return { at: null, unclear: true, confidence: 0 };
  }
  if (y === null || m === null || d === null || !valid(y, m, d)) {
    return { at: null, unclear: true, confidence: 0 };
  }
  const hourPick = pick("hour");
  const hour = hourPick === null ? 23 : Number(hourPick);
  const confidence = Math.min(...used.map((p) => p.confidence));
  if (confidence < minConfidence) return { at: null, unclear: true, confidence };
  const at = inZone(y, m, d, hour, timeZone);
  if (hourPick === null) at.setUTCMinutes(59);
  return { at: at.toISOString(), unclear: false, confidence };
}
