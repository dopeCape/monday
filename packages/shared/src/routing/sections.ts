// Section rules (CONTEXT.md "Section", "Section rule"): which Section of the
// stream a Thread sits under. A rule is a set of conditions over Thread state
// and Group, evaluated on the client over the Cache, so the stream never waits
// on the Server or a model (ADR 0004: the rules and their order are Settings;
// ADR 0011: the list never waits). A Section a model must judge names a
// sentence for the `section` Task. Since slice 25 (ADR 0012) a rule may also
// set judged conditions over the Thread's Judgments (needs a reply, waiting,
// newsletter, automated, urgency): when the Thread has been judged those
// decide in place of the header heuristics they stand in for, and a Thread
// not yet judged falls back to the header conditions, so the stream is right
// before the judge answers and better after.

import type { GroupId, Section, Thread } from "../domain.ts";
import type { ThreadJudgments } from "../judge.ts";

/**
 * The judged conditions: a bound on one of the Thread's Judgments. Every
 * `_at_least` and every `_at_most` is inclusive. The Noul bounds (needs a
 * reply, waiting, newsletter, automated) are probabilities from 0 to 1;
 * urgency is a Score position from 0 (no deadline) to 3 (right now).
 */
export interface JudgedWhen {
  needs_reply_at_least?: number | undefined;
  needs_reply_at_most?: number | undefined;
  waiting_at_least?: number | undefined;
  waiting_at_most?: number | undefined;
  newsletter_at_least?: number | undefined;
  newsletter_at_most?: number | undefined;
  automated_at_least?: number | undefined;
  automated_at_most?: number | undefined;
  urgency_at_least?: number | undefined;
  urgency_at_most?: number | undefined;
}

/** The judged keys, for splitting a rule into its judged and header halves. */
export const JUDGED_WHEN_KEYS: readonly (keyof JudgedWhen)[] = [
  "needs_reply_at_least",
  "needs_reply_at_most",
  "waiting_at_least",
  "waiting_at_most",
  "newsletter_at_least",
  "newsletter_at_most",
  "automated_at_least",
  "automated_at_most",
  "urgency_at_least",
  "urgency_at_most",
];

/**
 * The conditions a Section rule may set. Every set one must hold, with one
 * rule: when the Thread has been judged and the rule sets judged conditions,
 * those decide in place of `unread`, `bulk`, `minMessages` and `lastFrom`
 * (the header heuristics a Judgment replaces). `starred`, `hasAttachments`
 * and the Group conditions always apply.
 */
export interface SectionWhen extends JudgedWhen {
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

/** One Section rule as the `sections.rules` Setting stores it (the schema's sectionRuleShape). */
export interface SectionRuleSetting {
  id: Section;
  when: SectionWhen;
  /** A sentence for the `section` Task when the conditions are not enough; empty means model-free. */
  sentence?: string | undefined;
  hidden?: boolean | undefined;
}

/** What a judged condition reads: the Nouls and the urgency Score of a Thread's Judgments. */
export type SectionJudgments = Pick<
  ThreadJudgments,
  "needsReply" | "waitingOnOthers" | "newsletter" | "automated" | "urgency"
>;

/** What the evaluator knows about a Thread beyond its header row. */
export interface SectionFacts {
  /** The address of the newest Message's sender, lowercased, or null when the Cache has no Messages. */
  lastSender: string | null;
  /** The mailbox owner's address. */
  owner: string;
  /** Group id to name, so a rule may name a Group either way. */
  groupNames?: Readonly<Record<GroupId, string>>;
  /** The Thread's Judgments once the arrival request has run (slice 25); absent or null means not judged yet. */
  judgments?: SectionJudgments | null | undefined;
}

/** The probability at or above which a shipped Section trusts a Judgment; the `sections.rules` Setting carries it. */
export const DEFAULT_JUDGED_THRESHOLD = 0.6;

/**
 * The shipped defaults, matching the mock's four Sections in their order.
 * Each pairs a header rule (what decides before the judge answers) with a
 * judged condition (what decides once it has): Needs your reply is unread
 * mail someone else wrote last, or a Thread judged to need a reply; Waiting
 * is an ongoing exchange someone else wrote last, or one judged waiting;
 * Newsletters is list mail, or a Thread judged a newsletter; For your
 * information is the rest.
 */
export const DEFAULT_SECTION_RULES: SectionRuleSetting[] = [
  {
    id: "needs-reply",
    when: {
      lastFrom: "others",
      unread: true,
      bulk: false,
      needs_reply_at_least: DEFAULT_JUDGED_THRESHOLD,
    },
  },
  {
    id: "waiting",
    when: {
      lastFrom: "others",
      minMessages: 2,
      bulk: false,
      waiting_at_least: DEFAULT_JUDGED_THRESHOLD,
    },
  },
  { id: "newsletters", when: { bulk: true, newsletter_at_least: DEFAULT_JUDGED_THRESHOLD } },
  { id: "fyi", when: { bulk: false, newsletter_at_most: DEFAULT_JUDGED_THRESHOLD } },
];

const lower = (s: string) => s.trim().toLowerCase();

function inGroups(thread: Thread, wanted: readonly string[], facts: SectionFacts): boolean {
  const ids = [thread.group, thread.subgroup].filter((g): g is string => g !== null);
  const names = ids.map((id) => lower(facts.groupNames?.[id] ?? ""));
  const set = wanted.map(lower);
  return ids.some((id) => set.includes(lower(id))) || names.some((n) => n && set.includes(n));
}

/** Whether a rule sets any judged condition. */
export function hasJudgedWhen(when: SectionWhen): boolean {
  return JUDGED_WHEN_KEYS.some((k) => when[k] !== undefined);
}

/** Whether the judged conditions hold over a Thread's Judgments. A rule with no judged key always holds. */
export function judgedMatches(when: JudgedWhen, judgments: SectionJudgments): boolean {
  const within = (value: number, atLeast: number | undefined, atMost: number | undefined) =>
    (atLeast === undefined || value >= atLeast) && (atMost === undefined || value <= atMost);
  return (
    within(judgments.needsReply, when.needs_reply_at_least, when.needs_reply_at_most) &&
    within(judgments.waitingOnOthers, when.waiting_at_least, when.waiting_at_most) &&
    within(judgments.newsletter, when.newsletter_at_least, when.newsletter_at_most) &&
    within(judgments.automated, when.automated_at_least, when.automated_at_most) &&
    within(judgments.urgency, when.urgency_at_least, when.urgency_at_most)
  );
}

/**
 * Whether one rule's conditions hold for a Thread. An empty `when` always
 * matches. A judged Thread under a rule with judged conditions skips the
 * header heuristics those stand in for (see SectionWhen).
 */
export function sectionMatches(when: SectionWhen, thread: Thread, facts: SectionFacts): boolean {
  const judged = facts.judgments && hasJudgedWhen(when) ? facts.judgments : null;
  if (judged) {
    if (!judgedMatches(when, judged)) return false;
  } else {
    if (when.unread !== undefined && thread.unread !== when.unread) return false;
    if (when.bulk !== undefined && (thread.bulk ?? false) !== when.bulk) return false;
    if (when.minMessages !== undefined && thread.messageCount < when.minMessages) return false;
    if (when.lastFrom !== undefined) {
      if (facts.lastSender === null) return false;
      const mine = lower(facts.lastSender) === lower(facts.owner);
      if ((when.lastFrom === "me") !== mine) return false;
    }
  }
  if (when.starred !== undefined && thread.starred !== when.starred) return false;
  if (when.hasAttachments !== undefined && thread.hasAttachments !== when.hasAttachments) {
    return false;
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
