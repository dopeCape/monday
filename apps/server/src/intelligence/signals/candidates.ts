// Candidates for a View's Extractions (docs/spec/views.md, "Extractions:
// select, don't generate"; TypeSafe's pre-parsed value extraction cookbook).
// Code finds every span of one kind in a Thread (tuned to over-find,
// deduplicated, in order of appearance, capped), each with a few words
// around it, so Jev can pick the one the View's question asks for; code then
// copies the pick and normalizes it. The model cannot choose a value that is
// not here, and never writes one. Builds on the Facts' own finders (amounts,
// links, tracking numbers, addresses). Pure, so every pattern is testable.

import type { ExtractKind, JsonValue, Person } from "@monday/shared";
import { companyOf } from "@monday/shared";
import { findAddresses, findAmounts, findLinks, findTracking, parseAmount } from "./facts.ts";

/** One span code found: the option key the judge sees, the span, its context, the normalized value. */
export interface Candidate {
  key: string;
  span: string;
  /** The span with the words around it, as the option's description. */
  line: string;
  value: JsonValue;
}

export interface CandidateInput {
  /** The Messages the Signal request read, oldest first. */
  messages: ReadonlyArray<{ from: Person; to: Person[]; cc: Person[]; date: string; text: string }>;
  owner: string;
  /** The date of the newest Message: a date written without a year reads against it. */
  written: string;
  /** How 10/03/2026 reads (views.extract.date_order). */
  dateOrder: "mdy" | "dmy";
  /** The longest line an item may be (views.extract.item_chars). */
  itemChars?: number | undefined;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** A few words either side of a span's first appearance. */
function around(text: string, span: string, width = 48): string {
  const i = text.indexOf(span);
  if (i < 0) return squash(span);
  const start = Math.max(0, i - width);
  const end = Math.min(text.length, i + span.length + width);
  return `${start > 0 ? "…" : ""}${squash(text.slice(start, end))}${end < text.length ? "…" : ""}`;
}

/** Candidates with unique keys: the span itself when short enough, else c1, c2. */
function keyed(
  found: ReadonlyArray<{ span: string; value: JsonValue; line?: string }>,
  text: string,
  max: number,
): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    const span = squash(f.span);
    if (!span || seen.has(span.toLowerCase())) continue;
    seen.add(span.toLowerCase());
    const key = span.length <= 60 && span !== "none" ? span : `c${out.length + 1}`;
    out.push({ key, span, line: f.line ?? around(text, f.span), value: f.value });
    if (out.length >= max) break;
  }
  return out;
}

/* ------------------------------ Dates ------------------------------ */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const WEEKDAY = "(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\\s+)?";
const ORD = "(?:st|nd|rd|th)?";

const pad = (n: number) => String(n).padStart(2, "0");

function validDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** A date written without a year: the year that puts it nearest the Message that wrote it. */
function nearestYear(m: number, d: number, written: Date): number {
  const y = written.getUTCFullYear();
  const options = [y - 1, y, y + 1].filter((c) => validDay(c, m, d));
  let best = y;
  let gap = Number.POSITIVE_INFINITY;
  for (const c of options) {
    const g = Math.abs(Date.UTC(c, m - 1, d) - written.getTime());
    if (g < gap) {
      gap = g;
      best = c;
    }
  }
  return best;
}

/** Written dates, each as `YYYY-MM-DD`: ISO, "October 3, 2026", "3 Oct", "Tue, Oct 3", "10/03/2026". */
export function findDates(
  text: string,
  written: string,
  order: "mdy" | "dmy",
  max: number,
): Array<{ span: string; value: string }> {
  const out: Array<{ span: string; value: string; at: number }> = [];
  const base = new Date(written);
  const ref = Number.isNaN(base.getTime()) ? new Date() : base;
  const push = (span: string, at: number, y: number | null, m: number, d: number) => {
    const year = y ?? nearestYear(m, d, ref);
    if (m < 1 || m > 12 || !validDay(year, m, d)) return;
    out.push({ span, value: `${year}-${pad(m)}-${pad(d)}`, at });
  };
  for (const x of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    push(x[0], x.index ?? 0, Number(x[1]), Number(x[2]), Number(x[3]));
  }
  const monthFirst = new RegExp(
    `\\b${WEEKDAY}${MONTH}\\s+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?\\b`,
    "gi",
  );
  for (const x of text.matchAll(monthFirst)) {
    const m = MONTHS.indexOf((x[1] ?? "").slice(0, 3).toLowerCase()) + 1;
    push(x[0], x.index ?? 0, x[3] ? Number(x[3]) : null, m, Number(x[2]));
  }
  const dayFirst = new RegExp(
    `\\b${WEEKDAY}(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`,
    "gi",
  );
  for (const x of text.matchAll(dayFirst)) {
    const m = MONTHS.indexOf((x[2] ?? "").slice(0, 3).toLowerCase()) + 1;
    push(x[0], x.index ?? 0, x[3] ? Number(x[3]) : null, m, Number(x[1]));
  }
  for (const x of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b/g)) {
    const a = Number(x[1]);
    const b = Number(x[2]);
    const y = Number(x[3]) < 100 ? 2000 + Number(x[3]) : Number(x[3]);
    const [m, d] = order === "mdy" ? [a, b] : [b, a];
    push(x[0], x.index ?? 0, y, m, d);
  }
  out.sort((a, b) => a.at - b.at);
  // A span inside a longer one ("Oct 3" in "Tue, Oct 3, 2026") is the same date.
  const kept = out.filter(
    (o) => !out.some((p) => p !== o && p.span.length > o.span.length && p.span.includes(o.span)),
  );
  return kept.slice(0, max * 2);
}

/* ------------------------------ Reference numbers ------------------------------ */

const REF_WORDS =
  "(?:order|invoice|booking|confirmation|reservation|ticket|reference|ref|case|PO|purchase order|receipt|account|itinerary|record locator|claim)";

/** Order, invoice, booking and other reference numbers: named as one nearby, or in a known shape. */
export function findReferences(text: string, max: number): Array<{ span: string; value: string }> {
  const out: Array<{ span: string; value: string; at: number }> = [];
  const named = new RegExp(
    `\\b(?:${REF_WORDS}\\s*)+(?:number|no\\.?|num|#|id|code)?\\s*[:#]?\\s*#?\\s*([A-Z0-9][A-Z0-9-]{3,30})\\b`,
    "gi",
  );
  for (const x of text.matchAll(named)) {
    const v = x[1] ?? "";
    // A reference has a digit, or is a code in capitals ("ABC123", "XKQ7PL").
    if (!/\d/.test(v) && !/^[A-Z]{5,8}$/.test(v)) continue;
    out.push({ span: v, value: v, at: (x.index ?? 0) + x[0].indexOf(v) });
  }
  for (const x of text.matchAll(/#\s?([A-Z0-9][A-Z0-9-]{3,30})\b/gi)) {
    const v = x[1] ?? "";
    if (/\d/.test(v)) out.push({ span: v, value: v, at: x.index ?? 0 });
  }
  // Marketplace order numbers: 113-4567890-1234567.
  for (const x of text.matchAll(/\b\d{3}-\d{7}-\d{7}\b/g)) {
    out.push({ span: x[0], value: x[0], at: x.index ?? 0 });
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(0, max * 2);
}

/* ------------------------------ People and companies ------------------------------ */

const NAME = "([A-Z][a-z'’-]+(?:\\s+[A-Z][a-z'’-]+){0,2})";

/** People's names: on the Messages, after a greeting, above a sign-off. */
export function findNames(
  input: CandidateInput,
): Array<{ span: string; value: string; line?: string }> {
  const out: Array<{ span: string; value: string; line?: string }> = [];
  for (const m of input.messages) {
    for (const p of [m.from, ...m.to, ...m.cc]) {
      if (p.name?.trim() && !/[@<>]/.test(p.name)) {
        out.push({
          span: p.name.trim(),
          value: p.name.trim(),
          line: `${p.name.trim()} <${p.email}>`,
        });
      }
    }
  }
  const text = input.messages.map((m) => m.text).join("\n\n");
  for (const x of text.matchAll(new RegExp(`\\b(?:Hi|Hello|Dear|Hey)\\s+${NAME}`, "g"))) {
    const n = x[1] ?? "";
    out.push({ span: n, value: n });
  }
  for (const x of text.matchAll(
    new RegExp(
      `\\b(?:Thanks|Thank you|Best|Regards|Cheers|Sincerely|Best regards|Kind regards),?\\s*\\n\\s*${NAME}`,
      "g",
    ),
  )) {
    const n = x[1] ?? "";
    out.push({ span: n, value: n });
  }
  return out;
}

const COMPANY_SUFFIX =
  "(?:Inc|LLC|Ltd|Limited|GmbH|AG|SA|SAS|SARL|BV|NV|Co|Corp|Corporation|PLC|Pty|Oy|AB|AS|KK|SpA|Srl)";

/** Organisations: senders' display names, names ending in Inc or GmbH, and senders' domains. */
export function findCompanies(
  input: CandidateInput,
): Array<{ span: string; value: string; line?: string }> {
  const out: Array<{ span: string; value: string; line?: string }> = [];
  const owner = input.owner.toLowerCase();
  for (const m of input.messages) {
    if (m.from.email.toLowerCase() === owner) continue;
    const name = m.from.name?.trim();
    if (name && !/[@<>]/.test(name))
      out.push({ span: name, value: name, line: `${name} <${m.from.email}>` });
  }
  const text = input.messages.map((m) => m.text).join("\n\n");
  for (const x of text.matchAll(
    new RegExp(
      `\\b([A-Z][\\w&.'’-]*(?:\\s+[A-Z][\\w&.'’-]*){0,3}\\s+${COMPANY_SUFFIX})\\b\\.?`,
      "g",
    ),
  )) {
    const n = x[1] ?? "";
    out.push({ span: n, value: n });
  }
  for (const m of input.messages) {
    if (m.from.email.toLowerCase() === owner) continue;
    const c = companyOf(m.from.email);
    if (c) out.push({ span: c.label, value: c.label, line: `${c.label} (${c.key})` });
  }
  return out;
}

/* ------------------------------ Quantities, items, sentences ------------------------------ */

/** Counts of things: "Qty: 2", "2 x Lamp", "3 items", "2 nights". */
export function findQuantities(text: string): Array<{ span: string; value: number }> {
  const out: Array<{ span: string; value: number; at: number }> = [];
  const add = (x: RegExpMatchArray, n: string | undefined) => {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0 && v < 100_000)
      out.push({ span: x[0], value: v, at: x.index ?? 0 });
  };
  for (const x of text.matchAll(/\b(?:qty|quantity)\s*[:x]?\s*(\d{1,5})\b/gi)) add(x, x[1]);
  for (const x of text.matchAll(/\b(\d{1,4})\s*[x×]\s+[A-Za-z]/g)) add(x, x[1]);
  for (const x of text.matchAll(
    /\b(\d{1,5})\s+(?:items?|pcs|pieces|units|tickets|seats|nights|guests|adults|bags|boxes|packages)\b/gi,
  )) {
    add(x, x[1]);
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

const BULLET = /^\s*(?:[-*•·▪◦]|\d{1,3}[.)])\s+/;
const QTY_PREFIX = /^\s*\d{1,4}\s*[x×]\s+\S/i;
/** Words that say what a line is (a price, a count), not what was bought. */
const LABEL_WORDS =
  /\b(?:qty|quantity|price|unit price|each|mrp|amount|items?|pcs|pieces|units|rs|inr|usd|eur|gbp)\b/gi;
/** A summary line of a receipt: a total, a tax, a fee, a discount; never an item. */
const SUMMARY =
  /^\s*(?:[-*•·]\s*)?(?:(?:order|bag|item|cart|grand|sub|net)[\s-]*)?(?:total|subtotal|tax(?:es)?|gst|vat|igst|cgst|sgst|shipping|delivery(?: charges?| fee)?|discount|coupon|savings|you saved|amount (?:paid|due|payable)|balance|convenience fee|handling|payment|paid|refund)\b/i;
/** A short attribute line under an item: "Size: M", "Color: White", "Art. No.: 0987654001". */
const ATTRIBUTE = /^\s*[A-Za-z][A-Za-z .]{0,24}:\s*\S.{0,19}$/;

/** A letter in any script, for names such as "Kérastase". */
const LETTERS = /\p{L}{3,}/u;

/** What is left of a line once its amounts, counts and label words are gone. */
function namePart(line: string): string {
  let rest = line;
  for (const a of findAmounts(line, 20)) rest = rest.replace(a, " ");
  return rest
    .replace(/\b\d+\s*[x×]\s*/gi, " ")
    .replace(LABEL_WORDS, " ")
    .replace(/[\d:.,#()|/\\-]+/g, " ")
    .trim();
}

/** A line that is only a count ("Quantity: 1") or only a price ("2900 INR", "Price: Rs. 799"). */
function countOrPrice(line: string): boolean {
  const priced = findAmounts(line, 1).length > 0;
  const counted = /\b(?:qty|quantity)\b|^\s*\d{1,4}\s*[x×]\s*$/i.test(line);
  return (priced || counted) && !LETTERS.test(namePart(line));
}

/**
 * Line items: the lines that name what was bought. A bulleted or numbered line
 * ("* Kérastase Gloss Absolu Shampoo | 250ml"), a line led by a count ("1x Desk
 * lamp"), a line that names a thing beside its price, and a line followed (after
 * its short attributes such as "Size: M") by its count or its price. Never a line
 * that is only a count or a price, never a total, tax or fee. At most `maxChars`
 * characters, copied as written.
 */
export function findItems(text: string, maxChars = 300): Array<{ span: string; value: string }> {
  const out: Array<{ span: string; value: string }> = [];
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim() !== "");
  for (let k = 0; k < nonEmpty.length; k++) {
    const raw = (nonEmpty[k] as { l: string }).l;
    const line = raw.replace(BULLET, "").trim();
    if (line.length < 3 || line.length > maxChars) continue;
    if (SUMMARY.test(line) || /^https?:\/\/\S+$/.test(line)) continue;
    if (countOrPrice(line) || !LETTERS.test(namePart(line))) continue;
    const bullet = BULLET.test(raw) || QTY_PREFIX.test(raw);
    const priced = findAmounts(line, 1).length > 0 || /\b(?:qty|quantity)\b/i.test(line);
    let followed = false;
    if (!bullet && !priced && !ATTRIBUTE.test(line)) {
      // Its count or its price follows, after at most a few short attributes.
      for (let j = k + 1; j < Math.min(nonEmpty.length, k + 6); j++) {
        const next = (nonEmpty[j] as { l: string }).l.trim();
        if (SUMMARY.test(next)) break;
        if (countOrPrice(next)) {
          followed = true;
          break;
        }
        if (!ATTRIBUTE.test(next)) break;
      }
    }
    if (bullet || priced || followed) out.push({ span: line, value: line });
  }
  return out;
}

/** The sentences of the Messages, the owner's own first. */
export function findSentences(input: CandidateInput): Array<{ span: string; value: string }> {
  const owner = input.owner.toLowerCase();
  const own = input.messages.filter((m) => m.from.email.toLowerCase() === owner);
  const rest = input.messages.filter((m) => m.from.email.toLowerCase() !== owner);
  const out: Array<{ span: string; value: string }> = [];
  for (const m of [...own.reverse(), ...rest.reverse()]) {
    // Quoted history is the earlier Messages again; only the Message's own words count.
    const body = m.text.split(/\n>|\nOn .{5,80} wrote:/)[0] ?? m.text;
    for (const s of body.split(/(?<=[.!?])\s+|\n{2,}/)) {
      const t = squash(s);
      if (t.length >= 8 && t.length <= 240 && /[A-Za-z]{3,}/.test(t))
        out.push({ span: t, value: t });
    }
  }
  return out;
}

/* ------------------------------ Every kind ------------------------------ */

const linkLine = (url: string, domain: string) => {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? `${u.pathname.slice(0, 40)}...` : u.pathname;
    return `${domain}${path === "/" ? "" : path}`;
  } catch {
    return domain;
  }
};

/** The candidates of one kind in a Thread, keyed for the judge, at most `max`. */
export function findCandidates(kind: ExtractKind, input: CandidateInput, max: number): Candidate[] {
  const text = input.messages.map((m) => m.text).join("\n\n");
  const cap = Math.max(1, max);
  switch (kind) {
    case "money":
      return keyed(
        findAmounts(text, cap * 2).map((span) => {
          const parsed = parseAmount(span);
          return {
            span,
            value: parsed ? { value: parsed.value, currency: parsed.currency } : span,
          };
        }),
        text,
        cap,
      );
    case "date":
      return keyed(findDates(text, input.written, input.dateOrder, cap), text, cap);
    case "reference":
      return keyed(
        findReferences(text, cap).map((r) => ({ span: r.span, value: r.value.replace(/^#/, "") })),
        text,
        cap,
      );
    case "tracking":
      return keyed(
        findTracking(text, cap).map((t) => ({
          span: t.number,
          value: t.number.toUpperCase(),
          line: `${t.carrier.toUpperCase()} ${around(text, t.number, 32)}`,
        })),
        text,
        cap,
      );
    case "email": {
      const found = [
        ...input.messages.flatMap((m) =>
          [m.from, ...m.to, ...m.cc].map((p) => p.email.toLowerCase()),
        ),
        ...findAddresses(text, cap * 2),
      ];
      return keyed(
        found.map((e) => ({ span: e, value: e.toLowerCase() })),
        text,
        cap,
      );
    }
    case "person":
      return keyed(findNames(input), text, cap);
    case "company":
      return keyed(findCompanies(input), text, cap);
    case "link":
      return findLinks(text, cap).map((l, i) => ({
        key: `l${i + 1}`,
        span: l.url,
        line: linkLine(l.url, l.domain),
        value: { url: l.url, domain: l.domain },
      }));
    case "quantity":
      return keyed(findQuantities(text), text, cap);
    case "item":
      return keyed(findItems(text, input.itemChars), text, cap);
    case "sentence":
      return keyed(findSentences(input), text, cap);
  }
}

/** An Extraction's kind from its Signal's option source (`extract:money`), or null. */
export function extractKindOf(from: string | null | undefined): ExtractKind | null {
  return from?.startsWith("extract:") ? (from.slice("extract:".length) as ExtractKind) : null;
}
