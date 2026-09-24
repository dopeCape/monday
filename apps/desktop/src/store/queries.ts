// The SQL the screens run against the Cache, with the row mappers that turn
// SQLite rows (0/1, JSON text) back into domain objects. Screens import these
// rather than writing SQL inline, so the schema has one client.

import type {
  Brief,
  BriefPolicy,
  DecisionCandidate,
  Draft,
  DraftAttachment,
  Group,
  Message,
  Person,
  Predicate,
  Rule,
  ScheduledSend,
  SectionRule,
  SendError,
  Tag,
  Thread,
  ThreadJudgments,
} from "@monday/shared";
import type { Row, SqlParam } from "./driver.ts";

const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
const bool = (value: unknown) => value === 1 || value === true;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const nullable = (value: unknown) => (typeof value === "string" ? value : null);

/** Threads in the stream, newest first, with their tag ids in the order they were applied. */
export const INBOX_THREADS_SQL = `
  select t.*,
    (select group_concat(tag_id) from (select tag_id from thread_tags where thread_id = t.id order by rowid)) as tag_ids,
    (select group_concat(label_id) from (select label_id from thread_labels where thread_id = t.id order by rowid)) as label_ids
  from threads t
  where t.archived = 0 and t.deleted = 0 and t.snoozed_until is null
  order by t.last_activity desc, t.rid desc`;

/**
 * The columns a Thread list row carries: the Thread, its tag and label ids in
 * the order they were applied, the newest Message's sender for the Section
 * rules ("lastFrom") and the Thread's Judgments (slice 25) as `j_*` columns.
 * Read over `threads t left join thread_judgments j`.
 */
const THREAD_LIST_COLUMNS = `t.*,
    (select group_concat(tag_id) from (select tag_id from thread_tags where thread_id = t.id order by rowid)) as tag_ids,
    (select group_concat(label_id) from (select label_id from thread_labels where thread_id = t.id order by rowid)) as label_ids,
    (select json_extract(m.sender, '$.email') from messages m where m.thread_id = t.id order by m.date desc, m.id desc limit 1) as last_sender,
    j.needs_reply as j_needs_reply, j.waiting_on_others as j_waiting_on_others, j.newsletter as j_newsletter,
    j.automated as j_automated, j.brief_worth as j_brief_worth, j.urgency as j_urgency,
    j.chips as j_chips, j.model as j_model, j.judged_at as j_judged_at`;

/**
 * Every Thread the Cache holds, trash included, newest first, with the
 * newest Message's sender for the Section rules ("lastFrom") and the
 * Thread's Judgments (slice 25) for the judged conditions and the chips.
 * The Inbox reads it in pages (threadPageSql) or by id, never whole.
 */
export const ALL_THREADS_SQL = `
  select ${THREAD_LIST_COLUMNS}
  from threads t
  left join thread_judgments j on j.thread_id = t.id
  order by t.last_activity desc, t.rid desc`;

/** ALL_THREADS_SQL for some Threads only: the rows a write named, or Threads asked for by id. */
export function threadsByIdsSql(count: number): string {
  const at = ALL_THREADS_SQL.lastIndexOf("order by");
  const marks = Array.from({ length: count }, () => "?").join(", ");
  return `${ALL_THREADS_SQL.slice(0, at)}where t.id in (${marks}) ${ALL_THREADS_SQL.slice(at)}`;
}

/** The Inbox: not archived, not in the trash, not snoozed (over `threads t`). */
export const INBOX_WHERE = "t.archived = 0 and t.deleted = 0 and t.snoozed_until is null";

/** The newest Message's sender address, as a correlated expression over `threads t`. */
export const LAST_SENDER_SQL =
  "(select json_extract(m.sender, '$.email') from messages m where m.thread_id = t.id order by m.date desc, m.id desc limit 1)";

/** One key of a Thread list's order: a column of `threads`, and its direction. */
export interface ThreadListOrder {
  column: "last_activity" | "rid" | "snoozed_until";
  desc: boolean;
}

/** Newest activity first, the rowid breaking ties: the Inbox's order and every folder's but Snoozed. */
export const NEWEST_FIRST: readonly ThreadListOrder[] = [
  { column: "last_activity", desc: true },
  { column: "rid", desc: true },
];

/** A Thread list as SQL: which rows (over `threads t`), with what params, in what order. */
export interface ThreadListQuery {
  where: string;
  params: readonly SqlParam[];
  order: readonly ThreadListOrder[];
}

/**
 * One page of a Thread list: the `limit` rows after `after` (a row of the
 * list, or null for the first page), in the list's order. The rows are
 * chosen through the index first and only those are read whole, so the
 * per-row subqueries run for the page alone, never for the whole Cache.
 */
export function threadPageSql(
  list: ThreadListQuery,
  after: Row | null,
  limit: number,
): { sql: string; params: SqlParam[] } {
  const orderBy = list.order.map((o) => `t.${o.column} ${o.desc ? "desc" : "asc"}`).join(", ");
  const keyParams: SqlParam[] = [];
  let keyset = "";
  if (after) {
    // (a < ?) or (a = ? and ((b < ?) or (b = ? and c < ?))): built from the last key outwards,
    // bound in reading order, every key but the last twice.
    let expr = "";
    for (let i = list.order.length - 1; i >= 0; i--) {
      const o = list.order[i] as ThreadListOrder;
      const cmp = `t.${o.column} ${o.desc ? "<" : ">"} ?`;
      expr = expr ? `(${cmp} or (t.${o.column} = ? and ${expr}))` : cmp;
    }
    keyset = ` and ${expr}`;
    list.order.forEach((o, i) => {
      const value = (after[o.column] ?? null) as SqlParam;
      keyParams.push(value);
      if (i < list.order.length - 1) keyParams.push(value);
    });
  }
  const sql = `
  select ${THREAD_LIST_COLUMNS}
  from threads t
  left join thread_judgments j on j.thread_id = t.id
  where t.rid in (select t.rid from threads t where (${list.where})${keyset} order by ${orderBy} limit ?)
  order by ${orderBy}`;
  return { sql, params: [...list.params, ...keyParams, limit] };
}

/**
 * The Inbox's totals over the whole Cache, in one read: how many Threads are
 * in the Inbox ('inbox'), how many are snoozed ('snoozed'), and the unread
 * Inbox Threads per Group, Sub-group and star ('unread' rows).
 */
export const INBOX_COUNTS_SQL = `
  select 'inbox' as k, null as group_id, null as subgroup_id, 0 as starred, count(*) as n
    from threads t where ${INBOX_WHERE}
  union all
  select 'snoozed', null, null, 0, count(*)
    from threads t where t.deleted = 0 and t.snoozed_until is not null
  union all
  select 'unread', t.group_id, t.subgroup_id, t.starred, count(*)
    from threads t where t.unread = 1 and ${INBOX_WHERE}
    group by t.group_id, t.subgroup_id, t.starred`;

/** The Judgments joined onto a Thread row as `j_*` columns, or null when the Thread is not judged yet. */
export function rowToJudgments(r: Row): ThreadJudgments | null {
  if (typeof r.j_judged_at !== "string" || r.j_judged_at === "") return null;
  const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0) || 0);
  return {
    threadId: text(r.id),
    needsReply: num(r.j_needs_reply),
    waitingOnOthers: num(r.j_waiting_on_others),
    newsletter: num(r.j_newsletter),
    automated: num(r.j_automated),
    briefWorth: num(r.j_brief_worth),
    urgency: num(r.j_urgency),
    chips: json<Record<string, number>>(r.j_chips, {}),
    model: text(r.j_model),
    judgedAt: r.j_judged_at,
  };
}

export const THREAD_BY_ID_SQL = `
  select t.*,
    (select group_concat(tag_id) from (select tag_id from thread_tags where thread_id = t.id order by rowid)) as tag_ids,
    (select group_concat(label_id) from (select label_id from thread_labels where thread_id = t.id order by rowid)) as label_ids
  from threads t where t.id = ?`;

export function rowToThread(r: Row, workspaceId: string): Thread {
  return {
    id: text(r.id),
    workspaceId,
    subject: text(r.subject),
    participants: json<Person[]>(r.participants, []),
    lastActivity: text(r.last_activity),
    messageCount: Number(r.message_count ?? 0),
    unread: bool(r.unread),
    starred: bool(r.starred),
    archived: bool(r.archived),
    snoozedUntil: nullable(r.snoozed_until),
    section: nullable(r.section),
    group: nullable(r.group_id),
    subgroup: nullable(r.subgroup_id),
    tags: text(r.tag_ids) ? text(r.tag_ids).split(",") : [],
    labels: text(r.label_ids) ? text(r.label_ids).split(",") : [],
    hasAttachments: bool(r.has_attachments),
    snippet: text(r.snippet),
    bulk: bool(r.bulk),
  };
}

/** The Thread plus the trash flag the domain type does not carry, and the newest sender when selected. */
export function rowToCachedThread(
  r: Row,
  workspaceId: string,
): {
  thread: Thread;
  deleted: boolean;
  lastSender: string | null;
  judgments: ThreadJudgments | null;
} {
  return {
    thread: rowToThread(r, workspaceId),
    deleted: bool(r.deleted),
    lastSender: nullable(r.last_sender),
    judgments: rowToJudgments(r),
  };
}

export const SECTIONS_SQL = "select * from section_rules order by position, id";

export function rowToSection(r: Row, workspaceId: string): SectionRule {
  return {
    id: text(r.id),
    workspaceId,
    name: text(r.name),
    order: Number(r.position ?? 0),
    rule: json<Rule>(r.rule, { sentence: "", predicate: {}, prompt: "" }),
    hidden: bool(r.hidden),
  };
}

/** Groups, top-level first, in the order they were made (the feed inserts in creation order). */
export const GROUPS_SQL = "select * from groups order by parent_id is not null, rowid";

export function rowToGroup(r: Row, workspaceId: string): Group {
  const sentence = text(r.sentence);
  const policy = nullable(r.brief_policy);
  return {
    id: text(r.id),
    workspaceId,
    parentId: nullable(r.parent_id),
    name: text(r.name),
    // The revised prompt is content and stays on the Server; the sentence stands in for it here.
    rule: { sentence, predicate: json<Predicate>(r.predicate, {}), prompt: sentence },
    threshold: typeof r.threshold === "number" ? r.threshold : null,
    briefPolicy:
      policy === "always" || policy === "on_open" || policy === "never"
        ? (policy as BriefPolicy)
        : null,
  };
}

/** Needs a decision, newest first, with the Thread's headers alongside. */
export const DECISIONS_SQL = `
  select d.thread_id, d.candidates, d.at, t.subject, t.participants
  from decisions d left join threads t on t.id = d.thread_id
  order by d.at desc, d.thread_id`;

export interface CachedDecision {
  threadId: string;
  candidates: DecisionCandidate[];
  at: string;
  subject: string;
  participants: Person[];
}

export function rowToDecision(r: Row): CachedDecision {
  return {
    threadId: text(r.thread_id),
    candidates: json<DecisionCandidate[]>(r.candidates, []),
    at: text(r.at),
    subject: text(r.subject),
    participants: json<Person[]>(r.participants, []),
  };
}

export const TAGS_SQL = "select * from tags order by name";

export function rowToTag(r: Row, workspaceId: string): Tag {
  return { id: text(r.id), workspaceId, name: text(r.name) };
}

/** A Thread's Messages in date order with their attachments inlined as JSON. */
export const MESSAGES_OF_THREAD_SQL = `
  select m.*,
    (select json_group_array(json_object('id', a.id, 'name', a.name, 'size', a.size, 'mediaType', a.media_type, 'text', a.text))
       from attachments a where a.message_id = m.id) as attachments_json
  from messages m
  where m.thread_id = ?
  order by m.date, m.id`;

interface AttachmentRow {
  id: string;
  name: string;
  size: number;
  mediaType: string;
  text: string | null;
}

export function rowToMessage(r: Row): Message {
  const attachments = json<AttachmentRow[]>(r.attachments_json, []).map((a) => ({
    id: a.id,
    name: a.name,
    size: a.size,
    mediaType: a.mediaType,
    ...(a.text !== null ? { text: a.text } : {}),
  }));
  const bodyText = nullable(r.body_text);
  const bodyHtml = nullable(r.body_html);
  return {
    id: text(r.id),
    threadId: text(r.thread_id),
    from: json<Person>(r.sender, { name: "", email: "" }),
    to: json<Person[]>(r.recipients, []),
    cc: json<Person[]>(r.cc, []),
    date: text(r.date),
    ...(bodyText !== null ? { bodyText } : {}),
    ...(bodyHtml !== null ? { bodyHtml } : {}),
    attachments,
  };
}

export const BRIEF_OF_THREAD_SQL = "select * from briefs where thread_id = ?";

/** Brief rows whose content is older than their headers, for the Store to warm after a pull. */
export const BRIEFS_TO_WARM_SQL =
  "select thread_id from briefs where content_stale = 1 order by computed_at desc limit ?";

/**
 * A Brief the reader can show, or null while the row holds headers only. A
 * row whose content lags its headers shows the old bullets dimmed, as a
 * stale Brief does, until the fetch replaces them.
 */
export function rowToBrief(r: Row): Brief | null {
  // The bullets column holds the bullets alone, or with the judge's verdicts per bullet (slice 27).
  const stored = json<
    Brief["bullets"] | { bullets: Brief["bullets"]; verified?: Brief["verified"] }
  >(r.bullets, []);
  const bullets = Array.isArray(stored) ? stored : stored.bullets;
  const verified = Array.isArray(stored) ? undefined : stored.verified;
  if (bullets.length === 0) return null;
  return {
    threadId: text(r.thread_id),
    bullets,
    actions: json<Brief["actions"]>(r.actions, []),
    computedAt: text(r.computed_at),
    stale: bool(r.stale) || bool(r.content_stale),
    ...(verified ? { verified } : {}),
  };
}

/* ------------------------------ Drafts and sends (ADR 0010) ------------------------------ */

/** Every open Draft, newest first. */
export const DRAFTS_SQL =
  "select * from drafts where deleted = 0 and status <> 'sent' order by updated_at desc, id";

export const DRAFT_BY_ID_SQL = "select * from drafts where id = ?";

/** Open Drafts on one Thread, so a reply resumes where it left off. */
export const DRAFTS_OF_THREAD_SQL =
  "select * from drafts where thread_id = ? and deleted = 0 and status = 'open' order by updated_at desc";

export function rowToDraft(r: Row, workspaceId: string): Draft {
  const kind = text(r.kind);
  const status = text(r.status);
  const attachments = json<DraftAttachment[]>(r.attachments, []);
  return {
    id: text(r.id),
    workspaceId,
    threadId: nullable(r.thread_id),
    kind: kind === "reply" || kind === "forward" ? kind : "new",
    inReplyToMessageId: nullable(r.in_reply_to_message_id),
    to: json<Person[]>(r.recipients, []),
    cc: json<Person[]>(r.cc, []),
    bcc: json<Person[]>(r.bcc, []),
    subject: text(r.subject),
    bodyHtml: text(r.body_html),
    bodyText: text(r.body_text),
    attachments,
    attachmentBlobIds: attachments.map((a) => a.blobId),
    status: status === "scheduled" || status === "sent" ? status : "open",
    updatedAt: text(r.updated_at),
    updatedBy: text(r.updated_by),
  };
}

/** Whether a Draft's content is older than its headers and must be fetched before editing. */
export function rowDraftStale(r: Row): boolean {
  return bool(r.content_stale);
}

/** Sends still waiting to run, soonest first. */
export const PENDING_SENDS_SQL =
  "select * from sends where status = 'scheduled' order by run_at, id";

export const SENDS_SQL = "select * from sends order by run_at desc, id";

export const SEND_BY_ID_SQL = "select * from sends where id = ?";

export function rowToSend(r: Row, workspaceId: string): ScheduledSend {
  const status = text(r.status);
  return {
    id: text(r.id),
    workspaceId,
    draftId: text(r.draft_id),
    runAt: text(r.run_at),
    status:
      status === "cancelled" || status === "sent" || status === "failed" ? status : "scheduled",
    cancelledAt: nullable(r.cancelled_at),
    sentAt: nullable(r.sent_at),
    jobId: nullable(r.job_id),
    error: json<SendError | null>(r.error, null),
    createdAt: text(r.created_at),
  };
}

/** The reply-all choice for one Thread, or none. */
export const REPLY_PREF_SQL = "select reply_all from reply_prefs where thread_id = ?";

/**
 * Everyone the Cache has seen on a Thread, by most recent activity, for the
 * recipient autocomplete. One row per address; the first name seen wins.
 */
export const PARTICIPANTS_SQL = `
  select json_extract(value, '$.email') as email, json_extract(value, '$.name') as name, max(t.last_activity) as last
  from threads t, json_each(t.participants)
  where json_extract(value, '$.email') <> ''
  group by lower(json_extract(value, '$.email'))
  order by last desc
  limit 500`;

export function rowToPerson(r: Row): Person {
  return { name: text(r.name), email: text(r.email) };
}
