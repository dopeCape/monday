// The inline search's fallback, as data: which Threads a typed query matches
// when the Store's search module is absent (the fixtures), and the words a
// row marks. The Filter menu is list-filter.ts. Pure.

import type { Thread } from "@monday/shared";

/** The words of a typed query worth marking in a row: no operators, no quotes. */
export function searchTerms(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]+)"|(\S+)/g)) {
    const phrase = m[1];
    const word = m[2];
    if (phrase?.trim()) out.push(phrase.trim());
    else if (word && !word.startsWith("-")) {
      const colon = word.indexOf(":");
      // from:aoife and subject:invoice mark their value; is:unread and has:attachment mark nothing.
      const value = colon >= 0 ? word.slice(colon + 1) : word;
      const key = colon >= 0 ? word.slice(0, colon).toLowerCase() : "";
      if (value && !["is", "has", "in", "before", "after", "tag", "label"].includes(key)) {
        out.push(value);
      }
    }
  }
  return out;
}

/**
 * The fallback search without a Store: every term must appear in the
 * subject, the snippet or a participant, subject hits first, then newest.
 */
export function localSearch(threads: readonly Thread[], text: string): Thread[] {
  const terms = searchTerms(text).map((w) => w.toLowerCase());
  if (terms.length === 0) return [];
  const scored: Array<{ t: Thread; score: number }> = [];
  for (const t of threads) {
    const subject = t.subject.toLowerCase();
    const people = t.participants.map((p) => `${p.name} ${p.email}`.toLowerCase()).join(" ");
    const hay = `${subject} ${t.snippet.toLowerCase()} ${people}`;
    if (!terms.every((w) => hay.includes(w))) continue;
    const score = terms.filter((w) => subject.includes(w) || people.includes(w)).length;
    scored.push({ t, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.t.lastActivity.localeCompare(a.t.lastActivity))
    .map(({ t }) => t);
}
