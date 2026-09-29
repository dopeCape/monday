// Routing (CONTEXT.md "Group", "Routing rule", "Predicate", "Example",
// "Confidence", "Needs a decision"; docs/spec/inbox.md; ADR 0004): Groups as
// data, the two-stage classify call through the Hosted runtime, thresholds
// to placement, corrections that become Examples and revise the Predicate,
// and the re-run with preview. Every placement routing makes is an
// automation `move` intent through the Mailstore, so a user's move always
// beats it (ADR 0005); every Group and decision reaches the client through
// the Changes feed. The `route` Job kind runs one Thread on the Server.
//
// Each stage is a Judgment when the judge is available (ADR 0012, slice 25):
// one Choice over the candidate Groups plus none, placed by its probabilities
// and its confidence (judge.ts). Without a judge the classify prompt runs as
// before, so both paths place the fixture mailbox the same way.

import type {
  AiLevel,
  BriefPolicy,
  ChoiceQuestion,
  Confidence,
  CorrectionResult,
  DecisionCandidate,
  GroupExample,
  GroupId,
  GroupInput,
  GroupView,
  Id,
  Intent,
  JsonValue,
  JudgeAnswer,
  Person,
  Predicate,
  ProposedMove,
  RerunProgress,
  RouteBy,
  RoutePlacement,
  RoutingApplied,
  RoutingDecision,
  RoutingPreview,
  Score,
  SortScope,
  ThreadRoute,
  Thresholds,
} from "@monday/shared";
import {
  domainMatches,
  domainOf,
  formatSortScope,
  matchesPredicate,
  mergePredicates,
  parseSortScope,
  place,
  settingsSchema,
} from "@monday/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { LockedError } from "../../crypto/keys.ts";
import type { Db, Tx } from "../../db/client.ts";
import {
  accounts,
  examples,
  groups,
  messages,
  routingDecisions,
  threadRoutes,
  threads,
  workspaces,
} from "../../db/schema.ts";
import type { Job, Jobs } from "../../jobs/index.ts";
import { type Mailstore, NotFoundError } from "../../mailstore/index.ts";
import {
  type HostedRuntime,
  type JudgeResult,
  NoJudgeError,
  NoProviderKeyError,
} from "../runtime/index.ts";
import { LocalRuntimeTimeoutError } from "../runtime/local.ts";
import { eachPool } from "../signals/pool.ts";
import {
  type BatchItem,
  batchQuestion,
  classifyBatchPrompt,
  classifyBatchSystemPrompt,
  estimateTokens,
  groupsJson,
  packBatches,
  parseClassifyBatchOutput,
  routeBatchQuestions,
  threadJson,
} from "./batch.ts";
import {
  classifyPrompt,
  classifySystemPrompt,
  type GroupText,
  parseClassifyOutput,
  parseReviseOutput,
  revisePrompt,
  reviseSystemPrompt,
  type ThreadFacts,
} from "./classify.ts";
import { type JudgedStage, judgedPlacement, routeQuestion } from "./judge.ts";
import { countInScope, pageInScope, resolveScope } from "./scope-query.ts";

export type { GroupText, ThreadFacts } from "./classify.ts";
export {
  ClassifyOutputError,
  classifyPrompt,
  classifySystemPrompt,
  parseClassifyOutput,
  parseReviseOutput,
  revisePrompt,
  reviseSystemPrompt,
  threadFactsText,
} from "./classify.ts";
export type { JudgedStage, RouteJudgeSettings, RouteQuestion } from "./judge.ts";
export { judgedPlacement, NONE_OPTION, optionName, routeQuestion } from "./judge.ts";

export const ROUTE_STEP = "route";

export interface RouteJobPayload {
  workspaceId: Id;
  threadId: Id;
}

/** The routing Settings, read once per operation (ADR 0004). */
export interface RoutingSettings {
  thresholds: Thresholds;
  decisionsCap: number;
  learnFromCorrections: boolean;
  onArrival: boolean;
  predicateFirst: boolean;
  /** The Group a Thread stays in when nothing is confident enough; "" for none. */
  defaultGroup: string;
  snippetChars: number;
  examplesInPrompt: number;
  rerunRecent: number;
  /** How many Threads a re-run scores at once. */
  rerunConcurrency?: number;
  lookbackDays: number;
  briefPolicyDefault: BriefPolicy;
  /** The routing Choice's wording (routing.judge.*), for the judge path. */
  judge: { instructions: string; noneOption: string };
  /**
   * routing.wait_seconds: how long a route Job sleeps when nothing can sort
   * (no judge, no language model), instead of failing. Absent means the default.
   */
  waitSeconds?: number;
  /** routing.rerun.scope: what a re-run covers when neither a scope nor a count is asked for. */
  rerunScope?: string;
  /** routing.rerun.preview_max: up to this many Threads a scoped re-run scores every one. */
  rerunPreviewMax?: number;
  /** routing.rerun.sample: how many of the newest a larger scoped re-run scores. */
  rerunSample?: number;
  /** The routing.backfill.* batch Settings a Backlog sort sends with; absent means the defaults. */
  backfill?: BackfillSettings;
}

/** How a Backlog sort batches its requests (routing.backfill.*). */
export interface BackfillSettings {
  /** Threads per TypeSafe request. */
  batchSize: number;
  /** State plus every question, in tokens. */
  requestTokens: number;
  /** State plus the longest question, in tokens. */
  stateTokens: number;
  /** Threads per language model prompt. */
  llmBatchSize: number;
  /** Requests in flight at once on TypeSafe. */
  concurrency: number;
}

export function defaultBackfillSettings(): BackfillSettings {
  return {
    batchSize: settingsSchema["routing.backfill.batch_size"].default,
    requestTokens: settingsSchema["routing.backfill.request_tokens"].default,
    stateTokens: settingsSchema["routing.backfill.state_tokens"].default,
    llmBatchSize: settingsSchema["routing.backfill.llm_batch_size"].default,
    concurrency: settingsSchema["routing.backfill.concurrency"].default,
  };
}

/** What routing many Threads at once did (a Backlog sort's batch). */
export interface RouteManyResult {
  /** Placed in a Group other than where they were. */
  moved: number;
  /** Sent to Needs a decision. */
  asked: number;
  /** Left where they were, or out of every Group. */
  left: number;
  /** Placed by the user, so left alone. */
  skipped: number;
  /** Requests to whoever sorts. */
  calls: number;
  /** Batched requests sent, and the size of the last one. */
  batches: number;
  batchSize: number;
  /** Who sorted: TypeSafe, a language model, or nobody (Predicates alone, or nothing to sort). */
  sorter: "typesafe" | "llm" | null;
}

export interface RoutingOptions {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  settings: () => Promise<RoutingSettings>;
  now?: () => Date;
  log?: (message: string) => void;
  /** The AI level (CONTEXT.md): routing on arrival only at `automate`. Absent means `automate`. */
  level?: () => Promise<AiLevel>;
}

/**
 * One request for one Thread carrying routing's Choices (slice 29): the
 * stage-one Group Choice and a speculative Sub-group Choice per Group that
 * has Sub-groups. The default asks the judge over routing's own state; the
 * Signals module replaces it so the same request also carries every Signal
 * the Thread lacks (slice 31), never asking one Thread twice.
 */
export interface OneThreadRequest {
  workspaceId: Id;
  threadId: Id;
  facts: ThreadFacts;
  /** Routing's own state for the Thread (routeQuestion). */
  state: JsonValue;
  questions: Record<string, ChoiceQuestion>;
  jobId: string | null;
}
export type OneThreadAsk = (
  request: OneThreadRequest,
) => Promise<{ answers: Record<string, JudgeAnswer | undefined>; calls: number }>;

/** A Group that does not exist yet, scored beside the stored ones by a preview (onboarding's proposals). */
export interface CandidateGroup extends GroupInput {
  /** The id the preview's moves name it by; the caller maps it to the Group it creates. */
  id: GroupId;
}

/** What the classify call decided for one Thread, before anything is applied. */
export interface Scored {
  scores: Score[];
  placement: RoutePlacement;
  subgroup: { groupId: GroupId; confidence: Confidence } | null;
  by: RouteBy;
  /** Hosted calls made. */
  calls: number;
}

export interface RoutingCallOptions {
  jobId?: string | null;
  /**
   * A proposed wording or threshold in place of the Settings, for a test of
   * a change before it is made (tune.ts). Only `classify` reads it; nothing
   * scored with an override is ever applied.
   */
  override?: RoutingOverride | undefined;
}

/** What a judgment test may put in place of the routing Settings. */
export interface RoutingOverride {
  thresholds?: Partial<Thresholds> | undefined;
  judge?: Partial<RoutingSettings["judge"]> | undefined;
}

export interface Routing {
  listGroups(workspaceId: Id): Promise<GroupView[]>;
  getGroup(groupId: Id): Promise<GroupView | null>;
  createGroup(workspaceId: Id, input: GroupInput): Promise<GroupView>;
  updateGroup(groupId: Id, patch: Partial<GroupInput>): Promise<GroupView>;
  /** Removes the Group and its Sub-groups; their Threads fall back to the parent or to no Group. */
  deleteGroup(groupId: Id): Promise<void>;
  /** Scores a Thread against the Workspace's Groups without moving anything. */
  classify(threadId: Id, options?: RoutingCallOptions): Promise<Scored>;
  /** Scores and applies: a move, a Needs a decision entry, or the default Group. */
  route(threadId: Id, options?: RoutingCallOptions): Promise<ThreadRoute | null>;
  routeOf(threadId: Id): Promise<ThreadRoute | null>;
  /** Enqueues the route Job for a Thread. With `id`, a duplicate is ignored (the arrival path). */
  enqueue(workspaceId: Id, threadId: Id, options?: { id?: string }): Promise<string>;
  /** The sync engine's new-Thread hook: enqueues under the Settings, or returns null. */
  onArrival(workspaceId: Id, threadId: Id, lastActivity: string): Promise<string | null>;
  decisions(workspaceId: Id): Promise<RoutingDecision[]>;
  /** The user's answer to Needs a decision: a Group, or null to leave the Thread out. */
  decide(threadId: Id, groupId: GroupId | null, at?: string): Promise<CorrectionResult>;
  /**
   * A user move that landed: records the correction as Examples and revises
   * the target Group's Predicate with one route call. Null when learning is off.
   */
  observeMove(
    intent: Extract<Intent, { kind: "move" }>,
    previous: { group: GroupId | null; subgroup: GroupId | null },
  ): Promise<CorrectionResult | null>;
  /**
   * Dry-runs routing over the newest Threads and reports what would move.
   * With `candidates`, Groups that are not stored yet are scored beside the
   * stored ones, so a proposal shows its counts before anything is created.
   */
  preview(
    workspaceId: Id,
    options?: {
      recent?: number;
      /**
       * The Sort scope to dry-run over, in place of `recent`. Up to
       * routing.rerun.preview_max Threads every one is scored; above it the
       * newest routing.rerun.sample are, and the preview says it is a sample.
       */
      scope?: SortScope;
      /** With a scope: score only the newest this many, whatever the scope holds (a Group proposal). */
      sample?: number;
      candidates?: readonly CandidateGroup[];
      /** Called after each Thread is scored, for a re-run that shows its progress. */
      onProgress?: (progress: RerunProgress) => void;
    },
  ): Promise<RoutingPreview>;
  /** Applies moves a preview proposed. */
  apply(workspaceId: Id, moves: readonly ProposedMove[]): Promise<RoutingApplied>;
  /**
   * Scores and applies many Threads with batched requests (a Backlog sort):
   * TypeSafe gets up to routing.backfill.batch_size Threads per request
   * under its token budget, a language model a few per prompt. Same
   * Predicates, thresholds and placement as arrival routing; a Thread the
   * user placed is left alone. Throws what the runtime throws when nothing
   * can sort (NoProviderKeyError, LocalRuntimeTimeoutError).
   */
  routeMany(
    workspaceId: Id,
    threadIds: readonly Id[],
    options?: { jobId?: string | null },
  ): Promise<RouteManyResult>;
  /**
   * Records a Thread as an Example for a Group, the way a correction does,
   * without moving it or revising the Group's criteria. Returns what the
   * Thread was for that Group before, so Undo can put it back.
   */
  recordExample(
    threadId: Id,
    groupId: GroupId,
    positive: boolean,
  ): Promise<{ previous: { positive: boolean } | null }>;
  /** Removes an Example, or restores the one it replaced; false when the Group or Thread is gone. */
  restoreExample(
    threadId: Id,
    groupId: GroupId,
    previous: { positive: boolean } | null,
  ): Promise<boolean>;
  /**
   * What a judgment over these Threads reads, exactly as routing builds it:
   * the owner, the routing Settings, every Group with its Examples, and the
   * facts per Thread (a Thread that cannot be read is left out). For the
   * batching measurement and the Signal request. Decrypts, so it needs the root key.
   */
  judgeInputs(workspaceId: Id, threadIds: readonly Id[]): Promise<JudgeInputs>;
  /**
   * Who asks a Backlog sort's one-Thread requests; null puts back routing's
   * own (the judge over routing's state). The Signals module sets it.
   */
  setOneThreadAsk(ask: OneThreadAsk | null): void;
  /**
   * An arriving Thread's routing questions, when it is routed now (slice 33),
   * and how their answers place it; null when routing leaves it alone.
   */
  arrivalPlan(threadId: Id): Promise<ArrivalPlan | null>;
  /**
   * Who asks the arrival request (slice 33): set, the route Job hands an
   * arriving Thread to it when TypeSafe answers, so routing, Sections, the
   * brief policy and custom actions are one request. Null keeps routing's own.
   */
  setArrivalAsk(
    ask: ((workspaceId: Id, threadId: Id, jobId: string | null) => Promise<void>) | null,
  ): void;
  registerSteps(jobs: Jobs): void;
}

/** An arriving Thread's routing questions and how their answers place it (slice 33). */
export interface ArrivalPlan {
  workspaceId: Id;
  questions: Record<string, ChoiceQuestion>;
  apply(answers: Record<string, JudgeAnswer | undefined>): Promise<ThreadRoute | null>;
}

/** What judgeInputs returns. */
export interface JudgeInputs {
  owner: string;
  settings: RoutingSettings;
  /** Every Group, top-level first, with its parent and its own threshold. */
  groups: Array<GroupText & { parentId: GroupId | null; threshold: Confidence | null }>;
  facts: Map<Id, ThreadFacts>;
}

/** A Sub-group under a Sub-group, or a parent that does not exist. */
export class GroupNestingError extends Error {
  constructor(readonly detail: string) {
    super(`group nesting: ${detail}`);
    this.name = "GroupNestingError";
  }
}

type GroupRow = typeof groups.$inferSelect;
type ThreadRow = typeof threads.$inferSelect;

export function createRouting(options: RoutingOptions): Routing {
  const { db, mailstore, runtime } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const level = options.level ?? (async (): Promise<AiLevel> => "automate");
  let jobs: Jobs | null = null;

  /* ------------------------------ Reading ------------------------------ */

  const requireThread = async (threadId: Id): Promise<ThreadRow> => {
    const row = await db.query.threads.findFirst({ where: eq(threads.id, threadId) });
    if (!row) throw new NotFoundError("thread", threadId);
    return row;
  };

  const requireGroup = async (groupId: Id): Promise<GroupRow> => {
    const row = await db.query.groups.findFirst({ where: eq(groups.id, groupId) });
    if (!row) throw new NotFoundError("group", groupId);
    return row;
  };

  /** The revised criteria text, decrypted; the sentence when none was revised; "" when locked. */
  const promptOf = async (g: GroupRow): Promise<string> => {
    if (!g.promptEnc || !g.promptKey) return "";
    try {
      return await mailstore.readText({
        workspaceId: g.workspaceId,
        kind: "rule",
        key: g.promptKey,
        chunks: [g.promptEnc],
        size: -1,
      });
    } catch (error) {
      if (error instanceof LockedError) return "";
      throw error;
    }
  };

  const examplesOf = async (workspaceId: Id): Promise<Map<GroupId, GroupExample[]>> => {
    const rows = await db
      .select()
      .from(examples)
      .where(eq(examples.workspaceId, workspaceId))
      .orderBy(desc(examples.at));
    const out = new Map<GroupId, GroupExample[]>();
    for (const r of rows) {
      const list = out.get(r.groupId) ?? [];
      list.push({
        threadId: r.threadId,
        positive: r.positive,
        from: r.from ?? null,
        subject: r.subject,
        at: r.at.toISOString(),
      });
      out.set(r.groupId, list);
    }
    return out;
  };

  const groupRows = (workspaceId: Id) =>
    db
      .select()
      .from(groups)
      .where(eq(groups.workspaceId, workspaceId))
      .orderBy(sql`${groups.parentId} nulls first`, asc(groups.createdAt), asc(groups.name));

  /** Groups as the prompts describe them. */
  const groupTexts = async (workspaceId: Id): Promise<Array<GroupText & { row: GroupRow }>> => {
    const rows = await groupRows(workspaceId);
    const byGroup = await examplesOf(workspaceId);
    const out: Array<GroupText & { row: GroupRow }> = [];
    for (const row of rows) {
      out.push({
        row,
        id: row.id,
        name: row.name,
        sentence: row.sentence,
        prompt: await promptOf(row),
        predicate: row.predicate,
        examples: (byGroup.get(row.id) ?? []).map((e) => ({
          positive: e.positive,
          from: e.from,
          subject: e.subject,
        })),
      });
    }
    return out;
  };

  /** The newest Message's sender on a Thread, from headers alone. */
  const newestSender = async (threadId: Id): Promise<Person | null> => {
    const row = await db.query.messages.findFirst({
      where: eq(messages.threadId, threadId),
      orderBy: desc(messages.date),
      columns: { from: true },
    });
    return row?.from ?? null;
  };

  /** Headers plus the newest snippet: what the classify Task reads. Decrypts, so it needs the root key. */
  const readFacts = async (row: ThreadRow): Promise<ThreadFacts> => {
    const subject = await mailstore.readThreadSubject(row.id);
    const headers = await mailstore.listMessages(row.id);
    const newest = headers[headers.length - 1] ?? null;
    const snippet = newest ? (await mailstore.readMessageBody(newest.id)).snippet : "";
    return {
      subject,
      from: newest?.from ?? row.participants[0] ?? null,
      to: newest?.to ?? [],
      participants: row.participants,
      headers: newest?.headers ?? {},
      snippet,
      hasAttachments: row.hasAttachments,
      messageCount: row.messageCount,
    };
  };

  const toView = async (
    row: GroupRow,
    byGroup: Map<GroupId, GroupExample[]>,
    stats: Map<GroupId, { threads: number; unread: number; confidence: number | null }>,
  ): Promise<GroupView> => {
    const prompt = await promptOf(row);
    const s = stats.get(row.id);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      parentId: row.parentId,
      name: row.name,
      rule: { sentence: row.sentence, predicate: row.predicate, prompt: prompt || row.sentence },
      threshold: row.threshold,
      briefPolicy: row.briefPolicy,
      examples: byGroup.get(row.id) ?? [],
      threads: s?.threads ?? 0,
      unread: s?.unread ?? 0,
      confidence: s?.confidence ?? null,
    };
  };

  /** Thread and unread counts, and the mean Confidence, per Group and Sub-group. */
  const statsOf = async (workspaceId: Id) => {
    const out = new Map<GroupId, { threads: number; unread: number; confidence: number | null }>();
    const live = and(
      eq(threads.workspaceId, workspaceId),
      eq(threads.archived, false),
      eq(threads.deleted, false),
    );
    for (const column of [threads.groupId, threads.subgroupId]) {
      const rows = await db
        .select({
          id: column,
          threads: sql<number>`count(*)::int`,
          unread: sql<number>`count(*) filter (where ${threads.unread})::int`,
        })
        .from(threads)
        .where(live)
        .groupBy(column);
      for (const r of rows) {
        if (!r.id) continue;
        out.set(r.id, { threads: r.threads, unread: r.unread, confidence: null });
      }
    }
    const scored = await db
      .select({
        id: threadRoutes.groupId,
        confidence: sql<number | null>`avg(${threadRoutes.confidence})`,
      })
      .from(threadRoutes)
      .where(eq(threadRoutes.workspaceId, workspaceId))
      .groupBy(threadRoutes.groupId);
    const scoredSub = await db
      .select({
        id: threadRoutes.subgroupId,
        confidence: sql<number | null>`avg(${threadRoutes.subgroupConfidence})`,
      })
      .from(threadRoutes)
      .where(eq(threadRoutes.workspaceId, workspaceId))
      .groupBy(threadRoutes.subgroupId);
    for (const r of [...scored, ...scoredSub]) {
      if (!r.id || r.confidence === null) continue;
      const entry = out.get(r.id) ?? { threads: 0, unread: 0, confidence: null };
      entry.confidence = Math.round(Number(r.confidence) * 1000) / 1000;
      out.set(r.id, entry);
    }
    return out;
  };

  /* ------------------------------ Changes ------------------------------ */

  const recordGroup = async (executor: Db | Tx, row: GroupRow, deleted = false) => {
    await mailstore.recordChange(executor, {
      workspaceId: row.workspaceId,
      kind: "group",
      entityId: row.id,
      payload: {
        id: row.id,
        workspaceId: row.workspaceId,
        parentId: row.parentId,
        name: row.name,
        sentence: row.sentence,
        predicate: row.predicate,
        threshold: row.threshold,
        briefPolicy: row.briefPolicy,
        deleted,
      },
    });
  };

  const setDecision = async (
    workspaceId: Id,
    threadId: Id,
    candidates: DecisionCandidate[],
    cap: number,
  ) => {
    const at = now();
    await db
      .insert(routingDecisions)
      .values({ threadId, workspaceId, candidates, at })
      .onConflictDoUpdate({ target: routingDecisions.threadId, set: { candidates, at } });
    await mailstore.recordChange(db, {
      workspaceId,
      kind: "decision",
      entityId: threadId,
      payload: { threadId, candidates, at: at.toISOString() },
    });
    // Above the cap the oldest entries are left alone (ADR 0004: the cap is a Setting).
    const over = await db
      .select({ threadId: routingDecisions.threadId })
      .from(routingDecisions)
      .where(eq(routingDecisions.workspaceId, workspaceId))
      .orderBy(desc(routingDecisions.at), desc(routingDecisions.threadId))
      .offset(cap);
    for (const o of over) await clearDecision(workspaceId, o.threadId);
  };

  const clearDecision = async (workspaceId: Id, threadId: Id) => {
    const gone = await db
      .delete(routingDecisions)
      .where(eq(routingDecisions.threadId, threadId))
      .returning({ threadId: routingDecisions.threadId });
    if (gone.length === 0) return;
    await mailstore.recordChange(db, {
      workspaceId,
      kind: "decision",
      entityId: threadId,
      payload: { threadId, candidates: [], at: now().toISOString() },
    });
  };

  const saveRoute = async (
    row: ThreadRow,
    route: Omit<ThreadRoute, "threadId" | "routedAt">,
    scores: Score[] = [],
  ): Promise<ThreadRoute> => {
    const routedAt = now();
    const values = {
      workspaceId: row.workspaceId,
      groupId: route.groupId,
      subgroupId: route.subgroupId,
      confidence: route.confidence,
      subgroupConfidence: route.subgroupConfidence,
      by: route.by,
      scores,
      routedAt,
    };
    await db
      .insert(threadRoutes)
      .values({ threadId: row.id, ...values })
      .onConflictDoUpdate({ target: threadRoutes.threadId, set: values });
    return { threadId: row.id, ...route, routedAt: routedAt.toISOString() };
  };

  const move = async (
    threadId: Id,
    group: GroupId | null,
    subgroup: GroupId | null,
    actor: "user" | "automation",
    at = now().toISOString(),
  ) => mailstore.applyIntent({ kind: "move", threadId, group, subgroup, at, actor });

  /** A placement the user made is never overwritten by routing (ADR 0005). */
  const userPlaced = (row: ThreadRow) => row.writes.placement?.by === "user";

  /* ------------------------------ Scoring ------------------------------ */

  const scoreThread = async (
    row: ThreadRow,
    facts: ThreadFacts,
    all: Array<GroupText & { row: GroupRow }>,
    settings: RoutingSettings,
    jobId: string | null,
  ): Promise<Scored> => {
    let calls = 0;
    const thresholdOf = (id: GroupId) => all.find((g) => g.id === id)?.row.threshold ?? null;
    const predicateFacts = {
      from: facts.from,
      participants: facts.participants,
      subject: facts.subject,
      hasAttachments: facts.hasAttachments,
      headers: facts.headers,
    };
    interface Staged {
      scores: Score[];
      by: RouteBy;
      /** Set when the judge answered: its placement reads the confidence too. */
      judged?: JudgedStage;
    }
    // Whether the judge answers, asked once per Thread, so both stages take the same path.
    let judgeOpen: Promise<boolean> | null = null;
    const judgeAvailable = () => {
      judgeOpen ??= runtime.judgeAvailable();
      return judgeOpen;
    };
    let owner: string | null = null;

    /** One Choice over the candidates through the judge, or null when the judge is unavailable. */
    const judgeStage = async (candidates: GroupText[]): Promise<Staged | null> => {
      if (!(await judgeAvailable())) return null;
      owner ??= await ownerOf(row.workspaceId);
      const asked = routeQuestion(facts, candidates, owner, {
        instructions: settings.judge.instructions,
        noneOption: settings.judge.noneOption,
        snippetChars: settings.snippetChars,
        examplesInPrompt: settings.examplesInPrompt,
      });
      let answer: JudgeResult<{ group: ChoiceQuestion }>;
      try {
        answer = await runtime.judge(
          "judge.route",
          asked.state,
          { group: asked.question },
          { workspaceId: row.workspaceId, jobId },
        );
      } catch (error) {
        // The judge went away between the check and the ask: the prompt path decides.
        if (error instanceof NoJudgeError) return null;
        throw error;
      }
      calls += 1;
      const judged = judgedPlacement(
        answer.answers.group,
        asked.options,
        settings.thresholds,
        thresholdOf,
      );
      return { scores: judged.scores, by: "model", judged };
    };

    const stage = async (candidates: GroupText[]): Promise<Staged> => {
      if (candidates.length === 0) return { scores: [], by: "model" };
      if (settings.predicateFirst) {
        const hits = candidates.filter((g) => matchesPredicate(g.predicate, predicateFacts));
        const hit = hits[0];
        if (hits.length === 1 && hit) {
          return {
            scores: candidates.map((g) => ({ groupId: g.id, confidence: g.id === hit.id ? 1 : 0 })),
            by: "predicate",
          };
        }
      }
      const judged = await judgeStage(candidates);
      if (judged) return judged;
      const { prompt, labels } = classifyPrompt(facts, candidates, settings);
      const result = await runtime.run(
        "classify",
        { system: classifySystemPrompt(), prompt },
        { workspaceId: row.workspaceId, jobId },
      );
      calls += 1;
      return { scores: parseClassifyOutput(result.output, labels), by: "model" };
    };
    const placeStage = (staged: Staged): RoutePlacement =>
      staged.judged?.placement ?? place(staged.scores, settings.thresholds, thresholdOf);

    const top = all.filter((g) => g.row.parentId === null);
    const first = await stage(top);
    const placement = placeStage(first);
    let subgroup: Scored["subgroup"] = null;
    if (placement.kind === "route") {
      const children = all.filter((g) => g.row.parentId === placement.groupId);
      if (children.length > 0) {
        const second = await stage(children);
        const inner = placeStage(second);
        if (inner.kind === "route") {
          subgroup = { groupId: inner.groupId, confidence: inner.confidence };
        }
      }
    }
    return { scores: first.scores, placement, subgroup, by: first.by, calls };
  };

  /** Applies a scored placement to a Thread; returns the route record, or null when the user's placement stands. */
  const applyScored = async (
    row: ThreadRow,
    scored: Scored,
    settings: RoutingSettings,
  ): Promise<ThreadRoute | null> => {
    if (userPlaced(row)) return null;
    const { placement } = scored;
    if (placement.kind === "route") {
      const subgroupId = scored.subgroup?.groupId ?? null;
      const result = await move(row.id, placement.groupId, subgroupId, "automation");
      if (!result.applied) return null;
      await clearDecision(row.workspaceId, row.id);
      return saveRoute(
        row,
        {
          groupId: placement.groupId,
          subgroupId,
          confidence: placement.confidence,
          subgroupConfidence: scored.subgroup?.confidence ?? null,
          by: scored.by,
        },
        scored.scores,
      );
    }
    if (placement.kind === "ask") {
      await setDecision(row.workspaceId, row.id, placement.candidates, settings.decisionsCap);
      return saveRoute(
        row,
        {
          groupId: null,
          subgroupId: null,
          confidence: placement.candidates[0]?.confidence ?? null,
          subgroupConfidence: null,
          by: scored.by,
        },
        scored.scores,
      );
    }
    const fallback = settings.defaultGroup.trim() || null;
    if (row.groupId !== fallback || row.subgroupId !== null) {
      const result = await move(row.id, fallback, null, "automation");
      if (!result.applied) return null;
    }
    await clearDecision(row.workspaceId, row.id);
    return saveRoute(
      row,
      {
        groupId: fallback,
        subgroupId: null,
        confidence: placement.best?.confidence ?? null,
        subgroupConfidence: null,
        by: scored.by,
      },
      scored.scores,
    );
  };

  const toProposed = (
    row: ThreadRow,
    facts: ThreadFacts,
    scored: Scored,
    settings: RoutingSettings,
  ) => {
    const { placement } = scored;
    const proposed: ProposedMove["proposed"] =
      placement.kind === "route"
        ? {
            kind: "route",
            groupId: placement.groupId,
            subgroupId: scored.subgroup?.groupId ?? null,
            confidence: placement.confidence,
          }
        : placement.kind === "ask"
          ? { kind: "ask", candidates: placement.candidates }
          : { kind: "none" };
    const fallback = settings.defaultGroup.trim() || null;
    const differs =
      proposed.kind === "route"
        ? proposed.groupId !== row.groupId || proposed.subgroupId !== row.subgroupId
        : proposed.kind === "ask"
          ? true
          : row.groupId !== fallback || row.subgroupId !== null;
    const proposal: ProposedMove = {
      threadId: row.id,
      from: facts.from,
      subject: facts.subject,
      current: { groupId: row.groupId, subgroupId: row.subgroupId },
      proposed,
    };
    return { proposal, differs };
  };

  /* ------------------------------ Many at once ------------------------------ */

  interface Staged {
    scores: Score[];
    by: RouteBy;
    judged?: JudgedStage;
  }
  interface ManyItem {
    row: ThreadRow;
    facts: ThreadFacts;
  }
  interface ManyContext {
    workspaceId: Id;
    settings: RoutingSettings;
    backfill: BackfillSettings;
    jobId: string | null;
    useJudge: boolean;
    owner: string | null;
    thresholdOf: (id: GroupId) => Confidence | null;
    calls: number;
    batches: number;
    batchSize: number;
    sorter: "typesafe" | "llm" | null;
  }

  /** One Thread through the language model's one-Thread prompt. */
  const classifyOne = async (item: ManyItem, candidates: GroupText[], ctx: ManyContext) => {
    const { prompt, labels } = classifyPrompt(item.facts, candidates, ctx.settings);
    const result = await runtime.run(
      "classify",
      { system: classifySystemPrompt(), prompt },
      { workspaceId: ctx.workspaceId, jobId: ctx.jobId },
    );
    ctx.calls += 1;
    return parseClassifyOutput(result.output, labels);
  };

  /** A stage for many Threads through TypeSafe: batches packed under the count and the token budgets. */
  const judgeMany = async (
    items: readonly ManyItem[],
    candidates: GroupText[],
    ctx: ManyContext,
    out: Map<Id, Staged>,
  ) => {
    ctx.owner ??= await ownerOf(ctx.workspaceId);
    const owner = ctx.owner;
    const js = {
      instructions: ctx.settings.judge.instructions,
      noneOption: ctx.settings.judge.noneOption,
      snippetChars: ctx.settings.snippetChars,
      examplesInPrompt: ctx.settings.examplesInPrompt,
    };
    const shared = groupsJson(candidates, js);
    const base = estimateTokens({ owner, groups: shared.groups, examples: shared.examples });
    const question = estimateTokens(
      batchQuestion("t000", shared.options, js, shared.examples.length > 0),
    );
    const batches = packBatches(
      items,
      base,
      (it) => ({ state: estimateTokens(threadJson(it.facts, js.snippetChars)) + 4, question }),
      {
        count: ctx.backfill.batchSize,
        requestTokens: ctx.backfill.requestTokens,
        stateTokens: ctx.backfill.stateTokens,
      },
    );
    await eachPool(batches, ctx.backfill.concurrency, async (batch) => {
      const keyed: BatchItem[] = batch.map((it, i) => ({ key: `t${i + 1}`, facts: it.facts }));
      const asked = routeBatchQuestions(keyed, candidates, owner, js);
      const answer = await runtime.judge("judge.backlog", asked.state, asked.questions, {
        workspaceId: ctx.workspaceId,
        jobId: ctx.jobId,
      });
      ctx.calls += 1;
      ctx.batches += 1;
      ctx.batchSize = batch.length;
      ctx.sorter = "typesafe";
      batch.forEach((it, i) => {
        const a = answer.answers[`t${i + 1}`];
        if (!a) return;
        const judged = judgedPlacement(a, asked.options, ctx.settings.thresholds, ctx.thresholdOf);
        out.set(it.row.id, { scores: judged.scores, by: "model", judged });
      });
    });
  };

  /** A stage for many Threads through the language model: a few Threads per prompt, one at a time. */
  const promptMany = async (
    items: readonly ManyItem[],
    candidates: GroupText[],
    ctx: ManyContext,
    out: Map<Id, Staged>,
  ) => {
    const size = Math.max(1, ctx.backfill.llmBatchSize);
    for (let i = 0; i < items.length; i += size) {
      const chunk = items.slice(i, i + size);
      ctx.sorter = "llm";
      ctx.batches += 1;
      ctx.batchSize = chunk.length;
      if (chunk.length === 1) {
        const only = chunk[0] as ManyItem;
        out.set(only.row.id, { scores: await classifyOne(only, candidates, ctx), by: "model" });
        continue;
      }
      const keyed: BatchItem[] = chunk.map((it, j) => ({ key: `t${j + 1}`, facts: it.facts }));
      const asked = classifyBatchPrompt(keyed, candidates, ctx.settings);
      const result = await runtime.run(
        "classify",
        { system: classifyBatchSystemPrompt(), prompt: asked.prompt },
        { workspaceId: ctx.workspaceId, jobId: ctx.jobId },
      );
      ctx.calls += 1;
      let parsed = new Map<string, Score[]>();
      try {
        parsed = parseClassifyBatchOutput(result.output, asked.labels, asked.threads);
      } catch {
        // An unreadable answer: every Thread of the prompt is asked alone below.
      }
      for (const [j, it] of chunk.entries()) {
        const scores = parsed.get(`t${j + 1}`) ?? (await classifyOne(it, candidates, ctx));
        out.set(it.row.id, { scores, by: "model" });
      }
    }
  };

  /** The Predicate's placement over candidates when exactly one matches, else null. */
  const predicateStage = (facts: ThreadFacts, candidates: readonly GroupText[]): Staged | null => {
    const hits = candidates.filter((g) =>
      matchesPredicate(g.predicate, {
        from: facts.from,
        participants: facts.participants,
        subject: facts.subject,
        hasAttachments: facts.hasAttachments,
        headers: facts.headers,
      }),
    );
    const hit = hits[0];
    if (hits.length !== 1 || !hit) return null;
    return {
      scores: candidates.map((g) => ({ groupId: g.id, confidence: g.id === hit.id ? 1 : 0 })),
      by: "predicate",
    };
  };

  /** Routing's own one-Thread ask: the judge over routing's state, metered as the Backlog sort. */
  const ownOneThreadAsk: OneThreadAsk = async (req) => {
    const answer = await runtime.judge("judge.backlog", req.state, req.questions, {
      workspaceId: req.workspaceId,
      jobId: req.jobId,
    });
    return { answers: answer.answers, calls: 1 };
  };
  let oneThreadAsk: OneThreadAsk = ownOneThreadAsk;

  const subQuestionId = (groupId: GroupId) => `subgroup_${groupId}`;

  type EachResult = {
    first: Staged;
    subgroup: { groupId: GroupId; confidence: Confidence } | null;
  };

  /** What one Thread's placement asks, and how its answers place it. */
  interface OnePlan {
    questions: Record<string, ChoiceQuestion>;
    state: JsonValue | null;
    decide(answers: Record<string, JudgeAnswer | undefined>): EachResult;
  }

  /**
   * One Thread's routing questions (slice 29): the stage-one Group Choice and,
   * speculatively, the Sub-group Choice of every Group that has Sub-groups,
   * so a two-stage placement is one request; code reads only the Sub-group
   * Choice under the Group chosen. Predicates decide first, and a Thread
   * they settle entirely asks nothing.
   */
  const planOne = (
    facts: ThreadFacts,
    all: ReadonlyArray<GroupText & { row: GroupRow }>,
    owner: string,
    settings: RoutingSettings,
    thresholdOf: (id: GroupId) => Confidence | null,
  ): OnePlan => {
    const js = {
      instructions: settings.judge.instructions,
      noneOption: settings.judge.noneOption,
      snippetChars: settings.snippetChars,
      examplesInPrompt: settings.examplesInPrompt,
    };
    const top = all.filter((g) => g.row.parentId === null);
    const childrenOf = (id: GroupId) => all.filter((g) => g.row.parentId === id);
    const placeOf = (st: Staged): RoutePlacement =>
      st.judged?.placement ?? place(st.scores, settings.thresholds, thresholdOf);
    const questions: Record<string, ChoiceQuestion> = {};
    const options = new Map<string, Record<string, GroupId>>();
    const first = settings.predicateFirst ? predicateStage(facts, top) : null;
    let state: JsonValue | null = null;
    if (!first) {
      const asked = routeQuestion(facts, top, owner, js);
      questions.group = asked.question;
      options.set("group", asked.options);
      state = asked.state;
    }
    // Every Group that could be chosen before the answer; only the one a Predicate chose after it.
    let parents = top;
    if (first) {
      const p = placeOf(first);
      parents = p.kind === "route" ? top.filter((g) => g.id === p.groupId) : [];
    }
    const decidedSub = new Map<GroupId, Staged>();
    for (const parent of parents) {
      const children = childrenOf(parent.id);
      if (children.length === 0) continue;
      const byPredicate = settings.predicateFirst ? predicateStage(facts, children) : null;
      if (byPredicate) {
        decidedSub.set(parent.id, byPredicate);
        continue;
      }
      const asked = routeQuestion(facts, children, owner, js);
      questions[subQuestionId(parent.id)] = asked.question;
      options.set(subQuestionId(parent.id), asked.options);
      state ??= asked.state;
    }
    return {
      questions,
      state,
      decide(answers) {
        const read = (id: string): Staged | null => {
          const a = answers[id];
          const opts = options.get(id);
          if (a?.type !== "choice" || !opts) return null;
          const judged = judgedPlacement(a, opts, settings.thresholds, thresholdOf);
          return { scores: judged.scores, by: "model", judged };
        };
        const stage: Staged = first ?? read("group") ?? { scores: [], by: "model" };
        const placement = placeOf(stage);
        let subgroup: EachResult["subgroup"] = null;
        if (placement.kind === "route") {
          const inner = decidedSub.get(placement.groupId) ?? read(subQuestionId(placement.groupId));
          const innerPlacement = inner ? placeOf(inner) : null;
          if (innerPlacement?.kind === "route") {
            subgroup = { groupId: innerPlacement.groupId, confidence: innerPlacement.confidence };
          }
        }
        return { first: stage, subgroup };
      },
    };
  };

  /** One request per Thread (slice 29; ADR 0014), through the one-Thread ask. */
  const judgeEach = async (
    items: readonly ManyItem[],
    all: ReadonlyArray<GroupText & { row: GroupRow }>,
    ctx: ManyContext,
  ): Promise<Map<Id, EachResult>> => {
    ctx.owner ??= await ownerOf(ctx.workspaceId);
    const owner = ctx.owner;
    const out = new Map<Id, EachResult>();
    await eachPool(items, ctx.backfill.concurrency, async (it) => {
      const plan = planOne(it.facts, all, owner, ctx.settings, ctx.thresholdOf);
      let answers: Record<string, JudgeAnswer | undefined> = {};
      if (Object.keys(plan.questions).length > 0 && plan.state !== null) {
        const asked = await oneThreadAsk({
          workspaceId: ctx.workspaceId,
          threadId: it.row.id,
          facts: it.facts,
          state: plan.state,
          questions: plan.questions,
          jobId: ctx.jobId,
        });
        answers = asked.answers;
        ctx.calls += asked.calls;
        ctx.batches += 1;
        ctx.batchSize = 1;
        ctx.sorter = "typesafe";
      }
      out.set(it.row.id, plan.decide(answers));
    });
    return out;
  };

  /**
   * Whether an arriving Thread is routed now (routing.on_arrival, the
   * lookback, a Group to route into, not placed by the user, and not routed
   * yet), and what that asks: the questions ride
   * in the arrival Signal request (slice 33), and `apply` places the Thread
   * from the answers the way route() would.
   */
  const arrivalPlan = async (threadId: Id): Promise<ArrivalPlan | null> => {
    if ((await level()) !== "automate") return null;
    const row = await db.query.threads.findFirst({ where: eq(threads.id, threadId) });
    if (!row || row.deleted || userPlaced(row)) return null;
    const settings = await options.settings();
    if (!settings.onArrival) return null;
    const ageMs = now().getTime() - row.lastActivity.getTime();
    if (Number.isFinite(ageMs) && ageMs > settings.lookbackDays * 86_400_000) return null;
    const all = await groupTexts(row.workspaceId);
    if (all.every((g) => g.row.parentId !== null)) return null;
    // Routing places a Thread once, when it arrives, as the route Job always has.
    const [routed] = await db
      .select({ at: threadRoutes.routedAt })
      .from(threadRoutes)
      .where(eq(threadRoutes.threadId, threadId));
    if (routed) return null;
    const facts = await readFacts(row);
    const owner = await ownerOf(row.workspaceId);
    const thresholdOf = (id: GroupId) => all.find((g) => g.id === id)?.row.threshold ?? null;
    const plan = planOne(facts, all, owner, settings, thresholdOf);
    return {
      workspaceId: row.workspaceId,
      questions: plan.questions,
      async apply(answers) {
        const decided = plan.decide(answers);
        const placement: RoutePlacement =
          decided.first.judged?.placement ??
          place(decided.first.scores, settings.thresholds, thresholdOf);
        const current =
          (await db.query.threads.findFirst({ where: eq(threads.id, threadId) })) ?? row;
        return applyScored(
          current,
          {
            scores: decided.first.scores,
            placement,
            subgroup: decided.subgroup,
            by: decided.first.by,
            calls: 0,
          },
          settings,
        );
      },
    };
  };
  let arrivalAsk: ((workspaceId: Id, threadId: Id, jobId: string | null) => Promise<void>) | null =
    null;

  /** One stage for many Threads over the same candidates: the Predicate first, then batched requests. */
  const stageMany = async (
    items: readonly ManyItem[],
    candidates: GroupText[],
    ctx: ManyContext,
  ): Promise<Map<Id, Staged>> => {
    const out = new Map<Id, Staged>();
    if (candidates.length === 0) {
      for (const it of items) out.set(it.row.id, { scores: [], by: "model" });
      return out;
    }
    const rest: ManyItem[] = [];
    for (const it of items) {
      if (ctx.settings.predicateFirst) {
        const hits = candidates.filter((g) =>
          matchesPredicate(g.predicate, {
            from: it.facts.from,
            participants: it.facts.participants,
            subject: it.facts.subject,
            hasAttachments: it.facts.hasAttachments,
            headers: it.facts.headers,
          }),
        );
        const hit = hits[0];
        if (hits.length === 1 && hit) {
          out.set(it.row.id, {
            scores: candidates.map((g) => ({ groupId: g.id, confidence: g.id === hit.id ? 1 : 0 })),
            by: "predicate",
          });
          continue;
        }
      }
      rest.push(it);
    }
    if (rest.length === 0) return out;
    if (ctx.useJudge) {
      try {
        await judgeMany(rest, candidates, ctx, out);
      } catch (error) {
        // The judge went away mid-way: the language model takes what is left.
        if (!(error instanceof NoJudgeError)) throw error;
        ctx.useJudge = false;
      }
    }
    const left = rest.filter((it) => !out.has(it.row.id));
    if (left.length > 0) await promptMany(left, candidates, ctx, out);
    return out;
  };

  /* ------------------------------ Corrections ------------------------------ */

  const upsertExample = async (
    row: ThreadRow,
    groupId: GroupId,
    positive: boolean,
    from: Person | null,
  ) => {
    const at = now();
    await db
      .insert(examples)
      .values({
        threadId: row.id,
        groupId,
        workspaceId: row.workspaceId,
        positive,
        from,
        subject: row.subjectSearch,
        at,
      })
      .onConflictDoUpdate({
        target: [examples.threadId, examples.groupId],
        set: { positive, from, subject: row.subjectSearch, at },
      });
  };

  /** The mailbox owner's address, so a revision never adds the owner as a Predicate. */
  const ownerOf = async (workspaceId: Id): Promise<string> => {
    const [row] = await db
      .select({ address: accounts.address })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    return (row?.address ?? "").toLowerCase();
  };

  /** Drops the owner's own address and domain: every Thread has them, so they place nothing. */
  const withoutOwner = (p: Predicate, owner: string): Predicate => {
    if (!owner) return p;
    const out: Predicate = { ...p };
    const senders = (p.senders ?? []).filter((s) => s.trim().toLowerCase() !== owner);
    const domains = (p.domains ?? []).filter((d) => !domainMatches(domainOf(owner), d));
    if (p.senders) {
      if (senders.length) out.senders = senders;
      else delete out.senders;
    }
    if (p.domains) {
      if (domains.length) out.domains = domains;
      else delete out.domains;
    }
    return out;
  };

  /** One route call: the Group's criteria rewritten around its Examples; the Predicate extended. */
  const revise = async (
    groupId: GroupId,
    facts: ThreadFacts,
    belongs: boolean,
    settings: RoutingSettings,
  ): Promise<void> => {
    const all = await groupTexts((await requireGroup(groupId)).workspaceId);
    const target = all.find((g) => g.id === groupId);
    if (!target) return;
    const result = await runtime.run(
      "route",
      {
        system: reviseSystemPrompt(),
        prompt: revisePrompt({ group: target, corrected: { facts, belongs } }, settings),
      },
      { workspaceId: target.row.workspaceId },
    );
    const revision = parseReviseOutput(result.output);
    const stored = await mailstore.storeContent(target.row.workspaceId, "rule", revision.prompt);
    const promptEnc = stored.chunks[0];
    if (!promptEnc) throw new RangeError("rule envelope missing");
    const owner = await ownerOf(target.row.workspaceId);
    const predicate = mergePredicates(
      target.row.predicate,
      withoutOwner(revision.predicate, owner),
    );
    const [updated] = await db
      .update(groups)
      .set({ promptEnc, promptKey: stored.key, predicate, updatedAt: now() })
      .where(eq(groups.id, groupId))
      .returning();
    if (updated) await recordGroup(db, updated);
  };

  const correct = async (
    row: ThreadRow,
    to: { group: GroupId | null; subgroup: GroupId | null },
    previous: { group: GroupId | null; subgroup: GroupId | null },
    settings: RoutingSettings,
  ): Promise<CorrectionResult> => {
    const known = new Set((await groupRows(row.workspaceId)).map((g) => g.id));
    const from = await newestSender(row.id);
    const written: CorrectionResult["examples"] = [];
    const positives = [...new Set([to.group, to.subgroup])].filter(
      (g): g is string => g !== null && known.has(g),
    );
    const negatives = [...new Set([previous.group, previous.subgroup])].filter(
      (g): g is string => g !== null && known.has(g) && !positives.includes(g),
    );
    for (const g of positives) {
      await upsertExample(row, g, true, from);
      written.push({ groupId: g, positive: true });
    }
    for (const g of negatives) {
      await upsertExample(row, g, false, from);
      written.push({ groupId: g, positive: false });
    }
    await saveRoute(row, {
      groupId: to.group,
      subgroupId: to.subgroup,
      confidence: null,
      subgroupConfidence: null,
      by: "user",
    });
    await clearDecision(row.workspaceId, row.id);
    // The deepest target learns the correction; with no target, the Group left behind does.
    const target = to.subgroup ?? to.group;
    const reviseId = target && known.has(target) ? target : (negatives[0] ?? null);
    if (!reviseId) return { examples: written, revised: null };
    const facts = await readFacts(row);
    await revise(reviseId, facts, reviseId === target, settings);
    return { examples: written, revised: reviseId };
  };

  /* ------------------------------ The interface ------------------------------ */

  const api: Routing = {
    async listGroups(workspaceId) {
      const rows = await groupRows(workspaceId);
      const byGroup = await examplesOf(workspaceId);
      const stats = await statsOf(workspaceId);
      const out: GroupView[] = [];
      for (const row of rows) out.push(await toView(row, byGroup, stats));
      return out;
    },

    async getGroup(groupId) {
      const row = await db.query.groups.findFirst({ where: eq(groups.id, groupId) });
      if (!row) return null;
      return toView(row, await examplesOf(row.workspaceId), await statsOf(row.workspaceId));
    },

    async createGroup(workspaceId, input) {
      const parentId = input.parentId ?? null;
      if (parentId) {
        const parent = await db.query.groups.findFirst({ where: eq(groups.id, parentId) });
        if (!parent || parent.workspaceId !== workspaceId) {
          throw new GroupNestingError("parent not found");
        }
        if (parent.parentId !== null) throw new GroupNestingError("nesting stops at one level");
      }
      const at = now();
      const [row] = await db
        .insert(groups)
        .values({
          id: crypto.randomUUID(),
          workspaceId,
          parentId,
          name: input.name.trim(),
          sentence: (input.sentence ?? "").trim(),
          predicate: input.predicate ?? {},
          threshold: input.threshold ?? null,
          briefPolicy: input.briefPolicy ?? null,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!row) throw new Error("createGroup returned no row");
      await recordGroup(db, row);
      return toView(row, new Map(), new Map());
    },

    async updateGroup(groupId, patch) {
      const current = await requireGroup(groupId);
      if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
        if (patch.parentId) {
          const parent = await db.query.groups.findFirst({ where: eq(groups.id, patch.parentId) });
          if (!parent || parent.workspaceId !== current.workspaceId) {
            throw new GroupNestingError("parent not found");
          }
          if (parent.parentId !== null || parent.id === groupId) {
            throw new GroupNestingError("nesting stops at one level");
          }
          const children = await db.query.groups.findFirst({ where: eq(groups.parentId, groupId) });
          if (children) throw new GroupNestingError("a Group with Sub-groups cannot nest");
        }
      }
      const sentenceChanged =
        patch.sentence !== undefined && patch.sentence.trim() !== current.sentence;
      const [row] = await db
        .update(groups)
        .set({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
          ...(patch.sentence !== undefined ? { sentence: patch.sentence.trim() } : {}),
          // The user's own words replace what a correction revised.
          ...(sentenceChanged ? { promptEnc: null, promptKey: null } : {}),
          ...(patch.predicate !== undefined ? { predicate: patch.predicate } : {}),
          ...(patch.threshold !== undefined ? { threshold: patch.threshold } : {}),
          ...(patch.briefPolicy !== undefined ? { briefPolicy: patch.briefPolicy } : {}),
          updatedAt: now(),
        })
        .where(eq(groups.id, groupId))
        .returning();
      if (!row) throw new NotFoundError("group", groupId);
      await recordGroup(db, row);
      return toView(row, await examplesOf(row.workspaceId), await statsOf(row.workspaceId));
    },

    async deleteGroup(groupId) {
      const row = await requireGroup(groupId);
      const children = await db.select().from(groups).where(eq(groups.parentId, groupId));
      const ids = [groupId, ...children.map((c) => c.id)];
      // Threads fall back: out of a deleted Sub-group to its parent, out of a Group to none.
      // The move keeps the placement's actor, so a Thread routing placed stays
      // routing's to place again; only a user's own placement stays the user's.
      const placed = await db
        .select({
          id: threads.id,
          groupId: threads.groupId,
          subgroupId: threads.subgroupId,
          writes: threads.writes,
        })
        .from(threads)
        .where(
          and(
            eq(threads.workspaceId, row.workspaceId),
            sql`(${threads.groupId} in ${ids} or ${threads.subgroupId} in ${ids})`,
          ),
        );
      for (const t of placed) {
        const leavesGroup = t.groupId !== null && ids.includes(t.groupId);
        await move(
          t.id,
          leavesGroup ? null : t.groupId,
          null,
          t.writes.placement?.by === "user" ? "user" : "automation",
        );
      }
      await db
        .update(threadRoutes)
        .set({ groupId: null, subgroupId: null, confidence: null, subgroupConfidence: null })
        .where(
          and(eq(threadRoutes.workspaceId, row.workspaceId), inArray(threadRoutes.groupId, ids)),
        );
      await db
        .update(threadRoutes)
        .set({ subgroupId: null, subgroupConfidence: null })
        .where(
          and(eq(threadRoutes.workspaceId, row.workspaceId), inArray(threadRoutes.subgroupId, ids)),
        );
      await db.delete(groups).where(eq(groups.id, groupId));
      for (const c of children) await recordGroup(db, c, true);
      await recordGroup(db, row, true);
    },

    async classify(threadId, opts = {}) {
      const row = await requireThread(threadId);
      const stored = await options.settings();
      const settings: RoutingSettings = opts.override
        ? {
            ...stored,
            thresholds: { ...stored.thresholds, ...opts.override.thresholds },
            judge: { ...stored.judge, ...opts.override.judge },
          }
        : stored;
      const all = await groupTexts(row.workspaceId);
      const facts = await readFacts(row);
      return scoreThread(row, facts, all, settings, opts.jobId ?? null);
    },

    async route(threadId, opts = {}) {
      const row = await requireThread(threadId);
      if (userPlaced(row)) return api.routeOf(threadId);
      const settings = await options.settings();
      const all = await groupTexts(row.workspaceId);
      if (all.every((g) => g.row.parentId !== null)) return null;
      const facts = await readFacts(row);
      const scored = await scoreThread(row, facts, all, settings, opts.jobId ?? null);
      return applyScored(row, scored, settings);
    },

    async routeOf(threadId) {
      const r = await db.query.threadRoutes.findFirst({
        where: eq(threadRoutes.threadId, threadId),
      });
      if (!r) return null;
      return {
        threadId: r.threadId,
        groupId: r.groupId,
        subgroupId: r.subgroupId,
        confidence: r.confidence,
        subgroupConfidence: r.subgroupConfidence,
        by: r.by,
        routedAt: r.routedAt.toISOString(),
      };
    },

    async enqueue(workspaceId, threadId, opts = {}) {
      if (!jobs) throw new Error("route Jobs need registerSteps first");
      const payload: RouteJobPayload = { workspaceId, threadId };
      return jobs.enqueue(ROUTE_STEP, payload, opts.id ? { id: opts.id } : {});
    },

    async onArrival(workspaceId, threadId, lastActivity) {
      if ((await level()) !== "automate") return null;
      if (!jobs) return null;
      const settings = await options.settings();
      if (!settings.onArrival) return null;
      const ageMs = now().getTime() - Date.parse(lastActivity);
      if (Number.isFinite(ageMs) && ageMs > settings.lookbackDays * 86_400_000) return null;
      const [any] = await db
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.workspaceId, workspaceId), isNull(groups.parentId)))
        .limit(1);
      if (!any) return null;
      // One arrival Job per Thread: a sync that sees the Thread twice enqueues once.
      return api.enqueue(workspaceId, threadId, { id: `${ROUTE_STEP}:${threadId}` });
    },

    async decisions(workspaceId) {
      const rows = await db
        .select({
          threadId: routingDecisions.threadId,
          candidates: routingDecisions.candidates,
          at: routingDecisions.at,
          subject: threads.subjectSearch,
          participants: threads.participants,
        })
        .from(routingDecisions)
        .innerJoin(threads, eq(threads.id, routingDecisions.threadId))
        .where(eq(routingDecisions.workspaceId, workspaceId))
        .orderBy(desc(routingDecisions.at));
      const out: RoutingDecision[] = [];
      for (const r of rows) {
        out.push({
          threadId: r.threadId,
          candidates: r.candidates,
          from: (await newestSender(r.threadId)) ?? r.participants[0] ?? null,
          subject: r.subject,
          at: r.at.toISOString(),
        });
      }
      return out;
    },

    async decide(threadId, groupId, at) {
      const row = await requireThread(threadId);
      let group: GroupId | null = null;
      let subgroup: GroupId | null = null;
      if (groupId) {
        const g = await requireGroup(groupId);
        group = g.parentId ?? g.id;
        subgroup = g.parentId ? g.id : null;
      }
      const previous = { group: row.groupId, subgroup: row.subgroupId };
      const stamp = at ?? now().toISOString();
      const result = await move(threadId, group, subgroup, "user", stamp);
      if (!result.applied) {
        await clearDecision(row.workspaceId, threadId);
        return { examples: [], revised: null };
      }
      const settings = await options.settings();
      if (!settings.learnFromCorrections) {
        await clearDecision(row.workspaceId, threadId);
        await saveRoute(row, {
          groupId: group,
          subgroupId: subgroup,
          confidence: null,
          subgroupConfidence: null,
          by: "user",
        });
        return { examples: [], revised: null };
      }
      return correct(row, { group, subgroup }, previous, settings);
    },

    async observeMove(intent, previous) {
      const settings = await options.settings();
      const row = await requireThread(intent.threadId);
      if (!settings.learnFromCorrections || intent.actor !== "user") {
        await clearDecision(row.workspaceId, row.id);
        return null;
      }
      return correct(row, { group: intent.group, subgroup: intent.subgroup }, previous, settings);
    },

    async preview(workspaceId, opts = {}) {
      const settings = await options.settings();
      const recent = Math.max(1, opts.recent ?? settings.rerunRecent);
      const at = now();
      // No count asked for: the Setting's scope (routing.rerun.scope).
      const scope =
        opts.scope ??
        (opts.recent === undefined && settings.rerunScope
          ? (parseSortScope(settings.rerunScope) ?? undefined)
          : undefined);
      const all = [
        ...(await groupTexts(workspaceId)),
        ...(opts.candidates ?? []).map((c) => ({
          row: {
            id: c.id,
            workspaceId,
            parentId: c.parentId ?? null,
            name: c.name.trim(),
            sentence: (c.sentence ?? "").trim(),
            predicate: c.predicate ?? {},
            promptEnc: null,
            promptKey: null,
            threshold: c.threshold ?? null,
            briefPolicy: c.briefPolicy ?? null,
            createdAt: at,
            updatedAt: at,
          } satisfies GroupRow,
          id: c.id,
          name: c.name.trim(),
          sentence: (c.sentence ?? "").trim(),
          prompt: "",
          predicate: c.predicate ?? {},
          examples: [],
        })),
      ];
      // A scope: every Thread in it up to the preview size, else the newest sample.
      let walked: ThreadRow[];
      let scoped: Pick<RoutingPreview, "scope" | "inScope" | "complete" | "after"> = {};
      if (scope) {
        const resolved = resolveScope(scope, at);
        const inScope = await countInScope(db, workspaceId, resolved);
        const previewMax =
          settings.rerunPreviewMax ?? settingsSchema["routing.rerun.preview_max"].default;
        const size =
          opts.sample !== undefined
            ? Math.min(opts.sample, inScope)
            : inScope <= previewMax
              ? inScope
              : Math.min(
                  inScope,
                  settings.rerunSample ?? settingsSchema["routing.rerun.sample"].default,
                );
        walked = await pageInScope(db, workspaceId, resolved, { limit: Math.max(0, size) });
        const last = walked[walked.length - 1];
        scoped = {
          scope: formatSortScope(scope),
          inScope,
          complete: walked.length >= inScope,
          after: last ? { at: last.lastActivity.toISOString(), id: last.id } : null,
        };
      } else {
        const page = await mailstore.listThreads(workspaceId, { limit: recent });
        const ids = page.threads.map((t) => t.id);
        const rows = ids.length
          ? await db.select().from(threads).where(inArray(threads.id, ids))
          : [];
        const byId = new Map(rows.map((r) => [r.id, r]));
        walked = ids.flatMap((id) => {
          const row = byId.get(id);
          return row ? [row] : [];
        });
      }
      if (all.every((g) => g.row.parentId !== null)) {
        return { workspaceId, considered: 0, moves: [], calls: 0, ...scoped };
      }
      const todo = walked.filter((row) => !userPlaced(row));
      // routing.rerun.concurrency at a time, continuously: each score may wait on the Judge over the network.
      const found: Array<ProposedMove | null> = todo.map(() => null);
      let calls = 0;
      let done = 0;
      let moved = 0;
      opts.onProgress?.({ done: 0, total: todo.length, moves: 0, subject: null });
      await eachPool(todo, settings.rerunConcurrency ?? 1, async (row, i) => {
        const facts = await readFacts(row);
        const scored = await scoreThread(row, facts, all, settings, null);
        calls += scored.calls;
        const { proposal, differs } = toProposed(row, facts, scored, settings);
        if (differs) {
          found[i] = proposal;
          moved += 1;
        }
        done += 1;
        opts.onProgress?.({ done, total: todo.length, moves: moved, subject: proposal.subject });
      });
      const moves = found.filter((m): m is ProposedMove => m !== null);
      if (!scope) return { workspaceId, considered: todo.length, moves, calls };
      const byTarget: Record<string, number> = {};
      for (const m of moves) {
        const target =
          m.proposed.kind === "route"
            ? (m.proposed.subgroupId ?? m.proposed.groupId)
            : m.proposed.kind === "ask"
              ? "ask"
              : "none";
        byTarget[target] = (byTarget[target] ?? 0) + 1;
      }
      return { workspaceId, considered: todo.length, moves, calls, ...scoped, byTarget };
    },

    async judgeInputs(workspaceId, threadIds) {
      const settings = await options.settings();
      const all = await groupTexts(workspaceId);
      const owner = await ownerOf(workspaceId);
      const facts = new Map<Id, ThreadFacts>();
      if (threadIds.length > 0) {
        const rows = await db
          .select()
          .from(threads)
          .where(and(eq(threads.workspaceId, workspaceId), inArray(threads.id, [...threadIds])));
        for (const row of rows) {
          try {
            facts.set(row.id, await readFacts(row));
          } catch (error) {
            if (error instanceof LockedError) throw error;
            log(
              `judge inputs ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      return {
        owner,
        settings,
        groups: all.map(({ row, ...g }) => ({
          ...g,
          parentId: row.parentId,
          threshold: row.threshold,
        })),
        facts,
      };
    },

    async routeMany(workspaceId, threadIds, opts = {}) {
      const settings = await options.settings();
      const result: RouteManyResult = {
        moved: 0,
        asked: 0,
        left: 0,
        skipped: 0,
        calls: 0,
        batches: 0,
        batchSize: 0,
        sorter: null,
      };
      if (threadIds.length === 0) return result;
      const all = await groupTexts(workspaceId);
      const top = all.filter((g) => g.row.parentId === null);
      if (top.length === 0) return { ...result, left: threadIds.length };
      const rows = await db
        .select()
        .from(threads)
        .where(and(eq(threads.workspaceId, workspaceId), inArray(threads.id, [...threadIds])));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const items: ManyItem[] = [];
      for (const id of threadIds) {
        const row = byId.get(id);
        if (!row || row.deleted) {
          result.left += 1;
          continue;
        }
        if (userPlaced(row)) {
          result.skipped += 1;
          continue;
        }
        items.push({ row, facts: await readFacts(row) });
      }
      const ctx: ManyContext = {
        workspaceId,
        settings,
        backfill: settings.backfill ?? defaultBackfillSettings(),
        jobId: opts.jobId ?? null,
        useJudge: await runtime.judgeAvailable(),
        owner: null,
        thresholdOf: (id) => all.find((g) => g.id === id)?.row.threshold ?? null,
        calls: 0,
        batches: 0,
        batchSize: 0,
        sorter: null,
      };
      const placeOf = (st: Staged | undefined): RoutePlacement =>
        st?.judged?.placement ?? place(st?.scores ?? [], settings.thresholds, ctx.thresholdOf);
      const subgroupOf = new Map<Id, { groupId: GroupId; confidence: Confidence }>();
      let first = new Map<Id, Staged>();
      // One Thread per request is the default (routing.backfill.batch_size 1); above 1 the batched path packs Group Choices.
      let each = false;
      if (ctx.useJudge && ctx.backfill.batchSize <= 1) {
        try {
          for (const [id, r] of await judgeEach(items, all, ctx)) {
            first.set(id, r.first);
            if (r.subgroup) subgroupOf.set(id, r.subgroup);
          }
          each = true;
        } catch (error) {
          // The judge went away mid-way: the language model takes the round.
          if (!(error instanceof NoJudgeError)) throw error;
          ctx.useJudge = false;
          first = new Map();
          subgroupOf.clear();
        }
      }
      if (!each) first = await stageMany(items, top, ctx);
      // Sub-groups: the Threads routed into a Group with children, one stage per parent.
      const byParent = new Map<GroupId, ManyItem[]>();
      for (const it of items) {
        if (each) break;
        const placement = placeOf(first.get(it.row.id));
        if (placement.kind !== "route") continue;
        if (!all.some((g) => g.row.parentId === placement.groupId)) continue;
        byParent.set(placement.groupId, [...(byParent.get(placement.groupId) ?? []), it]);
      }
      for (const [parent, list] of byParent) {
        const children = all.filter((g) => g.row.parentId === parent);
        const second = await stageMany(list, children, ctx);
        for (const it of list) {
          const inner = placeOf(second.get(it.row.id));
          if (inner.kind === "route") {
            subgroupOf.set(it.row.id, { groupId: inner.groupId, confidence: inner.confidence });
          }
        }
      }
      for (const it of items) {
        const staged = first.get(it.row.id);
        const placement = placeOf(staged);
        const scored: Scored = {
          scores: staged?.scores ?? [],
          placement,
          subgroup: subgroupOf.get(it.row.id) ?? null,
          by: staged?.by ?? "model",
          calls: 0,
        };
        const applied = await applyScored(it.row, scored, settings);
        if (!applied) result.skipped += 1;
        else if (placement.kind === "ask") result.asked += 1;
        else if (
          placement.kind === "route" &&
          (it.row.groupId !== applied.groupId || it.row.subgroupId !== applied.subgroupId)
        ) {
          result.moved += 1;
        } else result.left += 1;
      }
      return {
        ...result,
        calls: ctx.calls,
        batches: ctx.batches,
        batchSize: ctx.batchSize,
        sorter: ctx.sorter,
      };
    },

    async apply(workspaceId, moves) {
      const settings = await options.settings();
      let moved = 0;
      let asked = 0;
      for (const m of moves) {
        const row = await db.query.threads.findFirst({ where: eq(threads.id, m.threadId) });
        if (!row || row.workspaceId !== workspaceId) continue;
        const scored: Scored =
          m.proposed.kind === "route"
            ? {
                scores: [{ groupId: m.proposed.groupId, confidence: m.proposed.confidence }],
                placement: {
                  kind: "route",
                  groupId: m.proposed.groupId,
                  confidence: m.proposed.confidence,
                },
                subgroup: m.proposed.subgroupId
                  ? { groupId: m.proposed.subgroupId, confidence: m.proposed.confidence }
                  : null,
                by: "model",
                calls: 0,
              }
            : m.proposed.kind === "ask"
              ? {
                  scores: m.proposed.candidates,
                  placement: { kind: "ask", candidates: m.proposed.candidates },
                  subgroup: null,
                  by: "model",
                  calls: 0,
                }
              : {
                  scores: [],
                  placement: { kind: "none", best: null },
                  subgroup: null,
                  by: "model",
                  calls: 0,
                };
        const applied = await applyScored(row, scored, settings);
        if (!applied) continue;
        if (m.proposed.kind === "ask") asked += 1;
        else moved += 1;
      }
      return { moved, asked };
    },

    async recordExample(threadId, groupId, positive) {
      const row = await requireThread(threadId);
      const group = await requireGroup(groupId);
      if (group.workspaceId !== row.workspaceId) throw new NotFoundError("group", groupId);
      const existing = await db.query.examples.findFirst({
        where: and(eq(examples.threadId, threadId), eq(examples.groupId, groupId)),
        columns: { positive: true },
      });
      await upsertExample(row, groupId, positive, await newestSender(threadId));
      return { previous: existing ? { positive: existing.positive } : null };
    },

    async restoreExample(threadId, groupId, previous) {
      const group = await db.query.groups.findFirst({ where: eq(groups.id, groupId) });
      const row = await db.query.threads.findFirst({ where: eq(threads.id, threadId) });
      if (!group || !row) return false;
      if (!previous) {
        await db
          .delete(examples)
          .where(and(eq(examples.threadId, threadId), eq(examples.groupId, groupId)));
        return true;
      }
      await upsertExample(row, groupId, previous.positive, await newestSender(threadId));
      return true;
    },

    setOneThreadAsk(ask) {
      oneThreadAsk = ask ?? ownOneThreadAsk;
    },

    arrivalPlan: (threadId) => arrivalPlan(threadId),

    setArrivalAsk(ask) {
      arrivalAsk = ask;
    },

    registerSteps(target) {
      jobs = target;
      target.registerStep<RouteJobPayload>(ROUTE_STEP, async (job: Job<RouteJobPayload>) => {
        try {
          // With TypeSafe, the arrival request carries routing with every Signal (slice 33).
          if (arrivalAsk && (await runtime.judgeAvailable())) {
            try {
              await arrivalAsk(job.payload.workspaceId, job.payload.threadId, job.id);
              return "done";
            } catch (error) {
              if (!(error instanceof NoJudgeError)) throw error;
            }
          }
          await api.route(job.payload.threadId, { jobId: job.id });
        } catch (error) {
          // A Thread that vanished before its turn is done, not failed.
          if (error instanceof NotFoundError) {
            log(`route ${job.payload.threadId}: ${error.message}`);
            return "done";
          }
          // Nothing can sort right now (no TypeSafe key, no provider key, no
          // coding agent connected, or the agent went away): the Thread waits
          // and sorting picks up again once one is there. Never a failed Job.
          if (error instanceof NoProviderKeyError || error instanceof LocalRuntimeTimeoutError) {
            const wait =
              (await options.settings()).waitSeconds ??
              settingsSchema["routing.wait_seconds"].default;
            log(`route ${job.payload.threadId}: waiting ${wait}s: ${error.message}`);
            return { sleepMs: wait * 1000 };
          }
          throw error;
        }
        return "done";
      });
    },
  };
  return api;
}
