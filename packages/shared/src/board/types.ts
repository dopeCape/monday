// The Board document (CONTEXT.md "Board", "Lane"; docs/spec/boards.md): a
// JSON document the Agent writes, validated against this schema, versioned
// like a Workflow (ADR 0003's shape). A code-only scope of exact Facts, the
// Board's own Signals (ADR 0014), ordered Lanes with three-valued conditions,
// a layout from a fixed catalog and the nav entry. Runtime-neutral: types,
// the closed lists, and the zod shape.

import { z } from "zod";
import type { Id, IsoDate } from "../domain.ts";
import type { SignalQuestion } from "../signals.ts";

/* ------------------------------ The closed lists ------------------------------ */

/** The palette's semantic colours a Lane may take; no free colours. */
export const LANE_TONES = ["danger", "warning", "ok", "info", "muted"] as const;
export type LaneTone = (typeof LANE_TONES)[number];

/** The component catalog (docs/spec/boards.md): the Agent names one and fills its props. */
export const BOARD_COMPONENTS = ["lanes", "list", "counts", "table", "timeline"] as const;
export type BoardComponent = (typeof BOARD_COMPONENTS)[number];

/** What a Board row may show, from a closed list; `signal:<id>` shows a small label with the answer. */
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
export type RowField = (typeof ROW_FIELDS)[number] | `signal:${string}`;

export const BOARD_SORTS = ["newest_first", "oldest_first", "deadline_first"] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

/** The icons a Board may carry in the nav, by the names the Group icons use. */
export const BOARD_ICONS = [
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
export type BoardIcon = (typeof BOARD_ICONS)[number];

/**
 * The Facts a Lane condition may test (docs/spec/signals.md, "Facts"), by
 * the test they take: a flag (`is`), a number (`at_least`, `at_most`), a
 * date (`before`, `after`) or a text (`is`, `in`). Code computes them; the
 * model never compares a date, a count or an amount.
 */
export const BOARD_FACTS = {
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
export type BoardFact = keyof typeof BOARD_FACTS;

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
export type BoardFolder = "inbox" | "any" | "archive" | `group:${string}` | `section:${string}`;

/** The scope's exact filters: code only, never a model. */
export interface BoardScopeFacts {
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
  folder?: BoardFolder | undefined;
}

export interface BoardScope {
  facts: BoardScopeFacts;
  /** The most Threads the Board looks at, newest first; at most boards.scope.max_threads. */
  limit: number;
}

/** One of the Board's own Signals, asked only inside its scope. */
export interface BoardSignal {
  /** Local to the Board; stored as `board:<boardId>:<id>`. */
  id: string;
  kind: "noul" | "choice" | "score";
  /** A few words for the card's reasons ("support request", "blocked"). */
  label?: string | undefined;
  question: SignalQuestion;
}

/**
 * A test on one Signal (the Board's own or a shipped one the Board `uses`):
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
  fact: BoardFact;
  is?: boolean | string | undefined;
  in?: string[] | undefined;
  at_least?: number | undefined;
  at_most?: number | undefined;
  before?: DateRef | undefined;
  after?: DateRef | undefined;
}

export type LaneCondition =
  | { all: LaneCondition[] }
  | { any: LaneCondition[] }
  | { not: LaneCondition }
  | { scope: BoardScopeFacts }
  | SignalTest
  | FactTest;

export interface Lane {
  id: string;
  label: string;
  tone: LaneTone;
  when: LaneCondition;
}

export interface TableColumn {
  label: string;
  fact?: BoardFact | undefined;
  signal?: string | undefined;
  field?: RowField | undefined;
  format?: "text" | "number" | "date" | "percent" | undefined;
}

export type BoardLayout =
  | {
      component: "lanes";
      row?: { fields: RowField[] } | undefined;
      sort?: BoardSort | undefined;
      collapse_empty?: boolean | undefined;
    }
  | { component: "list"; row?: { fields: RowField[] } | undefined; sort?: BoardSort | undefined }
  | { component: "counts"; lanes?: string[] | undefined }
  | { component: "table"; columns: TableColumn[]; sort?: BoardSort | undefined }
  | {
      component: "timeline";
      date: "deadline_at" | "received_at" | "last_activity_at";
      range?: { days: number } | undefined;
    };

/** A correction the user made: evidence for a Signal, or a Thread moved to a Lane. */
export interface BoardExample {
  threadId: Id;
  /** For a Noul: whether the statement holds on this Thread. */
  holds?: boolean | undefined;
  /** The Lane the user put the Thread in ("Move to"). */
  lane?: string | undefined;
  /** Who wrote and what it was about, for the question's Examples; sealed with the document. */
  from?: string | undefined;
  subject?: string | undefined;
  at?: IsoDate | undefined;
}

export interface BoardDoc {
  id: string;
  name: string;
  /** The user's own sentence. */
  sentence: string;
  version: number;
  scope: BoardScope;
  signals: BoardSignal[];
  /** Shipped Signals the Lanes also read. */
  uses: string[];
  lanes: Lane[];
  unsure: { label: string };
  /** Threads no Lane claims and none is unsure about: hidden, or a Lane of their own. */
  others: "hide" | { label: string };
  layout: BoardLayout;
  nav: { icon: string; count: string };
  /** Corrections by the Signal they are evidence for; `_lanes` holds the Move-to ones. */
  examples: Record<string, BoardExample[]>;
}

/* ------------------------------ Stored and synced ------------------------------ */

/* ------------------------------ The Agent's draft and its test (slice 40) ------------------------------ */

/** One Thread the test tried, as the Board card shows it. */
export interface BoardTriedThread {
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
  /** The Board's own Nouls on this Thread, for "Wrong". */
  nouls: Array<{ signal: string; label: string; noul: number | null }>;
}

/** What the test found: the Threads tried, the ones shown, the counts over all of them. */
export interface BoardTest {
  /** Threads asked. */
  tried: number;
  /** The ones the card shows: spread across the Lanes, least confident first. */
  shown: BoardTriedThread[];
  /** Per Lane id (and unsure, others) over every tried Thread. */
  counts: Record<string, number>;
  /** When the scope held too few: only its dates were widened, and how many the scope itself holds. */
  widened: { when: "today" | "this_week" | "scope"; count: number } | null;
  /** Nothing to try even after widening. */
  empty: boolean;
  /** Threads in the real scope, for the limit and the backfill estimate. */
  inScope: number;
  /** After corrections: how many of them the Board now agrees with. */
  agreement: { agree: number; total: number } | null;
  /** What a revision changed, in words. */
  changes: string[];
  /** The Board reads mail through Signals and no judge answers (no TypeSafe key). */
  needsJudge: boolean;
  /** For an edit: Threads that would change Lane. */
  moves: Array<{ from: string; to: string; threadIds: Id[] }> | null;
}

/** A Board the Agent proposed and tried: pinned only when the user says so. */
export interface BoardDraft {
  id: Id;
  workspaceId: Id;
  /** The Board an edit changes; null for a new one. */
  boardId: Id | null;
  status: "open" | "pinned" | "applied" | "discarded";
  doc: BoardDoc;
  /** For an edit: the document in effect before it. */
  previous: BoardDoc | null;
  test: BoardTest | null;
  /** The Threads the test tried, kept so a revision tries the same ones. */
  threadIds: Id[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** A Thread the user placed by hand: it stays in that Lane until the Thread changes. */
export interface BoardPlacement {
  lane: string;
  /** The Thread version it was placed at; a new Message lets the rules place it again. */
  messageCount: number;
  at: IsoDate;
  /** The Lane the rules had it in, so repeated moves out of a Lane can be counted. */
  from: string | null;
}

/** A Board as the Server serves it: the current document and what lives beside it. */
export interface Board {
  id: Id;
  workspaceId: Id;
  version: number;
  pinned: boolean;
  /** Position in the nav, from 0. */
  position: number;
  deletedAt: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  doc: BoardDoc;
  /** Threads the user placed by hand. */
  placements: Record<Id, BoardPlacement>;
  /** Pinned without a test (nothing to try it on): the "check its first placements" bar shows until dismissed. */
  checkBar: boolean;
}

/** The Changes feed's `board` row: headers only; the document is sealed and read through GET /boards. */
export interface BoardChange {
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
    from_any: z.array(address).max(50).optional(),
    from_domain: z.array(domain).max(50).optional(),
    from_domain_not: z.array(domain).max(50).optional(),
    to_any: z.array(address).max(50).optional(),
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

const boardSignal = z
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
        fact: z.enum(Object.keys(BOARD_FACTS) as [BoardFact, ...BoardFact[]]),
        is: z.union([z.boolean(), z.string().min(1).max(200)]).optional(),
        in: z.array(z.string().min(1).max(320)).min(1).max(50).optional(),
        at_least: z.number().optional(),
        at_most: z.number().optional(),
        before: dateRef.optional(),
        after: dateRef.optional(),
      })
      .strict(),
  ]),
) as z.ZodType<LaneCondition>;

const rowField = z.union([
  z.enum(ROW_FIELDS),
  z.string().regex(/^signal:[a-z][a-z0-9_]*$/, "signal:<id>"),
]);

const layout = z.discriminatedUnion("component", [
  z
    .object({
      component: z.literal("lanes"),
      row: z.object({ fields: z.array(rowField).min(1).max(8) }).optional(),
      sort: z.enum(BOARD_SORTS).optional(),
      collapse_empty: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      component: z.literal("list"),
      row: z.object({ fields: z.array(rowField).min(1).max(8) }).optional(),
      sort: z.enum(BOARD_SORTS).optional(),
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
              fact: z.enum(Object.keys(BOARD_FACTS) as [BoardFact, ...BoardFact[]]).optional(),
              signal: z.string().min(1).max(80).optional(),
              field: rowField.optional(),
              format: z.enum(["text", "number", "date", "percent"]).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(8),
      sort: z.enum(BOARD_SORTS).optional(),
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

const example = z
  .object({
    threadId: z.string().min(1),
    holds: z.boolean().optional(),
    lane: z.string().optional(),
    from: z.string().max(320).optional(),
    subject: z.string().max(500).optional(),
    at: z.string().optional(),
  })
  .strict();

export const boardDocSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,64}$/, "lowercase letters, digits, _ and -"),
    name: text(60),
    sentence: z.string().max(1000).default(""),
    version: z.int().min(0).default(0),
    scope: z
      .object({ facts: scopeFactsSchema.default({}), limit: z.int().min(1).max(100_000) })
      .strict(),
    signals: z.array(boardSignal).default([]),
    uses: z.array(z.string().min(1).max(80)).default([]),
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
      .min(1),
    unsure: z.object({ label: text(40) }).strict(),
    others: z.union([z.literal("hide"), z.object({ label: text(40) }).strict()]).default("hide"),
    layout,
    nav: z.object({ icon: z.string().min(1).max(40), count: z.string().min(1).max(40) }).strict(),
    examples: z.record(z.string(), z.array(example).max(200)).default({}),
  })
  .strict();
