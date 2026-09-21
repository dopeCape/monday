// Judgments (CONTEXT.md, ADR 0012): typed questions a System One model answers
// with probabilities, never text. monday uses them where a decision is needed
// and a sentence is not: which Group, which Section, whether a Brief is worth
// writing, what the palette's sentence asks for. Generation stays with the
// language models (ADR 0007). Runtime-neutral: types only.

import type { HostedProvider } from "./domain.ts";

/** The providers that answer judgments; the LLM providers stay HostedProvider. */
export type JudgeProvider = "typesafe";
/** Every provider a key can be stored for. */
export type KeyProvider = HostedProvider | JudgeProvider;

/**
 * The Meter names the judgment by what asked for it, so the Meter page shows
 * routing, sections, chips and the rest as their own lines beside the Tasks.
 */
export type JudgeTask =
  | "judge.route"
  | "judge.section"
  | "judge.policy"
  | "judge.chips"
  | "judge.intent"
  | "judge.guard"
  | "judge.verify"
  | "judge.rerank"
  | "judge.condition";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One of a defined set. `criteria` maps option names to descriptions (null when the name says it all). */
export interface ChoiceQuestion {
  type: "choice";
  instructions: JsonValue;
  criteria: Record<string, JsonValue | null>;
}

/** Whether a statement holds; the answer is the probability of yes. */
export interface NoulQuestion {
  type: "noul";
  instructions: JsonValue;
  criteria?: { true: string; false: string } | undefined;
}

/** A position on ordered levels, low to high; each level describes a concrete situation. */
export interface ScoreQuestion {
  type: "score";
  instructions: JsonValue;
  criteria: JsonValue[];
}

export type JudgeQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type JudgeQuestions = Record<string, JudgeQuestion>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /** How peaked the distribution is, 0 to 1; low means no clear winner. */
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  /** The probability that the statement holds. Near 0.5 is uncertain, not medium. */
  noul: number;
}

export interface ScoreAnswer {
  type: "score";
  /** A position along the levels, 0 to levels - 1, possibly between two. */
  score: number;
  probabilities: number[];
  confidence: number;
}

export type JudgeAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export type AnswerFor<Q extends JudgeQuestion> = Q extends ChoiceQuestion
  ? ChoiceAnswer
  : Q extends NoulQuestion
    ? NoulAnswer
    : ScoreAnswer;

export type JudgeAnswers<Q extends JudgeQuestions> = { [K in keyof Q]: AnswerFor<Q[K]> };

export interface JudgeUsage {
  /** System One prices input only; output is free. */
  inputTokens: number;
}

/** What a judge provider returns for one request. */
export interface JudgeResponse<Q extends JudgeQuestions = JudgeQuestions> {
  answers: JudgeAnswers<Q>;
  /** The versioned model that answered, for the Meter and for pinning thresholds. */
  model: string;
  usage: JudgeUsage;
}

/** The judgments monday keeps per Thread once the arrival request has run (slice 25). */
export interface ThreadJudgments {
  threadId: string;
  /** A person wrote to the owner and expects a reply. */
  needsReply: number;
  /** The owner wrote last and is waiting on someone else. */
  waitingOnOthers: number;
  newsletter: number;
  automated: number;
  /** 0 nothing to summarize, 1 a little, 2 useful, 3 essential. */
  briefWorth: number;
  /** 0 no deadline, 1 this week, 2 today or tomorrow, 3 right now. */
  urgency: number;
  /** Per action chip name, the probability the owner wants it first. */
  chips: Record<string, number>;
  model: string;
  judgedAt: string;
}
