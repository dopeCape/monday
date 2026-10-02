// How a draft read over the Threads it was tried on (docs/spec/views.md,
// "Making a View", step 4): per Extraction and Signal, how many Threads got a
// value or a clear answer, "none of these", an answer below the floor, or no
// candidate at all, and a diagnosis per Thread for inspect_view_thread. A
// session that saw only "Tried on 30 threads: Unsure 0" guessed the bodies
// were missing; these counts say what actually happened. Code only.

import type {
  CoverageReason,
  Id,
  JudgeAnswer,
  ViewContext,
  ViewCoverage,
  ViewDoc,
  ViewThread,
  ViewThreadDiagnosis,
} from "@monday/shared";
import {
  readExtraction,
  readingOf,
  scopeReasons,
  signalName,
  viewExtractionId,
  viewSignalId,
} from "@monday/shared";

/** What one Thread's Signal request returned for the draft's questions. */
export interface AskedThread {
  extra: Record<string, JudgeAnswer | undefined>;
  picks: Record<string, unknown>;
  candidates: Record<string, string[]>;
  found?: Record<string, Array<{ key: string; span: string; line: string }>> | undefined;
}

const label = (x: { id: string; label?: string | undefined }) =>
  x.label?.trim() || x.id.replaceAll("_", " ");

type FieldRow = ViewCoverage["fields"][number];

/** Notes which tried Thread a count came from, once per Thread and reason. */
function mark(row: FieldRow, reason: CoverageReason, threadId: Id): void {
  const threads = row.threads ?? {};
  row.threads = threads;
  const list = threads[reason] ?? [];
  threads[reason] = list;
  if (!list.includes(threadId)) list.push(threadId);
}

/** A per-row Signal over the rows of the tried Threads: its answer per item or per Message. */
function eachCoverage(
  doc: ViewDoc,
  threads: readonly ViewThread[],
  s: { local: string; stored: string },
  ctx: ViewContext,
  diagnosis: Record<Id, ViewThreadDiagnosis>,
  examples: number,
): FieldRow {
  const { noulLow, noulHigh, confidenceBelow } = ctx.rules;
  const row: FieldRow = {
    field: `signal:${s.local}`,
    label: signalName(doc, s.local),
    resolved: 0,
    none: 0,
    unsure: 0,
    noCandidates: 0,
    notRead: 0,
    capped: 0,
    examples: [],
    per: "row",
  };
  for (const t of threads) {
    const answers = Object.values(t.values?.[s.stored]?.answers ?? {});
    const tally = new Map<string, number>();
    for (const a of answers) {
      let word: string;
      if (a.noul !== undefined && a.noul !== null) {
        const clear = a.noul >= noulHigh || a.noul < noulLow;
        if (clear) row.resolved += 1;
        else row.unsure += 1;
        mark(row, clear ? "resolved" : "unsure", t.id);
        word = clear ? (a.noul >= noulHigh ? "yes" : "no") : "unsure";
      } else if (
        a.confidence !== undefined &&
        a.confidence !== null &&
        a.confidence < confidenceBelow
      ) {
        row.unsure += 1;
        mark(row, "unsure", t.id);
        word = "unsure";
      } else if (a.choice === "none") {
        row.none += 1;
        mark(row, "none", t.id);
        word = "none";
      } else {
        row.resolved += 1;
        mark(row, "resolved", t.id);
        word = a.choice ?? (a.score !== undefined && a.score !== null ? a.score.toFixed(1) : "?");
        if (a.choice && row.examples.length < examples && !row.examples.includes(a.choice))
          row.examples.push(a.choice);
      }
      tally.set(word, (tally.get(word) ?? 0) + 1);
    }
    diagnosis[t.id]?.signals.push({
      signal: s.local,
      label: row.label,
      answer: answers.length
        ? `asked per ${doc.grain === "message" ? "message" : "item"}: ${[...tally.entries()]
            .map(([w, n]) => `${w} ${n}`)
            .join(", ")}`
        : "no rows asked",
    });
  }
  return row;
}

/** The Signals the draft reads by local id: its own, then the shipped ones it uses. */
function signalsOf(doc: ViewDoc): Array<{ local: string; stored: string }> {
  return [
    ...doc.signals.map((s) => ({ local: s.id, stored: viewSignalId(doc.id, s.id) })),
    ...doc.uses.map((u) => ({ local: u, stored: u })),
  ];
}

export function coverageOf(
  doc: ViewDoc,
  threads: readonly ViewThread[],
  asked: ReadonlyMap<Id, AskedThread>,
  ctx: ViewContext,
  options: {
    candidatesMax: number;
    scopeFacts: ViewDoc["scope"]["facts"];
    examples?: number;
    /** views.extract.many.max */
    manyMax?: number;
  },
): { coverage: ViewCoverage; diagnosis: Record<Id, ViewThreadDiagnosis> } {
  const senders = new Map<string, number>();
  for (const t of threads) {
    const from = t.from ?? "";
    if (from) senders.set(from, (senders.get(from) ?? 0) + 1);
  }
  const diagnosis: Record<Id, ViewThreadDiagnosis> = {};
  for (const t of threads) {
    diagnosis[t.id] = {
      threadId: t.id,
      from: t.from ?? "",
      subject: t.subject ?? "",
      receivedAt: t.receivedAt,
      scope: scopeReasons(options.scopeFacts, t, ctx).reasons,
      extractions: [],
      signals: [],
    };
  }
  const fields: ViewCoverage["fields"] = [];
  for (const x of doc.extractions) {
    const sid = viewExtractionId(doc.id, x.id);
    const row: FieldRow = {
      field: `x:${x.id}`,
      label: label(x),
      resolved: 0,
      none: 0,
      unsure: 0,
      noCandidates: 0,
      notRead: 0,
      capped: 0,
      examples: [] as string[],
      ...(x.many || doc.grain === "message" ? { values: 0 } : {}),
    };
    for (const t of threads) {
      const r = asked.get(t.id);
      const spans = r?.candidates[sid];
      const capped =
        (spans?.length ?? 0) >= (x.many ? (options.manyMax ?? 30) : options.candidatesMax);
      if (capped) {
        row.capped += 1;
        mark(row, "capped", t.id);
      }
      const read = readExtraction(doc, t, x.id, ctx);
      let state: ViewThreadDiagnosis["extractions"][number]["state"];
      if (r && spans && spans.length === 0) state = "no_candidates";
      else if (read.state === "value") state = "value";
      else if (read.state === "empty") state = "none";
      else if (read.state === "unsure") state = "unsure";
      else state = "not_read";
      if (state === "value") {
        row.resolved += 1;
        if (read.state === "value" && row.values !== undefined)
          row.values += read.items?.length ?? 1;
        const texts = read.state === "value" ? (read.items?.map((i) => i.text) ?? [read.text]) : [];
        for (const text of texts)
          if (row.examples.length < (options.examples ?? 3)) row.examples.push(text);
      } else if (state === "none") row.none += 1;
      else if (state === "unsure") row.unsure += 1;
      else if (state === "no_candidates") row.noCandidates += 1;
      else row.notRead += 1;
      mark(
        row,
        state === "value"
          ? "resolved"
          : state === "no_candidates"
            ? "noCandidates"
            : state === "not_read"
              ? "notRead"
              : state,
        t.id,
      );
      const answer = r?.extra[sid];
      const shares = answer?.type === "choice" ? answer.probabilities : null;
      // Many values: each candidate's own Noul, as the judge answered it.
      const nouls = new Map((t.values?.[sid]?.items ?? []).map((i) => [i.text, i.confidence]));
      const found =
        r?.found?.[sid] ?? (spans ?? []).map((span) => ({ key: span, span, line: span }));
      diagnosis[t.id]?.extractions.push({
        extraction: x.id,
        label: label(x),
        find: x.find,
        state,
        picked: read.state === "value" || read.state === "unsure" ? read.text : null,
        confidence:
          read.state === "value" || read.state === "unsure"
            ? read.confidence
            : answer?.type === "choice"
              ? answer.confidence
              : null,
        candidates: found.map((c) => ({
          span: c.span,
          line: c.line,
          probability: x.many
            ? r
              ? (nouls.get(c.span) ?? 0)
              : null
            : shares
              ? (shares[c.key] ?? 0)
              : null,
        })),
        capped,
      });
    }
    fields.push(row);
  }
  const { noulLow, noulHigh, confidenceBelow } = ctx.rules;
  for (const s of signalsOf(doc)) {
    const own = doc.signals.find((x) => x.id === s.local);
    if (own?.each) {
      fields.push(eachCoverage(doc, threads, s, ctx, diagnosis, options.examples ?? 3));
      continue;
    }
    const row: FieldRow = {
      field: `signal:${s.local}`,
      label: signalName(doc, s.local),
      resolved: 0,
      none: 0,
      unsure: 0,
      noCandidates: 0,
      notRead: 0,
      capped: 0,
      examples: [] as string[],
    };
    for (const t of threads) {
      const r = readingOf(doc, t, s.local);
      let words: string;
      if (!r) {
        row.notRead += 1;
        mark(row, "notRead", t.id);
        words = "not read";
      } else if (r.noul !== undefined && r.noul !== null) {
        const clear = r.noul >= noulHigh || r.noul < noulLow;
        if (clear) row.resolved += 1;
        else row.unsure += 1;
        mark(row, clear ? "resolved" : "unsure", t.id);
        words = `${Math.round(r.noul * 100)}% yes${clear ? "" : " (unsure)"}`;
      } else if (
        r.confidence !== undefined &&
        r.confidence !== null &&
        r.confidence < confidenceBelow
      ) {
        row.unsure += 1;
        mark(row, "unsure", t.id);
        words = `${r.choice ?? r.score?.toFixed(1) ?? "?"} at ${Math.round(r.confidence * 100)}% (unsure)`;
      } else if (r.choice === "none") {
        row.none += 1;
        mark(row, "none", t.id);
        words = "none";
      } else {
        row.resolved += 1;
        mark(row, "resolved", t.id);
        const what =
          r.choice ?? (r.score !== undefined && r.score !== null ? r.score.toFixed(1) : "?");
        words = `${what}${r.confidence !== undefined && r.confidence !== null ? ` at ${Math.round(r.confidence * 100)}%` : ""}`;
        if (
          r.choice &&
          row.examples.length < (options.examples ?? 3) &&
          !row.examples.includes(r.choice)
        )
          row.examples.push(r.choice);
      }
      diagnosis[t.id]?.signals.push({ signal: s.local, label: row.label, answer: words });
    }
    fields.push(row);
  }
  return {
    coverage: {
      senders: [...senders.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([from, count]) => ({ from, count })),
      fields,
    },
    diagnosis,
  };
}
