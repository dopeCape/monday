// The three checks on a Message drafted from a Template (docs/spec/templates.md,
// "Draft from a Template in a Workflow", Verify; the citation-check cookbook).
// One request over a state holding the newest message from someone else, the
// filled Template and the draft, split into sentences by code:
//   - Answers every question: the newest message's sentences ending in "?"
//     are questions by code; every other sentence gets the Noul "asks the
//     owner to do or answer something". Per sentence, speculatively, the Noul
//     "the draft answers or addresses it"; code keeps the ones that are asks.
//   - No promise the thread does not support: per draft sentence the Noul
//     "commits the owner", and speculatively the citation-check Choice
//     supported, partly, unsupported.
//   - No leak: code lists the details in the draft found in neither the
//     Thread, the Template nor the signature; one Noul over the whole draft
//     asks whether it shares confidential information nobody asked for.
// A Noul inside the Unsure band, or no judge at all, is "Could not check".
// Verification never rewrites the draft; it only marks.

import type {
  ChoiceAnswer,
  JsonValue,
  JudgeQuestions,
  NoulAnswer,
  TemplateChecks,
} from "@monday/shared";
import { ownWords, questionSentences, splitSentences } from "@monday/shared";
import type { Ask } from "./ask.ts";

export interface VerifySettings {
  /** A Noul closer than this to 0.5 is Unsure: "Could not check". */
  unsureBand: number;
  questions: {
    asks: string;
    answers: string;
    commits: string;
    supports: string;
    supportsCriteria: { supported: string; partly: string; unsupported: string };
    leak: string;
  };
}

export interface VerifyInput {
  ask: Ask;
  workspaceId: string;
  /** The newest message from someone else, its own words. */
  newest: { from: string; text: string };
  /** The whole Thread's text, for the details that must come from somewhere. */
  threadText: string;
  /** The Template with its Placeholders filled. */
  template: string;
  draft: string;
  signature: string;
  settings: VerifySettings;
  jobId?: string | null;
}

/* ------------------------------ Details not in the thread ------------------------------ */

const DETAIL_PATTERNS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\+?\d[\d\s().-]{7,}\d/g,
  /[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?/g,
  /\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|SEK|CHF)\b/g,
  /\b[A-Z]{2,6}[-_]?\d{2,}[A-Z0-9-]*\b/g,
];
const COMMON_CAPITALS = new Set(
  (
    "I Hi Hello Dear Thanks Thank Best Regards Cheers Kind Yes No Please Sorry Monday Tuesday Wednesday Thursday Friday Saturday Sunday " +
    "January February March April May June July August September October November December Mon Tue Wed Thu Fri Sat Sun"
  ).split(" "),
);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/**
 * Every address, phone number, amount, reference and capitalised name in the
 * draft that appears in neither the Thread, the Template nor the signature
 * ("details not in the thread"). Code only.
 */
export function detailsNotInThread(draft: string, sources: readonly string[]): string[] {
  const known = norm(sources.join("\n"));
  const found: string[] = [];
  const add = (d: string) => {
    const t = d.trim();
    if (t && !known.includes(norm(t)) && !found.includes(t)) found.push(t);
  };
  for (const p of DETAIL_PATTERNS)
    for (const m of draft.matchAll(new RegExp(p.source, p.flags))) add(m[0]);
  // A capitalised word that does not start a sentence, or a run of them: a name.
  for (const sentence of splitSentences(draft)) {
    const words = sentence.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = (words[i] ?? "").replace(/[^\p{L}'-]/gu, "");
      if (!/^\p{Lu}\p{Ll}+/u.test(w) || COMMON_CAPITALS.has(w)) continue;
      let name = w;
      // A name runs over capitalised words until punctuation ends it ("Priya, Ravi Menon" is two).
      while (i + 1 < words.length && !/[,.;:!?]$/.test(words[i] ?? "")) {
        const next = (words[i + 1] ?? "").replace(/[^\p{L}'-]/gu, "");
        if (!/^\p{Lu}\p{Ll}+/u.test(next) || COMMON_CAPITALS.has(next)) break;
        name += ` ${next}`;
        i++;
      }
      add(name);
    }
  }
  return found;
}

/* ------------------------------ The request ------------------------------ */

export function verifyQuestions(
  asked: readonly string[],
  draft: readonly string[],
  isQuestion: readonly boolean[],
  q: VerifySettings["questions"],
): JudgeQuestions {
  const out: JudgeQuestions = {};
  asked.forEach((_, i) => {
    if (!isQuestion[i]) {
      out[`ask_${i}`] = { type: "noul", instructions: q.asks.replaceAll("{i}", String(i)) };
    }
    out[`answered_${i}`] = { type: "noul", instructions: q.answers.replaceAll("{i}", String(i)) };
  });
  draft.forEach((_, j) => {
    out[`commits_${j}`] = { type: "noul", instructions: q.commits.replaceAll("{j}", String(j)) };
    out[`supported_${j}`] = {
      type: "choice",
      instructions: q.supports.replaceAll("{j}", String(j)),
      criteria: {
        supported: q.supportsCriteria.supported,
        partly: q.supportsCriteria.partly,
        unsupported: q.supportsCriteria.unsupported,
      },
    };
  });
  out.leak = { type: "noul", instructions: q.leak };
  return out;
}

export async function verifyDraft(input: VerifyInput): Promise<TemplateChecks> {
  const asked = splitSentences(ownWords(input.newest.text));
  const questions = new Set(questionSentences(asked));
  const isQuestion = asked.map((s) => questions.has(s));
  const draft = splitSentences(input.draft);
  const details = detailsNotInThread(input.draft, [
    input.threadText,
    input.template,
    input.signature,
  ]);

  const state: JsonValue = {
    newest_message: { from: input.newest.from, sentences: asked },
    template: input.template,
    draft,
  };
  const r = await input.ask(
    state,
    verifyQuestions(asked, draft, isQuestion, input.settings.questions),
    { workspaceId: input.workspaceId, jobId: input.jobId ?? null },
  );
  const band = input.settings.unsureBand;
  const unsure = (p: number) => Math.abs(p - 0.5) < band;

  if (!r) {
    return {
      answers: {
        state: asked.length ? "unsure" : "clean",
        answered: 0,
        total: questions.size,
        unanswered: [],
      },
      promises: { state: draft.length ? "unsure" : "clean", unsupported: [] },
      leaks: { state: details.length ? "flagged" : "unsure", details, confidential: false },
    };
  }
  const a = r.answers as Record<string, NoulAnswer | ChoiceAnswer | undefined>;
  const noul = (id: string) => (a[id]?.type === "noul" ? (a[id] as NoulAnswer).noul : 0.5);

  // Answers every question.
  let total = 0;
  let answered = 0;
  let unsureAnswers = false;
  const unanswered: string[] = [];
  asked.forEach((s, i) => {
    const ask = isQuestion[i] ? 1 : noul(`ask_${i}`);
    if (!isQuestion[i] && unsure(ask)) {
      unsureAnswers = true;
      return;
    }
    if (ask < 0.5) return;
    total++;
    const p = noul(`answered_${i}`);
    if (unsure(p)) unsureAnswers = true;
    else if (p >= 0.5) answered++;
    else unanswered.push(s);
  });
  const answers: TemplateChecks["answers"] = {
    state: unanswered.length ? "flagged" : unsureAnswers ? "unsure" : "clean",
    answered,
    total,
    unanswered,
  };

  // No promise the thread does not support.
  const unsupported: string[] = [];
  let unsurePromises = false;
  draft.forEach((s, j) => {
    const c = noul(`commits_${j}`);
    if (unsure(c)) {
      unsurePromises = true;
      return;
    }
    if (c < 0.5) return;
    const support = a[`supported_${j}`];
    const pick = support?.type === "choice" ? support.choice : null;
    // "partly" is not enough for a message that may go out unattended.
    if (pick === "supported") return;
    if (pick === null) unsurePromises = true;
    else unsupported.push(s);
  });
  const promises: TemplateChecks["promises"] = {
    state: unsupported.length ? "flagged" : unsurePromises ? "unsure" : "clean",
    unsupported,
  };

  // No leak.
  const leak = noul("leak");
  const confidential = !unsure(leak) && leak >= 0.5;
  const leaks: TemplateChecks["leaks"] = {
    state: details.length || confidential ? "flagged" : unsure(leak) ? "unsure" : "clean",
    details,
    confidential,
  };
  return { answers, promises, leaks };
}
