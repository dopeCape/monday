// Typed sentences as typed intents (ADR 0012, slice 27): what the palette
// asks the judge about a sentence, what comes back, and how code turns the
// answers into an Intent. Every question is a Choice over a closed set (the
// function-calling pattern), so the model never writes a name or a date:
// contacts, Groups and Sections are options the client sent, a weekday and
// an hour are options, and code owns the calendar arithmetic, the set
// semantics and the confidence gate. Runtime-neutral: types and pure
// functions the Server and the Device share.

import type { ToolTier } from "./agent.ts";
import type { IsoDate, Person } from "./domain.ts";

/* ------------------------------ Closed sets ------------------------------ */

export const TYPED_INTENT_KINDS = [
  "archive",
  "snooze",
  "move",
  "tag",
  "star",
  "mark_read",
  "schedule_event",
  "search",
  "compose",
  "open_group",
  "open_section",
  "other",
] as const;
export type TypedIntentKind = (typeof TYPED_INTENT_KINDS)[number];

export const INTENT_WEEKDAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
  "today",
  "tomorrow",
  "none",
] as const;
export type IntentWeekday = (typeof INTENT_WEEKDAYS)[number];

/** The hours of a 24 hour clock as option names, plus the three parts of a day and none. */
export const INTENT_HOURS = [
  ...Array.from({ length: 24 }, (_, h) => `h${h}` as const),
  "morning",
  "afternoon",
  "evening",
  "none",
] as const;
export type IntentHour = (typeof INTENT_HOURS)[number];

export const INTENT_AGES = ["day", "week", "month", "none"] as const;
export type IntentAge = (typeof INTENT_AGES)[number];

export const INTENT_THREAD_KINDS = [
  "newsletter",
  "unread",
  "starred",
  "from_person",
  "any",
] as const;
export type IntentThreadKind = (typeof INTENT_THREAD_KINDS)[number];

/** The Tier an intent runs at (ADR 0002): what the confidence gate may run on its own. */
export const INTENT_TIERS: Readonly<Record<TypedIntentKind, ToolTier | null>> = {
  archive: "reversible",
  snooze: "reversible",
  move: "reversible",
  tag: "reversible",
  star: "reversible",
  mark_read: "reversible",
  // A draft opens; nothing is sent from the palette.
  compose: "reversible",
  schedule_event: "leaves_mailbox",
  search: "read",
  open_group: "read",
  open_section: "read",
  other: null,
};

/* ------------------------------ The request and the reading ------------------------------ */

export interface IntentGroupOption {
  id: string;
  name: string;
  /** The Routing rule's sentence, when the Group has one. */
  sentence?: string | undefined;
}

export interface IntentSectionOption {
  id: string;
  name: string;
}

/** What the Device sends to POST /judge/intent: the sentence and the closed sets it may name. */
export interface IntentRequest {
  workspace: string;
  text: string;
  /** The Device's clock as an ISO string with its offset, so the day is the user's. */
  now: IsoDate;
  /** Contacts by recency, at most intent.contacts_max. */
  contacts: Person[];
  groups: IntentGroupOption[];
  sections: IntentSectionOption[];
}

/** One Choice as the judge answered it. */
export interface ChoiceReading<K extends string = string> {
  choice: K;
  /** How peaked the distribution was, 0 to 1. */
  confidence: number;
  probabilities: Record<string, number>;
}

/** The judge's answers to the intent request, before code assembles them. */
export interface IntentReading {
  text: string;
  intent: ChoiceReading<TypedIntentKind>;
  /** A contact option key (see contactOptions), or "none". */
  person: ChoiceReading;
  /** A Group option key (see groupOptions), or "none". */
  group: ChoiceReading;
  /** A Section option key (see sectionOptions), or "none". */
  section: ChoiceReading;
  weekday: ChoiceReading<IntentWeekday>;
  hour: ChoiceReading<IntentHour>;
  /** The probability that the sentence names a set of Threads rather than the one open. */
  scope: number;
  age: ChoiceReading<IntentAge>;
  kind: ChoiceReading<IntentThreadKind>;
  /** The judge model that answered. */
  model: string;
}

/* ------------------------------ Option keys ------------------------------ */

/** A Choice option name: lowercase letters, digits and underscores, never empty. */
export function optionKey(text: string, fallback = "item"): string {
  const key = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return key || fallback;
}

/** Unique keys for a list, in order: a repeated key gets a numeric suffix. */
function uniqueKeys<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): Array<{ key: string; item: T }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n === 0 ? base : `${base}_${n + 1}`, item };
  });
}

/** The contact options as the judge sees them: the name (or the address's local part) as the key. */
export function contactOptions(
  contacts: readonly Person[],
  max = 200,
): Array<{ key: string; person: Person }> {
  return uniqueKeys(contacts.slice(0, max), (p) =>
    optionKey(p.name || p.email.split("@")[0] || "", "contact"),
  ).map(({ key, item }) => ({ key, person: item }));
}

export function groupOptions(
  groups: readonly IntentGroupOption[],
): Array<{ key: string; group: IntentGroupOption }> {
  return uniqueKeys(groups, (g) => optionKey(g.name, "group")).map(({ key, item }) => ({
    key,
    group: item,
  }));
}

export function sectionOptions(
  sections: readonly IntentSectionOption[],
): Array<{ key: string; section: IntentSectionOption }> {
  return uniqueKeys(sections, (s) => optionKey(s.name, "section")).map(({ key, item }) => ({
    key,
    section: item,
  }));
}

/* ------------------------------ Assembly ------------------------------ */

/** The hour each part of the day resolves to, from Settings. */
export interface DayHours {
  morning: number;
  afternoon: number;
  evening: number;
}

export interface ResolveContext {
  now: Date;
  contacts: readonly Person[];
  groups: readonly IntentGroupOption[];
  sections: readonly IntentSectionOption[];
  hours: DayHours;
}

/** A typed sentence as the intent code can act on (not an Outbox Intent: that is sync.ts). */
export interface TypedIntent {
  text: string;
  kind: TypedIntentKind;
  tier: ToolTier | null;
  /** The least certain of the answers this intent depends on (the function-calling pattern). */
  confidence: number;
  person: Person | null;
  group: IntentGroupOption | null;
  section: IntentSectionOption | null;
  /** The moment the sentence names, in the caller's zone; null when it names none. */
  when: Date | null;
  /** Whether the sentence names a set of Threads or the one open. */
  scope: "one" | "many";
  /** The age limit, as a moment: Threads last active before it. */
  olderThan: Date | null;
  age: IntentAge;
  threadKind: IntentThreadKind;
  model: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** The hour an hour option names, or null for none. */
export function hourOf(hour: IntentHour, hours: DayHours): number | null {
  if (hour === "none") return null;
  if (hour === "morning") return hours.morning;
  if (hour === "afternoon") return hours.afternoon;
  if (hour === "evening") return hours.evening;
  return Number(hour.slice(1));
}

/**
 * The moment a weekday and an hour name, in code (the date-extraction
 * pattern): a bare weekday is its next occurrence on or after today, and a
 * time already past today moves to the next day it fits. Null when the
 * sentence names neither a day nor a time.
 */
export function resolveWhen(
  weekday: IntentWeekday,
  hour: IntentHour,
  now: Date,
  hours: DayHours,
): Date | null {
  const h = hourOf(hour, hours);
  if (weekday === "none" && h === null) return null;
  const at = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    h ?? hours.morning,
    0,
    0,
    0,
  );
  if (weekday === "tomorrow") {
    at.setDate(at.getDate() + 1);
  } else if (weekday !== "none" && weekday !== "today") {
    const target = WEEKDAY_INDEX[weekday] ?? now.getDay();
    let ahead = (target - now.getDay() + 7) % 7;
    if (ahead === 0 && at.getTime() <= now.getTime()) ahead = 7;
    at.setDate(at.getDate() + ahead);
  } else if (at.getTime() <= now.getTime()) {
    // "at 15:00" after 15:00 means tomorrow.
    at.setDate(at.getDate() + 1);
  }
  return at;
}

const DAY_MS = 86_400_000;

/** The cutoff an age names: Threads last active before it are "older than". */
export function olderThanOf(age: IntentAge, now: Date): Date | null {
  switch (age) {
    case "day":
      return new Date(now.getTime() - DAY_MS);
    case "week":
      return new Date(now.getTime() - 7 * DAY_MS);
    case "month":
      return new Date(now.getTime() - 30 * DAY_MS);
    default:
      return null;
  }
}

/** The questions an intent's outcome depends on; their least confident answer gates it. */
function dependsOn(kind: TypedIntentKind, many: boolean): Array<keyof IntentReading> {
  const set: Array<keyof IntentReading> = many ? ["kind", "age"] : [];
  switch (kind) {
    case "schedule_event":
      return ["person", "weekday", "hour"];
    case "snooze":
      return ["weekday", "hour", ...set];
    case "move":
      return ["group", ...set];
    case "compose":
      return ["person"];
    case "open_group":
      return ["group"];
    case "open_section":
      return ["section"];
    case "archive":
    case "star":
    case "mark_read":
    case "tag":
      return set;
    default:
      return [];
  }
}

/**
 * The reading as an Intent: names looked up in the sets the client sent,
 * the moment and the cutoff computed here, the set semantics decided here
 * (an age or a kind names a set whatever the scope answer said, which is
 * where the literal reading of "many threads" went wrong in the research),
 * and the confidence the least certain answer the intent depends on.
 */
export function resolveIntent(reading: IntentReading, ctx: ResolveContext): TypedIntent {
  const kind = reading.intent.choice;
  const contact = contactOptions(ctx.contacts).find((c) => c.key === reading.person.choice);
  const group = groupOptions(ctx.groups).find((g) => g.key === reading.group.choice);
  const section = sectionOptions(ctx.sections).find((s) => s.key === reading.section.choice);
  const age = reading.age.choice;
  const threadKind = reading.kind.choice;
  const many = reading.scope >= 0.5 || age !== "none" || threadKind !== "any";
  const answers: Record<string, number> = {
    person: contact ? reading.person.confidence : reading.person.choice === "none" ? 1 : 0,
    group: group ? reading.group.confidence : reading.group.choice === "none" ? 1 : 0,
    section: section ? reading.section.confidence : reading.section.choice === "none" ? 1 : 0,
    weekday: reading.weekday.confidence,
    hour: reading.hour.confidence,
    kind: reading.kind.confidence,
    age: reading.age.confidence,
  };
  let confidence = reading.intent.confidence;
  for (const q of dependsOn(kind, many)) confidence = Math.min(confidence, answers[q] ?? 0);
  return {
    text: reading.text,
    kind,
    tier: INTENT_TIERS[kind],
    confidence,
    person: contact?.person ?? null,
    group: group?.group ?? null,
    section: section?.section ?? null,
    when: resolveWhen(reading.weekday.choice, reading.hour.choice, ctx.now, ctx.hours),
    scope: many ? "many" : "one",
    olderThan: olderThanOf(age, ctx.now),
    age,
    threadKind,
    model: reading.model,
  };
}

/** What the confidence gate says: run it, show it and ask for one key, or hand the sentence to the Agent. */
export type IntentGate = "act" | "confirm" | "agent";

export function gateIntent(
  intent: Pick<TypedIntent, "kind" | "tier" | "confidence">,
  thresholds: { actAbove: number; askBelow: number },
): IntentGate {
  if (intent.kind === "other" || intent.tier === null) return "agent";
  if (intent.confidence < thresholds.askBelow) return "agent";
  if (intent.confidence >= thresholds.actAbove) return "act";
  return "confirm";
}
