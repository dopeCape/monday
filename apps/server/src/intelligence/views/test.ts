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
  ViewThreadDiagnosis,
  ViewTriedThread,
} from "@monday/shared";
import {
  actionShows,
  aggregatedExtractions,
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
import { countViewThreads, loadViewThreads } from "../../views/threads.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import type { PriorAnswers, Signals } from "../signals/index.ts";
import { eachPool } from "../signals/pool.ts";
import { type AskedThread, coverageOf } from "./coverage.ts";

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
  /** views.test.prefer_readable: prefer Threads whose text holds the values the Blocks add up. */
  preferReadable?: boolean | undefined;
  /** views.test.scan: how many in-scope Threads code looks through for them. */
  scan?: number | undefined;
  /** views.extract.candidates_max: a Thread with this many candidates was cut short. */
  candidatesMax?: number | undefined;
  /** views.extract.many.max: the same for many values. */
  manyMax?: number | undefined;
}

export interface TestRun {
  test: ViewTest;
  threadIds: Id[];
  /** Each tried Thread explained, for inspect_view_thread (sealed in the draft). */
  diagnosis: Record<Id, ViewThreadDiagnosis>;
  /** What each tried Thread was answered, kept so Pin view writes it instead of asking again. */
  priors: Record<Id, PriorAnswers>;
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
  // The scope is applied in SQL: the newest Threads it admits across the whole mailbox.
  const scoped = (f: typeof facts) => ({
    workspaceId,
    owner: ctx.owner,
    since: scopeSince(f, ctx.now, ctx.zone),
    scope: { facts: f, now: ctx.now, zone: ctx.zone },
  });
  const admitted = async (f: typeof facts, limit: number, exclude: readonly Id[] = []) =>
    limit <= 0
      ? []
      : (await loadViewThreads(db, { ...scoped(f), limit, exclude })).filter((t) =>
          scopeAdmits(f, t, ctx),
        );

  // The scope's real size; a quiet scope's dates widen so the test has Threads to try.
  const inScope = Math.min(
    await countViewThreads(db, scoped(facts), settings.maxThreads + 1),
    doc.scope.limit,
  );
  let poolFacts = facts;
  let widened: ViewTest["widened"] = null;
  if (inScope < settings.pool && (facts.received || facts.active)) {
    const wide = widenScope(facts, settings.widenDays);
    if ((await countViewThreads(db, scoped(wide), settings.pool)) > inScope) {
      const within = (facts.received ?? facts.active) as { within?: string };
      poolFacts = wide;
      widened = {
        when:
          within.within === "today"
            ? "today"
            : within.within === "this_week"
              ? "this_week"
              : "scope",
        count: inScope,
      };
    }
  }
  // A revision tries again the Threads it tried that its scope still admits, so the
  // corrections stay comparable; a changed scope drops the ones it no longer admits and
  // fills the rest with the newest Threads it does.
  let kept = options.threadIds?.length
    ? (
        await loadViewThreads(db, {
          ...scoped(poolFacts),
          ids: options.threadIds,
          limit: options.threadIds.length,
        })
      ).filter((t) => scopeAdmits(poolFacts, t, ctx))
    : [];
  const before = new Map((options.threadIds ?? []).map((id, i) => [id, i]));
  kept.sort((a, b) => (before.get(a.id) ?? 0) - (before.get(b.id) ?? 0));
  kept = kept.slice(0, settings.pool);

  // When a Block adds up a value, the Threads worth trying are the ones whose text holds
  // that kind of value: code looks (no judge) through the newest views.test.scan in scope
  // and prefers them, passing over the rest, and says how many.
  const kinds = settings.preferReadable
    ? [
        ...new Set(
          aggregatedExtractions(doc).flatMap(
            (id) => doc.extractions.find((x) => x.id === id)?.find ?? [],
          ),
        ),
      ]
    : [];
  const readable = new Map<Id, boolean>();
  const check = async (list: readonly ViewThread[]) => {
    await eachPool(
      list.filter((t) => !readable.has(t.id)),
      settings.concurrency,
      async (t) => {
        try {
          const found = await deps.signals.candidates(workspaceId, t.id, kinds);
          readable.set(
            t.id,
            kinds.every((k) => (found[k]?.length ?? 0) > 0),
          );
        } catch {
          readable.set(t.id, true);
        }
      },
    );
  };
  let skipped = 0;
  let scanned = 0;
  let fresh: ViewThread[];
  if (kinds.length === 0) {
    fresh = await admitted(
      poolFacts,
      settings.pool - kept.length,
      kept.map((t) => t.id),
    );
  } else {
    // A kept Thread the user corrected stays; one code can no longer read makes room.
    const corrected = new Set(
      Object.values(doc.examples)
        .flat()
        .map((e) => e.threadId),
    );
    await check(kept);
    const dropped = kept.filter((t) => !corrected.has(t.id) && readable.get(t.id) === false);
    kept = kept.filter((t) => !dropped.includes(t));
    const need = settings.pool - kept.length;
    const looked = await admitted(
      poolFacts,
      Math.max(settings.scan ?? settings.pool * 4, need),
      [...kept, ...dropped].map((t) => t.id),
    );
    await check(looked);
    scanned = looked.length + kept.length + dropped.length;
    const good = looked.filter((t) => readable.get(t.id) !== false);
    const rest = [...dropped, ...looked.filter((t) => readable.get(t.id) === false)];
    fresh = [...good.slice(0, need), ...rest.slice(0, Math.max(0, need - good.length))];
    skipped = rest.length - Math.max(0, Math.min(rest.length, need - good.length));
  }
  const pool: ViewThread[] = [...kept, ...fresh];

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
  // How each is asked: one value, many (a Noul per candidate), one per Message, and a Signal per row.
  const extraOptions: Record<string, SignalOptionsFrom> = Object.fromEntries([
    ...pulls.map((d) => [
      d.id,
      (d.mode === "many"
        ? `extract_many:${d.find}`
        : d.mode === "message"
          ? `extract_message:${d.find}`
          : `extract:${d.find}`) as SignalOptionsFrom,
    ]),
    ...own.flatMap((d) =>
      d.each
        ? [
            [
              d.id,
              ("item" in d.each ? `each_item:${d.each.item}` : "each_message") as SignalOptionsFrom,
            ],
          ]
        : [],
    ),
  ]);
  const eachIds = new Set(own.filter((d) => d.each).map((d) => d.id));
  const asksOwn = own.length + pulls.length > 0;
  const stored = await deps.signals.readings(pool.map((t) => t.id));
  const judge = await deps.runtime.judgeAvailable();
  const extras = new Map<Id, Record<string, SignalReading>>();
  const values = new Map<Id, Record<string, ExtractedValue>>();
  const candidates = new Map<Id, Record<string, string[]>>();
  const asked = new Map<Id, AskedThread>();
  const priors: Record<Id, PriorAnswers> = {};
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
          if (p?.items) {
            // Many values (or one per Message): all of them, the Unsure ones marked.
            const any = p.items.some((i) => !i.unsure);
            got[d.id] = {
              choice: any ? "picked" : "none",
              confidence: p.confidence,
              version: 0,
            };
            picked[d.id] = {
              text: p.text,
              value: p.value,
              confidence: p.confidence,
              items: p.items,
            };
          } else if (p) {
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
        // A per-row Signal's answers ride beside the values, as the Device reads them.
        for (const id of eachIds) {
          const p = r.picks[id];
          if (p?.answers)
            picked[id] = { text: "each", value: null, confidence: 1, answers: p.answers };
        }
        extras.set(t.id, got);
        values.set(t.id, picked);
        candidates.set(t.id, r.candidates);
        asked.set(t.id, r);
        if (r.prior) priors[t.id] = r.prior;
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

  const { coverage, diagnosis } = coverageOf(doc, threads, asked, ctx, {
    candidatesMax: settings.candidatesMax ?? 20,
    manyMax: settings.manyMax ?? 30,
    scopeFacts: facts,
  });

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
  // The card shows Threads: an item or Message View's rows of one Thread show as that Thread once.
  const seenThreads = new Set<Id>();
  const tried = lanes.lanes.flatMap((l) =>
    l.rows.flatMap((r) => {
      if (seenThreads.has(r.thread.id)) return [];
      seenThreads.add(r.thread.id);
      return [
        {
          id: r.thread.id,
          lane: l.id,
          certainty: placementCertainty(doc, r.thread, r.placement),
          placement: r.placement,
        },
      ];
    }),
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
  const triedRow = (p: (typeof tried)[number]): ViewTriedThread | null => {
    const t = byId.get(p.id);
    if (!t) return null;
    const row = {
      thread: t,
      threads: [t],
      lane: doc.lanes.length ? p.lane : null,
      placement: p.placement,
    };
    return {
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
    };
  };
  const shown = picked.flatMap((p) => triedRow(p) ?? []);
  // The rest of the tried Threads, so the card's coverage can show the ones a reason names.
  const shownIds = new Set(shown.map((r) => r.threadId));
  const rest = tried.filter((p) => !shownIds.has(p.id)).flatMap((p) => triedRow(p) ?? []);
  const examples = Object.values(doc.examples).flat().length;
  return {
    test: {
      tried: threads.length,
      shown,
      rest,
      counts: lanes.counts,
      widened,
      empty: threads.length === 0,
      inScope,
      agreement: examples ? correctionAgreement(doc, byId, lanes.lanesOf, ctx.rules) : null,
      pool: {
        kept: kept.length,
        fresh: fresh.length,
        skipped,
        scanned,
        ...(kinds.length ? { prefer: kinds } : {}),
      },
      coverage,
      changes: [],
      needsJudge: viewReadsSignals(doc) && (!judge || unanswered),
      moves: null,
      blocks,
    },
    threadIds: threads.map((t) => t.id),
    diagnosis,
    priors,
    lanesOf: lanes.lanesOf,
    threads,
  };
}
