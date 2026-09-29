// The Threads a View reads on the Server (the test, the moves preview, the
// Signal request's scope check): each Thread's row, who started it, its
// recipients, its clear Facts and, when asked, its Signal answers, in the
// shape @monday/shared's View code reads. Newest first, bounded.

import type { Id, SignalReadings, ViewThread } from "@monday/shared";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";

export interface ViewThreadQuery {
  workspaceId: Id;
  /** Only Threads active since this moment. */
  since?: Date | null | undefined;
  /** The owner's address, lowercased: the correspondent is the newest sender who is not the owner. */
  owner?: string | undefined;
  /** Only these Threads. */
  ids?: readonly Id[] | undefined;
  limit: number;
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
}

const iso = (v: Date | string | null) =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/** The Threads, newest activity first, without their Signal answers (the caller adds those). */
export async function loadViewThreads(
  db: Db,
  query: ViewThreadQuery,
): Promise<Array<Omit<ViewThread, "readings"> & { readings: SignalReadings }>> {
  if (query.ids && query.ids.length === 0) return [];
  const where = [sql`t.workspace_id = ${query.workspaceId}`, sql`t.deleted = false`];
  if (query.since) where.push(sql`t.last_activity >= ${query.since.toISOString()}::timestamptz`);
  if (query.ids)
    where.push(
      sql`t.id in (${sql.join(
        query.ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  const rows = (await db.execute(sql`
    select t.id, t.message_count, t.last_activity, t.unread, t.starred, t.archived, t.deleted,
      (t.snoozed_until is not null) as snoozed, t.section, t.group_id, t.subgroup_id, t.has_attachments,
      (select min(m.date) from messages m where m.thread_id = t.id) as received,
      (select lower(m."from"->>'email') from messages m where m.thread_id = t.id order by m.date asc, m.id asc limit 1) as first_from,
      (select coalesce(jsonb_agg(distinct lower(r->>'email')), '[]'::jsonb)
         from messages m, jsonb_array_elements(m."to" || m.cc) r where m.thread_id = t.id) as recipients,
      (select m."from" from messages m where m.thread_id = t.id and lower(m."from"->>'email') <> ${(query.owner ?? "").toLowerCase()} order by m.date desc, m.id desc limit 1) as correspondent,
      f.facts
    from threads t left join thread_facts f on f.thread_id = t.id
    where ${sql.join(where, sql` and `)}
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
    readings: {},
  }));
}
