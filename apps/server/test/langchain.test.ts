// The LangChain layer under the runtime seam, without a network: each
// provider builds, and the effort Setting lands where that provider takes
// it. Calls against the real providers are in intelligence.live.test.ts.

import { describe, expect, test } from "bun:test";
import { AIMessage, type ToolMessage } from "@langchain/core/messages";
import type { ChatCall } from "../src/intelligence/runtime/index.ts";
import {
  buildModel,
  textOf,
  toLangChainMessages,
  toolCallsOf,
  toolDefinition,
  usageOf,
} from "../src/intelligence/runtime/langchain.ts";

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

  test("the agent loop's transcript and tools cross into LangChain and its tool calls come back parsed", () => {
    const messages = toLangChainMessages("sys", [
      { role: "user", content: "archive old newsletters" },
      {
        role: "assistant",
        content: "Looking.",
        toolCalls: [{ id: "toolu_1", name: "search_threads", args: { section: "newsletters" } }],
      },
      {
        role: "tool",
        toolCallId: "toolu_1",
        name: "search_threads",
        content: "12 threads",
        isError: true,
      },
    ]);
    expect(messages.map((m) => m.getType())).toEqual(["system", "human", "ai", "tool"]);
    const ai = messages[2] as AIMessage;
    expect(ai.tool_calls).toEqual([
      {
        id: "toolu_1",
        name: "search_threads",
        args: { section: "newsletters" },
        type: "tool_call",
      },
    ]);
    const tool = messages[3] as ToolMessage;
    expect(tool.tool_call_id).toBe("toolu_1");
    expect(tool.status).toBe("error");

    expect(
      toolDefinition({ name: "undo", description: "Undo.", inputSchema: { type: "object" } }),
    ).toEqual({
      type: "function",
      function: { name: "undo", description: "Undo.", parameters: { type: "object" } },
    });

    const answer = new AIMessage({
      content: "",
      tool_calls: [
        { id: "a", name: "archive_threads", args: { thread_ids: ["t1"] }, type: "tool_call" },
      ],
      invalid_tool_calls: [
        {
          id: "b",
          name: "snooze_threads",
          args: "{not json",
          error: "Unexpected token",
          type: "invalid_tool_call",
        },
      ],
    });
    expect(toolCallsOf(answer)).toEqual([
      { id: "a", name: "archive_threads", args: { thread_ids: ["t1"] } },
      {
        id: "b",
        name: "snooze_threads",
        args: { __invalid: "Unexpected token", raw: "{not json" },
      },
    ]);
    // Every provider model binds the catalog's tools.
    for (const provider of ["anthropic", "gemini", "openai", "kimi"] as const) {
      const model = buildModel(call({ provider, model: "m" }));
      expect(typeof model.bindTools).toBe("function");
    }
  });
});
