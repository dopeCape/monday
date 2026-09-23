// Holds each row in the Section it was first rendered in, so a Thread never
// jumps Sections while the user looks at it: opening it reads it, a Judgment
// lands, a rule is reworded, and the row stays where it was, only its look
// changes. The stream is rebuilt, and every row takes the Section its rules
// give it now, when the scope changes (another lens, other Section rules, a
// fresh mount after navigating away) or a Thread the stream has not held
// before arrives (a new pull). Even then the rows under the cursor (the
// focused and open Thread, the multi-select) keep their place until the next
// rebuild. Removals are not holds: a Thread archived, snoozed or deleted
// leaves the list, and its held Section is remembered so an undo puts it back
// where it was.

import type { Section, Thread } from "@monday/shared";
import { useMemo, useRef } from "react";

/** The Section each Thread was rendered in, for one scope. */
export interface HeldSections {
  scope: readonly unknown[];
  sections: Map<string, Section | null>;
}

const sameScope = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * The Threads with their held Sections. Mutates `held`: a Thread seen for the
 * first time is held where it is, and a new arrival (or a changed scope)
 * releases every hold but those in `keep`. Returns `threads` itself when no
 * hold differs from the Thread's own Section, so identity-keyed memos stay put.
 */
export function holdSections(
  threads: readonly Thread[],
  held: HeldSections,
  scope: readonly unknown[],
  keep: ReadonlySet<string>,
): readonly Thread[] {
  const rebuild = !sameScope(held.scope, scope) || threads.some((t) => !held.sections.has(t.id));
  if (rebuild) {
    held.scope = scope;
    for (const id of [...held.sections.keys()]) if (!keep.has(id)) held.sections.delete(id);
  }
  let moved = false;
  const out = threads.map((t) => {
    if (!held.sections.has(t.id)) {
      held.sections.set(t.id, t.section);
      return t;
    }
    const section = held.sections.get(t.id) ?? null;
    if (section === t.section) return t;
    moved = true;
    return { ...t, section };
  });
  return moved ? out : threads;
}

/**
 * The hook over holdSections for one mounted stream. `scope` lists what
 * rebuilds it (the Inbox seam, the lens, the Section rules and order);
 * `keep` is read at rebuild time, so a focus change alone does not recompute.
 */
export function useHeldSections(
  threads: readonly Thread[],
  scope: readonly unknown[],
  keep: () => ReadonlySet<string>,
): readonly Thread[] {
  const held = useRef<HeldSections>({ scope, sections: new Map() });
  const keepRef = useRef(keep);
  keepRef.current = keep;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scope's items are the dependencies
  return useMemo(
    () => holdSections(threads, held.current, scope, keepRef.current()),
    [threads, ...scope],
  );
}
