// The search query language (ADR 0011, ADR 0015): Gmail-style operators
// parsed into a typed query. One parser for both sides: the client compiles
// it to an FTS5 MATCH over the Cache (apps/desktop/src/search/query.ts), the
// Server's full search applies it in SQL and over decrypted text
// (apps/server/src/mailstore/full-search.ts, with ./search-match.ts).
// Pure: no Store, no DOM, no clock of its own.
//
//   from:kenji to:me subject:"term sheet" has:attachment is:unread is:starred
//   in:hiring tag:candidate label:inbox before:2026-09-01 after:2026/08/01
//   older_than:7d newer_than:2w "quoted phrase" -negated -from:noreply
//
// Anything else is a bare word matched by prefix, so the box answers as the
// user types. Malformed input never throws: an operator with a value the
// parser does not understand becomes a bare word of the text as typed.

export interface Clause {
  text: string;
  negated: boolean;
}

export type BooleanFilter = boolean | null;

export interface SearchQuery {
  /** Bare words, prefix-matched over every indexed column. */
  words: Clause[];
  /** Quoted phrases, matched in order over every indexed column. */
  phrases: Clause[];
  from: Clause[];
  to: Clause[];
  subject: Clause[];
  /** has:attachment; null when not asked. */
  hasAttachment: BooleanFilter;
  /** is:unread true, is:read false, null when not asked. */
  unread: BooleanFilter;
  /** is:starred true, is:unstarred false. */
  starred: BooleanFilter;
  /** in:<group>: a Group name or id; matches group or sub-group. */
  group: Clause[];
  tags: Clause[];
  labels: Clause[];
  /** Exclusive upper bound on last activity, ISO. Null when unbounded. */
  before: string | null;
  /** Inclusive lower bound on last activity, ISO. Null when unbounded. */
  after: string | null;
  /** The text as typed. */
  raw: string;
}

/** The operators the box completes; the order is the order they are offered. */
export const OPERATORS = [
  "from:",
  "to:",
  "subject:",
  "has:attachment",
  "is:unread",
  "is:read",
  "is:starred",
  "in:",
  "tag:",
  "label:",
  "before:",
  "after:",
  "older_than:",
  "newer_than:",
] as const;

export type Operator = (typeof OPERATORS)[number];

export function emptyQuery(raw = ""): SearchQuery {
  return {
    words: [],
    phrases: [],
    from: [],
    to: [],
    subject: [],
    hasAttachment: null,
    unread: null,
    starred: null,
    group: [],
    tags: [],
    labels: [],
    before: null,
    after: null,
    raw,
  };
}

/** True when the query names any field, so the palette switches to search mode. */
export function hasOperator(q: SearchQuery): boolean {
  return (
    q.from.length > 0 ||
    q.to.length > 0 ||
    q.subject.length > 0 ||
    q.hasAttachment !== null ||
    q.unread !== null ||
    q.starred !== null ||
    q.group.length > 0 ||
    q.tags.length > 0 ||
    q.labels.length > 0 ||
    q.before !== null ||
    q.after !== null ||
    q.phrases.length > 0
  );
}

/** True when nothing at all was asked. */
export function isEmpty(q: SearchQuery): boolean {
  return q.words.length === 0 && !hasOperator(q);
}

/** True when the query needs body text: bare words or phrases that are not field-bound. */
export function hasBodyTerms(q: SearchQuery): boolean {
  return q.words.some((w) => !w.negated) || q.phrases.some((p) => !p.negated);
}

/* ------------------------------ Tokenizer ------------------------------ */

interface Token {
  /** The operator name without the colon, or null for a bare term. */
  op: string | null;
  value: string;
  quoted: boolean;
  negated: boolean;
  /** The text exactly as typed, for the fallback to a bare word. */
  source: string;
}

const OP_NAMES = new Set([
  "from",
  "to",
  "subject",
  "has",
  "is",
  "in",
  "tag",
  "label",
  "before",
  "after",
  "older_than",
  "newer_than",
]);

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    let negated = false;
    if (ch === "-" && i + 1 < n && !/\s/.test(text[i + 1] as string)) {
      negated = true;
      i++;
    }
    let op: string | null = null;
    // An operator is letters or underscores followed by a colon, glued to its value.
    const m = /^([a-z_]+):/i.exec(text.slice(i));
    if (m && OP_NAMES.has((m[1] as string).toLowerCase())) {
      op = (m[1] as string).toLowerCase();
      i += m[0].length;
    }
    let value = "";
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      const close = text.indexOf('"', i);
      value = close === -1 ? text.slice(i) : text.slice(i, close);
      i = close === -1 ? n : close + 1;
    } else {
      const j = i;
      while (i < n && !/\s/.test(text[i] as string)) i++;
      value = text.slice(j, i);
    }
    const source = text.slice(start, i);
    if (value === "" && !op) continue;
    out.push({ op, value, quoted, negated, source });
  }
  return out;
}

/* ------------------------------ Dates ------------------------------ */

const DAY_MS = 86_400_000;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** An absolute date: 2026-09-01, 2026/09/01, 2026-09, 2026, today, yesterday. Local midnight. */
export function parseAbsoluteDate(value: string, now: Date): Date | null {
  const v = value.trim().toLowerCase();
  if (v === "today") return startOfDay(now);
  if (v === "yesterday") return new Date(startOfDay(now).getTime() - DAY_MS);
  const m = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/.exec(v);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 1;
  const day = m[3] ? Number(m[3]) : 1;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

/** A relative span: 7d, 2w, 3m, 1y, or a bare number of days. */
export function parseRelativeSpan(value: string, now: Date): Date | null {
  const m = /^(\d+)\s*([dwmy]?)$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? "d").toLowerCase() || "d";
  const d = new Date(now.getTime());
  if (unit === "d") d.setDate(d.getDate() - n);
  else if (unit === "w") d.setDate(d.getDate() - 7 * n);
  else if (unit === "m") d.setMonth(d.getMonth() - n);
  else d.setFullYear(d.getFullYear() - n);
  return d;
}

/** The later of two ISO strings, or the one that exists. */
function later(a: string | null, b: string): string {
  return a === null || b > a ? b : a;
}

function earlier(a: string | null, b: string): string {
  return a === null || b < a ? b : a;
}

/* ------------------------------ Parser ------------------------------ */

export interface ParseOptions {
  /** The wall clock relative dates count from. Defaults to now. */
  now?: Date;
}

export function parseQuery(text: string, options: ParseOptions = {}): SearchQuery {
  const now = options.now ?? new Date();
  const q = emptyQuery(text);
  const asWord = (t: Token) => {
    const raw = t.negated ? t.source.slice(1) : t.source;
    if (raw.trim() !== "") q.words.push({ text: raw, negated: t.negated });
  };
  for (const t of tokenize(text)) {
    const clause: Clause = { text: t.value, negated: t.negated };
    if (t.op === null) {
      if (t.quoted) {
        if (t.value.trim() !== "") q.phrases.push(clause);
      } else q.words.push(clause);
      continue;
    }
    if (t.value === "") {
      // A dangling "from:" while typing: nothing to match yet, nothing to break.
      continue;
    }
    switch (t.op) {
      case "from":
        q.from.push(clause);
        break;
      case "to":
        q.to.push(clause);
        break;
      case "subject":
        q.subject.push(clause);
        break;
      case "in":
        q.group.push(clause);
        break;
      case "tag":
        q.tags.push(clause);
        break;
      case "label":
        q.labels.push(clause);
        break;
      case "has": {
        const v = t.value.toLowerCase();
        if (v === "attachment" || v === "attachments" || v === "file") {
          q.hasAttachment = !t.negated;
        } else asWord(t);
        break;
      }
      case "is": {
        const v = t.value.toLowerCase();
        if (v === "unread") q.unread = !t.negated;
        else if (v === "read") q.unread = t.negated;
        else if (v === "starred") q.starred = !t.negated;
        else if (v === "unstarred") q.starred = t.negated;
        else asWord(t);
        break;
      }
      case "before": {
        const d = parseAbsoluteDate(t.value, now);
        if (!d) asWord(t);
        else if (t.negated) q.after = later(q.after, d.toISOString());
        else q.before = earlier(q.before, d.toISOString());
        break;
      }
      case "after": {
        const d = parseAbsoluteDate(t.value, now);
        if (!d) asWord(t);
        else if (t.negated) q.before = earlier(q.before, d.toISOString());
        else q.after = later(q.after, d.toISOString());
        break;
      }
      case "older_than": {
        const d = parseRelativeSpan(t.value, now);
        if (!d) asWord(t);
        else if (t.negated) q.after = later(q.after, d.toISOString());
        else q.before = earlier(q.before, d.toISOString());
        break;
      }
      case "newer_than": {
        const d = parseRelativeSpan(t.value, now);
        if (!d) asWord(t);
        else if (t.negated) q.before = earlier(q.before, d.toISOString());
        else q.after = later(q.after, d.toISOString());
        break;
      }
      default:
        asWord(t);
    }
  }
  return q;
}
