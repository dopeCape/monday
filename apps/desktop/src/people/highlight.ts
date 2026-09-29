// Which parts of a suggested name or address the typed words matched: each
// word (or piece of one) marks the start of the first term it prefixes, so
// "ken wat" marks "Ken" and "Wat" in "Kenji Watanabe".

import { peopleQueryWords } from "@monday/shared";

export interface Span {
  text: string;
  hit: boolean;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

export function highlightSpans(text: string, query: string): Span[] {
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  const needles = new Set<string>();
  for (const w of peopleQueryWords(query)) {
    needles.add(w.word);
    for (const p of w.pieces) needles.add(p);
  }
  // Longest first, so a whole typed address wins over its pieces.
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    let from = 0;
    while (from <= lower.length - needle.length) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      if (at === 0 || !isWordChar(lower[at - 1])) {
        if (!marked.slice(at, at + needle.length).some(Boolean)) {
          for (let i = at; i < at + needle.length; i++) marked[i] = true;
        }
        break;
      }
      from = at + 1;
    }
  }
  const out: Span[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = marked[i] ?? false;
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i] ?? "", hit });
  }
  return out;
}
