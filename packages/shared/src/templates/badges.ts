// The three badges a draft_from_template Step's checks read as (docs/spec/
// templates.md, "Badges on the approval card"): the approval card, the Run's
// Step card and the waiting notification say the same words. Pure; the
// words are the strings.templates.badge.* Settings.

import type { CheckState, TemplateChecks } from "./types.ts";

export interface BadgeStrings {
  answersAll: string;
  answersSome: string;
  noPromises: string;
  promises: string;
  noDetails: string;
  details: string;
  confidential: string;
  couldNotCheck: string;
}

export interface Badge {
  key: "answers" | "promises" | "leaks";
  state: CheckState;
  text: string;
}

const fill = (s: string, v: Record<string, string | number>) =>
  s.replace(/\{([a-z]+)\}/g, (w, k: string) => (k in v ? String(v[k]) : w));

export function templateBadges(checks: TemplateChecks, s: BadgeStrings): Badge[] {
  const a = checks.answers;
  const p = checks.promises;
  const l = checks.leaks;
  return [
    {
      key: "answers",
      state: a.state,
      text:
        a.state === "unsure"
          ? s.couldNotCheck
          : a.state === "flagged"
            ? fill(s.answersSome, { n: a.unanswered.length, question: a.unanswered[0] ?? "" })
            : fill(s.answersAll, { n: a.answered, m: a.total }),
    },
    {
      key: "promises",
      state: p.state,
      text:
        p.state === "unsure"
          ? s.couldNotCheck
          : p.state === "flagged"
            ? fill(s.promises, { sentence: p.unsupported[0] ?? "" })
            : s.noPromises,
    },
    {
      key: "leaks",
      state: l.state,
      text:
        l.state === "unsure"
          ? s.couldNotCheck
          : l.details.length
            ? fill(s.details, { n: l.details.length, list: l.details.join(", ") })
            : l.confidential
              ? s.confidential
              : s.noDetails,
    },
  ];
}

/** The first badge that is not clean, for the line a waiting Run's notification carries. */
export function firstFlag(checks: TemplateChecks, s: BadgeStrings): string | null {
  return templateBadges(checks, s).find((b) => b.state !== "clean")?.text ?? null;
}
