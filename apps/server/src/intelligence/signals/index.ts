// The Signal store and the Signal request (ADR 0014; docs/spec/signals.md;
// slice 30). Every judgment monday keeps about a Thread is a Signal: an id,
// an owner, a question as sent, a Question version. Its answers live one row
// per Thread and Signal in signal_answers, stamped with the Question version
// and the Thread version they were asked for, and reach the Cache as one
// `signals` change per request, so every list is a query over numbers.
//
// The definitions follow the Settings: the shipped Signals' words, each
// Section's and Custom action's judge statement. A new wording (or a new
// judge model) is a new hash and a new Question version; answers under an
// older one are stale: lists may show them (signals.stale_answers), nothing
// that acts reads them.
//
// The Signal request is one Thread and every Signal that applies, in one
// request (split in two only when the questions would not fit TypeSafe's
// budgets), so a Signal added later never changes another's answer and one
// Thread is never asked twice for the same version. Without TypeSafe the
// language model is asked the Signals signals.llm_fallback allows.

import type {
  AiLevel,
  ExtractedItem,
  ExtractKind,
  FactsChange,
  Id,
  JsonValue,
  JudgeAnswer,
  JudgeQuestion,
  JudgeTask,
  LowTrust,
  Person,
  RowAnswer,
  SignalDefChange,
  SignalGate,
  SignalKind,
  SignalOptionsFrom,
  SignalOwner,
  SignalQuestion,
  SignalReading,
  SignalRules,
  SignalsChange,
  SignalsExplain,
  SignalsPage,
  ThreadJudgments,
  ViewScopeFacts,
} from "@monday/shared";
import {
  ARRIVAL_SIGNALS,
  actionSignalId,
  canonicalJson,
  judgmentsFromSignals,
  parseSortScope,
  questionLabel,
  SHIPPED_SECTION_SIGNALS,
  scopeAdmits,
  sectionSignalId,
} from "@monday/shared";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  accounts,
  invites,
  messages,
  signalAnswers,
  signalDefs,
  signalVersions,
  threadFacts,
  threads,
  workspaces,
} from "../../db/schema.ts";
import { type Mailstore, NotFoundError } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import { loadViewThreads } from "../../views/threads.ts";
import {
  listOptions,
  RECOMMENDED_SIGNAL_SETTING_KEYS,
  type RecommendedSignalSettings,
  recipientOptions,
  recommendedSignals,
} from "../actions/signals.ts";
import { sectionQuestion } from "../organize.ts";
import { estimateTokens } from "../routing/batch.ts";
import { extractJson } from "../routing/classify.ts";
import { countInScope, resolveScope } from "../routing/scope-query.ts";
import { type HostedRuntime, NoJudgeError, NoProviderKeyError } from "../runtime/index.ts";
import { type Candidate, extractKindOf, findCandidates } from "./candidates.ts";
import {
  assembleDeadline,
  type ClearFacts,
  computeFacts,
  type DeadlineParts,
  type FactMessage,
  mayStateDate,
  mayStateDeadline,
  parseAmount,
  type SealedFacts,
  type SenderStats,
} from "./facts.ts";
import {
  foldRows,
  planRows,
  type RowFold,
  type RowMessage,
  type RowPlan,
  type RowWords,
  rowModeOf,
} from "./rows.ts";
import {
  amountOptions,
  SHIPPED_SETTING_KEYS,
  type ShippedSettings,
  shippedSignals,
  type WantedSignal,
  yearOptions,
} from "./shipped.ts";
import { type StateMessage, signalState } from "./state.ts";

export type { Candidate } from "./candidates.ts";
export { shippedSignals, type WantedSignal } from "./shipped.ts";
export { dateInWords, ownWords, signalState } from "./state.ts";

const SETTING_KEYS = [
  ...SHIPPED_SETTING_KEYS,
  ...RECOMMENDED_SIGNAL_SETTING_KEYS,
  "signals.enabled",
  "signals.candidates.max",
  "views.extract.candidates_max",
  "views.extract.date_order",
  "views.extract.item_chars",
  "views.extract.many.threshold",
  "views.extract.many.max",
  "views.extract.many.note",
  "views.extract.many.yes",
  "views.each.item_note",
  "views.each.message_note",
  "views.grain.max_messages",
  "views.grain.message_chars",
  "signals.stats.window",
  "signals.stats.broad_above",
  "signals.stats.min_answers",
  "signals.deadline.min_confidence",
  "signals.state.newest_chars",
  "signals.state.thread_chars",
  "signals.state.earlier_chars",
  "signals.stale_answers",
  "signals.unsure.noul_low",
  "signals.unsure.noul_high",
  "signals.unsure.confidence_below",
  "signals.hysteresis",
  "signals.llm_fallback",
  "signals.llm_prompt",
  "signals.max_active",
  "signals.keep_inactive_days",
  "judgments.on_arrival",
  "ai.judge.model",
  "signals.backfill.scope",
  "routing.backfill.request_tokens",
  "routing.backfill.state_tokens",
  "calendar.time_zone",
  "sections.rules",
  "sections.examples",
  "routing.examples_in_prompt",
  "actions.custom",
] as const;

type Settings = Awaited<ReturnType<typeof readSettingsOf>>;
const readSettingsOf = (db: Db) => readGlobalSettings(db, SETTING_KEYS);

/** A definition as stored, with its current Question version. */
export interface StoredDef {
  id: string;
  owner: SignalOwner;
  kind: SignalKind;
  question: SignalQuestion;
  version: number;
  hash: string;
  window: string;
  /** A View's exact scope: its Signal is asked only of Threads these admit. */
  facts: ViewScopeFacts | null;
  gate: SignalGate | null;
  optionsFrom: SignalOptionsFrom | null;
  consumers: string[];
  active: boolean;
}

/** One stored answer as the Server reads it. */
export interface StoredAnswer extends SignalReading {
  signalId: string;
  version: number;
  model: string;
  judgedAt: string;
  messageCount: number;
  latestMessageId: string;
  probabilities: Record<string, number> | null;
  stale: boolean;
}

export interface ThreadVersion {
  messageCount: number;
  latestMessageId: string;
}

/** Why a Signal request is made; each is metered on its own line. */
/** `view` is a View's test before it is pinned (docs/spec/views.md): the user waits on it. */
export type AskReason = "arrival" | "background" | "backlog" | "view";

export interface AskOptions {
  reason: AskReason;
  /** Only these Signals (the backfill's missing ones); absent means every one that applies. */
  only?: readonly string[] | undefined;
  /** Ask again even when the answers cover this Thread version. */
  force?: boolean | undefined;
  /** Whether the language model may answer when TypeSafe cannot (signals.llm_fallback); default true. */
  llm?: boolean | undefined;
  /** Questions riding in the same request that are not Signals (routing's Group Choices). */
  extra?: Record<string, JudgeQuestion> | undefined;
  /**
   * Extra questions whose options code builds for this Thread (a View draft's
   * Extractions): asked only when code found candidates, their picks copied
   * and normalized into the result's `picks`.
   */
  extraOptions?: Record<string, SignalOptionsFrom> | undefined;
  /**
   * Answers this Thread version already has, by question id as asked (a View's
   * try before Pin view): they stand in for asking again when the Thread has
   * not changed since, and are written as if just answered.
   */
  prior?: PriorAnswers | undefined;
  jobId?: string | null | undefined;
}

/** What one Signal request answered, kept to be written later without asking again. */
export interface PriorAnswers {
  messageCount: number;
  latestMessageId: string;
  model: string;
  answers: Record<string, JudgeAnswer>;
}

/** A value an Extraction picked: the span as written, normalized by code, with the pick's confidence. */
export interface ExtractPick {
  text: string;
  value: JsonValue;
  confidence: number;
  /** The other spans code found, for "Wrong value". */
  candidates: string[];
  /** A many-Extraction's values (and the ones in the Unsure band), or one per Message. */
  items?: ExtractedItem[] | undefined;
  /** A per-row Signal's answers, by row key. */
  answers?: Record<string, RowAnswer> | undefined;
  /** Candidates past views.extract.many.max, not asked. */
  capped?: number | undefined;
}

export interface AskResult {
  /** The Signals answered by this request. */
  asked: string[];
  /** The answers to `extra`, by their ids. */
  extra: Record<string, JudgeAnswer | undefined>;
  /** For `extraOptions`: the value picked, or null when none was (or none could be). */
  picks: Record<string, ExtractPick | null>;
  /** For `extraOptions`: every span code found, the pick among them. */
  candidates: Record<string, string[]>;
  /** For `extraOptions`: the same spans as the judge saw them, with their option keys and words around them. */
  found?: Record<string, Array<Pick<Candidate, "key" | "span" | "line">>> | undefined;
  /** Requests made. */
  calls: number;
  /** Who answered: TypeSafe, the language model, or nobody. */
  by: "typesafe" | "llm" | null;
  /** Every answer by question id as asked, with the Thread version and model (a later `prior`). */
  prior?: PriorAnswers | undefined;
}

export interface SignalsSettings {
  enabled: boolean;
  onArrival: boolean;
  rules: SignalRules;
  llmFallback: "shipped_sections" | "all" | "none";
  maxActive: number;
}

/**
 * What code offers a Thread's per-Thread Choices besides what its text holds
 * (docs/spec/actions.md): the people a recipient Choice may pick, each with
 * its one line of Facts, and whom the owner forwarded this sender's mail to
 * (the state's sender history).
 */
export interface SignalCandidates {
  people: Array<{ email: string; name: string; line: string }>;
  forwardedTo: string[];
  /** The Workflows a Thread may be run through by hand, each with the sentence it was written from. */
  workflows?: Array<{ id: string; name: string; sentence: string }> | undefined;
}

export type CandidateSource = (input: {
  workspaceId: Id;
  threadId: Id;
  owner: string;
  sender: string;
  /** Addresses named in the Thread's text (a Fact, sealed). */
  named: readonly string[];
  /** Everyone already on the Thread. */
  participants: readonly string[];
}) => Promise<SignalCandidates>;

export interface Signals {
  /** Syncs the Workspace's definitions with the Settings; every definition, active or not. */
  defs(workspaceId: Id): Promise<StoredDef[]>;
  /** The Signal request for one Thread. Throws NoJudgeError when nothing can answer. */
  ask(workspaceId: Id, threadId: Id, options: AskOptions): Promise<AskResult>;
  /** Every stored answer for these Threads, with staleness, by Thread then Signal. */
  readings(threadIds: readonly Id[]): Promise<Map<Id, Record<string, StoredAnswer>>>;
  /** Answers written some other way (the owner's own, a judged Section asked on demand), at the current versions. */
  store(
    workspaceId: Id,
    threadId: Id,
    answers: Record<string, JudgeAnswer>,
    meta: { model: string },
  ): Promise<void>;
  /** The slice 25 Judgments as the shipped Signals hold them; `fresh` asks for current answers only. */
  judgments(threadId: Id, options?: { fresh?: boolean }): Promise<ThreadJudgments | null>;
  /** The Judgments of many Threads (any version), optionally only those asked since a moment. */
  listJudgments(
    workspaceId: Id,
    options: { since?: Date; threadIds?: readonly Id[] },
  ): Promise<ThreadJudgments[]>;
  /** The Threads with an answer to any of these Signals asked since a moment, with all their answers. */
  answeredSince(
    workspaceId: Id,
    signalIds: readonly string[],
    since: Date,
  ): Promise<Map<Id, Record<string, StoredAnswer>>>;
  /** The Signals page (slice 32): every active Signal with its reach and base rate. */
  page(workspaceId: Id): Promise<SignalsPage>;
  /** Explain on a Thread: its Signals with their numbers, versions and when asked, and its Facts. */
  explain(threadId: Id): Promise<SignalsExplain | null>;
  /**
   * The spans code finds of each kind in a Thread, as a View's Extractions
   * would see them: no judge, no answer written (the test's choice of Threads
   * and inspect_view_thread read it). Decrypts the newest Messages.
   */
  candidates(
    workspaceId: Id,
    threadId: Id,
    kinds: readonly ExtractKind[],
  ): Promise<Partial<Record<ExtractKind, Candidate[]>>>;
  /** The Signals the arrival request would ask that this Thread version lacks. */
  missing(workspaceId: Id, threadId: Id): Promise<string[]>;
  version(threadId: Id): Promise<ThreadVersion>;
  /** Drops a Thread's answers and tells the feed; false when it had none. */
  remove(threadId: Id): Promise<boolean>;
  /** Drops every answer to one Signal in a Workspace (an owner's Undo); returns how many. */
  forget(workspaceId: Id, signalId: string): Promise<number>;
  settings(): Promise<SignalsSettings>;
  /** Told the Signals a new or reworded definition needs read over the mail already there (the backfill). */
  setDefsListener(
    listener: ((workspaceId: Id, signalIds: string[]) => Promise<unknown>) | null,
  ): void;
  /** Told a Thread's answers were written (the Recommended actions read them again). */
  setAnsweredListener(listener: ((workspaceId: Id, threadId: Id) => Promise<unknown>) | null): void;
  /** Where the per-Thread people and history come from (the Recommended actions). */
  setCandidateSource(source: CandidateSource | null): void;
}

/** Which Setting words each shipped Signal. */
function shippedSettingKeys(): Record<string, string> {
  const out: Record<string, string> = {
    needs_reply: "judgments.questions.needs_reply",
    waiting_on_others: "judgments.questions.waiting_on_others",
    newsletter: "judgments.questions.newsletter",
    automated: "judgments.questions.automated",
    brief_worth: "judgments.questions.brief_worth",
    urgency: "judgments.questions.urgency",
  };
  for (const id of [
    "waiting_on_me",
    "personal",
    "has_deadline",
    "money_involved",
    "money_amount",
    "money_direction",
    "frustrated",
    "owner_promised",
    "they_promised",
  ]) {
    out[id] = `signals.questions.${id}`;
  }
  for (const part of ["form", "month", "day", "year", "anchor", "weekday", "week", "hour"]) {
    out[`deadline_${part}`] = "signals.questions.deadline_parts";
  }
  return out;
}

/** A Signal a View declares (docs/spec/views.md), scoped by the View's Facts. */
export interface OwnedSignal {
  id: string;
  kind: SignalKind;
  question: JudgeQuestion;
  facts: ViewScopeFacts;
  viewId: string;
  consumer: string;
  /** An Extraction's: asked only when code found candidates of its kind, with them as the options. */
  gate?: SignalGate | undefined;
  optionsFrom?: SignalOptionsFrom | undefined;
}

export interface SignalsOptions {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  /** The pinned Views' own Signals, per Workspace; absent, none. */
  viewSignals?: ((workspaceId: Id) => Promise<OwnedSignal[]>) | undefined;
  level?: () => Promise<AiLevel>;
  now?: () => Date;
  log?: (message: string) => void;
}

const LIST_HEADERS = ["list-id", "list-unsubscribe", "precedence", "auto-submitted", "reply-to"];

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hash of a question under a model: a new wording or a new model is a new Question version. */
export function questionHash(question: JudgeQuestion, model: string): Promise<string> {
  return sha256(canonicalJson({ question, model }));
}

const TASK: Record<AskReason, JudgeTask> = {
  arrival: "judge.signals",
  background: "judge.backfill",
  backlog: "judge.backlog",
  view: "judge.board",
};

const clamp = (v: number, max = 1) =>
  Math.round(Math.min(max, Math.max(0, Number.isFinite(v) ? v : 0)) * 1000) / 1000;

/** The row values of one answer, by its question's kind. */
function answerValues(question: JudgeQuestion, answer: JudgeAnswer) {
  if (answer.type === "noul")
    return {
      noul: clamp(answer.noul),
      choice: null,
      score: null,
      probabilities: null,
      confidence: null,
    };
  if (answer.type === "choice") {
    return {
      noul: null,
      choice: answer.choice,
      score: null,
      probabilities: answer.probabilities,
      confidence: clamp(answer.confidence),
    };
  }
  const levels = question.type === "score" ? question.criteria.length : answer.probabilities.length;
  return {
    noul: null,
    choice: null,
    score: clamp(answer.score, Math.max(0, levels - 1)),
    probabilities: Object.fromEntries(answer.probabilities.map((p, i) => [String(i), p])),
    confidence: clamp(answer.confidence),
  };
}

/** The questions cut into requests under the budgets, over one state; never more than needed. */
export function splitQuestions(
  state: JsonValue,
  questions: Record<string, JudgeQuestion>,
  limits: { requestTokens: number; stateTokens: number },
): Array<Record<string, JudgeQuestion>> {
  const base = estimateTokens(state);
  const out: Array<Record<string, JudgeQuestion>> = [];
  let current: Record<string, JudgeQuestion> = {};
  let total = base;
  let longest = 0;
  for (const [id, q] of Object.entries(questions)) {
    const cost = estimateTokens(q) + estimateTokens(id);
    const fits =
      total + cost <= limits.requestTokens && base + Math.max(longest, cost) <= limits.stateTokens;
    if (!fits && Object.keys(current).length > 0) {
      out.push(current);
      current = {};
      total = base;
      longest = 0;
    }
    current[id] = q;
    total += cost;
    longest = Math.max(longest, cost);
  }
  if (Object.keys(current).length > 0) out.push(current);
  return out;
}

/** A link as a Choice option's line: where it goes, "pay.stripe.com/i/2291". */
function linkLine(url: string, domain: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? `${u.pathname.slice(0, 40)}...` : u.pathname;
    return `${domain}${path === "/" ? "" : path}`;
  } catch {
    return domain;
  }
}

/** An Extraction's options for one Thread: the candidates code found, each with its context, then none. */
export function candidateOptions(
  template: JudgeQuestion,
  found: readonly Candidate[],
): JudgeQuestion {
  return listOptions(
    template,
    found.map((c) => ({ key: c.key, line: c.line })),
  );
}

/** The language model's prompt for the Signals it may answer: Nouls and Scores, by id. */
export function llmPrompt(questions: Record<string, JudgeQuestion>, state: JsonValue): string {
  const lines = Object.entries(questions).map(([id, q]) => {
    const words =
      typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
    if (q.type === "score") {
      const levels = q.criteria.map(
        (c, i) => `  ${i}. ${typeof c === "string" ? c : JSON.stringify(c)}`,
      );
      return `${id} (a level from 0 to ${q.criteria.length - 1}): ${words}\n${levels.join("\n")}`;
    }
    const criteria =
      q.type === "noul" && q.criteria
        ? ` Yes when: ${q.criteria.true} No when: ${q.criteria.false}`
        : "";
    return `${id} (a probability from 0 to 1 that it holds): ${words}${criteria}`;
  });
  return `Questions:\n${lines.join("\n")}\n\nThe thread:\n${JSON.stringify(state, null, 1)}`;
}

/** The language model's numbers as answers; a question it left out gets none. */
export function parseLlmAnswers(
  text: string,
  questions: Record<string, JudgeQuestion>,
): Record<string, JudgeAnswer> {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, JudgeAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const v = Number((raw as Record<string, unknown>)[id]);
    if (!Number.isFinite(v)) continue;
    if (q.type === "noul") out[id] = { type: "noul", noul: clamp(v) };
    else if (q.type === "score") {
      const levels = q.criteria.length;
      const score = clamp(v, Math.max(0, levels - 1));
      out[id] = {
        type: "score",
        score,
        probabilities: Array.from({ length: levels }, (_, i) => (i === Math.round(score) ? 1 : 0)),
        confidence: 0.5,
      };
    }
  }
  return out;
}

export function createSignals(options: SignalsOptions): Signals {
  const { db, mailstore, runtime } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const readSettings = () => readSettingsOf(db);

  const rulesOf = (s: Settings): SignalRules => ({
    noulLow: s["signals.unsure.noul_low"],
    noulHigh: s["signals.unsure.noul_high"],
    confidenceBelow: s["signals.unsure.confidence_below"],
    staleAnswers: s["signals.stale_answers"],
    hysteresis: s["signals.hysteresis"],
  });

  /** Every Signal the Settings declare now: the shipped ones and each owner's. */
  const wanted = (s: Settings): Array<WantedSignal & { owner: SignalOwner }> => {
    const window = parseSortScope(s["signals.backfill.scope"])
      ? s["signals.backfill.scope"]
      : "last 3 months";
    const out: Array<WantedSignal & { owner: SignalOwner }> = shippedSignals(
      s as unknown as ShippedSettings,
      window,
    ).map((w) => ({ ...w, owner: { kind: "shipped" as const, id: null } }));
    for (const r of s["sections.rules"]) {
      const statement = r.judge?.trim();
      if (!statement) continue;
      const asked = sectionQuestion(
        statement,
        s["sections.examples"][r.id],
        s["routing.examples_in_prompt"],
      );
      out.push({
        id: sectionSignalId(r.id),
        kind: "noul",
        question: asked.question,
        window,
        consumers: [r.name?.trim() || r.id],
        owner: { kind: "section", id: r.id },
      });
    }
    for (const w of recommendedSignals(s as unknown as RecommendedSignalSettings, window)) {
      // "action:forward.to" is owned by the forward action; the owner id is the action's name.
      const action = w.id.slice("action:".length).split(".")[0] ?? null;
      out.push({ ...w, owner: { kind: "recommended_action", id: action } });
    }
    for (const a of s["actions.custom"]) {
      const statement = a.on.judge?.trim();
      if (!statement) continue;
      out.push({
        id: actionSignalId(a.id),
        kind: "noul",
        question: { type: "noul", instructions: statement },
        window,
        consumers: [a.label],
        owner: { kind: "custom_action", id: a.id },
      });
    }
    return out;
  };

  /** The statement key a slice 26 answer was asked with, for a Section's or action's Signal now. */
  const legacyKeyOf = (s: Settings, w: { owner: SignalOwner }): string | null => {
    if (w.owner.kind === "section" && w.owner.id) {
      const rule = s["sections.rules"].find((r) => r.id === w.owner.id);
      const statement = rule?.judge?.trim();
      if (!statement) return null;
      return sectionQuestion(
        statement,
        s["sections.examples"][rule?.id ?? ""],
        s["routing.examples_in_prompt"],
      ).key;
    }
    if (w.owner.kind === "custom_action" && w.owner.id) {
      return s["actions.custom"].find((a) => a.id === w.owner.id)?.on.judge?.trim() ?? null;
    }
    return null;
  };

  type DefRow = typeof signalDefs.$inferSelect;
  const toDef = (r: DefRow): StoredDef => ({
    id: r.id,
    owner: { kind: r.ownerKind, id: r.ownerId },
    kind: r.kind,
    question: r.question,
    version: r.version,
    hash: r.hash,
    window: r.scope.window,
    facts: (r.scope.facts as ViewScopeFacts | undefined) ?? null,
    gate: r.gate,
    optionsFrom: r.optionsFrom,
    consumers: r.consumers,
    active: r.active,
  });

  const recordDef = (workspaceId: Id, r: DefRow) => {
    const payload: SignalDefChange = {
      id: r.id,
      kind: r.kind,
      version: r.version,
      ownerKind: r.ownerKind,
      ownerId: r.ownerId,
      active: r.active,
      label: questionLabel(r.question),
    };
    return mailstore.recordChange(db, { workspaceId, kind: "signal_def", entityId: r.id, payload });
  };

  /** Gives migrated slice 26 answers the current version when they were asked with the statement asked now. */
  const claimLegacy = async (workspaceId: Id, def: DefRow, key: string | null) => {
    if (def.ownerKind === "custom_action" && def.ownerId) {
      // The migration could not tell an action from a Section when the Setting lived elsewhere.
      await db.execute(sql`
        update signal_answers set signal_id = ${def.id}
        where workspace_id = ${workspaceId} and signal_id = ${sectionSignalId(def.ownerId)} and version = 0
          and not exists (select 1 from signal_answers b where b.thread_id = signal_answers.thread_id and b.signal_id = ${def.id})`);
    }
    if (!key) return;
    await db.execute(sql`
      update signal_answers a set version = ${def.version}, legacy_key = null,
        message_count = t.message_count,
        latest_message_id = coalesce((select m.id from messages m where m.thread_id = a.thread_id order by m.date desc, m.id desc limit 1), '')
      from threads t
      where t.id = a.thread_id and a.workspace_id = ${workspaceId} and a.signal_id = ${def.id}
        and a.version = 0 and a.legacy_key = ${key}`);
  };

  const synced = new Map<Id, { key: string; at: number; defs: StoredDef[] }>();

  // Syncs of one Workspace take turns: many Threads asked at once (the judge's
  // pool) must not race to insert the same definition, or the losers would
  // store their answers under none. After the first, a turn is the cached read.
  const syncTurns = new Map<Id, Promise<unknown>>();
  const syncDefs = (workspaceId: Id, s: Settings): Promise<StoredDef[]> => {
    const before = syncTurns.get(workspaceId) ?? Promise.resolve();
    const turn = before.catch(() => {}).then(() => syncDefsNow(workspaceId, s));
    syncTurns.set(workspaceId, turn);
    void turn
      .catch(() => {})
      .finally(() => {
        if (syncTurns.get(workspaceId) === turn) syncTurns.delete(workspaceId);
      });
    return turn;
  };
  const syncDefsNow = async (workspaceId: Id, s: Settings): Promise<StoredDef[]> => {
    const model = s["ai.judge.model"];
    const viewWindow = parseSortScope(s["signals.backfill.scope"])
      ? s["signals.backfill.scope"]
      : "last 3 months";
    // A pinned View's Signals, asked only inside its scope (docs/spec/views.md).
    const owned = options.viewSignals ? await options.viewSignals(workspaceId) : [];
    const want: Array<WantedSignal & { owner: SignalOwner; facts?: ViewScopeFacts | undefined }> = [
      ...wanted(s),
      ...owned.map((b) => ({
        id: b.id,
        kind: b.kind,
        question: b.question,
        window: viewWindow,
        facts: b.facts,
        consumers: [b.consumer],
        owner: { kind: "view" as const, id: b.viewId },
        ...(b.gate ? { gate: b.gate } : {}),
        ...(b.optionsFrom ? { optionsFrom: b.optionsFrom } : {}),
      })),
    ];
    const key = canonicalJson({ model, want });
    const cached = synced.get(workspaceId);
    if (cached && cached.key === key && now().getTime() - cached.at < 60_000) return cached.defs;
    const rows = await db.select().from(signalDefs).where(eq(signalDefs.workspaceId, workspaceId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const at = now();
    // A new Signal needs the mail already there read; on a Workspace's very first sync nothing
    // is there to read yet, unless answers came over from before the Signal store (a migration).
    const established =
      rows.length > 0 ||
      (
        await db
          .select({ id: signalAnswers.signalId })
          .from(signalAnswers)
          .where(eq(signalAnswers.workspaceId, workspaceId))
          .limit(1)
      ).length > 0;
    const toRead: string[] = [];
    for (const w of want) {
      const hash = await questionHash(w.question, model);
      const row = byId.get(w.id);
      const scope = {
        window: w.window,
        ...(w.facts ? { facts: w.facts as unknown as Record<string, JsonValue> } : {}),
      };
      if (!row) {
        const values = {
          workspaceId,
          id: w.id,
          ownerKind: w.owner.kind,
          ownerId: w.owner.id,
          owners: [w.owner],
          kind: w.kind,
          question: w.question as SignalQuestion,
          hash,
          version: 1,
          scope,
          gate: w.gate ?? null,
          optionsFrom: w.optionsFrom ?? null,
          consumers: w.consumers,
          active: true,
          createdAt: at,
          retiredAt: null,
        };
        const [inserted] = await db
          .insert(signalDefs)
          .values(values)
          .onConflictDoNothing()
          .returning();
        if (!inserted) continue;
        if (established) toRead.push(w.id);
        await db
          .insert(signalVersions)
          .values({
            workspaceId,
            signalId: w.id,
            version: 1,
            hash,
            question: values.question,
            createdAt: at,
          })
          .onConflictDoNothing();
        await claimLegacy(workspaceId, inserted, legacyKeyOf(s, w));
        await recordDef(workspaceId, inserted);
        byId.set(w.id, inserted);
        continue;
      }
      const changedWords = row.hash !== hash;
      const changedMeta =
        !row.active ||
        canonicalJson(row.scope) !== canonicalJson(scope) ||
        canonicalJson(row.consumers) !== canonicalJson(w.consumers) ||
        (row.gate ?? null) !== (w.gate ?? null) ||
        (row.optionsFrom ?? null) !== (w.optionsFrom ?? null);
      if (!changedWords && !changedMeta) continue;
      const version = changedWords ? row.version + 1 : row.version;
      const [updated] = await db
        .update(signalDefs)
        .set({
          question: w.question as SignalQuestion,
          hash,
          version,
          scope,
          gate: w.gate ?? null,
          optionsFrom: w.optionsFrom ?? null,
          consumers: w.consumers,
          active: true,
          retiredAt: null,
        })
        .where(
          and(
            eq(signalDefs.workspaceId, workspaceId),
            eq(signalDefs.id, w.id),
            eq(signalDefs.hash, row.hash),
          ),
        )
        .returning();
      if (!updated) continue;
      if (changedWords) {
        await db
          .insert(signalVersions)
          .values({
            workspaceId,
            signalId: w.id,
            version,
            hash,
            question: w.question as SignalQuestion,
            createdAt: at,
          })
          .onConflictDoNothing();
      }
      await recordDef(workspaceId, updated);
      byId.set(w.id, updated);
      // A View whose scope moved has Threads to read that it never looked at.
      const movedScope =
        w.owner.kind === "view" && canonicalJson(row.scope) !== canonicalJson(scope);
      if (changedWords || movedScope) toRead.push(w.id);
    }
    // A Signal nobody declares any more is retired; its answers stay signals.keep_inactive_days for an Undo.
    const wantedIds = new Set(want.map((w) => w.id));
    for (const row of byId.values()) {
      if (wantedIds.has(row.id) || !row.active) continue;
      const [retired] = await db
        .update(signalDefs)
        .set({ active: false, retiredAt: at })
        .where(and(eq(signalDefs.workspaceId, workspaceId), eq(signalDefs.id, row.id)))
        .returning();
      if (retired) {
        await recordDef(workspaceId, retired);
        byId.set(row.id, retired);
      }
    }
    // Past the keep window, a retired Signal and its answers go.
    const cutoff = new Date(at.getTime() - s["signals.keep_inactive_days"] * 86_400_000);
    const gone = await db
      .delete(signalDefs)
      .where(
        and(
          eq(signalDefs.workspaceId, workspaceId),
          eq(signalDefs.active, false),
          lt(signalDefs.retiredAt, cutoff),
        ),
      )
      .returning({ id: signalDefs.id });
    if (gone.length > 0) {
      const ids = gone.map((g) => g.id);
      await db
        .delete(signalAnswers)
        .where(
          and(eq(signalAnswers.workspaceId, workspaceId), inArray(signalAnswers.signalId, ids)),
        );
      await db
        .delete(signalVersions)
        .where(
          and(eq(signalVersions.workspaceId, workspaceId), inArray(signalVersions.signalId, ids)),
        );
      for (const id of ids) byId.delete(id);
    }
    const defs = [...byId.values()].map(toDef);
    synced.set(workspaceId, { key, at: now().getTime(), defs });
    // The backfill reads the mail already there for what the arrival request carries.
    const carried = new Set(defs.filter((d) => d.active && inArrival(d, s)).map((d) => d.id));
    const read = toRead.filter((id) => carried.has(id));
    if (read.length > 0 && defsListener) {
      await defsListener(workspaceId, read).catch((error: unknown) =>
        log(
          `signals backfill ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    return defs;
  };
  let defsListener: ((workspaceId: Id, signalIds: string[]) => Promise<unknown>) | null = null;
  let answeredListener: ((workspaceId: Id, threadId: Id) => Promise<unknown>) | null = null;
  let candidateSource: CandidateSource | null = null;
  /** Tells the listener a Thread's answers changed; a failing listener never fails the request. */
  const answered = async (workspaceId: Id, threadId: Id) => {
    if (!answeredListener) return;
    await answeredListener(workspaceId, threadId).catch((error: unknown) =>
      log(
        `signals answered ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  };

  const versionsOf = async (threadIds: readonly Id[]): Promise<Map<Id, ThreadVersion>> => {
    const out = new Map<Id, ThreadVersion>();
    if (threadIds.length === 0) return out;
    const rows = await db
      .select({
        threadId: messages.threadId,
        n: sql<number>`count(*)::int`,
        latest: sql<string>`(array_agg(${messages.id} order by ${messages.date} desc, ${messages.id} desc))[1]`,
      })
      .from(messages)
      .where(inArray(messages.threadId, [...threadIds]))
      .groupBy(messages.threadId);
    for (const id of threadIds) out.set(id, { messageCount: 0, latestMessageId: "" });
    for (const r of rows)
      out.set(r.threadId, { messageCount: Number(r.n), latestMessageId: r.latest ?? "" });
    return out;
  };

  type AnswerRow = typeof signalAnswers.$inferSelect;

  const readRows = async (threadIds: readonly Id[]) => {
    if (threadIds.length === 0) return [] as AnswerRow[];
    return db
      .select()
      .from(signalAnswers)
      .where(inArray(signalAnswers.threadId, [...threadIds]));
  };

  const defVersions = async (workspaceIds: readonly Id[]): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    if (workspaceIds.length === 0) return out;
    const rows = await db
      .select({
        workspaceId: signalDefs.workspaceId,
        id: signalDefs.id,
        version: signalDefs.version,
      })
      .from(signalDefs)
      .where(inArray(signalDefs.workspaceId, [...workspaceIds]));
    for (const r of rows) out.set(`${r.workspaceId}\u0000${r.id}`, r.version);
    return out;
  };

  const toStored = (
    r: AnswerRow,
    current: number | undefined,
    version: ThreadVersion | undefined,
  ): StoredAnswer => ({
    signalId: r.signalId,
    version: r.version,
    model: r.model,
    judgedAt: r.judgedAt.toISOString(),
    messageCount: r.messageCount,
    latestMessageId: r.latestMessageId,
    noul: r.noul,
    choice: r.choice,
    score: r.score,
    confidence: r.confidence,
    probabilities: r.probabilities ?? null,
    lowTrust: r.lowTrust ?? null,
    stale:
      (current !== undefined && r.version < current) ||
      r.version === 0 ||
      (version !== undefined &&
        (version.messageCount !== r.messageCount || version.latestMessageId !== r.latestMessageId)),
  });

  const readings = async (threadIds: readonly Id[]) => {
    const rows = await readRows(threadIds);
    const versions = await versionsOf([...new Set(rows.map((r) => r.threadId))]);
    // The definitions follow the Settings first, so an answer to a reworded question reads as stale.
    const workspaceIds = [...new Set(rows.map((r) => r.workspaceId))];
    if (workspaceIds.length > 0) {
      const s = await readSettings();
      for (const w of workspaceIds) await syncDefs(w, s);
    }
    const defs = await defVersions(workspaceIds);
    const out = new Map<Id, Record<string, StoredAnswer>>();
    for (const r of rows) {
      const entry = out.get(r.threadId) ?? {};
      entry[r.signalId] = toStored(
        r,
        defs.get(`${r.workspaceId}\u0000${r.signalId}`),
        versions.get(r.threadId),
      );
      out.set(r.threadId, entry);
    }
    return out;
  };

  const changeOf = (threadId: Id, rows: readonly AnswerRow[]): SignalsChange => ({
    threadId,
    answers: rows.map((r) => ({
      signalId: r.signalId,
      version: r.version,
      noul: r.noul,
      choice: r.choice,
      score: r.score,
      confidence: r.confidence,
      stale: false,
      lowTrust: (r.lowTrust ?? null) as LowTrust | null,
      judgedAt: r.judgedAt.toISOString(),
    })),
  });

  /** Writes answers at the given versions and tells the feed once. */
  const write = async (
    workspaceId: Id,
    threadId: Id,
    version: ThreadVersion,
    items: Array<{
      def: Pick<StoredDef, "id" | "version" | "question">;
      answer: JudgeAnswer;
      /** Who answered when not the request's model: code, for a Signal its gate kept out. */
      model?: string;
      /** The option stored in place of the picked one (a span stays sealed with the Facts). */
      choice?: string;
    }>,
    model: string,
    lowTrust: LowTrust | null = null,
  ) => {
    if (items.length === 0) return;
    const judgedAt = now();
    const written: AnswerRow[] = [];
    for (const item of items) {
      const { def, answer } = item;
      const shaped = answerValues(def.question, answer);
      const values = {
        workspaceId,
        version: def.version,
        model: item.model ?? model,
        judgedAt,
        messageCount: version.messageCount,
        latestMessageId: version.latestMessageId,
        ...shaped,
        ...(item.choice !== undefined
          ? {
              choice: item.choice,
              // A span's probabilities would name it: only the picked-or-not share is kept.
              probabilities: null,
            }
          : {}),
        lowTrust,
        legacyKey: null,
      };
      const [row] = await db
        .insert(signalAnswers)
        .values({ threadId, signalId: def.id, ...values })
        .onConflictDoUpdate({
          target: [signalAnswers.threadId, signalAnswers.signalId],
          set: values,
        })
        .returning();
      if (row) written.push(row);
    }
    await mailstore.recordChange(db, {
      workspaceId,
      kind: "signals",
      entityId: threadId,
      payload: changeOf(threadId, written),
    });
  };

  /** What the newest sender's past with the owner looks like, counted by code (Facts). */
  const senderStats = async (
    workspaceId: Id,
    sender: string,
    owner: string,
  ): Promise<SenderStats> => {
    const rows = await db.execute<{
      threads: number;
      replied: number;
      archived_unread: number;
    }>(sql`
      select count(*)::int as threads,
        count(*) filter (where exists (
          select 1 from messages o where o.thread_id = t.id and lower(o."from"->>'email') = ${owner}
        ))::int as replied,
        count(*) filter (where t.archived and t.unread)::int as archived_unread
      from threads t
      where t.workspace_id = ${workspaceId} and t.deleted = false and exists (
        select 1 from messages m where m.thread_id = t.id and lower(m."from"->>'email') = ${sender}
      )`);
    const r = (
      rows as unknown as Array<{ threads: number; replied: number; archived_unread: number }>
    )[0];
    return {
      threads: Number(r?.threads ?? 0),
      ownerReplied: Number(r?.replied ?? 0),
      archivedUnread: Number(r?.archived_unread ?? 0),
    };
  };

  /**
   * Everything a Signal request reads about one Thread: the state, and the
   * Facts code computes for it. Decrypts, so it needs the root key.
   */
  const loadThread = async (workspaceId: Id, threadId: Id, s: Settings, rowCount = 0) => {
    const [owner] = await db
      .select({ address: accounts.address, name: accounts.displayName })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    const ownerAddress = (owner?.address ?? "").toLowerCase();
    const row = await db.query.threads.findFirst({ where: eq(threads.id, threadId) });
    const subject = await mailstore.readThreadSubject(threadId);
    const headers = await mailstore.listMessages(threadId);
    const texts: StateMessage[] = [];
    const factMessages: FactMessage[] = [];
    // Only the newest few Messages can fit; older ones are not decrypted.
    const room = Math.max(
      1,
      Math.ceil(s["signals.state.thread_chars"] / Math.max(1, s["signals.state.earlier_chars"])) +
        1,
    );
    // A message-grain View reads more of the Messages: each is its own row and its own question.
    const span = Math.max(room, rowCount);
    const first = Math.max(0, headers.length - span);
    const rowMessages: Array<RowMessage & { to: Person[]; cc: Person[] }> = [];
    for (const [n, h] of headers.slice(-span).entries()) {
      const body = await mailstore.readMessageBody(h.id);
      const text = body.text || body.snippet;
      rowMessages.push({
        id: h.id,
        index: first + n,
        date: h.date,
        from: h.from,
        to: h.to,
        cc: h.cc,
        text,
      });
      // The state carries only the newest few, as before.
      if (first + n < headers.length - room) continue;
      texts.push({ from: h.from, to: h.to, cc: h.cc, date: h.date, text });
      factMessages.push({
        from: h.from,
        to: h.to,
        cc: h.cc,
        date: h.date,
        headers: h.headers,
        text,
        hasImages: /<img\b/i.test(body.html ?? ""),
      });
    }
    const newest = headers[headers.length - 1];
    const listHeaders: Record<string, string> = {};
    for (const k of LIST_HEADERS) {
      const v = newest?.headers[k];
      if (v) listHeaders[k] = v;
    }
    const sender = newest ? newest.from.email.toLowerCase() : "";
    const stats =
      sender && sender !== ownerAddress
        ? await senderStats(workspaceId, sender, ownerAddress)
        : null;
    const [invite] = await db
      .select({ id: invites.id })
      .from(invites)
      .where(eq(invites.threadId, threadId))
      .limit(1);
    const attachmentNames = headers.flatMap((h) => h.attachments.map((a) => a.name));
    const participants = (row?.participants ?? []).map((p) => p.email.toLowerCase());
    const facts = computeFacts({
      owner: ownerAddress,
      messages: factMessages,
      attachmentNames,
      participants: row?.participants ?? [],
      sender: stats,
      hasInvite: invite !== undefined,
      candidatesMax: s["signals.candidates.max"],
    });
    // The first Message's date, not only the newest few's.
    facts.clear.received_at = headers[0]?.date ?? facts.clear.received_at;
    facts.clear.message_count = headers.length;
    const candidates: SignalCandidates =
      candidateSource && sender
        ? await candidateSource({
            workspaceId,
            threadId,
            owner: ownerAddress,
            sender,
            named: facts.sealed.addresses,
            participants,
          })
        : { people: [], forwardedTo: [] };
    const ownerPerson: Person = { name: owner?.name ?? "", email: ownerAddress };
    const state = signalState(
      {
        owner: ownerPerson,
        subject,
        messages: texts,
        attachmentNames: attachmentNames.slice(0, 10),
        listHeaders,
        timeZone: s["calendar.time_zone"],
        senderHistory: stats
          ? {
              threadsFromSender: stats.threads,
              ownerReplied: stats.ownerReplied,
              ownerArchivedUnread: stats.archivedUnread,
              ownerForwardedTo: candidates.forwardedTo,
            }
          : null,
      },
      {
        newestChars: s["signals.state.newest_chars"],
        threadChars: s["signals.state.thread_chars"],
        earlierChars: s["signals.state.earlier_chars"],
      },
    );
    const lowTrust: LowTrust | null = facts.clear.image_only
      ? "image_only"
      : facts.clear.language === "other"
        ? "not_english"
        : null;
    return {
      state,
      facts,
      candidates,
      lowTrust,
      text: factMessages.map((m) => m.text).join("\n\n"),
      written: newest?.date ?? now().toISOString(),
      messages: factMessages,
      rowMessages,
      owner: ownerAddress,
    };
  };

  type Loaded = Awaited<ReturnType<typeof loadThread>>;
  /** What a View's Extraction may pick from on this Thread, found once per kind per request. */
  const found = new WeakMap<Loaded, Map<ExtractKind, Candidate[]>>();
  const extractCandidates = (loaded: Loaded, kind: ExtractKind, s: Settings): Candidate[] => {
    const byKind = found.get(loaded) ?? new Map<ExtractKind, Candidate[]>();
    found.set(loaded, byKind);
    const hit = byKind.get(kind);
    if (hit) return hit;
    const list = findCandidates(
      kind,
      {
        messages: loaded.messages,
        owner: loaded.owner,
        written: loaded.written,
        dateOrder: s["views.extract.date_order"],
        itemChars: s["views.extract.item_chars"],
      },
      s["views.extract.candidates_max"],
    );
    byKind.set(kind, list);
    return list;
  };

  /** A many-Extraction's candidates: the same finder, up to views.extract.many.max. */
  const manyFound = new WeakMap<Loaded, Map<string, Candidate[]>>();
  const manyCandidates = (loaded: Loaded, kind: ExtractKind, s: Settings): Candidate[] => {
    const byKind = manyFound.get(loaded) ?? new Map<string, Candidate[]>();
    manyFound.set(loaded, byKind);
    const hit = byKind.get(kind);
    if (hit) return hit;
    const list = findCandidates(
      kind,
      {
        messages: loaded.messages,
        owner: loaded.owner,
        written: loaded.written,
        dateOrder: s["views.extract.date_order"],
        itemChars: s["views.extract.item_chars"],
      },
      s["views.extract.many.max"],
    );
    byKind.set(kind, list);
    return list;
  };

  /** One Message's own candidates of a kind (a message-grain View). */
  const messageCandidates = (
    loaded: Loaded,
    m: RowMessage,
    kind: ExtractKind,
    s: Settings,
  ): Candidate[] => {
    const full = loaded.rowMessages.find((r) => r.id === m.id);
    return findCandidates(
      kind,
      {
        messages: [
          { from: m.from, to: full?.to ?? [], cc: full?.cc ?? [], date: m.date, text: m.text },
        ],
        owner: loaded.owner,
        written: m.date,
        dateOrder: s["views.extract.date_order"],
        itemChars: s["views.extract.item_chars"],
      },
      s["views.extract.candidates_max"],
    );
  };

  const rowWords = (s: Settings): RowWords => ({
    manyNote: s["views.extract.many.note"],
    manyYes: s["views.extract.many.yes"],
    itemNote: s["views.each.item_note"],
    messageNote: s["views.each.message_note"],
    messageChars: s["views.grain.message_chars"],
  });

  /** The questions of a per-row question for this Thread; null when it is asked once. */
  const planFor = (
    id: string,
    template: JudgeQuestion,
    from: SignalOptionsFrom | string | null | undefined,
    loaded: Loaded,
    s: Settings,
  ): RowPlan | null => {
    const mode = rowModeOf(from);
    if (!mode) return null;
    return planRows(
      id,
      template,
      mode,
      {
        found:
          mode.mode === "many" || mode.mode === "each_item"
            ? manyCandidates(loaded, mode.kind, s)
            : [],
        messages: loaded.rowMessages,
        ...(mode.mode === "message"
          ? { perMessage: (m: RowMessage) => messageCandidates(loaded, m, mode.kind, s) }
          : {}),
        listOptions: candidateOptions,
      },
      rowWords(s),
      mode.mode === "many" || mode.mode === "each_item"
        ? s["views.extract.many.max"]
        : s["views.extract.candidates_max"],
    );
  };

  /** Whether any of these option sources reads the Messages one by one. */
  const readsMessages = (froms: ReadonlyArray<SignalOptionsFrom | string | null | undefined>) =>
    froms.some((f) => {
      const m = rowModeOf(f);
      return m?.mode === "message" || m?.mode === "each_message";
    });

  /** The View Signals among `need` whose View's scope does not admit this Thread. */
  const scopedOut = async (
    workspaceId: Id,
    threadId: Id,
    need: readonly StoredDef[],
    s: Settings,
  ): Promise<Set<string>> => {
    const scoped = need.filter((d) => d.facts);
    if (scoped.length === 0) return new Set();
    const [thread] = await loadViewThreads(db, { workspaceId, ids: [threadId], limit: 1 });
    const ctx = { now: now(), zone: s["calendar.time_zone"] };
    return new Set(
      scoped
        .filter((d) => !thread || !scopeAdmits(d.facts as ViewScopeFacts, thread, ctx))
        .map((d) => d.id),
    );
  };

  /** Whether code lets a gated Signal be asked of this Thread. */
  const gateHolds = (d: StoredDef, loaded: Loaded, s: Settings) => {
    if (d.gate === "amounts") return loaded.facts.sealed.amounts.length > 0;
    if (d.gate === "deadline") return mayStateDeadline(loaded.text);
    if (d.gate === "invite") return loaded.facts.clear.has_invite;
    if (d.gate === "no_invite") return !loaded.facts.clear.has_invite;
    if (d.gate === "event") return !loaded.facts.clear.has_invite && mayStateDate(loaded.text);
    if (d.gate === "addresses") return loaded.candidates.people.length > 0;
    if (d.gate === "links") return loaded.facts.sealed.links.length > 0;
    if (d.gate === "tracking") return loaded.facts.sealed.tracking_numbers.length > 0;
    if (d.gate === "workflows") return (loaded.candidates.workflows ?? []).length > 0;
    const kind = extractKindOf(d.gate);
    if (kind) return extractCandidates(loaded, kind, s).length > 0;
    return true;
  };

  /** A Signal's question for one Thread: per-Thread options built by code. */
  const questionFor = (d: StoredDef, loaded: Loaded, s: Settings): JudgeQuestion => {
    const kind = extractKindOf(d.optionsFrom);
    if (kind) return candidateOptions(d.question, extractCandidates(loaded, kind, s));
    if (d.optionsFrom === "amounts") return amountOptions(d.question, loaded.facts.sealed.amounts);
    if (d.optionsFrom === "addresses")
      return recipientOptions(d.question, loaded.candidates.people);
    // Links are numbered by code (l1, l2) with where they go; the pick maps back to the URL.
    if (d.optionsFrom === "links")
      return listOptions(
        d.question,
        loaded.facts.sealed.links.map((l, i) => ({
          key: `l${i + 1}`,
          line: linkLine(l.url, l.domain),
        })),
      );
    if (d.optionsFrom === "tracking")
      return listOptions(
        d.question,
        loaded.facts.sealed.tracking_numbers.map((t) => ({
          key: t.number,
          line: `${t.carrier.toUpperCase()} pattern`,
        })),
      );
    if (d.optionsFrom === "workflows")
      return listOptions(
        d.question,
        (loaded.candidates.workflows ?? []).map((w) => ({
          key: w.id,
          line: w.sentence ? `${w.name}: ${w.sentence}` : w.name,
        })),
      );
    if (d.id === "deadline_year" || d.id === "action:calendar.year")
      return yearOptions(d.question, new Date(loaded.written));
    return d.question;
  };

  /** The Facts stored for the Thread version, what this request learnt folded in; tells the feed. */
  const storeFacts = async (
    workspaceId: Id,
    threadId: Id,
    version: ThreadVersion,
    loaded: Awaited<ReturnType<typeof loadThread>>,
    answers: Record<string, JudgeAnswer | undefined>,
    s: Settings,
    /** The Choices whose options were built per Thread (other than amounts), by what: their picks are kept sealed. */
    pickedFrom: ReadonlyMap<string, SignalOptionsFrom> = new Map(),
    /** Per-row questions folded back: a many-Extraction's values, a per-row Signal's answers. */
    folds: ReadonlyMap<string, RowFold> = new Map(),
  ) => {
    const { clear, sealed } = loaded.facts;
    const previous = await db.query.threadFacts.findFirst({
      where: eq(threadFacts.threadId, threadId),
    });
    const before = (previous?.facts ?? {}) as Partial<ClearFacts>;
    const choice = (id: string) => {
      const a = answers[id];
      return a?.type === "choice" ? { choice: a.choice, confidence: a.confidence } : undefined;
    };
    if (answers.deadline_form) {
      const parts: DeadlineParts = {};
      for (const k of [
        "form",
        "month",
        "day",
        "year",
        "anchor",
        "weekday",
        "week",
        "hour",
      ] as const) {
        const p = choice(`deadline_${k}`);
        if (p) parts[k] = p;
      }
      const date = assembleDeadline(
        parts,
        loaded.written,
        s["calendar.time_zone"],
        s["signals.deadline.min_confidence"],
      );
      clear.deadline_at = date.at;
      clear.deadline_unclear = date.unclear;
    } else {
      clear.deadline_at = before.deadline_at ?? null;
      clear.deadline_unclear = before.deadline_unclear ?? false;
    }
    let old: SealedFacts | null = null;
    if (previous?.contentEnc && previous.contentKey) {
      try {
        old = JSON.parse(
          await mailstore.readText({
            workspaceId,
            kind: "facts",
            key: previous.contentKey,
            chunks: [previous.contentEnc],
            size: -1,
          }),
        ) as SealedFacts;
      } catch {
        old = null;
      }
    }
    const picked = answers.money_amount;
    if (picked?.type === "choice" && sealed.amounts.includes(picked.choice)) {
      const parsed = parseAmount(picked.choice);
      sealed.amount = parsed ? { span: picked.choice, ...parsed } : null;
    } else if (!picked) {
      sealed.amount = old?.amount ?? null;
    }
    // The picks of this request replace the ones it asked again; the rest carry over.
    const oldPicks = old?.picks ?? null;
    // A picked person (or link, or number) is kept verbatim, sealed; the answer row says only "picked".
    const picks: NonNullable<SealedFacts["picks"]> = { ...(oldPicks ?? {}) };
    for (const [id, a] of Object.entries(answers)) {
      const from = pickedFrom.get(id);
      if (a?.type !== "choice" || !from) continue;
      if (a.choice === "none") {
        delete picks[id];
        continue;
      }
      const kind = extractKindOf(from);
      if (kind) {
        // A View's Extraction: code copies the span it found and keeps it normalized beside it.
        const c = extractCandidates(loaded, kind, s).find((x) => x.key === a.choice);
        if (!c) delete picks[id];
        else
          picks[id] = {
            value: c.span,
            normalized: c.value,
            confidence: a.confidence,
            probability: a.probabilities[a.choice] ?? a.confidence,
          };
        continue;
      }
      const value =
        from === "links" ? (sealed.links[Number(a.choice.slice(1)) - 1]?.url ?? null) : a.choice;
      if (value === null) delete picks[id];
      else
        picks[id] = {
          value,
          confidence: a.confidence,
          probability: a.probabilities[a.choice] ?? a.confidence,
        };
    }
    for (const [id, f] of folds) {
      if (!f.items?.length && !f.answers) {
        delete picks[id];
        continue;
      }
      const first = f.items?.find((i) => !i.unsure) ?? f.items?.[0];
      const confidence = f.row.type === "noul" ? 1 : f.row.confidence;
      picks[id] = {
        value: first?.text ?? "each",
        normalized: first?.value ?? null,
        confidence,
        probability: confidence,
        ...(f.items ? { items: f.items } : {}),
        ...(f.answers ? { answers: f.answers } : {}),
      };
    }
    sealed.picks = picks;
    const stored = await mailstore.storeContent(workspaceId, "facts", JSON.stringify(sealed));
    const values = {
      workspaceId,
      messageCount: version.messageCount,
      latestMessageId: version.latestMessageId,
      facts: clear as unknown as Record<string, unknown>,
      deadlineAt: clear.deadline_at ? new Date(clear.deadline_at) : null,
      contentEnc: stored.chunks[0] ?? null,
      contentKey: stored.key,
      computedAt: now(),
    };
    await db
      .insert(threadFacts)
      .values({ threadId, ...values })
      .onConflictDoUpdate({ target: threadFacts.threadId, set: values });
    const payload: FactsChange = { threadId, facts: clear as unknown as Record<string, unknown> };
    await mailstore.recordChange(db, { workspaceId, kind: "facts", entityId: threadId, payload });
  };

  const currentFor = (a: AnswerRow | undefined, def: StoredDef, version: ThreadVersion) =>
    a !== undefined &&
    a.version === def.version &&
    a.messageCount === version.messageCount &&
    a.latestMessageId === version.latestMessageId;

  /** The Signals a request asks: those the reason covers, active, and lacking a current answer. */
  const needed = async (
    workspaceId: Id,
    threadId: Id,
    s: Settings,
    opts: Pick<AskOptions, "reason" | "only" | "force">,
  ) => {
    const defs = (await syncDefs(workspaceId, s)).filter((d) => d.active);
    const version = (await versionsOf([threadId])).get(threadId) as ThreadVersion;
    const rows = new Map((await readRows([threadId])).map((r) => [r.signalId, r]));
    const only = opts.only ? new Set(opts.only) : null;
    // The arrival request carries the shipped Signals; a Section's or action's own is asked with its owner (slice 33 joins them).
    const inRequest = (d: StoredDef) => (only ? only.has(d.id) : inArrival(d, s));
    const need = defs.filter(
      (d) => inRequest(d) && (opts.force || !currentFor(rows.get(d.id), d, version)),
    );
    return { need, version };
  };

  /** Whether the arrival request carries a Signal: the shipped ones (only the slice 25 set while Signals are off). */
  const inArrival = (d: StoredDef, s: Settings) =>
    (d.owner.kind === "shipped" && (s["signals.enabled"] || isArrivalSignal(d.id))) ||
    // A Section's, a Custom action's and a Recommended action's own questions ride in the same
    // request (slice 33), and a pinned View's, on the Threads its scope admits (docs/spec/views.md).
    (s["signals.enabled"] &&
      (d.owner.kind === "section" ||
        d.owner.kind === "custom_action" ||
        d.owner.kind === "view" ||
        d.owner.kind === "recommended_action"));

  const isArrivalSignal = (id: string) =>
    (Object.values(ARRIVAL_SIGNALS) as string[]).includes(id) || id === "waiting_on_me";

  const api: Signals = {
    setDefsListener(listener) {
      defsListener = listener;
    },

    setAnsweredListener(listener) {
      answeredListener = listener;
    },

    setCandidateSource(source) {
      candidateSource = source;
    },

    async defs(workspaceId) {
      return syncDefs(workspaceId, await readSettings());
    },

    async ask(workspaceId, threadId, opts) {
      const s = await readSettings();
      const thread = await db.query.threads.findFirst({
        where: eq(threads.id, threadId),
        columns: { id: true },
      });
      if (!thread) throw new NotFoundError("thread", threadId);
      const { need, version } = await needed(workspaceId, threadId, s, opts);
      const extra = opts.extra ?? {};
      const result: AskResult = {
        asked: [],
        extra: {},
        picks: {},
        candidates: {},
        calls: 0,
        by: null,
      };
      if (need.length === 0 && Object.keys(extra).length === 0) return result;
      const loaded = await loadThread(
        workspaceId,
        threadId,
        s,
        readsMessages([
          ...need.map((d) => d.optionsFrom),
          ...Object.values(opts.extraOptions ?? {}),
        ])
          ? s["views.grain.max_messages"]
          : 0,
      );
      const state = loaded.state;
      // A View's Signal is asked only of the Threads its scope's Facts admit; code decides.
      const outOfScope = await scopedOut(workspaceId, threadId, need, s);
      // Code decides what applies: a gated Signal whose gate fails is answered by code as not stated.
      const gatedOut = need.filter((d) => !outOfScope.has(d.id) && !gateHolds(d, loaded, s));
      let asked = need.filter((d) => !outOfScope.has(d.id) && gateHolds(d, loaded, s));
      const questions: Record<string, JudgeQuestion> = {};
      // Per-row questions (many values, one per Message, a Signal per item or Message) ride as
      // several independent questions in this same request.
      const plans = new Map<string, RowPlan>();
      for (const d of asked) {
        const plan = planFor(d.id, d.question as JudgeQuestion, d.optionsFrom, loaded, s);
        if (!plan) {
          questions[d.id] = questionFor(d, loaded, s);
          continue;
        }
        plans.set(d.id, plan);
        if (plan.parts.length === 0) gatedOut.push(d);
        Object.assign(questions, plan.questions);
      }
      asked = asked.filter((d) => !plans.has(d.id) || (plans.get(d.id)?.parts.length ?? 0) > 0);
      for (const [id, q] of Object.entries(extra)) {
        const plan = planFor(id, q, opts.extraOptions?.[id], loaded, s);
        if (plan) {
          plans.set(id, plan);
          result.picks[id] = null;
          result.candidates[id] = plan.found.map((c) => c.span);
          result.found = {
            ...result.found,
            [id]: plan.found.map((c) => ({ key: c.key, span: c.span, line: c.line })),
          };
          Object.assign(questions, plan.questions);
          continue;
        }
        const kind = extractKindOf(opts.extraOptions?.[id]);
        if (!kind) {
          questions[id] = q;
          continue;
        }
        // A draft's Extraction: asked only when code found candidates, with them as the options.
        const found = extractCandidates(loaded, kind, s);
        result.picks[id] = null;
        result.candidates[id] = found.map((c) => c.span);
        result.found = {
          ...result.found,
          [id]: found.map((c) => ({ key: c.key, span: c.span, line: c.line })),
        };
        if (found.length > 0) questions[id] = candidateOptions(q, found);
      }
      // A gated Noul is answered no; a gated Choice, not stated.
      const notStated = gatedOut.map((d) => ({
        def: d,
        model: "code",
        answer:
          d.kind === "noul"
            ? ({ type: "noul", noul: 0 } as const)
            : ({
                type: "choice",
                choice: "none",
                probabilities: { none: 1 },
                confidence: 1,
              } as const),
      }));
      const pickedFrom = new Map<string, SignalOptionsFrom>();
      for (const d of asked)
        if (d.optionsFrom && d.optionsFrom !== "amounts") pickedFrom.set(d.id, d.optionsFrom);
      if (Object.keys(questions).length === 0) {
        await write(workspaceId, threadId, version, notStated, "code", loaded.lowTrust);
        await storeFacts(workspaceId, threadId, version, loaded, {}, s);
        result.asked = notStated.map((i) => i.def.id);
        await answered(workspaceId, threadId);
        return result;
      }
      // Answers this Thread version already has (a View's try before Pin view) are not asked again.
      const prior =
        opts.prior &&
        opts.prior.messageCount === version.messageCount &&
        opts.prior.latestMessageId === version.latestMessageId
          ? opts.prior
          : null;
      const reused: Record<string, JudgeAnswer> = {};
      for (const id of Object.keys(questions)) {
        const a = prior?.answers[id];
        if (a) reused[id] = a;
      }
      const toAsk = Object.fromEntries(Object.entries(questions).filter(([id]) => !reused[id]));
      const asking = Object.keys(toAsk).length > 0;
      if (!asking || (await runtime.judgeAvailable())) {
        const answers: Record<string, JudgeAnswer> = { ...reused };
        let model = prior?.model ?? "";
        try {
          // A Thread whose questions outgrow one request is asked in parts, all in flight at once.
          const parts = !asking
            ? []
            : splitQuestions(state, toAsk, {
                requestTokens: s["routing.backfill.request_tokens"],
                stateTokens: s["routing.backfill.state_tokens"],
              });
          const replies = await Promise.allSettled(
            parts.map((part) =>
              runtime.judge(TASK[opts.reason], state, part, {
                workspaceId,
                priority:
                  opts.reason === "arrival" || opts.reason === "view" ? "arrival" : "background",
                jobId: opts.jobId ?? null,
              }),
            ),
          );
          for (const reply of replies) {
            if (reply.status === "rejected") throw reply.reason;
            result.calls += 1;
            model = reply.value.model;
            Object.assign(answers, reply.value.answers);
          }
        } catch (error) {
          if (!(error instanceof NoJudgeError)) throw error;
          return llmAsk(workspaceId, threadId, s, asked, state, version, opts, error, loaded);
        }
        const folds = new Map<string, RowFold>();
        for (const [id, plan] of plans) {
          const f = foldRows(plan, answers, {
            threshold: s["views.extract.many.threshold"],
            unsureFrom: s["signals.unsure.noul_low"],
            max: s["views.extract.many.max"],
          });
          if (f) folds.set(id, f);
        }
        const items = asked.flatMap((d) => {
          if (plans.has(d.id)) {
            const f = folds.get(d.id);
            if (!f) return [];
            return [{ def: d, answer: f.row, ...(f.choice ? { choice: f.choice } : {}) }];
          }
          const a = answers[d.id];
          if (!a) return [];
          // A picked span stays sealed with the Facts; the answer keeps only whether one was picked.
          if (d.optionsFrom && a.type === "choice") {
            return [{ def: d, answer: a, choice: a.choice === "none" ? "none" : "picked" }];
          }
          return [{ def: d, answer: a }];
        });
        await write(
          workspaceId,
          threadId,
          version,
          [...items, ...notStated],
          model,
          loaded.lowTrust,
        );
        const storedFolds = new Map([...folds].filter(([id]) => asked.some((d) => d.id === id)));
        await storeFacts(
          workspaceId,
          threadId,
          version,
          loaded,
          answers,
          s,
          pickedFrom,
          storedFolds,
        );
        if ([...pickedFrom.values()].some((f) => extractKindOf(f) !== null) || storedFolds.size) {
          // A View's picked values changed: the Device reads them again (they stay sealed here).
          await mailstore.recordChange(db, {
            workspaceId,
            kind: "view_values",
            entityId: threadId,
            payload: { threadId },
          });
        }
        result.asked = [...items, ...notStated].map((i) => i.def.id);
        await answered(workspaceId, threadId);
        for (const id of Object.keys(extra)) result.extra[id] = answers[id] ?? folds.get(id)?.row;
        for (const [id, plan] of plans) {
          if (!(id in extra)) continue;
          const f = folds.get(id);
          if (!f) continue;
          const first = f.items?.find((i) => !i.unsure);
          result.picks[id] =
            f.items?.length || f.answers
              ? {
                  text: first?.text ?? (f.answers ? "each" : ""),
                  value: first?.value ?? null,
                  confidence: f.row.type === "choice" ? f.row.confidence : 1,
                  candidates: plan.found.map((c) => c.span),
                  ...(f.items ? { items: f.items } : {}),
                  ...(f.answers ? { answers: f.answers } : {}),
                  capped: plan.capped,
                }
              : null;
        }
        for (const id of Object.keys(result.picks)) {
          if (plans.has(id)) continue;
          const kind = extractKindOf(opts.extraOptions?.[id]);
          const a = answers[id];
          if (!kind || a?.type !== "choice" || a.choice === "none") continue;
          const found = extractCandidates(loaded, kind, s);
          const c = found.find((x) => x.key === a.choice);
          if (c) {
            result.picks[id] = {
              text: c.span,
              value: c.value,
              confidence: a.confidence,
              candidates: found.map((x) => x.span),
            };
          }
        }
        result.by = "typesafe";
        result.prior = {
          messageCount: version.messageCount,
          latestMessageId: version.latestMessageId,
          model,
          answers,
        };
        return result;
      }
      return llmAsk(
        workspaceId,
        threadId,
        s,
        asked,
        state,
        version,
        opts,
        new NoJudgeError("no_key"),
        loaded,
      );
    },

    readings,

    async candidates(workspaceId, threadId, kinds) {
      const s = await readSettings();
      const [owner] = await db
        .select({ address: accounts.address })
        .from(workspaces)
        .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
        .where(eq(workspaces.id, workspaceId));
      const headers = await mailstore.listMessages(threadId);
      // The same Messages the Signal request reads: only the newest few fit its state.
      const room = Math.max(
        1,
        Math.ceil(s["signals.state.thread_chars"] / Math.max(1, s["signals.state.earlier_chars"])) +
          1,
      );
      const messages = [];
      for (const h of headers.slice(-room)) {
        const body = await mailstore.readMessageBody(h.id);
        messages.push({
          from: h.from,
          to: h.to,
          cc: h.cc,
          date: h.date,
          text: body.text || body.snippet,
        });
      }
      const input = {
        messages,
        owner: (owner?.address ?? "").toLowerCase(),
        written: headers[headers.length - 1]?.date ?? now().toISOString(),
        dateOrder: s["views.extract.date_order"],
        itemChars: s["views.extract.item_chars"],
      };
      const out: Partial<Record<ExtractKind, Candidate[]>> = {};
      for (const kind of new Set(kinds)) {
        out[kind] = findCandidates(kind, input, s["views.extract.candidates_max"]);
      }
      return out;
    },

    async store(workspaceId, threadId, answers, meta) {
      const s = await readSettings();
      const defs = new Map((await syncDefs(workspaceId, s)).map((d) => [d.id, d]));
      const version = (await versionsOf([threadId])).get(threadId) as ThreadVersion;
      const items = Object.entries(answers).flatMap(([id, answer]) => {
        const def = defs.get(id);
        return def ? [{ def, answer }] : [];
      });
      await write(workspaceId, threadId, version, items, meta.model);
    },

    async judgments(threadId, opts = {}) {
      const all = (await readings([threadId])).get(threadId);
      if (!all) return null;
      const picked: Record<string, StoredAnswer> = {};
      for (const [id, a] of Object.entries(all)) {
        if (opts.fresh && a.stale) continue;
        picked[id] = a;
      }
      if (opts.fresh) {
        const wantedIds = [...Object.values(ARRIVAL_SIGNALS)];
        if (wantedIds.some((id) => picked[id] === undefined)) return null;
      }
      const newest = Object.values(picked).sort((a, b) => b.judgedAt.localeCompare(a.judgedAt))[0];
      return judgmentsFromSignals(threadId, picked, {
        model: newest?.model ?? "",
        judgedAt: newest?.judgedAt ?? "",
      });
    },

    async listJudgments(workspaceId, opts) {
      const conditions = [
        eq(signalAnswers.workspaceId, workspaceId),
        inArray(signalAnswers.signalId, Object.values(ARRIVAL_SIGNALS)),
      ];
      if (opts.since) conditions.push(gte(signalAnswers.judgedAt, opts.since));
      if (opts.threadIds) {
        if (opts.threadIds.length === 0) return [];
        conditions.push(inArray(signalAnswers.threadId, [...opts.threadIds]));
      }
      const rows = await db
        .select({ threadId: signalAnswers.threadId })
        .from(signalAnswers)
        .where(and(...conditions))
        .groupBy(signalAnswers.threadId);
      const all = await readings(rows.map((r) => r.threadId));
      const out: ThreadJudgments[] = [];
      for (const [threadId, answers] of all) {
        const newest = Object.values(answers).sort((a, b) =>
          b.judgedAt.localeCompare(a.judgedAt),
        )[0];
        const j = judgmentsFromSignals(threadId, answers, {
          model: newest?.model ?? "",
          judgedAt: newest?.judgedAt ?? "",
        });
        if (j) out.push(j);
      }
      return out;
    },

    async answeredSince(workspaceId, signalIds, since) {
      if (signalIds.length === 0) return new Map();
      const rows = await db
        .select({ threadId: signalAnswers.threadId })
        .from(signalAnswers)
        .where(
          and(
            eq(signalAnswers.workspaceId, workspaceId),
            inArray(signalAnswers.signalId, [...signalIds]),
            gte(signalAnswers.judgedAt, since),
          ),
        )
        .groupBy(signalAnswers.threadId);
      return readings(rows.map((r) => r.threadId));
    },

    async page(workspaceId) {
      const s = await readSettings();
      const defs = (await syncDefs(workspaceId, s)).filter((d) => d.active);
      const scope = parseSortScope(s["signals.backfill.scope"]) ?? { kind: "all" as const };
      const total = await countInScope(db, workspaceId, resolveScope(scope, now()));
      const counts = await db
        .select({
          signalId: signalAnswers.signalId,
          version: signalAnswers.version,
          n: sql<number>`count(*)::int`,
        })
        .from(signalAnswers)
        .where(eq(signalAnswers.workspaceId, workspaceId))
        .groupBy(signalAnswers.signalId, signalAnswers.version);
      // Base rates over the newest Threads that have answers.
      const recent = await db
        .select({ threadId: signalAnswers.threadId })
        .from(signalAnswers)
        .innerJoin(threads, eq(threads.id, signalAnswers.threadId))
        .where(eq(signalAnswers.workspaceId, workspaceId))
        .groupBy(signalAnswers.threadId, threads.lastActivity)
        .orderBy(sql`${threads.lastActivity} desc`)
        .limit(s["signals.stats.window"]);
      const window = recent.map((r) => r.threadId);
      const rows = window.length
        ? await db.select().from(signalAnswers).where(inArray(signalAnswers.threadId, window))
        : [];
      const rules = rulesOf(s);
      const shippedKey = shippedSettingKeys();
      const signals = defs.map((d) => {
        const current = counts.find((c) => c.signalId === d.id && c.version === d.version)?.n ?? 0;
        const stale = counts
          .filter((c) => c.signalId === d.id && c.version < d.version)
          .reduce((n, c) => n + c.n, 0);
        const answers = rows.filter((r) => r.signalId === d.id && r.model !== "code");
        const holding = answers.filter((r) =>
          d.kind === "noul"
            ? (r.noul ?? 0) >= rules.noulHigh
            : d.kind === "score"
              ? (r.score ?? 0) >= 1 && (r.confidence ?? 0) >= rules.confidenceBelow
              : r.choice !== null && r.choice !== "none" && r.choice !== "unclear",
        ).length;
        const share = answers.length > 0 ? holding / answers.length : null;
        const flag: SignalsPage["signals"][number]["flag"] =
          share === null || answers.length < s["signals.stats.min_answers"]
            ? null
            : share >= s["signals.stats.broad_above"]
              ? "too_broad"
              : share === 0
                ? "never"
                : null;
        return {
          id: d.id,
          label: questionLabel(d.question),
          kind: d.kind,
          version: d.version,
          owner: d.owner,
          consumers: d.consumers,
          read: current,
          stale,
          holds: share,
          flag,
          setting: d.owner.kind === "shipped" ? (shippedKey[d.id] ?? null) : null,
        };
      });
      return { workspaceId, total, signals };
    },

    async explain(threadId) {
      const all = (await readings([threadId])).get(threadId);
      const row = await db.query.threads.findFirst({
        where: eq(threads.id, threadId),
        columns: { workspaceId: true },
      });
      if (!row) return null;
      const defs = new Map((await api.defs(row.workspaceId)).map((d) => [d.id, d]));
      const facts = await db.query.threadFacts.findFirst({
        where: eq(threadFacts.threadId, threadId),
      });
      let amount: SealedFacts["amount"] = null;
      if (facts?.contentEnc && facts.contentKey) {
        try {
          const sealed = JSON.parse(
            await mailstore.readText({
              workspaceId: row.workspaceId,
              kind: "facts",
              key: facts.contentKey,
              chunks: [facts.contentEnc],
              size: -1,
            }),
          ) as SealedFacts;
          amount = sealed.amount;
        } catch {
          amount = null;
        }
      }
      return {
        threadId,
        signals: Object.values(all ?? {}).map((a) => {
          const d = defs.get(a.signalId);
          return {
            id: a.signalId,
            label: d ? questionLabel(d.question) : a.signalId,
            kind: d?.kind ?? "noul",
            noul: a.noul ?? null,
            choice: a.choice ?? null,
            score: a.score ?? null,
            confidence: a.confidence ?? null,
            version: a.version,
            currentVersion: d?.version ?? a.version,
            stale: a.stale,
            lowTrust: a.lowTrust ?? null,
            model: a.model,
            judgedAt: a.judgedAt,
          };
        }),
        facts: (facts?.facts ?? null) as Record<string, unknown> | null,
        amount,
      };
    },

    async missing(workspaceId, threadId) {
      const s = await readSettings();
      return (await needed(workspaceId, threadId, s, { reason: "arrival" })).need.map((d) => d.id);
    },

    async version(threadId) {
      return (await versionsOf([threadId])).get(threadId) as ThreadVersion;
    },

    async remove(threadId) {
      const removed = await db
        .delete(signalAnswers)
        .where(eq(signalAnswers.threadId, threadId))
        .returning();
      const first = removed[0];
      if (!first) return false;
      const payload: SignalsChange = { threadId, answers: [], deleted: true };
      await mailstore.recordChange(db, {
        workspaceId: first.workspaceId,
        kind: "signals",
        entityId: threadId,
        payload,
      });
      return true;
    },

    async forget(workspaceId, signalId) {
      const removed = await db
        .delete(signalAnswers)
        .where(
          and(eq(signalAnswers.workspaceId, workspaceId), eq(signalAnswers.signalId, signalId)),
        )
        .returning({ threadId: signalAnswers.threadId });
      for (const r of removed) {
        const payload: SignalsChange = { threadId: r.threadId, answers: [], removed: [signalId] };
        await mailstore.recordChange(db, {
          workspaceId,
          kind: "signals",
          entityId: r.threadId,
          payload,
        });
      }
      return removed.length;
    },

    async settings() {
      const s = await readSettings();
      return {
        enabled: s["signals.enabled"],
        onArrival: s["judgments.on_arrival"],
        rules: rulesOf(s),
        llmFallback: s["signals.llm_fallback"],
        maxActive: s["signals.max_active"],
      };
    },
  };

  /** Without TypeSafe: the language model answers what signals.llm_fallback allows, one Thread per prompt. */
  async function llmAsk(
    workspaceId: Id,
    threadId: Id,
    s: Settings,
    need: readonly StoredDef[],
    state: JsonValue,
    version: ThreadVersion,
    opts: AskOptions,
    cause: NoJudgeError,
    loaded?: Awaited<ReturnType<typeof loadThread>>,
  ): Promise<AskResult> {
    const mode = s["signals.llm_fallback"];
    // Routing's Choices never go this way: routing keeps its own prompt path.
    if (
      opts.llm === false ||
      mode === "none" ||
      (opts.extra && Object.keys(opts.extra).length > 0)
    ) {
      throw cause;
    }
    const allowed = need.filter(
      (d) =>
        d.kind !== "choice" &&
        rowModeOf(d.optionsFrom) === null &&
        (mode === "all" || SHIPPED_SECTION_SIGNALS.includes(d.id)),
    );
    if (allowed.length === 0) throw cause;
    const questions: Record<string, JudgeQuestion> = {};
    for (const d of allowed) questions[d.id] = d.question;
    let text: string;
    let model: string;
    try {
      const r = await runtime.run(
        "classify",
        { system: s["signals.llm_prompt"], prompt: llmPrompt(questions, state) },
        { workspaceId, jobId: opts.jobId ?? null },
      );
      text = r.output;
      model = r.model;
    } catch (error) {
      if (error instanceof NoProviderKeyError) throw cause;
      throw error;
    }
    const answers = parseLlmAnswers(text, questions);
    const items = allowed.flatMap((d) => {
      const a = answers[d.id];
      return a ? [{ def: d, answer: a }] : [];
    });
    if (items.length === 0)
      log(`signals ${threadId}: the language model answered nothing readable`);
    await write(workspaceId, threadId, version, items, model, loaded?.lowTrust ?? null);
    if (loaded) await storeFacts(workspaceId, threadId, version, loaded, {}, s);
    await answered(workspaceId, threadId);
    return {
      asked: items.map((i) => i.def.id),
      extra: {},
      picks: {},
      candidates: {},
      calls: 1,
      by: "llm",
    };
  }

  return api;
}
