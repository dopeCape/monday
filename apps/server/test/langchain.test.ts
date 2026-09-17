// The LangChain layer under the runtime seam, without a network: each
// provider builds, and the effort Setting lands where that provider takes
// it. Calls against the real providers are in intelligence.live.test.ts.

import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import type { ChatCall } from "../src/intelligence/runtime/index.ts";
import { buildModel, textOf, usageOf } from "../src/intelligence/runtime/langchain.ts";

const base = { key: "not-a-real-key", maxOutputTokens: 4096, system: "", prompt: "" };
const call = (over: Partial<ChatCall> & Pick<ChatCall, "provider" | "model">): ChatCall => ({
  ...base,
  effort: "low",
  ...over,
});

/** The constructed models keep their options as fields; read them without the provider types. */
const fields = (model: unknown) => model as Record<string, unknown>;

describe("LangChain models", () => {
  test("Haiku 4.5 takes a thinking budget from the effort, none at low", () => {
    const low = fields(buildModel(call({ provider: "anthropic", model: "claude-haiku-4-5" })));
    expect(low.model).toBe("claude-haiku-4-5");
    expect(low.maxTokens).toBe(4096);
    expect(low.thinking).toEqual({ type: "disabled" });
    const medium = fields(
      buildModel(call({ provider: "anthropic", model: "claude-haiku-4-5", effort: "medium" })),
    );
    expect(medium.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    const high = fields(
      buildModel(
        call({
          provider: "anthropic",
          model: "claude-haiku-4-5",
          effort: "high",
          maxOutputTokens: 1000,
        }),
      ),
    );
    // The budget must stay under max_tokens, so the cap rises to fit it.
    expect(high.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(high.maxTokens).toBe(8192 + 1024);
  });

  test("Sonnet 5 runs adaptive thinking with output_config.effort", () => {
    const sonnet = fields(
      buildModel(call({ provider: "anthropic", model: "claude-sonnet-5", effort: "high" })),
    );
    expect(sonnet.thinking).toEqual({ type: "adaptive" });
    expect(sonnet.outputConfig).toEqual({ effort: "high" });
  });

  test("Gemini, OpenAI, Kimi and OpenRouter build with their effort or endpoint", () => {
    const gemini = fields(buildModel(call({ provider: "gemini", model: "gemini-2.5-flash" })));
    expect(gemini.model).toBe("gemini-2.5-flash");
    expect(gemini.thinkingConfig).toEqual({ thinkingBudget: 1024 });
    const openai = fields(
      buildModel(call({ provider: "openai", model: "gpt-5-mini", effort: "medium" })),
    );
    expect(openai.model).toBe("gpt-5-mini");
    expect(openai.reasoning).toEqual({ effort: "medium" });
    const kimi = fields(
      buildModel(
        call({ provider: "kimi", model: "kimi-k2-turbo-preview", baseUrl: "https://kimi.test/v1" }),
      ),
    );
    expect((kimi.clientConfig as { baseURL?: string }).baseURL).toBe("https://kimi.test/v1");
    const openrouter = fields(
      buildModel(call({ provider: "openrouter", model: "anthropic/claude-haiku-4.5" })),
    );
    expect((openrouter.clientConfig as { baseURL?: string }).baseURL).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  test("text and usage come out of an AIMessage; cache reads are the cached tokens", () => {
    // The wire shape Anthropic answers with; the generic message types do not narrow it.
    const wire = {
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: '{"bullets":' },
        { type: "text", text: "[]}" },
      ],
      usage_metadata: {
        input_tokens: 900,
        output_tokens: 40,
        total_tokens: 940,
        input_token_details: { cache_read: 300, cache_creation: 100 },
      },
    };
    const message = new AIMessage(wire as unknown as ConstructorParameters<typeof AIMessage>[0]);
    expect(textOf(message)).toBe('{"bullets":[]}');
    expect(usageOf(message)).toEqual({ inputTokens: 900, outputTokens: 40, cachedTokens: 300 });
    expect(usageOf(new AIMessage("plain"))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    });
    expect(textOf(new AIMessage("plain"))).toBe("plain");
  });
});
