// The Store: the client's only data path (ADR 0009). Reads come from the
// Cache through query and live; writes go through intent, which applies the
// change locally, appends it to the Outbox and returns before any network
// call, so a row never flickers. sync drains the Outbox in order and pulls the
// Changes feed from the stored cursor; subscribe keeps a wake connection open
// with reconnect and backoff and syncs on every wake (ADR 0005).
//
// SQL lives here and in queries.ts; the driver underneath is three calls
// (driver.ts). Live queries re-run when a table they read is written; tables
// are found with a small parser over `from` and `join`, and every write path
// names the tables it touched.

import type {
  Actor,
  Brief,
  BriefChange,
  CalendarChange,
  Change,
  DecisionChange,
  Draft,
  DraftChange,
  DraftIntent,
  DraftIntentArgs,
  EventChange,
  GroupChange,
  Id,
  Intent,
  IntentArgs,
  InviteChange,
  InviteIntent,
  InviteIntentArgs,
  IsoDate,
  Message,
  MessageBodyRow,
  SendChange,
  ThreadChange,
} from "@monday/shared";
import { isDraftIntentKind, isInviteIntentKind } from "@monday/shared";
import { ApiError } from "../platform/api.ts";
import type { Row, SqlDriver, SqlParam, Statement } from "./driver.ts";
import schemaSql from "./schema.sql?raw";
import type { StoreTransport, WakeConnection } from "./transport.ts";

export type { Row, SqlDriver, SqlParam, Statement } from "./driver.ts";

export interface LiveQuery<T> {
  /** The latest rows; undefined until the first run has finished. */
  readonly rows: T[] | undefined;
  /** Called with the rows now (if any) and after every change. */
  subscribe(listener: (rows: T[]) => void): () => void;
  refresh(): Promise<T[]>;
  close(): void;
}

/** An intent as a screen raises it; the Store stamps time and actor. */
export type StoreIntent = IntentArgs & { threadId: Id; actor?: Actor; at?: IsoDate };
/** A Draft or send intent as the compose surface raises it (ADR 0010). */
export type DraftStoreIntent = DraftIntentArgs & { draftId: Id; actor?: Actor; at?: IsoDate };
/** An Invite's answer as the invite bar raises it (slice 18). */
export type InviteStoreIntent = InviteIntentArgs & { inviteId: Id; actor?: Actor; at?: IsoDate };
export type AnyIntent = Intent | DraftIntent | InviteIntent;

/** A Message header with its attachment headers, as GET /threads/:id/messages returns it. */
export interface CachedMessageHeader {
  id: Id;
  threadId: Id;
  from: Message["from"];
  to: Message["to"];
  cc: Message["cc"];
  date: IsoDate;
  hasAttachments: boolean;
  attachments: Array<{
    id: Id;
    name: string;
    size: number;
    mediaType: string;
    contentId?: string | null;
    inline?: boolean;
  }>;
}

export interface SyncResult {
  /** Outbox rows the Server accepted this round (applied or not). */
  pushed: number;
  /** Changes applied to the Cache. */
  pulled: number;
  cursor: number;
  /** Outbox rows still waiting after a transient failure. */
  pending: number;
  error: Error | null;
}

export type StoreStatus = "offline" | "connecting" | "online" | "syncing";

/** How far a catch-up pull has got, for the thin line at the top of the inbox. */
export interface SyncProgress {
  done: number;
  total: number;
}

export interface Store {
  readonly workspaceId: Id;
  query<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  live<T = Row>(sql: string, params?: SqlParam[]): LiveQuery<T>;
  /** Applies locally, appends to the Outbox, returns. The network happens in sync. */
  intent(action: StoreIntent | DraftStoreIntent | InviteStoreIntent): Promise<void>;
  /**
   * Content the screens fetched through the content routes, written into the
   * Cache so live queries pick it up: Message headers with attachments, one
   * Message's body, a Draft's full content, the reply-all choice for a Thread.
   */
  cacheMessages(rows: readonly CachedMessageHeader[]): Promise<void>;
  cacheBody(messageId: Id, body: { text: string; html: string | null }): Promise<void>;
  cacheDraft(draft: Draft): Promise<void>;
  /** A Brief fetched whole; the feed's header row (if any) is filled in. */
  cacheBrief(brief: Brief): Promise<void>;
  /**
   * Fetches the content of every Brief whose feed row is newer than its
   * bullets, through the transport. Runs after each pull; screens may call it
   * too. Returns how many landed. Never throws.
   */
  warmBriefs(): Promise<number>;
  /**
   * Fetches the title, description and location of every Event and the title
   * of every Invite whose feed row is newer than its content (slice 18), in
   * batches through the transport. Runs after each pull. Never throws.
   */
  warmEvents(): Promise<number>;
  setReplyAll(threadId: Id, replyAll: boolean): Promise<void>;
  /**
   * Cache-only writes that are not intents and never reach the Outbox: bodies
   * landing from the content routes, meta rows, evictions. One transaction;
   * live queries over the touched tables refresh.
   */
  write(statements: Statement[]): Promise<void>;
  /** Stores decrypted bodies for Messages the Cache already has headers for; returns how many landed. */
  applyBodies(bodies: readonly MessageBodyRow[], at?: IsoDate): Promise<number>;
  /** Drains the Outbox in order, then pulls the Changes feed from the cursor. Never throws. */
  sync(): Promise<SyncResult>;
  /** Connects the wake transport and syncs on each wake, reconnecting with backoff. */
  subscribe(): () => void;
  status(): StoreStatus;
  onStatus(listener: (status: StoreStatus) => void): () => void;
  /** Non-null while a pull spans more than one page (a first sync or a long catch-up). */
  progress(): SyncProgress | null;
  onProgress(listener: (progress: SyncProgress | null) => void): () => void;
  close(): Promise<void>;
}

export interface StoreOptions {
  workspaceId: Id;
  driver: SqlDriver;
  transport: StoreTransport;
  now?: () => Date;
  /** Reconnect backoff bounds; small in tests. */
  backoff?: { minMs: number; maxMs: number };
  changesPageSize?: number;
  /** How many Briefs one pull warms at most; the rest wait for the next. */
  briefWarmLimit?: number;
  log?: (message: string) => void;
}

const CURSOR_KEY = "cursor";
const SCHEMA_VERSION_KEY = "schema_version";
/**
 * Bumped when a table changes shape. Version 2 gave `messages` its rowid alias
 * and the body index (slice 10); version 3 gave `threads` the bulk flag,
 * `groups` the feed's columns (slice 12) and `briefs` its Thread version and
 * content flag (slice 13). An older Cache is a copy, so it is rebuilt from the
 * feed: content tables dropped, cursor reset, Outbox and settings kept.
 */
export const SCHEMA_VERSION = 3;

const REBUILD_SQL = `
  drop trigger if exists threads_fts_ai;
  drop trigger if exists threads_fts_ad;
  drop trigger if exists threads_fts_au;
  drop trigger if exists messages_fts_ai;
  drop trigger if exists messages_fts_ad;
  drop trigger if exists messages_fts_au;
  drop trigger if exists messages_fts_subject;
  drop table if exists messages_fts;
  drop view if exists messages_content;
  drop table if exists threads_fts;
  drop table if exists threads_trgm;
  drop view if exists threads_content;
  drop table if exists messages;
  drop table if exists attachments;
  drop table if exists threads;
  drop table if exists thread_tags;
  drop table if exists thread_labels;
  drop table if exists briefs;
  drop table if exists groups;
  drop table if exists decisions;
  delete from meta where key = 'cursor';
`;

/** Applies the schema, rebuilding the content tables first when the Cache predates this version. */
export async function applySchema(driver: SqlDriver): Promise<void> {
  const versionRows = await driver
    .query("select value from meta where key = ?", [SCHEMA_VERSION_KEY])
    .catch(() => [] as Row[]);
  const existing = await driver.query(
    "select name from sqlite_master where type = 'table' and name = 'threads'",
  );
  const version = Number(versionRows[0]?.value ?? 0) || 0;
  if (existing.length > 0 && version < SCHEMA_VERSION) await driver.exec(REBUILD_SQL);
  await driver.exec(schemaSql);
  await driver.exec(
    "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
    [SCHEMA_VERSION_KEY, String(SCHEMA_VERSION)],
  );
}

/**
 * Folds the newest FTS segments into the index. Run after a batch of writes
 * rather than 'optimize', which rewrites the whole index (research 5).
 */
export const FTS_MERGE_SQL = "insert into messages_fts (messages_fts, rank) values ('merge', 16)";

/* ------------------------------ Tables ------------------------------ */

const READ_TABLE = /\b(?:from|join)\s+["`]?([a-z_][a-z0-9_]*)/gi;

/** The tables a statement reads, for live query invalidation. */
export function tablesRead(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(READ_TABLE)) {
    const name = m[1]?.toLowerCase();
    if (name && name !== "select") out.add(name);
  }
  return out;
}

const WRITE_TABLE =
  /\b(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from)\s+["`]?([a-z_][a-z0-9_]*)/gi;

/** The tables a statement writes; `threads` and `messages` also touch their FTS indexes. */
export function tablesWritten(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(WRITE_TABLE)) {
    const name = m[1]?.toLowerCase();
    if (name) out.add(name);
  }
  if (out.has("threads")) {
    out.add("threads_fts");
    out.add("threads_trgm");
    out.add("messages_fts");
  }
  if (out.has("messages")) out.add("messages_fts");
  return out;
}

/** The Cache statements that store one decrypted body on its header row. */
export function bodyStatements(body: MessageBodyRow, at: IsoDate): Statement[] {
  return [
    {
      sql: "update messages set body_text = ?, body_html = ?, body_at = ? where id = ?",
      params: [body.text, body.html, at, body.id],
    },
    {
      // The Thread snippet is content too: the newest body fills it while it is empty.
      sql: "update threads set snippet = ? where id = ? and snippet = '' and ? <> ''",
      params: [body.snippet, body.threadId, body.snippet],
    },
  ];
}

/* ------------------------------ Local effects of an intent ------------------------------ */

/** The Cache statements that make an intent visible, before the Server has seen it. */
export function localStatements(intent: Intent): Statement[] {
  const set = (assignments: string, params: SqlParam[]): Statement => ({
    sql: `update threads set ${assignments}, updated_at = ? where id = ?`,
    params: [...params, intent.at, intent.threadId],
  });
  switch (intent.kind) {
    case "archive":
      return [set("archived = 1", [])];
    case "unarchive":
      return [set("archived = 0", [])];
    case "star":
      return [set("starred = 1", [])];
    case "unstar":
      return [set("starred = 0", [])];
    case "read":
      return [set("unread = 0", [])];
    case "unread":
      return [set("unread = 1", [])];
    case "snooze":
      return [set("snoozed_until = ?, archived = 1", [intent.until])];
    case "unsnooze":
      return [set("snoozed_until = null, archived = 0", [])];
    case "move":
      return [set("group_id = ?, subgroup_id = ?", [intent.group, intent.subgroup])];
    case "delete":
      return [set("deleted = 1", [])];
    case "undelete":
      return [set("deleted = 0", [])];
    case "tags":
      return [
        { sql: "delete from thread_tags where thread_id = ?", params: [intent.threadId] },
        ...[...new Set(intent.tags)].map((tagId) => ({
          sql: "insert or ignore into thread_tags (thread_id, tag_id) values (?, ?)",
          params: [intent.threadId, tagId],
        })),
      ];
  }
}

/** The Cache statements that make an Invite's answer visible before the Server has it (slice 18). */
export function localInviteStatements(intent: InviteIntent): Statement[] {
  return [
    {
      sql: "update invites set response = ? where id = ?",
      params: [intent.response, intent.inviteId],
    },
    {
      // The Event the Invite points at answers the same way, so the views agree at once.
      sql: "update events set response = ?, updated_at = ? where id = (select event_id from invites where id = ?)",
      params: [intent.response, intent.at, intent.inviteId],
    },
  ];
}

/** The Cache statements that make a Draft or send intent visible before the Server has it. */
export function localDraftStatements(intent: DraftIntent): Statement[] {
  switch (intent.kind) {
    case "draft.save": {
      const c = intent.content;
      return [
        {
          sql: `insert into drafts (id, thread_id, kind, in_reply_to_message_id, recipients, cc, bcc, subject,
                  body_html, body_text, attachments, status, deleted, content_stale, updated_at, updated_by)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, 0, ?, ?)
                on conflict (id) do update set
                  thread_id = excluded.thread_id, kind = excluded.kind,
                  in_reply_to_message_id = excluded.in_reply_to_message_id,
                  recipients = excluded.recipients, cc = excluded.cc, bcc = excluded.bcc,
                  subject = excluded.subject, body_html = excluded.body_html, body_text = excluded.body_text,
                  attachments = excluded.attachments, status = 'open', deleted = 0, content_stale = 0,
                  updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          params: [
            intent.draftId,
            c.threadId,
            c.kind,
            c.inReplyToMessageId,
            c.to,
            c.cc,
            c.bcc,
            c.subject,
            c.bodyHtml,
            c.bodyText,
            c.attachments,
            intent.at,
            intent.actor,
          ],
        },
      ];
    }
    case "draft.delete":
      return [
        {
          sql: "update drafts set deleted = 1, updated_at = ? where id = ?",
          params: [intent.at, intent.draftId],
        },
      ];
    case "send.schedule": {
      const runAt =
        intent.runAt ??
        new Date(Date.parse(intent.at) + (intent.delaySeconds ?? 0) * 1000).toISOString();
      return [
        {
          sql: `insert into sends (id, draft_id, run_at, status, created_at) values (?, ?, ?, 'scheduled', ?)
                on conflict (id) do update set run_at = excluded.run_at, status = 'scheduled'`,
          params: [intent.sendId, intent.draftId, runAt, intent.at],
        },
        {
          sql: "update drafts set status = 'scheduled', updated_at = ? where id = ?",
          params: [intent.at, intent.draftId],
        },
      ];
    }
    case "send.cancel":
      return [
        {
          sql: "update sends set status = 'cancelled', cancelled_at = ? where id = ? and status = 'scheduled'",
          params: [intent.at, intent.sendId],
        },
        {
          sql: "update drafts set status = 'open', updated_at = ? where id = ?",
          params: [intent.at, intent.draftId],
        },
      ];
  }
}

/* ------------------------------ Applying the feed ------------------------------ */

function threadUpsert(t: ThreadChange, at: IsoDate): Statement[] {
  return [
    {
      // Subject and snippet are content: a feed row fills them only while they are empty.
      sql: `insert into threads (id, subject, participants, last_activity, message_count, unread, starred,
              archived, deleted, snoozed_until, section, group_id, subgroup_id, has_attachments, bulk, snippet, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (id) do update set
              subject = case when threads.subject = '' then excluded.subject else threads.subject end,
              participants = excluded.participants,
              last_activity = excluded.last_activity,
              message_count = excluded.message_count,
              unread = excluded.unread,
              starred = excluded.starred,
              archived = excluded.archived,
              deleted = excluded.deleted,
              snoozed_until = excluded.snoozed_until,
              section = excluded.section,
              group_id = excluded.group_id,
              subgroup_id = excluded.subgroup_id,
              has_attachments = excluded.has_attachments,
              bulk = excluded.bulk,
              snippet = case when threads.snippet = '' then excluded.snippet else threads.snippet end,
              updated_at = excluded.updated_at`,
      params: [
        t.id,
        t.subject,
        t.participants,
        t.lastActivity,
        t.messageCount,
        t.unread,
        t.starred,
        t.archived,
        t.deleted,
        t.snoozedUntil,
        t.section,
        t.group,
        t.subgroup,
        t.hasAttachments,
        t.bulk ?? false,
        t.snippet,
        at,
      ],
    },
    ...links("thread_tags", "tag_id", t.id, t.tags),
    ...links("thread_labels", "label_id", t.id, t.labels),
  ];
}

function links(table: string, column: string, threadId: Id, ids: Id[]): Statement[] {
  return [
    { sql: `delete from ${table} where thread_id = ?`, params: [threadId] },
    ...[...new Set(ids)].map((id) => ({
      sql: `insert or ignore into ${table} (thread_id, ${column}) values (?, ?)`,
      params: [threadId, id],
    })),
  ];
}

/** The Cache statements for one feed row. */
export function changeStatements(change: Change): Statement[] {
  switch (change.kind) {
    case "thread":
      return threadUpsert(change.payload, change.at);
    case "message": {
      const m = change.payload;
      return [
        {
          // Bodies arrive through the content route; a header row never clears them.
          sql: `insert into messages (id, thread_id, sender, recipients, cc, date, has_attachments)
                values (?, ?, ?, ?, ?, ?, ?)
                on conflict (id) do update set
                  thread_id = excluded.thread_id, sender = excluded.sender, recipients = excluded.recipients,
                  cc = excluded.cc, date = excluded.date, has_attachments = excluded.has_attachments`,
          params: [m.id, m.threadId, m.from, m.to, m.cc, m.date, m.hasAttachments],
        },
      ];
    }
    case "label":
      return [
        {
          sql: `insert into labels (id, name, provider_id) values (?, ?, ?)
                on conflict (id) do update set name = excluded.name, provider_id = excluded.provider_id`,
          params: [change.payload.id, change.payload.name, change.payload.providerId],
        },
      ];
    case "tag":
      return [
        {
          sql: "insert into tags (id, name) values (?, ?) on conflict (id) do update set name = excluded.name",
          params: [change.payload.id, change.payload.name],
        },
      ];
    case "thread_tags":
      return links("thread_tags", "tag_id", change.payload.threadId, change.payload.ids);
    case "thread_labels":
      return links("thread_labels", "label_id", change.payload.threadId, change.payload.ids);
    case "draft":
      return [draftUpsert(change.payload)];
    case "send":
      return [sendUpsert(change.payload)];
    case "brief":
      return [briefUpsert(change.payload)];
    case "group":
      return [groupUpsert(change.payload)];
    case "decision":
      return [decisionUpsert(change.payload)];
    case "calendar":
      return [calendarUpsert(change.payload)];
    case "event":
      return [eventUpsert(change.payload)];
    case "invite":
      return [inviteUpsert(change.payload)];
  }
}

/** A calendar row from the feed, or its removal with its Events. */
function calendarUpsert(c: CalendarChange): Statement {
  if (c.deleted) return { sql: "delete from calendars where id = ?", params: [c.id] };
  return {
    sql: `insert into calendars (id, source, provider_id, name, "primary", writable, visible, color)
          values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (id) do update set
            source = excluded.source, provider_id = excluded.provider_id, name = excluded.name,
            "primary" = excluded."primary", writable = excluded.writable, visible = excluded.visible,
            color = excluded.color`,
    params: [c.id, c.source, c.providerId, c.name, c.primary, c.writable, c.visible, c.color],
  };
}

/**
 * An Event header row from the feed (slice 18): times, people, link and
 * status always; the title is content and stays until a newer header marks
 * it stale for the warm step. A deleted Event drops the row.
 */
function eventUpsert(e: EventChange): Statement {
  if (e.deleted) return { sql: "delete from events where id = ?", params: [e.id] };
  return {
    sql: `insert into events (id, calendar_id, provider_id, uid, start, "end", all_day, time_zone, organizer,
            attendees, link, status, recurrence, recurring_event_id, response, created_by_agent, content_stale, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
          on conflict (id) do update set
            calendar_id = excluded.calendar_id, provider_id = excluded.provider_id, uid = excluded.uid,
            start = excluded.start, "end" = excluded."end", all_day = excluded.all_day, time_zone = excluded.time_zone,
            organizer = excluded.organizer, attendees = excluded.attendees, link = excluded.link,
            status = excluded.status, recurrence = excluded.recurrence, recurring_event_id = excluded.recurring_event_id,
            response = excluded.response, created_by_agent = excluded.created_by_agent,
            content_stale = case when excluded.updated_at > events.updated_at or events.title = '' then 1 else events.content_stale end,
            updated_at = max(events.updated_at, excluded.updated_at)`,
    params: [
      e.id,
      e.calendarId,
      e.providerId,
      e.uid,
      e.start,
      e.end,
      e.allDay,
      e.timeZone,
      e.organizer,
      e.attendees,
      e.link,
      e.status,
      e.recurrence,
      e.recurringEventId,
      e.response,
      e.createdByAgent,
      e.updatedAt,
    ],
  };
}

/** An Invite header row from the feed; the title is content, warmed like an Event's. */
function inviteUpsert(i: InviteChange): Statement {
  if (i.deleted) return { sql: "delete from invites where id = ?", params: [i.id] };
  return {
    sql: `insert into invites (id, message_id, thread_id, event_id, method, uid, sequence, start, "end", all_day,
            organizer, attendees, response, by_mail, sender_mismatch, received_at, content_stale)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          on conflict (id) do update set
            message_id = excluded.message_id, thread_id = excluded.thread_id, event_id = excluded.event_id,
            method = excluded.method, uid = excluded.uid, sequence = excluded.sequence, start = excluded.start,
            "end" = excluded."end", all_day = excluded.all_day, organizer = excluded.organizer,
            attendees = excluded.attendees, response = excluded.response, by_mail = excluded.by_mail,
            sender_mismatch = excluded.sender_mismatch, received_at = excluded.received_at,
            content_stale = case when invites.title = '' then 1 else invites.content_stale end`,
    params: [
      i.id,
      i.messageId,
      i.threadId,
      i.eventId,
      i.method,
      i.uid,
      i.sequence,
      i.start,
      i.end,
      i.allDay,
      i.organizer,
      i.attendees,
      i.response,
      i.byMail,
      i.senderMismatch,
      i.receivedAt,
    ],
  };
}

/** A Group row from the feed, or its removal. Sub-groups arrive as their own rows. */
function groupUpsert(g: GroupChange): Statement {
  if (g.deleted) return { sql: "delete from groups where id = ?", params: [g.id] };
  return {
    sql: `insert into groups (id, parent_id, name, sentence, predicate, threshold, brief_policy)
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict (id) do update set
            parent_id = excluded.parent_id, name = excluded.name, sentence = excluded.sentence,
            predicate = excluded.predicate, threshold = excluded.threshold, brief_policy = excluded.brief_policy`,
    params: [g.id, g.parentId, g.name, g.sentence, g.predicate, g.threshold, g.briefPolicy],
  };
}

/** A Needs a decision entry from the feed; no candidates means the Thread left the queue. */
function decisionUpsert(d: DecisionChange): Statement {
  if (d.candidates.length === 0) {
    return { sql: "delete from decisions where thread_id = ?", params: [d.threadId] };
  }
  return {
    sql: `insert into decisions (thread_id, candidates, at) values (?, ?, ?)
          on conflict (thread_id) do update set candidates = excluded.candidates, at = excluded.at`,
    params: [d.threadId, d.candidates, d.at],
  };
}

/**
 * A Brief header row from the feed (slice 13): headers always, content left
 * alone. A newer Brief than the local row marks the content stale so the
 * Store fetches it after the pull; a stale flag on the same Brief keeps the
 * bullets and only dims them. A removed Brief drops the row.
 */
function briefUpsert(b: BriefChange): Statement {
  if (b.deleted) return { sql: "delete from briefs where thread_id = ?", params: [b.threadId] };
  return {
    sql: `insert into briefs (thread_id, bullets, actions, computed_at, stale, message_count, content_stale)
          values (?, '[]', '[]', ?, ?, ?, 1)
          on conflict (thread_id) do update set
            stale = excluded.stale,
            message_count = excluded.message_count,
            content_stale = case when excluded.computed_at > briefs.computed_at then 1 else briefs.content_stale end,
            computed_at = max(briefs.computed_at, excluded.computed_at)`,
    params: [b.threadId, b.computedAt, b.stale, b.messageCount],
  };
}

/**
 * The Cache statements for a Brief fetched whole from GET /threads/:id/brief.
 * The Thread version stays what the feed said; the content route does not
 * carry it.
 */
export function cachedBriefStatements(brief: Brief): Statement[] {
  return [
    {
      sql: `insert into briefs (thread_id, bullets, actions, computed_at, stale, message_count, content_stale)
            values (?, ?, ?, ?, ?, 0, 0)
            on conflict (thread_id) do update set
              bullets = excluded.bullets, actions = excluded.actions,
              computed_at = excluded.computed_at, stale = excluded.stale,
              content_stale = 0`,
      params: [
        brief.threadId,
        brief.verified ? { bullets: brief.bullets, verified: brief.verified } : brief.bullets,
        brief.actions,
        brief.computedAt,
        brief.stale,
      ],
    },
  ];
}

/**
 * A Draft header row from the feed: headers always, content left alone. A
 * newer header than the local row marks the content stale so the compose
 * surface fetches it before editing.
 */
function draftUpsert(d: DraftChange): Statement {
  return {
    sql: `insert into drafts (id, thread_id, kind, in_reply_to_message_id, recipients, cc, bcc, attachments,
            status, deleted, content_stale, updated_at, updated_by)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          on conflict (id) do update set
            thread_id = excluded.thread_id, kind = excluded.kind,
            in_reply_to_message_id = excluded.in_reply_to_message_id,
            recipients = excluded.recipients, cc = excluded.cc, bcc = excluded.bcc,
            attachments = excluded.attachments, status = excluded.status, deleted = excluded.deleted,
            content_stale = case when excluded.updated_at > drafts.updated_at then 1 else drafts.content_stale end,
            updated_at = max(drafts.updated_at, excluded.updated_at), updated_by = excluded.updated_by`,
    params: [
      d.id,
      d.threadId,
      d.kind,
      d.inReplyToMessageId,
      d.to,
      d.cc,
      d.bcc,
      d.attachments,
      d.status,
      d.deleted,
      d.updatedAt,
      d.updatedBy,
    ],
  };
}

function sendUpsert(sd: SendChange): Statement {
  return {
    sql: `insert into sends (id, draft_id, run_at, status, cancelled_at, sent_at, job_id, error, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (id) do update set
            draft_id = excluded.draft_id, run_at = excluded.run_at, status = excluded.status,
            cancelled_at = excluded.cancelled_at, sent_at = excluded.sent_at, job_id = excluded.job_id,
            error = excluded.error, created_at = excluded.created_at`,
    params: [
      sd.id,
      sd.draftId,
      sd.runAt,
      sd.status,
      sd.cancelledAt,
      sd.sentAt,
      sd.jobId,
      sd.error,
      sd.createdAt,
    ],
  };
}

/** The Cache statements for a Draft fetched whole from GET /drafts/:id. */
export function cachedDraftStatements(draft: Draft): Statement[] {
  return [
    {
      sql: `insert into drafts (id, thread_id, kind, in_reply_to_message_id, recipients, cc, bcc, subject,
              body_html, body_text, attachments, status, deleted, content_stale, updated_at, updated_by)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
            on conflict (id) do update set
              thread_id = excluded.thread_id, kind = excluded.kind,
              in_reply_to_message_id = excluded.in_reply_to_message_id,
              recipients = excluded.recipients, cc = excluded.cc, bcc = excluded.bcc,
              subject = excluded.subject, body_html = excluded.body_html, body_text = excluded.body_text,
              attachments = excluded.attachments, status = excluded.status, deleted = 0, content_stale = 0,
              updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      params: [
        draft.id,
        draft.threadId,
        draft.kind,
        draft.inReplyToMessageId,
        draft.to,
        draft.cc,
        draft.bcc,
        draft.subject,
        draft.bodyHtml,
        draft.bodyText,
        draft.attachments,
        draft.status,
        draft.updatedAt,
        draft.updatedBy,
      ],
    },
  ];
}

/** The Cache statements for Message headers with their attachments; bodies untouched. */
export function cachedMessageStatements(rows: readonly CachedMessageHeader[]): Statement[] {
  const out: Statement[] = [];
  for (const m of rows) {
    out.push({
      sql: `insert into messages (id, thread_id, sender, recipients, cc, date, has_attachments)
            values (?, ?, ?, ?, ?, ?, ?)
            on conflict (id) do update set
              thread_id = excluded.thread_id, sender = excluded.sender, recipients = excluded.recipients,
              cc = excluded.cc, date = excluded.date, has_attachments = excluded.has_attachments`,
      params: [m.id, m.threadId, m.from, m.to, m.cc, m.date, m.hasAttachments],
    });
    out.push({ sql: "delete from attachments where message_id = ?", params: [m.id] });
    for (const a of m.attachments) {
      out.push({
        sql: "insert or replace into attachments (id, message_id, name, size, media_type, text) values (?, ?, ?, ?, ?, null)",
        params: [a.id, m.id, a.name, a.size, a.mediaType],
      });
    }
  }
  return out;
}

interface OutboxRow {
  seq: number;
  thread_id: string;
  kind: AnyIntent["kind"];
  payload: string;
  at: string;
  actor: Actor;
  attempts: number;
}

function intentOf(row: OutboxRow): AnyIntent {
  const args = JSON.parse(row.payload) as Record<string, unknown>;
  if (isInviteIntentKind(row.kind)) {
    return {
      ...args,
      kind: row.kind,
      inviteId: row.thread_id,
      at: row.at,
      actor: row.actor,
    } as InviteIntent;
  }
  if (isDraftIntentKind(row.kind)) {
    return {
      ...args,
      kind: row.kind,
      draftId: row.thread_id,
      at: row.at,
      actor: row.actor,
    } as DraftIntent;
  }
  return {
    ...args,
    kind: row.kind,
    threadId: row.thread_id,
    at: row.at,
    actor: row.actor,
  } as Intent;
}

/** The local effect of any Outbox row. */
function localOf(intent: AnyIntent): Statement[] {
  if ("inviteId" in intent) return localInviteStatements(intent);
  return "draftId" in intent ? localDraftStatements(intent) : localStatements(intent);
}

/* ------------------------------ The Store ------------------------------ */

export async function createStore(options: StoreOptions): Promise<Store> {
  const { workspaceId, driver, transport } = options;
  const now = options.now ?? (() => new Date());
  const backoff = options.backoff ?? { minMs: 1_000, maxMs: 30_000 };
  const pageSize = options.changesPageSize ?? 500;
  const warmLimit = options.briefWarmLimit ?? 50;
  const eventWarmBatch = 200;
  const log = options.log ?? (() => {});

  await applySchema(driver);

  /* Live queries */
  interface LiveEntry {
    tables: Set<string>;
    refresh: () => Promise<unknown>;
  }
  const lives = new Set<LiveEntry>();

  const invalidate = (tables: Iterable<string>) => {
    const touched = new Set(tables);
    for (const entry of lives) {
      for (const t of entry.tables) {
        if (touched.has(t)) {
          void entry.refresh();
          break;
        }
      }
    }
  };

  /** Every write goes through here so live queries learn what changed. */
  const write = async (statements: Statement[]) => {
    if (statements.length === 0) return;
    await driver.batch(statements);
    const touched = new Set<string>();
    for (const s of statements) for (const t of tablesWritten(s.sql)) touched.add(t);
    invalidate(touched);
  };

  const readCursor = async () => {
    const rows = await driver.query("select value from meta where key = ?", [CURSOR_KEY]);
    const value = rows[0]?.value;
    return typeof value === "string" ? Number(value) || 0 : 0;
  };

  /* Status */
  let status: StoreStatus = "offline";
  const statusListeners = new Set<(s: StoreStatus) => void>();
  const setStatus = (s: StoreStatus) => {
    if (s === status) return;
    status = s;
    for (const l of statusListeners) l(s);
  };

  /* Progress */
  let progress: SyncProgress | null = null;
  /** The newest seq the wake transport reported; bounds a pull's total. */
  let latestSeq = 0;
  const progressListeners = new Set<(p: SyncProgress | null) => void>();
  const setProgress = (p: SyncProgress | null) => {
    if (
      p === progress ||
      (p && progress && p.done === progress.done && p.total === progress.total)
    ) {
      return;
    }
    progress = p;
    for (const l of progressListeners) l(p);
  };

  /* Sync */
  let inflight: Promise<SyncResult> | null = null;
  let again = false;
  let closed = false;

  const pendingFor = async (threadIds: Iterable<Id>): Promise<AnyIntent[]> => {
    const ids = [...new Set(threadIds)];
    if (ids.length === 0) return [];
    const rows = (await driver.query(
      `select * from outbox where thread_id in (${ids.map(() => "?").join(", ")}) order by seq`,
      ids,
    )) as unknown as OutboxRow[];
    return rows.map(intentOf);
  };

  const applyChanges = async (changes: Change[], cursor: number) => {
    const statements: Statement[] = [];
    for (const c of changes) statements.push(...changeStatements(c));
    // Intents still in the Outbox are the truth for their Threads until the
    // Server has them: replay their local effect over whatever the feed said.
    const touched = changes.flatMap((c) => {
      if (c.kind === "thread") return [c.payload.id];
      if (c.kind === "thread_tags") return [c.payload.threadId];
      if (c.kind === "draft") return [c.payload.id];
      if (c.kind === "send") return [c.payload.draftId];
      if (c.kind === "invite") return [c.payload.id];
      return [];
    });
    for (const intent of await pendingFor(touched)) statements.push(...localOf(intent));
    statements.push({
      sql: "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
      params: [CURSOR_KEY, String(cursor)],
    });
    await write(statements);
    await driver.exec(FTS_MERGE_SQL);
  };

  const drainOutbox = async (result: SyncResult) => {
    const rows = (await driver.query(
      "select * from outbox order by seq",
    )) as unknown as OutboxRow[];
    for (const row of rows) {
      const intent = intentOf(row);
      try {
        const answer =
          "inviteId" in intent
            ? await transport.inviteIntent(intent)
            : "draftId" in intent
              ? await transport.draftIntent(workspaceId, intent)
              : await transport.intent(intent);
        if (!answer.applied) log(`intent ${row.kind} on ${row.thread_id} lost: ${answer.reason}`);
        await driver.exec("delete from outbox where seq = ?", [row.seq]);
        result.pushed += 1;
      } catch (error) {
        if (error instanceof ApiError && error.permanent) {
          log(`intent ${row.kind} on ${row.thread_id} rejected (${error.status}); dropped`);
          await driver.exec("delete from outbox where seq = ?", [row.seq]);
          continue;
        }
        await driver.exec(
          "update outbox set attempts = attempts + 1, last_error = ? where seq = ?",
          [error instanceof Error ? error.message : String(error), row.seq],
        );
        throw error;
      }
    }
    invalidate(["outbox"]);
  };

  const pullChanges = async (result: SyncResult) => {
    let cursor = await readCursor();
    const start = cursor;
    try {
      for (;;) {
        const page = await transport.changes(workspaceId, cursor, pageSize);
        if (page.changes.length > 0) {
          await applyChanges(page.changes, page.cursor);
          result.pulled += page.changes.length;
        }
        cursor = page.cursor;
        result.cursor = cursor;
        if (page.changes.length < pageSize) break;
        // A full page means more is coming: show how far the catch-up has got.
        const total = Math.max(latestSeq - start, cursor - start + pageSize);
        setProgress({ done: cursor - start, total });
      }
    } finally {
      setProgress(null);
    }
  };

  /**
   * Brief content follows its feed row: rows whose bullets lag their headers
   * are fetched through the transport so the reader shows the Brief on open
   * without a request (slice 13). A row the Server no longer has is dropped.
   */
  const warmBriefs = async (): Promise<number> => {
    const fetchBrief = transport.brief;
    if (!fetchBrief || closed) return 0;
    let landed = 0;
    try {
      const rows = await driver.query(
        "select thread_id from briefs where content_stale = 1 order by computed_at desc limit ?",
        [warmLimit],
      );
      for (const row of rows) {
        if (closed) break;
        const threadId = String(row.thread_id);
        try {
          const brief = await fetchBrief.call(transport, threadId);
          if (brief) {
            await write(cachedBriefStatements(brief));
            landed += 1;
          } else {
            await write([{ sql: "delete from briefs where thread_id = ?", params: [threadId] }]);
          }
        } catch (error) {
          log(`brief ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof ApiError && !error.permanent) break;
        }
      }
    } catch (error) {
      log(`warm briefs: ${error instanceof Error ? error.message : String(error)}`);
    }
    return landed;
  };

  /**
   * Event and Invite content follows the feed rows (slice 18): titles are
   * fetched in batches through the transport so the views and the invite
   * bar read them from the Cache. Ids the Server no longer has are dropped.
   */
  const warmEvents = async (): Promise<number> => {
    const fetchContent = transport.eventsContent;
    const fetchInvite = transport.invite;
    if (closed) return 0;
    let landed = 0;
    try {
      if (fetchContent) {
        const rows = await driver.query(
          "select id from events where content_stale = 1 order by start limit ?",
          [eventWarmBatch],
        );
        const ids = rows.map((r) => String(r.id));
        if (ids.length > 0) {
          const content = await fetchContent.call(transport, workspaceId, ids);
          const seen = new Set<string>();
          const statements: Statement[] = [];
          for (const c of content) {
            seen.add(c.id);
            statements.push({
              sql: "update events set title = ?, description = ?, location = ?, content_stale = 0 where id = ?",
              params: [c.title, c.description, c.location, c.id],
            });
            landed += 1;
          }
          for (const id of ids) {
            if (!seen.has(id))
              statements.push({ sql: "delete from events where id = ?", params: [id] });
          }
          await write(statements);
        }
      }
      if (fetchInvite) {
        const rows = await driver.query(
          "select id from invites where content_stale = 1 order by received_at desc limit ?",
          [warmLimit],
        );
        for (const row of rows) {
          if (closed) break;
          const id = String(row.id);
          try {
            const invite = await fetchInvite.call(transport, id);
            if (invite) {
              await write([
                {
                  sql: "update invites set title = ?, content_stale = 0 where id = ?",
                  params: [invite.title, id],
                },
              ]);
              landed += 1;
            } else {
              await write([{ sql: "delete from invites where id = ?", params: [id] }]);
            }
          } catch (error) {
            log(`invite ${id}: ${error instanceof Error ? error.message : String(error)}`);
            if (error instanceof ApiError && !error.permanent) break;
          }
        }
      }
    } catch (error) {
      log(`warm events: ${error instanceof Error ? error.message : String(error)}`);
    }
    return landed;
  };

  const runSync = async (): Promise<SyncResult> => {
    const result: SyncResult = { pushed: 0, pulled: 0, cursor: 0, pending: 0, error: null };
    setStatus("syncing");
    try {
      await drainOutbox(result);
      await pullChanges(result);
      await warmBriefs();
      await warmEvents();
      setStatus(connection ? "online" : "offline");
    } catch (error) {
      result.error = error instanceof Error ? error : new Error(String(error));
      setStatus("offline");
    }
    if (closed) return result;
    const pending = await driver.query("select count(*) as n from outbox");
    result.pending = Number(pending[0]?.n ?? 0);
    if (result.cursor === 0) result.cursor = await readCursor();
    return result;
  };

  const sync = (): Promise<SyncResult> => {
    if (closed) {
      return Promise.resolve({
        pushed: 0,
        pulled: 0,
        cursor: 0,
        pending: 0,
        error: new Error("store closed"),
      });
    }
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      let result = await runSync();
      while (again) {
        again = false;
        result = await runSync();
      }
      inflight = null;
      return result;
    })();
    return inflight;
  };

  /* Wake */
  let connection: WakeConnection | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let subscribed = false;
  let attempt = 0;

  const connect = () => {
    if (!subscribed) return;
    setStatus("connecting");
    connection = transport.connect(workspaceId, {
      onOpen() {
        attempt = 0;
        setStatus("online");
        void sync();
      },
      onWake(seq) {
        if (seq > latestSeq) latestSeq = seq;
        void sync();
      },
      onClose() {
        connection = null;
        if (!subscribed) return;
        setStatus("offline");
        const delay = Math.min(backoff.maxMs, backoff.minMs * 2 ** attempt) * (0.5 + Math.random());
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      },
    });
  };

  const disconnect = () => {
    subscribed = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connection?.close();
    connection = null;
    setStatus("offline");
  };

  const store: Store = {
    workspaceId,

    query<T = Row>(sql: string, params?: SqlParam[]) {
      return driver.query(sql, params) as Promise<T[]>;
    },

    live<T = Row>(sql: string, params: SqlParam[] = []): LiveQuery<T> {
      const listeners = new Set<(rows: T[]) => void>();
      let rows: T[] | undefined;
      let last = "";
      let closed = false;
      let running: Promise<T[]> | null = null;
      let rerun = false;
      const run = async (): Promise<T[]> => {
        const next = (await driver.query(sql, params)) as T[];
        if (closed) return next;
        const key = JSON.stringify(next);
        if (rows === undefined || key !== last) {
          rows = next;
          last = key;
          for (const l of listeners) l(next);
        }
        return next;
      };
      const refresh = (): Promise<T[]> => {
        if (running) {
          rerun = true;
          return running;
        }
        running = (async () => {
          let out = await run();
          while (rerun && !closed) {
            rerun = false;
            out = await run();
          }
          running = null;
          return out;
        })();
        return running;
      };
      const entry: LiveEntry = { tables: tablesRead(sql), refresh };
      lives.add(entry);
      void refresh();
      return {
        get rows() {
          return rows;
        },
        subscribe(listener) {
          listeners.add(listener);
          if (rows !== undefined) listener(rows);
          return () => listeners.delete(listener);
        },
        refresh,
        close() {
          closed = true;
          lives.delete(entry);
          listeners.clear();
        },
      };
    },

    async intent(action) {
      const stampAt = action.at ?? now().toISOString();
      const stampActor = action.actor ?? "user";
      let intent: AnyIntent;
      let entityId: Id;
      let payload: Record<string, unknown>;
      if ("inviteId" in action) {
        const { inviteId, actor: _c, at: _a, ...args } = action;
        intent = { ...args, inviteId, at: stampAt, actor: stampActor } as InviteIntent;
        entityId = inviteId;
        const { kind: _k, inviteId: _i, at: _x, actor: _y, ...rest } = intent;
        payload = rest;
      } else if ("draftId" in action) {
        const { draftId, actor: _c, at: _a, ...args } = action;
        intent = { ...args, draftId, at: stampAt, actor: stampActor } as DraftIntent;
        entityId = draftId;
        const { kind: _k, draftId: _d, at: _x, actor: _y, ...rest } = intent;
        payload = rest;
      } else {
        const { threadId, actor: _c, at: _a, ...args } = action;
        intent = { ...args, threadId, at: stampAt, actor: stampActor } as Intent;
        entityId = threadId;
        const { kind: _k, threadId: _t, at: _x, actor: _y, ...rest } = intent;
        payload = rest;
      }
      await write([
        ...localOf(intent),
        {
          sql: "insert into outbox (thread_id, kind, payload, at, actor) values (?, ?, ?, ?, ?)",
          params: [entityId, intent.kind, payload, intent.at, intent.actor],
        },
      ]);
      // The row is already on screen; a subscribed Store tells the Server in the
      // background, an unsubscribed one (tests, offline by choice) waits for sync().
      if (subscribed) void sync();
    },

    async cacheMessages(rows) {
      await write(cachedMessageStatements(rows));
    },

    async cacheBody(messageId, body) {
      // `body_at` is the read clock the pre-warm Job's eviction orders by (ADR 0011).
      await write([
        {
          sql: "update messages set body_text = ?, body_html = ?, body_at = ? where id = ?",
          params: [body.text, body.html, now().toISOString(), messageId],
        },
      ]);
      await driver.exec(FTS_MERGE_SQL);
    },

    async cacheDraft(draft) {
      await write(cachedDraftStatements(draft));
    },

    async cacheBrief(brief) {
      await write(cachedBriefStatements(brief));
    },

    warmBriefs,
    warmEvents,

    async setReplyAll(threadId, replyAll) {
      await write([
        {
          sql: "insert into reply_prefs (thread_id, reply_all) values (?, ?) on conflict (thread_id) do update set reply_all = excluded.reply_all",
          params: [threadId, replyAll],
        },
      ]);
    },

    async write(statements) {
      await write(statements);
    },

    async applyBodies(bodies, at = now().toISOString()) {
      if (bodies.length === 0) return 0;
      const ids = bodies.map((b) => b.id);
      const known = new Set(
        (
          await driver.query(
            `select id from messages where id in (${ids.map(() => "?").join(", ")})`,
            ids,
          )
        ).map((r) => String(r.id)),
      );
      const landing = bodies.filter((b) => known.has(b.id));
      await write(landing.flatMap((b) => bodyStatements(b, at)));
      if (landing.length > 0) await driver.exec(FTS_MERGE_SQL);
      return landing.length;
    },

    sync,

    subscribe() {
      if (subscribed) return disconnect;
      subscribed = true;
      attempt = 0;
      connect();
      return disconnect;
    },

    status: () => status,

    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },

    progress: () => progress,

    onProgress(listener) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },

    async close() {
      disconnect();
      closed = true;
      for (const entry of [...lives]) lives.delete(entry);
      if (inflight) await inflight.catch(() => {});
      await driver.close();
    },
  };

  return store;
}
