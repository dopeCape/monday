// The fake at the runtime's seam: a ChatModel that answers from a script
// and records every call, plus in-memory keys, so a module test exercises
// the real runtime (model resolution, the Meter, cost) without a network.

import type { HostedProvider, MeterEntry, Usage } from "@monday/shared";
import { defaultSettings, type HostedSettings } from "@monday/shared";
import type {
  ChatCall,
  ChatModel,
  ChatResponse,
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
  meter: ReturnType<typeof createMemoryMeter>;
} {
  const chat = createFakeChat(options.answer ?? "");
  const meter = createMemoryMeter();
  const runtime = createHostedRuntime({
    chat: chat.chat,
    keys: fakeKeys(options.keys ?? { anthropic: "sk-ant-fake" }),
    settings: async () => ({ ...defaultSettings(), ...options.settings }),
    meter,
    ...(options.now ? { now: options.now } : {}),
  });
  return { runtime, chat, meter };
}
