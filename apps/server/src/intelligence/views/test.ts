// The test a View must pass before it is saved (docs/spec/views.md,
// "Making a View: the Agent must test it", step 2 and 3). Code takes the
// newest views.test.pool Threads in scope; when the scope holds fewer (a
// quiet "today"), only its date part widens to the last
// views.test.widen_days and the card says so. Those Threads are asked the
// View's Signals in the ordinary Signal request (one Thread each; the
// View's own questions ride as extra questions, the shipped ones it uses
// are stored as usual), the Lanes are evaluated, and the card gets
// views.test.shown of them spread across the Lanes, least confident first,
// with the answers behind each, plus the counts over all of them.

import type {
  Id,
  JudgeAnswer,
  JudgeQuestion,
  SignalReading,
  ViewContext,
  ViewDoc,
  ViewTest,
  ViewThread,
  ViewTriedThread,
} from "@monday/shared";
import {
  correctionAgreement,
  laneView,
  OTHERS_LANE,
  pickShown,
  placementCertainty,
  placementReasons,
  readingOf,
  scopeAdmits,
  scopeSince,
  signalName,
  UNSURE_LANE,
  viewReadsSignals,
  viewSignalDefs,
  widenScope,
} from "@monday/shared";
import type { Db } from "../../db/client.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { loadViewThreads } from "../../views/threads.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import type { Signals } from "../signals/index.ts";

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
  test: ViewTest;
  threadIds: Id[];
  lanesOf: Map<Id, string>;
  threads: ViewThread[];
}

/** A judge's answer as a list reads it. */
export function readingFrom(answer: JudgeAnswer): SignalReading {
  if (answer.type === "noul") return { noul: answer.noul, version: 0 };
  if (answer.type === "choice") {
    return { choice: answer.choice, confidence: answer.confidence, version: 0 };
  }
  return { score: answer.score, confidence: answer.confidence, version: 0 };
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += Math.max(1, size)) {
    await Promise.all(items.slice(i, i + Math.max(1, size)).map(run));
  }
}

export async function runViewTest(
  deps: {
    db: Db;
    mailstore: Mailstore;
    runtime: HostedRuntime;
    signals: Signals;
    context: ViewContext;
    workspaceId: Id;
    log: (message: string) => void;
  },
  doc: ViewDoc,
  settings: TestSettings,
  options: { threadIds?: readonly Id[] | undefined } = {},
): Promise<TestRun> {
  const { db, context: ctx, workspaceId } = deps;
  const facts = doc.scope.facts;
  const admitted = async (f: typeof facts, limit: number) =>
    (
      await loadViewThreads(db, {
        workspaceId,
        since: scopeSince(f, ctx.now, ctx.zone),
        limit: Math.max(limit * 4, 200),
      })
    ).filter((t) => scopeAdmits(f, t, ctx));

  // The Threads to try: the same ones again for a revision, else the newest in scope, widened when quiet.
  const inScopeList = await admitted(facts, settings.maxThreads + 1);
  const inScope = Math.min(inScopeList.length, doc.scope.limit);
  let pool: ViewThread[];
  let widened: ViewTest["widened"] = null;
  if (options.threadIds) {
    const ids = new Set(options.threadIds);
    pool = (await loadViewThreads(db, { workspaceId, ids: [...ids], limit: ids.size })).filter(
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

  // Ask: the View's own questions ride as extras; the shipped ones it uses and lacks are stored as usual.
  const own = viewSignalDefs(doc, settings.examplesMax);
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
    await inBatches(pool, settings.concurrency, async (t) => {
      const have = stored.get(t.id) ?? {};
      const missing = doc.uses.filter((u) => !have[u]);
      if (own.length === 0 && missing.length === 0) return;
      try {
        const r = await deps.signals.ask(workspaceId, t.id, {
          reason: "view",
          only: missing,
          ...(own.length ? { extra } : {}),
        });
        const got: Record<string, SignalReading> = {};
        for (const [id, a] of Object.entries(r.extra)) if (a) got[id] = readingFrom(a);
        extras.set(t.id, got);
      } catch (error) {
        unanswered = true;
        deps.log(`view test ${t.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  const after = judge ? await deps.signals.readings(pool.map((t) => t.id)) : stored;
  const threads: ViewThread[] = pool.map((t) => ({
    ...t,
    readings: { ...(after.get(t.id) ?? {}), ...(extras.get(t.id) ?? {}) },
  }));

  // Evaluate over the tried Threads as they are (they already passed the scope, perhaps widened).
  const evalDoc: ViewDoc = {
    ...doc,
    scope: { facts: { folder: "any" }, limit: threads.length || 1 },
  };
  const lanes = laneView(evalDoc, threads, ctx);
  const byId = new Map(threads.map((t) => [t.id, t]));
  const tried = lanes.lanes.flatMap((l) =>
    l.rows.map((r) => ({
      id: r.thread.id,
      lane: l.id,
      certainty: placementCertainty(doc, r.thread, r.placement),
      placement: r.placement,
    })),
  );
  // Threads no Lane claims are tried too; the card may show them as others.
  for (const t of threads) {
    if (!lanes.lanesOf.has(t.id)) continue;
    if (lanes.lanesOf.get(t.id) === OTHERS_LANE && !tried.some((x) => x.id === t.id)) {
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
  const shown: ViewTriedThread[] = [];
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
      counts: lanes.counts,
      widened,
      empty: threads.length === 0,
      inScope,
      agreement: examples ? correctionAgreement(doc, byId, lanes.lanesOf, ctx.rules) : null,
      changes: [],
      needsJudge:
        viewReadsSignals(doc) && (!judge || unanswered) && own.length + doc.uses.length > 0,
      moves: null,
    },
    threadIds: threads.map((t) => t.id),
    lanesOf: lanes.lanesOf,
    threads,
  };
}
