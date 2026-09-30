// The test a View must pass before it is saved (docs/spec/views.md,
// "Making a View: the Agent must test it", steps 3 and 4). Code takes the
// newest views.test.pool Threads in scope; when the scope holds fewer (a
// quiet "today"), only its date part widens to the last
// views.test.widen_days and the card says so. Each Thread is asked in its
// one ordinary Signal request, the Threads concurrently: the View's own
// Signals and its Extractions ride as extra questions (an Extraction's
// options are the candidates code finds in that Thread, and code copies the
// pick), the shipped ones it uses and lacks are stored as usual. Then the
// Lanes are evaluated, every Block is computed over the tried Threads and
// drawn small for the card, and the card gets views.test.shown of them
// spread across the Lanes, least confident first, with the answers and
// values behind each, plus the counts over all of them.

import type {
  ExtractedValue,
  Id,
  JudgeAnswer,
  JudgeQuestion,
  SignalOptionsFrom,
  SignalReading,
  ValueWords,
  ViewContext,
  ViewDoc,
  ViewTest,
  ViewThread,
  ViewTriedThread,
} from "@monday/shared";
import {
  actionShows,
  computeBlocks,
  correctionAgreement,
  DEFAULT_VALUE_WORDS,
  OTHERS_LANE,
  pickShown,
  placementCertainty,
  placementReasons,
  previewBlock,
  readExtraction,
  readingOf,
  scopeAdmits,
  scopeSince,
  signalName,
  UNSURE_LANE,
  viewBase,
  viewExtractionDefs,
  viewReadsSignals,
  viewSignalDefs,
  widenScope,
} from "@monday/shared";
import type { Db } from "../../db/client.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { loadViewThreads } from "../../views/threads.ts";
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
  /** "None of these" for an Extraction that names none (views.extract.none). */
  extractNone?: string | undefined;
  /** How values are written on the card (Unsure, Not read yet, today). */
  words?: ValueWords | undefined;
  maxRows?: number | undefined;
  maxGroups?: number | undefined;
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
        owner: ctx.owner,
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
    pool = (
      await loadViewThreads(db, { workspaceId, owner: ctx.owner, ids: [...ids], limit: ids.size })
    ).filter((t) => !t.deleted);
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

  // Ask: the View's own questions and Extractions ride as extras in each Thread's one request;
  // the shipped ones it uses and lacks are stored as usual.
  const own = viewSignalDefs(doc, settings.examplesMax);
  const pulls = viewExtractionDefs(doc, {
    ...(settings.extractNone ? { none: settings.extractNone } : {}),
    examplesMax: settings.examplesMax,
  });
  const extra: Record<string, JudgeQuestion> = Object.fromEntries([
    ...own.map((d) => [d.id, d.question as JudgeQuestion]),
    ...pulls.map((d) => [d.id, d.question as JudgeQuestion]),
  ]);
  const extraOptions: Record<string, SignalOptionsFrom> = Object.fromEntries(
    pulls.map((d) => [d.id, `extract:${d.find}` as SignalOptionsFrom]),
  );
  const asksOwn = own.length + pulls.length > 0;
  const stored = await deps.signals.readings(pool.map((t) => t.id));
  const judge = await deps.runtime.judgeAvailable();
  const extras = new Map<Id, Record<string, SignalReading>>();
  const values = new Map<Id, Record<string, ExtractedValue>>();
  const candidates = new Map<Id, Record<string, string[]>>();
  let unanswered = false;
  if (judge) {
    // The definitions settle once before the parallel requests read them.
    await deps.signals.defs(workspaceId);
    await eachPool(pool, settings.concurrency, async (t) => {
      const have = stored.get(t.id) ?? {};
      const missing = doc.uses.filter((u) => !have[u]);
      if (!asksOwn && missing.length === 0) return;
      try {
        const r = await deps.signals.ask(workspaceId, t.id, {
          reason: "view",
          only: missing,
          ...(asksOwn ? { extra } : {}),
          ...(pulls.length ? { extraOptions } : {}),
        });
        const got: Record<string, SignalReading> = {};
        const picked: Record<string, ExtractedValue> = {};
        for (const [id, a] of Object.entries(r.extra)) {
          if (!a || extraOptions[id]) continue;
          got[id] = readingFrom(a);
        }
        // An Extraction reads as "picked" with its value beside it, or "none" (code found nothing: sure).
        for (const d of pulls) {
          const p = r.picks[d.id];
          const a = r.extra[d.id];
          if (p) {
            got[d.id] = { choice: "picked", confidence: p.confidence, version: 0 };
            picked[d.id] = { text: p.text, value: p.value, confidence: p.confidence };
          } else if (d.id in r.picks) {
            got[d.id] = {
              choice: "none",
              confidence: a?.type === "choice" ? a.confidence : 1,
              version: 0,
            };
          }
        }
        extras.set(t.id, got);
        values.set(t.id, picked);
        candidates.set(t.id, r.candidates);
      } catch (error) {
        unanswered = true;
        deps.log(`view test ${t.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  const after = judge ? await deps.signals.readings(pool.map((t) => t.id)) : stored;
  const subjects = new Map<Id, string>(
    await Promise.all(
      pool.map(async (t): Promise<[Id, string]> => {
        try {
          return [t.id, await deps.mailstore.readThreadSubject(t.id)];
        } catch {
          return [t.id, ""];
        }
      }),
    ),
  );
  const threads: ViewThread[] = pool.map((t) => ({
    ...t,
    subject: subjects.get(t.id) ?? "",
    readings: { ...(after.get(t.id) ?? {}), ...(extras.get(t.id) ?? {}) },
    values: values.get(t.id) ?? {},
  }));

  // Evaluate over the tried Threads as they are (they already passed the scope, perhaps widened).
  const evalDoc: ViewDoc = {
    ...doc,
    scope: { facts: { folder: "any" }, limit: threads.length || 1 },
  };
  const base = viewBase(evalDoc, threads, ctx);
  const lanes = base.lanes;
  const words = settings.words ?? DEFAULT_VALUE_WORDS;
  const blocks = computeBlocks(base, {
    maxRows: settings.maxRows,
    maxGroups: settings.maxGroups,
  }).map((b) => previewBlock(b, ctx, words));
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
  const blockActions = [...new Set(doc.blocks.flatMap((b) => b.actions ?? []))].flatMap(
    (id) => doc.actions.find((a) => a.id === id) ?? [],
  );
  const shown: ViewTriedThread[] = [];
  for (const p of picked) {
    const t = byId.get(p.id);
    if (!t) continue;
    const row = {
      thread: t,
      threads: [t],
      lane: doc.lanes.length ? p.lane : null,
      placement: p.placement,
    };
    shown.push({
      threadId: t.id,
      from: t.from ?? "",
      subject: t.subject ?? "",
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
      values: doc.extractions.map((x) => {
        const read = readExtraction(doc, t, x.id, ctx);
        const stored = pulls.find((d) => d.local === x.id)?.id ?? "";
        return {
          extraction: x.id,
          label: x.label?.trim() || x.id.replaceAll("_", " "),
          state: read.state,
          text: read.state === "value" || read.state === "unsure" ? read.text : null,
          confidence: read.state === "value" || read.state === "unsure" ? read.confidence : null,
          candidates: candidates.get(t.id)?.[stored] ?? [],
        };
      }),
      actions: blockActions.filter((a) => actionShows(base, a, row)).map((a) => a.label),
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
      needsJudge: viewReadsSignals(doc) && (!judge || unanswered),
      moves: null,
      blocks,
    },
    threadIds: threads.map((t) => t.id),
    lanesOf: lanes.lanesOf,
    threads,
  };
}
