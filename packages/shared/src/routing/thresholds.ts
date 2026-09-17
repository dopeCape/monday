// Confidence to placement (CONTEXT.md "Confidence", "Needs a decision"): at
// or above the route threshold a Thread is placed; from the ask threshold up
// it goes to Needs a decision; below, it is left alone. Two rules within the
// tie margin of each other also ask. The thresholds are Settings; a Group may
// override the route threshold for itself. Pure, runtime-neutral.

import type { Confidence, GroupId } from "../domain.ts";

export interface Thresholds {
  route: Confidence;
  ask: Confidence;
  tieMargin: Confidence;
}

export interface Score {
  groupId: GroupId;
  confidence: Confidence;
}

export type RoutePlacement =
  | { kind: "route"; groupId: GroupId; confidence: Confidence }
  | { kind: "ask"; candidates: Score[] }
  | { kind: "none"; best: Score | null };

/** Clamps a model's number into a Confidence in [0, 1] with three decimals; a whole-number percentage is accepted. */
export function clampConfidence(value: unknown): Confidence {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const unit = n > 1 && n <= 100 && Number.isInteger(n) ? n / 100 : n;
  return Math.round(Math.min(1, Math.max(0, unit)) * 1000) / 1000;
}

/**
 * Decides where scores put a Thread. `groupThreshold` supplies a Group's own
 * route threshold, or null for the Setting. The candidates of an ask are every
 * Group at or above the ask threshold, best first, so the user can pick.
 */
export function place(
  scores: readonly Score[],
  thresholds: Thresholds,
  groupThreshold: (groupId: GroupId) => Confidence | null = () => null,
): RoutePlacement {
  const sorted = [...scores]
    .filter((s) => Number.isFinite(s.confidence))
    .sort((a, b) => b.confidence - a.confidence || a.groupId.localeCompare(b.groupId));
  const best = sorted[0];
  if (!best) return { kind: "none", best: null };
  const routeAt = groupThreshold(best.groupId) ?? thresholds.route;
  const askAt = Math.min(thresholds.ask, routeAt);
  const candidates = sorted.filter((s) => s.confidence >= askAt);
  const second = sorted[1];
  const tied = second !== undefined && best.confidence - second.confidence < thresholds.tieMargin;
  if (best.confidence >= routeAt && !(tied && second.confidence >= askAt)) {
    return { kind: "route", groupId: best.groupId, confidence: best.confidence };
  }
  if (best.confidence >= askAt) return { kind: "ask", candidates };
  return { kind: "none", best };
}
