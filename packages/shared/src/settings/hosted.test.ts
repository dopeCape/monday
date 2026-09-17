import { describe, expect, test } from "bun:test";
import {
  estimateCostMicros,
  formatMicros,
  priceFor,
  pricingFor,
  resolveTaskModel,
  rolesFor,
} from "./hosted.ts";
import { HOSTED_PROVIDERS, TASKS } from "./index.ts";
import { defaultSettings, settingsSchema, validateSetting } from "./schema.ts";

describe("task-to-Role map", () => {
  test("the brief Task runs on the fast Role, Haiku 4.5 on Anthropic by default", () => {
    const choice = resolveTaskModel(defaultSettings(), "brief");
    expect(choice).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      effort: "low",
      maxOutputTokens: 4096,
    });
  });

  test("the composer runs on the main Role, Sonnet 5, never Opus by default", () => {
    const d = defaultSettings();
    expect(resolveTaskModel(d, "composer").model).toBe("claude-sonnet-5");
    for (const task of TASKS) {
      for (const provider of HOSTED_PROVIDERS) {
        expect(resolveTaskModel(d, task, provider).model).not.toContain("opus");
      }
    }
  });

  test("an exact model on the Task beats the Role", () => {
    const d = defaultSettings();
    d["ai.task.brief"] = { role: "fast", model: "claude-sonnet-5", effort: "medium" };
    expect(resolveTaskModel(d, "brief")).toMatchObject({
      model: "claude-sonnet-5",
      effort: "medium",
    });
  });

  test("a provider argument picks that provider's Roles", () => {
    const d = defaultSettings();
    expect(resolveTaskModel(d, "brief", "gemini").model).toBe(rolesFor(d, "gemini").fast);
    expect(resolveTaskModel(d, "composer", "openrouter").model).toBe(
      rolesFor(d, "openrouter").main,
    );
  });

  test("every provider has Roles, a share switch and a price table", () => {
    const d = defaultSettings();
    for (const provider of HOSTED_PROVIDERS) {
      const roles = rolesFor(d, provider);
      expect(roles.main.length).toBeGreaterThan(0);
      expect(roles.fast.length).toBeGreaterThan(0);
      expect(d[`ai.share_key.${provider}`]).toBe(false);
      expect(priceFor(pricingFor(d, provider), roles.main)).not.toBeNull();
      expect(priceFor(pricingFor(d, provider), roles.fast)).not.toBeNull();
    }
  });

  test("the share switch help carries its threat model", () => {
    expect(settingsSchema["ai.share_key.anthropic"].help).toContain("controls the Server host");
  });
});

describe("pricing", () => {
  test("Anthropic prices come from the claude-api reference", () => {
    const anthropic = pricingFor(defaultSettings(), "anthropic");
    expect(anthropic["claude-haiku-4-5"]).toEqual({ input: 1, output: 5, cached: 0.1 });
    expect(anthropic["claude-sonnet-5"]).toEqual({ input: 2, output: 10, cached: 0.2 });
  });

  test("a dated model id meters at its family price", () => {
    const anthropic = pricingFor(defaultSettings(), "anthropic");
    expect(priceFor(anthropic, "claude-haiku-4-5-20251001")).toEqual({
      input: 1,
      output: 5,
      cached: 0.1,
    });
    expect(priceFor(anthropic, "claude-nonesuch")).toBeNull();
  });

  test("cost is micro-dollars: tokens times dollars per million", () => {
    const haiku = { input: 1, output: 5, cached: 0.1 };
    expect(
      estimateCostMicros(haiku, { inputTokens: 1000, outputTokens: 200, cachedTokens: 0 }),
    ).toBe(2000);
    expect(
      estimateCostMicros(haiku, { inputTokens: 1000, outputTokens: 0, cachedTokens: 600 }),
    ).toBe(460);
    expect(estimateCostMicros(null, { inputTokens: 1, outputTokens: 1, cachedTokens: 0 })).toBe(0);
  });

  test("a price table validates and rejects a negative price", () => {
    expect(
      validateSetting("ai.pricing.openai", { "gpt-5": { input: 1, output: 2, cached: 0 } }).ok,
    ).toBe(true);
    expect(validateSetting("ai.pricing.openai", { "gpt-5": { input: -1, output: 2 } }).ok).toBe(
      false,
    );
  });

  test("formatMicros", () => {
    expect(formatMicros(0)).toBe("$0.00");
    expect(formatMicros(2000)).toBe("$0.0020");
    expect(formatMicros(1_234_567)).toBe("$1.23");
  });
});
