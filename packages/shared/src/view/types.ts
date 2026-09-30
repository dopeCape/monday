// The View document (CONTEXT.md "View", "Block", "Field", "Extraction",
// "Lane"; docs/spec/views.md; ADR 0016): a JSON document the Agent writes,
// validated against this schema, versioned like a Workflow (ADR 0003's
// shape). A code-only scope of exact Facts; the Fields read per Thread (the
// View's own Signals, shipped ones it uses, its Extractions); ordered Lanes
// with three-valued conditions; a stack of Blocks from a fixed catalog, each
// with a code-only query; actions on items from a closed catalog; the nav
// entry. Runtime-neutral: types, the closed lists, and the zod shape.

import { z } from "zod";
import type { Id, IsoDate } from "../domain.ts";
import type { JsonValue } from "../judge.ts";
import type { SignalQuestion } from "../signals.ts";

/* ------------------------------ The closed lists ------------------------------ */

/** The palette's semantic colours a Lane may take; no free colours. */
export const LANE_TONES = ["danger", "warning", "ok", "info", "muted"] as const;
export type LaneTone = (typeof LANE_TONES)[number];

/** The Blocks that draw the Lanes a View's "Show as" switches between (a Board's old layouts). */
export const LANE_COMPONENTS = ["lanes", "list", "counts", "table", "timeline"] as const;
export type LaneComponent = (typeof LANE_COMPONENTS)[number];

/** What a View row may show, from a closed list; `signal:<id>` and `x:<id>` show a small label with the answer. */
export const ROW_FIELDS = [
  "sender",
  "subject",
  "snippet",
  "age",
  "time",
  "group",
  "deadline",
  "amount",
] as const;
export type RowField = (typeof ROW_FIELDS)[number] | `signal:${string}` | `x:${string}`;

export const VIEW_SORTS = ["newest_first", "oldest_first", "deadline_first"] as const;
export type ViewSort = (typeof VIEW_SORTS)[number];

/** The icons a View may carry in the nav, by the names the Group icons use. */
export const VIEW_ICONS = [
  "lifebuoy",
  "receipt",
  "users-three",
  "user-plus",
  "handshake",
  "calendar",
  "check-circle",
  "scales",
  "briefcase",
  "house",
  "heart",
  "tag",
  "folder",
  "code",
  "bell",
  "warning",
  "users",
  "shopping-bag",
  "shield",
  "megaphone",
  "chat-circle",
  "rocket",
  "currency-dollar",
  "graduation-cap",
  "chart-line",
  "truck",
  "kanban",
] as const;
export type ViewIcon = (typeof VIEW_ICONS)[number];

/**
 * What code finds candidates of for an Extraction (docs/spec/views.md,
 * "Extractions: select, don't generate"): Jev picks one, never writes one.
 */
export const EXTRACT_KINDS = [
  "money",
  "date",
  "reference",
  "tracking",
  "email",
  "person",
  "company",
  "link",
  "quantity",
  "item",
  "sentence",
] as const;
export type ExtractKind = (typeof EXTRACT_KINDS)[number];

/** The Block catalog (docs/spec/views.md, "The Block catalog"). */
export const BLOCK_TYPES = [
  "lanes",
  "list",
  "counts",
  "table",
  "stat",
  "chart",
  "timeline",
  "calendar",
  "cards",
  "people",
  "checklist",
  "heatmap",
  "text",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const CHART_TYPES = ["bar", "stacked_bar", "line", "area", "donut"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** How a value is written: a table column, a stat, a card's value. */
export const VALUE_FORMATS = [
  "money",
  "number",
  "date",
  "relative",
  "percent",
  "text",
  "chip",
] as const;
export type ValueFormat = (typeof VALUE_FORMATS)[number];

/** A date Field grouped by its day, week, month or year, or by weekday or hour, in the Workspace's zone. */
export const TIME_BUCKETS = ["day", "week", "month", "year", "weekday", "hour"] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

export const AGGREGATE_OPS = ["count", "sum", "avg", "min", "max"] as const;
export type AggregateOp = (typeof AGGREGATE_OPS)[number];

export const BLOCK_WIDTHS = ["full", "half", "third", "two_thirds"] as const;
export type BlockWidth = (typeof BLOCK_WIDTHS)[number];

/** What an action on an item does (docs/spec/views.md, "Actions on items"): a closed catalog. */
export const ACTION_KINDS = [
  "run_workflow",
  "archive",
  "snooze",
  "move",
  "tag",
  "mark_read",
  "mark_unread",
  "reply_template",
  "forward",
  "open_link",
  "add_to_calendar",
  "custom_action",
  "set_lane",
  "mark_done",
  "ask_agent",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** The Phosphor icons an action button may carry, by name. */
export const ACTION_ICONS = [
  "archive",
  "clock",
  "truck",
  "package",
  "arrow-u-up-left",
  "share",
  "paper-plane-tilt",
  "link",
  "calendar-plus",
  "check",
  "check-circle",
  "tag",
  "envelope-open",
  "envelope",
  "folder",
  "play",
  "flow-arrow",
  "sparkle",
  "currency-dollar",
  "receipt",
  "arrow-right",
  "star",
] as const;
export type ActionIcon = (typeof ACTION_ICONS)[number];

/** Snooze presets an action may name instead of a date Field. */
export const SNOOZE_PRESETS = ["tomorrow", "next_week", "weekend"] as const;

/**
 * The Facts a Lane condition may test (docs/spec/signals.md, "Facts"), by
 * the test they take: a flag (`is`), a number (`at_least`, `at_most`), a
 * date (`before`, `after`) or a text (`is`, `in`). Code computes them; the
 * model never compares a date, a count or an amount.
 */
export const VIEW_FACTS = {
  message_count: "number",
  participant_count: "number",
  attachment_count: "number",
  amount_count: "number",
  amount: "number",
  known_sender: "flag",
  has_attachment: "flag",
  owner_wrote_last: "flag",
  owner_ever_wrote: "flag",
  to_me_directly: "flag",
  has_invite: "flag",
  deadline_unclear: "flag",
  unread: "flag",
  starred: "flag",
  deadline_at: "date",
  received_at: "date",
  last_activity_at: "date",
  from_address: "text",
  from_domain: "text",
  list_id: "text",
  in_group: "text",
  in_section: "text",
} as const;
export type ViewFact = keyof typeof VIEW_FACTS;

/**
 * A moment a date test compares with, resolved by code in the Workspace's
 * zone: now, the start of today or tomorrow, the end of this week or month,
 * a number of days from now (negative is the past), or a calendar date.
 */
export type DateRef =
  | "now"
  | "today"
  | "tomorrow"
  | "end_of_today"
  | "end_of_week"
  | "end_of_next_week"
  | "end_of_month"
  | { days: number }
  | string;

/** A span of time for the scope: today, this week, the last N days, or since a date. */
export type DateScope =
  | { within: "today" | "this_week" }
  | { last_days: number }
  | { since: string };

/** Where the Threads live: the Inbox, anywhere but the trash, the Archive, a Group or a Section. */
export type ViewFolder = "inbox" | "any" | "archive" | `group:${string}` | `section:${string}`;

/** The scope's exact filters: code only, never a model. */
export interface ViewScopeFacts {
  /** When the Thread's first Message arrived. */
  received?: DateScope | undefined;
  /** When the Thread last moved. */
  active?: DateScope | undefined;
  /** Who started the Thread: exact addresses. */
  from_any?: string[] | undefined;
  from_domain?: string[] | undefined;
  from_domain_not?: string[] | undefined;
  /** Any Message's To or Cc holds one of these addresses. */
  to_any?: string[] | undefined;
  folder?: ViewFolder | undefined;
}

export interface ViewScope {
  facts: ViewScopeFacts;
  /** The most Threads the View looks at, newest first; at most views.scope.max_threads. */
  limit: number;
}

/** One of the View's own Signals, asked only inside its scope. */
export interface ViewSignal {
  /** Local to the View; stored as `board:<viewId>:<id>` (the prefix kept from Boards). */
  id: string;
  kind: "noul" | "choice" | "score";
  /** A few words for the card's reasons ("support request", "blocked"). */
  label?: string | undefined;
  question: SignalQuestion;
}

/**
 * A test on one Signal (the View's own or a shipped one the View `uses`):
 * `holds` or `fails` for a Noul against the Unsure band (or its own
 * `at_least` / `at_most` probability), `at_least` / `at_most` for a Score's
 * expectation, `is` for a Choice's pick above the confidence floor.
 */
export interface SignalTest {
  signal: string;
  holds?: boolean | undefined;
  fails?: boolean | undefined;
  at_least?: number | undefined;
  at_most?: number | undefined;
  is?: string | undefined;
}

/** A test on one Fact: `is` for a flag or a text, `in` for a text, `at_least` / `at_most` for a number, `before` / `after` for a date. */
export interface FactTest {
  fact: ViewFact;
  is?: boolean | string | undefined;
  in?: string[] | undefined;
  at_least?: number | undefined;
  at_most?: number | undefined;
  before?: DateRef | undefined;
  after?: DateRef | undefined;
}

/**
 * A test on one Extraction's value: `present` (a value was picked above its
 * floor), or the Fact tests on the value: `at_least` / `at_most` for money
 * and numbers, `before` / `after` for dates, `is` / `in` for text.
 */
export interface ExtractTest {
  extract: string;
  present?: boolean | undefined;
  is?: string | undefined;
  in?: string[] | undefined;
  at_least?: number | undefined;
  at_most?: number | undefined;
  before?: DateRef | undefined;
  after?: DateRef | undefined;
}

/** A test on the Lane a Thread is in (not inside a Lane's own condition). */
export interface LaneTest {
  lane: string | string[];
}

export type LaneCondition =
  | { all: LaneCondition[] }
  | { any: LaneCondition[] }
  | { not: LaneCondition }
  | { scope: ViewScopeFacts }
  | SignalTest
  | FactTest
  | ExtractTest
  | LaneTest;

/** Every condition a View holds (a Lane's `when`, a query's `where`, an action's `when`). */
export type ViewCondition = LaneCondition;

export interface Lane {
  id: string;
  label: string;
  tone: LaneTone;
  when: LaneCondition;
}

/* ------------------------------ Extractions ------------------------------ */

/** A value the View takes from the text by selection. */
export interface ViewExtraction {
  /** Local to the View; stored as `board:<viewId>:x_<id>`. */
  id: string;
  /** A few words for a column, a card or the reasons ("Total"). */
  label?: string | undefined;
  find: ExtractKind;
  /** Which of the candidates answers: the Agent's own words, one value. */
  question: JsonValue;
  /** What "none of these" means here; views.extract.none when absent. */
  none?: string | undefined;
  /** Below this confidence the value is Unsure; views.extract.min_confidence when absent. */
  min_confidence?: number | undefined;
}

/** A value an Extraction picked for one Thread, as code copied and normalized it. */
export interface ExtractedValue {
  /** The span as the Thread wrote it. */
  text: string;
  /** Normalized by code: `{value, currency}`, `YYYY-MM-DD`, `{url, domain}`, a number, or the text. */
  value: JsonValue;
  confidence: number;
}

/* ------------------------------ A Board's old layout ------------------------------ */

/** A column of a Board's old table layout; read as a table Block's column. */
export interface TableColumn {
  label: string;
  fact?: ViewFact | undefined;
  signal?: string | undefined;
  field?: RowField | undefined;
  format?: "text" | "number" | "date" | "percent" | undefined;
}

/** A Board's old `layout`: a stored Board document is read as a View with one Block of it. */
export type LaneLayout =
  | {
      component: "lanes";
      row?: { fields: RowField[] } | undefined;
      sort?: ViewSort | undefined;
      collapse_empty?: boolean | undefined;
    }
  | { component: "list"; row?: { fields: RowField[] } | undefined; sort?: ViewSort | undefined }
  | { component: "counts"; lanes?: string[] | undefined }
  | { component: "table"; columns: TableColumn[]; sort?: ViewSort | undefined }
  | {
      component: "timeline";
      date: "deadline_at" | "received_at" | "last_activity_at";
      range?: { days: number } | undefined;
    };

/** A correction the user made: evidence for a Signal, or a Thread moved to a Lane. */
export interface ViewExample {
  threadId: Id;
  /** For a Noul: whether the statement holds on this Thread. */
  holds?: boolean | undefined;
  /** The Lane the user put the Thread in ("Move to"). */
  lane?: string | undefined;
  /** For an Extraction: the span the user said is right, or null for "not stated". */
  value?: string | null | undefined;
  /** Who wrote and what it was about, for the question's Examples; sealed with the document. */
  from?: string | undefined;
  subject?: string | undefined;
  at?: IsoDate | undefined;
}

export interface ViewDoc {
  id: string;
  name: string;
  /** The user's own sentence. */
  sentence: string;
  version: number;
  scope: ViewScope;
  signals: ViewSignal[];
  /** Shipped Signals the View also reads. */
  uses: string[];
  /** Values taken from the text by selection. */
  extractions: ViewExtraction[];
  /** May be empty when no Block reads the Lanes. */
  lanes: Lane[];
  unsure: { label: string };
  /** Threads no Lane claims and none is unsure about: hidden, or a Lane of their own. */
  others: "hide" | { label: string };
  blocks: ViewBlock[];
  actions: ViewAction[];
  nav: { icon: string; count: string };
  /**
   * Corrections by what they are evidence for: a Signal's local id, `x:<id>`
   * for an Extraction's value, `_lanes` for the Move-to ones.
   */
  examples: Record<string, ViewExample[]>;
}

/* ------------------------------ Stored and synced ------------------------------ */

/* ------------------------------ The Agent's draft and its test (slice 40) ------------------------------ */

/** One Thread the test tried, as the View card shows it. */
export interface ViewTriedThread {
  threadId: Id;
  from: string;
  subject: string;
  lastActivity: IsoDate;
  /** A Lane id, `unsure` or `others`. */
  lane: string;
  notRead: boolean;
  /** 0 to 1: how clear the answers behind the placement are. */
  certainty: number;
  /** The answers behind it in words: "support request 94%", "blocked 2.1 of 2". */
  reasons: string[];
  /** The View's own Nouls on this Thread, for "Wrong". */
  nouls: Array<{ signal: string; label: string; noul: number | null }>;
  /** Each Extraction's value on this Thread, for its column and "Wrong value". */
  values: Array<{
    extraction: string;
    label: string;
    state: "value" | "unsure" | "empty" | "not_read";
    /** The span as written; null when none was picked. */
    text: string | null;
    confidence: number | null;
    /** The other spans code found, for "Wrong value". */
    candidates: string[];
  }>;
  /** The actions this Thread would carry, by label (disabled on the card). */
  actions: string[];
}

/** One Block as the card draws it small: its rows or groups in words. */
export interface BlockPreview {
  id: string;
  type: BlockType;
  title: string;
  /** The main number in words (a stat), or a text Block's words. */
  value: string | null;
  /** The change from the previous period in words ("up 12%"). */
  change: string | null;
  items: Array<{
    label: string;
    value?: string | undefined;
    count?: number | undefined;
    tone?: LaneTone | undefined;
    sub?: string | undefined;
  }>;
  /** Threads the query could not decide. */
  unsure: number;
}

/** What the test found: the Threads tried, the ones shown, the counts over all of them. */
export interface ViewTest {
  /** Threads asked. */
  tried: number;
  /** The ones the card shows: spread across the Lanes, least confident first. */
  shown: ViewTriedThread[];
  /** Per Lane id (and unsure, others) over every tried Thread. */
  counts: Record<string, number>;
  /** When the scope held too few: only its dates were widened, and how many the scope itself holds. */
  widened: { when: "today" | "this_week" | "scope"; count: number } | null;
  /** Nothing to try even after widening. */
  empty: boolean;
  /** Threads in the real scope, for the limit and the backfill estimate. */
  inScope: number;
  /**
   * How the tried Threads were chosen: `kept` tried before (a revision keeps the ones its
   * scope still admits), `fresh` the newest others in scope. When a Block adds up a value,
   * code looked through `scanned` Threads in scope and passed over `skipped` whose text holds
   * no value of that kind.
   */
  pool?: { kept: number; fresh: number; skipped?: number; scanned?: number } | undefined;
  /** After corrections: how many of them the View now agrees with. */
  agreement: { agree: number; total: number } | null;
  /** What a revision changed, in words. */
  changes: string[];
  /** The View reads mail through Signals and no judge answers (no TypeSafe key). */
  needsJudge: boolean;
  /** For an edit: Threads that would change Lane. */
  moves: Array<{ from: string; to: string; threadIds: Id[] }> | null;
  /** Each Block over the tried Threads, drawn small on the card. */
  blocks: BlockPreview[];
}

/** A View the Agent proposed and tried: pinned only when the user says so. */
export interface ViewDraft {
  id: Id;
  workspaceId: Id;
  /** The View an edit changes; null for a new one. */
  viewId: Id | null;
  status: "open" | "pinned" | "applied" | "discarded";
  doc: ViewDoc;
  /** For an edit: the document in effect before it. */
  previous: ViewDoc | null;
  test: ViewTest | null;
  /** The Threads the test tried, kept so a revision tries the same ones. */
  threadIds: Id[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** A Thread the user placed by hand: it stays in that Lane until the Thread changes. */
export interface ViewPlacement {
  lane: string;
  /** The Thread version it was placed at; a new Message lets the rules place it again. */
  messageCount: number;
  at: IsoDate;
  /** The Lane the rules had it in, so repeated moves out of a Lane can be counted. */
  from: string | null;
}

/** A View as the Server serves it: the current document and what lives beside it. */
export interface View {
  id: Id;
  workspaceId: Id;
  version: number;
  pinned: boolean;
  /** Position in the nav, from 0. */
  position: number;
  deletedAt: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  doc: ViewDoc;
  /** Threads the user placed by hand. */
  placements: Record<Id, ViewPlacement>;
  /** Pinned without a test (nothing to try it on): the "check its first placements" bar shows until dismissed. */
  checkBar: boolean;
  /** Checklist items checked, by Thread, at the Thread version checked. */
  done: Record<Id, ViewDone>;
}

/** A checklist item checked: it stays checked until the Thread changes. */
export interface ViewDone {
  messageCount: number;
  at: IsoDate;
}

/** The Changes feed's `view_values` row: a Thread whose picked values changed (headers only; the values are sealed). */
export interface ViewValuesChange {
  threadId: Id;
}

/** The Changes feed's `view` row: headers only; the document is sealed and read through GET /views. */
export interface ViewChange {
  id: Id;
  version: number;
  pinned: boolean;
  position: number;
  deleted: boolean;
  updatedAt: IsoDate;
}

/* ------------------------------ The zod shape ------------------------------ */

const text = (max: number) => z.string().trim().min(1).max(max);
const localId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "use lowercase letters, digits and underscores");
const address = z.string().trim().toLowerCase().min(3).max(320);
const domain = z.string().trim().toLowerCase().min(1).max(253);
/** A whole address: a bare domain in from_any or to_any matches nothing, so it is refused. */
const fullAddress = address.regex(
  /^[^@\s]+@[^@\s]+$/,
  "a whole address like orders@shop.com; a bare domain goes in from_domain",
);
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "a date like 2026-10-03");

const dateScope = z.union([
  z.object({ within: z.enum(["today", "this_week"]) }).strict(),
  z.object({ last_days: z.int().min(1).max(3650) }).strict(),
  z.object({ since: dateText }).strict(),
]);

export const scopeFactsSchema = z
  .object({
    received: dateScope.optional(),
    active: dateScope.optional(),
    from_any: z.array(fullAddress).max(50).optional(),
    from_domain: z.array(domain).max(50).optional(),
    from_domain_not: z.array(domain).max(50).optional(),
    to_any: z.array(fullAddress).max(50).optional(),
    folder: z
      .union([
        z.enum(["inbox", "any", "archive"]),
        z
          .string()
          .regex(/^(group|section):[^\s]+$/, "inbox, any, archive, group:<id> or section:<id>"),
      ])
      .optional(),
  })
  .strict();

const noulQuestion = z
  .object({
    type: z.literal("noul"),
    instructions: z.any(),
    criteria: z.object({ true: z.string().min(1), false: z.string().min(1) }).optional(),
  })
  .strict();
const choiceQuestion = z
  .object({
    type: z.literal("choice"),
    instructions: z.any(),
    criteria: z.record(z.string(), z.any()),
  })
  .strict();
const scoreQuestion = z
  .object({
    type: z.literal("score"),
    instructions: z.any(),
    criteria: z.array(z.any()).min(2).max(10),
  })
  .strict();

const viewSignal = z
  .object({
    id: localId,
    kind: z.enum(["noul", "choice", "score"]),
    label: z.string().trim().max(60).optional(),
    question: z.discriminatedUnion("type", [noulQuestion, choiceQuestion, scoreQuestion]),
  })
  .strict();

const dateRef = z.union([
  z.enum([
    "now",
    "today",
    "tomorrow",
    "end_of_today",
    "end_of_week",
    "end_of_next_week",
    "end_of_month",
  ]),
  z.object({ days: z.number().min(-3650).max(3650) }).strict(),
  dateText,
]);

const fieldRef = z.string().trim().min(1).max(80);

export const laneConditionSchema: z.ZodType<LaneCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(laneConditionSchema).min(1).max(12) }).strict(),
    z.object({ any: z.array(laneConditionSchema).min(1).max(12) }).strict(),
    z.object({ not: laneConditionSchema }).strict(),
    z.object({ scope: scopeFactsSchema }).strict(),
    z
      .object({
        signal: z.string().min(1).max(80),
        holds: z.boolean().optional(),
        fails: z.boolean().optional(),
        at_least: z.number().optional(),
        at_most: z.number().optional(),
        is: z.string().min(1).max(200).optional(),
      })
      .strict(),
    z
      .object({
        fact: z.enum(Object.keys(VIEW_FACTS) as [ViewFact, ...ViewFact[]]),
        is: z.union([z.boolean(), z.string().min(1).max(200)]).optional(),
        in: z.array(z.string().min(1).max(320)).min(1).max(50).optional(),
        at_least: z.number().optional(),
        at_most: z.number().optional(),
        before: dateRef.optional(),
        after: dateRef.optional(),
      })
      .strict(),
    z
      .object({
        extract: z.string().min(1).max(80),
        present: z.boolean().optional(),
        is: z.string().min(1).max(200).optional(),
        in: z.array(z.string().min(1).max(320)).min(1).max(50).optional(),
        at_least: z.number().optional(),
        at_most: z.number().optional(),
        before: dateRef.optional(),
        after: dateRef.optional(),
      })
      .strict(),
    z
      .object({
        lane: z.union([z.string().min(1).max(40), z.array(z.string().min(1).max(40)).min(1)]),
      })
      .strict(),
  ]),
) as z.ZodType<LaneCondition>;

const rowField = z.union([
  z.enum(ROW_FIELDS),
  z.string().regex(/^(signal|x):[a-z][a-z0-9_]*$/, "signal:<id> or x:<id>"),
]);

/** A Board's old layout, read as one Block (upgradeView). */
export const legacyLayoutSchema = z.discriminatedUnion("component", [
  z
    .object({
      component: z.literal("lanes"),
      row: z.object({ fields: z.array(rowField).min(1).max(8) }).optional(),
      sort: z.enum(VIEW_SORTS).optional(),
      collapse_empty: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      component: z.literal("list"),
      row: z.object({ fields: z.array(rowField).min(1).max(8) }).optional(),
      sort: z.enum(VIEW_SORTS).optional(),
    })
    .strict(),
  z
    .object({
      component: z.literal("counts"),
      lanes: z.array(z.string()).max(8).optional(),
    })
    .strict(),
  z
    .object({
      component: z.literal("table"),
      columns: z
        .array(
          z
            .object({
              label: text(40),
              fact: z.enum(Object.keys(VIEW_FACTS) as [ViewFact, ...ViewFact[]]).optional(),
              signal: z.string().min(1).max(80).optional(),
              field: rowField.optional(),
              format: z.enum(["text", "number", "date", "percent"]).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(8),
      sort: z.enum(VIEW_SORTS).optional(),
    })
    .strict(),
  z
    .object({
      component: z.literal("timeline"),
      date: z.enum(["deadline_at", "received_at", "last_activity_at"]),
      range: z.object({ days: z.int().min(1).max(365) }).optional(),
    })
    .strict(),
]);

/* ------------------------------ Queries ------------------------------ */

const groupBy = z
  .object({
    field: fieldRef,
    bucket: z.enum(TIME_BUCKETS).optional(),
  })
  .strict();

export const querySchema = z
  .object({
    /** Only Threads this holds on; an unknown one is counted as Unsure. */
    where: laneConditionSchema.optional(),
    /** Only Threads in these Lanes. */
    lanes: z.array(z.string().min(1).max(40)).min(1).max(8).optional(),
    /** One row per value of this Field; rows without one are kept. */
    dedupe: fieldRef.optional(),
    group_by: groupBy.optional(),
    aggregate: z
      .object({ op: z.enum(AGGREGATE_OPS), field: fieldRef.optional() })
      .strict()
      .optional(),
    sort: z
      .object({ by: fieldRef, dir: z.enum(["asc", "desc"]).optional() })
      .strict()
      .optional(),
    limit: z.int().min(1).max(5000).optional(),
    /** Only rows whose date Field falls in the current bucket (a stat's this month). */
    period: z
      .object({ field: fieldRef, bucket: z.enum(["day", "week", "month", "year"]) })
      .strict()
      .optional(),
  })
  .strict();
export type ViewQuery = z.output<typeof querySchema>;
export type GroupBy = z.output<typeof groupBy>;

/* ------------------------------ Blocks ------------------------------ */

const blockBase = {
  id: localId,
  title: z.string().trim().max(80).optional(),
  width: z.enum(BLOCK_WIDTHS).optional(),
  query: querySchema.optional(),
  /** The View's actions this Block's items carry, by id. */
  actions: z.array(localId).max(8).optional(),
};

const row = z.object({ fields: z.array(rowField).min(1).max(8) }).strict();

export const blockSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...blockBase,
      type: z.literal("lanes"),
      row: row.optional(),
      sort: z.enum(VIEW_SORTS).optional(),
      collapse_empty: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("list"),
      row: row.optional(),
      sort: z.enum(VIEW_SORTS).optional(),
      /** Headings by this Field instead of the Lane. */
      group_by: groupBy.optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("counts"),
      lanes: z.array(z.string()).max(8).optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("table"),
      columns: z
        .array(
          z
            .object({ label: text(40), field: fieldRef, format: z.enum(VALUE_FORMATS).optional() })
            .strict(),
        )
        .min(1)
        .max(8),
      sort: z.enum(VIEW_SORTS).optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("stat"),
      format: z.enum(VALUE_FORMATS).optional(),
      compare: z.literal("previous").optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("chart"),
      chart: z.enum(CHART_TYPES),
      /** A second grouping: the stacks of a stacked bar. */
      series: groupBy.optional(),
      format: z.enum(VALUE_FORMATS).optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("timeline"),
      date: fieldRef,
      range: z
        .object({ days: z.int().min(1).max(365) })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ ...blockBase, type: z.literal("calendar"), date: fieldRef }).strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("cards"),
      card_title: fieldRef.optional(),
      subtitle: fieldRef.optional(),
      badges: z.array(fieldRef).max(4).optional(),
      value: fieldRef.optional(),
      value_format: z.enum(VALUE_FORMATS).optional(),
    })
    .strict(),
  z.object({ ...blockBase, type: z.literal("people"), by: z.enum(["person", "company"]) }).strict(),
  z.object({ ...blockBase, type: z.literal("checklist"), item: fieldRef.optional() }).strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("heatmap"),
      date: fieldRef,
      grid: z.enum(["weekday_hour", "week_weekday"]).optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("text"),
      text: z.string().trim().min(1).max(280),
      tone: z.enum(LANE_TONES).optional(),
    })
    .strict(),
]);
export type ViewBlock = z.output<typeof blockSchema>;
export type BlockOf<T extends BlockType> = Extract<ViewBlock, { type: T }>;

/* ------------------------------ Actions on items ------------------------------ */

const actionDo = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("run_workflow"),
      workflow: z.string().min(1).max(80),
      /** Fields mapped into the Run's inputs. */
      inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), fieldRef).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("archive") }).strict(),
  z.object({ kind: z.literal("mark_read") }).strict(),
  z.object({ kind: z.literal("mark_unread") }).strict(),
  z.object({ kind: z.literal("mark_done") }).strict(),
  z
    .object({
      kind: z.literal("snooze"),
      /** A date Field, or a preset. */
      until: z.union([z.enum(SNOOZE_PRESETS), fieldRef]),
    })
    .strict(),
  z.object({ kind: z.literal("move"), group: z.string().min(1).max(80) }).strict(),
  z.object({ kind: z.literal("tag"), tag: z.string().trim().min(1).max(60) }).strict(),
  z.object({ kind: z.literal("reply_template"), template: z.string().min(1).max(80) }).strict(),
  z
    .object({
      kind: z.literal("forward"),
      /** An address Field, or a fixed address. */
      to: z.string().trim().min(1).max(320),
    })
    .strict(),
  z.object({ kind: z.literal("open_link"), link: fieldRef }).strict(),
  z
    .object({ kind: z.literal("add_to_calendar"), date: fieldRef, title: fieldRef.optional() })
    .strict(),
  z.object({ kind: z.literal("custom_action"), action: z.string().min(1).max(80) }).strict(),
  z.object({ kind: z.literal("set_lane"), lane: z.string().min(1).max(40) }).strict(),
  z.object({ kind: z.literal("ask_agent"), prompt: z.string().trim().min(1).max(500) }).strict(),
]);

export const actionSchema = z
  .object({
    id: localId,
    label: text(40),
    icon: z.enum(ACTION_ICONS),
    /** Each row or card, a Lane's or group's header (every Thread in it), or both. */
    on: z.enum(["row", "group", "both"]).default("row"),
    /** Three-valued: the button hides when this is false or unknown. */
    when: laneConditionSchema.optional(),
    do: actionDo,
  })
  .strict();
export type ViewAction = z.output<typeof actionSchema>;
export type ActionDo = ViewAction["do"];

/* ------------------------------ The document ------------------------------ */

const extraction = z
  .object({
    id: localId,
    label: z.string().trim().max(40).optional(),
    find: z.enum(EXTRACT_KINDS),
    question: z.union([z.string().trim().min(1).max(600), z.record(z.string(), z.any())]),
    none: z.string().trim().min(1).max(300).optional(),
    min_confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

const example = z
  .object({
    threadId: z.string().min(1),
    holds: z.boolean().optional(),
    lane: z.string().optional(),
    value: z.string().max(500).nullable().optional(),
    from: z.string().max(320).optional(),
    subject: z.string().max(500).optional(),
    at: z.string().optional(),
  })
  .strict();

export const viewDocSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,64}$/, "lowercase letters, digits, _ and -"),
    name: text(60),
    sentence: z.string().max(1000).default(""),
    version: z.int().min(0).default(0),
    scope: z
      .object({ facts: scopeFactsSchema.default({}), limit: z.int().min(1).max(100_000) })
      .strict(),
    signals: z.array(viewSignal).default([]),
    uses: z.array(z.string().min(1).max(80)).default([]),
    extractions: z.array(extraction).default([]),
    lanes: z
      .array(
        z
          .object({
            id: localId,
            label: text(40),
            tone: z.enum(LANE_TONES),
            when: laneConditionSchema,
          })
          .strict(),
      )
      .default([]),
    unsure: z
      .object({ label: text(40) })
      .strict()
      .default({ label: "Unsure" }),
    others: z.union([z.literal("hide"), z.object({ label: text(40) }).strict()]).default("hide"),
    blocks: z.array(blockSchema).min(1),
    actions: z.array(actionSchema).default([]),
    nav: z
      .object({ icon: z.string().min(1).max(40), count: z.string().min(1).max(40) })
      .strict()
      .default({ icon: "kanban", count: "total" }),
    examples: z.record(z.string(), z.array(example).max(200)).default({}),
  })
  .strict();
