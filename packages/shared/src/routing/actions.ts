// Custom actions (CONTEXT.md "Custom action"; docs/spec/inbox.md, Reader):
// a button the user defined for the Threads of a Group or Section, or for
// Threads a judge statement holds: a label, a condition, and an ordinary
// tool call with its Tier (ADR 0002). Stored as the `actions.custom`
// Setting (ADR 0004); rendered in the reader toolbar after the built-in
// buttons and as a chip under the Brief; authored by the Agent from a
// sentence. Arguments may hold the Workflow templates ({{thread.subject}},
// {{thread.from}}, {{thread.id}}); the caller renders them with
// renderTemplate before the tool runs. Runtime-neutral.

import type { GroupId, Section, Thread } from "../domain.ts";
import type { SectionJudged } from "./sections.ts";
import { DEFAULT_SECTION_JUDGE_THRESHOLD } from "./sections.ts";

/** Where an action shows: on the Threads of a Group, of a Section, or where a judge statement holds. */
export interface CustomActionOn {
  /** A Group or Sub-group id or name. */
  group?: string | undefined;
  /** A Section id. */
  section?: Section | undefined;
  /** A Noul statement, asked per Thread through the Judge and cached like a Section's. */
  judge?: string | undefined;
}

/** One custom action as the `actions.custom` Setting stores it. */
export interface CustomActionSetting {
  id: string;
  label: string;
  on: CustomActionOn;
  /** The tool server's name: forward_thread, tag_threads, archive_threads, move_threads, snooze_threads, draft_message, trash_threads. */
  tool: string;
  /** The tool's arguments, minus the Thread; strings may hold templates. */
  args: Record<string, unknown>;
  /** "always-ask" promotes a reversible tool; the tool's own Tier is the floor and can never be lowered. */
  tier?: "always-ask" | undefined;
  createdBy?: "user" | "agent" | undefined;
}

/** What the matcher knows beyond the Thread row. */
export interface CustomActionFacts {
  /** Group id to name, so `on.group` may name a Group either way. */
  groupNames?: Readonly<Record<GroupId, string>> | undefined;
  /** Judged answers for this Thread by action id, from the same cache as the Sections'. */
  judged?: SectionJudged | undefined;
  judgeThreshold?: number | undefined;
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * Whether an action applies to a Thread: every condition set must hold. An
 * action with no condition applies everywhere. A judged condition without
 * an answer yet does not hold.
 */
export function customActionApplies(
  action: CustomActionSetting,
  thread: Pick<Thread, "group" | "subgroup" | "section">,
  facts: CustomActionFacts = {},
): boolean {
  const on = action.on;
  if (on.group) {
    const want = lower(on.group);
    const ids = [thread.group, thread.subgroup].filter((g): g is string => g !== null);
    const names = ids.map((id) => lower(facts.groupNames?.[id] ?? ""));
    if (!ids.some((id) => lower(id) === want) && !names.some((n) => n && n === want)) return false;
  }
  if (on.section && thread.section !== on.section) return false;
  if (on.judge?.trim()) {
    const p = facts.judged?.[action.id];
    if (p === undefined) return false;
    if (p < (facts.judgeThreshold ?? DEFAULT_SECTION_JUDGE_THRESHOLD)) return false;
  }
  return true;
}

/** The actions that apply to a Thread, in the Setting's order. */
export function customActionsFor(
  actions: readonly CustomActionSetting[],
  thread: Pick<Thread, "group" | "subgroup" | "section">,
  facts: CustomActionFacts = {},
): CustomActionSetting[] {
  return actions.filter((a) => customActionApplies(a, thread, facts));
}

/** An action id from its label: lowercase words joined by dashes, never one of `taken`. */
export function customActionIdFor(label: string, taken: readonly string[] = []): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "action";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}
