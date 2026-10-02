// A View's scope by a full search (docs/spec/views.md, "Scope by a search";
// ADR 0016, amendment "a search as a scope"): the query language of the search
// box and the Agent's search_threads (packages/shared/src/search-query.ts),
// so a search that found exactly the right Threads becomes the View's scope.
// A scope stays true of a Thread until the Thread changes, so the query may
// only say what the mail says: words, phrases, from:, to:, subject: and
// has:attachment. Dates belong in `received` and `active` (a relative date
// would move every day), and read, starred, in:, tag: and label: change as the
// owner reads and files mail; those go in `folder`, or stay out.

import { parseQuery, type SearchQuery } from "../search-query.ts";

/** The query a scope holds, parsed: dates are refused, so the clock does not matter. */
export function parseScopeQuery(text: string): SearchQuery {
  return parseQuery(text, { now: new Date(0) });
}

/** Why a scope's query cannot be a View's scope, in words for the Agent; empty when it can. */
export function scopeQueryErrors(text: string): string[] {
  const q = parseScopeQuery(text);
  const errors: string[] = [];
  if (q.before !== null || q.after !== null) {
    errors.push(
      "query: dates go in the scope's received or active, not before:, after:, older_than: or newer_than:",
    );
  }
  if (
    q.unread !== null ||
    q.starred !== null ||
    q.group.length > 0 ||
    q.tags.length > 0 ||
    q.labels.length > 0
  ) {
    errors.push(
      "query: is:, in:, tag: and label: change as mail is read and filed; use the scope's folder, or leave them out",
    );
  }
  const positive = [...q.words, ...q.phrases, ...q.from, ...q.to, ...q.subject].some(
    (c) => !c.negated && c.text.trim() !== "",
  );
  if (!positive) {
    errors.push(
      "query: needs a word, a quoted phrase, from:, to: or subject: to look for, not only words to leave out",
    );
  }
  return errors;
}
