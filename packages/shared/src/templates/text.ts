// Plain-text helpers the Templates code owns (docs/spec/templates.md, "Code,
// Jev, language model"): a Message's own words without the quoted history,
// sentence splitting, and the questions a message asks by its punctuation.

/** A Message's own words: quoted lines and everything from an "On ... wrote:" line on are dropped. */
export function ownWords(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*On .{3,200}wrote:\s*$/i.test(line)) break;
    if (/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The sentences of a text, in order: split after ".", "!" or "?" followed by
 * space and a capital, digit or quote, and at line breaks. Greetings and
 * sign-offs on their own lines come out as their own short sentences.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split(/\n+/)) {
    const line = block.trim();
    if (!line) continue;
    for (const piece of line.split(/(?<=[.!?])\s+(?=["'(\p{Lu}\p{N}])/u)) {
      const s = piece.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** Sentences that end in a question mark: the questions code can find without a model. */
export function questionSentences(sentences: readonly string[]): string[] {
  return sentences.filter((s) => /\?["')\]]*$/.test(s));
}
