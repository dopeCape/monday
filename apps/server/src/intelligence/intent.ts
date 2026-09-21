// The palette's typed sentence as one Judgment request (ADR 0012, slice 27):
// one Choice per closed set (the function-calling pattern), one Noul for the
// scope, all over the same small state, answered in one round trip and
// metered under judge.intent. The Device assembles the intent from the
// reading (packages/shared/src/intent.ts) with its own clock and sets; the
// Server only asks. Every question's wording is a Setting.

import type {
  ChoiceAnswer,
  ChoiceQuestion,
  ChoiceReading,
  IntentReading,
  IntentRequest,
  JsonValue,
  NoulQuestion,
} from "@monday/shared";
import {
  contactOptions,
  groupOptions,
  INTENT_AGES,
  INTENT_HOURS,
  INTENT_THREAD_KINDS,
  INTENT_WEEKDAYS,
  sectionOptions,
  TYPED_INTENT_KINDS,
} from "@monday/shared";
import type { HostedRuntime } from "./runtime/index.ts";

export interface IntentSettings {
  contactsMax: number;
  questions: {
    intent: string;
    person: string;
    group: string;
    section: string;
    weekday: string;
    hour: string;
    scope: string;
    age: string;
    kind: string;
  };
  /** What each action option means, by option name. */
  intentCriteria: Record<string, string>;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const choice = (instructions: string, criteria: Record<string, string | null>): ChoiceQuestion => ({
  type: "choice",
  instructions,
  criteria,
});

const noul = (instructions: string): NoulQuestion => ({ type: "noul", instructions });

/** Options plus `none`, with a description per option when one is known. */
function withNone(entries: Array<[string, string | null]>): Record<string, string | null> {
  return Object.fromEntries([...entries, ["none", "The sentence names none of these."]]);
}

/** The questions for one request, over the closed sets the Device sent. */
export function intentQuestions(request: IntentRequest, settings: IntentSettings) {
  const q = settings.questions;
  return {
    intent: choice(
      q.intent,
      Object.fromEntries(TYPED_INTENT_KINDS.map((k) => [k, settings.intentCriteria[k] ?? null])),
    ),
    person: choice(
      q.person,
      withNone(
        contactOptions(request.contacts, settings.contactsMax).map(({ key, person }) => [
          key,
          person.name ? `${person.name} (${person.email})` : person.email,
        ]),
      ),
    ),
    group: choice(
      q.group,
      withNone(
        groupOptions(request.groups).map(({ key, group }) => [
          key,
          group.sentence ? `${group.name}: ${group.sentence}` : group.name,
        ]),
      ),
    ),
    section: choice(
      q.section,
      withNone(sectionOptions(request.sections).map(({ key, section }) => [key, section.name])),
    ),
    weekday: choice(q.weekday, Object.fromEntries(INTENT_WEEKDAYS.map((d) => [d, null]))),
    hour: choice(q.hour, Object.fromEntries(INTENT_HOURS.map((h) => [h, null]))),
    scope: noul(q.scope),
    age: choice(q.age, Object.fromEntries(INTENT_AGES.map((a) => [a, null]))),
    kind: choice(q.kind, Object.fromEntries(INTENT_THREAD_KINDS.map((k) => [k, null]))),
  };
}

/** The state the judge reads: the sentence and today, nothing else (large states distract). */
export function intentState(request: IntentRequest): JsonValue {
  // The Device's own date, read off the string it sent: converting to UTC could move the day.
  const day = /^\d{4}-\d{2}-\d{2}/.exec(request.now)?.[0];
  const at = day ? new Date(`${day}T12:00:00Z`) : null;
  return {
    typed: request.text,
    today: at && !Number.isNaN(at.getTime()) ? `${WEEKDAY_NAMES[at.getUTCDay()]} ${day}` : "",
  };
}

const reading = <K extends string>(answer: ChoiceAnswer): ChoiceReading<K> => ({
  choice: answer.choice as K,
  confidence: answer.confidence,
  probabilities: answer.probabilities,
});

/** One request; throws NoJudgeError or AiOffError like runtime.judge does. */
export async function judgeIntent(
  runtime: HostedRuntime,
  request: IntentRequest,
  settings: IntentSettings,
): Promise<IntentReading> {
  const result = await runtime.judge(
    "judge.intent",
    intentState(request),
    intentQuestions(request, settings),
    { workspaceId: request.workspace },
  );
  const a = result.answers;
  return {
    text: request.text,
    intent: reading(a.intent),
    person: reading(a.person),
    group: reading(a.group),
    section: reading(a.section),
    weekday: reading(a.weekday),
    hour: reading(a.hour),
    scope: a.scope.noul,
    age: reading(a.age),
    kind: reading(a.kind),
    model: result.model,
  };
}
