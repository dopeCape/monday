// The Cache's Views (docs/spec/views.md, "Data and sync"): `views` mirrors
// each View's current document, its place in the nav, the user's placements
// and checklist marks. The feed's `view` rows carry headers only (the
// documents are sealed on the Server) and mark a row's content stale; the
// Views module reads GET /views and writes the rows whole (views/cache.ts).
// `view_values` mirrors the values the Views' Extractions picked (sealed on
// the Server, read through the Views routes); a `view_values` feed row marks
// its Thread stale until they are read again. A View's Blocks are computed
// on the Device from thread_signals, thread_facts and view_values in SQLite
// (viewThreadsSql), so opening a View never waits on the network (ADR 0011)
// and works offline with the answers already there. A View whose scope is a
// full search reads its members from `view_members` (ids the Server found by
// reading the mail, from the feed's `view_members` rows and GET
// /views/:id/members), so its query works offline too.

import type {
  ExtractedValue,
  Id,
  Thread,
  View,
  ViewChange,
  ViewDoc,
  ViewDone,
  ViewMembersChange,
  ViewPlacement,
  ViewReadingChange,
  ViewScopeFacts,
  ViewThread,
} from "@monday/shared";
import { normalizeView } from "@monday/shared";
import type { Row, SqlParam, Statement } from "./driver.ts";
import { ALL_THREADS_SQL, rowSignals, rowToThread } from "./queries.ts";

export const VIEWS_SCHEMA_SQL = `
  create table if not exists views (
    id text primary key,
    version integer not null default 0,
    pinned integer not null default 1,
    position integer not null default 0,
    deleted integer not null default 0,
    check_bar integer not null default 0,
    doc text,
    placements text not null default '{}',
    done text not null default '{}',
    updated_at text not null default '',
    content_stale integer not null default 1
  );
  create table if not exists view_values (
    thread_id text not null,
    signal_id text not null,
    text text not null,
    value text not null,
    confidence real not null,
    items text,
    primary key (thread_id, signal_id)
  );
  create table if not exists view_values_stale (
    thread_id text primary key
  );
  create table if not exists view_members (
    view_id text not null,
    thread_id text not null,
    primary key (view_id, thread_id)
  );
  create table if not exists view_reading (
    view_id text primary key,
    status text not null,
    reason text,
    done integer not null default 0,
    total integer not null default 0,
    phase text,
    found integer
  );
`;

/** How far a pinned View has read its scope, from the feed (counts only). */
export function viewReadingUpsert(r: ViewReadingChange): Statement {
  return {
    sql: `insert into view_reading (view_id, status, reason, done, total, phase, found) values (?, ?, ?, ?, ?, ?, ?)
          on conflict (view_id) do update set status = excluded.status, reason = excluded.reason,
            done = excluded.done, total = excluded.total, phase = excluded.phase, found = excluded.found`,
    params: [r.viewId, r.status, r.reason, r.done, r.total, r.phase ?? null, r.found ?? null],
  };
}

/** Who joined or left a search scope's View, from the feed (ids only); `reset` empties it first. */
export function viewMembersStatements(c: ViewMembersChange): Statement[] {
  const out: Statement[] = [];
  if (c.reset) out.push({ sql: "delete from view_members where view_id = ?", params: [c.viewId] });
  for (const id of c.removed)
    out.push({
      sql: "delete from view_members where view_id = ? and thread_id = ?",
      params: [c.viewId, id],
    });
  for (const id of c.added)
    out.push({
      sql: "insert or ignore into view_members (view_id, thread_id) values (?, ?)",
      params: [c.viewId, id],
    });
  return out;
}

/** One View's reading, as its bar shows it. */
export const VIEW_READING_SQL = "select * from view_reading where view_id = ?";

export function rowToViewReading(r: Row): ViewReadingChange {
  return {
    viewId: String(r.view_id),
    status: String(r.status) as ViewReadingChange["status"],
    reason: (r.reason ?? null) as ViewReadingChange["reason"],
    done: Number(r.done ?? 0),
    total: Number(r.total ?? 0),
    ...(r.phase === "search" || r.phase === "read"
      ? { phase: r.phase, found: Number(r.found ?? 0) }
      : {}),
  };
}

/** The Views the nav and the screens read: not deleted, content read, in nav order. */
export const VIEWS_SQL =
  "select * from views where deleted = 0 and doc is not null order by position, id";

/** A View's headers from the feed: a newer row marks the content stale until GET /views is read. */
export function viewUpsert(b: ViewChange): Statement {
  return {
    sql: `insert into views (id, version, pinned, position, deleted, updated_at, content_stale)
          values (?, ?, ?, ?, ?, ?, 1)
          on conflict (id) do update set
            version = excluded.version, pinned = excluded.pinned, position = excluded.position,
            deleted = excluded.deleted,
            content_stale = case when excluded.updated_at > views.updated_at then 1 else views.content_stale end,
            updated_at = max(views.updated_at, excluded.updated_at)`,
    params: [b.id, b.version, b.pinned ? 1 : 0, b.position, b.deleted ? 1 : 0, b.updatedAt],
  };
}

/** A Thread whose picked values changed: they are read again through the Views routes. */
export function viewValuesStale(threadId: Id): Statement {
  return {
    sql: "insert or ignore into view_values_stale (thread_id) values (?)",
    params: [threadId],
  };
}

/** The Threads whose values are to be read again, at most `limit`. */
export const VIEW_VALUES_STALE_SQL = "select thread_id from view_values_stale limit ?";

/**
 * The Cache after reading picked values: each Thread's rows written whole
 * (a value no longer picked goes), and the Threads no longer stale.
 * `threadIds` names every Thread the read covered, with values or not.
 */
export function viewValuesStatements(
  values: Readonly<Record<Id, Readonly<Record<string, ExtractedValue>>>>,
  threadIds: readonly Id[],
  signalIds?: readonly string[],
): Statement[] {
  const out: Statement[] = [];
  for (const threadId of threadIds) {
    out.push(
      signalIds?.length
        ? {
            sql: `delete from view_values where thread_id = ? and signal_id in (${signalIds.map(() => "?").join(", ")})`,
            params: [threadId, ...signalIds],
          }
        : { sql: "delete from view_values where thread_id = ?", params: [threadId] },
    );
    for (const [signalId, v] of Object.entries(values[threadId] ?? {})) {
      // Many values, one per Message, or a per-row Signal's answers ride in `items`.
      const extra =
        v.items || v.answers
          ? JSON.stringify({
              ...(v.items ? { items: v.items } : {}),
              ...(v.answers ? { answers: v.answers } : {}),
            })
          : null;
      out.push({
        sql: `insert into view_values (thread_id, signal_id, text, value, confidence, items) values (?, ?, ?, ?, ?, ?)
              on conflict (thread_id, signal_id) do update set
                text = excluded.text, value = excluded.value, confidence = excluded.confidence,
                items = excluded.items`,
        params: [threadId, signalId, v.text, JSON.stringify(v.value), v.confidence, extra],
      });
    }
    out.push({ sql: "delete from view_values_stale where thread_id = ?", params: [threadId] });
  }
  return out;
}

/** The Cache after a full read of the Server's list: every View written whole, the rest marked deleted. */
export function viewStatements(views: readonly View[]): Statement[] {
  const out: Statement[] = views.map((b) => ({
    sql: `insert into views (id, version, pinned, position, deleted, check_bar, doc, placements, done, updated_at, content_stale)
          values (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0)
          on conflict (id) do update set version = excluded.version, pinned = excluded.pinned,
            position = excluded.position, deleted = 0, check_bar = excluded.check_bar, doc = excluded.doc,
            placements = excluded.placements, done = excluded.done, updated_at = excluded.updated_at,
            content_stale = 0`,
    params: [
      b.id,
      b.version,
      b.pinned ? 1 : 0,
      b.position,
      b.checkBar ? 1 : 0,
      JSON.stringify(b.doc),
      JSON.stringify(b.placements),
      JSON.stringify(b.done ?? {}),
      b.updatedAt,
    ],
  }));
  const ids = views.map((b) => b.id);
  out.push(
    ids.length === 0
      ? { sql: "update views set deleted = 1, content_stale = 0", params: [] }
      : {
          sql: `update views set deleted = 1, content_stale = 0 where id not in (${ids.map(() => "?").join(", ")})`,
          params: ids,
        },
  );
  return out;
}

const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

/** A View row as the screens read it; null when its content was never read. */
export function rowToView(r: Row, workspaceId: Id): View | null {
  const raw = json<unknown>(r.doc, null);
  if (!raw) return null;
  // A document cached before Views (a Board's) reads as a View with one Block.
  const doc: ViewDoc = normalizeView(raw);
  return {
    id: String(r.id),
    workspaceId,
    version: Number(r.version ?? doc.version),
    pinned: r.pinned === 1,
    position: Number(r.position ?? 0),
    deletedAt: r.deleted === 1 ? String(r.updated_at ?? "") : null,
    createdAt: "",
    updatedAt: String(r.updated_at ?? ""),
    doc,
    placements: json<Record<Id, ViewPlacement>>(r.placements, {}),
    checkBar: r.check_bar === 1,
    done: json<Record<Id, ViewDone>>(r.done, {}),
  };
}

/** A Thread on a View: what the View code reads and the Thread the row renders. */
export type CachedViewThread = ViewThread & { thread: Thread };

/**
 * The Threads a View looks at, newest first, as one query over the Cache:
 * each Thread row with its Signal answers (`j_signals`), its clear Facts,
 * who started it, its correspondent, every address it was sent to and the
 * values the Views picked. SQL narrows by the scope's folder, date, senders
 * and recipients before the limit; the View code checks the scope again
 * exactly and decides the Lanes and every Block over these rows.
 */
export function viewThreadsSql(
  facts: ViewScopeFacts,
  since: Date | null,
  limit: number,
  owner = "",
  viewId?: string,
): { sql: string; params: SqlParam[] } {
  const where: string[] = ["t.deleted = 0"];
  const params: SqlParam[] = [owner.toLowerCase()];
  if (facts.query) {
    // A search scope: its members, found on the Server and mirrored here, stand in for the
    // search; a View whose members have not reached this Cache shows none yet.
    where.push(
      "exists (select 1 from view_members vm where vm.view_id = ? and vm.thread_id = t.id)",
    );
    params.push(viewId ?? "");
  }
  const folder = facts.folder ?? "inbox";
  if (folder === "inbox") where.push("t.archived = 0 and t.snoozed_until is null");
  else if (folder === "archive") where.push("t.archived = 1");
  else if (folder.startsWith("group:")) {
    where.push("(t.group_id = ? or t.subgroup_id = ?)");
    const g = folder.slice("group:".length);
    params.push(g, g);
  } else if (folder.startsWith("section:")) {
    where.push("t.section = ? and t.archived = 0 and t.snoozed_until is null");
    params.push(folder.slice("section:".length));
  }
  if (since) {
    where.push("t.last_activity >= ?");
    // A bound only: the View's own scope test is exact. Rounded down to the UTC day so
    // the nav count and the open View ask the same query and share its rows.
    params.push(new Date(Math.floor(since.getTime() / 86_400_000) * 86_400_000).toISOString());
  }
  // Who started it and who it went to narrow in SQL too, so the limit counts only Threads in
  // scope: a View of five senders over a year shows their newest Threads, not the few of
  // them among the newest of everything.
  const firstFrom =
    "(select lower(json_extract(m.sender, '$.email')) from messages m where m.thread_id = t.id order by m.date asc, m.id asc limit 1)";
  const marks = (list: readonly string[]) => list.map(() => "?").join(", ");
  const lower = (list: readonly string[]) => list.map((x) => x.toLowerCase());
  const domainOf = `substr(coalesce(${firstFrom}, ''), instr(coalesce(${firstFrom}, ''), '@') + 1)`;
  if (facts.from_any?.length) {
    where.push(`${firstFrom} in (${marks(facts.from_any)})`);
    params.push(...lower(facts.from_any));
  }
  if (facts.from_domain?.length) {
    where.push(
      `instr(coalesce(${firstFrom}, ''), '@') > 0 and ${domainOf} in (${marks(facts.from_domain)})`,
    );
    params.push(...lower(facts.from_domain));
  }
  if (facts.from_domain_not?.length) {
    where.push(
      `(instr(coalesce(${firstFrom}, ''), '@') = 0 or ${domainOf} not in (${marks(facts.from_domain_not)}))`,
    );
    params.push(...lower(facts.from_domain_not));
  }
  if (facts.to_any?.length) {
    where.push(`(exists (select 1 from messages m, json_each(m.recipients) r where m.thread_id = t.id
        and lower(json_extract(r.value, '$.email')) in (${marks(facts.to_any)}))
      or exists (select 1 from messages m, json_each(m.cc) r where m.thread_id = t.id
        and lower(json_extract(r.value, '$.email')) in (${marks(facts.to_any)})))`);
    params.push(...lower(facts.to_any), ...lower(facts.to_any));
  }
  if (facts.subject_any?.length) {
    // A bound: the View code reads the subject's first 80 characters, whitespace collapsed.
    where.push(`(${facts.subject_any.map(() => "instr(lower(t.subject), ?) > 0").join(" or ")})`);
    params.push(...lower(facts.subject_any));
  }
  const at = ALL_THREADS_SQL.lastIndexOf("order by");
  const sql = `select * from (${ALL_THREADS_SQL.slice(0, at).replace(
    "select ",
    `select
    (select json_extract(m.sender, '$.email') from messages m where m.thread_id = t.id order by m.date asc, m.id asc limit 1) as first_from,
    (select m.sender from messages m where m.thread_id = t.id
       and lower(json_extract(m.sender, '$.email')) <> ?1 order by m.date desc, m.id desc limit 1) as correspondent,
    (select min(m.date) from messages m where m.thread_id = t.id) as received,
    (select group_concat(lower(json_extract(r.value, '$.email')), ' ')
       from messages m, json_each(m.recipients) r where m.thread_id = t.id) as to_emails,
    (select group_concat(lower(json_extract(r.value, '$.email')), ' ')
       from messages m, json_each(m.cc) r where m.thread_id = t.id) as cc_emails,
    (select json_group_object(v.signal_id, json_object('text', v.text, 'value', json(v.value), 'confidence', v.confidence,
         'items', json_extract(coalesce(v.items, '{}'), '$.items'), 'answers', json_extract(coalesce(v.items, '{}'), '$.answers')))
       from view_values v where v.thread_id = t.id) as v_values,
    f.facts as f_facts,
    `,
  )} left join thread_facts f on f.thread_id = t.id where ${where.join(" and ")} ${ALL_THREADS_SQL.slice(at)} limit ${Math.max(1, Math.floor(limit))})`;
  return { sql, params };
}

/** The picked values as the View code reads them: no `items` or `answers` where there are none. */
function valuesOf(raw: Record<string, ExtractedValue>): Record<string, ExtractedValue> {
  const out: Record<string, ExtractedValue> = {};
  for (const [id, v] of Object.entries(raw)) {
    const { items, answers, ...rest } = v;
    out[id] = {
      ...rest,
      ...(Array.isArray(items) ? { items } : {}),
      ...(answers && typeof answers === "object" ? { answers } : {}),
    };
  }
  return out;
}

/** One row of viewThreadsSql as the View code and the row read it. */
export function rowToViewThread(r: Row, workspaceId: Id): CachedViewThread {
  const thread = rowToThread(r, workspaceId);
  const words = (v: unknown) =>
    typeof v === "string" && v !== "" ? v.split(" ").filter(Boolean) : [];
  const who = json<{ name?: string; email?: string } | null>(r.correspondent, null);
  return {
    id: thread.id,
    messageCount: thread.messageCount,
    lastActivity: thread.lastActivity,
    receivedAt: typeof r.received === "string" ? r.received : null,
    unread: thread.unread,
    starred: thread.starred,
    archived: thread.archived,
    deleted: r.deleted === 1,
    snoozed: thread.snoozedUntil !== null,
    group: thread.group,
    subgroup: thread.subgroup,
    section: thread.section,
    hasAttachments: thread.hasAttachments,
    from: typeof r.first_from === "string" ? r.first_from.toLowerCase() : null,
    recipients: [...words(r.to_emails), ...words(r.cc_emails)],
    facts: json<Record<string, unknown> | null>(r.f_facts, null),
    readings: rowSignals(r),
    values: valuesOf(json<Record<string, ExtractedValue>>(r.v_values, {})),
    subject: thread.subject,
    snippet: thread.snippet,
    correspondent: who?.email ? { name: who.name ?? "", email: who.email.toLowerCase() } : null,
    thread,
  };
}
