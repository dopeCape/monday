// Validating a View document (docs/spec/views.md; ADR 0016): the zod shape
// first, then what the shape cannot say: ids unique, every Signal,
// Extraction, Field, Lane and action a Block or a condition names declared,
// tests that fit their Signal's kind, Fact's type or Extraction's value, no
// question that asks the model to count, add up or compare a date (code
// owns those), Block props that fit their Fields (a chart groups, a stat
// adds up a number), actions from the catalog naming things that exist,
// and the limits. The errors are plain sentences the drafting model reads
// and fixes.

import { actionRefs, blockRefs, upgradeView } from "./blocks.ts";
import { OTHERS_LANE, UNSURE_LANE, VIEW_SHIPPED_SIGNALS } from "./core.ts";
import { EXTRACT_TYPES, fieldInfo } from "./fields.ts";
import {
  type ExtractTest,
  type FactTest,
  type Lane,
  type LaneCondition,
  VIEW_FACTS,
  VIEW_ICONS,
  type ViewAction,
  type ViewBlock,
  type ViewDoc,
  type ViewSignal,
  viewDocSchema,
} from "./types.ts";

export interface ViewLimits {
  maxLanes: number;
  maxSignals: number;
  maxThreads: number;
  maxExtractions?: number | undefined;
  maxBlocks?: number | undefined;
  maxActions?: number | undefined;
}

export const DEFAULT_VIEW_LIMITS: ViewLimits = {
  maxLanes: 6,
  maxSignals: 6,
  maxThreads: 2000,
  maxExtractions: 6,
  maxBlocks: 8,
  maxActions: 8,
};

/** What an action may name that lives outside the document; absent lists are not checked. */
export interface ViewRefs {
  workflows?: readonly string[] | undefined;
  templates?: readonly string[] | undefined;
  customActions?: readonly string[] | undefined;
  groups?: readonly string[] | undefined;
}

export type ViewValidation = { ok: true; doc: ViewDoc } | { ok: false; errors: string[] };

/**
 * Words that ask the model for a count, an amount or a date comparison: Jev
 * reads literally and does no arithmetic (ADR 0012), so code owns these as
 * Facts and a question that asks for one fails validation.
 */
const COUNTING =
  /\b(more|fewer|less|greater|higher|lower)\s+than\s+(\$|€|£)?\d|\bat\s+(least|most)\s+(\$|€|£)?\d|\bover\s+(\$|€|£)\s?\d|\bover\s+\d+\s*(replies|messages|emails|days|weeks|months)|\b(older|newer|younger)\s+than\b|\bhow\s+many\b|\b\d+\s*(or\s+more\s+)?(replies|messages|emails|responses)\b|\bnumber\s+of\s+(replies|messages|emails|days)\b|(\$|€|£)\s?\d[\d,.]*\s*(or\s+more|and\s+above|\+)|\b(add\s+up|total\s+of\s+all|sum\s+of)\b/i;

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
export function signalWordingErrors(s: ViewSignal): string[] {
  const errors: string[] = [];
  const words = `${wordsOf(s.question.instructions)} ${wordsOf(s.question.criteria ?? "")}`;
  if (COUNTING.test(words)) {
    errors.push(
      `Signal ${s.id} asks for a count, an amount or a date comparison. Code owns those: test a Fact instead (message_count, amount, received_at, deadline_at), or take the value with an Extraction and compare it in a condition.`,
    );
  }
  if (!wordsOf(s.question.instructions).trim()) {
    errors.push(`Signal ${s.id} has no instructions.`);
  }
  return errors;
}

type Kinds = ReadonlyMap<string, { kind: string; options?: string[] }>;

function conditionErrors(
  cond: LaneCondition,
  where: string,
  doc: ViewDoc,
  kinds: Kinds,
  errors: string[],
  allowLane: boolean,
): void {
  if ("all" in cond || "any" in cond) {
    for (const c of "all" in cond ? cond.all : cond.any)
      conditionErrors(c, where, doc, kinds, errors, allowLane);
    return;
  }
  if ("not" in cond) {
    conditionErrors(cond.not, where, doc, kinds, errors, allowLane);
    return;
  }
  if ("scope" in cond) return;
  if ("lane" in cond) {
    if (!allowLane) {
      errors.push(`${where} tests a Lane; a Lane's own condition cannot read Lanes.`);
      return;
    }
    for (const l of Array.isArray(cond.lane) ? cond.lane : [cond.lane]) {
      if (l !== UNSURE_LANE && l !== OTHERS_LANE && !doc.lanes.some((x) => x.id === l))
        errors.push(`${where} tests Lane ${l}, which the View does not have.`);
    }
    return;
  }
  if ("extract" in cond) {
    extractTestErrors(cond, where, doc, errors);
    return;
  }
  if ("signal" in cond) {
    const k = kinds.get(cond.signal);
    if (!k) {
      errors.push(
        `${where} reads Signal ${cond.signal}, which is neither one of the View's own nor listed in uses.`,
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
      if (tests[0] || cond.is !== undefined)
        errors.push(`${where}: ${cond.signal} is a score; use at_least or at_most.`);
    } else if (k.kind === "choice") {
      if (tests[0] || range) errors.push(`${where}: ${cond.signal} is a choice; use is.`);
      if (cond.is !== undefined && k.options && !k.options.includes(cond.is)) {
        errors.push(`${where}: ${cond.signal} has no option "${cond.is}".`);
      }
    }
    return;
  }
  factTestErrors(cond, where, errors);
}

function factTestErrors(cond: FactTest, where: string, errors: string[]): void {
  const kind = VIEW_FACTS[cond.fact];
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

function extractTestErrors(cond: ExtractTest, where: string, doc: ViewDoc, errors: string[]) {
  const x = doc.extractions.find((e) => e.id === cond.extract);
  if (!x) {
    errors.push(`${where} tests Extraction ${cond.extract}, which the View does not declare.`);
    return;
  }
  const type = EXTRACT_TYPES[x.find];
  const has = (k: keyof ExtractTest) => cond[k] !== undefined;
  if (has("at_least") || has("at_most")) {
    if (type !== "money" && type !== "number")
      errors.push(
        `${where}: ${cond.extract} is not a number; at_least and at_most need money or a quantity.`,
      );
  }
  if (has("before") || has("after")) {
    if (type !== "date")
      errors.push(`${where}: ${cond.extract} is not a date; before and after need a date.`);
  }
  if (
    !has("present") &&
    !has("at_least") &&
    !has("at_most") &&
    !has("before") &&
    !has("after") &&
    !has("is") &&
    !has("in")
  ) {
    errors.push(
      `${where}: a test on ${cond.extract} needs present, is, in, at_least, at_most, before or after.`,
    );
  }
}

const NUMERIC = new Set(["number", "money", "probability", "score"]);

function refErrors(doc: ViewDoc, ref: string, where: string, errors: string[]): void {
  if (!fieldInfo(doc, ref)) {
    errors.push(
      `${where} names the Field ${ref}, which is not a Fact, a row field, one of the View's Signals (signal:<id>) or Extractions (x:<id>).`,
    );
  }
}

function blockErrors(doc: ViewDoc, b: ViewBlock, kinds: Kinds, errors: string[]): void {
  const where = `Block ${b.id}`;
  for (const ref of blockRefs(b)) {
    if (ref === "age" || ref === "time" || ref === "deadline" || ref === "sender") continue;
    refErrors(doc, ref, where, errors);
  }
  const q = b.query;
  if (q?.where) conditionErrors(q.where, `${where}'s where`, doc, kinds, errors, true);
  if (q?.lanes) {
    for (const l of q.lanes) {
      if (l !== UNSURE_LANE && !doc.lanes.some((x) => x.id === l))
        errors.push(`${where} shows Lane ${l}, which the View does not have.`);
    }
  }
  const agg = q?.aggregate;
  if (agg && agg.op !== "count") {
    if (!agg.field) errors.push(`${where}: ${agg.op} needs a field to add up.`);
    else {
      const info = fieldInfo(doc, agg.field);
      if (info && !NUMERIC.has(info.type))
        errors.push(`${where}: ${agg.op} adds up numbers or money; ${agg.field} is ${info.type}.`);
    }
  }
  const bucketed = (
    g: { field: string; bucket?: string | undefined } | undefined,
    what: string,
  ) => {
    if (!g) return;
    const info = fieldInfo(doc, g.field);
    if (g.bucket && info && info.type !== "date")
      errors.push(
        `${where}: ${what} by ${g.bucket} needs a date Field; ${g.field} is ${info.type}.`,
      );
  };
  bucketed(q?.group_by, "grouping");
  if (q?.period) {
    const info = fieldInfo(doc, q.period.field);
    if (info && info.type !== "date") errors.push(`${where}: period needs a date Field.`);
  }
  const dateField = (ref: string) => {
    const info = fieldInfo(doc, ref);
    if (info && info.type !== "date") errors.push(`${where}: ${ref} is not a date.`);
  };
  switch (b.type) {
    case "lanes":
    case "counts":
      if (doc.lanes.length === 0)
        errors.push(
          `${where} draws Lanes, and the View has none; add Lanes or use a list or table.`,
        );
      if (b.type === "counts") {
        for (const l of b.lanes ?? []) {
          if (l !== UNSURE_LANE && !doc.lanes.some((x) => x.id === l))
            errors.push(`The counts show Lane ${l}, which the View does not have.`);
        }
      }
      break;
    case "list":
      bucketed(b.group_by, "grouping");
      break;
    case "stat":
      if (!q?.aggregate && !q?.period)
        errors.push(
          `${where} is a stat: its query needs an aggregate (count, sum, avg, min, max).`,
        );
      if (b.compare === "previous" && !q?.period)
        errors.push(`${where} compares with the previous period; its query needs a period.`);
      break;
    case "chart":
      if (!q?.group_by) errors.push(`${where} is a chart: its query needs group_by.`);
      bucketed(b.series, "the series");
      if (b.series && b.chart !== "stacked_bar")
        errors.push(`${where}: only a stacked_bar chart has a series.`);
      break;
    case "timeline":
    case "calendar":
    case "heatmap":
      dateField(b.date);
      break;
  }
  for (const id of b.actions ?? []) {
    if (!doc.actions.some((a) => a.id === id))
      errors.push(`${where} carries action ${id}, which the View does not declare.`);
  }
}

function actionErrors(
  doc: ViewDoc,
  a: ViewAction,
  kinds: Kinds,
  refs: ViewRefs,
  errors: string[],
): void {
  const where = `Action ${a.id}`;
  if (a.when) conditionErrors(a.when, `${where}'s when`, doc, kinds, errors, true);
  for (const ref of actionRefs(a)) refErrors(doc, ref, where, errors);
  const d = a.do;
  const typed = (ref: string, want: string[], what: string) => {
    const info = fieldInfo(doc, ref);
    if (info && !want.includes(info.type)) errors.push(`${where}: ${ref} is not ${what}.`);
  };
  switch (d.kind) {
    case "run_workflow":
      if (refs.workflows && !refs.workflows.includes(d.workflow))
        errors.push(
          `${where} runs Workflow ${d.workflow}, which does not exist or cannot run by hand.`,
        );
      break;
    case "reply_template":
      if (refs.templates && !refs.templates.includes(d.template))
        errors.push(`${where} replies with Template ${d.template}, which does not exist.`);
      break;
    case "custom_action":
      if (refs.customActions && !refs.customActions.includes(d.action))
        errors.push(`${where} runs Custom action ${d.action}, which does not exist.`);
      break;
    case "move":
      if (refs.groups && !refs.groups.includes(d.group))
        errors.push(`${where} moves to Group ${d.group}, which does not exist.`);
      break;
    case "set_lane":
      if (!doc.lanes.some((l) => l.id === d.lane))
        errors.push(`${where} puts the Thread in Lane ${d.lane}, which the View does not have.`);
      break;
    case "open_link":
      typed(d.link, ["link"], "a link (an Extraction with find: link)");
      break;
    case "add_to_calendar":
      typed(d.date, ["date"], "a date");
      break;
    case "snooze":
      if (!["tomorrow", "next_week", "weekend"].includes(d.until))
        typed(d.until, ["date"], "a date");
      break;
    case "forward":
      if (!d.to.includes("@")) typed(d.to, ["text"], "an address");
      break;
    case "mark_done":
      if (!doc.blocks.some((b) => b.type === "checklist"))
        errors.push(`${where} checks a checklist item; the View has no checklist Block.`);
      break;
  }
}

/**
 * Validates a View document (a Board's too: its layout is read as one
 * Block first) against the schema and the limits. `shipped` names the
 * shipped Signals `uses` may list; `refs` what actions may name.
 */
export function validateView(
  input: unknown,
  limits: ViewLimits = DEFAULT_VIEW_LIMITS,
  shipped: Readonly<Record<string, { kind: string }>> = VIEW_SHIPPED_SIGNALS,
  refs: ViewRefs = {},
): ViewValidation {
  const parsed = viewDocSchema.safeParse(upgradeView(input));
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) =>
        i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
      ),
    };
  }
  const doc = parsed.data as ViewDoc;
  const errors: string[] = [];
  if (doc.lanes.length > limits.maxLanes) {
    errors.push(
      `A View has at most ${limits.maxLanes} Lanes plus Unsure; this one has ${doc.lanes.length}.`,
    );
  }
  if (doc.signals.length > limits.maxSignals) {
    errors.push(
      `A View asks at most ${limits.maxSignals} Signals of its own; this one asks ${doc.signals.length}.`,
    );
  }
  const maxX = limits.maxExtractions ?? DEFAULT_VIEW_LIMITS.maxExtractions ?? 6;
  if (doc.extractions.length > maxX) {
    errors.push(`A View has at most ${maxX} Extractions; this one has ${doc.extractions.length}.`);
  }
  const maxB = limits.maxBlocks ?? DEFAULT_VIEW_LIMITS.maxBlocks ?? 8;
  if (doc.blocks.length > maxB) {
    errors.push(`A View has at most ${maxB} Blocks; this one has ${doc.blocks.length}.`);
  }
  const maxA = limits.maxActions ?? DEFAULT_VIEW_LIMITS.maxActions ?? 8;
  if (doc.actions.length > maxA) {
    errors.push(`A View has at most ${maxA} actions; this one has ${doc.actions.length}.`);
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
    if (s.id.startsWith("x_")) errors.push(`Signal id ${s.id} may not start with x_.`);
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
    if (kinds.has(u)) errors.push(`${u} is both the View's own Signal and a shipped one.`);
    kinds.set(u, { kind: k.kind });
  }
  const xIds = new Set<string>();
  for (const x of doc.extractions) {
    if (xIds.has(x.id)) errors.push(`Extraction id ${x.id} is used twice.`);
    xIds.add(x.id);
    if (COUNTING.test(wordsOf(x.question)))
      errors.push(
        `Extraction ${x.id} asks the model to count, add up or compare. It picks one value; code compares and adds.`,
      );
  }
  for (const l of doc.lanes as Lane[])
    conditionErrors(l.when, `Lane ${l.id}`, doc, kinds, errors, false);
  const blockIds = new Set<string>();
  for (const b of doc.blocks) {
    if (blockIds.has(b.id)) errors.push(`Block id ${b.id} is used twice.`);
    blockIds.add(b.id);
    blockErrors(doc, b, kinds, errors);
  }
  const actionIds = new Set<string>();
  for (const a of doc.actions) {
    if (actionIds.has(a.id)) errors.push(`Action id ${a.id} is used twice.`);
    actionIds.add(a.id);
    actionErrors(doc, a, kinds, refs, errors);
  }
  if (!(VIEW_ICONS as readonly string[]).includes(doc.nav.icon)) {
    errors.push(`The nav icon ${doc.nav.icon} is not one of ${VIEW_ICONS.join(", ")}.`);
  }
  if (doc.nav.count !== "total" && !laneIds.has(doc.nav.count) && doc.nav.count !== UNSURE_LANE) {
    errors.push(
      `The nav counts Lane ${doc.nav.count}, which the View does not have; name a Lane or "total".`,
    );
  }
  for (const key of Object.keys(doc.examples)) {
    if (key === "_lanes") continue;
    if (key.startsWith("x:")) {
      if (!xIds.has(key.slice(2)))
        errors.push(`Examples for ${key}, which the View does not read.`);
      continue;
    }
    if (!kinds.has(key)) errors.push(`Examples for ${key}, which the View does not read.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, doc };
}

/**
 * A stored document as the current View shape: a Board's layout read as a
 * Block, the defaults filled. Only the shape is checked (a stored document
 * was validated when it was saved); one that does not parse is returned as
 * it was stored.
 */
export function normalizeView(raw: unknown): ViewDoc {
  const parsed = viewDocSchema.safeParse(upgradeView(raw));
  return (parsed.success ? parsed.data : raw) as ViewDoc;
}

/**
 * The View with only what needs no reading: its Signals, Extractions and
 * shipped Signals dropped, with every Lane, Block and action that reads one.
 * What "keep only what needs no reading" offers without a TypeSafe key;
 * null when nothing is left to show.
 */
export function factLanesOnly(doc: ViewDoc): ViewDoc | null {
  const readsJudged = (ref: string) => ref.startsWith("signal:") || ref.startsWith("x:");
  const reads = (c: LaneCondition): boolean =>
    "all" in c
      ? c.all.some(reads)
      : "any" in c
        ? c.any.some(reads)
        : "not" in c
          ? reads(c.not)
          : "signal" in c || "extract" in c;
  const lanes = doc.lanes.filter((l) => !reads(l.when));
  const laneIds = new Set(lanes.map((l) => l.id));
  const actions = doc.actions.filter((a) => !actionRefs(a).some(readsJudged));
  const actionIds = new Set(actions.map((a) => a.id));
  const blocks = doc.blocks
    .map((b): ViewBlock | null => {
      if ((b.type === "lanes" || b.type === "counts") && lanes.length === 0) return null;
      if (b.type === "table") {
        const columns = b.columns.filter((c) => !readsJudged(c.field));
        if (columns.length === 0) return null;
        b = { ...b, columns };
      }
      if (blockRefs(b).some(readsJudged)) return null;
      if (b.type === "counts") b = { ...b, lanes: (b.lanes ?? []).filter((l) => laneIds.has(l)) };
      return b.actions ? { ...b, actions: b.actions.filter((a) => actionIds.has(a)) } : b;
    })
    .filter((b): b is ViewBlock => b !== null);
  if (blocks.length === 0) return null;
  const first = lanes[0];
  return {
    ...doc,
    signals: [],
    uses: [],
    extractions: [],
    lanes,
    blocks,
    actions,
    examples: {},
    nav: {
      ...doc.nav,
      count: laneIds.has(doc.nav.count) ? doc.nav.count : first ? first.id : "total",
    },
  };
}
