// Filling Placeholders from the Thread (docs/spec/templates.md; the
// pre-parsed value extraction cookbook). Values are selected, never
// invented:
//   1. code finds candidates per type (packages/shared candidates.ts);
//   2. one request asks one Choice per Placeholder over its candidates, with
//      the Placeholder's hint in the instructions and a `none` option; a
//      first_name with exactly one other person on the Thread is filled by
//      code with no question, and a type with no candidates asks nothing;
//   3. code copies the pick verbatim and normalizes it by type. A pick below
//      templates.fill.confidence, or `none`, leaves the Placeholder unfilled
//      with its candidates, likeliest first.

import type {
  ChoiceQuestion,
  FillThread,
  JudgeQuestions,
  NormalizeOptions,
  Person,
  PlaceholderCandidate,
  PlaceholderFill,
  Template,
  TemplateFillResult,
} from "@monday/shared";
import { findCandidates, firstNameOf, otherPeople } from "@monday/shared";
import type { Ask } from "./ask.ts";
import { threadState } from "./thread.ts";

export const NONE = "none";

export interface FillSettings {
  confidence: number;
  candidatesMax: number;
  stateChars: number;
  question: string;
  none: string;
  normalize: NormalizeOptions;
}

/** The question id for a Placeholder. */
export const fillQuestionId = (name: string) => `fill_${name}`;

/** One Choice over a Placeholder's candidates, the hint in its instructions. */
export function fillQuestion(
  hint: string,
  candidates: readonly PlaceholderCandidate[],
  settings: Pick<FillSettings, "question" | "none">,
): ChoiceQuestion {
  const criteria: Record<string, null | string> = {};
  for (const c of candidates) if (c.span !== NONE) criteria[c.span] = null;
  criteria[NONE] = settings.none;
  return {
    type: "choice",
    instructions: settings.question.replaceAll("{hint}", hint || "a value from the thread"),
    criteria,
  };
}

/** A Thread for a new Message: only the To field's name can fill anything. */
export function threadForNewMessage(to: readonly Person[], owner: string): FillThread {
  return {
    subject: "",
    owner: owner ? [owner] : [],
    messages: [{ from: { name: "", email: owner }, to: [...to], cc: [], text: "" }],
  };
}

export async function fillFromThread(options: {
  ask: Ask;
  workspaceId: string;
  template: Template;
  thread: FillThread;
  settings: FillSettings;
  /** A new Message: nothing but the To name fills, and no question is asked. */
  newMessage?: boolean;
  jobId?: string | null;
}): Promise<TemplateFillResult> {
  const { template, thread, settings } = options;
  const people = otherPeople(thread).filter((p) => p.name.trim());
  const fills: PlaceholderFill[] = [];
  const questions: JudgeQuestions = {};
  const pending = new Map<string, PlaceholderCandidate[]>();

  for (const p of template.placeholders) {
    const unfilled = (candidates: PlaceholderCandidate[]): PlaceholderFill => ({
      name: p.name,
      value: null,
      span: null,
      by: null,
      confidence: 0,
      candidates,
    });
    if (options.newMessage) {
      const only = people.length === 1 ? people[0] : undefined;
      if (p.type === "first_name" && only) {
        fills.push({
          name: p.name,
          value: firstNameOf(only.name),
          span: only.name,
          by: "code",
          confidence: 1,
          candidates: [{ span: only.name, value: firstNameOf(only.name) }],
        });
      } else fills.push(unfilled([]));
      continue;
    }
    const candidates = findCandidates(p.type, thread, settings.candidatesMax, settings.normalize);
    if (candidates.length === 0) {
      fills.push(unfilled([]));
      continue;
    }
    // One other person on the Thread: their first name needs no question.
    const firstWords = new Set(people.map((x) => firstNameOf(x.name).toLowerCase()));
    if (p.type === "first_name" && people.length === 1 && firstWords.size === 1) {
      const only = candidates[0] as PlaceholderCandidate;
      fills.push({
        name: p.name,
        value: only.value,
        span: only.span,
        by: "code",
        confidence: 1,
        candidates,
      });
      continue;
    }
    questions[fillQuestionId(p.name)] = fillQuestion(p.hint, candidates, settings);
    pending.set(p.name, candidates);
    fills.push(unfilled(candidates));
  }

  if (pending.size === 0) return { templateId: template.id, fills, judge: "none" };
  const asked = await options.ask(threadState(thread, settings.stateChars), questions, {
    workspaceId: options.workspaceId,
    jobId: options.jobId ?? null,
  });
  if (!asked) return { templateId: template.id, fills, judge: "none" };

  const out = fills.map((f): PlaceholderFill => {
    const candidates = pending.get(f.name);
    if (!candidates) return f;
    const answer = (asked.answers as Record<string, unknown>)[fillQuestionId(f.name)] as
      | {
          type: "choice";
          choice: string;
          confidence: number;
          probabilities: Record<string, number>;
        }
      | undefined;
    if (answer?.type !== "choice") return f;
    const ranked = [...candidates].sort(
      (a, b) => (answer.probabilities[b.span] ?? 0) - (answer.probabilities[a.span] ?? 0),
    );
    const pick = candidates.find((c) => c.span === answer.choice);
    if (!pick || answer.confidence < settings.confidence) {
      return { ...f, candidates: ranked, confidence: answer.confidence };
    }
    return {
      name: f.name,
      value: pick.value,
      span: pick.span,
      by: "judge",
      confidence: answer.confidence,
      candidates: ranked,
    };
  });
  return { templateId: template.id, fills: out, judge: asked.by };
}
