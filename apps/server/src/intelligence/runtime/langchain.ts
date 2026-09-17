// The LangChain ChatModel (ADR 0007): Anthropic, Gemini and OpenAI through
// their LangChain packages; Kimi and OpenRouter through the OpenAI package
// with their base URL from Settings. This is the only file that imports a
// provider package. Effort is mapped per provider here: Anthropic's
// output_config.effort with adaptive thinking on the models that take it,
// a thinking budget on Haiku 4.5, OpenAI's reasoning effort, Gemini's
// thinking budget or level.

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type UsageMetadata,
} from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type { Effort, HostedProvider, Usage } from "@monday/shared";
import type {
  AgentMessage,
  AgentToolCall,
  ChatCall,
  ChatModel,
  ChatResponse,
  ConverseCall,
  ConverseModel,
  ConverseResponse,
  ToolSpec,
} from "./index.ts";

/** Haiku 4.5 takes a thinking budget instead of an effort level. */
const HAIKU_BUDGET: Record<Effort, number> = { low: 0, medium: 2048, high: 8192 };
const GEMINI_BUDGET: Record<Effort, number> = { low: 1024, medium: 4096, high: 16384 };
const GEMINI_LEVEL: Record<Effort, "LOW" | "MEDIUM" | "HIGH"> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
};

/** A model the effort setting reaches through `output_config.effort` rather than a budget. */
export function anthropicTakesEffort(model: string): boolean {
  return !model.startsWith("claude-haiku");
}

export function buildModel(call: Omit<ChatCall, "system" | "prompt">): BaseChatModel {
  switch (call.provider) {
    case "anthropic": {
      if (anthropicTakesEffort(call.model)) {
        return new ChatAnthropic({
          apiKey: call.key,
          model: call.model,
          maxTokens: call.maxOutputTokens,
          thinking: { type: "adaptive" },
          outputConfig: { effort: call.effort },
        });
      }
      const budget = HAIKU_BUDGET[call.effort];
      // A budget must stay under max_tokens; leave room for the answer.
      const maxTokens =
        budget > 0 ? Math.max(call.maxOutputTokens, budget + 1024) : call.maxOutputTokens;
      return new ChatAnthropic({
        apiKey: call.key,
        model: call.model,
        maxTokens,
        ...(budget > 0 ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
      });
    }
    case "gemini":
      return new ChatGoogleGenerativeAI({
        apiKey: call.key,
        model: call.model,
        maxOutputTokens: call.maxOutputTokens,
        thinkingConfig: call.model.includes("2.5")
          ? { thinkingBudget: GEMINI_BUDGET[call.effort] }
          : { thinkingLevel: GEMINI_LEVEL[call.effort] },
      });
    case "openai":
      return new ChatOpenAI({
        apiKey: call.key,
        model: call.model,
        maxTokens: call.maxOutputTokens,
        reasoning: { effort: call.effort },
      });
    case "kimi":
    case "openrouter":
      return new ChatOpenAI({
        apiKey: call.key,
        model: call.model,
        maxTokens: call.maxOutputTokens,
        configuration: { baseURL: call.baseUrl ?? defaultBaseUrl(call.provider) },
      });
  }
}

function defaultBaseUrl(provider: Extract<HostedProvider, "kimi" | "openrouter">): string {
  return provider === "kimi" ? "https://api.moonshot.ai/v1" : "https://openrouter.ai/api/v1";
}

/** The text blocks of an answer, joined; thinking and tool blocks are not text. */
export function textOf(message: AIMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .join("");
}

export function usageOf(message: AIMessage): Usage {
  // The generic message structure types the field away; the wire shape is UsageMetadata.
  const usage = message.usage_metadata as UsageMetadata | undefined;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: usage?.input_token_details?.cache_read ?? 0,
  };
}

export function createLangChainChat(): ChatModel {
  return async (call): Promise<ChatResponse> => {
    const model = buildModel(call);
    const answer = await model.invoke([
      new SystemMessage(call.system),
      new HumanMessage(call.prompt),
    ]);
    const reported = answer.response_metadata?.model_name ?? answer.response_metadata?.model;
    return {
      text: textOf(answer),
      usage: usageOf(answer),
      ...(typeof reported === "string" && reported ? { model: reported } : {}),
    };
  };
}

/* ------------------------------ The agent loop's seam ------------------------------ */

/** The OpenAI function shape, which every LangChain provider package accepts in bindTools. */
export function toolDefinition(tool: ToolSpec) {
  return {
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

/** The loop's provider-neutral transcript as LangChain messages. */
export function toLangChainMessages(system: string, messages: AgentMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [new SystemMessage(system)];
  for (const m of messages) {
    switch (m.role) {
      case "user":
        out.push(new HumanMessage(m.content));
        break;
      case "assistant":
        out.push(
          new AIMessage({
            content: m.content,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              name: c.name,
              args: c.args,
              type: "tool_call" as const,
            })),
          }),
        );
        break;
      case "tool":
        out.push(
          new ToolMessage({
            content: m.content,
            tool_call_id: m.toolCallId,
            name: m.name,
            ...(m.isError ? { status: "error" as const } : {}),
          }),
        );
        break;
    }
  }
  return out;
}

/** The parsed tool calls of an answer. A call whose arguments did not parse reaches the loop as an error. */
export function toolCallsOf(message: AIMessage | AIMessageChunk): AgentToolCall[] {
  const calls: AgentToolCall[] = [];
  for (const c of message.tool_calls ?? []) {
    calls.push({ id: c.id ?? crypto.randomUUID(), name: c.name, args: c.args ?? {} });
  }
  for (const bad of message.invalid_tool_calls ?? []) {
    calls.push({
      id: bad.id ?? crypto.randomUUID(),
      name: bad.name ?? "unknown",
      args: { __invalid: bad.error ?? "arguments did not parse", raw: bad.args ?? "" },
    });
  }
  return calls;
}

export function createLangChainConverse(): ConverseModel {
  return async (call: ConverseCall): Promise<ConverseResponse> => {
    const base = buildModel(call);
    if (!base.bindTools) throw new Error(`${call.provider} model cannot bind tools`);
    const bound = base.bindTools(call.tools.map(toolDefinition));
    const input = toLangChainMessages(call.system, call.messages);
    let final: AIMessageChunk | null = null;
    for await (const chunk of await bound.stream(input)) {
      const delta = textOf(chunk as unknown as AIMessage);
      if (delta && call.onText) call.onText(delta);
      final = final ? final.concat(chunk) : chunk;
    }
    if (!final) return { text: "", toolCalls: [], usage: usageOf(new AIMessage("")) };
    const answer = final as unknown as AIMessage;
    const reported = answer.response_metadata?.model_name ?? answer.response_metadata?.model;
    return {
      text: textOf(answer),
      toolCalls: toolCallsOf(final),
      usage: usageOf(answer),
      ...(typeof reported === "string" && reported ? { model: reported } : {}),
    };
  };
}
