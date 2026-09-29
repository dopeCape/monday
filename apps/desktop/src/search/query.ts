// The client half of the search query language (ADR 0011): the shared
// parser (packages/shared/src/search-query.ts, the one the Server's full
// search uses too) compiled to one FTS5 MATCH expression plus SQL predicates
// over the Cache, and the box's autocomplete. Pure: no Store, no DOM.

import { hasBodyTerms, OPERATORS, type SearchQuery } from "@monday/shared";

export {
  type BooleanFilter,
  type Clause,
  emptyQuery,
  hasBodyTerms,
  hasOperator,
  isEmpty,
  OPERATORS,
  type Operator,
  type ParseOptions,
  parseAbsoluteDate,
  parseQuery,
  parseRelativeSpan,
  type SearchQuery,
} from "@monday/shared";

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
