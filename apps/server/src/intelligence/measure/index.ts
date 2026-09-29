// The batching measurement on a Server (slice 28; docs/spec/signals.md,
// "Measure first"): the sampler over the Workspace's mail and a run kept in
// memory while the script polls it. Refused unless ai.judge.eval_enabled is
// on; every request is metered as judge.eval. What it returns is numbers and
// Thread ids, never a subject, a sender or text.

import type { GroupId, Id } from "@monday/shared";
import { parseSortScope } from "@monday/shared";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { examples, groups, threadRoutes, threads } from "../../db/schema.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import type { Routing } from "../routing/index.ts";
import { resolveScope } from "../routing/scope-query.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import { NoJudgeError } from "../runtime/index.ts";
import {
  type BatchingReport,
  type EvalItem,
  type EvalStratum,
  measureBatching,
} from "./batching.ts";

export { type BatchingReport, measureBatching, summarize } from "./batching.ts";
export { FAKE_GROUPS, fakeAsk, fakeSample } from "./fake.ts";
export { renderBatchingReport, verdictLine } from "./report.ts";

/** ai.judge.eval_enabled is off. */
export class EvalDisabledError extends Error {
  readonly status = 403;
  readonly code = "eval_disabled";
  constructor() {
    super("the batching measurement is off (ai.judge.eval_enabled)");
    this.name = "EvalDisabledError";
  }
}

export interface EvalStatus {
  id: string;
  workspaceId: Id;
  status: "running" | "done" | "failed";
  /** Requests answered so far, of the total the arms need. */
  done: number;
  total: number;
  startedAt: string;
  report: BatchingReport | null;
  error: string | null;
}

export interface BatchingEval {
  /** Samples and starts the measurement; returns at once with the run to poll. */
  start(workspaceId: Id, options?: { sample?: number; seed?: number }): Promise<EvalStatus>;
  status(id: string): EvalStatus | null;
}

const SETTING_KEYS = [
  "ai.judge.eval_enabled",
  "routing.backfill.scope",
  "routing.backfill.request_tokens",
  "routing.backfill.state_tokens",
  "routing.backfill.concurrency",
  "judgments.questions.needs_reply",
  "judgments.questions.waiting_on_others",
  "judgments.questions.newsletter",
  "judgments.questions.automated",
  "judgments.questions.urgency",
  "judgments.questions.urgency_levels",
] as const;

/** mulberry32 over a string-free seed, for a reproducible draw. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function draw<T>(items: readonly T[], count: number, random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy.slice(0, count);
}

export interface SampleIds {
  ids: Array<{ id: Id; stratum: EvalStratum }>;
  labels: Map<Id, GroupId | null>;
}

/**
 * The sample (docs/spec/signals.md): the newest third, a third at random from
 * the last 3 months, a third at random from older mail inside the Backlog
 * sort's scope, then every Thread the owner placed or confirmed on top, up to
 * 200. Threads with no Message are never drawn.
 */
export async function sampleThreads(
  db: Db,
  workspaceId: Id,
  options: { sample: number; seed: number; scope: string; now: Date },
): Promise<SampleIds> {
  const random = seeded(options.seed);
  const per = Math.max(1, Math.floor(options.sample / 3));
  const recentFrom = new Date(options.now.getTime() - 90 * 86_400_000);
  const scope = parseSortScope(options.scope);
  const since = scope ? resolveScope(scope, options.now).since : null;
  const live = and(
    eq(threads.workspaceId, workspaceId),
    eq(threads.deleted, false),
    sql`${threads.messageCount} > 0`,
  );
  const newest = await db
    .select({ id: threads.id })
    .from(threads)
    .where(live)
    .orderBy(desc(threads.lastActivity), desc(threads.id))
    .limit(per);
  const taken = new Set(newest.map((r) => r.id));
  const recentPool = (
    await db
      .select({ id: threads.id })
      .from(threads)
      .where(and(live, gte(threads.lastActivity, recentFrom)))
  ).filter((r) => !taken.has(r.id));
  const recent = draw(recentPool, per, random);
  for (const r of recent) taken.add(r.id);
  const olderPool = (
    await db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          live,
          lt(threads.lastActivity, recentFrom),
          ...(since ? [gte(threads.lastActivity, since)] : []),
        ),
      )
  ).filter((r) => !taken.has(r.id));
  const older = draw(olderPool, per, random);

  // The owner's own answers: user placements, then Examples (a Sub-group's counts for its parent).
  const parents = new Map(
    (
      await db
        .select({ id: groups.id, parentId: groups.parentId })
        .from(groups)
        .where(eq(groups.workspaceId, workspaceId))
    ).map((g) => [g.id, g.parentId]),
  );
  const top = (id: GroupId | null) => (id ? (parents.get(id) ?? id) : null);
  const labels = new Map<Id, GroupId | null>();
  const placed = await db
    .select({ threadId: threadRoutes.threadId, groupId: threadRoutes.groupId })
    .from(threadRoutes)
    .where(and(eq(threadRoutes.workspaceId, workspaceId), eq(threadRoutes.by, "user")))
    .orderBy(desc(threadRoutes.routedAt))
    .limit(400);
  for (const p of placed) labels.set(p.threadId, top(p.groupId));
  const confirmed = await db
    .select({ threadId: examples.threadId, groupId: examples.groupId })
    .from(examples)
    .where(and(eq(examples.workspaceId, workspaceId), eq(examples.positive, true)))
    .orderBy(desc(examples.at))
    .limit(400);
  for (const e of confirmed) if (!labels.has(e.threadId)) labels.set(e.threadId, top(e.groupId));
  const labelledIds = [...labels.keys()].slice(0, 200);
  const existing = labelledIds.length
    ? new Set(
        (
          await db
            .select({ id: threads.id })
            .from(threads)
            .where(and(live, inArray(threads.id, labelledIds)))
        ).map((r) => r.id),
      )
    : new Set<string>();
  const ids: SampleIds["ids"] = [
    ...newest.map((r) => ({ id: r.id, stratum: "newest" as const })),
    ...recent.map((r) => ({ id: r.id, stratum: "recent" as const })),
    ...older.map((r) => ({ id: r.id, stratum: "older" as const })),
  ];
  const inSample = new Set(ids.map((i) => i.id));
  for (const id of labelledIds) {
    if (existing.has(id) && !inSample.has(id)) ids.push({ id, stratum: "labelled" });
  }
  const kept = new Map<Id, GroupId | null>();
  for (const id of labelledIds) if (existing.has(id)) kept.set(id, labels.get(id) ?? null);
  return { ids, labels: kept };
}

export interface BatchingEvalOptions {
  db: Db;
  routing: Routing;
  runtime: HostedRuntime;
  now?: () => Date;
  log?: (message: string) => void;
}

export function createBatchingEval(options: BatchingEvalOptions): BatchingEval {
  const { db, routing, runtime } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const runs = new Map<string, EvalStatus>();

  return {
    status: (id) => runs.get(id) ?? null,

    async start(workspaceId, opts = {}) {
      const s = await readGlobalSettings(db, SETTING_KEYS);
      if (!s["ai.judge.eval_enabled"]) throw new EvalDisabledError();
      if (!(await runtime.judgeAvailable())) throw new NoJudgeError("no_key");
      const sample = await sampleThreads(db, workspaceId, {
        sample: Math.max(3, Math.min(3000, opts.sample ?? 300)),
        seed: opts.seed ?? 7,
        scope: s["routing.backfill.scope"],
        now: now(),
      });
      const inputs = await routing.judgeInputs(
        workspaceId,
        sample.ids.map((i) => i.id),
      );
      const items: EvalItem[] = [];
      for (const { id, stratum } of sample.ids) {
        const facts = inputs.facts.get(id);
        if (!facts) continue;
        const label = sample.labels.has(id)
          ? { groupId: sample.labels.get(id) ?? null }
          : undefined;
        items.push({ id, stratum, facts, ...(label ? { label } : {}) });
      }
      const candidates = inputs.groups.filter((g) => g.parentId === null);
      const status: EvalStatus = {
        id: crypto.randomUUID(),
        workspaceId,
        status: "running",
        done: 0,
        total: 0,
        startedAt: now().toISOString(),
        report: null,
        error: null,
      };
      runs.set(status.id, status);
      const thresholds = new Map(inputs.groups.map((g) => [g.id, g.threshold]));
      void measureBatching({
        items,
        candidates,
        owner: inputs.owner,
        settings: {
          route: {
            instructions: inputs.settings.judge.instructions,
            noneOption: inputs.settings.judge.noneOption,
            snippetChars: inputs.settings.snippetChars,
            examplesInPrompt: inputs.settings.examplesInPrompt,
          },
          nouls: {
            needs_reply: s["judgments.questions.needs_reply"],
            waiting_on_others: s["judgments.questions.waiting_on_others"],
            newsletter: s["judgments.questions.newsletter"],
            automated: s["judgments.questions.automated"],
          },
          urgency: s["judgments.questions.urgency"],
          urgencyLevels: s["judgments.questions.urgency_levels"],
        },
        thresholds: inputs.settings.thresholds,
        thresholdOf: (id) => thresholds.get(id) ?? null,
        limits: {
          requestTokens: s["routing.backfill.request_tokens"],
          stateTokens: s["routing.backfill.state_tokens"],
        },
        concurrency: s["routing.backfill.concurrency"],
        now: () => now().getTime(),
        onProgress: (done, total) => {
          status.done = done;
          status.total = total;
        },
        ask: async (state, questions) => {
          const result = await runtime.judge("judge.eval", state, questions, { workspaceId });
          return {
            answers: result.answers,
            inputTokens: result.usage.inputTokens,
            costMicros: result.costMicros,
            model: result.model,
          };
        },
      })
        .then((report) => {
          status.report = report;
          status.status = "done";
        })
        .catch((error: unknown) => {
          status.status = "failed";
          status.error = error instanceof Error ? error.message : String(error);
          log(`batching measurement: ${status.error}`);
        });
      return status;
    },
  };
}
