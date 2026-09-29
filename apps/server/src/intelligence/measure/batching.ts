// The batching measurement (docs/spec/signals.md, "Measure first"; slice 28):
// batched against one-Thread requests on the same sample, the same questions,
// two repeats per arm. Pure: the caller hands in the sample, the Groups and a
// way to ask, so the arms, the comparison, the verdict and the report are
// testable without a runtime, and the script's --fake mode runs this file
// with a fake `ask`.
//
// Every arm uses the Backlog sort's batch shape (routing/batch.ts): Threads
// under `threads.<key>`, the Groups and Examples once in the state, one
// question per Thread and judgment pointing at its Thread by path. A Single
// request is that shape with one Thread, so the only thing that changes
// between arms is how many Threads share a state.

import type {
  ChoiceAnswer,
  GroupId,
  JsonValue,
  JudgeAnswer,
  JudgeQuestion,
  NoulQuestion,
  ScoreQuestion,
  Thresholds,
} from "@monday/shared";
import {
  batchQuestion,
  estimateTokens,
  groupsJson,
  packBatches,
  threadJson,
} from "../routing/batch.ts";
import type { GroupText, ThreadFacts } from "../routing/classify.ts";
import { judgedPlacement, type RouteJudgeSettings } from "../routing/judge.ts";
import { eachPool } from "../signals/pool.ts";

/** The four arrival Nouls the measurement carries, by their Signal ids. */
export const EVAL_NOULS = ["needs_reply", "waiting_on_others", "newsletter", "automated"] as const;
export type EvalNoul = (typeof EVAL_NOULS)[number];

/** Where a Thread in the sample came from. */
export type EvalStratum = "newest" | "recent" | "older" | "labelled";

export interface EvalItem {
  id: string;
  facts: ThreadFacts;
  stratum: EvalStratum;
  /** The owner's own answer: the top-level Group they placed it in, or null for none. Absent when unlabelled. */
  label?: { groupId: GroupId | null } | undefined;
}

export interface EvalQuestionSettings {
  route: RouteJudgeSettings;
  nouls: Record<EvalNoul, string>;
  urgency: string;
  urgencyLevels: string[];
}

/** What one request returned, as the measurement reads it. */
export interface EvalAsked {
  answers: Record<string, JudgeAnswer>;
  inputTokens: number;
  costMicros: number;
  model: string;
}

export type EvalAsk = (
  state: JsonValue,
  questions: Record<string, JudgeQuestion>,
) => Promise<EvalAsked>;

export interface EvalInput {
  items: readonly EvalItem[];
  /** The top-level Groups as the Backlog sort sends them. */
  candidates: readonly GroupText[];
  owner: string;
  settings: EvalQuestionSettings;
  thresholds: Thresholds;
  thresholdOf?: (groupId: GroupId) => number | null;
  /** Threads per request per arm; 1 is Single. Default [1, 10, 50]. */
  arms?: readonly number[];
  /** Default 2. */
  repeats?: number;
  /** Token budgets per request (routing.backfill.request_tokens and state_tokens). */
  limits: { requestTokens: number; stateTokens: number };
  /** Requests in flight at once. */
  concurrency: number;
  ask: EvalAsk;
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
}

/** One Thread's answers in one repeat of one arm. */
export interface EvalAnswer {
  /** "route:<groupId>", "ask" or "none", after the thresholds. */
  outcome: string;
  confidence: number;
  nouls: Record<EvalNoul, number>;
  urgency: number;
}

export interface EvalRun {
  size: number;
  repeat: number;
  requests: number;
  inputTokens: number;
  costMicros: number;
  wallMs: number;
  answers: Map<string, EvalAnswer>;
}

/** Two runs compared Thread by Thread. */
export interface Comparison {
  threads: number;
  /** Placement agreement, in percent. */
  agreement: number;
  differing: string[];
  /** Noul decisions at 0.7 that agree, in percent. */
  noulAgreement: number;
  /** Mean absolute difference of the Noul probabilities. */
  noulMad: number;
  /** Mean absolute difference of the urgency Score. */
  urgencyMad: number;
}

export interface Accuracy {
  correct: number;
  count: number;
  /** Percent; null with no labelled Threads. */
  share: number | null;
}

export interface ArmReport {
  size: number;
  /** This arm's first repeat against Single's first (Single's own row compares repeat 2). */
  vsSingle: Comparison;
  /** This arm's repeat 1 against its repeat 2. */
  selfAgreement: number;
  accuracy: Accuracy;
  meanConfidence: number;
  /** Percent sent to Needs a decision. */
  askShare: number;
  requests: number;
  tokensPerThread: number;
  /** USD per Thread. */
  costPerThread: number;
  /** Seconds per 100 Threads. */
  wallPer100: number;
}

export interface BarCheck {
  id: 1 | 2 | 3 | 4;
  holds: boolean;
  /** Why, with the numbers. */
  detail: string;
}

export interface ArmVerdict {
  size: number;
  keep: boolean;
  inconclusive: boolean;
  checks: BarCheck[];
}

export interface BatchingReport {
  generatedAt: string;
  model: string;
  sample: Record<EvalStratum | "total", number>;
  noiseFloor: Comparison;
  arms: ArmReport[];
  verdicts: ArmVerdict[];
  /** The batch size the bars allow for the Group Choice, or null: one Thread per request. */
  recommendation: number | null;
}

/* ------------------------------ The questions ------------------------------ */

const pointer = (key: string) =>
  `The email thread to judge is \`threads.${key}\`; any other threads are there for other questions.`;

/** Question ids for one Thread of a request: `<key>__group`, `<key>__needs_reply`, ... */
export const questionId = (key: string, what: string) => `${key}__${what}`;

/** Every question for one Thread under its key, in the batch shape. */
export function evalQuestions(
  key: string,
  options: Readonly<Record<string, GroupId>>,
  settings: EvalQuestionSettings,
  withExamples: boolean,
): Record<string, JudgeQuestion> {
  const out: Record<string, JudgeQuestion> = {};
  out[questionId(key, "group")] = batchQuestion(key, options, settings.route, withExamples);
  for (const noul of EVAL_NOULS) {
    const q: NoulQuestion = {
      type: "noul",
      instructions: { question: settings.nouls[noul], thread: pointer(key) },
    };
    out[questionId(key, noul)] = q;
  }
  const urgency: ScoreQuestion = {
    type: "score",
    instructions: { question: settings.urgency, thread: pointer(key) },
    criteria: settings.urgencyLevels,
  };
  out[questionId(key, "urgency")] = urgency;
  return out;
}

/** One request's state and questions over a batch of Threads (one Thread for Single). */
export function evalRequest(
  batch: readonly EvalItem[],
  candidates: readonly GroupText[],
  owner: string,
  settings: EvalQuestionSettings,
): {
  state: JsonValue;
  questions: Record<string, JudgeQuestion>;
  options: Record<string, GroupId>;
  keys: string[];
} {
  const { options, groups, examples } = groupsJson(candidates, settings.route);
  const threads: Record<string, JsonValue> = {};
  const questions: Record<string, JudgeQuestion> = {};
  const keys: string[] = [];
  batch.forEach((item, i) => {
    const key = `t${i + 1}`;
    keys.push(key);
    const json = threadJson(item.facts, settings.route.snippetChars) as Record<string, JsonValue>;
    threads[key] = {
      ...json,
      owner_wrote_last: (item.facts.from?.email ?? "").toLowerCase() === owner.toLowerCase(),
    };
    Object.assign(questions, evalQuestions(key, options, settings, examples.length > 0));
  });
  const state: Record<string, JsonValue> = { owner, groups, threads };
  if (examples.length > 0) state.examples = examples;
  return { state, questions, options, keys };
}

/* ------------------------------ Running the arms ------------------------------ */

const outcomeOf = (placement: ReturnType<typeof judgedPlacement>["placement"]) =>
  placement.kind === "route" ? `route:${placement.groupId}` : placement.kind;

/** Packs the sample for one arm the way the Backlog sort packs today. */
export function packArm(input: EvalInput, size: number): EvalItem[][] {
  const { groups, examples, options } = groupsJson(input.candidates, input.settings.route);
  const base = estimateTokens({ owner: input.owner, groups, examples });
  const question = estimateTokens(
    evalQuestions("t000", options, input.settings, examples.length > 0),
  );
  return packBatches(
    input.items,
    base,
    (it) => ({
      state: estimateTokens(threadJson(it.facts, input.settings.route.snippetChars)) + 4,
      question,
    }),
    {
      count: size,
      requestTokens: input.limits.requestTokens,
      stateTokens: input.limits.stateTokens,
    },
  );
}

/** Every arm, every repeat. Requests of one run go out `concurrency` at a time. */
export async function runArms(input: EvalInput): Promise<EvalRun[]> {
  const arms = input.arms ?? [1, 10, 50];
  const repeats = Math.max(1, input.repeats ?? 2);
  const now = input.now ?? (() => Date.now());
  const packed = arms.map((size) => ({ size, batches: packArm(input, size) }));
  const total = packed.reduce((n, a) => n + a.batches.length, 0) * repeats;
  let done = 0;
  const runs: EvalRun[] = [];
  for (const { size, batches } of packed) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const run: EvalRun = {
        size,
        repeat,
        requests: 0,
        inputTokens: 0,
        costMicros: 0,
        wallMs: 0,
        answers: new Map(),
      };
      const started = now();
      await eachPool(batches, input.concurrency, async (batch) => {
        const req = evalRequest(batch, input.candidates, input.owner, input.settings);
        const asked = await input.ask(req.state, req.questions);
        run.requests += 1;
        run.inputTokens += asked.inputTokens;
        run.costMicros += asked.costMicros;
        batch.forEach((item, i) => {
          const key = req.keys[i] as string;
          const group = asked.answers[questionId(key, "group")];
          if (group?.type !== "choice") return;
          const judged = judgedPlacement(
            group as ChoiceAnswer,
            req.options,
            input.thresholds,
            input.thresholdOf,
          );
          const nouls = {} as Record<EvalNoul, number>;
          for (const n of EVAL_NOULS) {
            const a = asked.answers[questionId(key, n)];
            nouls[n] = a?.type === "noul" ? a.noul : 0.5;
          }
          const u = asked.answers[questionId(key, "urgency")];
          run.answers.set(item.id, {
            outcome: outcomeOf(judged.placement),
            confidence: judged.confidence,
            nouls,
            urgency: u?.type === "score" ? u.score : 0,
          });
        });
        done += 1;
        input.onProgress?.(done, total);
      });
      run.wallMs = Math.max(0, now() - started);
      runs.push(run);
    }
  }
  return runs;
}

/* ------------------------------ Comparing ------------------------------ */

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 10_000) / 100);
const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

/** Two runs over the Threads both answered. */
export function compare(a: EvalRun, b: EvalRun, noulAt = 0.7): Comparison {
  const ids = [...a.answers.keys()].filter((id) => b.answers.has(id)).sort();
  let same = 0;
  let noulSame = 0;
  let noulCount = 0;
  let noulDiff = 0;
  let urgencyDiff = 0;
  const differing: string[] = [];
  for (const id of ids) {
    const x = a.answers.get(id) as EvalAnswer;
    const y = b.answers.get(id) as EvalAnswer;
    if (x.outcome === y.outcome) same += 1;
    else differing.push(id);
    for (const n of EVAL_NOULS) {
      noulCount += 1;
      if (x.nouls[n] >= noulAt === y.nouls[n] >= noulAt) noulSame += 1;
      noulDiff += Math.abs(x.nouls[n] - y.nouls[n]);
    }
    urgencyDiff += Math.abs(x.urgency - y.urgency);
  }
  return {
    threads: ids.length,
    agreement: pct(same, ids.length),
    differing,
    noulAgreement: pct(noulSame, noulCount),
    noulMad: round(noulCount === 0 ? 0 : noulDiff / noulCount),
    urgencyMad: round(ids.length === 0 ? 0 : urgencyDiff / ids.length),
  };
}

/** Right when the placement names the Group the owner chose, or none when they chose none. */
export function accuracy(run: EvalRun, items: readonly EvalItem[]): Accuracy {
  let correct = 0;
  let count = 0;
  for (const item of items) {
    if (!item.label) continue;
    const answer = run.answers.get(item.id);
    if (!answer) continue;
    count += 1;
    const wanted = item.label.groupId === null ? "none" : `route:${item.label.groupId}`;
    if (answer.outcome === wanted) correct += 1;
  }
  return { correct, count, share: count === 0 ? null : pct(correct, count) };
}

function armReport(
  runs: readonly EvalRun[],
  single1: EvalRun,
  items: readonly EvalItem[],
): ArmReport {
  const r1 = runs.find((r) => r.repeat === 1) as EvalRun;
  const r2 = runs.find((r) => r.repeat === 2) ?? r1;
  const answers = [...r1.answers.values()];
  const threads = Math.max(1, r1.answers.size);
  const allThreads = runs.reduce((n, r) => n + r.answers.size, 0) || 1;
  const allWall = runs.reduce((n, r) => n + r.wallMs, 0);
  return {
    size: r1.size,
    vsSingle: r1.size === single1.size ? compare(single1, r2) : compare(single1, r1),
    selfAgreement: compare(r1, r2).agreement,
    accuracy: accuracy(r1, items),
    meanConfidence: round(answers.reduce((n, a) => n + a.confidence, 0) / threads),
    askShare: pct(answers.filter((a) => a.outcome === "ask").length, answers.length),
    requests: r1.requests,
    tokensPerThread: Math.round(runs.reduce((n, r) => n + r.inputTokens, 0) / allThreads),
    costPerThread: round(runs.reduce((n, r) => n + r.costMicros, 0) / allThreads / 1_000_000, 8),
    wallPer100: round(((allWall / allThreads) * 100) / 1000, 2),
  };
}

/** The bars in signals.md, for one batch arm against Single. */
export function verdictFor(arm: ArmReport, single: ArmReport, noise: Comparison): ArmVerdict {
  const checks: BarCheck[] = [];
  const floor = noise.agreement - 1;
  checks.push({
    id: 1,
    holds: arm.vsSingle.agreement >= floor && arm.vsSingle.agreement >= 97,
    detail: `placement agreement ${arm.vsSingle.agreement}% against a floor of ${round(floor, 2)}% (noise floor minus 1) and 97%`,
  });
  const labelled = arm.accuracy.count;
  const inconclusive =
    labelled < 30 || arm.accuracy.share === null || single.accuracy.share === null;
  checks.push({
    id: 2,
    holds: !inconclusive && (arm.accuracy.share as number) >= (single.accuracy.share as number) - 1,
    detail: inconclusive
      ? `only ${labelled} labelled threads (30 needed): inconclusive`
      : `accuracy ${arm.accuracy.share}% against Single's ${single.accuracy.share}% minus 1`,
  });
  const confDrop = round(single.meanConfidence - arm.meanConfidence);
  const askRise = round(arm.askShare - single.askShare, 2);
  checks.push({
    id: 3,
    holds: confDrop <= 0.03 && askRise <= 2,
    detail: `mean Group confidence ${confDrop >= 0 ? `${confDrop} lower` : `${-confDrop} higher`} (0.03 allowed); Needs a decision ${askRise >= 0 ? `${askRise} points higher` : `${-askRise} points lower`} (2 allowed)`,
  });
  checks.push({
    id: 4,
    holds: arm.vsSingle.noulAgreement >= 97,
    detail: `Noul decisions at 0.7 agree ${arm.vsSingle.noulAgreement}% (97% needed)`,
  });
  return { size: arm.size, keep: checks.every((c) => c.holds), inconclusive, checks };
}

/** The runs as the report's numbers, the verdict per batch arm, and the recommendation. */
export function summarize(
  runs: readonly EvalRun[],
  items: readonly EvalItem[],
  meta: { generatedAt: string; model: string },
): BatchingReport {
  const sizes = [...new Set(runs.map((r) => r.size))].sort((a, b) => a - b);
  const singleSize = sizes[0] ?? 1;
  const single1 = runs.find((r) => r.size === singleSize && r.repeat === 1);
  if (!single1) throw new Error("the measurement needs a Single arm");
  const single2 = runs.find((r) => r.size === singleSize && r.repeat === 2) ?? single1;
  const noiseFloor = compare(single1, single2);
  const arms = sizes.map((size) =>
    armReport(
      runs.filter((r) => r.size === size),
      single1,
      items,
    ),
  );
  const singleArm = arms[0] as ArmReport;
  const verdicts = arms.slice(1).map((arm) => verdictFor(arm, singleArm, noiseFloor));
  const kept = verdicts.filter((v) => v.keep).map((v) => v.size);
  const sample = { total: items.length, newest: 0, recent: 0, older: 0, labelled: 0 };
  for (const item of items) sample[item.stratum] += 1;
  sample.labelled = items.filter((i) => i.label).length;
  return {
    generatedAt: meta.generatedAt,
    model: meta.model,
    sample,
    noiseFloor,
    arms,
    verdicts,
    // Ties go to one Thread per request; the largest size that passes every bar otherwise.
    recommendation: kept.length ? Math.max(...kept) : null,
  };
}

/** Measures: runs every arm and summarizes. */
export async function measureBatching(input: EvalInput): Promise<BatchingReport> {
  let model = "";
  const ask: EvalAsk = async (state, questions) => {
    const asked = await input.ask(state, questions);
    model ||= asked.model;
    return asked;
  };
  const runs = await runArms({ ...input, ask });
  return summarize(runs, input.items, {
    generatedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
    model,
  });
}
