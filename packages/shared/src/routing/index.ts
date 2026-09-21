// Routing (docs/spec/inbox.md, ADR 0004): the Predicate matcher, the
// placement rule, the Section rules, and the shapes the /groups and /routing
// routes exchange with the client. Runtime-neutral.

import type {
  BriefPolicy,
  Confidence,
  GroupId,
  Id,
  IsoDate,
  Person,
  Predicate,
  Group as StoredGroup,
} from "../domain.ts";

export type {
  CustomActionFacts,
  CustomActionOn,
  CustomActionSetting,
  CustomActionTool,
} from "./actions.ts";
export {
  CUSTOM_ACTION_TOOLS,
  customActionApplies,
  customActionIdFor,
  customActionsFor,
  normalizeActionArgs,
} from "./actions.ts";
export type { PredicateFacts } from "./predicate.ts";
export {
  domainMatches,
  domainOf,
  isBulk,
  matchesPredicate,
  mergePredicates,
  predicateIsEmpty,
  subjectMatches,
} from "./predicate.ts";
export type {
  SectionCreatedBy,
  SectionFacts,
  SectionJudged,
  SectionPlacement,
  SectionRuleSetting,
  SectionWhen,
} from "./sections.ts";
export {
  DEFAULT_SECTION_JUDGE_THRESHOLD,
  DEFAULT_SECTION_RULES,
  orderedSectionRules,
  sectionIdFor,
  sectionInNav,
  sectionInStream,
  sectionLabel,
  sectionMatches,
  sectionOf,
  sectionRuleHolds,
  sectionsToJudge,
} from "./sections.ts";
export type { RoutePlacement, Score, Thresholds } from "./thresholds.ts";
export { clampConfidence, place } from "./thresholds.ts";

/* ------------------------------ Groups on the wire ------------------------------ */

/** What a client sends to make or change a Group. Everything but the name is optional. */
export interface GroupInput {
  name: string;
  parentId?: GroupId | null;
  /** The plain-language rule sentence; doubles as the model prompt until a correction revises it. */
  sentence?: string;
  predicate?: Predicate;
  threshold?: number | null;
  briefPolicy?: BriefPolicy | null;
}

/** An Example as the Routing page shows it: who and what, never the body. */
export interface GroupExample {
  threadId: Id;
  positive: boolean;
  from: Person | null;
  /** The plaintext subject prefix. */
  subject: string;
  at: IsoDate;
}

/** A Group with what the Routing page shows beside it. */
export interface GroupView extends StoredGroup {
  examples: GroupExample[];
  /** Threads routed here now. */
  threads: number;
  unread: number;
  /** The mean Confidence of the Threads routed here, or null when none was scored. */
  confidence: Confidence | null;
}

/* ------------------------------ Placement on the wire ------------------------------ */

/** How a Thread came to be where it is. */
export type RouteBy = "predicate" | "model" | "user";

/** The routing record for one Thread: where it went and how sure the rule was. */
export interface ThreadRoute {
  threadId: Id;
  groupId: GroupId | null;
  subgroupId: GroupId | null;
  confidence: Confidence | null;
  subgroupConfidence: Confidence | null;
  by: RouteBy;
  routedAt: IsoDate;
}

/** One candidate in Needs a decision. */
export interface DecisionCandidate {
  groupId: GroupId;
  confidence: Confidence;
}

/** A Thread in Needs a decision: the Groups it could join, best first. */
export interface RoutingDecision {
  threadId: Id;
  candidates: DecisionCandidate[];
  from: Person | null;
  subject: string;
  at: IsoDate;
}

/** What a re-run proposes for one Thread, before anything moves. */
export interface ProposedMove {
  threadId: Id;
  from: Person | null;
  subject: string;
  /** Where the Thread is now. */
  current: { groupId: GroupId | null; subgroupId: GroupId | null };
  /** Where routing would put it: a Group, Needs a decision, or nowhere. */
  proposed:
    | { kind: "route"; groupId: GroupId; subgroupId: GroupId | null; confidence: Confidence }
    | { kind: "ask"; candidates: DecisionCandidate[] }
    | { kind: "none" };
}

/** A dry run over the last N Threads (docs/spec/architecture.md: `/routing/rerun`). */
export interface RoutingPreview {
  workspaceId: Id;
  /** How many Threads were scored. */
  considered: number;
  /** Only the Threads whose placement would change. */
  moves: ProposedMove[];
  /** Hosted calls the dry run made. */
  calls: number;
}

/** What applying a preview did. */
export interface RoutingApplied {
  moved: number;
  asked: number;
}

/** A user moving a Thread between Groups, as the correction path sees it. */
export interface Correction {
  threadId: Id;
  /** Where routing had it; null when nowhere. */
  fromGroupId: GroupId | null;
  /** Where the user put it; null for out of every Group. */
  toGroupId: GroupId | null;
}

/** What a correction changed, for the caller and the test. */
export interface CorrectionResult {
  /** Examples written: positive on the target, negative on the source. */
  examples: Array<{ groupId: GroupId; positive: boolean }>;
  /** The Group whose Predicate the route Task revised, or null when nothing was revised. */
  revised: GroupId | null;
}
