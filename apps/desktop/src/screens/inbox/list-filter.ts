// The Filter menu as data (docs/spec/inbox.md, Stream): the chips the user
// stacked under the list header, what they mean over a Thread, and the SQL
// that answers them over the whole Cache. The Inbox holds only a window of
// each list (inbox.memory_window), so a filter that must see every Thread
// (a year, a sender, a domain) is its own bounded list the Store's seam
// pages like any other (folders.ts), keyed by `filter:` and the resolved
// filter. Needs a reply stays a filter over the Threads held: it reads the
// Section the client decides and the Judgments. Pure: no Store, no DOM.

import type { Thread, ThreadJudgments } from "@monday/shared";
import { DEFAULT_JUDGED_THRESHOLD } from "@monday/shared";
import type { Row, SqlParam } from "../../store/driver.ts";
import type { ThreadListQuery } from "../../store/queries.ts";
import type { ThreadListKey } from "./folders.ts";

/** The on/off filters. */
export type FlagKind = "unread" | "starred" | "attachments" | "needs_reply";
export const FLAG_KINDS: readonly FlagKind[] = ["unread", "starred", "attachments", "needs_reply"];

/** A date range the menu offers: this week, this month, or two days picked (inclusive, YYYY-MM-DD). */
export type RangeChip =
  | { kind: "range"; range: "week" }
  | { kind: "range"; range: "month" }
  | { kind: "range"; range: "dates"; from: string; to: string };

/** One filter under the list header. At most one chip of each kind; they combine with AND. */
export type FilterChip =
  | { kind: FlagKind }
  | { kind: "year"; year: number }
  | { kind: "person"; email: string; name: string }
  | { kind: "domain"; domain: string }
  | RangeChip;
export type FilterKind = FilterChip["kind"];

/** The facets the menu lists with counts. */
export type FacetKind = "year" | "person" | "domain";

/** One facet choice: its key (a year, an address, a domain), a label, how many Threads carry it. */
export interface Facet {
  key: string;
  label: string;
  count: number;
}

/** Adds a chip, replacing one of the same kind; the chip goes last (Escape takes it back first). */
export function withChip(chips: readonly FilterChip[], chip: FilterChip): FilterChip[] {
  return [...chips.filter((c) => c.kind !== chip.kind), chip];
}

export function withoutChip(chips: readonly FilterChip[], kind: FilterKind): FilterChip[] {
  return chips.filter((c) => c.kind !== kind);
}

/** Turns an on/off filter on or off. */
export function toggleFlag(chips: readonly FilterChip[], kind: FlagKind): FilterChip[] {
  return chips.some((c) => c.kind === kind) ? withoutChip(chips, kind) : [...chips, { kind }];
}

/* ------------------------------ Resolving ------------------------------ */

/**
 * The chips as a filter over the Cache, with the dates turned into bounds
 * on last activity (ISO, `from` inclusive, `to` exclusive) for this `now`.
 * A year and a range together keep the days both allow. Needs a reply is
 * not here: it is decided over the Threads held.
 */
export interface ResolvedFilter {
  unread?: true;
  starred?: true;
  attachments?: true;
  from?: string;
  to?: string;
  person?: string;
  domain?: string;
}

const localDay = (y: number, m: number, d: number) => new Date(y, m, d);
function parseDay(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = localDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A chip's span of local days as [from, to), or null for a chip with no dates. */
export function chipSpan(
  chip: FilterChip,
  now: Date,
  weekStartsMonday: boolean,
): { from: Date; to: Date } | null {
  if (chip.kind === "year") {
    return { from: localDay(chip.year, 0, 1), to: localDay(chip.year + 1, 0, 1) };
  }
  if (chip.kind !== "range") return null;
  if (chip.range === "week") {
    const back = (now.getDay() - (weekStartsMonday ? 1 : 0) + 7) % 7;
    const from = localDay(now.getFullYear(), now.getMonth(), now.getDate() - back);
    return { from, to: localDay(from.getFullYear(), from.getMonth(), from.getDate() + 7) };
  }
  if (chip.range === "month") {
    return {
      from: localDay(now.getFullYear(), now.getMonth(), 1),
      to: localDay(now.getFullYear(), now.getMonth() + 1, 1),
    };
  }
  if (chip.range !== "dates") return null;
  const a = parseDay(chip.from);
  const b = parseDay(chip.to);
  if (!a || !b) return null;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return { from: lo, to: localDay(hi.getFullYear(), hi.getMonth(), hi.getDate() + 1) };
}

export function resolveFilter(
  chips: readonly FilterChip[],
  now: Date,
  weekStartsMonday: boolean,
): ResolvedFilter {
  const f: ResolvedFilter = {};
  for (const c of chips) {
    switch (c.kind) {
      case "unread":
      case "starred":
      case "attachments":
        f[c.kind] = true;
        break;
      case "person":
        f.person = c.email.trim().toLowerCase();
        break;
      case "domain":
        f.domain = c.domain.trim().toLowerCase().replace(/^@/, "");
        break;
      case "year":
      case "range": {
        const span = chipSpan(c, now, weekStartsMonday);
        if (!span) break;
        const from = span.from.toISOString();
        const to = span.to.toISOString();
        if (f.from === undefined || from > f.from) f.from = from;
        if (f.to === undefined || to < f.to) f.to = to;
        break;
      }
      case "needs_reply":
        break;
    }
  }
  return f;
}

/** Whether a resolved filter asks the Cache anything. */
export function isFilterEmpty(f: ResolvedFilter): boolean {
  return Object.keys(f).length === 0;
}

/** The filter without one facet's own dimension, so that facet's counts show every choice. */
export function withoutFacet(f: ResolvedFilter, kind: FacetKind): ResolvedFilter {
  const { from, to, person, domain, ...rest } = f;
  if (kind === "year")
    return { ...rest, ...(person ? { person } : {}), ...(domain ? { domain } : {}) };
  if (kind === "person") {
    return {
      ...rest,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(domain ? { domain } : {}),
    };
  }
  return {
    ...rest,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(person ? { person } : {}),
  };
}

/* ------------------------------ SQL ------------------------------ */

/** The filter as a predicate over `threads t`, and its params. */
export function filterWhere(f: ResolvedFilter): { where: string; params: SqlParam[] } {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (f.unread) where.push("t.unread = 1");
  if (f.starred) where.push("t.starred = 1");
  if (f.attachments) where.push("t.has_attachments = 1");
  if (f.from !== undefined) {
    where.push("t.last_activity >= ?");
    params.push(f.from);
  }
  if (f.to !== undefined) {
    where.push("t.last_activity < ?");
    params.push(f.to);
  }
  if (f.person !== undefined) {
    where.push("t.id in (select thread_id from thread_senders where email = ?)");
    params.push(f.person);
  }
  if (f.domain !== undefined) {
    where.push("t.id in (select thread_id from thread_senders where domain = ?)");
    params.push(f.domain);
  }
  return { where: where.length ? where.join(" and ") : "1", params };
}

/** A list narrowed by the filter: the list's own rows and order, AND the filter. */
export function filteredQuery(list: ThreadListQuery, f: ResolvedFilter): ThreadListQuery {
  const fw = filterWhere(f);
  return {
    where: `(${list.where}) and ${fw.where}`,
    params: [...list.params, ...fw.params],
    order: list.order,
  };
}

/** How many Threads a list holds over the whole Cache. */
export function countSql(list: ThreadListQuery): { sql: string; params: SqlParam[] } {
  return {
    sql: `select count(*) as n from threads t where ${list.where}`,
    params: [...list.params],
  };
}

/** Every Thread id of a list over the whole Cache, in the list's order ("Select all"). */
export function idsSql(list: ThreadListQuery): { sql: string; params: SqlParam[] } {
  const orderBy = list.order.map((o) => `t.${o.column} ${o.desc ? "desc" : "asc"}`).join(", ");
  return {
    sql: `select t.id as id from threads t where ${list.where} order by ${orderBy}`,
    params: [...list.params],
  };
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * One facet's choices over a list, most Threads first (years newest first).
 * `offsetMinutes` is the Device's offset from UTC at the start of the year
 * (minutes east), so a Thread counts toward the user's own calendar year.
 * `owner` is left out of Person: the Sent folder already answers "mine".
 */
export function facetSql(
  kind: FacetKind,
  list: ThreadListQuery,
  options: {
    needle?: string | undefined;
    limit: number;
    offsetMinutes: number;
    owner?: string | undefined;
  },
): { sql: string; params: SqlParam[] } {
  const needle = (options.needle ?? "").trim().toLowerCase();
  const like = `%${likeEscape(needle)}%`;
  if (kind === "year") {
    return {
      sql: `select strftime('%Y', t.last_activity, ?) as k, count(*) as n
            from threads t where ${list.where}
            group by k order by k desc`,
      params: [
        `${options.offsetMinutes >= 0 ? "+" : ""}${options.offsetMinutes} minutes`,
        ...list.params,
      ],
    };
  }
  if (kind === "person") {
    const owner = (options.owner ?? "").trim().toLowerCase();
    return {
      sql: `select s.email as k, max(s.name) as label, count(*) as n
            from thread_senders s join threads t on t.id = s.thread_id
            where (${list.where}) and s.email <> ?
              ${needle ? "and (s.email like ? escape '\\' or lower(s.name) like ? escape '\\')" : ""}
            group by s.email order by n desc, s.email limit ?`,
      params: [...list.params, owner, ...(needle ? [like, like] : []), options.limit],
    };
  }
  return {
    sql: `select s.domain as k, count(distinct s.thread_id) as n
          from thread_senders s join threads t on t.id = s.thread_id
          where (${list.where}) and s.domain <> ''
            ${needle ? "and s.domain like ? escape '\\'" : ""}
          group by s.domain order by n desc, s.domain limit ?`,
    params: [...list.params, ...(needle ? [like] : []), options.limit],
  };
}

/** A facet row as the menu lists it. */
export function rowToFacet(kind: FacetKind, r: Row): Facet {
  const key = String(r.k ?? "");
  const label = kind === "person" && typeof r.label === "string" && r.label ? r.label : key;
  return { key, label, count: Number(r.n ?? 0) };
}

/* ------------------------------ Over one row or Thread ------------------------------ */

const flag = (v: unknown) => v === 1 || v === true;
const inSpan = (f: ResolvedFilter, at: string) =>
  (f.from === undefined || at >= f.from) && (f.to === undefined || at < f.to);
const domainOf = (email: string) => {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : "";
};

/**
 * Whether a Cache row (as the list columns read it, `sender_emails` among
 * them) belongs in the filtered list. A row the list already holds keeps
 * its place when only a flag changed (a Thread read under Unread stays
 * until the filter changes), as the screen's own filter always did.
 */
export function filterKeepsRow(f: ResolvedFilter, r: Row, held: boolean): boolean {
  if (!held) {
    if (f.unread && !flag(r.unread)) return false;
    if (f.starred && !flag(r.starred)) return false;
    if (f.attachments && !flag(r.has_attachments)) return false;
  }
  if (!inSpan(f, String(r.last_activity ?? ""))) return false;
  if (f.person !== undefined || f.domain !== undefined) {
    const senders = String(r.sender_emails ?? "")
      .split(" ")
      .filter(Boolean);
    if (f.person !== undefined && !senders.includes(f.person)) return false;
    if (f.domain !== undefined && !senders.some((e) => domainOf(e) === f.domain)) return false;
  }
  return true;
}

/**
 * Whether a Thread passes the filter, for a seam with no Cache (the
 * fixtures): the flags, the dates, and a sender or domain among the
 * Thread's participants.
 */
export function filterKeepsThread(f: ResolvedFilter, t: Thread): boolean {
  if (f.unread && !t.unread) return false;
  if (f.starred && !t.starred) return false;
  if (f.attachments && !t.hasAttachments) return false;
  if (!inSpan(f, t.lastActivity)) return false;
  const people = t.participants.map((p) => p.email.trim().toLowerCase());
  if (f.person !== undefined && !people.includes(f.person)) return false;
  if (f.domain !== undefined && !people.some((e) => domainOf(e) === f.domain)) return false;
  return true;
}

/** "Needs a reply": the Thread's Section, or its arrival Judgment (slice 25). */
export function needsReply(
  thread: Thread,
  judgments?: Pick<ThreadJudgments, "needsReply"> | undefined,
): boolean {
  return (
    thread.section === "needs-reply" || (judgments?.needsReply ?? 0) >= DEFAULT_JUDGED_THRESHOLD
  );
}

/**
 * The facets over Threads a seam holds whole (the fixtures): years newest
 * first, people and domains most Threads first.
 */
export function facetsOf(
  kind: FacetKind,
  threads: readonly Thread[],
  options: { needle?: string | undefined; limit: number; owner?: string | undefined },
): Facet[] {
  const needle = (options.needle ?? "").trim().toLowerCase();
  const owner = (options.owner ?? "").trim().toLowerCase();
  const counts = new Map<string, { label: string; count: number }>();
  const bump = (key: string, label: string) => {
    const c = counts.get(key);
    if (c) c.count += 1;
    else counts.set(key, { label, count: 1 });
  };
  for (const t of threads) {
    if (kind === "year") {
      const d = new Date(t.lastActivity);
      if (!Number.isNaN(d.getTime())) bump(String(d.getFullYear()), String(d.getFullYear()));
      continue;
    }
    const seen = new Set<string>();
    for (const p of t.participants) {
      const email = p.email.trim().toLowerCase();
      const key = kind === "person" ? email : domainOf(email);
      if (!key || seen.has(key) || (kind === "person" && email === owner)) continue;
      const label = kind === "person" ? p.name || email : key;
      if (needle && !`${key} ${label}`.toLowerCase().includes(needle)) continue;
      seen.add(key);
      bump(key, label);
    }
  }
  const out = [...counts.entries()].map(([key, c]) => ({ key, label: c.label, count: c.count }));
  if (kind === "year") return out.sort((a, b) => b.key.localeCompare(a.key));
  return out
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, options.limit);
}

/* ------------------------------ Keys and search ------------------------------ */

/** The lists a filter narrows: the Inbox, a Mail folder, a Group lens. */
export type BaseListKey = Exclude<ThreadListKey, `filter:${string}`>;

/** The seam's key for a list narrowed by a filter; the same filter always gives the same key. */
export function filterListKey(base: BaseListKey, f: ResolvedFilter): ThreadListKey {
  const ordered: Record<string, unknown> = { b: base };
  for (const k of ["unread", "starred", "attachments", "from", "to", "person", "domain"] as const) {
    if (f[k] !== undefined) ordered[k] = f[k];
  }
  return `filter:${JSON.stringify(ordered)}`;
}

/** The base list and the filter a `filter:` key names, or null for any other key. */
export function parseFilterListKey(
  key: string,
): { base: BaseListKey; filter: ResolvedFilter } | null {
  if (!key.startsWith("filter:")) return null;
  try {
    const { b, ...rest } = JSON.parse(key.slice("filter:".length)) as {
      b: BaseListKey;
    } & ResolvedFilter;
    if (typeof b !== "string" || b.startsWith("filter:")) return null;
    return { base: b, filter: rest };
  } catch {
    return null;
  }
}

const day = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * The filter as the search's own operators (search/query.ts), so a search
 * typed under a filter answers from the Cache with both at once.
 */
export function filterSearchText(f: ResolvedFilter): string {
  const out: string[] = [];
  if (f.unread) out.push("is:unread");
  if (f.starred) out.push("is:starred");
  if (f.attachments) out.push("has:attachment");
  if (f.from !== undefined) out.push(`after:${day(f.from)}`);
  if (f.to !== undefined) out.push(`before:${day(f.to)}`);
  if (f.person !== undefined) out.push(`from:${f.person}`);
  if (f.domain !== undefined) out.push(`from:${f.domain}`);
  return out.join(" ");
}
