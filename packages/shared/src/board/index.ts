// Boards (docs/spec/boards.md): validation of the document, the code-only
// scope, three-valued Lane evaluation with hysteresis, the view a component
// renders, and what the test card and the moves preview compute. Pure and
// runtime-neutral, so the Server (the test, the Signal scope) and the Device
// (Lanes over thread_signals in SQLite) read Boards one way.
//
// Three-valued: each test is true, false or unknown (an Unsure answer, or a
// Signal not read yet). Lanes are tried in order; the first Lane whose
// condition is true takes the Thread unless an earlier Lane was unknown, in
// which case the Thread goes to Unsure. So a Thread is never placed in Green
// because Red could not be decided.

import { utcToZoned, zonedToUtc } from "../calendar.ts";
import type { JsonValue } from "../judge.ts";
import type { SignalQuestion, SignalReading, SignalReadings, SignalRules } from "../signals.ts";
import { questionLabel } from "../signals.ts";
import {
  BOARD_FACTS,
  BOARD_ICONS,
  type BoardDoc,
  type BoardExample,
  type BoardFact,
  type BoardPlacement,
  type BoardScopeFacts,
  type BoardSignal,
  boardDocSchema,
  type DateRef,
  type DateScope,
  type FactTest,
  type Lane,
  type LaneCondition,
  type SignalTest,
} from "./types.ts";

export * from "./fixture.ts";
export * from "./types.ts";

/* ------------------------------ Ids ------------------------------ */

/** The stored id of a Board's own Signal. */
export const boardSignalId = (boardId: string, signalId: string) => `board:${boardId}:${signalId}`;

/** The Lane id a Thread no Signal could decide goes to. */
export const UNSURE_LANE = "unsure";
/** The Lane id of Threads no Lane claims (hidden unless the Board shows them). */
export const OTHERS_LANE = "others";

/**
 * The shipped Signals a Board may read (`uses`), with their kind and, for a
 * Score, how many levels it has. The Board's reasons read these.
 */
export const BOARD_SHIPPED_SIGNALS: Readonly<
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

/* ------------------------------ Validation ------------------------------ */

export interface BoardLimits {
  maxLanes: number;
  maxSignals: number;
  maxThreads: number;
}

export const DEFAULT_BOARD_LIMITS: BoardLimits = { maxLanes: 6, maxSignals: 6, maxThreads: 2000 };

export type BoardValidation = { ok: true; doc: BoardDoc } | { ok: false; errors: string[] };

/**
 * Words that ask the model for a count, an amount or a date comparison: Jev
 * reads literally and does no arithmetic (ADR 0012), so code owns these as
 * Facts and a question that asks for one fails validation.
 */
const COUNTING =
  /\b(more|fewer|less|greater|higher|lower)\s+than\s+(\$|€|£)?\d|\bat\s+(least|most)\s+(\$|€|£)?\d|\bover\s+(\$|€|£)\s?\d|\bover\s+\d+\s*(replies|messages|emails|days|weeks|months)|\b(older|newer|younger)\s+than\b|\bhow\s+many\b|\b\d+\s*(or\s+more\s+)?(replies|messages|emails|responses)\b|\bnumber\s+of\s+(replies|messages|emails|days)\b|(\$|€|£)\s?\d[\d,.]*\s*(or\s+more|and\s+above|\+)/i;

function wordsOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(wordsOf).join(" ");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== "examples")
      .map(([k, v]) => `${k} ${wordsOf(v)}`)
      .join(" ");
  }
  return "";
}

/** The problems with a Signal's own wording, in plain words; empty when it may be asked. */
export function signalWordingErrors(s: BoardSignal): string[] {
  const errors: string[] = [];
  const words = `${wordsOf(s.question.instructions)} ${wordsOf(s.question.criteria ?? "")}`;
  if (COUNTING.test(words)) {
    errors.push(
      `Signal ${s.id} asks for a count, an amount or a date comparison. Code owns those: test a Fact instead (message_count, amount, received_at, deadline_at).`,
    );
  }
  if (!wordsOf(s.question.instructions).trim()) {
    errors.push(`Signal ${s.id} has no instructions.`);
  }
  return errors;
}

function conditionErrors(
  cond: LaneCondition,
  where: string,
  kinds: ReadonlyMap<string, { kind: string; options?: string[] }>,
  errors: string[],
): void {
  if ("all" in cond || "any" in cond) {
    for (const c of "all" in cond ? cond.all : cond.any) conditionErrors(c, where, kinds, errors);
    return;
  }
  if ("not" in cond) {
    conditionErrors(cond.not, where, kinds, errors);
    return;
  }
  if ("scope" in cond) return;
  if ("signal" in cond) {
    const k = kinds.get(cond.signal);
    if (!k) {
      errors.push(
        `${where} reads Signal ${cond.signal}, which is neither one of the Board's own nor listed in uses.`,
      );
      return;
    }
    const tests = [cond.holds !== undefined || cond.fails !== undefined, cond.is !== undefined];
    const range = cond.at_least !== undefined || cond.at_most !== undefined;
    if (!tests[0] && !tests[1] && !range) {
      errors.push(
        `${where}: a test on ${cond.signal} needs holds, fails, at_least, at_most or is.`,
      );
    }
    if (k.kind === "noul") {
      if (cond.is !== undefined)
        errors.push(`${where}: ${cond.signal} is a yes or no; use holds or fails.`);
      for (const v of [cond.at_least, cond.at_most]) {
        if (v !== undefined && (v < 0 || v > 1)) {
          errors.push(`${where}: a probability for ${cond.signal} is between 0 and 1.`);
        }
      }
    } else if (k.kind === "score") {
      if (tests[0]) errors.push(`${where}: ${cond.signal} is a score; use at_least or at_most.`);
      if (cond.is !== undefined)
        errors.push(`${where}: ${cond.signal} is a score; use at_least or at_most.`);
    } else if (k.kind === "choice") {
      if (tests[0] || range) errors.push(`${where}: ${cond.signal} is a choice; use is.`);
      if (cond.is !== undefined && k.options && !k.options.includes(cond.is)) {
        errors.push(`${where}: ${cond.signal} has no option "${cond.is}".`);
      }
    }
    return;
  }
  const kind = BOARD_FACTS[cond.fact];
  const has = (k: keyof FactTest) => cond[k] !== undefined;
  const ok =
    kind === "flag"
      ? typeof cond.is === "boolean" && !has("in") && !has("at_least") && !has("before")
      : kind === "number"
        ? (has("at_least") || has("at_most")) && !has("is") && !has("before")
        : kind === "date"
          ? (has("before") || has("after")) && !has("is") && !has("at_least")
          : (typeof cond.is === "string" || has("in")) && !has("at_least") && !has("before");
  if (!ok) {
    const how =
      kind === "flag"
        ? "is: true or false"
        : kind === "number"
          ? "at_least or at_most"
          : kind === "date"
            ? "before or after"
            : "is or in";
    errors.push(`${where}: the Fact ${cond.fact} takes ${how}.`);
  }
}

/**
 * Validates a Board document against the schema and the limits: shapes,
 * unique ids, every Signal a Lane reads declared, tests that fit their
 * Signal's kind or Fact's type, no question that asks the model to count,
 * compare an amount or a date, the layout's references, the nav entry.
 * `shipped` names the shipped Signals `uses` may list (their kinds).
 */
export function validateBoard(
  input: unknown,
  limits: BoardLimits = DEFAULT_BOARD_LIMITS,
  shipped: Readonly<Record<string, { kind: string }>> = BOARD_SHIPPED_SIGNALS,
): BoardValidation {
  const parsed = boardDocSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) =>
        i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
      ),
    };
  }
  const doc = parsed.data as BoardDoc;
  const errors: string[] = [];
  if (doc.lanes.length > limits.maxLanes) {
    errors.push(
      `A Board has at most ${limits.maxLanes} Lanes plus Unsure; this one has ${doc.lanes.length}.`,
    );
  }
  if (doc.signals.length > limits.maxSignals) {
    errors.push(
      `A Board asks at most ${limits.maxSignals} Signals of its own; this one asks ${doc.signals.length}.`,
    );
  }
  if (doc.scope.limit > limits.maxThreads) {
    errors.push(
      `The scope looks at ${doc.scope.limit} threads; the most is ${limits.maxThreads}. Narrow it.`,
    );
  }
  const laneIds = new Set<string>();
  for (const l of doc.lanes) {
    if (l.id === UNSURE_LANE || l.id === OTHERS_LANE) errors.push(`Lane id ${l.id} is reserved.`);
    if (laneIds.has(l.id)) errors.push(`Lane id ${l.id} is used twice.`);
    laneIds.add(l.id);
  }
  const kinds = new Map<string, { kind: string; options?: string[] }>();
  for (const s of doc.signals) {
    if (kinds.has(s.id)) errors.push(`Signal id ${s.id} is used twice.`);
    if (s.kind !== s.question.type)
      errors.push(`Signal ${s.id} is a ${s.kind} but its question is a ${s.question.type}.`);
    if (s.question.type === "choice" && Object.keys(s.question.criteria).length < 2) {
      errors.push(`Signal ${s.id} needs at least two options.`);
    }
    errors.push(...signalWordingErrors(s));
    kinds.set(s.id, {
      kind: s.kind,
      ...(s.question.type === "choice" ? { options: Object.keys(s.question.criteria) } : {}),
    });
  }
  for (const u of doc.uses) {
    const k = shipped[u];
    if (!k) {
      errors.push(`uses lists ${u}, which is not a shipped Signal.`);
      continue;
    }
    if (kinds.has(u)) errors.push(`${u} is both the Board's own Signal and a shipped one.`);
    kinds.set(u, { kind: k.kind });
  }
  for (const l of doc.lanes) conditionErrors(l.when, `Lane ${l.id}`, kinds, errors);
  const layout = doc.layout;
  const checkField = (f: string, where: string) => {
    if (f.startsWith("signal:") && !kinds.has(f.slice("signal:".length))) {
      errors.push(`${where} shows ${f}, which the Board does not read.`);
    }
  };
  if (layout.component === "lanes" || layout.component === "list") {
    for (const f of layout.row?.fields ?? []) checkField(f, "The row");
  }
  if (layout.component === "counts") {
    for (const l of layout.lanes ?? []) {
      if (!laneIds.has(l) && l !== UNSURE_LANE)
        errors.push(`The counts show Lane ${l}, which the Board does not have.`);
    }
  }
  if (layout.component === "table") {
    for (const c of layout.columns) {
      const given = [c.fact, c.signal, c.field].filter((v) => v !== undefined).length;
      if (given !== 1) errors.push(`Column ${c.label} shows exactly one of fact, signal or field.`);
      if (c.signal && !kinds.has(c.signal))
        errors.push(`Column ${c.label} shows Signal ${c.signal}, which the Board does not read.`);
      if (c.field) checkField(c.field, `Column ${c.label}`);
    }
  }
  if (!(BOARD_ICONS as readonly string[]).includes(doc.nav.icon)) {
    errors.push(`The nav icon ${doc.nav.icon} is not one of ${BOARD_ICONS.join(", ")}.`);
  }
  if (doc.nav.count !== "total" && !laneIds.has(doc.nav.count) && doc.nav.count !== UNSURE_LANE) {
    errors.push(
      `The nav counts Lane ${doc.nav.count}, which the Board does not have; name a Lane or "total".`,
    );
  }
  for (const key of Object.keys(doc.examples)) {
    if (key !== "_lanes" && !kinds.has(key))
      errors.push(`Examples for ${key}, which the Board does not read.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, doc };
}

/** The Signals a Lane or the layout reads, local ids, in order of first use. */
export function signalsRead(doc: BoardDoc): string[] {
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

/** Whether a Board reads mail through Signals (it then needs a judge); a Fact-only Board does not. */
export function boardReadsSignals(doc: BoardDoc): boolean {
  return doc.signals.length > 0 || signalsRead(doc).length > 0;
}

/**
 * The Board with only its Fact Lanes: every Lane that reads a Signal and
 * every Signal dropped. What "keep only the Fact Lanes" offers without a
 * TypeSafe key; null when no Lane is left.
 */
export function factLanesOnly(doc: BoardDoc): BoardDoc | null {
  const reads = (c: LaneCondition): boolean =>
    "all" in c
      ? c.all.some(reads)
      : "any" in c
        ? c.any.some(reads)
        : "not" in c
          ? reads(c.not)
          : "signal" in c;
  const lanes = doc.lanes.filter((l) => !reads(l.when));
  if (lanes.length === 0) return null;
  const first = lanes[0] as Lane;
  return {
    ...doc,
    signals: [],
    uses: [],
    lanes,
    examples: {},
    nav: {
      ...doc.nav,
      count: lanes.some((l) => l.id === doc.nav.count) ? doc.nav.count : first.id,
    },
    layout:
      doc.layout.component === "counts"
        ? { component: "counts", lanes: lanes.map((l) => l.id) }
        : doc.layout.component === "table"
          ? { ...doc.layout, columns: doc.layout.columns.filter((c) => !c.signal) }
          : doc.layout,
  };
}

/* ------------------------------ The question as asked ------------------------------ */

const EXAMPLES_NOTE =
  "Past decisions the mailbox owner made about other threads. Use them to understand what the owner means; judge only the current thread.";

/**
 * A Board Signal's question as it is asked: its own words, with the
 * Examples the user's corrections made (newest first, up to `max` of each
 * answer) in its instructions, the way a Section's Examples ride.
 */
export function boardQuestion(
  signal: BoardSignal,
  examples: readonly BoardExample[] | undefined,
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

/** The Signals a Board declares for the Signal store: stored id, kind and the question as asked. */
export function boardSignalDefs(
  doc: BoardDoc,
  examplesMax = 5,
): Array<{ id: string; local: string; kind: BoardSignal["kind"]; question: SignalQuestion }> {
  return doc.signals.map((s) => ({
    id: boardSignalId(doc.id, s.id),
    local: s.id,
    kind: s.kind,
    question: boardQuestion(s, doc.examples[s.id], examplesMax),
  }));
}

/* ------------------------------ Dates ------------------------------ */

function validZone(zone: string): boolean {
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
export function widenScope(facts: BoardScopeFacts, days: number): BoardScopeFacts {
  return {
    ...facts,
    ...(facts.received ? { received: { last_days: days } } : {}),
    ...(facts.active ? { active: { last_days: days } } : {}),
  };
}

/** The earliest moment the scope's date parts admit, for a query's bound; null when it has none. */
export function scopeSince(facts: BoardScopeFacts, now: Date, zone: string): Date | null {
  const starts = [facts.received, facts.active]
    .filter((d): d is DateScope => d !== undefined)
    .map((d) => dateScopeStart(d, now, zone).getTime());
  return starts.length ? new Date(Math.max(...starts)) : null;
}

/* ------------------------------ The Thread as a Board reads it ------------------------------ */

/** What a Board reads about one Thread: its row, its clear Facts and its Signal answers. */
export interface BoardThread {
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
}

export interface BoardContext {
  rules: SignalRules;
  now: Date;
  /** The Workspace's zone (calendar.time_zone); empty means the host's own. */
  zone: string;
  /** The owner's address, lowercased. */
  owner: string;
}

const domainOf = (address: string | null) =>
  address ? (address.split("@")[1] ?? "").toLowerCase() : "";

/** Whether the scope's exact filters admit a Thread. Code only. */
export function scopeAdmits(
  facts: BoardScopeFacts,
  t: BoardThread,
  ctx: Pick<BoardContext, "now" | "zone">,
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
  if (facts.from_domain?.length && !facts.from_domain.includes(domainOf(from))) return false;
  if (facts.from_domain_not?.length && facts.from_domain_not.includes(domainOf(from))) return false;
  if (facts.to_any?.length && !t.recipients.some((r) => facts.to_any?.includes(r.toLowerCase()))) {
    return false;
  }
  return true;
}

/* ------------------------------ Three-valued evaluation ------------------------------ */

/** true, false, or null for unknown (Unsure, or not read yet). */
export type Tri = boolean | null;

interface EvalState {
  /** Something unknown was met because a Signal had no answer at all (not read yet). */
  notRead: boolean;
}

/** A Board's reading of one Signal by its local id: its own are stored as board:<id>:<local>. */
export function readingOf(doc: BoardDoc, t: BoardThread, local: string): SignalReading | undefined {
  const own = doc.signals.some((s) => s.id === local);
  return t.readings[own ? boardSignalId(doc.id, local) : local];
}

function factValue(t: BoardThread, fact: BoardFact): unknown {
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
      return t.facts?.from_domain ?? (t.from ? domainOf(t.from) : undefined);
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

function factTest(c: FactTest, t: BoardThread, ctx: BoardContext, state: EvalState): Tri {
  const v = factValue(t, c.fact);
  const kind = BOARD_FACTS[c.fact];
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
  doc: BoardDoc,
  t: BoardThread,
  ctx: BoardContext,
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
  doc: BoardDoc,
  t: BoardThread,
  ctx: BoardContext,
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
  return factTest(cond, t, ctx, state);
}

/** Where one Thread goes on a Board. */
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
  doc: BoardDoc,
  t: BoardThread,
  ctx: BoardContext,
  current: string | null = null,
  placement: BoardPlacement | null = null,
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

export interface BoardRow<T extends BoardThread = BoardThread> {
  thread: T;
  placement: LanePlacement;
}

export interface BoardLaneView<T extends BoardThread = BoardThread> {
  id: string;
  label: string;
  tone: Lane["tone"];
  rows: BoardRow<T>[];
}

export interface BoardView<T extends BoardThread = BoardThread> {
  /** The Lanes in order, then Unsure, then Everything else when the Board shows it. */
  lanes: BoardLaneView<T>[];
  /** Threads per Lane id, Unsure and others included. */
  counts: Record<string, number>;
  /** Threads shown (hidden others not counted). */
  total: number;
  /** The nav's number: the Lane the Board names, else the total. */
  navCount: number;
  /** Where each Thread went, for hysteresis on the next read and for moves. */
  lanesOf: Map<string, string>;
}

const deadlineOf = (t: BoardThread) => {
  const d = t.facts?.deadline_at;
  return typeof d === "string" ? Date.parse(d) : Number.POSITIVE_INFINITY;
};

function sortRows<T extends BoardThread>(
  rows: BoardRow<T>[],
  sort: string | undefined,
): BoardRow<T>[] {
  const at = (r: BoardRow<T>) => Date.parse(r.thread.lastActivity) || 0;
  const out = [...rows];
  if (sort === "oldest_first") out.sort((a, b) => at(a) - at(b));
  else if (sort === "deadline_first")
    out.sort((a, b) => deadlineOf(a.thread) - deadlineOf(b.thread) || at(b) - at(a));
  else out.sort((a, b) => at(b) - at(a));
  return out;
}

/**
 * The Board over the Threads the Cache holds in its scope: each placed,
 * sorted per the layout, counted. `previous` is where each Thread was on
 * the last read (hysteresis); `placements` the user's own.
 */
export function boardView<T extends BoardThread>(
  doc: BoardDoc,
  threads: readonly T[],
  ctx: BoardContext,
  options: {
    previous?: ReadonlyMap<string, string> | undefined;
    placements?: Readonly<Record<string, BoardPlacement>> | undefined;
    unsureLabel?: string | undefined;
    othersLabel?: string | undefined;
  } = {},
): BoardView<T> {
  const byLane = new Map<string, BoardRow<T>[]>();
  const lanesOf = new Map<string, string>();
  let taken = 0;
  for (const t of threads) {
    if (taken >= doc.scope.limit) break;
    if (!scopeAdmits(doc.scope.facts, t, ctx)) continue;
    taken += 1;
    const placement = placeThread(
      doc,
      t,
      ctx,
      options.previous?.get(t.id) ?? null,
      options.placements?.[t.id] ?? null,
    );
    lanesOf.set(t.id, placement.lane);
    const list = byLane.get(placement.lane) ?? [];
    list.push({ thread: t, placement });
    byLane.set(placement.lane, list);
  }
  const sort =
    doc.layout.component === "lanes" ||
    doc.layout.component === "list" ||
    doc.layout.component === "table"
      ? doc.layout.sort
      : undefined;
  const lanes: BoardLaneView<T>[] = doc.lanes.map((l) => ({
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

/* ------------------------------ Reasons, the test card, moves ------------------------------ */

/** A Signal's short name for the reasons line. */
export function signalName(doc: BoardDoc, local: string): string {
  const own = doc.signals.find((s) => s.id === local);
  if (own) return own.label?.trim() || local.replaceAll("_", " ");
  return BOARD_SHIPPED_SIGNALS[local]?.label ?? local.replaceAll("_", " ");
}

/** How many levels a Score has, for "2.1 of 3". */
function levelsOf(doc: BoardDoc, local: string): number | null {
  const own = doc.signals.find((s) => s.id === local);
  if (own?.question.type === "score") return own.question.criteria.length;
  return BOARD_SHIPPED_SIGNALS[local]?.levels ?? null;
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
  doc: BoardDoc,
  t: BoardThread,
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
export function placementCertainty(
  doc: BoardDoc,
  t: BoardThread,
  placement: LanePlacement,
): number {
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
export interface BoardMove {
  from: string;
  to: string;
  threadIds: string[];
}

export function boardMoves(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): BoardMove[] {
  const moves = new Map<string, BoardMove>();
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
 * How many of the user's corrections the Board now agrees with: a "Move to"
 * agrees when the Thread lands in that Lane; a "Wrong" on a Noul agrees
 * when the Signal now answers the way the user said.
 */
export function correctionAgreement(
  doc: BoardDoc,
  threads: ReadonlyMap<string, BoardThread>,
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
export function lanesChanged(a: BoardDoc, b: BoardDoc): boolean {
  const pick = (d: BoardDoc) =>
    JSON.stringify({
      scope: d.scope,
      signals: d.signals,
      uses: d.uses,
      lanes: d.lanes,
      examples: d.examples,
      others: d.others,
    });
  return pick(a) !== pick(b);
}

/** A Board's Signal question in words, for cards and the Signals page. */
export function boardSignalLabel(s: BoardSignal): string {
  return questionLabel(s.question);
}

/** A new Board id from its name: `b_` and the name's words, unique against `taken`. */
export function boardIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = `b_${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "board"
  }`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}
