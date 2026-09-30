// Fields (CONTEXT.md "Field"; docs/spec/views.md, "Fields"): one value per
// Thread a Block can show, filter, group, sort, dedupe or add up, named by a
// reference: a Fact (`received_at`), a row field (`subject`, `person`,
// `company`, `lane`), a Signal (`signal:<id>`) or an Extraction (`x:<id>`).
// Each has a type code knows, and a value that is three-valued: a value,
// empty (known absent), Unsure, or not read yet. Pure and runtime-neutral.

import type { JsonValue } from "../judge.ts";
import {
  domainOfAddress,
  factValue,
  readExtraction,
  readingOf,
  VIEW_SHIPPED_SIGNALS,
  type ViewContext,
  type ViewThread,
} from "./core.ts";
import {
  type ExtractKind,
  type ValueFormat,
  VIEW_FACTS,
  type ViewDoc,
  type ViewFact,
} from "./types.ts";

export type FieldType =
  | "number"
  | "money"
  | "date"
  | "text"
  | "flag"
  | "probability"
  | "score"
  | "choice"
  | "lane"
  | "person"
  | "link";

export interface Money {
  value: number;
  currency: string;
}

export interface PersonValue {
  name: string;
  email: string;
}

export interface LinkValue {
  url: string;
  domain: string;
}

export type FieldScalar = number | string | boolean | Money | PersonValue | LinkValue;

/** One Field's value on one Thread (or one deduped row). */
export type FieldValue =
  | { state: "value"; type: FieldType; value: FieldScalar; text: string; confidence?: number }
  /** Known absent: no deadline, an Extraction that found none. */
  | { state: "empty" }
  /** A Signal or an Extraction that could not decide. */
  | { state: "unsure"; text?: string | undefined }
  /** No answer yet. */
  | { state: "not_read" };

/** What a reference names, for validation, formatting and the column header. */
export interface FieldInfo {
  ref: string;
  kind: "fact" | "row" | "signal" | "extraction" | "lane";
  type: FieldType;
  label: string;
}

/** The row fields beside the Facts (and a Board row's old names for them). */
export const ROW_FIELD_TYPES: Readonly<Record<string, FieldType>> = {
  subject: "text",
  snippet: "text",
  sender: "text",
  group: "text",
  section: "text",
  person: "person",
  company: "text",
  lane: "lane",
  age: "date",
  time: "date",
  deadline: "date",
};

/** The type an Extraction's value has, by what it finds. */
export const EXTRACT_TYPES: Readonly<Record<ExtractKind, FieldType>> = {
  money: "money",
  date: "date",
  reference: "text",
  tracking: "text",
  email: "text",
  person: "text",
  company: "text",
  link: "link",
  quantity: "number",
  item: "text",
  sentence: "text",
};

const words = (id: string) => id.replaceAll("_", " ");

/** What a reference names in this View; null when it names nothing the View has. */
export function fieldInfo(
  doc: ViewDoc,
  ref: string,
  shipped: Readonly<Record<string, { kind: string; label?: string }>> = VIEW_SHIPPED_SIGNALS,
): FieldInfo | null {
  if (ref.startsWith("signal:")) {
    const id = ref.slice("signal:".length);
    const own = doc.signals.find((s) => s.id === id);
    const kind = own?.kind ?? (doc.uses.includes(id) ? shipped[id]?.kind : undefined);
    if (!kind) return null;
    const type: FieldType = kind === "noul" ? "probability" : kind === "score" ? "score" : "choice";
    return {
      ref,
      kind: "signal",
      type,
      label: own?.label?.trim() || shipped[id]?.label || words(id),
    };
  }
  if (ref.startsWith("x:")) {
    const x = doc.extractions.find((e) => e.id === ref.slice(2));
    if (!x) return null;
    return {
      ref,
      kind: "extraction",
      type: EXTRACT_TYPES[x.find],
      label: x.label?.trim() || words(x.id),
    };
  }
  if (ref === "lane") return { ref, kind: "lane", type: "lane", label: "Lane" };
  if (ref in VIEW_FACTS) {
    const k = VIEW_FACTS[ref as ViewFact];
    return { ref, kind: "fact", type: k === "flag" ? "flag" : k, label: words(ref) };
  }
  const row = ROW_FIELD_TYPES[ref];
  return row ? { ref, kind: "row", type: row, label: words(ref) } : null;
}

/* ------------------------------ People and companies ------------------------------ */

/** Mail domains that belong to a person, not a company. */
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "fastmail.com",
  "fastmail.fm",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "mail.com",
  "hey.com",
  "zoho.com",
  "yandex.com",
  "web.de",
]);

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"]);

/** The part of a domain an organisation registered: `mail.amazon.co.uk` is `amazon.co.uk`. */
export function registrableDomain(domain: string): string {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1] as string;
  const second = labels[labels.length - 2] as string;
  const keep = tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

const titleCase = (s: string) =>
  s
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => (w[0] ?? "").toUpperCase() + w.slice(1))
    .join(" ");

/**
 * The organisation behind an address, from its domain (code only): `acme.com`
 * is Acme. Null for a personal mail domain: the person is the company.
 */
export function companyOf(email: string | null | undefined): { key: string; label: string } | null {
  const domain = domainOfAddress(email ?? null);
  if (!domain || PERSONAL_DOMAINS.has(domain)) return null;
  const key = registrableDomain(domain);
  const name = key.split(".")[0] ?? key;
  return { key, label: titleCase(name) };
}

/** The Thread's correspondent: the newest sender who is not the owner, else whoever started it. */
export function personOf(t: ViewThread): PersonValue | null {
  if (t.correspondent?.email) {
    return { name: t.correspondent.name, email: t.correspondent.email.toLowerCase() };
  }
  return t.from ? { name: "", email: t.from.toLowerCase() } : null;
}

/* ------------------------------ Reading a Field ------------------------------ */

const value = (type: FieldType, v: FieldScalar, text: string, confidence?: number): FieldValue =>
  confidence === undefined
    ? { state: "value", type, value: v, text }
    : { state: "value", type, value: v, text, confidence };

function fromJson(type: FieldType, v: JsonValue, text: string): FieldScalar {
  if (type === "money" && v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, JsonValue>;
    return { value: Number(o.value ?? 0), currency: String(o.currency ?? "") };
  }
  if (type === "link" && v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, JsonValue>;
    return { url: String(o.url ?? text), domain: String(o.domain ?? "") };
  }
  if (type === "number") return typeof v === "number" ? v : Number(v);
  return typeof v === "string" ? v : text;
}

/**
 * One Field on one Thread. `lane` is where the Thread sits (the lanes code
 * computed it); a Signal reads as its number (a Noul's probability, a
 * Score's expectation) or a Choice's pick, Unsure under the confidence floor.
 */
export function readField(
  doc: ViewDoc,
  t: ViewThread,
  ref: string,
  ctx: ViewContext,
  lane: string | null = null,
  laneLabel?: (id: string) => string,
): FieldValue {
  if (ref.startsWith("x:")) {
    const read = readExtraction(doc, t, ref.slice(2), ctx);
    if (read.state === "value") {
      const x = doc.extractions.find((e) => e.id === ref.slice(2));
      const type = x ? EXTRACT_TYPES[x.find] : "text";
      return value(type, fromJson(type, read.value, read.text), read.text, read.confidence);
    }
    if (read.state === "unsure") return { state: "unsure", text: read.text ?? undefined };
    return read;
  }
  if (ref.startsWith("signal:")) {
    const local = ref.slice("signal:".length);
    const r = readingOf(doc, t, local);
    if (!r || (r.stale && ctx.rules.staleAnswers === "hide")) return { state: "not_read" };
    if (r.noul !== undefined && r.noul !== null) {
      return value("probability", r.noul, `${Math.round(r.noul * 100)}%`);
    }
    if (
      r.confidence !== undefined &&
      r.confidence !== null &&
      r.confidence < ctx.rules.confidenceBelow
    )
      return { state: "unsure" };
    if (r.choice !== undefined && r.choice !== null) {
      return r.choice === "none" ? { state: "empty" } : value("choice", r.choice, r.choice);
    }
    if (r.score !== undefined && r.score !== null)
      return value("score", r.score, r.score.toFixed(1));
    return { state: "not_read" };
  }
  switch (ref) {
    case "lane":
      return lane === null ? { state: "empty" } : value("lane", lane, laneLabel?.(lane) ?? lane);
    case "subject":
      return t.subject ? value("text", t.subject, t.subject) : { state: "empty" };
    case "snippet":
      return t.snippet ? value("text", t.snippet, t.snippet) : { state: "empty" };
    case "sender":
    case "person": {
      const p = personOf(t);
      if (!p) return { state: "empty" };
      return ref === "person"
        ? value("person", p, p.name || p.email)
        : value("text", p.name || p.email, p.name || p.email);
    }
    case "company": {
      const p = personOf(t);
      const c = companyOf(p?.email);
      if (c) return value("text", c.key, c.label);
      return p ? value("text", p.email, p.name || p.email) : { state: "empty" };
    }
    case "group":
      return t.group ? value("text", t.group, t.group) : { state: "empty" };
    case "section":
      return t.section ? value("text", t.section, t.section) : { state: "empty" };
    case "age":
    case "time":
      return value("date", t.lastActivity, t.lastActivity);
    case "deadline":
      return readField(doc, t, "deadline_at", ctx, lane);
  }
  if (ref in VIEW_FACTS) {
    const fact = ref as ViewFact;
    const v = factValue(t, fact);
    if (v === undefined || v === null) return t.facts ? { state: "empty" } : { state: "not_read" };
    const kind = VIEW_FACTS[fact];
    if (kind === "flag") return value("flag", v === true || v === 1, String(v === true || v === 1));
    if (kind === "number") {
      const n = Number(v);
      return Number.isFinite(n) ? value("number", n, String(n)) : { state: "empty" };
    }
    if (kind === "date") return value("date", String(v), String(v));
    const list = Array.isArray(v) ? v.map(String) : [String(v)];
    return value("text", list.join(", "), list.join(", "));
  }
  return { state: "empty" };
}

/** A value as a number for sums and comparisons (money's amount), else null. */
export function numeric(v: FieldValue): number | null {
  if (v.state !== "value") return null;
  const x = v.value;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (x && typeof x === "object" && "currency" in x) return x.value;
  if (typeof x === "string" && v.type === "date") {
    const at = Date.parse(x);
    return Number.isNaN(at) ? null : at;
  }
  return null;
}

/** A value's grouping and dedupe key: comparable text. */
export function keyOf(v: FieldValue): string | null {
  if (v.state !== "value") return null;
  const x = v.value;
  if (x && typeof x === "object") {
    if ("email" in x) return x.email.toLowerCase();
    if ("url" in x) return x.url;
    if ("currency" in x) return `${x.currency} ${x.value}`;
  }
  return String(x).trim().replace(/^#/, "").toLowerCase();
}

/* ------------------------------ Writing a value ------------------------------ */

/** The words a value is written with when it is not a value. */
export interface ValueWords {
  unsure: string;
  notRead: string;
  yes: string;
  no: string;
  today: string;
  tomorrow: string;
  yesterday: string;
  /** "in {n} days" */
  inDays: string;
  /** "{n} days ago" */
  daysAgo: string;
}

export const DEFAULT_VALUE_WORDS: ValueWords = {
  unsure: "Unsure",
  notRead: "Not read yet",
  yes: "Yes",
  no: "No",
  today: "today",
  tomorrow: "tomorrow",
  yesterday: "yesterday",
  inDays: "in {n} days",
  daysAgo: "{n} days ago",
};

/** Money in its own currency, as the owner's locale writes it. */
export function formatMoney(m: Money, locale = "en-US"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(
      m.value,
    );
  } catch {
    return `${m.currency} ${m.value.toFixed(2)}`;
  }
}

/** A number the way a stat or a column writes it: whole numbers plain, others to two places. */
export function formatNumber(n: number, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
  }).format(n);
}

const DAY = 86_400_000;

/** A date as a short day ("Oct 3", with the year when it is not this year), in the zone. */
export function formatViewDay(iso: string, now: Date, zone: string, locale = "en-US"): string {
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(at.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    ...(zone ? { timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : zone } : {}),
  };
  if (at.getUTCFullYear() !== now.getUTCFullYear()) opts.year = "numeric";
  try {
    return new Intl.DateTimeFormat(locale, opts).format(at);
  } catch {
    return iso.slice(0, 10);
  }
}

/** A date relative to now in days: today, tomorrow, in 3 days, 2 days ago. */
export function formatRelative(iso: string, now: Date, words: ValueWords = DEFAULT_VALUE_WORDS) {
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(at)) return iso;
  const days = Math.round((at - now.getTime()) / DAY);
  if (days === 0) return words.today;
  if (days === 1) return words.tomorrow;
  if (days === -1) return words.yesterday;
  return (days > 0 ? words.inDays : words.daysAgo).replace("{n}", String(Math.abs(days)));
}

/** A Field's value in words, by the format a column or a stat asks for (else by its type). */
export function formatFieldValue(
  v: FieldValue,
  format: ValueFormat | undefined,
  ctx: Pick<ViewContext, "now" | "zone">,
  words: ValueWords = DEFAULT_VALUE_WORDS,
): string {
  if (v.state === "unsure") return words.unsure;
  if (v.state === "not_read") return words.notRead;
  if (v.state === "empty") return "";
  const x = v.value;
  const as = format ?? (v.type === "money" ? "money" : v.type === "date" ? "date" : undefined);
  if (x && typeof x === "object") {
    if ("currency" in x) return as === "number" ? formatNumber(x.value) : formatMoney(x);
    if ("url" in x) return x.domain || x.url;
    if ("email" in x) return x.name || x.email;
  }
  if (typeof x === "boolean") return x ? words.yes : "";
  if (as === "date" && typeof x === "string") return formatViewDay(x, ctx.now, ctx.zone);
  if (as === "relative" && typeof x === "string") return formatRelative(x, ctx.now, words);
  if (as === "percent" && typeof x === "number") return `${Math.round(x * 100)}%`;
  if (typeof x === "number") {
    if (v.type === "probability") return `${Math.round(x * 100)}%`;
    if (v.type === "score") return x.toFixed(1);
    return formatNumber(x);
  }
  return v.text || String(x);
}
