// The full search (ADR 0015): the whole mailbox, searched on the Server, only
// when asked ("Search older mail", or the Agent's search with `full`). The
// Server keeps no plaintext index, so the scan is:
//
// 1. SQL narrows the Threads on what is in the clear: the Workspace, not in
//    the trash, the dates, is:unread, is:starred, has:attachment, in:, tag:,
//    label:, and from: and to: as substrings of the Messages' addresses.
// 2. The Threads left are walked newest first in pages (search.full_page_size),
//    with up to search.full_concurrency pages read from Postgres at once.
// 3. Each Thread is matched with the shared matcher (packages/shared
//    search-match.ts). Subjects and bodies are decrypted lazily, in memory,
//    only when a term reaches them, and dropped with the page.
//
// The scan yields hits in order, a progress line after every page, and ends
// at the hit limit with a cursor below the last Thread examined, so a second
// call resumes where the first stopped. Aborting the signal stops it between
// Threads; reads already in flight finish and are discarded.

import {
  compileMatcher,
  excerpt,
  type FullSearchEvent,
  type MatchMessage,
  type Person,
  peopleText,
  queryTerms,
  type SearchQuery,
  searchTokens,
  type Thread,
  textNeeds,
} from "@monday/shared";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { ContentStore } from "./content.ts";

export interface FullSearchOptions {
  /** The parsed query; the caller parses with the shared parser and its own clock. */
  query: SearchQuery;
  /** Only Threads last active before this moment, on top of the query's dates. */
  before?: string | null | undefined;
  /** Stop after this many hits (search.full_limit). */
  limit: number;
  /** A previous stream's cursor: resume below it. */
  cursor?: string | null | undefined;
  /** Threads per page (search.full_page_size). */
  pageSize: number;
  /** Pages read from Postgres at once (search.full_concurrency). */
  concurrency: number;
  signal?: AbortSignal | undefined;
}

interface Cursor {
  /** last_activity of the last Thread examined, as Postgres printed it (full precision). */
  at: string;
  id: string;
  /** Threads examined before it, so progress carries on across "Search further". */
  scanned: number;
}

export function encodeFullCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.at, c.id, c.scanned])).toString("base64url");
}

export function decodeFullCursor(text: string): Cursor | null {
  try {
    const v = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [at, id, scanned] = v as [unknown, unknown, unknown];
    if (typeof at !== "string" || typeof id !== "string" || typeof scanned !== "number") {
      return null;
    }
    return { at, id, scanned };
  } catch {
    return null;
  }
}

const likeEscape = (text: string) =>
  text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

/**
 * The tokens of a from: or to: value as ILIKE patterns: every token of a
 * matching address is a substring of it, so the SQL is a superset of the
 * matcher's answer and never drops a hit. Tokens outside ASCII are left to
 * the matcher, since the matcher folds diacritics and ILIKE does not.
 */
function addressPatterns(text: string): string[] {
  return searchTokens(text)
    .filter((t) => /^[\x20-\x7e]+$/.test(t))
    .map((t) => `%${likeEscape(t)}%`);
}

/** The clear-text predicates over `t` (threads), ANDed. */
function filters(workspaceId: string, q: SearchQuery, before: string | null): SQL {
  const where: SQL[] = [sql`t.workspace_id = ${workspaceId}`, sql`t.deleted = false`];
  const upper = [q.before, before].filter((x): x is string => x !== null).sort()[0];
  if (upper) where.push(sql`t.last_activity < ${upper}::timestamptz`);
  if (q.after !== null) where.push(sql`t.last_activity >= ${q.after}::timestamptz`);
  if (q.hasAttachment !== null) where.push(sql`t.has_attachments = ${q.hasAttachment}`);
  if (q.unread !== null) where.push(sql`t.unread = ${q.unread}`);
  if (q.starred !== null) where.push(sql`t.starred = ${q.starred}`);
  for (const c of q.group) {
    const sub = sql`exists (select 1 from groups g where (g.id = t.group_id or g.id = t.subgroup_id)
      and (lower(g.name) = lower(${c.text}) or g.id = ${c.text}))`;
    where.push(c.negated ? sql`not ${sub}` : sub);
  }
  for (const c of q.tags) {
    const sub = sql`exists (select 1 from thread_tags tt join tags g on g.id = tt.tag_id
      where tt.thread_id = t.id and (lower(g.name) = lower(${c.text}) or g.id = ${c.text}))`;
    where.push(c.negated ? sql`not ${sub}` : sub);
  }
  for (const c of q.labels) {
    const sub = sql`exists (select 1 from thread_labels tl join labels l on l.id = tl.label_id
      where tl.thread_id = t.id and (lower(l.name) = lower(${c.text}) or l.id = ${c.text} or l.provider_id = ${c.text}))`;
    where.push(c.negated ? sql`not ${sub}` : sub);
  }
  // A positive from: or to: needs one Message whose addresses hold every token.
  for (const c of q.from) {
    const patterns = addressPatterns(c.text);
    if (c.negated || patterns.length === 0) continue;
    where.push(sql`exists (select 1 from messages m where m.thread_id = t.id
      and (coalesce(m."from"->>'name', '') || ' ' || coalesce(m."from"->>'email', '')) ilike all (${sql.raw(arrayLiteral(patterns))}))`);
  }
  for (const c of q.to) {
    const patterns = addressPatterns(c.text);
    if (c.negated || patterns.length === 0) continue;
    where.push(sql`exists (select 1 from messages m where m.thread_id = t.id
      and (m."to"::text || ' ' || m.cc::text) ilike all (${sql.raw(arrayLiteral(patterns))}))`);
  }
  return sql.join(where, sql` and `);
}

/** A Postgres text[] literal, quoted, for ILIKE ALL. */
function arrayLiteral(values: readonly string[]): string {
  const quoted = values.map((v) => `'${v.replaceAll("'", "''")}'`);
  return `array[${quoted.join(", ")}]::text[]`;
}

type ThreadRow = {
  id: string;
  /** last_activity as text, for the keyset. */
  at: string;
  workspace_id: string;
  subject_enc: Uint8Array;
  subject_key: Uint8Array;
  participants: Person[];
  last_activity: string | Date;
  message_count: number;
  unread: boolean;
  starred: boolean;
  archived: boolean;
  snoozed_until: string | Date | null;
  section: string | null;
  group_id: string | null;
  subgroup_id: string | null;
  has_attachments: boolean;
  bulk: boolean;
  tag_ids: string[] | null;
  label_ids: string[] | null;
};

type MessageRow = {
  thread_id: string;
  from: Person;
  to: Person[];
  cc: Person[];
  body_enc?: Uint8Array;
  body_key?: Uint8Array;
};

interface Page {
  threads: ThreadRow[];
  messages: Map<string, MessageRow[]>;
}

const iso = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString();

export interface FullSearchDeps {
  db: Db;
  content: ContentStore;
}

/**
 * Prepares a scan: counts the Threads the SQL leaves and resolves the
 * Workspace key when the query needs text (throws LockedError when locked,
 * before anything streams). The returned iterator runs the scan.
 */
export async function prepareFullSearch(
  deps: FullSearchDeps,
  workspaceId: string,
  options: FullSearchOptions,
): Promise<AsyncGenerator<FullSearchEvent>> {
  const { db, content } = deps;
  const q = options.query;
  const needs = textNeeds(q);
  // Every hit carries its decrypted subject, so even a query over clear
  // headers alone needs the key: a locked Server refuses before streaming.
  const open = await content.textOpener(workspaceId);
  const where = filters(workspaceId, q, options.before ?? null);
  const [count] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from threads t where ${where}`,
  );
  const total = Number(count?.n ?? 0);
  const start = options.cursor ? decodeFullCursor(options.cursor) : null;
  const pageSize = Math.max(1, options.pageSize);
  const concurrency = Math.max(1, options.concurrency);
  const limit = Math.max(1, options.limit);
  const match = compileMatcher(q);
  const terms = queryTerms(q);

  /** The next page of ids below `after`, newest first. Light: two columns. */
  const idPage = async (after: { at: string; id: string } | null) => {
    const keyset = after
      ? sql` and (t.last_activity, t.id) < (${after.at}::timestamptz, ${after.id})`
      : sql``;
    return db.execute<{ id: string; at: string }>(
      sql`select t.id, t.last_activity::text as at from threads t where ${where}${keyset}
        order by t.last_activity desc, t.id desc limit ${pageSize}`,
    );
  };

  /** The rows a page's matching needs: ciphertext only when a term reaches it. */
  const readPage = async (ids: string[]): Promise<Page> => {
    const threadRows = await db.execute<ThreadRow>(sql`
      select t.id, t.workspace_id, t.last_activity::text as at, t.subject_enc, t.subject_key, t.participants, t.last_activity,
        t.message_count, t.unread, t.starred, t.archived, t.snoozed_until, t.section,
        t.group_id, t.subgroup_id, t.has_attachments, t.bulk,
        (select array_agg(tag_id) from thread_tags where thread_id = t.id) as tag_ids,
        (select array_agg(label_id) from thread_labels where thread_id = t.id) as label_ids
      from threads t where t.id in ${sql`(${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`}`);
    const byId = new Map(threadRows.map((r) => [r.id, r]));
    const messages = new Map<string, MessageRow[]>();
    if (needs.any) {
      const bodyCols = needs.body ? sql`, m.body_enc, m.body_key` : sql``;
      const rows = await db.execute<MessageRow>(sql`
        select m.thread_id, m."from", m."to", m.cc${bodyCols}
        from messages m where m.thread_id in ${sql`(${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`}
        order by m.date desc, m.id desc`);
      for (const r of rows) {
        const list = messages.get(r.thread_id) ?? [];
        list.push(r);
        messages.set(r.thread_id, list);
      }
    }
    return {
      threads: ids.flatMap((id) => {
        const r = byId.get(id);
        return r ? [r] : [];
      }),
      messages,
    };
  };

  async function* run(): AsyncGenerator<FullSearchEvent> {
    const started = performance.now();
    let scanned = start?.scanned ?? 0;
    let hits = 0;
    let decrypted = 0;
    let last: { at: string; id: string } | null = start ? { at: start.at, id: start.id } : null;
    const aborted = () => options.signal?.aborted === true;

    yield { type: "progress", scanned, total, cursor: options.cursor ?? null };

    // Pages are read ahead, `concurrency` at a time, and consumed in order.
    let idCursor = last;
    let idsDone = false;
    const inFlight: Promise<Page>[] = [];
    const fill = async () => {
      while (!idsDone && inFlight.length < concurrency && !aborted()) {
        const rows = await idPage(idCursor);
        if (rows.length < pageSize) idsDone = true;
        const tail = rows[rows.length - 1];
        if (!tail) {
          idsDone = true;
          break;
        }
        idCursor = { at: tail.at, id: tail.id };
        const page = readPage(rows.map((r) => r.id));
        // Consumed in order below; a page read after an abort is dropped unobserved.
        page.catch(() => {});
        inFlight.push(page);
      }
    };

    const decryptText = (kind: "subject" | "body", key: Uint8Array, envelope: Uint8Array) => {
      decrypted += 1;
      return open(kind, key, envelope);
    };

    for (;;) {
      if (aborted()) return;
      await fill();
      const next = inFlight.shift();
      if (!next) break;
      const page = await next;
      if (aborted()) return;
      for (const row of page.threads) {
        if (aborted()) return;
        let subject: string | null = null;
        const subjectOf = () => {
          subject ??= decryptText("subject", row.subject_key, row.subject_enc);
          return subject;
        };
        const bodies = new Map<number, string>();
        const list = page.messages.get(row.id) ?? [];
        const docs: MatchMessage[] = list.map((m, i) => ({
          sender: `${m.from?.name ?? ""} ${m.from?.email ?? ""}`,
          recipients: `${peopleText(m.to ?? [])} ${peopleText(m.cc ?? [])}`,
          body: () => {
            let text = bodies.get(i);
            if (text === undefined) {
              text =
                m.body_enc && m.body_key
                  ? bodyText(decryptText("body", m.body_key, m.body_enc))
                  : "";
              bodies.set(i, text);
            }
            return text;
          },
        }));
        const result = match({
          subject: subjectOf,
          participants: peopleText(row.participants ?? []),
          messages: docs,
        });
        scanned += 1;
        last = { at: row.at, id: row.id };
        if (!result.matched) continue;
        hits += 1;
        // The passage comes from a body the match already opened; none is opened for it.
        const hitBody = result.message >= 0 ? (bodies.get(result.message) ?? "") : "";
        yield {
          type: "hit",
          thread: projectHit(row, subjectOf()),
          snippet: hitBody ? excerpt(hitBody, terms) : "",
        };
        if (hits >= limit) {
          const more = scanned < total;
          yield {
            type: "done",
            scanned,
            total,
            hits,
            cursor: more ? encodeFullCursor({ ...last, scanned }) : null,
            reason: more ? "limit" : "exhausted",
            decrypted,
            elapsedMs: Math.round(performance.now() - started),
          };
          return;
        }
      }
      // A stop after this line resumes here.
      yield {
        type: "progress",
        scanned,
        total,
        cursor: last && scanned < total ? encodeFullCursor({ ...last, scanned }) : null,
      };
    }
    yield {
      type: "done",
      scanned,
      total,
      hits,
      cursor: null,
      reason: "exhausted",
      decrypted,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  return run();
}

/** A stored body's searchable text: the text part, or the HTML with its tags dropped. */
function bodyText(json: string): string {
  try {
    const b = JSON.parse(json) as { text?: string; html?: string | null };
    if (b.text && b.text.trim() !== "") return b.text;
    return (b.html ?? "")
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  } catch {
    return "";
  }
}

function projectHit(r: ThreadRow, subject: string): Thread {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    subject,
    participants: r.participants ?? [],
    lastActivity: iso(r.last_activity),
    messageCount: r.message_count,
    unread: r.unread,
    starred: r.starred,
    archived: r.archived,
    snoozedUntil: r.snoozed_until ? iso(r.snoozed_until) : null,
    section: r.section as Thread["section"],
    group: r.group_id,
    subgroup: r.subgroup_id,
    tags: r.tag_ids ?? [],
    labels: r.label_ids ?? [],
    hasAttachments: r.has_attachments,
    snippet: "",
    bulk: r.bulk,
  };
}
