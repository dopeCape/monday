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
// before the judge answers and better after. Since slice 26 a rule may also
// carry its own `judge` statement, a Noul the Judge answers per Thread through
// the Server's section_judgments cache; it decides last, after `when` and the
// arrival Judgments have let the Thread through (see sectionRuleHolds).

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

/** What a judged condition reads: the Nouls and the urgency Score of a Thread's Judgments. */
export type SectionJudgments = Pick<
  ThreadJudgments,
  "needsReply" | "waitingOnOthers" | "newsletter" | "automated" | "urgency"
>;

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
  // Two kinds of judged facts, from two slices, read at two points of the
  // evaluation. `judgments` (slice 25) are the Thread's arrival Judgments
  // from `thread_judgments`: the `_at_least` and `_at_most` bounds in `when`
  // read them, at no extra request. `judged` (slice 26) are the answers to
  // each rule's own `judge` statement, from the Server's `section_judgments`
  // cache, keyed by Section id; `sectionRuleHolds` reads them after `when`
  // has let the Thread through.
  /** The Thread's Judgments once the arrival request has run (slice 25); absent or null means not judged yet. */
  judgments?: SectionJudgments | null | undefined;
  /** The judged answers for this Thread, by Section id (slice 26); a judged rule without one does not decide. */
  judged?: SectionJudged | undefined;
  /** The probability at or above which a judge statement holds (the sections.judge_threshold Setting). */
  judgeThreshold?: number | undefined;
}

/** The probability at or above which a shipped Section trusts an arrival Judgment; the `sections.rules` Setting carries it. */
export const DEFAULT_JUDGED_THRESHOLD = 0.6;

/**
 * The shipped defaults, matching the mock's four Sections in their order:
 * rows like any other, placed in the stream. Each pairs a header rule (what
 * decides before the judge answers) with a judged condition (what decides
 * once it has): Needs your reply is mail someone else wrote last, read or
 * not (reading a Thread does not answer it), or a Thread judged to need a
 * reply; Waiting is an ongoing exchange someone
 * else wrote last, or one judged waiting; Newsletters is list mail, or a
 * Thread judged a newsletter; For your information is the rest.
 */
export const DEFAULT_SECTION_RULES: SectionRuleSetting[] = [
  {
    id: "needs-reply",
    when: {
      lastFrom: "others",
      bulk: false,
      needs_reply_at_least: DEFAULT_JUDGED_THRESHOLD,
    },
    placement: "stream",
    createdBy: "shipped",
  },
  {
    id: "waiting",
    when: {
      lastFrom: "others",
      minMessages: 2,
      bulk: false,
      waiting_at_least: DEFAULT_JUDGED_THRESHOLD,
    },
    placement: "stream",
    createdBy: "shipped",
  },
  {
    id: "newsletters",
    when: { bulk: true, newsletter_at_least: DEFAULT_JUDGED_THRESHOLD },
    placement: "stream",
    createdBy: "shipped",
  },
  {
    id: "fyi",
    when: { bulk: false, newsletter_at_most: DEFAULT_JUDGED_THRESHOLD },
    placement: "stream",
    createdBy: "shipped",
  },
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
 * Whether one rule claims a Thread, in this order: the deterministic `when`
 * conditions, then the judged bounds in `when` read from the arrival
 * Judgments when the Thread has them (`sectionMatches` does both), then the
 * rule's own `judge` statement when the Section cache has an answer, which
 * must be at or above the threshold. A judged rule with no answer yet does
 * not decide, so the Thread falls through to the next rule until the Judge
 * has spoken.
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
