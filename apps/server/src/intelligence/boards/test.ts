// The test a Board must pass before it is saved (docs/spec/boards.md,
// "Making a Board: the Agent must test it", step 2 and 3). Code takes the
// newest boards.test.pool Threads in scope; when the scope holds fewer (a
// quiet "today"), only its date part widens to the last
// boards.test.widen_days and the card says so. Those Threads are asked the
// Board's Signals in the ordinary Signal request (one Thread each; the
// Board's own questions ride as extra questions, the shipped ones it uses
// are stored as usual), the Lanes are evaluated, and the card gets
// boards.test.shown of them spread across the Lanes, least confident first,
// with the answers behind each, plus the counts over all of them.

import type {
  BoardContext,
  BoardDoc,
  BoardTest,
  BoardThread,
  BoardTriedThread,
  Id,
  JudgeAnswer,
  JudgeQuestion,
  SignalReading,
} from "@monday/shared";
import {
  boardReadsSignals,
  boardSignalDefs,
  boardView,
  correctionAgreement,
  OTHERS_LANE,
  pickShown,
  placementCertainty,
  placementReasons,
  readingOf,
  scopeAdmits,
  scopeSince,
  signalName,
  UNSURE_LANE,
  widenScope,
} from "@monday/shared";
import { loadBoardThreads } from "../../boards/threads.ts";
import type { Db } from "../../db/client.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import type { Signals } from "../signals/index.ts";
import { eachPool } from "../signals/pool.ts";

export interface TestSettings {
  pool: number;
  shown: number;
  widenDays: number;
  maxThreads: number;
  examplesMax: number;
  /** The words for a Signal with no answer, in the reasons. */
  notRead: string;
  /** How many Threads are asked at once. */
  concurrency: number;
}

export interface TestRun {
  test: BoardTest;
  threadIds: Id[];
  lanesOf: Map<Id, string>;
  threads: BoardThread[];
}

/** A judge's answer as a list reads it. */
export function readingFrom(answer: JudgeAnswer): SignalReading {
  if (answer.type === "noul") return { noul: answer.noul, version: 0 };
  if (answer.type === "choice") {
    return { choice: answer.choice, confidence: answer.confidence, version: 0 };
  }
  return { score: answer.score, confidence: answer.confidence, version: 0 };
}

export async function runBoardTest(
  deps: {
    db: Db;
    mailstore: Mailstore;
    runtime: HostedRuntime;
    signals: Signals;
    context: BoardContext;
    workspaceId: Id;
    log: (message: string) => void;
  },
  doc: BoardDoc,
  settings: TestSettings,
  options: { threadIds?: readonly Id[] | undefined } = {},
): Promise<TestRun> {
  const { db, context: ctx, workspaceId } = deps;
  const facts = doc.scope.facts;
  const admitted = async (f: typeof facts, limit: number) =>
    (
      await loadBoardThreads(db, {
        workspaceId,
        since: scopeSince(f, ctx.now, ctx.zone),
        limit: Math.max(limit * 4, 200),
      })
    ).filter((t) => scopeAdmits(f, t, ctx));

  // The Threads to try: the same ones again for a revision, else the newest in scope, widened when quiet.
  const inScopeList = await admitted(facts, settings.maxThreads + 1);
  const inScope = Math.min(inScopeList.length, doc.scope.limit);
  let pool: BoardThread[];
  let widened: BoardTest["widened"] = null;
  if (options.threadIds) {
    const ids = new Set(options.threadIds);
    pool = (await loadBoardThreads(db, { workspaceId, ids: [...ids], limit: ids.size })).filter(
      (t) => !t.deleted,
    );
  } else if (inScopeList.length >= settings.pool || !(facts.received || facts.active)) {
    pool = inScopeList.slice(0, settings.pool);
  } else {
    const wide = widenScope(facts, settings.widenDays);
    pool = (await admitted(wide, settings.pool)).slice(0, settings.pool);
    if (pool.length > inScopeList.length) {
      const within = (facts.received ?? facts.active) as { within?: string };
      widened = {
        when:
          within.within === "today"
            ? "today"
            : within.within === "this_week"
              ? "this_week"
              : "scope",
        count: inScopeList.length,
      };
    }
  }

  // Ask: the Board's own questions ride as extras; the shipped ones it uses and lacks are stored as usual.
  const own = boardSignalDefs(doc, settings.examplesMax);
  const extra: Record<string, JudgeQuestion> = Object.fromEntries(
    own.map((d) => [d.id, d.question as JudgeQuestion]),
  );
  const stored = await deps.signals.readings(pool.map((t) => t.id));
  const judge = await deps.runtime.judgeAvailable();
  const extras = new Map<Id, Record<string, SignalReading>>();
  let unanswered = false;
  if (judge) {
    // The definitions settle once before the parallel requests read them.
    await deps.signals.defs(workspaceId);
    await eachPool(pool, settings.concurrency, async (t) => {
      const have = stored.get(t.id) ?? {};
      const missing = doc.uses.filter((u) => !have[u]);
      if (own.length === 0 && missing.length === 0) return;
      try {
        const r = await deps.signals.ask(workspaceId, t.id, {
          reason: "board",
          only: missing,
          ...(own.length ? { extra } : {}),
        });
        const got: Record<string, SignalReading> = {};
        for (const [id, a] of Object.entries(r.extra)) if (a) got[id] = readingFrom(a);
        extras.set(t.id, got);
      } catch (error) {
        unanswered = true;
        deps.log(`board test ${t.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  const after = judge ? await deps.signals.readings(pool.map((t) => t.id)) : stored;
  const threads: BoardThread[] = pool.map((t) => ({
    ...t,
    readings: { ...(after.get(t.id) ?? {}), ...(extras.get(t.id) ?? {}) },
  }));

  // Evaluate over the tried Threads as they are (they already passed the scope, perhaps widened).
  const evalDoc: BoardDoc = {
    ...doc,
    scope: { facts: { folder: "any" }, limit: threads.length || 1 },
  };
  const view = boardView(evalDoc, threads, ctx);
  const byId = new Map(threads.map((t) => [t.id, t]));
  const tried = view.lanes.flatMap((l) =>
    l.rows.map((r) => ({
      id: r.thread.id,
      lane: l.id,
      certainty: placementCertainty(doc, r.thread, r.placement),
      placement: r.placement,
    })),
  );
  // Threads no Lane claims are tried too; the card may show them as others.
  for (const t of threads) {
    if (!view.lanesOf.has(t.id)) continue;
    if (view.lanesOf.get(t.id) === OTHERS_LANE && !tried.some((x) => x.id === t.id)) {
      tried.push({
        id: t.id,
        lane: OTHERS_LANE,
        certainty: 1,
        placement: { lane: OTHERS_LANE, notRead: false, byUser: false, decidedBy: null },
      });
    }
  }
  const order = [...doc.lanes.map((l) => l.id), UNSURE_LANE, OTHERS_LANE];
  const picked = pickShown(tried, settings.shown, order);
  const shown: BoardTriedThread[] = [];
  for (const p of picked) {
    const t = byId.get(p.id);
    if (!t) continue;
    let subject = "";
    try {
      subject = await deps.mailstore.readThreadSubject(t.id);
    } catch {}
    shown.push({
      threadId: t.id,
      from: t.from ?? "",
      subject,
      lastActivity: t.lastActivity,
      lane: p.lane,
      notRead: p.placement.notRead,
      certainty: p.certainty,
      reasons: placementReasons(doc, t, p.placement, settings.notRead),
      nouls: doc.signals
        .filter((s) => s.kind === "noul")
        .map((s) => ({
          signal: s.id,
          label: signalName(doc, s.id),
          noul: readingOf(doc, t, s.id)?.noul ?? null,
        })),
    });
  }
  const examples = Object.values(doc.examples).flat().length;
  return {
    test: {
      tried: threads.length,
      shown,
      counts: view.counts,
      widened,
      empty: threads.length === 0,
      inScope,
      agreement: examples ? correctionAgreement(doc, byId, view.lanesOf, ctx.rules) : null,
      changes: [],
      needsJudge:
        boardReadsSignals(doc) && (!judge || unanswered) && own.length + doc.uses.length > 0,
      moves: null,
    },
    threadIds: threads.map((t) => t.id),
    lanesOf: view.lanesOf,
    threads,
  };
}
