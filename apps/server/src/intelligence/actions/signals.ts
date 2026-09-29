// The Recommended actions' Signals (docs/spec/actions.md, "The catalog"): a
// fit Noul per action, owned by the Recommended action and shipped, and the
// argument Choices asked speculatively in the same Signal request, read only
// when the fit holds. Code gates which questions are asked at all (a
// recipient Choice only when code found people to offer) and builds the
// per-Thread options. Their words are Settings (actions.recommended.*). Pure.

import type { ChoiceQuestion, JudgeQuestion, NoulQuestion } from "@monday/shared";
import type { WantedSignal } from "../signals/shipped.ts";

/** The Signal ids, one namespace per action (`action:<action>.<question>`). */
export const ACTION_SIGNAL = {
  archiveFits: "action:archive.fits",
  snoozeFits: "action:snooze.fits",
  snoozeAnchor: "action:snooze.anchor",
  snoozeWeekday: "action:snooze.weekday",
  snoozePart: "action:snooze.part",
  forwardFits: "action:forward.fits",
  delegateFits: "action:delegate.fits",
  forwardTo: "action:forward.to",
} as const;

export const RECOMMENDED_SIGNAL_SETTING_KEYS = [
  "actions.recommended.enabled",
  "actions.recommended.archive.enabled",
  "actions.recommended.archive.question",
  "actions.recommended.archive.question.true",
  "actions.recommended.archive.question.false",
  "actions.recommended.snooze.enabled",
  "actions.recommended.snooze.question",
  "actions.recommended.snooze.question.true",
  "actions.recommended.snooze.question.false",
  "actions.recommended.snooze.arguments",
  "actions.recommended.forward.enabled",
  "actions.recommended.forward.question",
  "actions.recommended.delegate.enabled",
  "actions.recommended.delegate.question",
  "actions.recommended.forward.to_question",
  "actions.recommended.forward.to_none",
] as const;

type Key = (typeof RECOMMENDED_SIGNAL_SETTING_KEYS)[number];
type ArgumentWords = Record<
  string,
  { instructions: string; criteria?: Record<string, string | null> | undefined }
>;
export type RecommendedSignalSettings = Record<Key, unknown>;

const text = (s: RecommendedSignalSettings, key: Key) => String(s[key] ?? "");

function noul(instructions: string, criteria?: { true: string; false: string }): NoulQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

function choice(words: ArgumentWords[string] | undefined, fallback: string): ChoiceQuestion {
  return {
    type: "choice",
    instructions: words?.instructions ?? fallback,
    criteria: { ...(words?.criteria ?? { none: null }) },
  };
}

/** The per-Thread options of the recipient Choice: the people code found, each with its one line, then none. */
export function recipientOptions(
  template: JudgeQuestion,
  people: ReadonlyArray<{ email: string; line: string }>,
): JudgeQuestion {
  if (template.type !== "choice") return template;
  const criteria: Record<string, string | null> = {};
  for (const p of people) criteria[p.email] = p.line || null;
  return { ...template, criteria: { ...criteria, ...template.criteria } };
}

/**
 * The action Signals the Settings declare now, for Threads in `window`. An
 * action switched off asks nothing; Reply asks nothing of its own (it reads
 * the shipped needs_reply).
 */
export function recommendedSignals(s: RecommendedSignalSettings, window: string): WantedSignal[] {
  if (s["actions.recommended.enabled"] === false) return [];
  const out: WantedSignal[] = [];
  const on = (action: string) => s[`actions.recommended.${action}.enabled` as Key] !== false;
  if (on("archive")) {
    out.push({
      id: ACTION_SIGNAL.archiveFits,
      kind: "noul",
      question: noul(text(s, "actions.recommended.archive.question"), {
        true: text(s, "actions.recommended.archive.question.true"),
        false: text(s, "actions.recommended.archive.question.false"),
      }),
      window,
      consumers: ["Recommended action: archive"],
    });
  }
  if (on("snooze")) {
    out.push({
      id: ACTION_SIGNAL.snoozeFits,
      kind: "noul",
      question: noul(text(s, "actions.recommended.snooze.question"), {
        true: text(s, "actions.recommended.snooze.question.true"),
        false: text(s, "actions.recommended.snooze.question.false"),
      }),
      window,
      consumers: ["Recommended action: snooze"],
    });
    const args = (s["actions.recommended.snooze.arguments"] ?? {}) as ArgumentWords;
    for (const [id, part, fallback] of [
      [ACTION_SIGNAL.snoozeAnchor, "anchor", "When should this thread come back?"],
      [ACTION_SIGNAL.snoozeWeekday, "weekday", "On which day of the week?"],
      [ACTION_SIGNAL.snoozePart, "part", "At which part of the day?"],
    ] as const) {
      out.push({
        id,
        kind: "choice",
        question: choice(args[part], fallback),
        window,
        consumers: ["Recommended action: snooze, when"],
      });
    }
  }
  const forward = on("forward");
  const delegate = on("delegate");
  if (forward) {
    out.push({
      id: ACTION_SIGNAL.forwardFits,
      kind: "noul",
      question: noul(text(s, "actions.recommended.forward.question")),
      window,
      consumers: ["Recommended action: forward"],
    });
  }
  if (delegate) {
    out.push({
      id: ACTION_SIGNAL.delegateFits,
      kind: "noul",
      question: noul(text(s, "actions.recommended.delegate.question")),
      window,
      consumers: ["Recommended action: hand to someone"],
    });
  }
  if (forward || delegate) {
    out.push({
      id: ACTION_SIGNAL.forwardTo,
      kind: "choice",
      question: {
        type: "choice",
        instructions: text(s, "actions.recommended.forward.to_question"),
        criteria: { none: text(s, "actions.recommended.forward.to_none") },
      },
      window,
      // Asked only when code found people to offer; the options are those people.
      gate: "addresses",
      optionsFrom: "addresses",
      consumers: ["Recommended action: forward, to whom"],
    });
  }
  return out;
}
