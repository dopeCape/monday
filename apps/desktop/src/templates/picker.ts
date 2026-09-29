// The picker's pure parts (docs/spec/templates.md, "The picker"): where a
// typed trigger starts and what it asks for, and the library filtered by
// name and fits-when as the user types.

import type { Template } from "@monday/shared";
import type { EditorState } from "@tiptap/pm/state";

/** The typed trigger at the start of the caret's line: the range it covers and the query after it. */
export interface TriggerAt {
  from: number;
  to: number;
  query: string;
}

/** The longest query the picker follows before it lets go of the line. */
export const QUERY_MAX = 60;

export function triggerAt(state: EditorState, trigger: string): TriggerAt | null {
  if (!trigger) return null;
  const sel = state.selection;
  if (!sel.empty) return null;
  const $from = sel.$from;
  if (!$from.parent.isTextblock) return null;
  // Every non-text leaf (a break, a chip) ends a line for this purpose.
  const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if (!line.startsWith(trigger)) return null;
  const query = line.slice(trigger.length);
  if (query.length > QUERY_MAX) return null;
  return { from: $from.pos - line.length, to: $from.pos, query };
}

/**
 * The library filtered by every word of the query against the name and the
 * fits-when: the Workspace's own Templates, then the built-ins, and within
 * each a Template whose name matches before one that matches only by its
 * fits-when, each keeping the library's order.
 */
export function filterTemplates(library: readonly Template[], query: string): Template[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: Template[][] = [[], [], [], []];
  for (const t of library) {
    const name = t.name.toLowerCase();
    const all = `${name} ${t.fitsWhen.toLowerCase()}`;
    if (!words.every((w) => all.includes(w))) continue;
    const builtin = t.workspaceId === null ? 2 : 0;
    const fit = words.every((w) => name.includes(w)) ? 0 : 1;
    groups[builtin + fit]?.push(t);
  }
  return groups.flat();
}
