// The text half of the search query language, evaluated over plaintext
// (ADR 0015). The client never needs it: its Cache answers the same query
// through FTS5 (apps/desktop/src/search/query.ts). The Server's full search
// does, because it has no plaintext index: it decrypts a candidate Thread in
// memory, asks matchThread, and discards the text.
//
// The rules mirror the Cache's index so a query means the same thing on
// both sides (the parity test runs one fixture through both):
// - Text is split like SQLite's unicode61 tokenizer: runs of letters and
//   numbers, lowercased, diacritics removed.
// - Each Message is one document of four columns: the Thread's subject, the
//   sender, the recipients (to and cc) and the body.
// - A bare word is a prefix phrase over every column; a quoted phrase is an
//   exact phrase; from:, to: and subject: are prefix phrases over one column.
// - Every positive term must match inside one Message; a negated term drops
//   the Thread when any of its Messages matches it.
// - Bare words of three characters or more (with no field-bound term or
//   phrase in the query) also match as substrings of the subject and the
//   participants, like the Cache's trigram index.
// Pure: no Bun, no DOM.

import type { SearchQuery } from "./search-query.ts";

/**
 * Text, or a function that produces it the first time it is needed: the
 * Server passes decryption this way, so a Thread a header term already ruled
 * out never has its body opened.
 */
export type LazyText = string | (() => string);

export interface MatchMessage {
  /** The sender as "name email". */
  sender: string;
  /** Every to and cc as "name email", joined. */
  recipients: string;
  body: LazyText;
}

export interface MatchThread {
  subject: LazyText;
  /** Every participant as "name email", joined. */
  participants: string;
  messages: readonly MatchMessage[];
}

type Column = "subject" | "sender" | "recipients" | "body";
const ANY: readonly Column[] = ["subject", "sender", "recipients", "body"];

interface Term {
  columns: readonly Column[];
  tokens: string[];
  prefix: boolean;
}

/** Folds case and strips diacritics, as unicode61 does. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** The tokens unicode61 would index for `text`. */
export function searchTokens(text: string): string[] {
  return foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "");
}

function term(columns: readonly Column[], text: string, prefix: boolean): Term | null {
  const tokens = searchTokens(text);
  return tokens.length === 0 ? null : { columns, tokens, prefix };
}

interface CompiledText {
  positive: Term[];
  negative: Term[];
  /** Folded substrings for the trigram pass; empty when the pass does not run. */
  trigram: string[];
}

function compileText(q: SearchQuery): CompiledText {
  const positive: Term[] = [];
  const negative: Term[] = [];
  const add = (t: Term | null, negated: boolean) => {
    if (t) (negated ? negative : positive).push(t);
  };
  for (const w of q.words) add(term(ANY, w.text, true), w.negated);
  for (const p of q.phrases) add(term(ANY, p.text, false), p.negated);
  for (const c of q.from) add(term(["sender"], c.text, true), c.negated);
  for (const c of q.to) add(term(["recipients"], c.text, true), c.negated);
  for (const c of q.subject) add(term(["subject"], c.text, true), c.negated);
  const fieldBound =
    q.from.length > 0 || q.to.length > 0 || q.subject.length > 0 || q.phrases.length > 0;
  const trigram = fieldBound
    ? []
    : q.words.filter((w) => !w.negated && w.text.length >= 3).map((w) => w.text.toLowerCase());
  // Cheapest first, so a miss on a header column decides before a body is read:
  // sender and recipients, then the subject, then terms over every column.
  const cost = (t: Term) =>
    t.columns.includes("body") ? 2 : t.columns.includes("subject") ? 1 : 0;
  positive.sort((a, b) => cost(a) - cost(b));
  negative.sort((a, b) => cost(a) - cost(b));
  return { positive, negative, trigram };
}

/** What a query needs decrypted: the subject, the bodies, or neither. */
export function textNeeds(q: SearchQuery): { subject: boolean; body: boolean; any: boolean } {
  const t = compileText(q);
  const all = [...t.positive, ...t.negative];
  const subject = all.some((x) => x.columns.includes("subject")) || t.trigram.length > 0;
  const body = all.some((x) => x.columns.includes("body"));
  return { subject, body, any: all.length > 0 };
}

/** True when `tokens` holds `needle` as consecutive tokens, the last one by prefix when asked. */
function hasPhrase(tokens: readonly string[], needle: Term): boolean {
  const n = needle.tokens.length;
  const last = n - 1;
  outer: for (let i = 0; i + n <= tokens.length; i++) {
    for (let j = 0; j < n; j++) {
      const have = tokens[i + j] as string;
      const want = needle.tokens[j] as string;
      if (j === last && needle.prefix ? !have.startsWith(want) : have !== want) continue outer;
    }
    return true;
  }
  return false;
}

/** A Message as token columns, built lazily so a cheap miss never tokenizes a body. */
class Doc {
  private cache = new Map<Column, string[]>();
  private folded = new Map<Column, string>();
  constructor(private readonly text: Record<Column, LazyText>) {}
  fold(column: Column): string {
    let f = this.folded.get(column);
    if (f === undefined) {
      f = foldText(read(this.text[column]));
      this.folded.set(column, f);
    }
    return f;
  }
  tokens(column: Column): string[] {
    let t = this.cache.get(column);
    if (!t) {
      t = this.fold(column)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((x) => x !== "");
      this.cache.set(column, t);
    }
    return t;
  }
}

function read(text: LazyText): string {
  return typeof text === "string" ? text : text();
}

function matches(doc: Doc, t: Term): boolean {
  for (const column of t.columns) {
    // Every token of the phrase occurs as a substring when the phrase does:
    // a cheap test that skips tokenizing most bodies.
    const folded = doc.fold(column);
    if (!t.tokens.every((token) => folded.includes(token))) continue;
    if (hasPhrase(doc.tokens(column), t)) return true;
  }
  return false;
}

export interface ThreadMatch {
  matched: boolean;
  /** The index of the Message that matched every positive term, or -1. */
  message: number;
}

/**
 * Whether a Thread answers the text of `q`. Filters (dates, is:, has:, in:,
 * tag:, label:) are not the text's: the caller applies them. A query with no
 * positive text term matches every Thread no negated term excludes.
 */
export function matchThread(q: SearchQuery, thread: MatchThread): ThreadMatch {
  return compileMatcher(q)(thread);
}

/** matchThread with the query compiled once, for a scan over many Threads. */
export function compileMatcher(q: SearchQuery): (thread: MatchThread) => ThreadMatch {
  const t = compileText(q);
  const miss: ThreadMatch = { matched: false, message: -1 };
  return (thread) => {
    let subject: string | null = null;
    const subjectText = () => {
      subject ??= read(thread.subject);
      return subject;
    };
    const docs = thread.messages.map(
      (m) =>
        new Doc({
          subject: subjectText,
          sender: m.sender,
          recipients: m.recipients,
          body: m.body,
        }),
    );
    // The positive terms first: a Thread they miss never has its bodies
    // opened for the negated ones.
    let at = -1;
    if (t.positive.length > 0) {
      at = docs.findIndex((d) => t.positive.every((p) => matches(d, p)));
      if (at < 0) {
        if (t.trigram.length === 0) return miss;
        const hay = `${subjectText().toLowerCase()}\u0000${thread.participants.toLowerCase()}`;
        if (!t.trigram.every((w) => hay.includes(w))) return miss;
      }
    }
    for (const neg of t.negative) {
      if (docs.some((d) => matches(d, neg))) return miss;
    }
    return { matched: true, message: at };
  };
}

/**
 * A passage of `width` words around the first term that occurs in `body`:
 * a hit's preview. Terms are matched by prefix.
 */
export function excerpt(body: string, terms: readonly string[], width = 12): string {
  const tokens = body.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return "";
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t !== "");
  let at = -1;
  for (let i = 0; i < tokens.length && at === -1; i++) {
    const token = (tokens[i] as string)
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (needles.some((n) => token.startsWith(n))) at = i;
  }
  const start = Math.max(0, at === -1 ? 0 : at - Math.floor(width / 3));
  const slice = tokens.slice(start, start + width);
  return `${start > 0 ? "…" : ""}${slice.join(" ")}${start + width < tokens.length ? "…" : ""}`;
}

/** The query's positive text tokens, for the excerpt. */
export function queryTerms(q: SearchQuery): string[] {
  return [
    ...q.words.filter((w) => !w.negated),
    ...q.phrases.filter((p) => !p.negated),
    ...q.subject.filter((c) => !c.negated),
  ].flatMap((c) => c.text.split(/[^\p{L}\p{N}]+/u).filter((t) => t !== ""));
}

/** A Person list as the "name email" text the index sees. */
export function peopleText(people: readonly { name: string; email: string }[]): string {
  return people.map((p) => `${p.name} ${p.email}`).join(" ");
}
