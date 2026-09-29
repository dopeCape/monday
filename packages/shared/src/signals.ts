// Signals (CONTEXT.md "Signal", "Fact", "Question version", "Unsure"; ADR
// 0014 on ADR 0012; docs/spec/signals.md): a standing Judgment monday keeps
// answered per Thread, one row shape for every question, asked in one request
// per Thread and read locally. Runtime-neutral: types, the shipped ids, and
// the pure reading rules every list and Section shares (the Unsure band,
// staleness, hysteresis).

import type { Id, IsoDate } from "./domain.ts";
import type {
  ChipName,
  ChoiceQuestion,
  JsonValue,
  NoulQuestion,
  ScoreQuestion,
  ThreadJudgments,
} from "./judge.ts";

export type SignalKind = "noul" | "choice" | "score";

/** Who declared a Signal. The same question from two owners is one Signal with two owners. */
export type SignalOwnerKind =
  | "shipped"
  | "section"
  | "custom_action"
  | "recommended_action"
  | "board"
  | "interruption";

export interface SignalOwner {
  kind: SignalOwnerKind;
  id: string | null;
}

/** Which Threads carry a Signal: a Sort scope sentence, and a Board's exact Fact filters. */
export interface SignalScope {
  /** "last 3 months" by default; "arrival" asks only on arrival (the Interruption policy). */
  window: string;
  facts?: Record<string, JsonValue> | undefined;
}

/** Ask only when code says the question can apply. */
export type SignalGate = "amounts" | "invite" | "deadline";

/** Per-Thread options built by code (the amounts a pattern found), never versioned. */
export type SignalOptionsFrom = "amounts" | "addresses" | "links" | "tracking" | "workflows";

export type SignalQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** A Signal as the Server keeps it and the Cache mirrors it. */
export interface SignalDef {
  id: string;
  owner: SignalOwner;
  kind: SignalKind;
  question: SignalQuestion;
  /** The Question version: up by one whenever the words, options, levels or the judge model change. */
  version: number;
  /** sha-256 of the canonical question JSON with the model; a new hash is a new version. */
  hash: string;
  scope: SignalScope;
  gate?: SignalGate | undefined;
  options?: { from: SignalOptionsFrom } | undefined;
  /** Who reads it; the Signal is active while this is not empty and its owner is enabled. */
  consumers: string[];
  active: boolean;
}

export type LowTrust = "not_english" | "image_only" | "hidden_instructions";

/** One stored answer: a Signal for a Thread at a Question version and a Thread version. */
export interface SignalAnswer {
  threadId: Id;
  signalId: string;
  version: number;
  model: string;
  judgedAt: IsoDate;
  threadVersion: { messageCount: number; latestMessageId: string };
  noul?: number | null | undefined;
  /** The picked option; for per-Thread options, the option key (the span itself is sealed). */
  choice?: string | null | undefined;
  score?: number | null | undefined;
  probabilities?: Record<string, number> | null | undefined;
  /** Choice and Score only; Nouls carry none. */
  confidence?: number | null | undefined;
  lowTrust?: LowTrust | null | undefined;
}

/** What a list reads about one answer: the numbers, and whether it is stale. */
export interface SignalReading {
  noul?: number | null | undefined;
  choice?: string | null | undefined;
  score?: number | null | undefined;
  confidence?: number | null | undefined;
  version?: number | undefined;
  /** Asked under an older Question version, or for an older Thread version. */
  stale?: boolean | undefined;
  lowTrust?: LowTrust | null | undefined;
}

/** Signal id to reading, for one Thread. */
export type SignalReadings = Readonly<Record<string, SignalReading>>;

/**
 * The Changes feed's `signals` change: one per Signal request, carrying the
 * answers that changed for one Thread; `removed` names answers dropped (an
 * owner deleted past its keep window), `deleted` drops them all.
 */
export interface SignalsChange {
  threadId: Id;
  answers: Array<{
    signalId: string;
    version: number;
    noul: number | null;
    choice: string | null;
    score: number | null;
    confidence: number | null;
    stale: boolean;
    lowTrust: LowTrust | null;
    judgedAt: IsoDate;
  }>;
  removed?: string[] | undefined;
  deleted?: boolean | undefined;
}

/** The Changes feed's `signal_def` change: a Signal created, reworded, retired. */
export interface SignalDefChange {
  id: string;
  kind: SignalKind;
  version: number;
  ownerKind: SignalOwnerKind;
  ownerId: string | null;
  active: boolean;
  /** The question in words for the Signals page and Explain. */
  label: string;
  deleted?: boolean | undefined;
}

/** A Signal backfill (slice 31): one walk per Workspace over signals.backfill.scope. */
export interface SignalBackfill {
  workspaceId: Id;
  /** `confirm` waits for the owner's yes above signals.backfill.confirm_above. */
  status: "confirm" | "running" | "waiting" | "paused" | "done" | "cancelled";
  /** Why it waits: the month's background budget is spent, nothing can answer, or the AI level. */
  reason: "budget" | "no_judge" | "level" | null;
  /** The Signals it fills. */
  signals: string[];
  scope: string;
  done: number;
  total: number;
  /** Threads that needed a request. */
  asked: number;
  calls: number;
  /** The count and cost it was estimated at, from the recent average tokens per Thread. */
  estimate: { threads: number; costMicros: number } | null;
  /** This month's background spending and the budget, micro-dollars. */
  budget: { spentMicros: number; budgetMicros: number } | null;
  startedAt: IsoDate;
  updatedAt: IsoDate;
  finishedAt: IsoDate | null;
  lastError: string | null;
}

/* ------------------------------ The shipped Signals ------------------------------ */

/** The chips the arrival request still asks until Recommended actions replace them (slice 34). */
export const SHIPPED_CHIP_SIGNALS: readonly ChipName[] = ["reply", "call", "pay_or_file", "snooze"];

/** Shipped Signal ids that stand in for the slice 25 arrival Judgments. */
export const ARRIVAL_SIGNALS = {
  needsReply: "needs_reply",
  waitingOnOthers: "waiting_on_others",
  newsletter: "newsletter",
  automated: "automated",
  briefWorth: "brief_worth",
  urgency: "urgency",
} as const;

export const chipSignalId = (chip: ChipName): string => `chip_${chip}`;

/** The Signals the shipped Sections read: what the language model is asked without TypeSafe (signals.llm_fallback). */
export const SHIPPED_SECTION_SIGNALS: readonly string[] = [
  "needs_reply",
  "waiting_on_me",
  "newsletter",
  "automated",
];

/** A Section's own Signal id, and a Custom action's. */
export const sectionSignalId = (sectionId: string) => `section:${sectionId}`;
export const actionSignalId = (actionId: string) => `action:${actionId}`;

/**
 * The slice 25 Judgments as the shipped Signals read them, for the brief
 * policy, the chips and the header-rule fallbacks that still read that shape.
 * Null until the Thread has at least one of them.
 */
export function judgmentsFromSignals(
  threadId: Id,
  readings: SignalReadings,
  meta: { model?: string; judgedAt?: string } = {},
): ThreadJudgments | null {
  const read = (id: string) => readings[id];
  const any = Object.values(ARRIVAL_SIGNALS).some((id) => read(id) !== undefined);
  if (!any) return null;
  const noul = (id: string) => read(id)?.noul ?? 0;
  const score = (id: string) => read(id)?.score ?? 0;
  const chips: Record<string, number> = {};
  for (const chip of SHIPPED_CHIP_SIGNALS) {
    const r = read(chipSignalId(chip));
    if (r?.noul !== undefined && r.noul !== null) chips[chip] = r.noul;
  }
  return {
    threadId,
    needsReply: noul(ARRIVAL_SIGNALS.needsReply),
    waitingOnOthers: noul(ARRIVAL_SIGNALS.waitingOnOthers),
    newsletter: noul(ARRIVAL_SIGNALS.newsletter),
    automated: noul(ARRIVAL_SIGNALS.automated),
    briefWorth: score(ARRIVAL_SIGNALS.briefWorth),
    urgency: score(ARRIVAL_SIGNALS.urgency),
    chips,
    model: meta.model ?? "",
    judgedAt: meta.judgedAt ?? "",
  };
}

/* ------------------------------ Reading an answer ------------------------------ */

/** The reading rules (signals.unsure.*, signals.stale_answers, signals.hysteresis, signals.non_english). */
export interface SignalRules {
  noulLow: number;
  noulHigh: number;
  confidenceBelow: number;
  /** `show` lets lists read a stale answer; `hide` treats it as not read. */
  staleAnswers: "show" | "hide";
  hysteresis: number;
}

export const DEFAULT_SIGNAL_RULES: SignalRules = {
  noulLow: 0.3,
  noulHigh: 0.7,
  confidenceBelow: 0.5,
  staleAnswers: "show",
  hysteresis: 0.05,
};

/** Whether a list may read this answer at all: present, and not stale while stale answers are hidden. */
export function readable(reading: SignalReading | undefined, rules: SignalRules): boolean {
  if (!reading) return false;
  return !(reading.stale && rules.staleAnswers === "hide");
}

/**
 * Whether something that acts may read this answer (docs/spec/signals.md,
 * "Lists may show a stale answer; nothing that acts reads one"): current
 * version, current Thread version, and no low trust while low trust counts
 * as Unsure for acting.
 */
export function actionable(
  reading: SignalReading | undefined,
  options: { nonEnglish?: "unsure" | "trust" } = {},
): boolean {
  if (!reading || reading.stale) return false;
  if (reading.lowTrust === "hidden_instructions" || reading.lowTrust === "image_only") return false;
  if (reading.lowTrust === "not_english" && (options.nonEnglish ?? "unsure") === "unsure") {
    return false;
  }
  return true;
}

export type SignalState = "holds" | "fails" | "unsure";

/**
 * A Noul by the Unsure band: at or above the high threshold holds, below the
 * low one fails, between them Unsure. A Choice or Score answer under the
 * confidence floor is Unsure whatever it picked.
 */
export function noulState(
  noul: number,
  rules: Pick<SignalRules, "noulLow" | "noulHigh">,
): SignalState {
  if (noul >= rules.noulHigh) return "holds";
  if (noul < rules.noulLow) return "fails";
  return "unsure";
}

/** One condition a Section rule (or a Lane) sets on a Signal. */
export interface SignalCondition {
  signal: string;
  at_least?: number | undefined;
  at_most?: number | undefined;
  /** A Choice's option. */
  is?: string | undefined;
}

/**
 * Whether a condition holds on a reading. A reading not there (not read yet,
 * or stale while hidden) never holds. A Choice or Score under the confidence
 * floor is Unsure and never holds. `inside` is true when the Thread is in
 * the Section already: its bounds relax by the hysteresis, so a Thread near
 * a threshold does not flicker in and out as its answers move a little.
 */
export function signalConditionHolds(
  cond: SignalCondition,
  reading: SignalReading | undefined,
  rules: SignalRules,
  inside = false,
): boolean {
  if (!readable(reading, rules) || !reading) return false;
  const h = inside ? rules.hysteresis : 0;
  const hasConfidence = reading.confidence !== undefined && reading.confidence !== null;
  if (reading.noul === undefined || reading.noul === null) {
    if (hasConfidence && (reading.confidence as number) < rules.confidenceBelow) return false;
  }
  if (cond.is !== undefined && reading.choice !== cond.is) return false;
  const value = reading.noul ?? reading.score ?? null;
  if (cond.at_least !== undefined) {
    if (value === null || value < cond.at_least - h) return false;
  }
  if (cond.at_most !== undefined) {
    if (value === null || value > cond.at_most + h) return false;
  }
  return true;
}

/* ------------------------------ Hashing ------------------------------ */

/** JSON with object keys sorted at every depth, so equal questions hash equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The words of a question, for the Signals page and Explain. */
export function questionLabel(question: SignalQuestion): string {
  const i = question.instructions;
  if (typeof i === "string") return i;
  if (i && typeof i === "object" && !Array.isArray(i)) {
    const o = i as Record<string, JsonValue>;
    for (const k of ["statement", "question"]) if (typeof o[k] === "string") return o[k] as string;
  }
  return JSON.stringify(i);
}
