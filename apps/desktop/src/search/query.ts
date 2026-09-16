// The search query language (ADR 0011): Gmail-style operators parsed on the
// client into a typed query, and compiled to one FTS5 MATCH expression plus
// SQL predicates over the Cache. Pure: no Store, no DOM, no clock of its own.
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

/* ------------------------------ Compiler ------------------------------ */

export type SqlValue = string | number;

export interface CompiledQuery {
  /**
   * The FTS5 MATCH expression over messages_fts for the positive terms, or
   * null when the query has none (a pure filter such as is:unread).
   */
  match: string | null;
  /** MATCH expressions over messages_fts whose Threads are excluded. */
  exclude: string[];
  /**
   * A trigram MATCH over threads_trgm for bare words of three characters or
   * more, so a substring of an address or subject still finds the Thread.
   */
  trigram: string | null;
  /** SQL predicates over `t` (threads) joined with `_` for AND, and their params. */
  where: string;
  params: SqlValue[];
  /** True when the terms reach into bodies, which the Cache may not hold for old mail. */
  bodyTerms: boolean;
}

/** One FTS5 string token: double-quoted, inner quotes doubled. */
export function ftsString(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/** Splits a value into the tokens unicode61 would see, so an address becomes a phrase. */
function ftsTerms(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** A phrase of the value's tokens, prefix-matched on the last one when asked. */
function ftsPhrase(text: string, prefix: boolean): string | null {
  const terms = ftsTerms(text);
  if (terms.length === 0) return null;
  return `${ftsString(terms.join(" "))}${prefix ? " *" : ""}`;
}

function columnTerm(columns: string, text: string, prefix: boolean): string | null {
  const phrase = ftsPhrase(text, prefix);
  return phrase ? `${columns}: ${phrase}` : null;
}

const ANY = "{subject sender recipients body}";

export function compileQuery(q: SearchQuery): CompiledQuery {
  const positive: string[] = [];
  const exclude: string[] = [];
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (term: string | null, negated: boolean) => {
    if (!term) return;
    (negated ? exclude : positive).push(term);
  };

  for (const w of q.words) add(columnTerm(ANY, w.text, true), w.negated);
  for (const p of q.phrases) add(columnTerm(ANY, p.text, false), p.negated);
  for (const c of q.from) add(columnTerm("sender", c.text, true), c.negated);
  for (const c of q.to) add(columnTerm("recipients", c.text, true), c.negated);
  for (const c of q.subject) add(columnTerm("subject", c.text, true), c.negated);

  if (q.hasAttachment !== null) where.push(`t.has_attachments = ${q.hasAttachment ? 1 : 0}`);
  if (q.unread !== null) where.push(`t.unread = ${q.unread ? 1 : 0}`);
  if (q.starred !== null) where.push(`t.starred = ${q.starred ? 1 : 0}`);
  if (q.before !== null) {
    where.push("t.last_activity < ?");
    params.push(q.before);
  }
  if (q.after !== null) {
    where.push("t.last_activity >= ?");
    params.push(q.after);
  }
  for (const c of q.group) {
    const sub = `exists (select 1 from groups g where (g.id = t.group_id or g.id = t.subgroup_id)
        and (lower(g.name) = lower(?) or g.id = ?))`;
    where.push(c.negated ? `not ${sub}` : sub);
    params.push(c.text, c.text);
  }
  for (const c of q.tags) {
    const sub = `exists (select 1 from thread_tags tt join tags g on g.id = tt.tag_id
        where tt.thread_id = t.id and (lower(g.name) = lower(?) or g.id = ?))`;
    where.push(c.negated ? `not ${sub}` : sub);
    params.push(c.text, c.text);
  }
  for (const c of q.labels) {
    const sub = `exists (select 1 from thread_labels tl join labels l on l.id = tl.label_id
        where tl.thread_id = t.id and (lower(l.name) = lower(?) or l.id = ? or l.provider_id = ?))`;
    where.push(c.negated ? `not ${sub}` : sub);
    params.push(c.text, c.text, c.text);
  }

  // The trigram pass only stands in for bare words: a field-bound term or a
  // phrase already says which column it wants, and the trigram index has no
  // body column to honour it with.
  const fieldBound =
    q.from.length > 0 || q.to.length > 0 || q.subject.length > 0 || q.phrases.length > 0;
  const trigramTerms = fieldBound
    ? []
    : q.words.filter((w) => !w.negated && w.text.length >= 3).map((w) => ftsString(w.text));

  return {
    match: positive.length > 0 ? positive.join(" ") : null,
    exclude,
    trigram: trigramTerms.length > 0 ? trigramTerms.join(" ") : null,
    where: where.join(" and "),
    params,
    bodyTerms: hasBodyTerms(q),
  };
}

/* ------------------------------ Autocomplete ------------------------------ */

export interface Completion {
  /** What replaces the current token. */
  text: string;
  /** "operator" for from:, to: ...; "sender" for a known address. */
  kind: "operator" | "sender";
  label: string;
}

/**
 * Completions for the token under the caret: operators when the token is a
 * prefix of one, known senders after from: or to:. `senders` is the Cache's
 * participant list, "Name <email>" per entry or a bare address.
 */
export function complete(
  text: string,
  senders: readonly { name: string; email: string }[],
  limit = 8,
): Completion[] {
  const m = /(\S*)$/.exec(text);
  const token = (m?.[1] ?? "").toLowerCase();
  if (token === "") return [];
  const neg = token.startsWith("-") ? "-" : "";
  const bare = neg ? token.slice(1) : token;
  const out: Completion[] = [];
  const person = /^(from|to):(.*)$/.exec(bare);
  if (person) {
    const op = person[1] as string;
    const needle = person[2] as string;
    for (const s of senders) {
      if (out.length >= limit) break;
      const hay = `${s.name} ${s.email}`.toLowerCase();
      if (needle === "" || hay.includes(needle)) {
        out.push({
          text: `${neg}${op}:${s.email}`,
          kind: "sender",
          label: s.name ? `${s.name} <${s.email}>` : s.email,
        });
      }
    }
    return out;
  }
  for (const op of OPERATORS) {
    if (out.length >= limit) break;
    if (op.startsWith(bare) && op !== bare) {
      out.push({ text: `${neg}${op}`, kind: "operator", label: op });
    }
  }
  return out;
}
