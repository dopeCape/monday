// The judge path every Templates question takes (ADR 0012: "every Judgment
// keeps a prompt path for the language model"): TypeSafe when its key is on
// the Server, else the language model answering the same state and the same
// questions as one JSON object, else nobody, and the caller does without
// (no fill, no suggestion, "Could not check"). Which of the three answered
// is returned so the window can say so quietly.

import type {
  ChoiceAnswer,
  JsonValue,
  JudgeAnswer,
  JudgeAnswers,
  JudgeQuestion,
  JudgeQuestions,
} from "@monday/shared";
import type { Db } from "../../db/client.ts";
import { readGlobalSetting } from "../../settings/read.ts";
import {
  AiOffError,
  type HostedRuntime,
  NoJudgeError,
  NoProviderKeyError,
} from "../runtime/index.ts";

export type Answerer = "typesafe" | "llm";

export interface Asked<Q extends JudgeQuestions> {
  answers: JudgeAnswers<Q>;
  by: Answerer;
}

/** Asks typed questions over one state; null when nobody can answer now. */
export type Ask = <Q extends JudgeQuestions>(
  state: JsonValue,
  questions: Q,
  options: { workspaceId: string; jobId?: string | null },
) => Promise<Asked<Q> | null>;

export const PROMPT_JUDGE_SYSTEM = [
  "You answer typed questions about a JSON state for software. You never write prose.",
  'Answer with one JSON object and nothing else: for each question id, a "noul" question gets the probability (0 to 1) that its statement holds;',
  'a "choice" question gets {"choice": "<one option name exactly as given>", "confidence": <0 to 1>}; a "score" question gets {"level": <index of the level, 0 is the first>, "confidence": <0 to 1>}.',
  "Read the state literally. Never compute dates and never invent an option.",
].join(" ");

/** The Unsure answer: a Noul at 0.5, a Choice on its no-match option at confidence 0, a Score at 0. */
export function unsureAnswer(q: JudgeQuestion): JudgeAnswer {
  if (q.type === "noul") return { type: "noul", noul: 0.5 };
  if (q.type === "score") {
    return {
      type: "score",
      score: 0,
      probabilities: q.criteria.map(() => 1 / Math.max(1, q.criteria.length)),
      confidence: 0,
    };
  }
  const names = Object.keys(q.criteria);
  const fallback = names.find((n) => n === "none") ?? names.at(-1) ?? "";
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
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (q.type === "noul") {
    const p = unit(raw) ?? unit(o.noul) ?? unit(o.probability);
    return p === null ? unsureAnswer(q) : { type: "noul", noul: p };
  }
  if (q.type === "score") {
    const level =
      typeof raw === "number" ? raw : typeof o.level === "number" ? o.level : Number.NaN;
    const i = Math.round(level);
    if (!Number.isInteger(i) || i < 0 || i >= q.criteria.length) return unsureAnswer(q);
    const confidence = unit(o.confidence) ?? 1;
    return {
      type: "score",
      score: i,
      probabilities: q.criteria.map((_, k) => (k === i ? 1 : 0)),
      confidence,
    };
  }
  const names = Object.keys(q.criteria);
  const picked = typeof raw === "string" ? raw : o.choice;
  if (typeof picked !== "string" || !names.includes(picked)) return unsureAnswer(q);
  const confidence = typeof raw === "string" ? 1 : (unit(o.confidence) ?? 0);
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

/** The last JSON object in a model's answer, or null. */
function lastObject(text: string): Record<string, unknown> | null {
  const end = text.lastIndexOf("}");
  for (
    let start = text.indexOf("{");
    start >= 0 && start < end;
    start = text.indexOf("{", start + 1)
  ) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return null;
}

/** Reads the language model's JSON back into the judge's answer shapes; anything unreadable is Unsure. */
export function readPromptAnswers<Q extends JudgeQuestions>(
  questions: Q,
  text: string,
): JudgeAnswers<Q> {
  const raw = lastObject(text) ?? {};
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [id, readAnswer(q, raw[id])]),
  ) as JudgeAnswers<Q>;
}

export function promptJudgePrompt(state: JsonValue, questions: JudgeQuestions): string {
  return `State:\n${JSON.stringify(state)}\n\nQuestions:\n${JSON.stringify(questions)}`;
}

export function createAsk(options: {
  db: Db;
  runtime: HostedRuntime;
  log?: (message: string) => void;
}): Ask {
  const log = options.log ?? (() => {});
  return async (state, questions, opts) => {
    let llmAllowed = true;
    try {
      const r = await options.runtime.judge("judge.template", state, questions, {
        workspaceId: opts.workspaceId,
        jobId: opts.jobId ?? null,
      });
      return { answers: r.answers, by: "typesafe" };
    } catch (error) {
      if (error instanceof AiOffError) return null;
      if (!(error instanceof NoJudgeError)) {
        log(`templates: the judge failed, trying the language model: ${String(error)}`);
      }
      const choice = await readGlobalSetting(options.db, "ai.judge.provider");
      llmAllowed = choice !== "typesafe";
    }
    if (!llmAllowed) return null;
    try {
      const result = await options.runtime.run(
        "classify",
        { system: PROMPT_JUDGE_SYSTEM, prompt: promptJudgePrompt(state, questions) },
        { workspaceId: opts.workspaceId, jobId: opts.jobId ?? null },
      );
      return { answers: readPromptAnswers(questions, result.output), by: "llm" };
    } catch (error) {
      if (error instanceof NoProviderKeyError || error instanceof AiOffError) return null;
      log(`templates: the language model's judge failed: ${String(error)}`);
      return null;
    }
  };
}
