// How a draft read over the Threads it was tried on (docs/spec/views.md,
// "Making a View", step 4): per Extraction and Signal, how many Threads got a
// value or a clear answer, "none of these", an answer below the floor, or no
// candidate at all, and a diagnosis per Thread for inspect_view_thread. A
// session that saw only "Tried on 30 threads: Unsure 0" guessed the bodies
// were missing; these counts say what actually happened. Code only.

import type {
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
  options: { candidatesMax: number; scopeFacts: ViewDoc["scope"]["facts"]; examples?: number },
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
    const row = {
      field: `x:${x.id}`,
      label: label(x),
      resolved: 0,
      none: 0,
      unsure: 0,
      noCandidates: 0,
      notRead: 0,
      capped: 0,
      examples: [] as string[],
    };
    for (const t of threads) {
      const r = asked.get(t.id);
      const spans = r?.candidates[sid];
      const capped = (spans?.length ?? 0) >= options.candidatesMax;
      if (capped) row.capped += 1;
      const read = readExtraction(doc, t, x.id, ctx);
      let state: ViewThreadDiagnosis["extractions"][number]["state"];
      if (r && spans && spans.length === 0) state = "no_candidates";
      else if (read.state === "value") state = "value";
      else if (read.state === "empty") state = "none";
      else if (read.state === "unsure") state = "unsure";
      else state = "not_read";
      if (state === "value") {
        row.resolved += 1;
        if (read.state === "value" && row.examples.length < (options.examples ?? 3))
          row.examples.push(read.text);
      } else if (state === "none") row.none += 1;
      else if (state === "unsure") row.unsure += 1;
      else if (state === "no_candidates") row.noCandidates += 1;
      else row.notRead += 1;
      const answer = r?.extra[sid];
      const shares = answer?.type === "choice" ? answer.probabilities : null;
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
          probability: shares ? (shares[c.key] ?? 0) : null,
        })),
        capped,
      });
    }
    fields.push(row);
  }
  const { noulLow, noulHigh, confidenceBelow } = ctx.rules;
  for (const s of signalsOf(doc)) {
    const row = {
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
        words = "not read";
      } else if (r.noul !== undefined && r.noul !== null) {
        const clear = r.noul >= noulHigh || r.noul < noulLow;
        if (clear) row.resolved += 1;
        else row.unsure += 1;
        words = `${Math.round(r.noul * 100)}% yes${clear ? "" : " (unsure)"}`;
      } else if (
        r.confidence !== undefined &&
        r.confidence !== null &&
        r.confidence < confidenceBelow
      ) {
        row.unsure += 1;
        words = `${r.choice ?? r.score?.toFixed(1) ?? "?"} at ${Math.round(r.confidence * 100)}% (unsure)`;
      } else if (r.choice === "none") {
        row.none += 1;
        words = "none";
      } else {
        row.resolved += 1;
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
