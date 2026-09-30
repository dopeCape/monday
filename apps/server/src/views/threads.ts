// The Threads a View reads on the Server (the test, the moves preview, the
// Signal request's scope check): each Thread's row, who started it, its
// recipients, its clear Facts and, when asked, its Signal answers, in the
// shape @monday/shared's View code reads. Newest first, bounded.
//
// A View's scope is applied here, in SQL, before the bound: "the newest 30
// Threads from these five senders in the last year" are the newest 30 of
// those senders across the whole mailbox, never the few of them that happen
// to be among the newest 200 of everything. Every exact fact of the scope
// (folder, dates, who started it, who it went to) reads the clear header
// projections (threads, messages.from/to/cc) through the expression
// indexes on the sender; the View code's scopeAdmits checks each row again.

import type { Id, SignalReadings, ViewScopeFacts, ViewThread } from "@monday/shared";
import { dateScopeStart } from "@monday/shared";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";

export interface ViewThreadQuery {
  workspaceId: Id;
  /** Only Threads active since this moment. */
  since?: Date | null | undefined;
  /** The owner's address, lowercased: the correspondent is the newest sender who is not the owner. */
  owner?: string | undefined;
  /** Only these Threads. */
  ids?: readonly Id[] | undefined;
  /** Only Threads the View's scope admits, decided in SQL (dates resolved against `now` in `zone`). */
  scope?: { facts: ViewScopeFacts; now: Date; zone: string } | undefined;
  /** Not these Threads (a revision keeps the ones it tried and fills the rest). */
  exclude?: readonly Id[] | undefined;
  limit: number;
}

/** Who started a Thread, lowercased: its first Message's sender. */
const FIRST_FROM = sql`(select lower(m."from"->>'email') from messages m where m.thread_id = t.id order by m.date asc, m.id asc limit 1)`;

const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v.toLowerCase()}`),
    sql`, `,
  );

/**
 * The scope's exact facts as SQL over `threads t`, the same test as the View
 * code's scopeAdmits. The sender tests are led by a semi-join the sender
 * indexes serve, so a narrow scope never walks the whole mailbox row by row.
 */
export function scopeConditions(
  workspaceId: Id,
  facts: ViewScopeFacts,
  now: Date,
  zone: string,
): SQL[] {
  const out: SQL[] = [];
  const folder = facts.folder ?? "inbox";
  if (folder === "inbox") out.push(sql`t.archived = false and t.snoozed_until is null`);
  else if (folder === "archive") out.push(sql`t.archived = true`);
  else if (folder.startsWith("group:")) {
    const g = folder.slice("group:".length);
    out.push(sql`(t.group_id = ${g} or t.subgroup_id = ${g})`);
  } else if (folder.startsWith("section:")) {
    out.push(
      sql`t.section = ${folder.slice("section:".length)} and t.archived = false and t.snoozed_until is null`,
    );
  }
  if (facts.received) {
    const start = dateScopeStart(facts.received, now, zone).toISOString();
    out.push(
      sql`coalesce((select min(m.date) from messages m where m.thread_id = t.id), t.last_activity) >= ${start}::timestamptz`,
    );
  }
  if (facts.active) {
    const start = dateScopeStart(facts.active, now, zone).toISOString();
    out.push(sql`t.last_activity >= ${start}::timestamptz`);
  }
  if (facts.from_any?.length) {
    out.push(sql`t.id in (select m.thread_id from messages m where m.workspace_id = ${workspaceId}
      and lower(m."from"->>'email') in (${list(facts.from_any)}))`);
    out.push(sql`${FIRST_FROM} in (${list(facts.from_any)})`);
  }
  if (facts.from_domain?.length) {
    out.push(sql`t.id in (select m.thread_id from messages m where m.workspace_id = ${workspaceId}
      and split_part(lower(m."from"->>'email'), '@', 2) in (${list(facts.from_domain)}))`);
    out.push(sql`split_part(coalesce(${FIRST_FROM}, ''), '@', 2) in (${list(facts.from_domain)})`);
  }
  if (facts.from_domain_not?.length) {
    out.push(
      sql`split_part(coalesce(${FIRST_FROM}, ''), '@', 2) not in (${list(facts.from_domain_not)})`,
    );
  }
  if (facts.to_any?.length) {
    out.push(sql`exists (select 1 from messages m, jsonb_array_elements(m."to" || m.cc) r
      where m.thread_id = t.id and lower(r->>'email') in (${list(facts.to_any)}))`);
  }
  if (facts.subject_any?.length) {
    // The clear subject prefix (ADR 0015), the same words scopeAdmits reads.
    out.push(
      sql`(${sql.join(
        facts.subject_any.map((w) => sql`position(${w.toLowerCase()} in t.subject_search) > 0`),
        sql` or `,
      )})`,
    );
  }
  return out;
}

/** The WHERE of a query: the Workspace, not deleted, and what the query narrows by. */
function whereOf(query: Omit<ViewThreadQuery, "limit">): SQL {
  const where = [sql`t.workspace_id = ${query.workspaceId}`, sql`t.deleted = false`];
  if (query.since) where.push(sql`t.last_activity >= ${query.since.toISOString()}::timestamptz`);
  if (query.ids)
    where.push(
      sql`t.id in (${sql.join(
        query.ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  if (query.exclude?.length)
    where.push(
      sql`t.id not in (${sql.join(
        query.exclude.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  if (query.scope) {
    where.push(
      ...scopeConditions(query.workspaceId, query.scope.facts, query.scope.now, query.scope.zone),
    );
  }
  return sql.join(where, sql` and `);
}

/** How many Threads a query holds (a View's scope: its real size, for the card and the limit). */
export async function countViewThreads(
  db: Db,
  query: Omit<ViewThreadQuery, "limit">,
  cap = 100_000,
): Promise<number> {
  const rows = (await db.execute(sql`
    select count(*)::int as n from (select 1 from threads t where ${whereOf(query)} limit ${cap}) x`)) as unknown as Array<{
    n: number;
  }>;
  return Number(rows[0]?.n ?? 0);
}

interface Row {
  id: string;
  message_count: number;
  last_activity: Date | string;
  received: Date | string | null;
  unread: boolean;
  starred: boolean;
  archived: boolean;
  deleted: boolean;
  snoozed: boolean;
  section: string | null;
  group_id: string | null;
  subgroup_id: string | null;
  has_attachments: boolean;
  first_from: string | null;
  recipients: string[] | null;
  facts: Record<string, unknown> | null;
  correspondent: { name?: string; email?: string } | null;
  subject_search: string | null;
}

const iso = (v: Date | string | null) =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/** The Threads, newest activity first, without their Signal answers (the caller adds those). */
export async function loadViewThreads(
  db: Db,
  query: ViewThreadQuery,
): Promise<Array<Omit<ViewThread, "readings"> & { readings: SignalReadings }>> {
  if (query.ids && query.ids.length === 0) return [];
  const rows = (await db.execute(sql`
    select t.id, t.message_count, t.last_activity, t.unread, t.starred, t.archived, t.deleted,
      (t.snoozed_until is not null) as snoozed, t.section, t.group_id, t.subgroup_id, t.has_attachments,
      (select min(m.date) from messages m where m.thread_id = t.id) as received,
      ${FIRST_FROM} as first_from, t.subject_search,
      (select coalesce(jsonb_agg(distinct lower(r->>'email')), '[]'::jsonb)
         from messages m, jsonb_array_elements(m."to" || m.cc) r where m.thread_id = t.id) as recipients,
      (select m."from" from messages m where m.thread_id = t.id and lower(m."from"->>'email') <> ${(query.owner ?? "").toLowerCase()} order by m.date desc, m.id desc limit 1) as correspondent,
      f.facts
    from threads t left join thread_facts f on f.thread_id = t.id
    where ${whereOf(query)}
    order by t.last_activity desc, t.id desc
    limit ${query.limit}`)) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id,
    messageCount: Number(r.message_count),
    lastActivity: iso(r.last_activity) ?? "",
    receivedAt: iso(r.received),
    unread: r.unread,
    starred: r.starred,
    archived: r.archived,
    deleted: r.deleted,
    snoozed: r.snoozed,
    group: r.group_id,
    subgroup: r.subgroup_id,
    section: r.section,
    hasAttachments: r.has_attachments,
    from: r.first_from,
    recipients: Array.isArray(r.recipients)
      ? r.recipients.filter((x) => typeof x === "string")
      : [],
    facts: r.facts ?? null,
    correspondent: r.correspondent?.email
      ? { name: r.correspondent.name ?? "", email: r.correspondent.email.toLowerCase() }
      : null,
    subjectSearch: r.subject_search ?? "",
    readings: {},
  }));
}
