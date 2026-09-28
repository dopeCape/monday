// The Sort scope (CONTEXT.md "Sort scope"; docs/spec/routing.md): how much of
// the mail already there a re-run or a Backlog sort covers. The newest N
// Threads, the last N days, weeks, months or years, everything since a date,
// or everything. Stored in Settings and on the wire as one short sentence
// ("latest 50", "last 3 months", "since 2026-01-01", "all"), so monday.toml
// and the Agent write it the way a person would; `parseSortScope` reads that
// sentence (and the looser ways people say it) and `formatSortScope` writes
// the canonical one back. Dates are the caller's clock; months and years are
// calendar months and years, never 30 or 365 days.
//
// Runtime-neutral: no Bun, no DOM.

export type ScopeUnit = "days" | "weeks" | "months" | "years";

export const SCOPE_UNITS: readonly ScopeUnit[] = ["days", "weeks", "months", "years"];

export type SortScope =
  /** The newest `count` Inbox Threads. */
  | { kind: "latest"; count: number }
  /** Threads with activity in the last `amount` units, counted back from now. */
  | { kind: "last"; amount: number; unit: ScopeUnit }
  /** Threads with activity on or after `date` (YYYY-MM-DD, the start of that day in UTC). */
  | { kind: "since"; date: string }
  /** Every Inbox Thread. */
  | { kind: "all" };

export type SortScopeKind = SortScope["kind"];

export const SORT_SCOPE_KINDS: readonly SortScopeKind[] = ["latest", "last", "since", "all"];

/** The largest count or amount a scope may name, so a typo cannot ask for a billion Threads. */
export const SCOPE_MAX = 1_000_000;

const UNIT_WORDS: Record<string, ScopeUnit> = {
  d: "days",
  day: "days",
  days: "days",
  w: "weeks",
  wk: "weeks",
  wks: "weeks",
  week: "weeks",
  weeks: "weeks",
  m: "months",
  mo: "months",
  mos: "months",
  mon: "months",
  month: "months",
  months: "months",
  y: "years",
  yr: "years",
  yrs: "years",
  year: "years",
  years: "years",
};

const LATEST_WORDS = new Set(["latest", "newest", "recent", "last"]);
const ALL_WORDS = new Set(["all", "everything", "every", "whole"]);

/** A YYYY-MM-DD that names a real day. */
export function isScopeDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

const count = (text: string | undefined): number | null => {
  if (text === undefined) return 1;
  const n = Number(text.replaceAll(",", "").replaceAll("_", ""));
  if (!Number.isInteger(n) || n < 1 || n > SCOPE_MAX) return null;
  return n;
};

/**
 * Reads a scope sentence: "latest 50", "newest 200 threads", "50",
 * "last 3 months", "last month", "6 mo", "since 2026-01-01", "all",
 * "everything". Null when it names no scope.
 */
export function parseSortScope(text: string): SortScope | null {
  const words = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "")
    .split(/\s+/)
    .filter((w) => w.length > 0 && w !== "the" && w !== "my" && w !== "mail" && w !== "email");
  if (words.length === 0) return null;
  const [first, second, third, ...rest] = words;
  if (!first) return null;
  if (ALL_WORDS.has(first) && words.length <= 3) return { kind: "all" };
  if (first === "since" || first === "from" || first === "after") {
    if (!second || third !== undefined || !isScopeDate(second)) return null;
    return { kind: "since", date: second };
  }
  if (isScopeDate(first) && words.length === 1) return { kind: "since", date: first };
  // "last 3 months", "last month", "3 months", "latest 50", "newest 50 threads", "50".
  const lead = LATEST_WORDS.has(first);
  const tokens = lead ? [second, third, ...rest] : [first, second, third, ...rest];
  const live = tokens.filter((t): t is string => t !== undefined);
  // "last month": the unit alone means one of it.
  const [a, b, c] = live;
  if (a === undefined) return null;
  const alone = UNIT_WORDS[a];
  if (alone && b === undefined && lead) return { kind: "last", amount: 1, unit: alone };
  // "3months" as one word.
  const glued = a.match(/^(\d[\d,_]*)([a-z]+)$/);
  const gluedUnit = glued?.[2] ? UNIT_WORDS[glued[2]] : undefined;
  if (glued?.[1] && gluedUnit && b === undefined) {
    const n = count(glued[1]);
    return n === null ? null : { kind: "last", amount: n, unit: gluedUnit };
  }
  const n = count(a);
  if (n === null || !/^\d/.test(a)) return null;
  if (b === undefined) return { kind: "latest", count: n };
  const unit = UNIT_WORDS[b];
  if (unit && c === undefined) return { kind: "last", amount: n, unit };
  if ((b === "threads" || b === "thread" || b === "conversations") && c === undefined) {
    return { kind: "latest", count: n };
  }
  return null;
}

/** The canonical sentence for a scope, what Settings store and the wire carries. */
export function formatSortScope(scope: SortScope): string {
  switch (scope.kind) {
    case "latest":
      return `latest ${scope.count}`;
    case "last":
      return `last ${scope.amount} ${scope.unit}`;
    case "since":
      return `since ${scope.date}`;
    default:
      return "all";
  }
}

/** A scope sentence parsed, or the fallback when it does not parse. */
export function sortScopeOr(text: string, fallback: SortScope): SortScope {
  return parseSortScope(text) ?? fallback;
}

/**
 * The oldest last activity a Thread may have and still be in scope, or null
 * when the scope is a count or everything. Months and years step back on the
 * calendar (from March 31, one month back is the last day of February).
 */
export function scopeStart(scope: SortScope, now: Date): Date | null {
  if (scope.kind === "since") return new Date(`${scope.date}T00:00:00Z`);
  if (scope.kind !== "last") return null;
  const at = new Date(now.getTime());
  if (scope.unit === "days") at.setUTCDate(at.getUTCDate() - scope.amount);
  else if (scope.unit === "weeks") at.setUTCDate(at.getUTCDate() - scope.amount * 7);
  else {
    const months = scope.unit === "months" ? scope.amount : scope.amount * 12;
    const day = at.getUTCDate();
    at.setUTCDate(1);
    at.setUTCMonth(at.getUTCMonth() - months);
    const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
    at.setUTCDate(Math.min(day, last));
  }
  return at;
}

/** How many Threads a scope stops at, or null when it is bounded by date or not at all. */
export function scopeLimit(scope: SortScope): number | null {
  return scope.kind === "latest" ? scope.count : null;
}

/** Whether a Thread last active at `lastActivity` is inside a date scope (a count scope always says yes). */
export function inSortScope(scope: SortScope, lastActivity: Date, now: Date): boolean {
  const start = scopeStart(scope, now);
  return start === null || lastActivity.getTime() >= start.getTime();
}

/** The words a scope is described with: strings.routing.scope.* Settings. */
export interface ScopeWords {
  /** "the newest {n} threads" */
  latest: string;
  /** "the newest thread" */
  latestOne: string;
  /** "the last {n} {unit}" */
  last: string;
  /** "the last {unit}" */
  lastOne: string;
  /** "mail since {date}" */
  since: string;
  /** "all your mail" */
  all: string;
  /** Unit words, plural and singular: "days", "day", ... */
  units: Record<ScopeUnit, { one: string; many: string }>;
}

const fillWords = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) =>
    values[k] === undefined ? m : String(values[k]),
  );

/**
 * A scope in the user's words. `date` formats a since date; by default the
 * date as written. Numbers are grouped with `group` (the caller's locale).
 */
export function describeSortScope(
  scope: SortScope,
  words: ScopeWords,
  options: { date?: (iso: string) => string; group?: (n: number) => string } = {},
): string {
  const group = options.group ?? ((n: number) => String(n));
  switch (scope.kind) {
    case "latest":
      return scope.count === 1
        ? words.latestOne
        : fillWords(words.latest, { n: group(scope.count) });
    case "last": {
      const unit = words.units[scope.unit];
      return scope.amount === 1
        ? fillWords(words.lastOne, { unit: unit.one })
        : fillWords(words.last, { n: group(scope.amount), unit: unit.many });
    }
    case "since":
      return fillWords(words.since, { date: options.date ? options.date(scope.date) : scope.date });
    default:
      return words.all;
  }
}

/** ScopeWords from a Settings object (or any record holding the strings.routing.scope.* keys). */
export function scopeWordsFrom(settings: Readonly<Record<string, unknown>>): ScopeWords {
  const s = (key: string, fallback: string) => {
    const v = settings[`strings.routing.scope.${key}`];
    return typeof v === "string" ? v : fallback;
  };
  return {
    latest: s("latest", "the newest {n} threads"),
    latestOne: s("latest_one", "the newest thread"),
    last: s("last", "the last {n} {unit}"),
    lastOne: s("last_one", "the last {unit}"),
    since: s("since", "mail since {date}"),
    all: s("all", "all your mail"),
    units: {
      days: { one: s("unit.day", "day"), many: s("unit.days", "days") },
      weeks: { one: s("unit.week", "week"), many: s("unit.weeks", "weeks") },
      months: { one: s("unit.month", "month"), many: s("unit.months", "months") },
      years: { one: s("unit.year", "year"), many: s("unit.years", "years") },
    },
  };
}
