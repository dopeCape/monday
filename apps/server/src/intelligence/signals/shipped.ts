// The shipped Signals (docs/spec/signals.md, "The shipped Signals"): their
// words are Settings (signals.questions.*, and the judgments.questions.* keys
// slice 25 named, which keep their names), so the user or the Agent can
// reword any of them and the Question version follows. Pure.

import type {
  JudgeQuestion,
  NoulQuestion,
  ScoreQuestion,
  SignalGate,
  SignalKind,
  SignalOptionsFrom,
} from "@monday/shared";

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
  "signals.questions.personal",
  "signals.questions.personal.true",
  "signals.questions.personal.false",
  "signals.questions.has_deadline",
  "signals.questions.has_deadline.true",
  "signals.questions.has_deadline.false",
  "signals.questions.deadline_parts",
  "signals.questions.money_involved",
  "signals.questions.money_involved.true",
  "signals.questions.money_involved.false",
  "signals.questions.money_amount",
  "signals.questions.money_amount.none",
  "signals.questions.money_direction",
  "signals.questions.money_direction.options",
  "signals.questions.frustrated",
  "signals.questions.frustrated.levels",
  "signals.questions.owner_promised",
  "signals.questions.they_promised",
] as const;

type PartWords = Record<
  string,
  { instructions: string; criteria?: Record<string, string | null> | undefined }
>;

export type ShippedSettings = Record<
  (typeof SHIPPED_SETTING_KEYS)[number],
  string | string[] | PartWords | Record<string, string>
>;

/** The Signals added in slice 32, which the arrival request asks only while signals.enabled is on. */
export const NEW_SHIPPED_SIGNALS: readonly string[] = [
  "personal",
  "has_deadline",
  "deadline_form",
  "deadline_month",
  "deadline_day",
  "deadline_year",
  "deadline_anchor",
  "deadline_weekday",
  "deadline_week",
  "deadline_hour",
  "money_involved",
  "money_amount",
  "money_direction",
  "frustrated",
  "owner_promised",
  "they_promised",
];

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** A date part's options: the ones code enumerates (months, days, weekdays, hours), then the described ones. */
function partOptions(
  id: string,
  described: Record<string, string | null>,
): Record<string, string | null> {
  const listed: string[] =
    id === "deadline_month"
      ? MONTHS
      : id === "deadline_day"
        ? Array.from({ length: 31 }, (_, i) => String(i + 1))
        : id === "deadline_weekday"
          ? WEEKDAYS
          : id === "deadline_hour"
            ? Array.from({ length: 24 }, (_, i) => String(i))
            : [];
  const out: Record<string, string | null> = {};
  for (const k of listed) out[k] = null;
  return { ...out, ...described };
}

/**
 * The year part's options, built by code for the Thread: the year it was
 * written and the next, before the described ones (none, other).
 */
export function yearOptions(q: JudgeQuestion, written: Date): JudgeQuestion {
  if (q.type !== "choice") return q;
  const y = written.getUTCFullYear();
  return { ...q, criteria: { [String(y)]: null, [String(y + 1)]: null, ...q.criteria } };
}

/** The amount Choice's options for one Thread: the spans code found, verbatim, then none. */
export function amountOptions(template: JudgeQuestion, spans: readonly string[]): JudgeQuestion {
  if (template.type !== "choice") return template;
  const criteria: Record<string, null | string> = {};
  for (const span of spans) criteria[span] = null;
  return { ...template, criteria: { ...criteria, ...template.criteria } };
}

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
    ["Needs your reply", "Recommended action: reply"],
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

  /* Slice 32. */
  const withCriteria = (id: string) =>
    noul(text(s, `signals.questions.${id}` as (typeof SHIPPED_SETTING_KEYS)[number]), {
      true: text(s, `signals.questions.${id}.true` as (typeof SHIPPED_SETTING_KEYS)[number]),
      false: text(s, `signals.questions.${id}.false` as (typeof SHIPPED_SETTING_KEYS)[number]),
    });
  add("personal", "noul", withCriteria("personal"), ["Recommended actions", "Views"]);
  add("has_deadline", "noul", withCriteria("has_deadline"), ["Recommended actions", "Views"]);
  const parts = s["signals.questions.deadline_parts"] as PartWords;
  for (const id of [
    "deadline_form",
    "deadline_month",
    "deadline_day",
    "deadline_year",
    "deadline_anchor",
    "deadline_weekday",
    "deadline_week",
    "deadline_hour",
  ]) {
    const words = parts[id];
    if (!words) continue;
    const criteria = partOptions(id, words.criteria ?? { none: null });
    out.push({
      id,
      kind: "choice",
      question: { type: "choice", instructions: words.instructions, criteria },
      window,
      // Asked only when code finds the text may state a date the owner acts by.
      gate: "deadline",
      consumers: ["The deadline's date"],
    });
  }
  add("money_involved", "noul", withCriteria("money_involved"), ["Recommended actions", "Views"]);
  out.push({
    id: "money_amount",
    kind: "choice",
    question: {
      type: "choice",
      instructions: text(s, "signals.questions.money_amount"),
      criteria: { none: text(s, "signals.questions.money_amount.none") },
    },
    window,
    gate: "amounts",
    optionsFrom: "amounts",
    consumers: ["The amount on a bill"],
  });
  add(
    "money_direction",
    "choice",
    {
      type: "choice",
      instructions: text(s, "signals.questions.money_direction"),
      criteria: s["signals.questions.money_direction.options"] as Record<string, string>,
    },
    ["Recommended actions"],
  );
  add(
    "frustrated",
    "score",
    score(
      text(s, "signals.questions.frustrated"),
      s["signals.questions.frustrated.levels"] as string[],
    ),
    ["Views"],
  );
  add("owner_promised", "noul", noul(text(s, "signals.questions.owner_promised")), ["Views"]);
  add("they_promised", "noul", noul(text(s, "signals.questions.they_promised")), ["Views"]);
  return out;
}
