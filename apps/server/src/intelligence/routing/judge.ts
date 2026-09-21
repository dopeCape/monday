// Routing as a Judgment (ADR 0012, slice 25): one Choice per stage with the
// candidate Groups as options plus `none`, the Thread facts as the state and
// the Groups' Examples inside the instructions. Placement reads the answer's
// probabilities (route at or above the Group's threshold, the ask band and
// the tie margin as before) and its confidence (Needs a decision below the
// ask threshold; `none` leaves the Thread alone). Pure, so the question and
// the placement are testable without a runtime; the language model path in
// classify.ts stays for a runtime without a judge.

import type {
  ChoiceAnswer,
  ChoiceQuestion,
  Confidence,
  GroupId,
  JsonValue,
  RoutePlacement,
  Score,
  Thresholds,
} from "@monday/shared";
import { clampConfidence, place } from "@monday/shared";
import type { GroupText, ThreadFacts } from "./classify.ts";

/** The option that places a Thread in no Group. */
export const NONE_OPTION = "none";

export interface RouteJudgeSettings {
  /** The routing question (routing.judge.instructions). */
  instructions: string;
  /** How the none option is described (routing.judge.none_option). */
  noneOption: string;
  snippetChars: number;
  examplesInPrompt: number;
}

export interface RouteQuestion {
  question: ChoiceQuestion;
  /** Option name to Group id, for reading the answer. */
  options: Record<string, GroupId>;
  state: JsonValue;
}

/** An option name from a Group's name: lowercase words joined by underscores, unique within the stage. */
export function optionName(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "group";
  let candidate = base === NONE_OPTION ? `${base}_group` : base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base}_${i}`;
  return candidate;
}

const person = (p: { name: string; email: string } | null): JsonValue =>
  p ? { name: p.name || null, email: p.email } : null;

function predicateJson(g: GroupText): JsonValue {
  const p = g.predicate;
  const out: Record<string, JsonValue> = {};
  if (p.senders?.length) out.senders = p.senders;
  if (p.domains?.length) out.domains = p.domains;
  if (p.subjectPatterns?.length) out.subject_contains = p.subjectPatterns;
  if (p.listIds?.length) out.list_ids = p.listIds;
  if (p.hasAttachment !== undefined) out.has_attachment = p.hasAttachment;
  return out;
}

/**
 * The Choice for one stage. Each option describes its Group by name,
 * sentence, criteria text and header facts; the Examples of every candidate
 * go into the instructions as the owner's past decisions, newest first,
 * capped per Group by the Setting.
 */
export function routeQuestion(
  facts: ThreadFacts,
  candidates: readonly GroupText[],
  owner: string,
  settings: RouteJudgeSettings,
): RouteQuestion {
  const options: Record<string, GroupId> = {};
  const criteria: Record<string, JsonValue> = {};
  const examples: JsonValue[] = [];
  const taken = new Set<string>([NONE_OPTION]);
  for (const g of candidates) {
    const key = optionName(g.name, taken);
    taken.add(key);
    options[key] = g.id;
    const description: Record<string, JsonValue> = { name: g.name, rule: g.sentence || null };
    if (g.prompt && g.prompt !== g.sentence) description.criteria = g.prompt;
    const always = predicateJson(g);
    if (Object.keys(always as object).length > 0) description.always = always;
    criteria[key] = description;
    const positives = g.examples.filter((e) => e.positive).slice(0, settings.examplesInPrompt);
    const negatives = g.examples.filter((e) => !e.positive).slice(0, settings.examplesInPrompt);
    for (const e of [...positives, ...negatives]) {
      examples.push({
        group: key,
        belongs: e.positive,
        from: person(e.from),
        subject: e.subject,
      });
    }
  }
  criteria[NONE_OPTION] = settings.noneOption;
  const listHeaders: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(facts.headers)) {
    if (["list-id", "list-unsubscribe", "precedence", "auto-submitted", "reply-to"].includes(k)) {
      listHeaders[k] = v;
    }
  }
  return {
    question: {
      type: "choice",
      instructions:
        examples.length > 0
          ? {
              question: settings.instructions,
              examples_note: "The owner's own past decisions; they outrank the descriptions.",
              examples,
            }
          : settings.instructions,
      criteria,
    },
    options,
    state: {
      owner,
      thread: {
        subject: facts.subject,
        from: person(facts.from),
        to: facts.to.map(person),
        also_on_thread: facts.participants
          .filter(
            (p) => p.email !== facts.from?.email && !facts.to.some((t) => t.email === p.email),
          )
          .map(person),
        message_count: facts.messageCount,
        has_attachments: facts.hasAttachments,
        list_headers: listHeaders,
        newest_message_snippet: facts.snippet.trim().slice(0, settings.snippetChars),
      },
    },
  };
}

export interface JudgedStage {
  scores: Score[];
  placement: RoutePlacement;
  /** The Choice's confidence, for the record. */
  confidence: Confidence;
}

/**
 * Where a Choice answer puts a Thread. The probabilities are the scores.
 * `none` leaves the Thread alone whatever the probabilities; a confidence
 * below the ask threshold is Needs a decision with the likeliest Groups as
 * candidates; otherwise the thresholds place the best Group as before.
 */
export function judgedPlacement(
  answer: ChoiceAnswer,
  options: Readonly<Record<string, GroupId>>,
  thresholds: Thresholds,
  groupThreshold: (groupId: GroupId) => Confidence | null = () => null,
): JudgedStage {
  const scores: Score[] = Object.entries(options).map(([key, groupId]) => ({
    groupId,
    confidence: clampConfidence(answer.probabilities[key] ?? 0),
  }));
  const sorted = [...scores].sort(
    (a, b) => b.confidence - a.confidence || a.groupId.localeCompare(b.groupId),
  );
  const confidence = clampConfidence(answer.confidence);
  const best = sorted[0] ?? null;
  if (answer.choice === NONE_OPTION || !best) {
    return { scores, placement: { kind: "none", best }, confidence };
  }
  if (confidence < thresholds.ask) {
    const above = sorted.filter((s) => s.confidence >= thresholds.ask);
    const candidates =
      above.length >= 2 ? above : sorted.slice(0, 2).filter((s) => s.confidence > 0);
    if (candidates.length === 0) return { scores, placement: { kind: "none", best }, confidence };
    return { scores, placement: { kind: "ask", candidates }, confidence };
  }
  return { scores, placement: place(scores, thresholds, groupThreshold), confidence };
}
