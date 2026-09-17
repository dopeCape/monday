// Section rules (CONTEXT.md "Section", "Section rule"): which Section of the
// stream a Thread sits under. A rule is a set of conditions over Thread state
// and Group, evaluated on the client over the Cache, so the stream never waits
// on the Server or a model (ADR 0004: the rules and their order are Settings;
// ADR 0011: the list never waits). A Section a model must judge names a
// sentence for the `section` Task; the shipped defaults are model-free.

import type { GroupId, Section, Thread } from "../domain.ts";

/** The deterministic conditions a Section rule may set. Every set one must hold. */
export interface SectionWhen {
  unread?: boolean;
  starred?: boolean;
  hasAttachments?: boolean;
  /** List mail (List-Id, List-Unsubscribe, Precedence bulk). */
  bulk?: boolean;
  /** At least this many Messages on the Thread. */
  minMessages?: number;
  /** Who wrote the newest Message: the mailbox owner or someone else. */
  lastFrom?: "me" | "others";
  /** The Thread's Group or Sub-group is one of these ids or names. */
  groups?: string[];
  /** The Thread's Group or Sub-group is none of these. */
  notGroups?: string[];
  /** The Thread has no Group at all. */
  ungrouped?: boolean;
}

/** One Section rule as the `sections.rules` Setting stores it. */
export interface SectionRuleSetting {
  id: Section;
  when: SectionWhen;
  /** A sentence for the `section` Task when the conditions are not enough; empty means model-free. */
  sentence?: string;
  hidden?: boolean;
}

/** What the evaluator knows about a Thread beyond its header row. */
export interface SectionFacts {
  /** The address of the newest Message's sender, lowercased, or null when the Cache has no Messages. */
  lastSender: string | null;
  /** The mailbox owner's address. */
  owner: string;
  /** Group id to name, so a rule may name a Group either way. */
  groupNames?: Readonly<Record<GroupId, string>>;
}

/** The shipped defaults, matching the mock's four Sections in their order. */
export const DEFAULT_SECTION_RULES: SectionRuleSetting[] = [
  { id: "needs-reply", when: { lastFrom: "others", unread: true, bulk: false } },
  { id: "waiting", when: { lastFrom: "others", minMessages: 2, bulk: false } },
  { id: "newsletters", when: { bulk: true } },
  { id: "fyi", when: { bulk: false } },
];

const lower = (s: string) => s.trim().toLowerCase();

function inGroups(thread: Thread, wanted: readonly string[], facts: SectionFacts): boolean {
  const ids = [thread.group, thread.subgroup].filter((g): g is string => g !== null);
  const names = ids.map((id) => lower(facts.groupNames?.[id] ?? ""));
  const set = wanted.map(lower);
  return ids.some((id) => set.includes(lower(id))) || names.some((n) => n && set.includes(n));
}

/** Whether one rule's conditions hold for a Thread. An empty `when` always matches. */
export function sectionMatches(when: SectionWhen, thread: Thread, facts: SectionFacts): boolean {
  if (when.unread !== undefined && thread.unread !== when.unread) return false;
  if (when.starred !== undefined && thread.starred !== when.starred) return false;
  if (when.hasAttachments !== undefined && thread.hasAttachments !== when.hasAttachments) {
    return false;
  }
  if (when.bulk !== undefined && (thread.bulk ?? false) !== when.bulk) return false;
  if (when.minMessages !== undefined && thread.messageCount < when.minMessages) return false;
  if (when.lastFrom !== undefined) {
    if (facts.lastSender === null) return false;
    const mine = lower(facts.lastSender) === lower(facts.owner);
    if ((when.lastFrom === "me") !== mine) return false;
  }
  if (when.groups?.length && !inGroups(thread, when.groups, facts)) return false;
  if (when.notGroups?.length && inGroups(thread, when.notGroups, facts)) return false;
  if (when.ungrouped !== undefined && (thread.group === null) !== when.ungrouped) return false;
  return true;
}

/**
 * The Section a Thread belongs to: the first rule, in `order`, whose
 * conditions hold. Rules not in `order` come after it; hidden rules still
 * claim their Threads (a hidden Section is not rendered, its Threads are not
 * shown elsewhere). Null when no rule matches.
 */
export function sectionOf(
  thread: Thread,
  facts: SectionFacts,
  rules: readonly SectionRuleSetting[],
  order: readonly Section[] = [],
): Section | null {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const seen = new Set<Section>();
  const ordered: SectionRuleSetting[] = [];
  for (const id of order) {
    const r = byId.get(id);
    if (r && !seen.has(id)) {
      ordered.push(r);
      seen.add(id);
    }
  }
  for (const r of rules) if (!seen.has(r.id)) ordered.push(r);
  for (const r of ordered) if (sectionMatches(r.when, thread, facts)) return r.id;
  return null;
}
