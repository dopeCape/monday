// Many values per Thread, and questions per row (docs/spec/views.md, "Many
// values" and "Rows"). A View's Extraction may pick every candidate that
// answers (an order confirmation with 9 totals, a digest of 70 packages), a
// message-grain View picks one value per Message, and a View's Signal may be
// asked once per item or per Message. Each is still one Thread's one Signal
// request: code finds the candidates, then asks one independent question per
// candidate (a Noul: "does this span answer?") or per Message (a Choice over
// that Message's candidates), all riding together; never across Threads.
// Code keeps every candidate above the threshold, marks the ones in the Unsure
// band, caps them, and copies each span unchanged. Pure, so every rule is
// testable without a judge.

import type {
  ExtractedItem,
  ExtractKind,
  JsonValue,
  JudgeAnswer,
  JudgeQuestion,
  Person,
  RowAnswer,
  SignalOptionsFrom,
} from "@monday/shared";
import type { Candidate } from "./candidates.ts";

/** How a question is asked of one Thread, from its option source. */
export type RowMode =
  | { mode: "many"; kind: ExtractKind }
  | { mode: "message"; kind: ExtractKind }
  | { mode: "each_item"; kind: ExtractKind }
  | { mode: "each_message" };

/** The per-row mode of an option source; null for a question asked once (a plain Choice). */
export function rowModeOf(from: SignalOptionsFrom | string | null | undefined): RowMode | null {
  if (!from) return null;
  if (from === "each_message") return { mode: "each_message" };
  const at = from.indexOf(":");
  if (at < 0) return null;
  const head = from.slice(0, at);
  const kind = from.slice(at + 1) as ExtractKind;
  if (head === "extract_many") return { mode: "many", kind };
  if (head === "extract_message") return { mode: "message", kind };
  if (head === "each_item") return { mode: "each_item", kind };
  return null;
}

/** One Message of the Thread, as a per-Message question reads it. */
export interface RowMessage {
  id: string;
  /** Its place among the Thread's Messages, oldest first (the question id's suffix). */
  index: number;
  date: string;
  from: Person;
  text: string;
}

/** The words the per-row questions carry (Settings, like every question's words). */
export interface RowWords {
  /** views.extract.many.note */
  manyNote: string;
  /** views.extract.many.yes */
  manyYes: string;
  /** views.each.item_note */
  itemNote: string;
  /** views.each.message_note */
  messageNote: string;
  /** views.grain.message_chars: how much of a Message rides in its question. */
  messageChars: number;
}

export const DEFAULT_ROW_WORDS: RowWords = {
  manyNote:
    "This thread may hold several of the values the question asks for. Judge only this one span.",
  manyYes: "This span is one of the values the question asks for.",
  itemNote: "Judge only this one item of the thread.",
  messageNote: "Judge only this one message of the thread.",
  messageChars: 1500,
};

/** One question of a plan: what it is about, so code can fold its answer back. */
export interface PlannedPart {
  qid: string;
  /** The row it answers: a candidate's key (many, each_item) or a Message's id (message, each_message). */
  key: string;
  candidate?: Candidate | undefined;
  message?: RowMessage | undefined;
  /** For a per-Message Choice: that Message's candidates, by option key. */
  options?: readonly Candidate[] | undefined;
}

export interface RowPlan {
  id: string;
  mode: RowMode;
  questions: Record<string, JudgeQuestion>;
  parts: PlannedPart[];
  /** Candidates past the cap, not asked. */
  capped: number;
  /** Every candidate code found, in order (the tool's diagnosis reads them). */
  found: readonly Candidate[];
}

/** The instructions as an object, whatever shape the template's were. */
function asObject(instructions: unknown): Record<string, JsonValue> {
  return instructions && typeof instructions === "object" && !Array.isArray(instructions)
    ? { ...(instructions as Record<string, JsonValue>) }
    : { question: instructions as JsonValue };
}

/** The Message a span was found in: the first whose text holds it. */
function messageOf(span: string, messages: readonly RowMessage[]): RowMessage | undefined {
  return messages.find((m) => m.text.includes(span));
}

function messageState(m: RowMessage, chars: number): JsonValue {
  return {
    from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email,
    date: m.date,
    text: m.text.length > chars ? `${m.text.slice(0, chars)}...` : m.text,
  };
}

/** The "none of these" words of an Extraction's Choice template. */
function noneWords(template: JudgeQuestion): string {
  if (template.type === "choice") {
    const none = (template.criteria as Record<string, unknown>).none;
    if (typeof none === "string") return none;
  }
  return "This span is not one of the values the question asks for.";
}

/**
 * The questions one Thread is asked for one per-row question: a Noul per
 * candidate (many), a Choice per Message over its candidates (message), the
 * Signal's own question per candidate (each_item) or per Message
 * (each_message). `found` is the Thread's candidates of the kind; `perMessage`
 * each Message's own. At most `cap` candidates are asked.
 */
export function planRows(
  id: string,
  template: JudgeQuestion,
  mode: RowMode,
  input: {
    found: readonly Candidate[];
    messages: readonly RowMessage[];
    perMessage?: (m: RowMessage) => readonly Candidate[];
    listOptions: (template: JudgeQuestion, found: readonly Candidate[]) => JudgeQuestion;
  },
  words: RowWords,
  cap: number,
): RowPlan {
  const plan: RowPlan = { id, mode, questions: {}, parts: [], capped: 0, found: input.found };
  const base = asObject(template.instructions);
  if (mode.mode === "many" || mode.mode === "each_item") {
    const asked = input.found.slice(0, Math.max(1, cap));
    plan.capped = input.found.length - asked.length;
    asked.forEach((c, n) => {
      const qid = `${id}#i${n + 1}`;
      const message = messageOf(c.span, input.messages);
      plan.questions[qid] =
        mode.mode === "many"
          ? {
              type: "noul",
              instructions: {
                ...base,
                candidate: c.span,
                words_around: c.line,
                note: words.manyNote,
              },
              criteria: { true: words.manyYes, false: noneWords(template) },
            }
          : ({
              ...template,
              instructions: { ...base, item: c.span, words_around: c.line, note: words.itemNote },
            } as JudgeQuestion);
      plan.parts.push({ qid, key: c.key, candidate: c, message });
    });
    return plan;
  }
  for (const m of input.messages) {
    const qid = `${id}#m${m.index}`;
    const instructions = {
      ...base,
      message: messageState(m, words.messageChars),
      note: words.messageNote,
    };
    if (mode.mode === "each_message") {
      plan.questions[qid] = { ...template, instructions } as JudgeQuestion;
      plan.parts.push({ qid, key: m.id, message: m });
      continue;
    }
    const options = (input.perMessage?.(m) ?? []).slice(0, Math.max(1, cap));
    if (options.length === 0) continue;
    plan.questions[qid] = {
      ...input.listOptions(template, options),
      instructions,
    } as JudgeQuestion;
    plan.parts.push({ qid, key: m.id, message: m, options });
  }
  return plan;
}

/** What code keeps of a plan's answers. */
export interface RowFold {
  /** The one answer stored for the Thread (the answer row says picked or none, never a span). */
  row: JudgeAnswer;
  /** The stored option in place of a span: picked, none, or each. */
  choice: string | undefined;
  items?: ExtractedItem[] | undefined;
  answers?: Record<string, RowAnswer> | undefined;
  capped: number;
}

/**
 * The answers folded back: a many-Extraction keeps every candidate at or above
 * `threshold` (at most `max`, in order of appearance) and marks the ones in the
 * Unsure band (from `unsureFrom`); a message-grain Extraction keeps each
 * Message's pick; a per-row Signal keeps its answer per row. Null when nothing
 * was answered.
 */
export function foldRows(
  plan: RowPlan,
  answers: Readonly<Record<string, JudgeAnswer | undefined>>,
  rules: { threshold: number; unsureFrom: number; max: number },
): RowFold | null {
  const answered = plan.parts.filter((p) => answers[p.qid] !== undefined);
  if (answered.length === 0 && plan.parts.length > 0) return null;
  const { mode } = plan;
  if (mode.mode === "many") {
    const items: ExtractedItem[] = [];
    let picked = 0;
    let top = 0;
    let least = 1;
    for (const p of answered) {
      const a = answers[p.qid];
      if (a?.type !== "noul" || !p.candidate) continue;
      top = Math.max(top, a.noul);
      const yes = a.noul >= rules.threshold;
      const band = !yes && a.noul >= rules.unsureFrom;
      if (!yes && !band) continue;
      if (yes && picked >= rules.max) continue;
      if (yes) {
        picked += 1;
        least = Math.min(least, a.noul);
      }
      items.push({
        key: p.candidate.key,
        text: p.candidate.span,
        value: p.candidate.value,
        confidence: Math.round(a.noul * 1000) / 1000,
        ...(band ? { unsure: true } : {}),
        message: p.message?.id ?? null,
        at: p.message?.date ?? null,
      });
    }
    const confidence = picked ? least : Math.max(0, 1 - top);
    return {
      row: {
        type: "choice",
        choice: picked ? "picked" : "none",
        probabilities: {},
        confidence: Math.round(confidence * 1000) / 1000,
      },
      choice: picked ? "picked" : "none",
      items,
      capped: plan.capped,
    };
  }
  if (mode.mode === "message") {
    const items: ExtractedItem[] = [];
    let least = 1;
    for (const p of answered) {
      const a = answers[p.qid];
      if (a?.type !== "choice" || a.choice === "none") continue;
      const c = p.options?.find((o) => o.key === a.choice);
      if (!c) continue;
      least = Math.min(least, a.confidence);
      items.push({
        key: `${p.message?.index ?? 0}:${c.key}`,
        text: c.span,
        value: c.value,
        confidence: Math.round(a.confidence * 1000) / 1000,
        message: p.message?.id ?? null,
        at: p.message?.date ?? null,
      });
    }
    return {
      row: {
        type: "choice",
        choice: items.length ? "picked" : "none",
        probabilities: {},
        confidence: items.length ? least : 1,
      },
      choice: items.length ? "picked" : "none",
      items,
      capped: plan.capped,
    };
  }
  // A per-row Signal: its answer per row, and one answer for the Thread so it is not asked again.
  const out: Record<string, RowAnswer> = {};
  let noul = 0;
  let score = 0;
  for (const p of answered) {
    const a = answers[p.qid];
    if (!a) continue;
    const where = { message: p.message?.id ?? null, at: p.message?.date ?? null };
    if (a.type === "noul") {
      noul = Math.max(noul, a.noul);
      out[p.key] = { noul: a.noul, ...where };
    } else if (a.type === "choice") {
      out[p.key] = { choice: a.choice, confidence: a.confidence, ...where };
    } else {
      score = Math.max(score, a.score);
      out[p.key] = { score: a.score, confidence: a.confidence, ...where };
    }
  }
  const first = answered.map((p) => answers[p.qid]).find(Boolean);
  const row: JudgeAnswer =
    first?.type === "noul"
      ? { type: "noul", noul }
      : first?.type === "score"
        ? { type: "score", score, probabilities: first.probabilities, confidence: 1 }
        : { type: "choice", choice: "each", probabilities: {}, confidence: 1 };
  return {
    row,
    choice: first?.type === "choice" ? "each" : undefined,
    answers: out,
    capped: plan.capped,
  };
}
