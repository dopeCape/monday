// The SQL the screens run against the Cache, with the row mappers that turn
// SQLite rows (0/1, JSON text) back into domain objects. Screens import these
// rather than writing SQL inline, so the schema has one client.

import type {
  Brief,
  Draft,
  DraftAttachment,
  Group,
  Message,
  Person,
  Rule,
  ScheduledSend,
  SectionRule,
  SendError,
  Tag,
  Thread,
} from "@monday/shared";
import type { Row } from "./driver.ts";

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

/** Every Thread the Cache holds, trash included, newest first. */
export const ALL_THREADS_SQL = `
  select t.*,
    (select group_concat(tag_id) from (select tag_id from thread_tags where thread_id = t.id order by rowid)) as tag_ids,
    (select group_concat(label_id) from (select label_id from thread_labels where thread_id = t.id order by rowid)) as label_ids
  from threads t
  order by t.last_activity desc, t.rid desc`;

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
  };
}

/** The Thread plus the trash flag the domain type does not carry. */
export function rowToCachedThread(
  r: Row,
  workspaceId: string,
): { thread: Thread; deleted: boolean } {
  return { thread: rowToThread(r, workspaceId), deleted: bool(r.deleted) };
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

export const GROUPS_SQL = "select * from groups order by name";

export function rowToGroup(r: Row, workspaceId: string): Group {
  return {
    id: text(r.id),
    workspaceId,
    parentId: nullable(r.parent_id),
    name: text(r.name),
    rule: json<Rule>(r.rule, { sentence: "", predicate: {}, prompt: "" }),
    threshold: typeof r.threshold === "number" ? r.threshold : null,
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

export function rowToBrief(r: Row): Brief {
  return {
    threadId: text(r.thread_id),
    bullets: json<Brief["bullets"]>(r.bullets, []),
    actions: json<Brief["actions"]>(r.actions, []),
    computedAt: text(r.computed_at),
    stale: bool(r.stale),
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
