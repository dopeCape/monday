// Section rules (CONTEXT.md "Section", "Section rule"): which Section of the
// stream a Thread sits under. A rule is a set of conditions over Thread state
// and Group, evaluated on the client over the Cache, so the stream never waits
// on the Server or a model (ADR 0004: the rules and their order are Settings;
// ADR 0011: the list never waits). A Section a model must judge names a
// sentence for the `section` Task; the shipped defaults are model-free.

import type { GroupId, Section, Thread } from "../domain.ts";

/** The deterministic conditions a Section rule may set. Every set one must hold. */
export interface SectionWhen {
  unread?: boolean | undefined;
  starred?: boolean | undefined;
  hasAttachments?: boolean | undefined;
  /** List mail (List-Id, List-Unsubscribe, Precedence bulk). */
  bulk?: boolean | undefined;
  /** At least this many Messages on the Thread. */
  minMessages?: number | undefined;
  /** Who wrote the newest Message: the mailbox owner or someone else. */
  lastFrom?: "me" | "others" | undefined;
  /** The Thread's Group or Sub-group is one of these ids or names. */
  groups?: string[] | undefined;
  /** The Thread's Group or Sub-group is none of these. */
  notGroups?: string[] | undefined;
  /** The Thread has no Group at all. */
  ungrouped?: boolean | undefined;
}

/** Where a Section shows: as a heading in the stream, as an entry in the nav, or both (CONTEXT.md "Section rule"). */
export type SectionPlacement = "stream" | "nav" | "both";

/** Who made a Section: the user or the Agent from a sentence, or monday's shipped defaults. */
export type SectionCreatedBy = "user" | "agent" | "shipped";

/** One Section rule as the `sections.rules` Setting stores it (the schema's sectionRuleShape). */
export interface SectionRuleSetting {
  id: Section;
  when: SectionWhen;
  /** The heading and nav label; absent, the strings.section.<id> Setting or the id names it. */
  name?: string | undefined;
  /** The user's own words for the Section ("invoices I still owe"). */
  sentence?: string | undefined;
  /**
   * A Noul statement the Section holds when the deterministic conditions do
   * not decide alone (ADR 0012): asked per Thread through the Judge and
   * cached. Absent means the conditions decide by themselves.
   */
  judge?: string | undefined;
  /** Default `stream`. */
  placement?: SectionPlacement | undefined;
  /** A position among rules not listed in `sections.order`; lower first. */
  order?: number | undefined;
  createdBy?: SectionCreatedBy | undefined;
  hidden?: boolean | undefined;
}

/** The probability, per Section id, that a Thread holds the Section's judge statement. */
export type SectionJudged = Readonly<Record<Section, number>>;

/** What the evaluator knows about a Thread beyond its header row. */
export interface SectionFacts {
  /** The address of the newest Message's sender, lowercased, or null when the Cache has no Messages. */
  lastSender: string | null;
  /** The mailbox owner's address. */
  owner: string;
  /** Group id to name, so a rule may name a Group either way. */
  groupNames?: Readonly<Record<GroupId, string>>;
  /** The judged answers for this Thread, by Section id; a judged rule without one does not decide. */
  judged?: SectionJudged | undefined;
  /** The probability at or above which a judge statement holds (the sections.judge_threshold Setting). */
  judgeThreshold?: number | undefined;
}

/** The shipped defaults, matching the mock's four Sections in their order: rows like any other. */
export const DEFAULT_SECTION_RULES: SectionRuleSetting[] = [
  {
    id: "needs-reply",
    when: { lastFrom: "others", unread: true, bulk: false },
    placement: "stream",
    createdBy: "shipped",
  },
  {
    id: "waiting",
    when: { lastFrom: "others", minMessages: 2, bulk: false },
    placement: "stream",
    createdBy: "shipped",
  },
  { id: "newsletters", when: { bulk: true }, placement: "stream", createdBy: "shipped" },
  { id: "fyi", when: { bulk: false }, placement: "stream", createdBy: "shipped" },
];

/** The judge threshold when a caller passes none; the Setting sections.judge_threshold is the real default. */
export const DEFAULT_SECTION_JUDGE_THRESHOLD = 0.7;

/** Whether a Section shows as a heading in the stream. */
export function sectionInStream(rule: SectionRuleSetting): boolean {
  return (rule.placement ?? "stream") !== "nav";
}

/** Whether a Section shows as an entry in the nav. */
export function sectionInNav(rule: SectionRuleSetting): boolean {
  return rule.placement === "nav" || rule.placement === "both";
}

/**
 * The rules in effect order: those in `order` first, in that order, then
 * the rest by their `order` number (stable). A rule the Agent just appended
 * to `sections.rules` therefore renders before `sections.order` names it.
 */
export function orderedSectionRules(
  rules: readonly SectionRuleSetting[],
  order: readonly Section[] = [],
): SectionRuleSetting[] {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const seen = new Set<Section>();
  const out: SectionRuleSetting[] = [];
  for (const id of order) {
    const r = byId.get(id);
    if (r && !seen.has(id)) {
      out.push(r);
      seen.add(id);
    }
  }
  const rank = (r: SectionRuleSetting) => r.order ?? Number.MAX_SAFE_INTEGER;
  const rest = rules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !seen.has(r.id))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map(({ r }) => r);
  return [...out, ...rest];
}

/** A Section's label: its own name, else the caller's string Setting, else the id in words ("needs-reply" is "Needs reply"). */
export function sectionLabel(rule: SectionRuleSetting, fromStrings?: string | undefined): string {
  if (rule.name?.trim()) return rule.name.trim();
  if (fromStrings) return fromStrings;
  const words = rule.id.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A Section id from a name: lowercase words joined by dashes, never one of `taken`. */
export function sectionIdFor(name: string, taken: readonly Section[] = []): Section {
  const base =
    name
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "section";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

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
 * Whether one rule claims a Thread: its conditions hold and, when it carries
 * a judge statement, the Thread's judged answer is at or above the threshold.
 * A judged rule with no answer yet does not decide, so the Thread falls
 * through to the next rule until the Judge has spoken.
 */
export function sectionRuleHolds(
  rule: SectionRuleSetting,
  thread: Thread,
  facts: SectionFacts,
): boolean {
  if (!sectionMatches(rule.when, thread, facts)) return false;
  if (!rule.judge?.trim()) return true;
  const p = facts.judged?.[rule.id];
  if (p === undefined) return false;
  return p >= (facts.judgeThreshold ?? DEFAULT_SECTION_JUDGE_THRESHOLD);
}

/**
 * The Section a Thread belongs to: the first rule, in `order`, that holds.
 * Rules not in `order` come after it; hidden rules still claim their
 * Threads (a hidden Section is not rendered, its Threads are not shown
 * elsewhere), and so does a Section placed only in the nav. Null when no
 * rule matches.
 */
export function sectionOf(
  thread: Thread,
  facts: SectionFacts,
  rules: readonly SectionRuleSetting[],
  order: readonly Section[] = [],
): Section | null {
  for (const r of orderedSectionRules(rules, order)) {
    if (sectionRuleHolds(r, thread, facts)) return r.id;
  }
  return null;
}

/**
 * The judged rules whose answer a Thread still needs: every judged rule the
 * conditions let through, up to the first rule that decides the Thread on
 * its own. Empty when the Thread's Section is settled without the Judge.
 */
export function sectionsToJudge(
  thread: Thread,
  facts: SectionFacts,
  rules: readonly SectionRuleSetting[],
  order: readonly Section[] = [],
): Section[] {
  const out: Section[] = [];
  const threshold = facts.judgeThreshold ?? DEFAULT_SECTION_JUDGE_THRESHOLD;
  for (const r of orderedSectionRules(rules, order)) {
    if (!sectionMatches(r.when, thread, facts)) continue;
    if (!r.judge?.trim()) break;
    const p = facts.judged?.[r.id];
    if (p === undefined) out.push(r.id);
    else if (p >= threshold) break;
  }
  return out;
}
