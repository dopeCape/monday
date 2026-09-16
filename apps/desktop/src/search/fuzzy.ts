// A small fuzzy scorer for the palette: every character of the query must
// appear in the text in order; the score rewards matches at word starts,
// runs of consecutive matches and an early first match, and penalises gaps.
// No dependency, no allocation beyond the lowercase copies, synchronous.

const WORD_START = 8;
const CONSECUTIVE = 6;
const PREFIX = 10;
const EXACT = 40;
const GAP = -1;
const LEADING = -0.5;

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] as string;
  const cur = text[i] as string;
  if (/[\s\-_./:›>,]/.test(prev)) return true;
  // camelCase: a lower before an upper, checked on the original text.
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase() && /\p{L}/u.test(cur);
}

/**
 * One left-to-right pass. With `boundaries` the pass jumps to a word-start
 * occurrence of the next character when one is within reach, which finds
 * "mtg" in "Move to group"; without it the pass takes the earliest
 * occurrence, which finds "term" in "Term sheet redline". Null when the pass
 * cannot place every character.
 */
function pass(q: string, text: string, t: string, boundaries: boolean): number | null {
  let score = 0;
  let qi = 0;
  let last = -2;
  let first = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    if (boundaries && !isBoundary(text, i)) {
      const next = t.indexOf(q[qi] as string, i + 1);
      if (next !== -1 && next - i <= 12 && isBoundary(text, next)) {
        i = next - 1;
        continue;
      }
    }
    if (first === -1) first = i;
    if (i === last + 1) score += CONSECUTIVE;
    if (isBoundary(text, i)) score += WORD_START;
    if (last >= 0 && i > last + 1) score += GAP * Math.min(i - last - 1, 6);
    last = i;
    qi++;
  }
  if (qi < q.length) return null;
  if (first === 0) score += PREFIX;
  score += LEADING * Math.min(first, 20);
  return score;
}

/**
 * The match score of `query` against `text`, or null when the query's
 * characters do not all occur in order. Higher is better; an exact match
 * scores highest, then a prefix, then word-start matches.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const t = text.toLowerCase();
  if (q === t) return EXACT + PREFIX * q.length;
  const plain = pass(q, text, t, false);
  if (plain === null) return null;
  const jumpy = pass(q, text, t, true);
  return jumpy === null ? plain : Math.max(plain, jumpy);
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Every item whose label matches, best first; ties keep the input order. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  label: (item: T) => string,
): Scored<T>[] {
  const out: Scored<T>[] = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query, label(item));
    if (score !== null) out.push({ item, score: score - index * 1e-6 });
  });
  return out.sort((a, b) => b.score - a.score);
}
