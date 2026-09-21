// The task-to-model map and the price table, read out of Settings (ADR 0007,
// ADR 0004). Runtime-neutral so the Server's Hosted runtime and a client that
// runs a Task locally with a Device key resolve a model the same way, and the
// Meter's cost estimate is one formula everywhere.

import type { HostedProvider, Roles, Task, Usage } from "../domain.ts";
import type { KeyProvider } from "../judge.ts";
import type { Effort, ModelPrice, Pricing, SettingKey, Settings } from "./schema.ts";

/** The Settings the Hosted runtime reads, so a Server can load exactly these. */
export const HOSTED_SETTING_KEYS = [
  "ai.hosted.provider",
  "ai.roles.anthropic",
  "ai.roles.gemini",
  "ai.roles.openai",
  "ai.roles.kimi",
  "ai.roles.openrouter",
  "ai.task.composer",
  "ai.task.agentic-step",
  "ai.task.brief",
  "ai.task.classify",
  "ai.task.route",
  "ai.task.section",
  "ai.task.tag",
  "ai.task.draft-in-voice",
  "ai.task.summarize",
  "ai.pricing.anthropic",
  "ai.pricing.gemini",
  "ai.pricing.openai",
  "ai.pricing.kimi",
  "ai.pricing.openrouter",
  "ai.pricing.typesafe",
  "ai.judge.provider",
  "ai.judge.model",
  "ai.endpoint.kimi",
  "ai.endpoint.openrouter",
  "ai.endpoint.typesafe",
  "ai.max_output_tokens",
] as const satisfies readonly SettingKey[];

export type HostedSettingKey = (typeof HOSTED_SETTING_KEYS)[number];
export type HostedSettings = Pick<Settings, HostedSettingKey>;

/** What a Task runs on once the Settings are applied. */
export interface ModelChoice {
  provider: HostedProvider;
  /** The exact model id sent to the provider. */
  model: string;
  effort: Effort;
  maxOutputTokens: number;
}

export function rolesFor(settings: HostedSettings, provider: HostedProvider): Roles {
  return settings[`ai.roles.${provider}`];
}

export function pricingFor(settings: HostedSettings, provider: KeyProvider): Pricing {
  return settings[`ai.pricing.${provider}`];
}

/**
 * The model a Task uses on a provider: the Task's exact model when set,
 * otherwise the provider's model for the Task's Role.
 */
export function resolveTaskModel(
  settings: HostedSettings,
  task: Task,
  provider: HostedProvider = settings["ai.hosted.provider"],
): ModelChoice {
  const taskModel = settings[`ai.task.${task}`];
  const model = taskModel.model.trim() || rolesFor(settings, provider)[taskModel.role];
  return {
    provider,
    model,
    effort: taskModel.effort,
    maxOutputTokens: settings["ai.max_output_tokens"],
  };
}

/**
 * The price row for a model: an exact id first, then the longest table key
 * the id starts with (so "claude-haiku-4-5-20251001" meters at the
 * "claude-haiku-4-5" price). Null when the table has nothing for it.
 */
export function priceFor(pricing: Pricing, model: string): ModelPrice | null {
  const exact = pricing[model];
  if (exact) return exact;
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(pricing)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) best = { key, price };
  }
  return best?.price ?? null;
}

/**
 * The cost estimate in USD micro-units. A price is dollars per million
 * tokens, so tokens times price is already micro-dollars. Cached tokens are
 * part of the input count and are priced at the cached rate instead.
 */
export function estimateCostMicros(price: ModelPrice | null, usage: Usage): number {
  if (!price) return 0;
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  return Math.round(
    uncached * price.input + cached * price.cached + usage.outputTokens * price.output,
  );
}

/** Micro-dollars as a short dollar string for the Meter screen. */
export function formatMicros(costMicros: number): string {
  const dollars = costMicros / 1_000_000;
  if (dollars === 0) return "$0.00";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}
