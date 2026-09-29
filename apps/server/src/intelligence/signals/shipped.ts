// The shipped Signals (docs/spec/signals.md, "The shipped Signals"): their
// words are Settings (signals.questions.*, and the judgments.questions.* keys
// slice 25 named, which keep their names), so the user or the Agent can
// reword any of them and the Question version follows. Pure.

import type {
  ChipName,
  JudgeQuestion,
  NoulQuestion,
  ScoreQuestion,
  SignalGate,
  SignalKind,
  SignalOptionsFrom,
} from "@monday/shared";
import { chipSignalId, SHIPPED_CHIP_SIGNALS } from "@monday/shared";

/** A Signal as code wants it now, before its Question version is known. */
export interface WantedSignal {
  id: string;
  kind: SignalKind;
  question: JudgeQuestion;
  /** A Sort scope sentence; "arrival" for arrival only. */
  window: string;
  gate?: SignalGate | undefined;
  optionsFrom?: SignalOptionsFrom | undefined;
  /** Who reads it, in words for the Signals page. */
  consumers: string[];
}

export const SHIPPED_SETTING_KEYS = [
  "judgments.questions.needs_reply",
  "signals.questions.needs_reply.true",
  "signals.questions.needs_reply.false",
  "signals.questions.waiting_on_me",
  "signals.questions.waiting_on_me.true",
  "signals.questions.waiting_on_me.false",
  "judgments.questions.waiting_on_others",
  "judgments.questions.newsletter",
  "judgments.questions.automated",
  "judgments.questions.brief_worth",
  "judgments.questions.brief_worth_levels",
  "judgments.questions.urgency",
  "judgments.questions.urgency_levels",
  "judgments.questions.chip.reply",
  "judgments.questions.chip.call",
  "judgments.questions.chip.pay_or_file",
  "judgments.questions.chip.snooze",
] as const;

export type ShippedSettings = Record<(typeof SHIPPED_SETTING_KEYS)[number], string | string[]>;

const text = (s: ShippedSettings, key: (typeof SHIPPED_SETTING_KEYS)[number]) => s[key] as string;

const noul = (instructions: string, criteria?: { true: string; false: string }): NoulQuestion =>
  criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };

/** Every shipped Signal as the Settings word it now. `window` is the backfill scope. */
export function shippedSignals(s: ShippedSettings, window: string): WantedSignal[] {
  const out: WantedSignal[] = [];
  const add = (id: string, kind: SignalKind, question: JudgeQuestion, consumers: string[]) =>
    out.push({ id, kind, question, window, consumers });
  add(
    "needs_reply",
    "noul",
    noul(text(s, "judgments.questions.needs_reply"), {
      true: text(s, "signals.questions.needs_reply.true"),
      false: text(s, "signals.questions.needs_reply.false"),
    }),
    ["Needs your reply"],
  );
  add(
    "waiting_on_me",
    "noul",
    noul(text(s, "signals.questions.waiting_on_me"), {
      true: text(s, "signals.questions.waiting_on_me.true"),
      false: text(s, "signals.questions.waiting_on_me.false"),
    }),
    ["Waiting on you"],
  );
  add("waiting_on_others", "noul", noul(text(s, "judgments.questions.waiting_on_others")), [
    "Waiting on others",
  ]);
  add("newsletter", "noul", noul(text(s, "judgments.questions.newsletter")), ["Newsletters"]);
  add("automated", "noul", noul(text(s, "judgments.questions.automated")), [
    "Needs your reply",
    "Waiting on you",
  ]);
  const score = (instructions: string, levels: string[]): ScoreQuestion => ({
    type: "score",
    instructions,
    criteria: levels,
  });
  add(
    "brief_worth",
    "score",
    score(
      text(s, "judgments.questions.brief_worth"),
      s["judgments.questions.brief_worth_levels"] as string[],
    ),
    ["Brief policy"],
  );
  add(
    "urgency",
    "score",
    score(
      text(s, "judgments.questions.urgency"),
      s["judgments.questions.urgency_levels"] as string[],
    ),
    ["Sections"],
  );
  for (const chip of SHIPPED_CHIP_SIGNALS) {
    const key = `judgments.questions.chip.${chip}` as (typeof SHIPPED_SETTING_KEYS)[number];
    add(chipSignalId(chip as ChipName), "noul", noul(text(s, key)), ["Suggested actions"]);
  }
  return out;
}
