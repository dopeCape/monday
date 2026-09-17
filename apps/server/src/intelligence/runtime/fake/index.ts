// The fake at the runtime's seam: a ChatModel that answers from a script
// and records every call, plus in-memory keys, so a module test exercises
// the real runtime (model resolution, the Meter, cost) without a network.

import type { HostedProvider, MeterEntry, Usage } from "@monday/shared";
import { defaultSettings, type HostedSettings } from "@monday/shared";
import type {
  ChatCall,
  ChatModel,
  ChatResponse,
  ConverseCall,
  ConverseModel,
  ConverseResponse,
  HostedRuntime,
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
export function fakeKeys(keys: Partial<Record<HostedProvider, string>>): KeysResolver {
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
export function createFakeRuntime(options: FakeRuntimeOptions = {}): {
  runtime: HostedRuntime;
  chat: FakeChat;
  converse: FakeConverse;
  meter: ReturnType<typeof createMemoryMeter>;
} {
  const chat = createFakeChat(options.answer ?? "");
  const converse = createFakeConverse(...(options.steps ?? []));
  const meter = createMemoryMeter();
  const runtime = createHostedRuntime({
    chat: chat.chat,
    converse: converse.converse,
    keys: fakeKeys(options.keys ?? { anthropic: "sk-ant-fake" }),
    settings: async () => ({ ...defaultSettings(), ...options.settings }),
    meter,
    ...(options.now ? { now: options.now } : {}),
  });
  return { runtime, chat, converse, meter };
}
