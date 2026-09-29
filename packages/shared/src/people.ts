// People: who the user writes with, for every place the app offers a person
// (the composer's To, Cc and Bcc first). Two sources answer the same query:
// the Cache's people table, at once, and the Server's people index over the
// whole mailbox, a moment later (GET /people). Both match the same way (a
// prefix of a word of the name, or of the address, its local part, its
// domain, or a piece of either) and rank with the same score, so the merged
// list reads as one.
//
// Runtime-neutral: no Bun, no DOM.

import type { IsoDate } from "./domain.ts";

/** One person the index knows, with what the score is made of. */
export interface PersonHit {
  name: string;
  /** Lowercased. */
  email: string;
  /** Messages the user sent them (To or Cc), plus sends not yet seen back from the Provider. */
  sent: number;
  /** Messages they sent the user. */
  received: number;
  /** The newest Message either way, or with them on it. */
  lastAt: IsoDate | null;
  score: number;
}

/** GET /people?workspace=&q=&limit= */
export interface PeopleSearchPage {
  people: PersonHit[];
}

/** How the score weighs its three parts (the people.weights and people.recency_half_life_days Settings). */
export interface PeopleRanking {
  /** Weight of ln(1 + sent), ln(1 + received) and the recency decay, in that order. */
  weights: readonly [number, number, number];
  halfLifeDays: number;
}

const DAY_MS = 86_400_000;
/** The recency term is floored here so a very old date never underflows (and matches the SQL). */
const MIN_EXPONENT = -50;

/**
 * The score both sources rank by: how often the user sent to the person
 * (weighted strongest by default), how often they wrote to the user, and a
 * recency term that halves every `halfLifeDays`. Counts are log-damped so a
 * newsletter's thousand Messages do not bury a colleague.
 */
export function personScore(
  stats: { sent: number; received: number; lastAt: IsoDate | null },
  now: Date,
  ranking: PeopleRanking,
): number {
  const [ws, wr, wt] = ranking.weights;
  let recency = 0;
  if (stats.lastAt) {
    const ageDays = (now.getTime() - Date.parse(stats.lastAt)) / DAY_MS;
    if (Number.isFinite(ageDays)) {
      const exponent = Math.min(
        0,
        Math.max(MIN_EXPONENT, (-Math.LN2 * ageDays) / Math.max(ranking.halfLifeDays, 1e-6)),
      );
      recency = Math.exp(exponent);
    }
  }
  return (
    ws * Math.log1p(Math.max(0, stats.sent)) +
    wr * Math.log1p(Math.max(0, stats.received)) +
    wt * recency
  );
}

/** The recency exponent's floor, for the SQL twin of personScore. */
export const PEOPLE_MIN_EXPONENT = MIN_EXPONENT;

/**
 * The query as the index reads it: lowercased words, each of which must
 * prefix-match some term of the person. A word with punctuation in it
 * ("kenji.w", "o'brien") also matches when each of its pieces does.
 */
export interface PeopleQueryWord {
  word: string;
  pieces: string[];
}

export function peopleQueryWords(q: string): PeopleQueryWord[] {
  const out: PeopleQueryWord[] = [];
  for (const raw of q.toLowerCase().split(/[\s,;<>"]+/)) {
    const word = raw.trim();
    if (!word) continue;
    const pieces = word.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (pieces.length === 0) continue;
    out.push({ word, pieces });
  }
  return out;
}

/**
 * The terms a person is found by: the words of the name, the address, its
 * local part, its domain, and every alphanumeric piece of the address. The
 * Cache and tests use this; the Server's generated column is its SQL twin.
 */
export function personTerms(p: { name: string; email: string }): string[] {
  const email = p.email.toLowerCase();
  const at = email.indexOf("@");
  const terms = new Set<string>();
  for (const w of p.name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w) terms.add(w);
  for (const w of email.split(/[^\p{L}\p{N}]+/u)) if (w) terms.add(w);
  if (email) terms.add(email);
  if (at > 0) terms.add(email.slice(0, at));
  if (at >= 0 && at < email.length - 1) terms.add(email.slice(at + 1));
  return [...terms];
}

/** Whether a person matches every word of the query (see peopleQueryWords). */
export function personMatches(
  p: { name: string; email: string },
  words: readonly PeopleQueryWord[],
): boolean {
  if (words.length === 0) return false;
  const terms = personTerms(p);
  const has = (prefix: string) => terms.some((t) => t.startsWith(prefix));
  return words.every(
    (w) => has(w.word) || (w.pieces.length > 1 && w.pieces.every((piece) => has(piece))),
  );
}

/**
 * Merges the Cache's people and the Server's into one ranked list, one row
 * per address. A Server row wins over the Cache's for the same address (it
 * counts the whole mailbox); the Cache's name fills in when the Server has
 * none. Excluded addresses (already chosen, the user's own) are dropped.
 */
export function mergePeople(
  local: readonly PersonHit[],
  server: readonly PersonHit[] | null,
  exclude: Iterable<string>,
  limit: number,
): PersonHit[] {
  const skip = new Set([...exclude].map((e) => e.toLowerCase()));
  const byEmail = new Map<string, PersonHit>();
  for (const p of local) {
    const key = p.email.toLowerCase();
    if (!key || skip.has(key) || byEmail.has(key)) continue;
    byEmail.set(key, p);
  }
  for (const p of server ?? []) {
    const key = p.email.toLowerCase();
    if (!key || skip.has(key)) continue;
    const mine = byEmail.get(key);
    byEmail.set(key, { ...p, name: p.name || mine?.name || "" });
  }
  return [...byEmail.values()]
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email))
    .slice(0, Math.max(0, limit));
}
