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
  type AIMessage,
  HumanMessage,
  SystemMessage,
  type UsageMetadata,
} from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type { Effort, HostedProvider, Usage } from "@monday/shared";
import type { ChatCall, ChatModel, ChatResponse } from "./index.ts";

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

export function buildModel(call: ChatCall): BaseChatModel {
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
