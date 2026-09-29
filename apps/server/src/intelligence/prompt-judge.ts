// The language model's path for typed questions (ADR 0012: "every Judgment
// keeps a prompt path for the language model"): the same state and the same
// questions, one prompt, one JSON answer read back into the judge's answer
// shapes. A Noul comes back as a probability, a Choice as an option with a
// confidence the model states (not calibrated, so consumers keep their
// thresholds), a Score as a level. Anything unreadable becomes the no-match
// answer with confidence 0, which every consumer treats as unsure.

import type {
  ChoiceAnswer,
  JsonValue,
  JudgeAnswer,
  JudgeAnswers,
  JudgeQuestion,
  JudgeQuestions,
  Task,
} from "@monday/shared";
import type { HostedRuntime } from "./runtime/index.ts";

export const PROMPT_JUDGE_SYSTEM = [
  "You answer typed questions about a JSON state for software. You never write prose.",
  'Answer with one JSON object and nothing else: for each question id, a "noul" question gets the probability (0 to 1) that its statement holds;',
  'a "choice" question gets {"choice": "<one option name exactly as given>", "confidence": <0 to 1>}; a "score" question gets the index of the level (0 is the first).',
  "Read the state literally. Never compute dates, never invent an option.",
].join(" ");

/** The prompt: the state and the questions, as JSON. */
export function promptJudgePrompt(state: JsonValue, questions: JudgeQuestions): string {
  return `State:\n${JSON.stringify(state)}\n\nQuestions:\n${JSON.stringify(questions)}`;
}

function noMatch(q: JudgeQuestion): JudgeAnswer {
  if (q.type === "noul") return { type: "noul", noul: 0.5 };
  if (q.type === "score") {
    return {
      type: "score",
      score: 0,
      probabilities: q.criteria.map(() => 1 / q.criteria.length),
      confidence: 0,
    };
  }
  const names = Object.keys(q.criteria);
  const fallback =
    names.find((n) => n === "none" || n === "not_stated") ?? names[names.length - 1] ?? "";
  return {
    type: "choice",
    choice: fallback,
    probabilities: Object.fromEntries(names.map((n) => [n, n === fallback ? 1 : 0])),
    confidence: 0,
  };
}

const unit = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;

function readAnswer(q: JudgeQuestion, raw: unknown): JudgeAnswer {
  if (q.type === "noul") {
    const p = unit(raw) ?? unit((raw as { noul?: unknown } | null)?.noul);
    return p === null ? noMatch(q) : { type: "noul", noul: p };
  }
  if (q.type === "score") {
    const level = typeof raw === "number" ? Math.round(raw) : NaN;
    if (!Number.isInteger(level) || level < 0 || level >= q.criteria.length) return noMatch(q);
    return {
      type: "score",
      score: level,
      probabilities: q.criteria.map((_, i) => (i === level ? 1 : 0)),
      confidence: 1,
    };
  }
  const names = Object.keys(q.criteria);
  const picked = typeof raw === "string" ? raw : (raw as { choice?: unknown } | null)?.choice;
  const confidence =
    typeof raw === "string" ? 1 : (unit((raw as { confidence?: unknown } | null)?.confidence) ?? 0);
  if (typeof picked !== "string" || !names.includes(picked)) return noMatch(q);
  const answer: ChoiceAnswer = {
    type: "choice",
    choice: picked,
    probabilities: Object.fromEntries(
      names.map((n) => [
        n,
        n === picked ? confidence : (1 - confidence) / Math.max(1, names.length - 1),
      ]),
    ),
    confidence,
  };
  return answer;
}

/** The model's text read into answers; a question it skipped or garbled gets the no-match answer. */
export function readPromptJudgeOutput<Q extends JudgeQuestions>(
  output: string,
  questions: Q,
): JudgeAnswers<Q> {
  let parsed: Record<string, unknown> = {};
  const text = output.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [id, readAnswer(q, parsed[id])]),
  ) as JudgeAnswers<Q>;
}

/** One prompt through the Hosted runtime (or the Local runtime), metered under `task`. Throws what run() throws. */
export async function promptJudge<Q extends JudgeQuestions>(
  runtime: HostedRuntime,
  task: Task,
  state: JsonValue,
  questions: Q,
  options: { workspaceId: string; jobId?: string | null },
): Promise<{ answers: JudgeAnswers<Q>; model: string }> {
  const result = await runtime.run(
    task,
    { system: PROMPT_JUDGE_SYSTEM, prompt: promptJudgePrompt(state, questions) },
    { workspaceId: options.workspaceId, jobId: options.jobId ?? null },
  );
  return { answers: readPromptJudgeOutput(result.output, questions), model: result.model };
}
