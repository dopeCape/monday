// Pure triage rules: what a key acts on, where the focus goes afterwards, and
// how the multi-select grows. Testable without React (docs/spec/inbox.md).

import type { Settings } from "@monday/shared";

export type Direction = Settings["inbox.after_action.direction"];

/** The Threads an action applies to: the multi-select when there is one, else the focus row. */
export function targets(focus: string | null, selection: readonly string[]): string[] {
  if (selection.length > 0) return [...selection];
  return focus ? [focus] : [];
}

/**
 * The focus row after `removed` leave the list. Moves in the Setting's
 * direction, skipping other removed rows, then falls back the other way. A
 * focus that stays in the list keeps it.
 */
export function nextFocus(
  order: readonly string[],
  focus: string | null,
  removed: readonly string[],
  direction: Direction,
): string | null {
  if (focus === null) return null;
  const gone = new Set(removed);
  if (!gone.has(focus)) return focus;
  const i = order.indexOf(focus);
  if (i < 0) return null;
  const step = direction === "next" ? 1 : -1;
  const scan = (from: number, by: number): string | null => {
    for (let j = from; j >= 0 && j < order.length; j += by) {
      const id = order[j];
      if (id !== undefined && !gone.has(id)) return id;
    }
    return null;
  };
  return scan(i + step, step) ?? scan(i - step, -step);
}

/** The row `steps` away from the focus, clamped to the list. */
export function neighbor(
  order: readonly string[],
  focus: string | null,
  steps: number,
): string | null {
  if (order.length === 0) return null;
  const i = focus ? order.indexOf(focus) : -1;
  if (i < 0) return order[steps > 0 ? 0 : order.length - 1] ?? null;
  const j = Math.min(order.length - 1, Math.max(0, i + steps));
  return order[j] ?? null;
}

/** X: the focus row joins or leaves the multi-select. */
export function toggleSelected(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id];
}

/** Shift-J/K: the focus and the row it moves to are both selected; returns the new focus. */
export function extendSelection(
  order: readonly string[],
  selection: readonly string[],
  focus: string | null,
  steps: number,
): { selection: string[]; focus: string | null } {
  const next = neighbor(order, focus, steps);
  const out = [...selection];
  for (const id of [focus, next]) if (id && !out.includes(id)) out.push(id);
  return { selection: out, focus: next };
}

/** A batch above the Setting previews first (ADR 0002). */
export function needsPreview(count: number, above: number): boolean {
  return count > above;
}

/** Fills "{name}" holes in a string Setting. Missing names stay as written. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    return v === undefined ? m : String(v);
  });
}
