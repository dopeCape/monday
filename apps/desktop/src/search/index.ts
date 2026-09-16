// Search over the Cache (ADR 0011): every keystroke is answered from the
// Workspace's SQLite FTS5 index and nothing on that path touches the network
// or a model. Results are Threads, not Messages: the best-ranked Message of a
// Thread carries the Thread, ranked by bm25 with subject weighted highest, a
// recency boost, and exact sender or subject matches pinned first.
//
// Two things reach outside the index, both explicit and both after the
// results are already on screen: "search older mail" pulls candidate bodies
// by date range into the Cache and re-runs the query as they land, and the
// "all accounts" toggle runs the same query across every Workspace Cache the
// module knows, labelling each hit with its account.

import type { Id, MessageBodiesPage, Person, Thread } from "@monday/shared";
import type { Row, SqlParam } from "../store/driver.ts";
import { rowToThread } from "../store/queries.ts";
import type { Store } from "../store/store.ts";
import {
  type CompiledQuery,
  compileQuery,
  isEmpty,
  parseQuery,
  type SearchQuery,
} from "./query.ts";

export interface SearchSource {
  store: Store;
  /** The account label results carry in the all-accounts view. */
  account: string;
}

export interface SearchHit {
  thread: Thread;
  workspaceId: Id;
  account: string;
  /** The matched passage from the best Message body, or the Thread snippet. */
  snippet: string;
  /** Higher is better; pinned hits sort above every unpinned one. */
  score: number;
  pinned: boolean;
}

/** The live filter chips over a result set. */
export interface SearchChips {
  unread?: boolean | undefined;
  attachments?: boolean | undefined;
  group?: boolean | undefined;
}

/** The "search older mail" offer: bodies the Cache lacks inside the asked range. */
export interface OlderMail {
  workspaceId: Id;
  missing: number;
  /** The gap: from the oldest missing body to just past the newest. */
  after: string | null;
  before: string | null;
}

export interface SearchResult {
  query: SearchQuery;
  hits: SearchHit[];
  /** One offer per Cache whose bodies are missing in range, when the query has body terms. */
  older: OlderMail[];
  elapsedMs: number;
}

export interface SearchOptions {
  workspace: Id | "all";
  chips?: SearchChips | undefined;
  limit?: number | undefined;
  now?: Date | undefined;
}

export interface SearchSettings {
  /** The bm25 weights: subject, sender, recipients, body. */
  weights: readonly [number, number, number, number];
  /** Days of activity that count as recent; the boost fades to nothing past it. */
  recencyDays: number;
  limit: number;
  recentMax: number;
  olderBatch: number;
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  weights: [8, 3, 2, 1],
  recencyDays: 30,
  limit: 50,
  recentMax: 10,
  olderBatch: 200,
};

export interface PullProgress {
  done: number;
  total: number;
}

export type FetchBodies = (
  workspaceId: Id,
  range: { after: string | null; before: string | null; limit: number },
) => Promise<MessageBodiesPage>;

export interface SearchModuleOptions {
  /** Every Workspace Cache the Store knows; the first is the current one. */
  sources: () => readonly SearchSource[];
  settings?: () => SearchSettings;
  /** The bulk body route; absent means "search older mail" is not offered. */
  fetchBodies?: FetchBodies | undefined;
  now?: () => Date;
}

export interface SearchModule {
  parse(text: string, now?: Date): SearchQuery;
  search(text: string | SearchQuery, options: SearchOptions): Promise<SearchResult>;
  /**
   * Fetches the bodies `older` names into the Cache, newest first, calling
   * `onBatch` after every batch lands so the caller can re-run the search.
   * Resolves with how many bodies landed; rejects on a locked Server.
   */
  pullOlder(older: OlderMail, onBatch?: (p: PullProgress) => void): Promise<number>;
  /** Recent searches of the current Workspace, newest first. */
  recent(): Promise<string[]>;
  remember(text: string): Promise<void>;
  /** Known people from the Cache's participants, most recent first, for autocomplete. */
  senders(): Promise<Person[]>;
}

const RECENT_KEY = "recent_searches";
/** The first bm25 cut is this many Messages per asked Thread, at least MIN_CUT. */
const CUT_PER_LIMIT = 4;
const MIN_CUT = 200;
/** A query with predicates starts wider, since they thin the cut after the fact. */
const FILTERED_MIN_CUT = 1_000;
/** A cut that left too few Threads widens by this factor, up to MAX_CUT. */
const WIDEN = 5;
const MAX_CUT = 5_000;

/* ------------------------------ SQL ------------------------------ */

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Negated terms exclude a Thread when any of its Messages matches; one MATCH per term. */
function excludeSql(compiled: CompiledQuery): string {
  return compiled.exclude
    .map(
      () =>
        "t.id not in (select x.thread_id from messages_fts join messages x on x.rid = messages_fts.rowid where messages_fts match ?)",
    )
    .join(" and ");
}

function predicates(compiled: CompiledQuery, extra: string[]): string {
  const where = ["t.deleted = 0", compiled.where, ...extra].filter((w) => w !== "").join(" and ");
  const excludes = excludeSql(compiled);
  return excludes ? `${where} and ${excludes}` : where;
}

/**
 * The bm25 pass: the best `cut` Messages by rank, then their Threads with the
 * predicates applied and the best Message per Thread kept. The FTS part is a
 * materialized CTE with its own LIMIT: bm25() only runs inside a plain query
 * over the index, and ranking every match of a common word is the whole cost,
 * so the cut happens before any join. The bare `rid` in the group follows
 * SQLite's min() rule and names the best Message.
 */
function ftsSql(compiled: CompiledQuery, extra: string[]): string {
  return `
    with f as materialized (
      select rowid as rid, bm25(messages_fts, ?, ?, ?, ?) as rank
      from messages_fts where messages_fts match ?
      order by rank limit ?
    ),
    h as (
      select m.thread_id as tid, min(f.rank) as rank, f.rid as rid
      from f join messages m on m.rid = f.rid
      group by m.thread_id
    )
    select h.tid as id, h.rank as rank, h.rid as rid, t.last_activity as last_activity
    from h join threads t on t.id = h.tid
    where ${predicates(compiled, extra)}
    order by h.rank, t.last_activity desc`;
}

/** snippet() over the best Messages of the hits, for a term rare enough to afford it. */
function snippetSql(n: number): string {
  return `
    select rowid as rid, snippet(messages_fts, 3, '', '', '…', 12) as snip
    from messages_fts
    where messages_fts match ? and rowid in (${marks(n)})`;
}

/** The body text of the best Messages, for the excerpt a common term gets instead. */
function bodiesSql(n: number): string {
  return `select rid, substr(body_text, 1, 4000) as body from messages where rid in (${marks(n)})`;
}

/** Substring hits over subject and addresses, newest first; no bm25, a flat score. */
function trigramSql(compiled: CompiledQuery, extra: string[]): string {
  return `
    select t.id as id, t.last_activity as last_activity
    from threads_trgm join threads t on t.rid = threads_trgm.rowid
    where threads_trgm match ? and ${predicates(compiled, extra)}
    order by t.last_activity desc
    limit ?`;
}

/** A pure filter (is:unread, in:hiring ...) with no text: newest first. */
function filterSql(compiled: CompiledQuery, extra: string[]): string {
  return `
    select t.id as id, t.last_activity as last_activity
    from threads t
    where ${predicates(compiled, extra)}
    order by t.last_activity desc, t.rid desc
    limit ?`;
}

const threadsByIdsSql = (n: number) => `
  select t.*,
    (select group_concat(tag_id) from (select tag_id from thread_tags where thread_id = t.id order by rowid)) as tag_ids,
    (select group_concat(label_id) from (select label_id from thread_labels where thread_id = t.id order by rowid)) as label_ids
  from threads t where t.id in (${marks(n)})`;

function chipPredicates(chips: SearchChips | undefined): string[] {
  const out: string[] = [];
  if (chips?.unread) out.push("t.unread = 1");
  if (chips?.attachments) out.push("t.has_attachments = 1");
  if (chips?.group) out.push("t.group_id is not null");
  return out;
}

/* ------------------------------ Previews ------------------------------ */

/**
 * A passage of `width` words around the first term that occurs in `body`:
 * the preview a term gets when it is so common that snippet() over its
 * matches would not fit the budget. Terms are matched by prefix.
 */
export function excerpt(body: string, terms: readonly string[], width = 12): string {
  const tokens = body.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return "";
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t !== "");
  let at = -1;
  for (let i = 0; i < tokens.length && at === -1; i++) {
    const token = (tokens[i] as string)
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (needles.some((n) => token.startsWith(n))) at = i;
  }
  const start = Math.max(0, at === -1 ? 0 : at - Math.floor(width / 3));
  const slice = tokens.slice(start, start + width);
  return `${start > 0 ? "…" : ""}${slice.join(" ")}${start + width < tokens.length ? "…" : ""}`;
}

/** The query's positive text tokens, for the excerpt. */
function queryTerms(q: SearchQuery): string[] {
  return [
    ...q.words.filter((w) => !w.negated),
    ...q.phrases.filter((p) => !p.negated),
    ...q.subject.filter((c) => !c.negated),
  ].flatMap((c) => c.text.split(/[^\p{L}\p{N}]+/u).filter((t) => t !== ""));
}

/* ------------------------------ Ranking ------------------------------ */

interface Candidate {
  id: string;
  /** bm25 rank: negative, more negative is better; null for trigram and filter hits. */
  rank: number | null;
  /** The best Message's rowid, for its preview. */
  rid: number | null;
  lastActivity: string;
}

const DAY_MS = 86_400_000;

/** How much of the recency boost a Thread earns: 1 today, fading to 0 at `recencyDays`. */
export function recencyWeight(lastActivity: string, now: Date, recencyDays: number): number {
  const age = (now.getTime() - Date.parse(lastActivity)) / DAY_MS;
  if (!Number.isFinite(age) || age <= 0) return 1;
  if (age >= recencyDays) return 0;
  return 1 - age / recencyDays;
}

/** The exact-match texts a query carries: from: values and the bare text as one subject. */
function exactTargets(q: SearchQuery): { senders: string[]; subject: string | null } {
  const senders = q.from.filter((c) => !c.negated).map((c) => c.text.trim().toLowerCase());
  for (const w of q.words)
    if (!w.negated && w.text.includes("@")) senders.push(w.text.toLowerCase());
  const bare = [...q.words.filter((w) => !w.negated), ...q.phrases.filter((p) => !p.negated)]
    .map((c) => c.text.trim().toLowerCase())
    .join(" ")
    .replace(/\s+/g, " ");
  return { senders, subject: bare === "" ? null : bare };
}

/** True when the Thread's sender or subject equals what was typed. */
export function isPinned(thread: Thread, q: SearchQuery): boolean {
  const { senders, subject } = exactTargets(q);
  const first = thread.participants[0];
  for (const s of senders) {
    for (const p of thread.participants) {
      if (p.email.toLowerCase() === s || p.name.trim().toLowerCase() === s) return true;
    }
  }
  if (subject !== null) {
    if (thread.subject.trim().toLowerCase().replace(/\s+/g, " ") === subject) return true;
    if (first && (first.email.toLowerCase() === subject || first.name.toLowerCase() === subject)) {
      return true;
    }
  }
  return false;
}

/**
 * Scores one Cache's candidates: bm25 normalised into [0, 1] over the set,
 * trigram-only hits at a flat 0.3, then multiplied by one plus the recency
 * weight so today's mail ranks above last month's for the same match. Pinned
 * hits are marked; the caller sorts them first.
 */
export function scoreCandidates(
  candidates: readonly Candidate[],
  threads: ReadonlyMap<string, Thread>,
  previews: ReadonlyMap<number, string>,
  q: SearchQuery,
  now: Date,
  recencyDays: number,
  account: string,
  workspaceId: Id,
): SearchHit[] {
  let worst = 0;
  for (const c of candidates) if (c.rank !== null && c.rank < worst) worst = c.rank;
  const out: SearchHit[] = [];
  for (const c of candidates) {
    const thread = threads.get(c.id);
    if (!thread) continue;
    const base = c.rank === null ? 0.3 : worst === 0 ? 1 : c.rank / worst;
    const score = base * (1 + recencyWeight(thread.lastActivity, now, recencyDays));
    const preview = c.rid === null ? "" : (previews.get(c.rid) ?? "");
    out.push({
      thread,
      workspaceId,
      account,
      snippet: preview.trim() !== "" ? preview : thread.snippet,
      score,
      pinned: isPinned(thread, q),
    });
  }
  return out;
}

export function sortHits(hits: SearchHit[]): SearchHit[] {
  return hits.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return b.thread.lastActivity.localeCompare(a.thread.lastActivity);
    if (b.score !== a.score) return b.score - a.score;
    return b.thread.lastActivity.localeCompare(a.thread.lastActivity);
  });
}

/* ------------------------------ The module ------------------------------ */

export function createSearch(options: SearchModuleOptions): SearchModule {
  const settings = options.settings ?? (() => DEFAULT_SEARCH_SETTINGS);
  const now = options.now ?? (() => new Date());

  const current = (): SearchSource => {
    const first = options.sources()[0];
    if (!first) throw new Error("search has no Workspace Cache");
    return first;
  };

  /** The bm25 candidates of one Cache; widens the cut while it leaves too few Threads. */
  const ftsCandidates = async (
    store: Store,
    compiled: CompiledQuery,
    extra: string[],
    match: string,
    limit: number,
  ): Promise<{ rows: Candidate[]; rare: boolean }> => {
    const s = settings();
    const filtered = compiled.where !== "" || compiled.exclude.length > 0 || extra.length > 0;
    let cut = Math.max(filtered ? FILTERED_MIN_CUT : MIN_CUT, limit * CUT_PER_LIMIT);
    for (;;) {
      const rows = await store.query<Row>(ftsSql(compiled, extra), [
        ...s.weights,
        match,
        cut,
        ...compiled.params,
        ...compiled.exclude,
      ]);
      const out: Candidate[] = rows.map((r) => ({
        id: String(r.id),
        rank: Number(r.rank),
        rid: Number(r.rid),
        lastActivity: String(r.last_activity),
      }));
      // A cut is worth widening only when it was full: fewer matches than the
      // cut means every one is already in hand. The count comes straight from
      // the index, which is cheap next to ranking.
      if (out.length >= limit || cut >= MAX_CUT) return { rows: out, rare: false };
      const [count] = await store.query<{ n: number }>(
        "select count(*) as n from messages_fts where messages_fts match ?",
        [match],
      );
      const matches = Number(count?.n ?? 0);
      if (matches <= cut) return { rows: out, rare: matches <= MIN_CUT };
      cut = Math.min(MAX_CUT, cut * WIDEN);
    }
  };

  /** Previews for the best Messages: snippet() when the term is rare, an excerpt otherwise. */
  const previewsFor = async (
    store: Store,
    candidates: readonly Candidate[],
    match: string | null,
    rare: boolean,
    q: SearchQuery,
    limit: number,
  ): Promise<Map<number, string>> => {
    const out = new Map<number, string>();
    const rids = candidates.slice(0, limit).flatMap((c) => (c.rid === null ? [] : [c.rid]));
    if (rids.length === 0) return out;
    if (match !== null && rare) {
      const rows = await store.query<Row>(snippetSql(rids.length), [match, ...rids]);
      for (const r of rows) out.set(Number(r.rid), typeof r.snip === "string" ? r.snip : "");
      return out;
    }
    const terms = queryTerms(q);
    const rows = await store.query<Row>(bodiesSql(rids.length), rids);
    for (const r of rows) {
      const body = typeof r.body === "string" ? r.body : "";
      out.set(Number(r.rid), excerpt(body, terms));
    }
    return out;
  };

  const searchOne = async (
    source: SearchSource,
    q: SearchQuery,
    compiled: CompiledQuery,
    opts: SearchOptions,
    clock: Date,
  ): Promise<{ hits: SearchHit[]; older: OlderMail | null }> => {
    const { store, account } = source;
    const s = settings();
    const limit = opts.limit ?? s.limit;
    const extra = chipPredicates(opts.chips);
    const byId = new Map<string, Candidate>();
    const add = (c: Candidate) => {
      const had = byId.get(c.id);
      if (!had || (had.rank === null && c.rank !== null)) byId.set(c.id, c);
    };
    let rare = false;

    if (compiled.match !== null) {
      const found = await ftsCandidates(store, compiled, extra, compiled.match, limit);
      rare = found.rare;
      for (const c of found.rows) add(c);
      if (compiled.trigram !== null) {
        const rows = await store.query<Row>(trigramSql(compiled, extra), [
          compiled.trigram,
          ...compiled.params,
          ...compiled.exclude,
          Math.max(MIN_CUT, limit * CUT_PER_LIMIT),
        ]);
        for (const r of rows) {
          add({ id: String(r.id), rank: null, rid: null, lastActivity: String(r.last_activity) });
        }
      }
    } else {
      const rows = await store.query<Row>(filterSql(compiled, extra), [
        ...compiled.params,
        ...compiled.exclude,
        Math.max(MIN_CUT, limit * CUT_PER_LIMIT),
      ]);
      for (const r of rows) {
        add({ id: String(r.id), rank: null, rid: null, lastActivity: String(r.last_activity) });
      }
    }

    const candidates = [...byId.values()];
    const threads = new Map<string, Thread>();
    if (candidates.length > 0) {
      const ids = candidates.map((c) => c.id);
      const rows = await store.query<Row>(threadsByIdsSql(ids.length), ids as SqlParam[]);
      for (const r of rows) {
        const t = rowToThread(r, store.workspaceId);
        threads.set(t.id, t);
      }
    }
    const previews = await previewsFor(store, candidates, compiled.match, rare, q, limit);
    let hits = scoreCandidates(
      candidates,
      threads,
      previews,
      q,
      clock,
      s.recencyDays,
      account,
      store.workspaceId,
    );
    if (compiled.match === null) {
      // A pure filter is a list, not a ranking: newest first, nothing pinned.
      hits = hits.map((h) => ({ ...h, pinned: false, score: 0 }));
    }

    let older: OlderMail | null = null;
    if (compiled.bodyTerms && options.fetchBodies) {
      const where = ["body_text is null"];
      const params: SqlParam[] = [];
      if (q.after !== null) {
        where.push("date >= ?");
        params.push(q.after);
      }
      if (q.before !== null) {
        where.push("date < ?");
        params.push(q.before);
      }
      const [row] = await store.query<{ n: number; lo: string | null; hi: string | null }>(
        `select count(*) as n, min(date) as lo, max(date) as hi from messages where ${where.join(" and ")}`,
        params,
      );
      const missing = Number(row?.n ?? 0);
      if (missing > 0 && row?.lo && row.hi) {
        const past = new Date(Date.parse(row.hi) + 1);
        older = {
          workspaceId: store.workspaceId,
          missing,
          after: row.lo,
          before: Number.isNaN(past.getTime()) ? q.before : past.toISOString(),
        };
      }
    }
    return { hits, older };
  };

  const module: SearchModule = {
    parse: (text, clock) => parseQuery(text, { now: clock ?? now() }),

    async search(input, opts) {
      const started = performance.now();
      const clock = opts.now ?? now();
      const q = typeof input === "string" ? parseQuery(input, { now: clock }) : input;
      const compiled = compileQuery(q);
      const limit = opts.limit ?? settings().limit;
      const sources =
        opts.workspace === "all"
          ? options.sources()
          : options.sources().filter((s) => s.store.workspaceId === opts.workspace);
      const chipped = Boolean(opts.chips?.unread || opts.chips?.attachments || opts.chips?.group);
      if (isEmpty(q) && !chipped) {
        return { query: q, hits: [], older: [], elapsedMs: performance.now() - started };
      }
      const results = await Promise.all(
        sources.map((source) => searchOne(source, q, compiled, opts, clock)),
      );
      const hits = sortHits(results.flatMap((r) => r.hits)).slice(0, limit);
      const older = results.flatMap((r) => (r.older ? [r.older] : []));
      return { query: q, hits, older, elapsedMs: performance.now() - started };
    },

    async pullOlder(older, onBatch) {
      const fetchBodies = options.fetchBodies;
      if (!fetchBodies) return 0;
      const source = options.sources().find((s) => s.store.workspaceId === older.workspaceId);
      if (!source) return 0;
      const batch = settings().olderBatch;
      let before = older.before;
      let landed = 0;
      let total = older.missing;
      for (;;) {
        const page = await fetchBodies(older.workspaceId, {
          after: older.after,
          before,
          limit: batch,
        });
        total = Math.max(total, page.total);
        landed += await source.store.applyBodies(page.bodies);
        onBatch?.({ done: Math.min(landed, total), total });
        if (page.cursor === null || page.bodies.length === 0) break;
        before = page.cursor;
      }
      return landed;
    },

    async recent() {
      const { store } = current();
      const rows = await store.query<{ value: string }>("select value from meta where key = ?", [
        RECENT_KEY,
      ]);
      try {
        const parsed = JSON.parse(rows[0]?.value ?? "[]") as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((x): x is string => typeof x === "string")
          : [];
      } catch {
        return [];
      }
    },

    async remember(text) {
      const trimmed = text.trim();
      if (trimmed === "") return;
      const { store } = current();
      const max = settings().recentMax;
      const list = [trimmed, ...(await module.recent()).filter((t) => t !== trimmed)].slice(0, max);
      await store.write([
        {
          sql: "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
          params: [RECENT_KEY, JSON.stringify(list)],
        },
      ]);
    },

    async senders() {
      const { store } = current();
      const rows = await store.query<{ participants: string }>(
        "select participants from threads where deleted = 0 order by last_activity desc limit 500",
      );
      const seen = new Set<string>();
      const out: Person[] = [];
      for (const r of rows) {
        let people: Person[] = [];
        try {
          people = JSON.parse(r.participants) as Person[];
        } catch {
          continue;
        }
        for (const p of people) {
          const key = p.email.toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push({ name: p.name, email: p.email });
        }
      }
      return out;
    },
  };
  return module;
}
