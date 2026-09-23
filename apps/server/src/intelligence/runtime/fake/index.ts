// The fake at the runtime's seam: a ChatModel that answers from a script
// and records every call, plus in-memory keys, so a module test exercises
// the real runtime (model resolution, the Meter, cost) without a network.

import type {
  HostedProvider,
  JudgeAnswer,
  JudgeQuestion,
  JudgeQuestions,
  KeyProvider,
  MeterEntry,
  Usage,
} from "@monday/shared";
import { defaultSettings, type HostedSettings } from "@monday/shared";
import type {
  ChatCall,
  ChatModel,
  ChatResponse,
  ConverseCall,
  ConverseModel,
  ConverseResponse,
  HostedRuntime,
  JudgeModel,
  KeysResolver,
  MeterInput,
} from "../index.ts";
import { createHostedRuntime } from "../index.ts";

export type FakeAnswer = string | ChatResponse | ((call: ChatCall) => ChatResponse | string);

export interface FakeChat {
  chat: ChatModel;
  /** Every call made, in order, with the key the runtime resolved. */
  calls: ChatCall[];
  /** Replaces the answer for the next calls. */
  answer(next: FakeAnswer): void;
}

const DEFAULT_USAGE: Usage = { inputTokens: 1200, outputTokens: 180, cachedTokens: 0 };

/** Fills in usage so a string answer meters like a real one. */
export function fakeResponse(text: string, usage: Partial<Usage> = {}): ChatResponse {
  return { text, usage: { ...DEFAULT_USAGE, ...usage } };
}

export function createFakeChat(initial: FakeAnswer = ""): FakeChat {
  let current = initial;
  const calls: ChatCall[] = [];
  return {
    calls,
    answer(next) {
      current = next;
    },
    chat: async (call) => {
      calls.push(call);
      const produced = typeof current === "function" ? current(call) : current;
      return typeof produced === "string" ? fakeResponse(produced) : produced;
    },
  };
}

/* ------------------------------ The agent loop's fake ------------------------------ */

/**
 * One scripted step of the agent loop: what the model answers given the
 * transcript so far. A string is a final text answer; an object may ask for
 * tool calls. A function decides from the call (its messages and tools).
 */
export type FakeStep =
  | string
  | Partial<ConverseResponse>
  | ((call: ConverseCall) => Partial<ConverseResponse> | string);

export interface FakeConverse {
  converse: ConverseModel;
  calls: ConverseCall[];
  /** Appends steps; each call consumes one. Past the script the model answers with empty text. */
  script(...steps: FakeStep[]): void;
}

export function createFakeConverse(...steps: FakeStep[]): FakeConverse {
  const queue: FakeStep[] = [...steps];
  const calls: ConverseCall[] = [];
  return {
    calls,
    script(...more) {
      queue.push(...more);
    },
    converse: async (call) => {
      calls.push(call);
      const step = queue.shift();
      const produced = typeof step === "function" ? step(call) : step;
      const partial: Partial<ConverseResponse> =
        typeof produced === "string" ? { text: produced } : (produced ?? { text: "" });
      const response: ConverseResponse = {
        text: partial.text ?? "",
        toolCalls: partial.toolCalls ?? [],
        usage: { ...DEFAULT_USAGE, ...partial.usage },
        ...(partial.model ? { model: partial.model } : {}),
      };
      // Stream the text in two pieces so a consumer sees deltas arrive before the answer.
      if (call.onText && response.text) {
        const half = Math.ceil(response.text.length / 2);
        call.onText(response.text.slice(0, half));
        call.onText(response.text.slice(half));
      }
      return response;
    },
  };
}

/** A KeysResolver over a map; providers not in it have no key. */
export function fakeKeys(keys: Partial<Record<KeyProvider, string>>): KeysResolver {
  return async (provider) => keys[provider] ?? null;
}

/** A Meter that keeps rows in memory, for runtime tests without a database. */
export function createMemoryMeter(now: () => Date = () => new Date()) {
  const rows: MeterEntry[] = [];
  return {
    rows,
    async record(entry: MeterInput): Promise<MeterEntry> {
      const row: MeterEntry = {
        id: `m-${rows.length + 1}`,
        createdAt: now().toISOString(),
        ...entry,
      };
      rows.push(row);
      return row;
    },
  };
}

export interface FakeRuntimeOptions {
  /** Scripted judge answers by question id (see createFakeJudge). */
  judgments?: Record<string, FakeJudgeAnswer>;
  answer?: FakeAnswer;
  /** The agent loop's script, one step per model call. */
  steps?: FakeStep[];
  keys?: Partial<Record<HostedProvider, string>>;
  settings?: Partial<HostedSettings>;
  now?: () => number;
}

/**
 * The real runtime over the fake seam: default Settings with an Anthropic
 * key unless told otherwise. Tests of consumers (the Brief Task, routes)
 * start here.
 */
/* ------------------------------ The judge ------------------------------ */

/** A scripted answer: a Choice option name, a Noul probability, a Score position, or the full answer. */
export type FakeJudgeAnswer = string | number | JudgeAnswer;

export interface FakeJudge {
  judge: JudgeModel;
  /** Every request seen, in order: the state and the question ids. */
  calls: Array<{ state: unknown; questions: string[] }>;
  /** Scripts an answer by question id; unscripted questions get the neutral default. */
  answer(id: string, answer: FakeJudgeAnswer): void;
  /**
   * Scripts by a predicate over the state, for tests that judge many Threads.
   * The predicate also sees the questions, so a test can answer a reworded
   * question differently from the original. The first matching rule answers.
   */
  when(
    match: (state: unknown, questions: JudgeQuestions) => boolean,
    answers: Record<string, FakeJudgeAnswer>,
  ): void;
}

/** The neutral answer: the first option at 1, a Noul at 0.5, a Score at 0. */
function neutralAnswer(q: JudgeQuestion): JudgeAnswer {
  if (q.type === "choice") {
    const names = Object.keys(q.criteria);
    const first = names[0] ?? "";
    return {
      type: "choice",
      choice: first,
      probabilities: Object.fromEntries(names.map((n) => [n, n === first ? 1 : 0])),
      confidence: 1,
    };
  }
  if (q.type === "noul") return { type: "noul", noul: 0.5 };
  const levels = q.criteria.length;
  return {
    type: "score",
    score: 0,
    probabilities: Array.from({ length: levels }, (_, i) => (i === 0 ? 1 : 0)),
    confidence: 1,
  };
}

function shapeAnswer(q: JudgeQuestion, scripted: FakeJudgeAnswer): JudgeAnswer {
  if (typeof scripted === "object") return scripted;
  if (q.type === "choice") {
    const names = Object.keys(q.criteria);
    const pick = typeof scripted === "string" ? scripted : (names[Math.round(scripted)] ?? "");
    // The rest of the mass is spread so a test can pin a confidence below 1 by scripting the full answer.
    const probabilities = Object.fromEntries(names.map((n) => [n, n === pick ? 1 : 0]));
    return { type: "choice", choice: pick, probabilities, confidence: 1 };
  }
  if (q.type === "noul")
    return { type: "noul", noul: typeof scripted === "number" ? scripted : 0.5 };
  const levels = q.criteria.length;
  const score = typeof scripted === "number" ? scripted : 0;
  const probabilities = Array.from({ length: levels }, (_, i) => (i === Math.round(score) ? 1 : 0));
  return { type: "score", score, probabilities, confidence: 1 };
}

/**
 * A judge that answers from a script and counts tokens as the state's JSON
 * length, so the Meter has something to record. Unscripted questions get the
 * neutral answer, which keeps a test honest about which judgments it relies on.
 */
export function createFakeJudge(initial: Record<string, FakeJudgeAnswer> = {}): FakeJudge {
  const byId = new Map<string, FakeJudgeAnswer>(Object.entries(initial));
  const rules: Array<{
    match: (state: unknown, questions: JudgeQuestions) => boolean;
    answers: Record<string, FakeJudgeAnswer>;
  }> = [];
  const calls: FakeJudge["calls"] = [];
  const judge: JudgeModel = async <Q extends JudgeQuestions>(call: {
    model: string;
    state: unknown;
    questions: Q;
  }) => {
    calls.push({ state: call.state, questions: Object.keys(call.questions) });
    const rule = rules.find((r) => r.match(call.state, call.questions));
    const answers = Object.fromEntries(
      Object.entries(call.questions).map(([id, q]) => {
        const scripted = rule?.answers[id] ?? byId.get(id);
        return [id, scripted === undefined ? neutralAnswer(q) : shapeAnswer(q, scripted)];
      }),
    );
    return {
      answers: answers as never,
      model: call.model,
      usage: { inputTokens: Math.ceil(JSON.stringify(call.state).length / 4) + 40 },
    };
  };
  return {
    judge,
    calls,
    answer: (id, a) => byId.set(id, a),
    when: (match, answers) => rules.push({ match, answers }),
  };
}

export function createFakeRuntime(options: FakeRuntimeOptions = {}): {
  runtime: HostedRuntime;
  chat: FakeChat;
  converse: FakeConverse;
  judge: FakeJudge;
  meter: ReturnType<typeof createMemoryMeter>;
} {
  const chat = createFakeChat(options.answer ?? "");
  const converse = createFakeConverse(...(options.steps ?? []));
  const judge = createFakeJudge(options.judgments ?? {});
  const meter = createMemoryMeter();
  const runtime = createHostedRuntime({
    chat: chat.chat,
    converse: converse.converse,
    judge: judge.judge,
    keys: fakeKeys(options.keys ?? { anthropic: "sk-ant-fake", typesafe: "ts-fake" }),
    settings: async () => ({ ...defaultSettings(), ...options.settings }),
    meter,
    ...(options.now ? { now: options.now } : {}),
  });
  return { runtime, chat, converse, judge, meter };
}
