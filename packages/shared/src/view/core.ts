// Views (docs/spec/views.md): the code-only scope, the Thread as a View
// reads it (its Facts, Signal answers and picked values), three-valued
// conditions, Lane placement with hysteresis, the Lanes a lanes Block draws,
// and what the test card and the moves preview compute. Pure and
// runtime-neutral, so the Server (the test, the Signal scope) and the Device
// (Blocks over thread_signals, thread_facts and view_values in SQLite) read
// Views one way.
//
// Three-valued: each test is true, false or unknown (an Unsure answer, an
// Extraction below its floor, or a Signal not read yet). Lanes are tried in
// order; the first Lane whose condition is true takes the Thread unless an
// earlier Lane was unknown, in which case the Thread goes to Unsure. So a
// Thread is never placed in Green because Red could not be decided.

import { utcToZoned, zonedToUtc } from "../calendar.ts";
import type { ChoiceQuestion, JsonValue } from "../judge.ts";
import type { SignalQuestion, SignalReading, SignalReadings, SignalRules } from "../signals.ts";
import { questionLabel } from "../signals.ts";
import type {
  DateRef,
  DateScope,
  ExtractedItem,
  ExtractedValue,
  ExtractTest,
  FactTest,
  Lane,
  LaneCondition,
  RowAnswer,
  SignalTest,
  ViewDoc,
  ViewExample,
  ViewExtraction,
  ViewFact,
  ViewPlacement,
  ViewScopeFacts,
  ViewSignal,
  ViewSort,
} from "./types.ts";
import { VIEW_FACTS } from "./types.ts";

/* ------------------------------ Ids ------------------------------ */

/**
 * The stored id of a View's own Signal. The prefix predates Views (ADR 0016):
 * kept so the answers asked before and the Device's cached rows keep their ids.
 */
export const viewSignalId = (viewId: string, signalId: string) => `board:${viewId}:${signalId}`;

/** The stored id of a View's Extraction: a Choice Signal owned by the View. */
export const viewExtractionId = (viewId: string, extractionId: string) =>
  `board:${viewId}:x_${extractionId}`;

/** The Lane id a Thread no Signal could decide goes to. */
export const UNSURE_LANE = "unsure";
/** The Lane id of Threads no Lane claims (hidden unless the View shows them). */
export const OTHERS_LANE = "others";

/**
 * The shipped Signals a View may read (`uses`), with their kind and, for a
 * Score, how many levels it has. The View's reasons read these.
 */
export const VIEW_SHIPPED_SIGNALS: Readonly<
  Record<string, { kind: "noul" | "score" | "choice"; levels?: number; label: string }>
> = {
  needs_reply: { kind: "noul", label: "needs a reply" },
  waiting_on_me: { kind: "noul", label: "waiting on you" },
  waiting_on_others: { kind: "noul", label: "waiting on others" },
  newsletter: { kind: "noul", label: "newsletter" },
  automated: { kind: "noul", label: "automated" },
  personal: { kind: "noul", label: "written by a person" },
  has_deadline: { kind: "noul", label: "has a deadline" },
  money_involved: { kind: "noul", label: "money involved" },
  owner_promised: { kind: "noul", label: "you promised" },
  they_promised: { kind: "noul", label: "they promised" },
  frustrated: { kind: "score", levels: 4, label: "frustrated" },
  urgency: { kind: "score", levels: 4, label: "urgent" },
  brief_worth: { kind: "score", levels: 4, label: "worth a brief" },
  money_direction: { kind: "choice", label: "money" },
};

/** The Signals a Lane or the layout reads, local ids, in order of first use. */
export function signalsRead(doc: ViewDoc): string[] {
  const out: string[] = [];
  const walk = (c: LaneCondition) => {
    if ("all" in c) c.all.forEach(walk);
    else if ("any" in c) c.any.forEach(walk);
    else if ("not" in c) walk(c.not);
    else if ("signal" in c && !out.includes(c.signal)) out.push(c.signal);
  };
  for (const l of doc.lanes) walk(l.when);
  return out;
}

/** Whether a View reads mail through Signals or Extractions (it then needs a judge); a Fact-only View does not. */
export function viewReadsSignals(doc: ViewDoc): boolean {
  return (
    doc.signals.length > 0 ||
    doc.extractions.length > 0 ||
    doc.uses.length > 0 ||
    signalsRead(doc).length > 0
  );
}

/**
 * The Extractions a View's Blocks add up, group or chart by (local ids): a
 * tried Thread tells the most about the View when code finds candidates for
 * each of them. None when no Block adds one up.
 */
export function aggregatedExtractions(doc: ViewDoc): string[] {
  const out: string[] = [];
  const take = (ref: string | undefined) => {
    if (!ref?.startsWith("x:")) return;
    const id = ref.slice(2);
    if (doc.extractions.some((x) => x.id === id) && !out.includes(id)) out.push(id);
  };
  for (const b of doc.blocks) {
    take(b.query?.aggregate?.field);
    take(b.query?.group_by?.field);
    if (b.type === "chart") take(b.series?.field);
  }
  return out;
}

/* ------------------------------ The question as asked ------------------------------ */

const EXAMPLES_NOTE =
  "Past decisions the mailbox owner made about other threads. Use them to understand what the owner means; judge only the current thread.";

/**
 * A View Signal's question as it is asked: its own words, with the
 * Examples the user's corrections made (newest first, up to `max` of each
 * answer) in its instructions, the way a Section's Examples ride.
 */
export function viewQuestion(
  signal: ViewSignal,
  examples: readonly ViewExample[] | undefined,
  max = 5,
): SignalQuestion {
  const used = [...(examples ?? [])]
    .filter((e) => e.holds !== undefined)
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const shown = [
    ...used.filter((e) => e.holds).slice(0, max),
    ...used.filter((e) => e.holds === false).slice(0, max),
  ];
  if (shown.length === 0) return signal.question;
  const examplesJson: JsonValue[] = shown.map((e) => ({
    holds: e.holds ?? null,
    from: e.from ?? "",
    subject: e.subject ?? "",
  }));
  const instructions: JsonValue =
    signal.question.instructions &&
    typeof signal.question.instructions === "object" &&
    !Array.isArray(signal.question.instructions)
      ? {
          ...(signal.question.instructions as Record<string, JsonValue>),
          examples_note: EXAMPLES_NOTE,
          examples: examplesJson,
        }
      : {
          statement: signal.question.instructions,
          examples_note: EXAMPLES_NOTE,
          examples: examplesJson,
        };
  return { ...signal.question, instructions } as SignalQuestion;
}

/** The Signals a View declares for the Signal store: stored id, kind and the question as asked. */
export function viewSignalDefs(
  doc: ViewDoc,
  examplesMax = 5,
): Array<{
  id: string;
  local: string;
  kind: ViewSignal["kind"];
  question: SignalQuestion;
  /** Asked per row: per candidate of the item Extraction's kind, or per Message. */
  each: { item: ViewExtraction["find"] } | { message: true } | null;
}> {
  const itemOf = doc.extractions.find((x) => x.id === doc.item_of);
  return doc.signals.map((s) => ({
    id: viewSignalId(doc.id, s.id),
    local: s.id,
    kind: s.kind,
    question: viewQuestion(s, doc.examples[s.id], examplesMax),
    each: !s.each
      ? null
      : doc.grain === "message"
        ? { message: true as const }
        : doc.grain === "item" && itemOf
          ? { item: itemOf.find }
          : null,
  }));
}

/**
 * How an Extraction is asked: one value per Thread (a Choice), many (a Noul per
 * candidate), or one per Message in a message-grain View.
 */
export function extractionMode(doc: ViewDoc, x: ViewExtraction): "one" | "many" | "message" {
  if (doc.grain === "message") return "message";
  return x.many ? "many" : "one";
}

/** The words of "none of these" when an Extraction names none (views.extract.none). */
export const DEFAULT_EXTRACT_NONE = "None of these is the requested value.";

/**
 * An Extraction's question as it is asked: a Choice whose options code adds
 * per Thread (the candidates it found), with `none` always there. The
 * user's "Wrong value" corrections ride as Examples of the span that was
 * right, the way a Signal's do.
 */
export function extractionQuestion(
  x: ViewExtraction,
  examples: readonly ViewExample[] | undefined,
  options: { none?: string; max?: number } = {},
): ChoiceQuestion {
  const used = [...(examples ?? [])]
    .filter((e) => e.value !== undefined)
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, options.max ?? 5);
  const base: JsonValue =
    x.question && typeof x.question === "object" && !Array.isArray(x.question)
      ? (x.question as Record<string, JsonValue>)
      : { question: x.question as JsonValue };
  const instructions: JsonValue = used.length
    ? {
        ...(base as Record<string, JsonValue>),
        examples_note: EXAMPLES_NOTE,
        examples: used.map((e) => ({
          from: e.from ?? "",
          subject: e.subject ?? "",
          right_value: e.value ?? "none of them",
        })),
      }
    : typeof x.question === "string"
      ? x.question
      : base;
  return {
    type: "choice",
    instructions,
    criteria: { none: x.none ?? options.none ?? DEFAULT_EXTRACT_NONE },
  } as ChoiceQuestion;
}

/** The Extractions a View declares for the Signal store: stored id, kind and the question template. */
export function viewExtractionDefs(
  doc: ViewDoc,
  options: { none?: string; examplesMax?: number } = {},
): Array<{
  id: string;
  local: string;
  find: ViewExtraction["find"];
  question: ChoiceQuestion;
  mode: "one" | "many" | "message";
  /** A many-Extraction's own cap on values per Thread. */
  max: number | null;
}> {
  return doc.extractions.map((x) => ({
    id: viewExtractionId(doc.id, x.id),
    local: x.id,
    find: x.find,
    mode: extractionMode(doc, x),
    max: x.max ?? null,
    question: extractionQuestion(x, doc.examples[`x:${x.id}`], {
      ...(options.none ? { none: options.none } : {}),
      ...(options.examplesMax !== undefined ? { max: options.examplesMax } : {}),
    }),
  }));
}

/* ------------------------------ Dates ------------------------------ */

export function validZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Midnight of the day `at` falls on, in the zone (or the host's own when none is set). */
export function startOfDay(at: Date, zone: string, plusDays = 0): Date {
  if (validZone(zone)) {
    const z = utcToZoned(zone, at);
    const day = new Date(Date.UTC(z.y, z.mo - 1, z.d + plusDays));
    return zonedToUtc(zone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, 0);
  }
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + plusDays);
}

/** The weekday of `at` in the zone, Monday 0. */
function weekdayIn(at: Date, zone: string): number {
  const d = startOfDay(at, zone);
  const noon = new Date(d.getTime() + 12 * 3_600_000);
  const day = validZone(zone)
    ? new Date(
        Date.UTC(utcToZoned(zone, noon).y, utcToZoned(zone, noon).mo - 1, utcToZoned(zone, noon).d),
      ).getUTCDay()
    : noon.getDay();
  return (day + 6) % 7;
}

/** A DateRef as an instant. */
export function resolveDateRef(ref: DateRef, now: Date, zone: string): Date {
  if (typeof ref === "object") return new Date(now.getTime() + ref.days * 86_400_000);
  switch (ref) {
    case "now":
      return now;
    case "today":
      return startOfDay(now, zone);
    case "tomorrow":
    case "end_of_today":
      return startOfDay(now, zone, 1);
    case "end_of_week":
      return startOfDay(now, zone, 7 - weekdayIn(now, zone));
    case "end_of_next_week":
      return startOfDay(now, zone, 14 - weekdayIn(now, zone));
    case "end_of_month": {
      if (validZone(zone)) {
        const z = utcToZoned(zone, now);
        return zonedToUtc(
          zone,
          z.mo === 12 ? z.y + 1 : z.y,
          z.mo === 12 ? 1 : z.mo + 1,
          1,
          0,
          0,
          0,
        );
      }
      return new Date(now.getFullYear(), now.getMonth() + 1, 1);
    }
    default: {
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(ref)
        ? validZone(zone)
          ? zonedToUtc(
              zone,
              Number(ref.slice(0, 4)),
              Number(ref.slice(5, 7)),
              Number(ref.slice(8, 10)),
              0,
              0,
              0,
            )
          : new Date(Number(ref.slice(0, 4)), Number(ref.slice(5, 7)) - 1, Number(ref.slice(8, 10)))
        : new Date(ref);
      return Number.isNaN(parsed.getTime()) ? now : parsed;
    }
  }
}

/** Where a date part of the scope starts: today's midnight, this week's Monday, N days ago, a date. */
export function dateScopeStart(scope: DateScope, now: Date, zone: string): Date {
  if ("within" in scope) {
    return scope.within === "today"
      ? startOfDay(now, zone)
      : startOfDay(now, zone, -weekdayIn(now, zone));
  }
  if ("last_days" in scope) return new Date(now.getTime() - scope.last_days * 86_400_000);
  return resolveDateRef(scope.since, now, zone);
}

/**
 * The scope with only its date part widened to the last `days` days: how a
 * quiet scope ("today" has 4 threads) finds Threads to test on.
 */
export function widenScope(facts: ViewScopeFacts, days: number): ViewScopeFacts {
  return {
    ...facts,
    ...(facts.received ? { received: { last_days: days } } : {}),
    ...(facts.active ? { active: { last_days: days } } : {}),
  };
}

/** The earliest moment the scope's date parts admit, for a query's bound; null when it has none. */
export function scopeSince(facts: ViewScopeFacts, now: Date, zone: string): Date | null {
  const starts = [facts.received, facts.active]
    .filter((d): d is DateScope => d !== undefined)
    .map((d) => dateScopeStart(d, now, zone).getTime());
  return starts.length ? new Date(Math.max(...starts)) : null;
}

/* ------------------------------ The Thread as a View reads it ------------------------------ */

/** What a View reads about one Thread: its row, its clear Facts and its Signal answers. */
export interface ViewThread {
  id: string;
  messageCount: number;
  lastActivity: string;
  /** When its first Message arrived; null when not known yet (the Thread's last activity stands in). */
  receivedAt: string | null;
  unread: boolean;
  starred: boolean;
  archived: boolean;
  deleted: boolean;
  snoozed: boolean;
  group: string | null;
  subgroup: string | null;
  section: string | null;
  hasAttachments: boolean;
  /** Who started it: the first Message's sender, lowercased. */
  from: string | null;
  /** Every To and Cc address on its Messages, lowercased. */
  recipients: readonly string[];
  /** The clear Facts (thread_facts); null until the Signal request computed them. */
  facts: Readonly<Record<string, unknown>> | null;
  /** Signal answers by stored id. */
  readings: SignalReadings;
  /** The values the View's Extractions picked, by stored id (sealed on the Server, mirrored in the Cache). */
  values?: Readonly<Record<string, ExtractedValue>> | undefined;
  /** The subject and snippet, when the reader of the View has them (the Device; the test's tried Threads). */
  subject?: string | undefined;
  /** The subject's searchable prefix (the Server's clear subject_search: lowercased, 80 characters). */
  subjectSearch?: string | undefined;
  snippet?: string | undefined;
  /** The correspondent: the newest sender who is not the owner, else the first. */
  correspondent?: { name: string; email: string } | null | undefined;
  /** Dedupe merged these Threads into this row, newest first (the row is the newest). */
  merged?: readonly string[] | undefined;
  /**
   * An item or a Message of the Thread as its own row (grain item or message): its key
   * among the Thread's rows, the Message it came from and that Message's date. The row's
   * `id` stays the Thread's, so every row opens its Thread.
   */
  row?:
    | { key: string; message?: string | null | undefined; at?: string | null | undefined }
    | undefined;
}

/** A row's own key: the Thread's id, with the item's or Message's key for an item or Message row. */
export const rowKey = (t: Pick<ViewThread, "id" | "row">): string =>
  t.row ? `${t.id}#${t.row.key}` : t.id;

export interface ViewContext {
  rules: SignalRules;
  now: Date;
  /** The Workspace's zone (calendar.time_zone); empty means the host's own. */
  zone: string;
  /** The owner's address, lowercased. */
  owner: string;
  /** Below this an Extraction's pick is Unsure, unless it names its own (views.extract.min_confidence). */
  extractFloor?: number | undefined;
}

/** The default confidence floor of an Extraction. */
export const DEFAULT_EXTRACT_FLOOR = 0.6;

export const domainOfAddress = (address: string | null) =>
  address ? (address.split("@")[1] ?? "").toLowerCase() : "";

/** How long the subject's clear prefix is (the Server's subject_search, ADR 0015). */
export const SUBJECT_SEARCH_CHARS = 80;

/** A subject as its clear prefix: lowercased, whitespace collapsed, the first 80 characters. */
export function subjectSearchOf(subject: string): string {
  return subject.toLowerCase().replace(/\s+/g, " ").trim().slice(0, SUBJECT_SEARCH_CHARS);
}

/** The subject words a Thread's subject holds, or null when its subject is not known here. */
function subjectHolds(words: readonly string[], t: ViewThread): boolean | null {
  const prefix = t.subjectSearch ?? (t.subject !== undefined ? subjectSearchOf(t.subject) : null);
  if (prefix === null) return null;
  return words.some((w) => prefix.includes(w.toLowerCase()));
}

/** Whether the scope's exact filters admit a Thread. Code only. */
export function scopeAdmits(
  facts: ViewScopeFacts,
  t: ViewThread,
  ctx: Pick<ViewContext, "now" | "zone">,
): boolean {
  if (t.deleted) return false;
  const folder = facts.folder ?? "inbox";
  if (folder === "inbox" && (t.archived || t.snoozed)) return false;
  if (folder === "archive" && !t.archived) return false;
  if (folder.startsWith("group:")) {
    const g = folder.slice("group:".length);
    if (t.group !== g && t.subgroup !== g) return false;
  }
  if (folder.startsWith("section:")) {
    if (t.section !== folder.slice("section:".length) || t.archived || t.snoozed) return false;
  }
  const received = Date.parse(t.receivedAt ?? t.lastActivity);
  if (
    facts.received &&
    !(received >= dateScopeStart(facts.received, ctx.now, ctx.zone).getTime())
  ) {
    return false;
  }
  if (
    facts.active &&
    !(Date.parse(t.lastActivity) >= dateScopeStart(facts.active, ctx.now, ctx.zone).getTime())
  ) {
    return false;
  }
  const from = t.from?.toLowerCase() ?? null;
  if (facts.from_any?.length && !(from && facts.from_any.includes(from))) return false;
  if (facts.from_domain?.length && !facts.from_domain.includes(domainOfAddress(from))) return false;
  if (facts.from_domain_not?.length && facts.from_domain_not.includes(domainOfAddress(from)))
    return false;
  if (facts.to_any?.length && !t.recipients.some((r) => facts.to_any?.includes(r.toLowerCase()))) {
    return false;
  }
  // A subject not known to this reader cannot refuse: the SQL that loaded it already asked.
  if (facts.subject_any?.length && subjectHolds(facts.subject_any, t) === false) return false;
  return true;
}

/** A date part of the scope in words: "today", "the last 365 days", "since 2026-01-01". */
function dateScopeWords(d: DateScope): string {
  if ("within" in d) return d.within === "today" ? "today" : "this week";
  if ("last_days" in d) return `the last ${d.last_days} days`;
  return `since ${d.since}`;
}

/**
 * Why the scope admits a Thread or not, fact by fact, in words for the Agent
 * (inspect_view_thread): "started by auto-confirm@amazon.in, in from_any".
 * Code only, the same tests as scopeAdmits.
 */
export function scopeReasons(
  facts: ViewScopeFacts,
  t: ViewThread,
  ctx: Pick<ViewContext, "now" | "zone">,
): { admitted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const folder = facts.folder ?? "inbox";
  const where = t.archived ? "archived" : t.snoozed ? "snoozed" : "in the inbox";
  reasons.push(`folder ${folder}: the thread is ${where}`);
  const received = t.receivedAt ?? t.lastActivity;
  if (facts.received) {
    const ok = Date.parse(received) >= dateScopeStart(facts.received, ctx.now, ctx.zone).getTime();
    reasons.push(
      `received ${received.slice(0, 10)}, ${ok ? "within" : "outside"} ${dateScopeWords(facts.received)}`,
    );
  }
  if (facts.active) {
    const ok =
      Date.parse(t.lastActivity) >= dateScopeStart(facts.active, ctx.now, ctx.zone).getTime();
    reasons.push(
      `last active ${t.lastActivity.slice(0, 10)}, ${ok ? "within" : "outside"} ${dateScopeWords(facts.active)}`,
    );
  }
  const from = t.from?.toLowerCase() ?? "";
  if (facts.from_any?.length)
    reasons.push(
      `started by ${from || "nobody known"}, ${facts.from_any.includes(from) ? "in" : "not in"} from_any`,
    );
  if (facts.from_domain?.length)
    reasons.push(
      `sender domain ${domainOfAddress(from) || "none"}, ${facts.from_domain.includes(domainOfAddress(from)) ? "in" : "not in"} from_domain`,
    );
  if (facts.from_domain_not?.length)
    reasons.push(
      `sender domain ${domainOfAddress(from) || "none"}, ${facts.from_domain_not.includes(domainOfAddress(from)) ? "in" : "not in"} from_domain_not`,
    );
  if (facts.to_any?.length) {
    const hit = t.recipients.find((r) => facts.to_any?.includes(r.toLowerCase()));
    reasons.push(hit ? `sent to ${hit}, in to_any` : "sent to none of to_any");
  }
  if (facts.subject_any?.length) {
    const prefix = t.subjectSearch ?? subjectSearchOf(t.subject ?? "");
    const hit = facts.subject_any.find((w) => prefix.includes(w.toLowerCase()));
    reasons.push(
      hit ? `the subject holds "${hit}", in subject_any` : "the subject holds none of subject_any",
    );
  }
  return { admitted: scopeAdmits(facts, t, ctx), reasons };
}

/* ------------------------------ Three-valued evaluation ------------------------------ */

/** true, false, or null for unknown (Unsure, or not read yet). */
export type Tri = boolean | null;

export interface EvalState {
  /** Something unknown was met because a Signal had no answer at all (not read yet). */
  notRead: boolean;
  /** The Lane the Thread is in, for a `lane` test (a query's `where`, an action's `when`). */
  lane?: string | null | undefined;
}

/** An Extraction's value on one Thread, three-valued: a value, Unsure, not stated, or not read yet. */
export type ExtractRead =
  | {
      state: "value";
      text: string;
      value: JsonValue;
      confidence: number;
      /** A many-Extraction's values on a Thread row (each one on an item row). */
      items?: readonly ExtractedItem[] | undefined;
    }
  | { state: "unsure"; text: string | null; confidence: number | null }
  | { state: "empty" }
  | { state: "not_read" };

/**
 * What an Extraction picked on a Thread. The answer row says only "picked"
 * or "none" and the confidence; the value is mirrored beside it. Below the
 * floor (the Extraction's own, else the context's) a pick or a "none" is
 * Unsure; a pick whose value has not reached this reader yet is not read.
 */
export function readExtraction(
  doc: ViewDoc,
  t: ViewThread,
  local: string,
  ctx: Pick<ViewContext, "rules" | "extractFloor">,
): ExtractRead {
  const x = doc.extractions.find((e) => e.id === local);
  const id = viewExtractionId(doc.id, local);
  const r = t.readings[id];
  const v = t.values?.[id];
  if (r?.stale && ctx.rules.staleAnswers === "hide") return { state: "not_read" };
  const floor = x?.min_confidence ?? ctx.extractFloor ?? DEFAULT_EXTRACT_FLOOR;
  if (v?.items) {
    // Many values (or one per Message, on a Thread row): the ones above the threshold, at most
    // the Extraction's own max; the rest inside the Unsure band make the Field Unsure only when
    // nothing was picked.
    const picked = v.items.filter((i) => !i.unsure).slice(0, x?.max ?? v.items.length);
    if (picked.length > 0) {
      return {
        state: "value",
        text: picked.map((i) => i.text).join(", "),
        value: (picked[0] as ExtractedItem).value,
        confidence: Math.min(...picked.map((i) => i.confidence)),
        items: picked,
      };
    }
    if (v.items.length > 0) return { state: "unsure", text: null, confidence: null };
    return { state: "empty" };
  }
  if (r?.choice === "none") {
    const c = r.confidence ?? 1;
    return c >= floor ? { state: "empty" } : { state: "unsure", text: null, confidence: c };
  }
  if (v) {
    return v.confidence >= floor
      ? { state: "value", text: v.text, value: v.value, confidence: v.confidence }
      : { state: "unsure", text: v.text, confidence: v.confidence };
  }
  return { state: "not_read" };
}

/** A picked value as a number (money's amount, a quantity), or null. */
export function numberOf(value: JsonValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const n = (value as Record<string, JsonValue>).value;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

/** A picked value as words to compare with `is` / `in`: a link's address, else its text. */
function wordsOfValue(value: JsonValue, text: string): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, JsonValue>;
    return [text, ...["url", "domain", "currency"].map((k) => String(o[k] ?? ""))]
      .filter(Boolean)
      .map((s) => s.toLowerCase());
  }
  return [String(value ?? text).toLowerCase(), text.toLowerCase()];
}

function extractTest(
  c: ExtractTest,
  doc: ViewDoc,
  t: ViewThread,
  ctx: ViewContext,
  state: EvalState,
): Tri {
  const read = readExtraction(doc, t, c.extract, ctx);
  if (read.state === "not_read") {
    state.notRead = true;
    return null;
  }
  if (read.state === "unsure") return null;
  if (read.state === "empty") {
    return c.present === false;
  }
  if (c.present !== undefined && !c.present) return false;
  const n = numberOf(read.value);
  if (c.at_least !== undefined && !(n !== null && n >= c.at_least)) return false;
  if (c.at_most !== undefined && !(n !== null && n <= c.at_most)) return false;
  if (c.before !== undefined || c.after !== undefined) {
    const at = typeof read.value === "string" ? Date.parse(read.value) : Number.NaN;
    if (Number.isNaN(at)) return false;
    if (c.before !== undefined && !(at < resolveDateRef(c.before, ctx.now, ctx.zone).getTime()))
      return false;
    if (c.after !== undefined && !(at >= resolveDateRef(c.after, ctx.now, ctx.zone).getTime()))
      return false;
  }
  const words = wordsOfValue(read.value, read.text);
  if (c.is !== undefined && !words.includes(c.is.toLowerCase())) return false;
  if (c.in && !c.in.some((x) => words.includes(x.toLowerCase()))) return false;
  return true;
}

/** A View's reading of one Signal by its local id: its own are stored as view:<id>:<local>. */
export function readingOf(doc: ViewDoc, t: ViewThread, local: string): SignalReading | undefined {
  const own = doc.signals.some((s) => s.id === local);
  return t.readings[own ? viewSignalId(doc.id, local) : local];
}

export function factValue(t: ViewThread, fact: ViewFact): unknown {
  switch (fact) {
    case "message_count":
      return t.messageCount;
    case "has_attachment":
      return (
        t.hasAttachments ||
        (typeof t.facts?.attachment_count === "number"
          ? (t.facts.attachment_count as number) > 0
          : false)
      );
    case "unread":
      return t.unread;
    case "starred":
      return t.starred;
    case "in_group":
      return [t.group, t.subgroup].filter((g): g is string => g !== null);
    case "in_section":
      return t.section;
    case "last_activity_at":
      return t.lastActivity;
    case "received_at":
      return t.facts?.received_at ?? t.receivedAt ?? t.lastActivity;
    case "from_address":
      return t.facts?.from_address ?? t.from;
    case "from_domain":
      return t.facts?.from_domain ?? (t.from ? domainOfAddress(t.from) : undefined);
    case "amount": {
      const a = t.facts?.amount;
      if (typeof a === "number") return a;
      if (a && typeof a === "object" && typeof (a as { value?: unknown }).value === "number") {
        return (a as { value: number }).value;
      }
      return t.facts?.amount_value;
    }
    default:
      return t.facts ? t.facts[fact] : undefined;
  }
}

function factTest(c: FactTest, t: ViewThread, ctx: ViewContext, state: EvalState): Tri {
  const v = factValue(t, c.fact);
  const kind = VIEW_FACTS[c.fact];
  if (v === undefined || v === null) {
    // Once the Facts are computed a missing value is a no (code found no deadline);
    // before, the Thread has not been read yet.
    if (t.facts) return false;
    state.notRead = true;
    return null;
  }
  if (kind === "flag") return (v === true || v === 1) === c.is;
  if (kind === "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (c.at_least !== undefined && n < c.at_least) return false;
    if (c.at_most !== undefined && n > c.at_most) return false;
    return true;
  }
  if (kind === "date") {
    const at = Date.parse(String(v));
    if (Number.isNaN(at)) return false;
    if (c.before !== undefined && !(at < resolveDateRef(c.before, ctx.now, ctx.zone).getTime()))
      return false;
    if (c.after !== undefined && !(at >= resolveDateRef(c.after, ctx.now, ctx.zone).getTime()))
      return false;
    return true;
  }
  const values = (Array.isArray(v) ? v : [v]).map((x) => String(x).toLowerCase());
  if (typeof c.is === "string" && !values.includes(c.is.toLowerCase())) return false;
  if (c.in && !c.in.some((x) => values.includes(x.toLowerCase()))) return false;
  return true;
}

/**
 * One Signal test, three-valued. `margin` moves every threshold: positive
 * for a Lane the Thread is not in (the answer must be clearly past it),
 * negative for the Lane it is in (it stays until clearly past the other
 * way), 0 for a first placement (signals.hysteresis).
 */
function signalTest(
  c: SignalTest,
  doc: ViewDoc,
  t: ViewThread,
  ctx: ViewContext,
  margin: number,
  state: EvalState,
): Tri {
  const r = readingOf(doc, t, c.signal);
  if (!r) {
    state.notRead = true;
    return null;
  }
  if (r.stale && ctx.rules.staleAnswers === "hide") {
    state.notRead = true;
    return null;
  }
  const { noulLow, noulHigh, confidenceBelow } = ctx.rules;
  if (r.noul !== undefined && r.noul !== null) {
    const p = r.noul;
    if (c.holds !== undefined || c.fails !== undefined) {
      const wantHolds = c.holds !== undefined ? c.holds : !(c.fails as boolean);
      const high = (c.holds !== undefined ? c.at_least : undefined) ?? noulHigh;
      const low = Math.min(noulLow, high);
      const lowFail = (c.fails !== undefined ? c.at_most : undefined) ?? low;
      const holds: Tri =
        p >= high + margin ? true : p < Math.min(lowFail, high) - margin ? false : null;
      if (holds === null) return null;
      return wantHolds ? holds : !holds;
    }
    if (c.at_least !== undefined && p < c.at_least + margin) return false;
    if (c.at_most !== undefined && p > c.at_most - margin) return false;
    return true;
  }
  if (r.confidence !== undefined && r.confidence !== null && r.confidence < confidenceBelow)
    return null;
  if (c.is !== undefined) {
    if (r.choice === undefined || r.choice === null) return null;
    return r.choice === c.is;
  }
  const v = r.score ?? null;
  if (v === null) return null;
  if (c.at_least !== undefined && v < c.at_least + margin) return false;
  if (c.at_most !== undefined && v > c.at_most - margin) return false;
  return true;
}

/** A Lane condition, three-valued: all is false on any false, any is true on any true, unknown otherwise. */
export function evaluateLaneCondition(
  cond: LaneCondition,
  doc: ViewDoc,
  t: ViewThread,
  ctx: ViewContext,
  margin = 0,
  state: EvalState = { notRead: false },
): Tri {
  if ("all" in cond) {
    let unknown = false;
    for (const c of cond.all) {
      const v = evaluateLaneCondition(c, doc, t, ctx, margin, state);
      if (v === false) return false;
      if (v === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if ("any" in cond) {
    let unknown = false;
    for (const c of cond.any) {
      const v = evaluateLaneCondition(c, doc, t, ctx, margin, state);
      if (v === true) return true;
      if (v === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if ("not" in cond) {
    const v = evaluateLaneCondition(cond.not, doc, t, ctx, -margin, state);
    return v === null ? null : !v;
  }
  if ("scope" in cond) return scopeAdmits({ folder: "any", ...cond.scope }, t, ctx);
  if ("signal" in cond) return signalTest(cond, doc, t, ctx, margin, state);
  if ("extract" in cond) return extractTest(cond, doc, t, ctx, state);
  if ("lane" in cond) {
    if (state.lane === undefined || state.lane === null) return null;
    const want = Array.isArray(cond.lane) ? cond.lane : [cond.lane];
    return want.includes(state.lane);
  }
  return factTest(cond, t, ctx, state);
}

/** Where one Thread goes on a View. */
export interface LanePlacement {
  /** A Lane id, `unsure`, or `others`. */
  lane: string;
  /** Unsure because a Signal it needs was never asked of it. */
  notRead: boolean;
  /** Placed by the user ("Move to", a drag) rather than by the rules. */
  byUser: boolean;
  /** The Lane that decided: the one taken, or the one that could not be decided. */
  decidedBy: string | null;
}

/**
 * Tries the Lanes in order. The first true Lane takes the Thread unless an
 * earlier Lane was unknown: then Unsure. No Lane true and none unknown:
 * `others`. `current` is the Lane the Thread was in (hysteresis keeps it
 * there until an answer is clearly past a threshold); a user placement at
 * the Thread's current version wins.
 */
export function placeThread(
  doc: ViewDoc,
  t: ViewThread,
  ctx: ViewContext,
  current: string | null = null,
  placement: ViewPlacement | null = null,
): LanePlacement {
  if (placement && placement.messageCount === t.messageCount) {
    return { lane: placement.lane, notRead: false, byUser: true, decidedBy: null };
  }
  const h = ctx.rules.hysteresis;
  for (const lane of doc.lanes) {
    const state: EvalState = { notRead: false };
    const margin = current === null ? 0 : lane.id === current ? -h : h;
    const v = evaluateLaneCondition(lane.when, doc, t, ctx, margin, state);
    if (v === true) return { lane: lane.id, notRead: false, byUser: false, decidedBy: lane.id };
    if (v === null) {
      return { lane: UNSURE_LANE, notRead: state.notRead, byUser: false, decidedBy: lane.id };
    }
  }
  return { lane: OTHERS_LANE, notRead: false, byUser: false, decidedBy: null };
}

/* ------------------------------ The view ------------------------------ */

export interface LaneRow<T extends ViewThread = ViewThread> {
  thread: T;
  placement: LanePlacement;
}

export interface LaneColumn<T extends ViewThread = ViewThread> {
  id: string;
  label: string;
  tone: Lane["tone"];
  rows: LaneRow<T>[];
}

export interface LaneView<T extends ViewThread = ViewThread> {
  /** The Lanes in order, then Unsure, then Everything else when the View shows it. */
  lanes: LaneColumn<T>[];
  /** Threads per Lane id, Unsure and others included. */
  counts: Record<string, number>;
  /** Threads shown (hidden others not counted). */
  total: number;
  /** The nav's number: the Lane the View names, else the total. */
  navCount: number;
  /** Where each Thread went, for hysteresis on the next read and for moves. */
  lanesOf: Map<string, string>;
}

const deadlineOf = (t: ViewThread) => {
  const d = t.facts?.deadline_at;
  return typeof d === "string" ? Date.parse(d) : Number.POSITIVE_INFINITY;
};

function sortRows<T extends ViewThread>(
  rows: LaneRow<T>[],
  sort: string | undefined,
): LaneRow<T>[] {
  const at = (r: LaneRow<T>) => Date.parse(r.thread.lastActivity) || 0;
  const out = [...rows];
  if (sort === "oldest_first") out.sort((a, b) => at(a) - at(b));
  else if (sort === "deadline_first")
    out.sort((a, b) => deadlineOf(a.thread) - deadlineOf(b.thread) || at(b) - at(a));
  else out.sort((a, b) => at(b) - at(a));
  return out;
}

/**
 * The View over the Threads the Cache holds in its scope: each placed,
 * sorted per the layout, counted. `previous` is where each Thread was on
 * the last read (hysteresis); `placements` the user's own.
 */
export function laneView<T extends ViewThread>(
  doc: ViewDoc,
  threads: readonly T[],
  ctx: ViewContext,
  options: {
    previous?: ReadonlyMap<string, string> | undefined;
    placements?: Readonly<Record<string, ViewPlacement>> | undefined;
    unsureLabel?: string | undefined;
    othersLabel?: string | undefined;
    /** How the rows sort in each Lane (the lanes Block's own). */
    sort?: ViewSort | undefined;
  } = {},
): LaneView<T> {
  const rows = expandRows(doc, threads);
  if (doc.lanes.length === 0) return allInOne(doc, rows, ctx, options.sort);
  const byLane = new Map<string, LaneRow<T>[]>();
  const lanesOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const t of rows) {
    if (!taken.has(t.id) && taken.size >= doc.scope.limit) continue;
    if (!scopeAdmits(doc.scope.facts, t, ctx)) continue;
    taken.add(t.id);
    const placement = placeThread(
      doc,
      t,
      ctx,
      options.previous?.get(rowKey(t)) ?? null,
      options.placements?.[t.id] ?? null,
    );
    lanesOf.set(rowKey(t), placement.lane);
    const list = byLane.get(placement.lane) ?? [];
    list.push({ thread: t, placement });
    byLane.set(placement.lane, list);
  }
  const sort = options.sort;
  const lanes: LaneColumn<T>[] = doc.lanes.map((l) => ({
    id: l.id,
    label: l.label,
    tone: l.tone,
    rows: sortRows(byLane.get(l.id) ?? [], sort),
  }));
  lanes.push({
    id: UNSURE_LANE,
    label: options.unsureLabel ?? doc.unsure.label,
    tone: "muted",
    rows: sortRows(byLane.get(UNSURE_LANE) ?? [], sort),
  });
  if (doc.others !== "hide") {
    lanes.push({
      id: OTHERS_LANE,
      label: options.othersLabel ?? doc.others.label,
      tone: "muted",
      rows: sortRows(byLane.get(OTHERS_LANE) ?? [], sort),
    });
  }
  const counts: Record<string, number> = {};
  for (const l of doc.lanes) counts[l.id] = byLane.get(l.id)?.length ?? 0;
  counts[UNSURE_LANE] = byLane.get(UNSURE_LANE)?.length ?? 0;
  counts[OTHERS_LANE] = byLane.get(OTHERS_LANE)?.length ?? 0;
  const total = lanes.reduce((n, l) => n + l.rows.length, 0);
  const navCount = doc.nav.count === "total" ? total : (counts[doc.nav.count] ?? total);
  return { lanes, counts, total, navCount, lanesOf };
}

/* ------------------------------ Rows: Threads, items, Messages ------------------------------ */

/** A per-row Signal's answer as a reading the row's conditions read. */
function rowReading(a: RowAnswer): SignalReading {
  return {
    noul: a.noul ?? null,
    choice: a.choice ?? null,
    score: a.score ?? null,
    confidence: a.confidence ?? null,
    version: 0,
  };
}

/**
 * The rows of a View (docs/spec/views.md, "Rows"). Grain `thread`: the Threads
 * as they are. Grain `item`: each value the `item_of` Extraction picked becomes
 * its own row, carrying that value alone, the per-row Signals' answers for it and
 * its Message's date; a Thread whose items are Unsure or not read yet stays one
 * row (so it is counted as Unsure or Not read yet), one with none has no rows.
 * Grain `message`: each Message that holds a value or a per-row answer becomes a
 * row with that Message's values, answers and date. Every row keeps its Thread's
 * id, so it opens its Thread. Code only.
 */
export function expandRows<T extends ViewThread>(doc: ViewDoc, threads: readonly T[]): T[] {
  const grain = doc.grain ?? "thread";
  if (grain === "thread") return [...threads];
  const eachIds = doc.signals.filter((s) => s.each).map((s) => viewSignalId(doc.id, s.id));
  const answersOf = (t: T, key: string): Record<string, SignalReading> => {
    const out: Record<string, SignalReading> = {};
    for (const sid of eachIds) {
      const a = t.values?.[sid]?.answers?.[key];
      if (a) out[sid] = rowReading(a);
    }
    return out;
  };
  const dated = (
    t: T,
    at: string | null | undefined,
  ): Partial<Pick<ViewThread, "facts" | "receivedAt">> =>
    at ? { receivedAt: at, facts: { ...(t.facts ?? {}), received_at: at } } : {};
  const out: T[] = [];
  if (grain === "item") {
    const x = doc.extractions.find((e) => e.id === doc.item_of);
    if (!x) return [...threads];
    const sid = viewExtractionId(doc.id, x.id);
    for (const t of threads) {
      const items = t.values?.[sid]?.items ?? [];
      const picked = items.filter((i) => !i.unsure).slice(0, x.max ?? items.length);
      if (picked.length === 0) {
        // Unsure, or not read yet: one row that says so. None picked: no rows.
        const read = t.readings[sid];
        if (items.length > 0 || !read || (read.choice !== "none" && !t.values?.[sid])) out.push(t);
        continue;
      }
      for (const item of picked) {
        out.push({
          ...t,
          ...dated(t, item.at),
          row: { key: item.key, message: item.message ?? null, at: item.at ?? null },
          values: {
            ...t.values,
            [sid]: { text: item.text, value: item.value, confidence: item.confidence },
          },
          readings: { ...t.readings, ...answersOf(t, item.key) },
        });
      }
    }
    return out;
  }
  // Grain message: a row per Message that holds a value or an answer.
  const pulls = doc.extractions.map((x) => viewExtractionId(doc.id, x.id));
  for (const t of threads) {
    const byMessage = new Map<string, string | null>();
    for (const sid of pulls) {
      for (const i of t.values?.[sid]?.items ?? []) {
        if (i.message) byMessage.set(i.message, i.at ?? byMessage.get(i.message) ?? null);
      }
    }
    for (const sid of eachIds) {
      for (const [key, a] of Object.entries(t.values?.[sid]?.answers ?? {})) {
        byMessage.set(key, a.at ?? byMessage.get(key) ?? null);
      }
    }
    if (byMessage.size === 0) {
      out.push(t);
      continue;
    }
    const ordered = [...byMessage.entries()].sort((a, b) => (b[1] ?? "").localeCompare(a[1] ?? ""));
    for (const [message, at] of ordered) {
      const values: Record<string, ExtractedValue> = { ...t.values };
      const readings: Record<string, SignalReading> = { ...t.readings, ...answersOf(t, message) };
      for (const sid of pulls) {
        const v = t.values?.[sid];
        if (!v?.items) continue;
        const item = v.items.find((i) => i.message === message);
        delete values[sid];
        if (item && !item.unsure) {
          values[sid] = { text: item.text, value: item.value, confidence: item.confidence };
        } else if (item) {
          readings[sid] = { choice: "picked", confidence: 0, version: 0 };
          values[sid] = { text: item.text, value: item.value, confidence: 0 };
        } else {
          // Asked of the Thread, and this Message holds none: known absent.
          readings[sid] = { choice: "none", confidence: 1, version: 0 };
        }
      }
      out.push({ ...t, ...dated(t, at), row: { key: message, message, at }, values, readings });
    }
  }
  return out;
}

/** The Lane of every Thread in a View with no Lanes: its whole scope, one group. */
export const ALL_LANE = "_all";

function allInOne<T extends ViewThread>(
  doc: ViewDoc,
  threads: readonly T[],
  ctx: ViewContext,
  sort: ViewSort | undefined,
): LaneView<T> {
  const rows: LaneRow<T>[] = [];
  const lanesOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const t of threads) {
    if (!taken.has(t.id) && taken.size >= doc.scope.limit) continue;
    if (!scopeAdmits(doc.scope.facts, t, ctx)) continue;
    taken.add(t.id);
    rows.push({
      thread: t,
      placement: { lane: ALL_LANE, notRead: false, byUser: false, decidedBy: null },
    });
    lanesOf.set(rowKey(t), ALL_LANE);
  }
  return {
    lanes: [{ id: ALL_LANE, label: doc.name, tone: "muted", rows: sortRows(rows, sort) }],
    counts: { [ALL_LANE]: rows.length },
    total: rows.length,
    navCount: rows.length,
    lanesOf,
  };
}

/* ------------------------------ Reasons, the test card, moves ------------------------------ */

/** A Signal's short name for the reasons line. */
export function signalName(doc: ViewDoc, local: string): string {
  const own = doc.signals.find((s) => s.id === local);
  if (own) return own.label?.trim() || local.replaceAll("_", " ");
  return VIEW_SHIPPED_SIGNALS[local]?.label ?? local.replaceAll("_", " ");
}

/** How many levels a Score has, for "2.1 of 3". */
function levelsOf(doc: ViewDoc, local: string): number | null {
  const own = doc.signals.find((s) => s.id === local);
  if (own?.question.type === "score") return own.question.criteria.length;
  return VIEW_SHIPPED_SIGNALS[local]?.levels ?? null;
}

/** The Signals one Lane's condition reads, local ids. */
export function laneSignals(lane: Lane): string[] {
  const out: string[] = [];
  const walk = (c: LaneCondition) => {
    if ("all" in c) c.all.forEach(walk);
    else if ("any" in c) c.any.forEach(walk);
    else if ("not" in c) walk(c.not);
    else if ("signal" in c && !out.includes(c.signal)) out.push(c.signal);
  };
  walk(lane.when);
  return out;
}

/**
 * The answers behind a placement, in words: "support request 94%",
 * "blocked 2.1 of 2", "Not read yet" for a Signal with no answer.
 */
export function placementReasons(
  doc: ViewDoc,
  t: ViewThread,
  placement: LanePlacement,
  notRead = "not read yet",
): string[] {
  const lane = doc.lanes.find((l) => l.id === placement.decidedBy);
  if (!lane) return [];
  return laneSignals(lane).map((local) => {
    const r = readingOf(doc, t, local);
    const name = signalName(doc, local);
    if (!r) return `${name} ${notRead}`;
    if (r.noul !== undefined && r.noul !== null) return `${name} ${Math.round(r.noul * 100)}%`;
    if (r.choice !== undefined && r.choice !== null) return `${name} ${r.choice}`;
    if (r.score !== undefined && r.score !== null) {
      const levels = levelsOf(doc, local);
      return levels
        ? `${name} ${r.score.toFixed(1)} of ${levels - 1}`
        : `${name} ${r.score.toFixed(1)}`;
    }
    return `${name} ${notRead}`;
  });
}

/**
 * How sure a placement is, 0 to 1: the least clear of the answers its Lane
 * read (a Noul by its distance from 0.5, a Choice or Score by its
 * confidence). A user placement and a Fact-only Lane are sure.
 */
export function placementCertainty(doc: ViewDoc, t: ViewThread, placement: LanePlacement): number {
  if (placement.byUser) return 1;
  const lane = doc.lanes.find((l) => l.id === placement.decidedBy);
  if (!lane) return 1;
  let least = 1;
  for (const local of laneSignals(lane)) {
    const r = readingOf(doc, t, local);
    if (!r) return 0;
    const c =
      r.noul !== undefined && r.noul !== null ? Math.abs(r.noul - 0.5) * 2 : (r.confidence ?? 1);
    least = Math.min(least, c);
  }
  return least;
}

/**
 * The Threads the test card shows: `shown` of them, spread across the Lanes
 * (one from each in turn, Lane order, Unsure included) and including the
 * least confident ones, which are what a user should check.
 */
export function pickShown<T extends { id: string; lane: string; certainty: number }>(
  tried: readonly T[],
  shown: number,
  laneOrder: readonly string[],
): T[] {
  if (tried.length <= shown) return [...tried];
  const picked = new Set<string>();
  const out: T[] = [];
  const take = (t: T | undefined) => {
    if (t && !picked.has(t.id) && out.length < shown) {
      picked.add(t.id);
      out.push(t);
    }
  };
  // The least confident third first.
  const leastFirst = [...tried].sort((a, b) => a.certainty - b.certainty);
  for (const t of leastFirst.slice(0, Math.max(1, Math.floor(shown / 3)))) take(t);
  // Then round-robin across the Lanes.
  const byLane = laneOrder.map((l) => tried.filter((t) => t.lane === l && !picked.has(t.id)));
  for (let round = 0; out.length < shown && byLane.some((l) => l.length > round); round++) {
    for (const lane of byLane) take(lane[round]);
  }
  for (const t of tried) take(t);
  // Back in Lane order for the card.
  const rank = (lane: string) => {
    const i = laneOrder.indexOf(lane);
    return i < 0 ? laneOrder.length : i;
  };
  return out.sort((a, b) => rank(a.lane) - rank(b.lane));
}

/** Threads that would change Lane, grouped "2 Yellow to Green". */
export interface ViewMove {
  from: string;
  to: string;
  threadIds: string[];
}

export function viewMoves(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): ViewMove[] {
  const moves = new Map<string, ViewMove>();
  for (const [id, to] of after) {
    const from = before.get(id);
    if (from === undefined || from === to) continue;
    const key = `${from}\u0000${to}`;
    const m = moves.get(key) ?? { from, to, threadIds: [] };
    m.threadIds.push(id);
    moves.set(key, m);
  }
  return [...moves.values()].sort((a, b) => b.threadIds.length - a.threadIds.length);
}

/**
 * How many of the user's corrections the View now agrees with: a "Move to"
 * agrees when the Thread lands in that Lane; a "Wrong" on a Noul agrees
 * when the Signal now answers the way the user said.
 */
export function correctionAgreement(
  doc: ViewDoc,
  threads: ReadonlyMap<string, ViewThread>,
  lanesOf: ReadonlyMap<string, string>,
  rules: SignalRules,
): { agree: number; total: number } {
  let agree = 0;
  let total = 0;
  for (const [key, list] of Object.entries(doc.examples)) {
    for (const e of list) {
      const t = threads.get(e.threadId);
      if (!t) continue;
      if (key === "_lanes" && e.lane) {
        total += 1;
        if (lanesOf.get(e.threadId) === e.lane) agree += 1;
        continue;
      }
      if (key.startsWith("x:") && e.value !== undefined) {
        // "Wrong value": agrees when the pick is now the span the user named, or none for "not stated".
        total += 1;
        const read = readExtraction(doc, t, key.slice(2), { rules });
        if (
          e.value === null
            ? read.state === "empty"
            : read.state === "value" && read.text === e.value
        )
          agree += 1;
        continue;
      }
      if (e.holds === undefined) continue;
      total += 1;
      const r = readingOf(doc, t, key);
      const p = r?.noul;
      if (p === undefined || p === null) continue;
      if (e.holds ? p >= rules.noulHigh : p < rules.noulLow) agree += 1;
    }
  }
  return { agree, total };
}

/** Whether two documents differ in what decides the Lanes (Lanes, Signals, uses, scope, examples), not only in name or layout. */
export function lanesChanged(a: ViewDoc, b: ViewDoc): boolean {
  const pick = (d: ViewDoc) =>
    JSON.stringify({
      scope: d.scope,
      signals: d.signals,
      uses: d.uses,
      lanes: d.lanes,
      examples: d.examples,
      others: d.others,
      extractions: d.extractions,
    });
  return pick(a) !== pick(b);
}

/** A View's Signal question in words, for cards and the Signals page. */
export function viewSignalLabel(s: ViewSignal): string {
  return questionLabel(s.question);
}

/** A new View id from its name: `v_` and the name's words, unique against `taken`. */
export function viewIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = `v_${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "view"
  }`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}
