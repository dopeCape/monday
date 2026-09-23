// Tuning the judgments from the user's feedback (ADR 0012, ADR 0004;
// CONTEXT.md "Judgment", "Example", "Confidence", "Needs a decision";
// docs/spec/agent-composer.md "Organizing mail by talking"). Every question
// monday asks the Judge is a Setting, so the Agent can reword it; this module
// is what lets it do that with evidence instead of guesses:
//
// - explain: why one Thread is where it is. Its Group and how routing got
//   there (the stored distribution, the threshold and ask band it crossed,
//   a Predicate or Examples, or the user's own placement), its arrival
//   Judgments, and the Section rule that claims it with the judged value
//   that decided.
// - list: every judgment monday asks, grouped by what asks it, with its
//   Setting key, current wording or threshold, the default, and how it has
//   been answering over the window (tune.window_days) from the stored data.
// - test: a proposed wording or threshold re-asked beside the current one on
//   the newest matching Threads (tune.sample), one request per Thread per
//   version, with the state builders the judgments themselves use, and the
//   Threads whose answer or placement would change. Nothing is stored; the
//   requests are metered like any other.
//
// The tools in agent/tools/tune.ts write the change through the ToolHost
// like change_setting, so pinning, validation and Undo stay theirs.

import type {
  BriefPolicy,
  ChipName,
  GroupId,
  Id,
  JsonValue,
  Predicate,
  RouteBy,
  SectionFacts,
  SectionJudgments,
  SectionRuleSetting,
  SectionWhen,
  SettingKey,
  Settings,
  Thread,
  ThreadJudgments,
} from "@monday/shared";
import {
  CHIP_NAMES,
  domainOf,
  hasJudgedWhen,
  matchesPredicate,
  orderedSectionRules,
  sectionLabel,
  sectionMatches,
  sectionOf,
  sectionRuleHolds,
  settingsSchema,
  validateSetting,
} from "@monday/shared";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  examples,
  groups,
  messages,
  meter,
  routingDecisions,
  sectionJudgments,
  threadJudgments,
  threadRoutes,
  threads as threadsTable,
} from "../db/schema.ts";
import { type Mailstore, NotFoundError } from "../mailstore/index.ts";
import { readGlobalSettings } from "../settings/read.ts";
import {
  type JudgmentQuestionSettings,
  type Judgments,
  judgmentQuestions,
  judgmentState,
  readJudgments,
} from "./judgments.ts";
import {
  type OrganizeSeam,
  type SectionContext,
  type SectionExample,
  sectionQuestion,
} from "./organize.ts";
import { judgedPolicy } from "./policy.ts";
import type { Routing, RoutingOverride, Scored } from "./routing/index.ts";
import { AiOffError, type HostedRuntime, NoJudgeError } from "./runtime/index.ts";

/* ------------------------------ The registry ------------------------------ */

/** What asks a judgment, as list_judgments groups them. */
export type JudgmentFamily =
  | "routing"
  | "arrival"
  | "sections"
  | "palette"
  | "guard"
  | "verification"
  | "brief_policy"
  | "workflows";

export const FAMILY_LABELS: Readonly<Record<JudgmentFamily, string>> = {
  routing: "Routing into Groups",
  arrival: "Judgments on arrival",
  sections: "Section judge statements",
  palette: "The palette's typed sentences",
  guard: "Screening thread text",
  verification: "Brief verification",
  brief_policy: "Brief policy",
  workflows: "Workflow conditions",
};

/** What part of a judgment a Setting holds. */
export type JudgmentKind =
  | "question"
  | "option"
  | "levels"
  | "criteria"
  | "threshold"
  | "statement"
  | "group_rule";

/** How a test re-runs a judgment: by asking the Judge again, or over stored answers. */
export type TestPath =
  | "routing"
  | "arrival"
  | "section"
  | "stored_chips"
  | "stored_sections"
  | "stored_policy";

export interface JudgmentEntry {
  family: JudgmentFamily;
  /** The Setting key; "sections.rules" for a Section's statement, "" for a Group's rule. */
  key: string;
  /** The Section id, for a Section's statement. */
  section?: string | undefined;
  /** The Group id, for a Group's rule. */
  group?: string | undefined;
  /** How to name it to a tool: the key, "sections.rules[<id>].judge" or "group:<id>". */
  ref: string;
  label: string;
  kind: JudgmentKind;
  /** The judgment type the Judge answers. */
  question?: "choice" | "noul" | "score" | undefined;
  /** The threshold Setting that decides with this question's answer, when it has one. */
  threshold?: SettingKey | undefined;
  test: TestPath | null;
  /** Why test_judgment cannot re-run it on Threads. */
  untestable?: string | undefined;
  /** The tool that changes it, when it is not update_judgment. */
  editWith?: string | undefined;
}

/** The arrival questions by Setting key: the question id the request asks and the field it fills. */
const ARRIVAL: Record<
  string,
  { id: string; field: keyof ThreadJudgments | `chip:${ChipName}`; type: "noul" | "score" }
> = {
  "judgments.questions.needs_reply": { id: "needs_reply", field: "needsReply", type: "noul" },
  "judgments.questions.waiting_on_others": {
    id: "waiting_on_others",
    field: "waitingOnOthers",
    type: "noul",
  },
  "judgments.questions.newsletter": { id: "newsletter", field: "newsletter", type: "noul" },
  "judgments.questions.automated": { id: "automated", field: "automated", type: "noul" },
  "judgments.questions.brief_worth": { id: "brief_worth", field: "briefWorth", type: "score" },
  "judgments.questions.brief_worth_levels": {
    id: "brief_worth",
    field: "briefWorth",
    type: "score",
  },
  "judgments.questions.urgency": { id: "urgency", field: "urgency", type: "score" },
  "judgments.questions.urgency_levels": { id: "urgency", field: "urgency", type: "score" },
  ...Object.fromEntries(
    CHIP_NAMES.map((chip) => [
      `judgments.questions.chip.${chip}`,
      { id: `chip_${chip}`, field: `chip:${chip}` as const, type: "noul" as const },
    ]),
  ),
};

const label = (key: string): string =>
  (settingsSchema as Record<string, { label: string } | undefined>)[key]?.label ?? key;

const NOT_ON_THREADS = {
  palette:
    "It reads a sentence typed into the palette, not a Thread, so there are no recent Threads to test it on.",
  guard:
    "It screens message text as it enters a turn and keeps no answers, so there is nothing to compare against; test it by reading a thread.",
  verification:
    "It checks a Brief's bullets against the Thread text as the Brief is written; nothing to re-run on stored Threads.",
  workflows:
    "It decides a Workflow condition while a Run runs; dry_run_workflow shows what a Workflow would do.",
};

function staticEntries(): JudgmentEntry[] {
  const entry = (
    family: JudgmentFamily,
    key: SettingKey,
    kind: JudgmentKind,
    more: Partial<JudgmentEntry> = {},
  ): JudgmentEntry => ({
    family,
    key,
    ref: key,
    label: label(key),
    kind,
    test: null,
    ...more,
  });
  const arrival = Object.entries(ARRIVAL).map(([key, a]) =>
    entry("arrival", key as SettingKey, key.endsWith("_levels") ? "levels" : "question", {
      question: a.type,
      test: "arrival",
      ...(a.field.startsWith("chip:") ? { threshold: "chips.threshold" as const } : {}),
    }),
  );
  const intentKeys = Object.keys(settingsSchema).filter((k) =>
    k.startsWith("intent.question."),
  ) as SettingKey[];
  return [
    entry("routing", "routing.judge.instructions", "question", {
      question: "choice",
      threshold: "routing.threshold.route",
      test: "routing",
    }),
    entry("routing", "routing.judge.none_option", "option", {
      question: "choice",
      threshold: "routing.threshold.route",
      test: "routing",
    }),
    entry("routing", "routing.threshold.route", "threshold", { test: "routing" }),
    entry("routing", "routing.threshold.ask", "threshold", { test: "routing" }),
    entry("routing", "routing.threshold.tie_margin", "threshold", { test: "routing" }),
    ...arrival,
    entry("arrival", "chips.threshold", "threshold", { test: "stored_chips" }),
    entry("sections", "sections.judge_threshold", "threshold", { test: "stored_sections" }),
    ...intentKeys.map((k) =>
      entry("palette", k, "question", {
        question: k === "intent.question.scope" ? "noul" : "choice",
        threshold: "intent.act_above",
        untestable: NOT_ON_THREADS.palette,
      }),
    ),
    entry("palette", "intent.criteria.intent", "criteria", {
      question: "choice",
      untestable: NOT_ON_THREADS.palette,
      editWith: "change_setting",
    }),
    entry("palette", "intent.act_above", "threshold", { untestable: NOT_ON_THREADS.palette }),
    entry("palette", "intent.ask_below", "threshold", { untestable: NOT_ON_THREADS.palette }),
    entry("guard", "guard.question", "question", {
      question: "noul",
      threshold: "guard.threshold",
      untestable: NOT_ON_THREADS.guard,
    }),
    entry("guard", "guard.threshold", "threshold", { untestable: NOT_ON_THREADS.guard }),
    entry("verification", "briefs.verify.question", "question", {
      question: "choice",
      threshold: "briefs.verify.confidence",
      untestable: NOT_ON_THREADS.verification,
    }),
    entry("verification", "briefs.verify.criteria", "criteria", {
      question: "choice",
      untestable: NOT_ON_THREADS.verification,
      editWith: "change_setting",
    }),
    entry("verification", "briefs.verify.confidence", "threshold", {
      untestable: NOT_ON_THREADS.verification,
    }),
    entry("brief_policy", "briefs.judge.always_at_least", "threshold", { test: "stored_policy" }),
    entry("brief_policy", "briefs.judge.never_below", "threshold", { test: "stored_policy" }),
    entry("brief_policy", "briefs.judge.newsletter_at_least", "threshold", {
      test: "stored_policy",
    }),
    entry("workflows", "workflows.judged.question", "question", {
      question: "noul",
      threshold: "workflows.judged.threshold",
      untestable: NOT_ON_THREADS.workflows,
    }),
    entry("workflows", "workflows.judged.threshold", "threshold", {
      untestable: NOT_ON_THREADS.workflows,
    }),
  ];
}

/** The ref of a Section's judge statement. */
export const sectionRef = (id: string) => `sections.rules[${id}].judge`;

function sectionEntry(rule: SectionRuleSetting): JudgmentEntry {
  return {
    family: "sections",
    key: "sections.rules",
    section: rule.id,
    ref: sectionRef(rule.id),
    label: `Section "${sectionLabel(rule)}"`,
    kind: "statement",
    question: "noul",
    threshold: "sections.judge_threshold",
    test: "section",
  };
}

/* ------------------------------ Shapes ------------------------------ */

export interface TuneSettings {
  sample: number;
  scan: number;
  windowDays: number;
  uncertainBand: number;
  changesMax: number;
}

/** What a test or an update proposes: a new wording, new levels, a new threshold, or both. */
export interface JudgmentProposal {
  /** A Setting key, "sections.rules[<id>].judge", or "sections.rules" with `section`. */
  key: string;
  section?: string | undefined;
  text?: string | undefined;
  levels?: string[] | undefined;
  threshold?: number | undefined;
}

/** The Setting writes a proposal comes to, validated, with the values they replace. */
export interface ProposalPlan {
  entry: JudgmentEntry;
  writes: Array<{ key: SettingKey; value: unknown; previous: unknown }>;
  before: ProposalSide;
  after: ProposalSide;
}

export interface ProposalSide {
  text?: string | null | undefined;
  levels?: string[] | undefined;
  threshold?: { key: string; value: number } | undefined;
}

/** One Thread's answer and its consequence, before or after. */
export interface Outcome {
  /** The probability (a Noul), the position (a Score) or the chosen option (a Choice); null when not asked. */
  answer: number | string | null;
  /** A Choice's distribution by option name. */
  probabilities?: Record<string, number> | undefined;
  /** Where the answer puts the Thread: a Group, Needs a decision, a Section, a brief policy, the chips shown. */
  placement: string;
}

export interface ThreadChange {
  threadId: Id;
  subject: string;
  from: string | null;
  before: Outcome;
  after: Outcome;
}

export interface JudgmentTest {
  ref: string;
  key: string;
  section?: string | undefined;
  label: string;
  before: ProposalSide;
  after: ProposalSide;
  /** Whether the judge was asked; false for a test over stored answers. */
  asked: boolean;
  considered: number;
  /** Threads left out: placed by the user, or with no stored answer to re-threshold. */
  skipped: number;
  requests: number;
  costMicros: number;
  /** Threads whose placement would change. */
  moved: number;
  /** Threads whose answer would change side (yes to no, another option, another level) without moving. */
  flipped: number;
  /** "from -> to" to how many Threads. */
  moves: Record<string, number>;
  changes: ThreadChange[];
  /** Changes beyond the ones listed. */
  more: number;
  summary: string;
}

/** Why a test could not run. */
export class TuneRefusal extends Error {
  constructor(
    message: string,
    readonly reason: "unknown" | "untestable" | "invalid" | "no_judge",
  ) {
    super(message);
    this.name = "TuneRefusal";
  }
}

export interface PlacementExplanation {
  thread: { id: Id; subject: string; from: string | null; lastActivity: string };
  userPlaced: boolean;
  group: { id: GroupId; name: string } | null;
  subgroup: { id: GroupId; name: string } | null;
  routing: {
    by: RouteBy;
    routedAt: string;
    confidence: number | null;
    distribution: Array<{ groupId: GroupId; name: string; probability: number }>;
    thresholds: { route: number; ask: number; tieMargin: number; groupRoute: number | null };
    band: "route" | "ask" | "below" | null;
  } | null;
  needsDecision: {
    candidates: Array<{ groupId: GroupId; name: string; confidence: number }>;
    at: string;
  } | null;
  /** Groups whose Predicate matches the Thread's headers. */
  predicates: Array<{ groupId: GroupId; name: string; predicate: Predicate }>;
  examples: {
    /** This Thread as an Example. */
    thread: Array<{ groupId: GroupId; name: string; positive: boolean; at: string }>;
    /** Examples from the same sender or domain, which the routing Choice reads. */
    similar: Array<{
      groupId: GroupId;
      name: string;
      positive: boolean;
      from: string | null;
      subject: string;
    }>;
  };
  judgments: (Omit<ThreadJudgments, "threadId"> & { fresh: boolean }) | null;
  section: { id: string; name: string } | null;
  /** Each Section rule in order up to the one that claims the Thread. */
  sections: Array<{
    id: string;
    name: string;
    holds: boolean;
    conditions: boolean;
    /** The judged bounds that decided in place of the header conditions, as "needs_reply 0.9 >= 0.6". */
    judgedBounds: string[];
    judge: {
      statement: string;
      probability: number | null;
      threshold: number;
    } | null;
  }>;
  /** Plain sentences a card and the model can read as they are. */
  why: string[];
}

export interface ListedJudgment {
  ref: string;
  key: string;
  section?: string | undefined;
  group?: string | undefined;
  label: string;
  kind: JudgmentKind;
  question?: "choice" | "noul" | "score" | undefined;
  value: unknown;
  default: unknown;
  isDefault: boolean;
  threshold?: { key: string; value: unknown; default: unknown } | undefined;
  testable: boolean;
  untestable?: string | undefined;
  editWith: string;
  behavior: JudgmentBehavior | null;
}

export interface JudgmentBehavior {
  /** Threads (or requests, for judgments that keep no answers) over the window. */
  answered: number;
  /** Answers by side, option or level. */
  distribution: Record<string, number>;
  /** How many went to Needs a decision (routing) or were unsure (a Noul near 0.5). */
  undecided: number | null;
  /** The user's corrections over the window, where monday records them. */
  corrections: { examples: number; userPlacements: number; contradicting: number | null } | null;
  note?: string | undefined;
}

export interface JudgmentListing {
  windowDays: number;
  since: string;
  judge: boolean;
  families: Array<{ family: JudgmentFamily; label: string; judgments: ListedJudgment[] }>;
}

export interface TuneSeam {
  settings(): Promise<TuneSettings>;
  judgeAvailable(): Promise<boolean>;
  /** The judgments as they stand, Section statements and Group rules included. */
  entries(workspaceId: Id): Promise<JudgmentEntry[]>;
  /** The entry a proposal names, or null. */
  resolve(
    workspaceId: Id,
    ref: { key: string; section?: string | undefined },
  ): Promise<JudgmentEntry | null>;
  /** The Setting writes a proposal comes to, validated. Throws TuneRefusal. */
  plan(workspaceId: Id, proposal: JudgmentProposal): Promise<ProposalPlan>;
  explain(workspaceId: Id, threadId: Id): Promise<PlacementExplanation>;
  list(workspaceId: Id): Promise<JudgmentListing>;
  /** Re-runs a judgment beside the proposal. Throws TuneRefusal (no judge, untestable, invalid). */
  test(workspaceId: Id, proposal: JudgmentProposal, sample?: number): Promise<JudgmentTest>;
  /** The last test of this proposal in a Session, for the update card. */
  remembered(sessionId: string, workspaceId: Id, proposal: JudgmentProposal): JudgmentTest | null;
  remember(
    sessionId: string,
    workspaceId: Id,
    proposal: JudgmentProposal,
    test: JudgmentTest,
  ): void;
  /** A Group by id or name. */
  findGroup(workspaceId: Id, ref: string): Promise<{ id: GroupId; name: string } | null>;
  /** A Section by id or name, with the Examples it has. */
  findSection(
    ref: string,
  ): Promise<{ rule: SectionRuleSetting; examples: Record<string, SectionExample[]> } | null>;
  recordExample: Routing["recordExample"];
  restoreExample: Routing["restoreExample"];
  /** The owner's own answer for a Section's statement on one Thread (after its Examples change). */
  pinSectionAnswer(workspaceId: Id, threadId: Id, sectionId: string, holds: boolean): Promise<void>;
  /** What an Example shows of a Thread: its newest sender and plaintext subject prefix. */
  exampleFacts(threadId: Id): Promise<{ from: string | null; subject: string } | null>;
}

export interface TuneOptions {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  routing: Routing;
  judgments: Judgments;
  organize: OrganizeSeam;
  now?: () => Date;
}

const TUNE_KEYS = [
  "tune.sample",
  "tune.scan",
  "tune.window_days",
  "tune.uncertain_band",
  "tune.changes_max",
] as const;

const POLICY_KEYS = [
  "briefs.judge.always_at_least",
  "briefs.judge.never_below",
  "briefs.judge.newsletter_at_least",
] as const;

const ROUTING_KEYS = [
  "routing.threshold.route",
  "routing.threshold.ask",
  "routing.threshold.tie_margin",
  "routing.judge.instructions",
  "routing.judge.none_option",
  "routing.default_group",
  "routing.examples_in_prompt",
] as const;

const round = (n: number) => Math.round(n * 1000) / 1000;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The arrival question settings with one key replaced. */
function withArrivalChange(
  q: JudgmentQuestionSettings,
  key: string,
  value: unknown,
): JudgmentQuestionSettings {
  const next: JudgmentQuestionSettings = { ...q, chips: { ...q.chips } };
  const tail = key.slice("judgments.questions.".length);
  if (tail.startsWith("chip.")) {
    next.chips[tail.slice(5) as ChipName] = value as string;
    return next;
  }
  const fields: Record<string, keyof JudgmentQuestionSettings> = {
    needs_reply: "needsReply",
    waiting_on_others: "waitingOnOthers",
    newsletter: "newsletter",
    automated: "automated",
    brief_worth: "briefWorth",
    brief_worth_levels: "briefWorthLevels",
    urgency: "urgency",
    urgency_levels: "urgencyLevels",
  };
  const field = fields[tail];
  if (field) (next as unknown as Record<string, unknown>)[field] = value;
  return next;
}

/** The value of one arrival field on a ThreadJudgments. */
function arrivalValue(j: ThreadJudgments, field: string): number {
  if (field.startsWith("chip:")) return j.chips[field.slice(5)] ?? 0;
  return j[field as keyof ThreadJudgments] as number;
}

const sectionJudgmentsOf = (j: ThreadJudgments): SectionJudgments => ({
  needsReply: j.needsReply,
  waitingOnOthers: j.waitingOnOthers,
  newsletter: j.newsletter,
  automated: j.automated,
  urgency: j.urgency,
});

/** The judged bounds of a rule that hold over a Thread's Judgments, as the explanation names them. */
function judgedBounds(when: SectionWhen, j: SectionJudgments): string[] {
  const out: string[] = [];
  const pairs: Array<[string, number, number | undefined, number | undefined]> = [
    ["needs_reply", j.needsReply, when.needs_reply_at_least, when.needs_reply_at_most],
    ["waiting", j.waitingOnOthers, when.waiting_at_least, when.waiting_at_most],
    ["newsletter", j.newsletter, when.newsletter_at_least, when.newsletter_at_most],
    ["automated", j.automated, when.automated_at_least, when.automated_at_most],
    ["urgency", j.urgency, when.urgency_at_least, when.urgency_at_most],
  ];
  for (const [name, value, atLeast, atMost] of pairs) {
    if (atLeast !== undefined) {
      out.push(`${name} ${round(value)} ${value >= atLeast ? ">=" : "<"} ${atLeast}`);
    }
    if (atMost !== undefined) {
      out.push(`${name} ${round(value)} ${value <= atMost ? "<=" : ">"} ${atMost}`);
    }
  }
  return out;
}

/* ------------------------------ The seam ------------------------------ */

export function createTune(options: TuneOptions): TuneSeam {
  const { db, mailstore, runtime, routing, judgments, organize } = options;
  const now = options.now ?? (() => new Date());
  /** Tests by Session and proposal; bounded so a long-running Server does not grow. */
  const memory = new Map<string, JudgmentTest>();
  const MEMORY_MAX = 200;

  const tuneSettings = async (): Promise<TuneSettings> => {
    const s = await readGlobalSettings(db, TUNE_KEYS);
    return {
      sample: s["tune.sample"],
      scan: s["tune.scan"],
      windowDays: s["tune.window_days"],
      uncertainBand: s["tune.uncertain_band"],
      changesMax: s["tune.changes_max"],
    };
  };

  const judgeAvailable = async () => {
    try {
      return await runtime.judgeAvailable();
    } catch {
      return false;
    }
  };

  const groupNames = async (workspaceId: Id): Promise<Map<GroupId, string>> => {
    const rows = await db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(eq(groups.workspaceId, workspaceId));
    return new Map(rows.map((g) => [g.id, g.name]));
  };

  const entries = async (workspaceId: Id): Promise<JudgmentEntry[]> => {
    const { rules } = await organize.sectionRules();
    const sectionEntries = rules.filter((r) => r.judge?.trim()).map(sectionEntry);
    const groupRows = await db
      .select({ id: groups.id, name: groups.name, parentId: groups.parentId })
      .from(groups)
      .where(eq(groups.workspaceId, workspaceId));
    const groupEntries: JudgmentEntry[] = groupRows.map((g) => ({
      family: "routing",
      key: "",
      group: g.id,
      ref: `group:${g.id}`,
      label: `Group "${g.name}"`,
      kind: "group_rule",
      question: "choice",
      test: null,
      untestable:
        "A Group's rule is Group data, not a Setting: change it with update_group, then organize_existing previews what moves.",
      editWith: "update_group",
    }));
    const all = staticEntries();
    const at = all.findIndex((e) => e.key === "sections.judge_threshold");
    return [...all.slice(0, at), ...sectionEntries, ...all.slice(at), ...groupEntries];
  };

  const resolve = async (
    workspaceId: Id,
    ref: { key: string; section?: string | undefined },
  ): Promise<JudgmentEntry | null> => {
    const all = await entries(workspaceId);
    const m = /^sections\.rules\[(.+)\]\.judge$/.exec(ref.key.trim());
    const sectionRefOrName = m?.[1] ?? (ref.key.trim() === "sections.rules" ? ref.section : null);
    if (sectionRefOrName) {
      const { rules } = await organize.sectionRules();
      const want = sectionRefOrName.trim().toLowerCase();
      const rule =
        rules.find((r) => r.id.toLowerCase() === want) ??
        rules.find((r) => sectionLabel(r).toLowerCase() === want);
      if (!rule) return null;
      // A Section with no statement yet can be given one.
      return all.find((e) => e.section === rule.id) ?? sectionEntry(rule);
    }
    return (
      all.find((e) => e.ref === ref.key.trim() || (e.key === ref.key.trim() && !e.section)) ?? null
    );
  };

  /* ------------------------------ Proposals ------------------------------ */

  const current = async <K extends SettingKey>(key: K): Promise<Settings[K]> =>
    (await readGlobalSettings(db, [key]))[key];

  const plan = async (workspaceId: Id, proposal: JudgmentProposal): Promise<ProposalPlan> => {
    const entry = await resolve(workspaceId, proposal);
    if (!entry) {
      throw new TuneRefusal(
        `No judgment "${proposal.key}"${proposal.section ? ` for ${proposal.section}` : ""}; list_judgments names them.`,
        "unknown",
      );
    }
    if (entry.kind === "group_rule" || entry.editWith) {
      throw new TuneRefusal(
        `${entry.label} is changed with ${entry.editWith ?? "change_setting"}.`,
        "invalid",
      );
    }
    const writes: ProposalPlan["writes"] = [];
    const before: ProposalSide = {};
    const after: ProposalSide = {};
    const invalid = (key: string, error: string) => new TuneRefusal(`${key}: ${error}`, "invalid");

    if (entry.kind === "statement") {
      const rules = await current("sections.rules");
      const rule = rules.find((r) => r.id === entry.section);
      if (!rule) throw new TuneRefusal(`No section "${entry.section}".`, "unknown");
      before.text = rule.judge?.trim() || null;
      if (proposal.text !== undefined) {
        const text = proposal.text.trim();
        if (!text) throw invalid(entry.ref, "the statement cannot be empty");
        const next = rules.map((r) => (r.id === rule.id ? { ...r, judge: text } : r));
        const valid = validateSetting("sections.rules", next);
        if (!valid.ok) throw invalid("sections.rules", valid.error);
        writes.push({ key: "sections.rules", value: valid.value, previous: rules });
        after.text = text;
      }
    } else if (entry.kind !== "threshold") {
      const key = entry.key as SettingKey;
      const value = await current(key);
      if (entry.kind === "levels") {
        before.levels = value as string[];
        if (proposal.levels !== undefined) {
          const valid = validateSetting(key, proposal.levels);
          if (!valid.ok) throw invalid(key, valid.error);
          writes.push({ key, value: valid.value, previous: value });
          after.levels = valid.value as string[];
        } else if (proposal.text !== undefined) {
          throw invalid(key, "these are levels; pass `levels`, lowest first");
        }
      } else {
        before.text = value as string;
        if (proposal.levels !== undefined) throw invalid(key, "this is a question; pass `text`");
        if (proposal.text !== undefined) {
          const valid = validateSetting(key, proposal.text.trim());
          if (!valid.ok) throw invalid(key, valid.error);
          writes.push({ key, value: valid.value, previous: value });
          after.text = valid.value as string;
        }
      }
    }

    const thresholdKey: SettingKey | undefined =
      entry.kind === "threshold" ? (entry.key as SettingKey) : entry.threshold;
    if (thresholdKey) {
      const value = (await current(thresholdKey)) as number;
      before.threshold = { key: thresholdKey, value };
      if (proposal.threshold !== undefined) {
        const valid = validateSetting(thresholdKey, proposal.threshold);
        if (!valid.ok) throw invalid(thresholdKey, valid.error);
        writes.push({ key: thresholdKey, value: valid.value, previous: value });
        after.threshold = { key: thresholdKey, value: valid.value as number };
      }
    } else if (proposal.threshold !== undefined) {
      throw invalid(
        entry.ref,
        entry.family === "arrival"
          ? "this question has no threshold of its own; the Section rules bound its answer (update_section)"
          : "this judgment has no threshold",
      );
    }
    if (
      entry.kind === "threshold" &&
      (proposal.text !== undefined || proposal.levels !== undefined)
    ) {
      throw invalid(entry.ref, "this is a threshold; pass `threshold`");
    }
    if (writes.length === 0) {
      throw new TuneRefusal("Nothing proposed: pass `text`, `levels` or `threshold`.", "invalid");
    }
    // A side keeps what does not change, so the card shows both in full.
    const side = (s: ProposalSide, other: ProposalSide): ProposalSide => ({
      ...other,
      ...s,
    });
    return { entry, writes, before, after: side(after, before) };
  };

  /* ------------------------------ Explaining ------------------------------ */

  const explain = async (workspaceId: Id, threadId: Id): Promise<PlacementExplanation> => {
    const row = await db.query.threads.findFirst({ where: eq(threadsTable.id, threadId) });
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundError("thread", threadId);
    const names = await groupNames(workspaceId);
    const nameOf = (id: GroupId) => names.get(id) ?? id;
    const rs = await readGlobalSettings(db, ROUTING_KEYS);
    const ctx = await organize.sectionContext(workspaceId, [threadId]);
    const thread = ctx.threads[0];
    const facts = await judgments.facts(threadId);
    const why: string[] = [];

    const userPlaced = row.writes.placement?.by === "user";
    const route = await db.query.threadRoutes.findFirst({
      where: eq(threadRoutes.threadId, threadId),
    });
    const groupRow = row.groupId
      ? await db.query.groups.findFirst({ where: eq(groups.id, row.groupId) })
      : null;
    let routingPart: PlacementExplanation["routing"] = null;
    if (route) {
      const thresholds = {
        route: rs["routing.threshold.route"],
        ask: rs["routing.threshold.ask"],
        tieMargin: rs["routing.threshold.tie_margin"],
        groupRoute: route.groupId
          ? ((await db.query.groups.findFirst({ where: eq(groups.id, route.groupId) }))
              ?.threshold ?? null)
          : null,
      };
      const confidence = route.confidence;
      const routeAt = thresholds.groupRoute ?? thresholds.route;
      const band =
        confidence === null
          ? null
          : confidence >= routeAt
            ? "route"
            : confidence >= Math.min(thresholds.ask, routeAt)
              ? "ask"
              : "below";
      routingPart = {
        by: route.by,
        routedAt: route.routedAt.toISOString(),
        confidence,
        distribution: [...route.scores]
          .sort((a, b) => b.confidence - a.confidence)
          .map((s) => ({ groupId: s.groupId, name: nameOf(s.groupId), probability: s.confidence })),
        thresholds,
        band,
      };
    }
    const decision = await db.query.routingDecisions.findFirst({
      where: eq(routingDecisions.threadId, threadId),
    });
    const needsDecision = decision
      ? {
          candidates: decision.candidates.map((c) => ({
            groupId: c.groupId,
            name: nameOf(c.groupId),
            confidence: c.confidence,
          })),
          at: decision.at.toISOString(),
        }
      : null;

    const allGroups = await db.select().from(groups).where(eq(groups.workspaceId, workspaceId));
    const predicateFacts = {
      from: facts.from,
      participants: facts.participants,
      subject: row.subjectSearch,
      hasAttachments: facts.hasAttachments,
      headers: facts.headers,
    };
    const predicates = allGroups
      .filter(
        (g) => Object.keys(g.predicate).length > 0 && matchesPredicate(g.predicate, predicateFacts),
      )
      .map((g) => ({ groupId: g.id, name: g.name, predicate: g.predicate }));

    const exampleRows = await db
      .select()
      .from(examples)
      .where(eq(examples.workspaceId, workspaceId))
      .orderBy(desc(examples.at));
    const sender = facts.from?.email.toLowerCase() ?? null;
    const own = exampleRows.filter((e) => e.threadId === threadId);
    const similar = exampleRows
      .filter((e) => e.threadId !== threadId && sender !== null && e.from)
      .filter((e) => {
        const f = e.from?.email.toLowerCase() ?? "";
        return f === sender || domainOf(f) === domainOf(sender ?? "");
      })
      .slice(0, rs["routing.examples_in_prompt"] * 2)
      .map((e) => ({
        groupId: e.groupId,
        name: nameOf(e.groupId),
        positive: e.positive,
        from: e.from?.email ?? null,
        subject: e.subject,
      }));

    const stored = await judgments.get(threadId);
    const fresh = stored ? (await judgments.fresh(threadId)) !== null : false;

    // The Section, rule by rule in order, up to the one that claims it.
    const sectionTrace: PlacementExplanation["sections"] = [];
    let section: PlacementExplanation["section"] = null;
    const tFacts = thread ? ctx.facts.get(thread.id) : undefined;
    if (thread && tFacts) {
      const ordered = orderedSectionRules(ctx.rules, ctx.order);
      for (const rule of ordered) {
        const conditions = sectionMatches(rule.when, thread, tFacts);
        const holds = sectionRuleHolds(rule, thread, tFacts);
        const bounds =
          tFacts.judgments && hasJudgedWhen(rule.when)
            ? judgedBounds(rule.when, tFacts.judgments)
            : [];
        sectionTrace.push({
          id: rule.id,
          name: sectionLabel(rule),
          holds,
          conditions,
          judgedBounds: bounds,
          judge: rule.judge?.trim()
            ? {
                statement: rule.judge.trim(),
                probability: tFacts.judged?.[rule.id] ?? null,
                threshold: ctx.threshold,
              }
            : null,
        });
        if (holds) {
          section = { id: rule.id, name: sectionLabel(rule) };
          break;
        }
      }
    }

    // The sentences.
    if (userPlaced) {
      why.push(
        `You placed it${row.groupId ? ` in ${nameOf(row.groupId)}` : " out of every Group"}; routing never moves a Thread you placed.`,
      );
    } else if (route?.by === "predicate" && row.groupId) {
      why.push(`${nameOf(row.groupId)}'s Predicate matches its headers, so no judgment was asked.`);
    } else if (routingPart && route) {
      const top = routingPart.distribution[0];
      const t = routingPart.thresholds;
      const routeAt = t.groupRoute ?? t.route;
      if (row.groupId && route.groupId === row.groupId) {
        why.push(
          `The routing judgment put it in ${nameOf(row.groupId)} at ${round(route.confidence ?? 0)}, at or above the route threshold ${routeAt}.`,
        );
      } else if (needsDecision) {
        why.push(
          `It waits in Needs a decision: the best Group${top ? `, ${top.name} at ${round(top.probability)},` : ""} was in the ask band from ${t.ask} to ${routeAt}, or the judge was not sure or two Groups tied.`,
        );
      } else {
        why.push(
          top
            ? `No Group: the best, ${top.name} at ${round(top.probability)}, is below what places it, or the judge chose none.`
            : "No Group: routing found nothing to weigh.",
        );
      }
    } else {
      why.push(
        row.groupId ? `It is in ${nameOf(row.groupId)}.` : "Routing has not placed it in a Group.",
      );
    }
    if (similar.length > 0) {
      why.push(
        `${plural(similar.length, "Example")} from the same sender or domain go into the routing question as your past decisions.`,
      );
    }
    const claimed = sectionTrace.find((s) => s.holds);
    if (claimed) {
      const reason = claimed.judge
        ? `the judge says ${round(claimed.judge.probability ?? 0)} to "${claimed.judge.statement}", at or above ${claimed.judge.threshold}`
        : claimed.judgedBounds.length > 0
          ? `its judged bounds hold (${claimed.judgedBounds.join(", ")})`
          : "its header conditions hold";
      why.push(`It shows under ${claimed.name} because ${reason}.`);
    } else if (sectionTrace.length > 0) {
      why.push("No Section rule claims it.");
    }
    if (stored && !fresh)
      why.push("Its arrival Judgments were asked for an older version of the Thread.");

    return {
      thread: {
        id: row.id,
        subject: thread?.subject ?? row.subjectSearch,
        from: facts.from?.email ?? null,
        lastActivity: row.lastActivity.toISOString(),
      },
      userPlaced,
      group: row.groupId ? { id: row.groupId, name: groupRow?.name ?? row.groupId } : null,
      subgroup: row.subgroupId ? { id: row.subgroupId, name: nameOf(row.subgroupId) } : null,
      routing: routingPart,
      needsDecision,
      predicates,
      examples: {
        thread: own.map((e) => ({
          groupId: e.groupId,
          name: nameOf(e.groupId),
          positive: e.positive,
          at: e.at.toISOString(),
        })),
        similar,
      },
      judgments: stored
        ? {
            needsReply: stored.needsReply,
            waitingOnOthers: stored.waitingOnOthers,
            newsletter: stored.newsletter,
            automated: stored.automated,
            briefWorth: stored.briefWorth,
            urgency: stored.urgency,
            chips: stored.chips,
            model: stored.model,
            judgedAt: stored.judgedAt,
            fresh,
          }
        : null,
      section,
      sections: sectionTrace,
      why,
    };
  };

  /* ------------------------------ Listing ------------------------------ */

  const list = async (workspaceId: Id): Promise<JudgmentListing> => {
    const ts = await tuneSettings();
    const since = new Date(now().getTime() - ts.windowDays * 86_400_000);
    const all = await entries(workspaceId);
    const names = await groupNames(workspaceId);
    const band = ts.uncertainBand;
    const side = (p: number) => (p >= 0.5 + band ? "yes" : p <= 0.5 - band ? "no" : "unsure");

    // Routing: what was placed, asked about and corrected over the window.
    const routes = await db
      .select({ groupId: threadRoutes.groupId, by: threadRoutes.by })
      .from(threadRoutes)
      .where(and(eq(threadRoutes.workspaceId, workspaceId), gte(threadRoutes.routedAt, since)));
    const decisions = await db
      .select({ threadId: routingDecisions.threadId })
      .from(routingDecisions)
      .where(and(eq(routingDecisions.workspaceId, workspaceId), gte(routingDecisions.at, since)));
    const exampleRows = await db
      .select({ groupId: examples.groupId, positive: examples.positive })
      .from(examples)
      .where(and(eq(examples.workspaceId, workspaceId), gte(examples.at, since)));
    const routed = routes.filter((r) => r.by !== "user");
    const routingDistribution: Record<string, number> = {};
    for (const r of routed) {
      const k = r.groupId ? (names.get(r.groupId) ?? r.groupId) : "no group";
      routingDistribution[k] = (routingDistribution[k] ?? 0) + 1;
    }
    const routingBehavior: JudgmentBehavior = {
      answered: routed.length,
      distribution: routingDistribution,
      undecided: decisions.length,
      corrections: {
        examples: exampleRows.length,
        userPlacements: routes.filter((r) => r.by === "user").length,
        contradicting: exampleRows.filter((e) => !e.positive).length,
      },
      note: "Corrections are Examples written over the window (a move you made, an answer to Needs a decision, add_example); contradicting counts the ones that took a Thread out of a Group routing chose.",
    };

    // Arrival: the stored answers over the window.
    const arrivalRows = await db
      .select()
      .from(threadJudgments)
      .where(
        and(eq(threadJudgments.workspaceId, workspaceId), gte(threadJudgments.judgedAt, since)),
      );
    const s = await readGlobalSettings(db, ["chips.threshold", ...POLICY_KEYS]);
    const arrivalBehavior = (field: string, type: "noul" | "score"): JudgmentBehavior => {
      const distribution: Record<string, number> = {};
      let unsure = 0;
      for (const r of arrivalRows) {
        const value = field.startsWith("chip:")
          ? (r.chips[field.slice(5)] ?? 0)
          : (r[field as keyof typeof r] as number);
        let bucket: string;
        if (field.startsWith("chip:")) bucket = value >= s["chips.threshold"] ? "shown" : "hidden";
        else if (type === "score") bucket = `level ${Math.round(value)}`;
        else bucket = side(value);
        if (type === "noul" && side(value) === "unsure") unsure += 1;
        distribution[bucket] = (distribution[bucket] ?? 0) + 1;
      }
      return {
        answered: arrivalRows.length,
        distribution,
        undecided: type === "noul" ? unsure : null,
        corrections: null,
        note: "monday records no correction for this answer directly; explain_placement on a Thread shows it.",
      };
    };
    const policyBehavior: JudgmentBehavior = (() => {
      const distribution: Record<string, number> = {};
      for (const r of arrivalRows) {
        const p = judgedPolicy(r, {
          alwaysAtLeast: s["briefs.judge.always_at_least"],
          neverBelow: s["briefs.judge.never_below"],
          newsletterAtLeast: s["briefs.judge.newsletter_at_least"],
        });
        distribution[p] = (distribution[p] ?? 0) + 1;
      }
      return { answered: arrivalRows.length, distribution, undecided: null, corrections: null };
    })();

    // Sections: the cached answers per rule, and the Examples.
    const ctxRules = await organize.sectionRules();
    const sectionSettings = await organize.settings();
    const sectionRows = await db
      .select({
        ruleId: sectionJudgments.ruleId,
        statement: sectionJudgments.statement,
        probability: sectionJudgments.probability,
        threadId: sectionJudgments.threadId,
      })
      .from(sectionJudgments)
      .where(
        and(eq(sectionJudgments.workspaceId, workspaceId), gte(sectionJudgments.judgedAt, since)),
      );
    const sectionExamples = await current("sections.examples");
    const examplesMax = (await current("routing.examples_in_prompt")) as number;
    const sectionBehavior = (rule: SectionRuleSetting): JudgmentBehavior => {
      const key = sectionQuestion(
        rule.judge?.trim() ?? "",
        sectionExamples[rule.id],
        examplesMax,
      ).key;
      const rows = sectionRows.filter((r) => r.ruleId === rule.id);
      const currentRows = rows.filter((r) => r.statement === key);
      const distribution: Record<string, number> = {};
      let unsure = 0;
      for (const r of currentRows) {
        const bucket = r.probability >= sectionSettings.judgeThreshold ? "holds" : "does not hold";
        distribution[bucket] = (distribution[bucket] ?? 0) + 1;
        if (side(r.probability) === "unsure") unsure += 1;
      }
      const ex = (sectionExamples[rule.id] ?? []).filter(
        (e) => Date.parse(e.at) >= since.getTime(),
      );
      const byThread = new Map(rows.map((r) => [r.threadId, r.probability]));
      const contradicting = ex.filter((e) => {
        const p = byThread.get(e.threadId);
        return p !== undefined && p >= sectionSettings.judgeThreshold !== e.holds;
      }).length;
      return {
        answered: currentRows.length,
        distribution,
        undecided: unsure,
        corrections: { examples: ex.length, userPlacements: 0, contradicting },
        ...(rows.length > currentRows.length
          ? {
              note: `${rows.length - currentRows.length} older answers were asked with an earlier wording.`,
            }
          : {}),
      };
    };

    // Judgments that keep no answers: the Meter counts their requests.
    const metered = await db
      .select({ task: meter.task })
      .from(meter)
      .where(
        and(
          eq(meter.workspaceId, workspaceId),
          gte(meter.createdAt, since),
          inArray(meter.task, ["judge.intent", "judge.guard", "judge.verify", "judge.condition"]),
        ),
      );
    const requests = (task: string): JudgmentBehavior => ({
      answered: metered.filter((m) => m.task === task).length,
      distribution: {},
      undecided: null,
      corrections: null,
      note: "Requests over the window from the Meter; the answers are not kept.",
    });
    const meterTask: Partial<Record<JudgmentFamily, string>> = {
      palette: "judge.intent",
      guard: "judge.guard",
      verification: "judge.verify",
      workflows: "judge.condition",
    };

    const values = await readGlobalSettings(db, [
      ...new Set(all.flatMap((e) => [e.key, e.threshold]).filter((k): k is SettingKey => !!k)),
    ]);
    const defaults = (key: string) =>
      (settingsSchema as Record<string, { default: unknown }>)[key]?.default;
    const listed = (e: JudgmentEntry): ListedJudgment => {
      let value: unknown;
      let def: unknown;
      let behavior: JudgmentBehavior | null = null;
      if (e.kind === "statement") {
        const rule = ctxRules.rules.find((r) => r.id === e.section);
        value = rule?.judge ?? null;
        def = null;
        if (rule) behavior = sectionBehavior(rule);
      } else if (e.kind === "group_rule") {
        const g = e.group ?? "";
        value = null;
        def = null;
        const toGroup = routed.filter((r) => r.groupId === g).length;
        const ex = exampleRows.filter((x) => x.groupId === g);
        behavior = {
          answered: toGroup,
          distribution: { routed: toGroup },
          undecided: null,
          corrections: {
            examples: ex.length,
            userPlacements: 0,
            contradicting: ex.filter((x) => !x.positive).length,
          },
        };
      } else {
        value = (values as Record<string, unknown>)[e.key];
        def = defaults(e.key);
        if (e.key === "routing.judge.instructions") behavior = routingBehavior;
        else if (e.family === "arrival" && ARRIVAL[e.key] && !e.key.endsWith("_levels")) {
          const a = ARRIVAL[e.key];
          if (a) behavior = arrivalBehavior(a.field, a.type);
        } else if (e.key === "briefs.judge.always_at_least") behavior = policyBehavior;
        else if (e.kind !== "threshold" && meterTask[e.family]) {
          behavior = requests(meterTask[e.family] ?? "");
        }
      }
      return {
        ref: e.ref,
        key: e.key,
        ...(e.section ? { section: e.section } : {}),
        ...(e.group ? { group: e.group } : {}),
        label: e.label,
        kind: e.kind,
        ...(e.question ? { question: e.question } : {}),
        value,
        default: def,
        isDefault:
          e.kind === "statement" || e.kind === "group_rule"
            ? false
            : JSON.stringify(value) === JSON.stringify(def),
        ...(e.threshold
          ? {
              threshold: {
                key: e.threshold,
                value: (values as Record<string, unknown>)[e.threshold],
                default: defaults(e.threshold),
              },
            }
          : {}),
        testable: e.test !== null,
        ...(e.untestable ? { untestable: e.untestable } : {}),
        editWith: e.editWith ?? "update_judgment",
        behavior,
      };
    };

    const order: JudgmentFamily[] = [
      "routing",
      "arrival",
      "sections",
      "brief_policy",
      "palette",
      "guard",
      "verification",
      "workflows",
    ];
    return {
      windowDays: ts.windowDays,
      since: since.toISOString(),
      judge: await judgeAvailable(),
      families: order.map((family) => ({
        family,
        label: FAMILY_LABELS[family],
        judgments: all.filter((e) => e.family === family).map(listed),
      })),
    };
  };

  /* ------------------------------ Testing ------------------------------ */

  const sectionName = (ctx: SectionContext, id: string | null, rules = ctx.rules) => {
    if (!id) return "no section";
    const r = rules.find((x) => x.id === id);
    return r ? sectionLabel(r) : id;
  };

  const placementOfScored = (scored: Scored, names: Map<GroupId, string>, fallback: string) => {
    const p = scored.placement;
    if (p.kind === "route") {
      const sub = scored.subgroup
        ? ` / ${names.get(scored.subgroup.groupId) ?? scored.subgroup.groupId}`
        : "";
      return `${names.get(p.groupId) ?? p.groupId}${sub}`;
    }
    if (p.kind === "ask") return "Needs a decision";
    return fallback ? (names.get(fallback) ?? fallback) : "no group";
  };

  const answerOfScored = (scored: Scored, names: Map<GroupId, string>): Outcome["answer"] => {
    const best = [...scored.scores].sort((a, b) => b.confidence - a.confidence)[0];
    return best ? (names.get(best.groupId) ?? best.groupId) : null;
  };

  interface Collected {
    considered: number;
    skipped: number;
    requests: number;
    costMicros: number;
    rows: Array<ThreadChange & { moved: boolean; flipped: boolean }>;
  }

  const summarize = (
    p: ProposalPlan,
    c: Collected,
    asked: boolean,
    ts: TuneSettings,
  ): JudgmentTest => {
    const changed = c.rows.filter((r) => r.moved || r.flipped);
    const moves: Record<string, number> = {};
    for (const r of changed.filter((x) => x.moved)) {
      const k = `${r.before.placement} -> ${r.after.placement}`;
      moves[k] = (moves[k] ?? 0) + 1;
    }
    const moved = changed.filter((r) => r.moved).length;
    const flipped = changed.filter((r) => !r.moved && r.flipped).length;
    const parts = Object.entries(moves)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} from ${k.replace(" -> ", " to ")}`);
    const summary =
      c.considered === 0
        ? "No recent thread to test on."
        : moved === 0 && flipped === 0
          ? `Tested on ${plural(c.considered, "recent thread")}: nothing would change.`
          : `Tested on ${plural(c.considered, "recent thread")}: ${plural(moved, "thread")} would move${
              parts.length ? ` (${parts.join("; ")})` : ""
            }${flipped ? `, and ${flipped} more would answer differently without moving` : ""}.`;
    // Moves first, then the biggest answer changes.
    const delta = (r: ThreadChange) =>
      typeof r.before.answer === "number" && typeof r.after.answer === "number"
        ? Math.abs(r.after.answer - r.before.answer)
        : 1;
    const listed = [...changed]
      .sort((a, b) => Number(b.moved) - Number(a.moved) || delta(b) - delta(a))
      .slice(0, ts.changesMax)
      .map(({ moved: _m, flipped: _f, ...rest }) => rest);
    return {
      ref: p.entry.ref,
      key: p.entry.key,
      ...(p.entry.section ? { section: p.entry.section } : {}),
      label: p.entry.label,
      before: p.before,
      after: p.after,
      asked,
      considered: c.considered,
      skipped: c.skipped,
      requests: c.requests,
      costMicros: c.costMicros,
      moved,
      flipped,
      moves,
      changes: listed,
      more: Math.max(0, changed.length - listed.length),
      summary,
    };
  };

  const noJudge = (entry: JudgmentEntry) =>
    new TuneRefusal(
      `No judge is answering now (no TypeSafe key, or Settings, AI has the language model deciding), so ${entry.label} is not being asked and cannot be tested. ${
        entry.family === "routing"
          ? "Routing runs on the language model's classify prompt meanwhile: organize_existing on a Group previews what it would move, and a Group's rule sentence (update_group) is what that prompt reads."
          : entry.family === "sections"
            ? "Until a judge answers, a judged Section holds only what its conditions decide."
            : "The header rules decide meanwhile; update_section changes their conditions."
      } Add a TypeSafe key under Settings, AI to test and use the question itself.`,
      "no_judge",
    );

  const ask = async <Q extends Record<string, import("@monday/shared").JudgeQuestion>>(
    task: "judge.route" | "judge.section",
    workspaceId: Id,
    state: JsonValue,
    questions: Q,
    c: Collected,
  ) => {
    try {
      const result = await runtime.judge(task, state, questions, { workspaceId });
      c.requests += 1;
      c.costMicros += result.costMicros;
      return result;
    } catch (error) {
      if (error instanceof NoJudgeError || error instanceof AiOffError) {
        throw new TuneRefusal(error.message, "no_judge");
      }
      throw error;
    }
  };

  const testRouting = async (workspaceId: Id, p: ProposalPlan, sample: number) => {
    const override: RoutingOverride = { thresholds: {}, judge: {} };
    for (const w of p.writes) {
      if (w.key === "routing.judge.instructions")
        override.judge = { ...override.judge, instructions: w.value as string };
      if (w.key === "routing.judge.none_option")
        override.judge = { ...override.judge, noneOption: w.value as string };
      if (w.key === "routing.threshold.route")
        override.thresholds = { ...override.thresholds, route: w.value as number };
      if (w.key === "routing.threshold.ask")
        override.thresholds = { ...override.thresholds, ask: w.value as number };
      if (w.key === "routing.threshold.tie_margin")
        override.thresholds = { ...override.thresholds, tieMargin: w.value as number };
    }
    const names = await groupNames(workspaceId);
    const fallback = ((await current("routing.default_group")) as string).trim();
    const page = await mailstore.listThreads(workspaceId, { limit: sample });
    const ids = page.threads.map((t) => t.id);
    const rows = ids.length
      ? await db.select().from(threadsTable).where(inArray(threadsTable.id, ids))
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const c: Collected = { considered: 0, skipped: 0, requests: 0, costMicros: 0, rows: [] };
    for (const t of page.threads) {
      const row = byId.get(t.id);
      if (!row || row.writes.placement?.by === "user") {
        c.skipped += 1;
        continue;
      }
      c.considered += 1;
      const before = await routing.classify(t.id);
      const after = await routing.classify(t.id, { override });
      c.requests += before.calls + after.calls;
      const prob = (s: Scored) =>
        Object.fromEntries(
          s.scores.map((x) => [names.get(x.groupId) ?? x.groupId, round(x.confidence)]),
        );
      const b: Outcome = {
        answer: answerOfScored(before, names),
        probabilities: prob(before),
        placement: placementOfScored(before, names, fallback),
      };
      const a: Outcome = {
        answer: answerOfScored(after, names),
        probabilities: prob(after),
        placement: placementOfScored(after, names, fallback),
      };
      c.rows.push({
        threadId: t.id,
        subject: t.subject,
        from: t.participants[0]?.email ?? null,
        before: b,
        after: a,
        moved: b.placement !== a.placement,
        flipped: b.answer !== a.answer,
      });
    }
    return c;
  };

  const testArrival = async (workspaceId: Id, p: ProposalPlan, sample: number) => {
    const entry = p.entry;
    const target = ARRIVAL[entry.key];
    if (!target) throw new TuneRefusal(`${entry.label} is not an arrival question.`, "untestable");
    const settings = await judgments.settings();
    let proposed = settings.questions;
    for (const w of p.writes) {
      if (w.key.startsWith("judgments.questions."))
        proposed = withArrivalChange(proposed, w.key, w.value);
    }
    const chipsBefore = (await current("chips.threshold")) as number;
    const chipsAfter =
      (p.writes.find((w) => w.key === "chips.threshold")?.value as number | undefined) ??
      chipsBefore;
    const policy = await readGlobalSettings(db, POLICY_KEYS);
    const policySettings = {
      alwaysAtLeast: policy["briefs.judge.always_at_least"],
      neverBelow: policy["briefs.judge.never_below"],
      newsletterAtLeast: policy["briefs.judge.newsletter_at_least"],
    };
    const ctx = await organize.sectionContext(workspaceId, sample);
    const c: Collected = { considered: 0, skipped: 0, requests: 0, costMicros: 0, rows: [] };
    const read = (
      answers: Parameters<typeof readJudgments>[0],
      threadId: Id,
      q: JudgmentQuestionSettings,
    ) =>
      readJudgments(answers, {
        threadId,
        model: "",
        judgedAt: now().toISOString(),
        levels: { briefWorth: q.briefWorthLevels.length, urgency: q.urgencyLevels.length },
      });
    const consequence = (
      t: Thread,
      facts: SectionFacts,
      j: ThreadJudgments,
      chipAt: number,
    ): string => {
      if (target.field.startsWith("chip:")) {
        return arrivalValue(j, target.field) >= chipAt ? "chip shown" : "chip hidden";
      }
      if (target.field === "briefWorth")
        return `brief ${judgedPolicy(j, policySettings) as BriefPolicy}`;
      const id = sectionOf(t, { ...facts, judgments: sectionJudgmentsOf(j) }, ctx.rules, ctx.order);
      return sectionName(ctx, id);
    };
    for (const t of ctx.threads) {
      const facts = ctx.facts.get(t.id);
      if (!facts) continue;
      c.considered += 1;
      const judgmentFacts = await judgments.facts(t.id);
      const state = judgmentState(judgmentFacts, settings.snippetChars);
      const before = await ask(
        "judge.section",
        workspaceId,
        state,
        judgmentQuestions(settings.questions),
        c,
      );
      const after = await ask("judge.section", workspaceId, state, judgmentQuestions(proposed), c);
      const jb = read(before.answers, t.id, settings.questions);
      const ja = read(after.answers, t.id, proposed);
      const vb = round(arrivalValue(jb, target.field));
      const va = round(arrivalValue(ja, target.field));
      const b: Outcome = { answer: vb, placement: consequence(t, facts, jb, chipsBefore) };
      const a: Outcome = { answer: va, placement: consequence(t, facts, ja, chipsAfter) };
      const sideOf = (v: number) => (target.type === "score" ? Math.round(v) : v >= 0.5 ? 1 : 0);
      c.rows.push({
        threadId: t.id,
        subject: t.subject,
        from: facts.lastSender ?? t.participants[0]?.email ?? null,
        before: b,
        after: a,
        moved: b.placement !== a.placement,
        flipped: sideOf(vb) !== sideOf(va),
      });
    }
    return c;
  };

  const testSection = async (workspaceId: Id, p: ProposalPlan, sample: number) => {
    const ts = await tuneSettings();
    const ctx = await organize.sectionContext(workspaceId, ts.scan);
    const rule = ctx.rules.find((r) => r.id === p.entry.section);
    if (!rule) throw new TuneRefusal(`No section "${p.entry.section}".`, "unknown");
    const nextRules =
      (p.writes.find((w) => w.key === "sections.rules")?.value as
        | SectionRuleSetting[]
        | undefined) ?? ctx.rules;
    const nextRule = nextRules.find((r) => r.id === rule.id) ?? rule;
    const thresholdAfter =
      (p.writes.find((w) => w.key === "sections.judge_threshold")?.value as number | undefined) ??
      ctx.threshold;
    const beforeQ = ctx.questions.get(rule.id) ?? null;
    const afterStatement = nextRule.judge?.trim() ?? "";
    const afterQ = afterStatement
      ? sectionQuestion(afterStatement, ctx.examples[rule.id], ctx.examplesMax)
      : null;
    const c: Collected = { considered: 0, skipped: 0, requests: 0, costMicros: 0, rows: [] };
    const matching = ctx.threads.filter((t) => {
      const f = ctx.facts.get(t.id);
      return f ? sectionMatches(rule.when, t, f) : false;
    });
    for (const t of matching.slice(0, sample)) {
      const facts = ctx.facts.get(t.id);
      if (!facts) continue;
      c.considered += 1;
      const state = await ctx.state(t);
      const pb = beforeQ
        ? (await ask("judge.section", workspaceId, state, { s: beforeQ.question }, c)).answers.s
            .noul
        : null;
      const pa = afterQ
        ? (await ask("judge.section", workspaceId, state, { s: afterQ.question }, c)).answers.s.noul
        : null;
      const judgedWith = (v: number | null) => {
        const out: Record<string, number> = { ...(facts.judged ?? {}) };
        if (v === null) delete out[rule.id];
        else out[rule.id] = v;
        return out;
      };
      const sb = sectionOf(t, { ...facts, judged: judgedWith(pb) }, ctx.rules, ctx.order);
      const sa = sectionOf(
        t,
        { ...facts, judged: judgedWith(pa), judgeThreshold: thresholdAfter },
        nextRules,
        ctx.order,
      );
      const b: Outcome = {
        answer: pb === null ? null : round(pb),
        placement: sectionName(ctx, sb),
      };
      const a: Outcome = {
        answer: pa === null ? null : round(pa),
        placement: sectionName(ctx, sa, nextRules),
      };
      c.rows.push({
        threadId: t.id,
        subject: t.subject,
        from: facts.lastSender ?? null,
        before: b,
        after: a,
        moved: b.placement !== a.placement,
        flipped: (pb ?? 0) >= ctx.threshold !== (pa ?? 0) >= thresholdAfter,
      });
    }
    return c;
  };

  /** A threshold over answers already stored: no request, the Threads without an answer are skipped. */
  const testStored = async (workspaceId: Id, p: ProposalPlan, sample: number) => {
    const path = p.entry.test;
    const c: Collected = { considered: 0, skipped: 0, requests: 0, costMicros: 0, rows: [] };
    const ctx = await organize.sectionContext(workspaceId, sample);
    const ids = ctx.threads.map((t) => t.id);
    const stored = ids.length
      ? await db.select().from(threadJudgments).where(inArray(threadJudgments.threadId, ids))
      : [];
    const byId = new Map(stored.map((r) => [r.threadId, r]));
    const proposedValue = (key: string, fallback: number) =>
      (p.writes.find((w) => w.key === key)?.value as number | undefined) ?? fallback;
    const policy = await readGlobalSettings(db, POLICY_KEYS);
    const chips = (await current("chips.threshold")) as number;
    for (const t of ctx.threads) {
      const facts = ctx.facts.get(t.id);
      if (!facts) continue;
      let b: Outcome;
      let a: Outcome;
      if (path === "stored_sections") {
        const sb = sectionOf(t, facts, ctx.rules, ctx.order);
        const sa = sectionOf(
          t,
          { ...facts, judgeThreshold: proposedValue("sections.judge_threshold", ctx.threshold) },
          ctx.rules,
          ctx.order,
        );
        b = { answer: null, placement: sectionName(ctx, sb) };
        a = { answer: null, placement: sectionName(ctx, sa) };
      } else {
        const j = byId.get(t.id);
        if (!j) {
          c.skipped += 1;
          continue;
        }
        if (path === "stored_chips") {
          const shown = (at: number) =>
            CHIP_NAMES.filter((n) => (j.chips[n] ?? 0) >= at).join(", ") || "no chips";
          b = { answer: null, placement: shown(chips) };
          a = { answer: null, placement: shown(proposedValue("chips.threshold", chips)) };
        } else {
          const before = {
            alwaysAtLeast: policy["briefs.judge.always_at_least"],
            neverBelow: policy["briefs.judge.never_below"],
            newsletterAtLeast: policy["briefs.judge.newsletter_at_least"],
          };
          const after = {
            alwaysAtLeast: proposedValue("briefs.judge.always_at_least", before.alwaysAtLeast),
            neverBelow: proposedValue("briefs.judge.never_below", before.neverBelow),
            newsletterAtLeast: proposedValue(
              "briefs.judge.newsletter_at_least",
              before.newsletterAtLeast,
            ),
          };
          b = { answer: round(j.briefWorth), placement: `brief ${judgedPolicy(j, before)}` };
          a = { answer: round(j.briefWorth), placement: `brief ${judgedPolicy(j, after)}` };
        }
      }
      c.considered += 1;
      c.rows.push({
        threadId: t.id,
        subject: t.subject,
        from: facts.lastSender ?? null,
        before: b,
        after: a,
        moved: b.placement !== a.placement,
        flipped: false,
      });
    }
    return c;
  };

  const test = async (
    workspaceId: Id,
    proposal: JudgmentProposal,
    sampleOverride?: number,
  ): Promise<JudgmentTest> => {
    const p = await plan(workspaceId, proposal);
    const ts = await tuneSettings();
    const sample = Math.max(1, sampleOverride ?? ts.sample);
    const path = p.entry.test;
    if (!path) {
      throw new TuneRefusal(
        `${p.entry.label} cannot be tested on Threads. ${p.entry.untestable ?? ""}`.trim(),
        "untestable",
      );
    }
    const asked = path === "routing" || path === "arrival" || path === "section";
    if (asked && !(await judgeAvailable())) throw noJudge(p.entry);
    const collected =
      path === "routing"
        ? await testRouting(workspaceId, p, sample)
        : path === "arrival"
          ? await testArrival(workspaceId, p, sample)
          : path === "section"
            ? await testSection(workspaceId, p, sample)
            : await testStored(workspaceId, p, sample);
    return summarize(p, collected, asked, ts);
  };

  const memoryKey = (sessionId: string, workspaceId: Id, proposal: JudgmentProposal) =>
    JSON.stringify([
      sessionId,
      workspaceId,
      proposal.key.trim(),
      proposal.section ?? null,
      proposal.text?.trim() ?? null,
      proposal.levels ?? null,
      proposal.threshold ?? null,
    ]);

  return {
    settings: tuneSettings,
    judgeAvailable,
    entries,
    resolve,
    plan,
    explain,
    list,
    test,
    remembered: (sessionId, workspaceId, proposal) =>
      memory.get(memoryKey(sessionId, workspaceId, proposal)) ?? null,
    remember(sessionId, workspaceId, proposal, result) {
      const k = memoryKey(sessionId, workspaceId, proposal);
      memory.delete(k);
      memory.set(k, result);
      while (memory.size > MEMORY_MAX) {
        const oldest = memory.keys().next().value;
        if (oldest === undefined) break;
        memory.delete(oldest);
      }
    },
    async findGroup(workspaceId, ref) {
      const want = ref.trim().toLowerCase();
      const rows = await db
        .select({ id: groups.id, name: groups.name })
        .from(groups)
        .where(eq(groups.workspaceId, workspaceId));
      return (
        rows.find((g) => g.id.toLowerCase() === want) ??
        rows.find((g) => g.name.toLowerCase() === want) ??
        null
      );
    },
    async findSection(ref) {
      const { rules } = await organize.sectionRules();
      const want = ref.trim().toLowerCase();
      const rule =
        rules.find((r) => r.id.toLowerCase() === want) ??
        rules.find((r) => sectionLabel(r).toLowerCase() === want);
      if (!rule) return null;
      return { rule, examples: await current("sections.examples") };
    },
    recordExample: (threadId, groupId, positive) =>
      routing.recordExample(threadId, groupId, positive),
    restoreExample: (threadId, groupId, previous) =>
      routing.restoreExample(threadId, groupId, previous),
    pinSectionAnswer: (workspaceId, threadId, sectionId, holds) =>
      organize.pinAnswer(workspaceId, threadId, sectionId, holds),
    async exampleFacts(threadId) {
      const row = await db.query.threads.findFirst({ where: eq(threadsTable.id, threadId) });
      if (!row) return null;
      const newest = await db.query.messages.findFirst({
        where: eq(messages.threadId, threadId),
        orderBy: desc(messages.date),
        columns: { from: true },
      });
      return {
        from: newest?.from?.email ?? row.participants[0]?.email ?? null,
        subject: row.subjectSearch,
      };
    },
  };
}
