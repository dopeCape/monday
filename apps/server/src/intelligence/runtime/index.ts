// The Hosted runtime (ADR 0007): every model call goes through run(), so the
// task-to-model map, the provider key and the Meter are enforced in one
// place. Below it sits one seam, ChatModel: one call to one provider. The
// LangChain implementation is langchain.ts; tests use fake/.
//
// Keys come through a resolver so the same runtime serves the Server (shared
// keys under the envelope) and a client running a Task with a Device key.

import type {
  AiLevel,
  HostedProvider,
  JsonValue,
  JudgeQuestions,
  JudgeResponse,
  JudgeTask,
  KeyProvider,
  MeterEntry,
  Task,
  Usage,
} from "@monday/shared";
import {
  type Effort,
  estimateCostMicros,
  type HostedSettings,
  type ModelChoice,
  priceFor,
  pricingFor,
  resolveTaskModel,
} from "@monday/shared";

/** One call to one model, with the key already resolved. */
export interface ChatCall {
  provider: HostedProvider;
  model: string;
  effort: Effort;
  maxOutputTokens: number;
  key: string;
  /** The OpenAI-compatible base URL for kimi and openrouter. */
  baseUrl?: string;
  system: string;
  prompt: string;
}

export interface ChatResponse {
  text: string;
  usage: Usage;
  /** The model the provider reports having used, when it says. */
  model?: string;
}

/** The seam under the runtime: LangChain in production, canned answers in tests. */
export type ChatModel = (call: ChatCall) => Promise<ChatResponse>;

/* ------------------------------ The agent loop's seam ------------------------------ */

/** One tool call the model asked for. Arguments are parsed JSON, never a string. */
export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** The transcript as the loop keeps it: provider-neutral, JSON-serializable. */
export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

/** A tool as the model sees it: name, description and a JSON Schema for its input. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One model step with the tools bound and the history so far. */
export interface ConverseCall extends Omit<ChatCall, "prompt"> {
  messages: AgentMessage[];
  tools: ToolSpec[];
  /** Text as it streams; the whole answer still arrives in the response. */
  onText?: ((delta: string) => void) | undefined;
}

export interface ConverseResponse {
  text: string;
  toolCalls: AgentToolCall[];
  usage: Usage;
  model?: string;
}

/** The seam the agent loop calls: LangChain with tools bound in production, a script in tests. */
export type ConverseModel = (call: ConverseCall) => Promise<ConverseResponse>;

/** Where a provider's key comes from: the shared-key store on the Server, the keychain on a Device. */
export type KeysResolver = (provider: KeyProvider) => Promise<string | null>;

export interface RunInput {
  system: string;
  prompt: string;
  /** Raises the Setting's cap for a Task that needs more room. */
  maxOutputTokens?: number;
}

export interface RunOptions {
  workspaceId: string;
  /** The Job this call runs under, for the Meter row. */
  jobId?: string | null;
  /** Overrides the Setting's provider, for a client with a key for another one. */
  provider?: HostedProvider;
}

export interface RunResult {
  output: string;
  usage: Usage;
  costMicros: number;
  provider: HostedProvider;
  model: string;
  durationMs: number;
  meter: MeterEntry;
}

export type MeterInput = Omit<MeterEntry, "id" | "createdAt">;

export interface ConverseInput {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  onText?: ((delta: string) => void) | undefined;
  maxOutputTokens?: number;
}

export interface ConverseResult extends Omit<RunResult, "output"> {
  text: string;
  toolCalls: AgentToolCall[];
}

export interface HostedRuntime {
  /** Resolves the model, calls it, meters the call. Throws NoProviderKeyError. */
  run(task: Task, input: RunInput, options: RunOptions): Promise<RunResult>;
  /** One step of an agent loop: the same resolution and Meter, with tools bound. */
  converse(task: Task, input: ConverseInput, options: RunOptions): Promise<ConverseResult>;
  /** The model a Task would run on now, under the current Settings. */
  resolve(task: Task, provider?: HostedProvider): Promise<ModelChoice>;
  /**
   * Typed questions over one state, answered by the judge (ADR 0012) and
   * metered under the JudgeTask. Throws NoJudgeError when Settings say the
   * language model decides or no TypeSafe key is configured; callers keep
   * their prompt path for that case. Throws AiOffError at level off.
   */
  judge<Q extends JudgeQuestions>(
    task: JudgeTask,
    state: JsonValue,
    questions: Q,
    options: RunOptions,
  ): Promise<JudgeResult<Q>>;
  /** Whether judge() would answer right now, without asking anything. */
  judgeAvailable(): Promise<boolean>;
}

/** One request to the judge provider, with the key already resolved. */
export interface JudgeCall<Q extends JudgeQuestions = JudgeQuestions> {
  model: string;
  key: string;
  state: JsonValue;
  questions: Q;
  /** The judge API's base URL from Settings (ai.endpoint.typesafe); absent means the provider's default. */
  baseUrl?: string;
}

export type JudgeModel = <Q extends JudgeQuestions>(
  call: JudgeCall<Q>,
) => Promise<JudgeResponse<Q>>;

export interface JudgeResult<Q extends JudgeQuestions> extends JudgeResponse<Q> {
  costMicros: number;
  durationMs: number;
  meter: MeterEntry;
}

/** Settings send judgments to the language model, or no TypeSafe key is configured. */
export class NoJudgeError extends Error {
  readonly status = 409;
  readonly code = "no_judge";
  constructor(readonly reason: "llm" | "no_key" | "no_model") {
    super(
      reason === "llm"
        ? "judgments go to the language model under Settings"
        : reason === "no_key"
          ? "no TypeSafe key is configured"
          : "this runtime has no judge model",
    );
    this.name = "NoJudgeError";
  }
}

export interface HostedRuntimeOptions {
  chat: ChatModel;
  /** Absent means converse() throws; the Server wires LangChain, tests a script. */
  converse?: ConverseModel;
  /** Absent means judge() throws NoJudgeError("no_model"); the Server wires TypeSafe, tests a script. */
  judge?: JudgeModel;
  keys: KeysResolver;
  settings: () => Promise<HostedSettings>;
  meter: { record(entry: MeterInput): Promise<MeterEntry> };
  now?: () => number;
  /**
   * The AI level (CONTEXT.md). At `off` every call is refused with AiOffError
   * before a model or a key is touched: no Brief, no classify, no composer
   * turn, no agentic Step. Absent means the level is not enforced here.
   */
  level?: () => Promise<AiLevel>;
}

/** The AI level is `off`: monday makes no model calls at all (docs/spec/onboarding.md). */
export class AiOffError extends Error {
  readonly status = 409;
  readonly code = "ai_off";
  constructor(readonly task: Task) {
    super(`AI is off; the ${task} Task made no model call`);
    this.name = "AiOffError";
  }
}

/** The provider has no key where this runtime looks for one. */
export class NoProviderKeyError extends Error {
  readonly status = 409;
  constructor(readonly provider: HostedProvider) {
    super(`no ${provider} key is available to this runtime`);
    this.name = "NoProviderKeyError";
  }
}

export function endpointFor(
  settings: HostedSettings,
  provider: HostedProvider,
): string | undefined {
  if (provider === "kimi") return settings["ai.endpoint.kimi"];
  if (provider === "openrouter") return settings["ai.endpoint.openrouter"];
  return undefined;
}

export function createHostedRuntime(options: HostedRuntimeOptions): HostedRuntime {
  const now = options.now ?? (() => Date.now());

  const runtime: HostedRuntime = {
    async resolve(task, provider) {
      return resolveTaskModel(await options.settings(), task, provider);
    },

    async run(task, input, opts) {
      const { call, finish } = await prepare(task, input.maxOutputTokens, opts);
      const response = await options.chat({ ...call, system: input.system, prompt: input.prompt });
      const metered = await finish(response);
      return { output: response.text, ...metered };
    },

    async judgeAvailable() {
      if (!options.judge) return false;
      if (options.level && (await options.level()) === "off") return false;
      const settings = await options.settings();
      if (settings["ai.judge.provider"] === "llm") return false;
      return (await options.keys("typesafe")) !== null;
    },

    async judge(task, state, questions, opts) {
      if (options.level && (await options.level()) === "off") throw new AiOffError("classify");
      const judge = options.judge;
      if (!judge) throw new NoJudgeError("no_model");
      const settings = await options.settings();
      if (settings["ai.judge.provider"] === "llm") throw new NoJudgeError("llm");
      const key = await options.keys("typesafe");
      if (!key) throw new NoJudgeError("no_key");
      const started = now();
      const response = await judge({
        model: settings["ai.judge.model"],
        key,
        state,
        questions,
        baseUrl: settings["ai.endpoint.typesafe"],
      });
      const durationMs = Math.max(0, now() - started);
      const usage: Usage = {
        inputTokens: Math.max(0, Math.round(response.usage.inputTokens)),
        outputTokens: 0,
        cachedTokens: 0,
      };
      const costMicros = estimateCostMicros(
        priceFor(pricingFor(settings, "typesafe"), response.model),
        usage,
      );
      const meter = await options.meter.record({
        workspaceId: opts.workspaceId,
        task,
        provider: "typesafe",
        model: response.model,
        ...usage,
        costMicros,
        durationMs,
        jobId: opts.jobId ?? null,
      });
      return { ...response, costMicros, durationMs, meter };
    },

    async converse(task, input, opts) {
      const converse = options.converse;
      if (!converse) throw new Error("this runtime has no conversational model");
      const { call, finish } = await prepare(task, input.maxOutputTokens, opts);
      const response = await converse({
        ...call,
        system: input.system,
        messages: input.messages,
        tools: input.tools,
        onText: input.onText,
      });
      const metered = await finish(response);
      return { text: response.text, toolCalls: response.toolCalls, ...metered };
    },
  };

  /** What both entry points share: resolve the model, check the key, then meter what came back. */
  async function prepare(task: Task, maxOutputTokens: number | undefined, opts: RunOptions) {
    if (options.level && (await options.level()) === "off") throw new AiOffError(task);
    const settings = await options.settings();
    const choice = resolveTaskModel(settings, task, opts.provider);
    const key = await options.keys(choice.provider);
    if (!key) throw new NoProviderKeyError(choice.provider);
    const started = now();
    const baseUrl = endpointFor(settings, choice.provider);
    const call: Omit<ChatCall, "system" | "prompt"> = {
      provider: choice.provider,
      model: choice.model,
      effort: choice.effort,
      maxOutputTokens: Math.max(choice.maxOutputTokens, maxOutputTokens ?? 0),
      key,
      ...(baseUrl ? { baseUrl } : {}),
    };
    const finish = async (response: { usage: Usage; model?: string }) => {
      const durationMs = Math.max(0, now() - started);
      const model = response.model || choice.model;
      const usage: Usage = {
        inputTokens: Math.max(0, Math.round(response.usage.inputTokens)),
        outputTokens: Math.max(0, Math.round(response.usage.outputTokens)),
        cachedTokens: Math.max(0, Math.round(response.usage.cachedTokens)),
      };
      const costMicros = estimateCostMicros(
        priceFor(pricingFor(settings, choice.provider), model),
        usage,
      );
      const meter = await options.meter.record({
        workspaceId: opts.workspaceId,
        task,
        provider: choice.provider,
        model,
        ...usage,
        costMicros,
        durationMs,
        jobId: opts.jobId ?? null,
      });
      return { usage, costMicros, provider: choice.provider, model, durationMs, meter };
    };
    return { call, finish };
  }

  return runtime;
}
