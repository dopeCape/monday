// Routing (CONTEXT.md "Group", "Routing rule", "Predicate", "Example",
// "Confidence", "Needs a decision"; docs/spec/inbox.md; ADR 0004): Groups as
// data, the two-stage classify call through the Hosted runtime, thresholds
// to placement, corrections that become Examples and revise the Predicate,
// and the re-run with preview. Every placement routing makes is an
// automation `move` intent through the Mailstore, so a user's move always
// beats it (ADR 0005); every Group and decision reaches the client through
// the Changes feed. The `route` Job kind runs one Thread on the Server.

import type {
  AiLevel,
  BriefPolicy,
  Confidence,
  CorrectionResult,
  DecisionCandidate,
  GroupExample,
  GroupId,
  GroupInput,
  GroupView,
  Id,
  Intent,
  Person,
  Predicate,
  ProposedMove,
  RouteBy,
  RoutePlacement,
  RoutingApplied,
  RoutingDecision,
  RoutingPreview,
  Score,
  ThreadRoute,
  Thresholds,
} from "@monday/shared";
import { domainMatches, domainOf, matchesPredicate, mergePredicates, place } from "@monday/shared";
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
import type { HostedRuntime } from "../runtime/index.ts";
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
  lookbackDays: number;
  briefPolicyDefault: BriefPolicy;
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
    options?: { recent?: number; candidates?: readonly CandidateGroup[] },
  ): Promise<RoutingPreview>;
  /** Applies moves a preview proposed. */
  apply(workspaceId: Id, moves: readonly ProposedMove[]): Promise<RoutingApplied>;
  registerSteps(jobs: Jobs): void;
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
    const stage = async (candidates: GroupText[]): Promise<{ scores: Score[]; by: RouteBy }> => {
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
      const { prompt, labels } = classifyPrompt(facts, candidates, settings);
      const result = await runtime.run(
        "classify",
        { system: classifySystemPrompt(), prompt },
        { workspaceId: row.workspaceId, jobId },
      );
      calls += 1;
      return { scores: parseClassifyOutput(result.output, labels), by: "model" };
    };

    const top = all.filter((g) => g.row.parentId === null);
    const first = await stage(top);
    const placement = place(first.scores, settings.thresholds, thresholdOf);
    let subgroup: Scored["subgroup"] = null;
    if (placement.kind === "route") {
      const children = all.filter((g) => g.row.parentId === placement.groupId);
      if (children.length > 0) {
        const second = await stage(children);
        const inner = place(second.scores, settings.thresholds, thresholdOf);
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
      const placed = await db
        .select({ id: threads.id, groupId: threads.groupId, subgroupId: threads.subgroupId })
        .from(threads)
        .where(
          and(
            eq(threads.workspaceId, row.workspaceId),
            sql`(${threads.groupId} in ${ids} or ${threads.subgroupId} in ${ids})`,
          ),
        );
      for (const t of placed) {
        const leavesGroup = t.groupId !== null && ids.includes(t.groupId);
        await move(t.id, leavesGroup ? null : t.groupId, null, "user");
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
      const settings = await options.settings();
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
      if (all.every((g) => g.row.parentId !== null)) {
        return { workspaceId, considered: 0, moves: [], calls: 0 };
      }
      const page = await mailstore.listThreads(workspaceId, { limit: recent });
      const ids = page.threads.map((t) => t.id);
      const rows = ids.length
        ? await db.select().from(threads).where(inArray(threads.id, ids))
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const moves: ProposedMove[] = [];
      let calls = 0;
      let considered = 0;
      for (const id of ids) {
        const row = byId.get(id);
        if (!row || userPlaced(row)) continue;
        considered += 1;
        const facts = await readFacts(row);
        const scored = await scoreThread(row, facts, all, settings, null);
        calls += scored.calls;
        const { proposal, differs } = toProposed(row, facts, scored, settings);
        if (differs) moves.push(proposal);
      }
      return { workspaceId, considered, moves, calls };
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

    registerSteps(target) {
      jobs = target;
      target.registerStep<RouteJobPayload>(ROUTE_STEP, async (job: Job<RouteJobPayload>) => {
        try {
          await api.route(job.payload.threadId, { jobId: job.id });
        } catch (error) {
          // A Thread that vanished before its turn is done, not failed.
          if (error instanceof NotFoundError) {
            log(`route ${job.payload.threadId}: ${error.message}`);
            return "done";
          }
          throw error;
        }
        return "done";
      });
    },
  };
  return api;
}
