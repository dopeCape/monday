// Views' intelligence (docs/spec/views.md, "Code, Jev, language model"):
// the stored Views (../../views) plus where their Threads land on the
// Server's answers. Code owns the scope, the Lanes, the three-valued logic
// and the counts; Jev answers the View's Signals in the ordinary Signal
// request; the language model writes and revises the document (slice 40).

import type {
  AiLevel,
  Id,
  LaneView,
  View,
  ViewContext,
  ViewDoc,
  ViewPlacement,
  ViewThread,
} from "@monday/shared";
import { laneView, scopeSince, viewExtractionId } from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { accounts, workspaces } from "../../db/schema.ts";
import type { Jobs } from "../../jobs/index.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import { createDraftStore } from "../../views/drafts.ts";
import { decidingSignal, ViewNotFoundError, type ViewStore } from "../../views/index.ts";
import { loadViewThreads } from "../../views/threads.ts";
import { readValues, type ValuesByThread } from "../../views/values.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import type { Signals } from "../signals/index.ts";
import { createViewBackfills, type ViewBackfills } from "./backfill.ts";
import { createViewDrafting, type ViewDrafting } from "./drafting.ts";

export type { DraftCorrection, UpdateProposal, ViewDrafting } from "./drafting.ts";

const READING_KEYS = [
  "views.backfill.enabled",
  "views.backfill.page_size",
  "signals.backfill.concurrency",
  "views.scope.max_threads",
  "signals.budget.background_monthly_usd",
  "routing.wait_seconds",
] as const;

const CONTEXT_KEYS = [
  "signals.unsure.noul_low",
  "signals.unsure.noul_high",
  "signals.unsure.confidence_below",
  "signals.stale_answers",
  "signals.hysteresis",
  "calendar.time_zone",
  "views.extract.min_confidence",
] as const;

export interface ViewPlaced {
  threads: ViewThread[];
  lanes: LaneView;
}

export interface ViewIntelligence {
  store: ViewStore;
  /**
   * Tells the Signal store the Workspace's Views changed: a new View's
   * Signals are defined and read over the mail already there (the backfill),
   * a deleted one's lose their consumer. Never throws.
   */
  changed(workspaceId: Id): Promise<void>;
  /** The reading rules, the clock, the zone and the owner, as the View code takes them. */
  context(workspaceId: Id): Promise<ViewContext>;
  /**
   * Where the Threads in a document's scope land now, on the answers the
   * Server holds, newest first up to the scope's limit (or only `threadIds`).
   */
  place(
    workspaceId: Id,
    doc: ViewDoc,
    options?: {
      threadIds?: readonly Id[] | undefined;
      placements?: Readonly<Record<Id, ViewPlacement>> | undefined;
    },
  ): Promise<ViewPlaced>;
  /**
   * The user moved a Thread on the View ("Move to", a drag): it stays in
   * that Lane until it changes, and the move is kept as an Example for the
   * deciding Signal of the Lane it left (does not hold) or entered (holds).
   * `lane` null takes the placement back.
   */
  moveThread(viewId: Id, threadId: Id, lane: string | null): Promise<View>;
  /** The Agent's drafts: propose, correct, revise, pin, update, apply, discard (slice 40). */
  drafting: ViewDrafting;
  /** Every value a View's Extractions picked, by Thread (decrypted for the owner's Device). */
  values(viewId: Id): Promise<ValuesByThread>;
  /** The values every View of the Workspace picked on these Threads (the feed named them). */
  valuesFor(workspaceId: Id, threadIds: readonly Id[]): Promise<ValuesByThread>;
  /** Each pinned View reading its own scope (docs/spec/views.md, "Reading a pinned View"). */
  reading: ViewBackfills;
  /**
   * The Signal store's new or reworded definitions: a View's go to its own reading,
   * the rest are returned for the Workspace's backfill.
   */
  readNew(workspaceId: Id, signalIds: readonly string[]): Promise<string[]>;
  registerSteps(jobs: Jobs): void;
}

export interface ViewIntelligenceOptions {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  signals: Signals;
  store: ViewStore;
  now?: () => Date;
  log?: (message: string) => void;
  level?: () => Promise<AiLevel>;
}

export function createViewIntelligence(options: ViewIntelligenceOptions): ViewIntelligence {
  const { db, signals, store } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});

  const context = async (workspaceId: Id): Promise<ViewContext> => {
    const s = await readGlobalSettings(db, CONTEXT_KEYS);
    const [owner] = await db
      .select({ address: accounts.address })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    return {
      rules: {
        noulLow: s["signals.unsure.noul_low"],
        noulHigh: s["signals.unsure.noul_high"],
        confidenceBelow: s["signals.unsure.confidence_below"],
        staleAnswers: s["signals.stale_answers"],
        hysteresis: s["signals.hysteresis"],
      },
      now: now(),
      zone: s["calendar.time_zone"],
      owner: (owner?.address ?? "").toLowerCase(),
      extractFloor: s["views.extract.min_confidence"],
    };
  };

  /** Threads with their answers (the Server's readings, by stored Signal id) and the View's picked values. */
  const withReadings = async (
    workspaceId: Id,
    doc: ViewDoc,
    threads: ViewThread[],
  ): Promise<ViewThread[]> => {
    const ids = threads.map((t) => t.id);
    const readings = await signals.readings(ids);
    const pulls = doc.extractions.map((x) => viewExtractionId(doc.id, x.id));
    const values = pulls.length
      ? await readValues(db, options.mailstore, workspaceId, pulls, ids)
      : {};
    return threads.map((t) => ({
      ...t,
      readings: readings.get(t.id) ?? {},
      values: values[t.id] ?? {},
    }));
  };

  const place: ViewIntelligence["place"] = async (workspaceId, doc, opts = {}) => {
    const ctx = await context(workspaceId);
    const threads = await withReadings(
      workspaceId,
      doc,
      await loadViewThreads(db, {
        workspaceId,
        owner: ctx.owner,
        ...(opts.threadIds
          ? { ids: opts.threadIds }
          : {
              since: scopeSince(doc.scope.facts, ctx.now, ctx.zone),
              scope: { facts: doc.scope.facts, now: ctx.now, zone: ctx.zone },
            }),
        limit: opts.threadIds ? opts.threadIds.length : Math.min(doc.scope.limit, 5000),
      }),
    );
    return { threads, lanes: laneView(doc, threads, ctx, { placements: opts.placements }) };
  };

  const changed = async (workspaceId: Id) => {
    try {
      await signals.defs(workspaceId);
    } catch (error) {
      log(`views ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const reading = createViewBackfills({
    db,
    mailstore: options.mailstore,
    signals,
    store,
    context,
    now,
    log,
    ...(options.level ? { level: options.level } : {}),
    canAnswer: () => options.runtime.judgeAvailable(),
    settings: async () => {
      const s = await readGlobalSettings(db, READING_KEYS);
      return {
        enabled: s["views.backfill.enabled"],
        pageSize: s["views.backfill.page_size"],
        concurrency: Math.max(1, s["signals.backfill.concurrency"]),
        maxThreads: s["views.scope.max_threads"],
        budgetUsd: s["signals.budget.background_monthly_usd"],
        waitSeconds: s["routing.wait_seconds"],
      };
    },
  });

  const drafting = createViewDrafting({
    db,
    mailstore: options.mailstore,
    runtime: options.runtime,
    signals,
    store,
    drafts: createDraftStore({ db, mailstore: options.mailstore, now }),
    context,
    changed,
    log,
    reading: () => reading,
  });

  return {
    store,
    context,
    changed,
    drafting,
    reading,
    registerSteps: (jobs) => reading.registerSteps(jobs),
    async readNew(workspaceId, signalIds) {
      // A View's stored ids are board:<viewId>:<local>; each View reads its own scope.
      const byView = new Map<string, string[]>();
      const rest: string[] = [];
      for (const id of signalIds) {
        const m = /^board:([^:]+):/.exec(id);
        if (!m?.[1]) {
          rest.push(id);
          continue;
        }
        byView.set(m[1], [...(byView.get(m[1]) ?? []), id]);
      }
      for (const [viewId, ids] of byView) {
        try {
          await reading.request(workspaceId, viewId, ids);
        } catch (error) {
          log(`view reading ${viewId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return rest;
    },
    place,
    async values(viewId) {
      const view = await store.get(viewId);
      if (!view) throw new ViewNotFoundError(viewId);
      const pulls = view.doc.extractions.map((x) => viewExtractionId(view.id, x.id));
      return readValues(db, options.mailstore, view.workspaceId, pulls);
    },
    async valuesFor(workspaceId, threadIds) {
      const views = await store.list(workspaceId);
      const pulls = views.flatMap((v) =>
        v.doc.extractions.map((x) => viewExtractionId(v.id, x.id)),
      );
      return readValues(db, options.mailstore, workspaceId, pulls, threadIds);
    },
    async moveThread(viewId, threadId, lane) {
      const view = await store.get(viewId);
      if (!view) throw new ViewNotFoundError(viewId);
      const placed = await place(view.workspaceId, view.doc, {
        threadIds: [threadId],
        placements: view.placements,
      });
      const thread = placed.threads[0];
      if (!thread) throw new ViewNotFoundError(`${viewId} thread ${threadId}`);
      const was = placed.lanes.lanesOf.get(threadId) ?? null;
      const at = { lane, messageCount: thread.messageCount, from: was };
      if (lane === null) return store.place(viewId, threadId, at);
      let subject = "";
      try {
        subject = await options.mailstore.readThreadSubject(threadId);
      } catch {}
      const who = { ...(thread.from ? { from: thread.from } : {}), subject };
      // The Lane the user chose, and the evidence for the Signal that decided between the two Lanes.
      const evidence = decidingSignal(view.doc, was, lane);
      return store.place(viewId, threadId, at, [
        { signal: "_lanes", lane, ...who },
        ...(evidence ? [{ ...evidence, ...who }] : []),
      ]);
    },
  };
}
