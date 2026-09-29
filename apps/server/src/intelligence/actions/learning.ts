// Learning from what the user does with the chips (docs/spec/actions.md,
// "Learning from what the user does"; slice 35). Pure: over an action's last
// actions.learning.window outcomes since its threshold was last set, fewer
// used than actions.learning.min_use_rate raises the threshold one step (up
// to the ceiling); more than actions.learning.high_use_rate lowers it one
// step, never below its shipped default. No weights are trained.

import type { RecommendationOutcome } from "@monday/shared";

export interface LearningSettings {
  enabled: boolean;
  window: number;
  minUseRate: number;
  highUseRate: number;
  step: number;
  maxThreshold: number;
}

export interface LearningInput {
  /** The action's outcomes since its threshold was last set, newest first. */
  outcomes: readonly RecommendationOutcome[];
  current: number;
  /** The shipped default: learning never goes below it. */
  shipped: number;
  settings: LearningSettings;
}

export interface LearningStep {
  next: number;
  shown: number;
  used: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The threshold the action moves to, or null when it stays (too few outcomes, or inside the band). */
export function learnThreshold(input: LearningInput): LearningStep | null {
  const s = input.settings;
  if (!s.enabled || s.window < 1) return null;
  const window = input.outcomes.slice(0, s.window);
  if (window.length < s.window) return null;
  const used = window.filter((o) => o === "used").length;
  const rate = used / window.length;
  let next = input.current;
  if (rate < s.minUseRate) next = Math.min(s.maxThreshold, input.current + s.step);
  else if (rate > s.highUseRate) next = Math.max(input.shipped, input.current - s.step);
  next = round(next);
  if (next === round(input.current)) return null;
  return { next, shown: window.length, used };
}

/** An action's recent use rate for ordering its chip: used over its outcomes, 1 before any history. */
export function useRate(outcomes: readonly RecommendationOutcome[], minimum = 5): number {
  if (outcomes.length < minimum) return 1;
  const used = outcomes.filter((o) => o === "used").length;
  // A small floor so an action never ranks at nothing.
  return Math.max(0.05, used / outcomes.length);
}
