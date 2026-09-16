// Mailstore: envelope encryption, threads, messages, labels, tags and
// attachments behind one interface (ADR 0009). Every write that carries
// content goes through storeContent; every read of content goes through
// readContent; the list projection never decrypts.
//
// Locked servers: storeContent and readContent throw LockedError, so a content
// write or read while no root key is in memory fails before any row is
// touched. Header-only operations (listThreads, setLabels, setTags, applyIntent)
// work locked. Queueing content writes for a locked Cloud is a later slice.
//
// Changes feed: every write a client cares about appends a row to `changes`
// through recordChange, inside the same transaction, and NOTIFYs the in-process
// listeners (src/changes/bus.ts). Intents from the Outbox go through applyIntent,
// which applies per-field last-writer-wins (packages/shared sync.ts) and logs
// the losers to `activity`.

import type {
  Account,
  Change,
  ChangeKind,
  ChangePayload,
  ChangesPage,
  ContentRef,
  FieldWrites,
  GroupId,
  Id,
  Intent,
  IntentResult,
  IsoDate,
  Person,
  Section,
  Thread,
  ThreadChange,
  Workspace,
} from "@monday/shared";
import { FIELD_GROUP_OF, resolveWrite } from "@monday/shared";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { CHANGES_CHANNEL, encodeNotice } from "../changes/bus.ts";
import { CHUNK_BYTES } from "../crypto/aead.ts";
import { type Keys, LockedError } from "../crypto/keys.ts";
import type { Db, Tx } from "../db/client.ts";
import {
  accounts,
  activity,
  attachments,
  blobChunks,
  blobs,
  changes,
  labels,
  messages,
  tags,
  threadLabels,
  threads,
  threadTags,
  workspaces,
} from "../db/schema.ts";
import { type ContentStore, createContentStore } from "./content.ts";

export type { ContentStore } from "./content.ts";
export { CONTENT_KINDS, createContentStore, isContentKind } from "./content.ts";

/** How much of the subject the headers index keeps in the clear. */
export const SUBJECT_SEARCH_CHARS = 80;

export interface ThreadInput {
  workspaceId: Id;
  providerThreadId: string;
  subject: string;
  participants: Person[];
  lastActivity: IsoDate;
  unread?: boolean;
  starred?: boolean;
  archived?: boolean;
  snoozedUntil?: IsoDate | null;
  section?: Section | null;
  group?: GroupId | null;
  subgroup?: GroupId | null;
}

export interface MessageInput {
  threadId: Id;
  providerMessageId: string;
  from: Person;
  to: Person[];
  cc: Person[];
  date: IsoDate;
  headers: Record<string, string>;
  bodyText: string;
  bodyHtml: string | null;
  snippet: string;
}

export interface MessageBody {
  text: string;
  html: string | null;
  snippet: string;
}

export interface AttachmentInput {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  /** Extracted text, when the caller already has it. */
  text?: string;
}

export interface AttachmentContent {
  id: Id;
  name: string;
  mediaType: string;
  size: number;
  bytes: Uint8Array;
  text: string | null;
}

export interface ListThreadsOptions {
  section?: Section;
  group?: GroupId;
  limit: number;
  cursor?: string | null;
  /** Archived Threads are out of the stream unless asked for. */
  includeArchived?: boolean;
}

export interface ThreadPage {
  threads: Thread[];
  /** Pass back to get the next page; null when this was the last one. */
  cursor: string | null;
}

/** What a module appends to the Changes feed; seq and at are assigned on insert. */
export type ChangeInput = ChangePayload & { workspaceId: Id; entityId: Id };

export interface ListChangesOptions {
  /** Return rows with seq greater than this; 0 for everything. */
  since: number;
  limit: number;
}

export interface Mailstore extends ContentStore {
  createWorkspace(account: Account): Promise<Workspace>;
  /**
   * Appends a row to the Changes feed inside `executor`'s transaction and
   * notifies in-process listeners. Every Mailstore write calls this; other
   * modules that write client-visible rows (routing, briefs) call it too rather
   * than inserting into `changes` themselves. Returns the seq.
   */
  recordChange(executor: Db | Tx, change: ChangeInput): Promise<number>;
  /** The feed from a cursor, ordered by seq. */
  listChanges(workspaceId: Id, options: ListChangesOptions): Promise<ChangesPage>;
  /** The newest seq in the Workspace; 0 when the feed is empty. */
  latestSeq(workspaceId: Id): Promise<number>;
  /**
   * Applies one Outbox intent under per-field last-writer-wins (ADR 0005). A
   * winning intent updates the row and records a change; a losing one is
   * written to the Activity log and reported with `applied: false`.
   */
  applyIntent(intent: Intent): Promise<IntentResult>;
  /** Insert or update by (workspace, provider thread id). Encrypts the subject. */
  upsertThread(input: ThreadInput): Promise<Id>;
  /** Insert or update by (workspace, provider message id). Encrypts body and snippet. */
  upsertMessage(input: MessageInput): Promise<Id>;
  readMessageBody(messageId: Id): Promise<MessageBody>;
  readThreadSubject(threadId: Id): Promise<string>;
  putAttachment(messageId: Id, input: AttachmentInput): Promise<Id>;
  readAttachment(attachmentId: Id): Promise<AttachmentContent>;
  upsertLabel(workspaceId: Id, label: { providerId: string; name: string }): Promise<Id>;
  upsertTag(workspaceId: Id, name: string): Promise<Id>;
  setLabels(threadId: Id, labelIds: Id[]): Promise<void>;
  setTags(threadId: Id, tagIds: Id[]): Promise<void>;
  /**
   * The header projection, newest activity first, without decrypting anything.
   * `subject` carries subject_search (the lowercased 80-character prefix) and
   * `snippet` is empty; the reader fetches both through readThreadSubject and
   * readMessageBody.
   */
  listThreads(workspaceId: Id, options: ListThreadsOptions): Promise<ThreadPage>;
  /** New K_ws; every wrapped data key in the Workspace is re-wrapped, no ciphertext is read. */
  rotateWorkspaceKey(workspaceId: Id): Promise<{ version: number; rewrapped: number }>;
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(
    readonly entity: "thread" | "message" | "attachment" | "workspace",
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
    this.name = "NotFoundError";
  }
}

/** The one plaintext derivative of a subject: lowercased, whitespace collapsed, 80 chars. */
export function subjectSearchOf(subject: string): string {
  return subject.toLowerCase().replace(/\s+/g, " ").trim().slice(0, SUBJECT_SEARCH_CHARS);
}

function encodeCursor(lastActivity: Date, id: string): string {
  return btoa(`${lastActivity.getTime()}:${id}`).replaceAll("=", "");
}

function decodeCursor(cursor: string): { lastActivity: Date; id: string } | null {
  try {
    const text = atob(cursor);
    const sep = text.indexOf(":");
    if (sep < 1) return null;
    const ms = Number(text.slice(0, sep));
    if (!Number.isFinite(ms)) return null;
    return { lastActivity: new Date(ms), id: text.slice(sep + 1) };
  } catch {
    return null;
  }
}

const singleRef = (
  workspaceId: string,
  kind: ContentRef["kind"],
  key: Uint8Array,
  envelope: Uint8Array,
): ContentRef => ({ workspaceId, kind, key, chunks: [envelope], size: -1 });

type ThreadRow = typeof threads.$inferSelect;

/** The header projection the list and the Changes feed share: nothing decrypted. */
function projectThread(r: ThreadRow, tagIds: string[], labelIds: string[]): ThreadChange {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    subject: r.subjectSearch,
    participants: r.participants,
    lastActivity: r.lastActivity.toISOString(),
    messageCount: r.messageCount,
    unread: r.unread,
    starred: r.starred,
    archived: r.archived,
    snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
    section: r.section,
    group: r.groupId,
    subgroup: r.subgroupId,
    tags: tagIds,
    labels: labelIds,
    hasAttachments: r.hasAttachments,
    snippet: "",
    deleted: r.deleted,
  };
}

/** The columns an intent sets, before the write stamp is added. */
function intentColumns(intent: Intent): Partial<ThreadRow> {
  switch (intent.kind) {
    case "archive":
      return { archived: true };
    case "unarchive":
      return { archived: false };
    case "star":
      return { starred: true };
    case "unstar":
      return { starred: false };
    case "read":
      return { unread: false };
    case "unread":
      return { unread: true };
    case "snooze":
      return { snoozedUntil: new Date(intent.until), archived: true };
    case "unsnooze":
      return { snoozedUntil: null, archived: false };
    case "move":
      return { groupId: intent.group, subgroupId: intent.subgroup };
    case "delete":
      return { deleted: true };
    case "undelete":
      return { deleted: false };
    case "tags":
      return {};
  }
}

function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case "snooze":
      return `snooze until ${intent.until}`;
    case "move":
      return `move to ${intent.group ?? "no group"}${intent.subgroup ? ` / ${intent.subgroup}` : ""}`;
    case "tags":
      return `set tags ${intent.tags.join(", ") || "(none)"}`;
    default:
      return intent.kind;
  }
}

export function createMailstore(db: Db, keys: Keys): Mailstore {
  const content = createContentStore(keys);

  const requireThread = async (executor: Db | Tx, threadId: string) => {
    const row = await executor.query.threads.findFirst({ where: eq(threads.id, threadId) });
    if (!row) throw new NotFoundError("thread", threadId);
    return row;
  };

  const requireMessage = async (executor: Db | Tx, messageId: string) => {
    const row = await executor.query.messages.findFirst({ where: eq(messages.id, messageId) });
    if (!row) throw new NotFoundError("message", messageId);
    return row;
  };

  const linksOf = async (executor: Db | Tx, threadId: string) => {
    const tagRows = await executor
      .select({ id: threadTags.tagId })
      .from(threadTags)
      .where(eq(threadTags.threadId, threadId));
    const labelRows = await executor
      .select({ id: threadLabels.labelId })
      .from(threadLabels)
      .where(eq(threadLabels.threadId, threadId));
    return { tagIds: tagRows.map((r) => r.id), labelIds: labelRows.map((r) => r.id) };
  };

  /** Records a "thread" change carrying the row's current projection. */
  const recordThread = async (executor: Db | Tx, threadId: string) => {
    const row = await requireThread(executor, threadId);
    const { tagIds, labelIds } = await linksOf(executor, threadId);
    return store.recordChange(executor, {
      workspaceId: row.workspaceId,
      kind: "thread",
      entityId: row.id,
      payload: projectThread(row, tagIds, labelIds),
    });
  };

  const store: Mailstore = {
    storeContent: content.storeContent,
    readContent: content.readContent,
    readText: content.readText,

    async recordChange(executor, change) {
      const rows = await executor
        .insert(changes)
        .values({
          workspaceId: change.workspaceId,
          kind: change.kind,
          entityId: change.entityId,
          payload: change.payload,
        })
        .returning({ seq: changes.seq });
      const seq = rows[0]?.seq;
      if (seq === undefined) throw new Error("recordChange returned no row");
      const notice = encodeNotice({ workspaceId: change.workspaceId, seq });
      await executor.execute(sql`select pg_notify(${CHANGES_CHANNEL}, ${notice})`);
      return seq;
    },

    async listChanges(workspaceId, options) {
      const limit = Math.max(1, Math.min(options.limit, 1000));
      const rows = await db
        .select()
        .from(changes)
        .where(and(eq(changes.workspaceId, workspaceId), gt(changes.seq, options.since)))
        .orderBy(asc(changes.seq))
        .limit(limit);
      const list: Change[] = rows.map(
        (r) =>
          ({
            seq: r.seq,
            workspaceId: r.workspaceId,
            kind: r.kind as ChangeKind,
            entityId: r.entityId,
            payload: r.payload,
            at: r.at.toISOString(),
          }) as Change,
      );
      const last = list[list.length - 1];
      return { changes: list, cursor: last ? last.seq : options.since };
    },

    async latestSeq(workspaceId) {
      const [row] = await db
        .select({ seq: sql<number | null>`max(${changes.seq})::bigint` })
        .from(changes)
        .where(eq(changes.workspaceId, workspaceId));
      return Number(row?.seq ?? 0);
    },

    async applyIntent(intent) {
      return db.transaction(async (tx) => {
        const row = await requireThread(tx, intent.threadId);
        const group = FIELD_GROUP_OF[intent.kind];
        const last = row.writes[group] ?? null;
        const resolution = resolveWrite(intent, last);
        if (!resolution.wins) {
          await tx.insert(activity).values({
            id: crypto.randomUUID(),
            workspaceId: row.workspaceId,
            actor: intent.actor,
            tool: `thread.${intent.kind}`,
            summary: `${describeIntent(intent)} on thread ${row.id} not applied: ${resolution.reason}`,
            at: new Date(intent.at),
          });
          return { applied: false, reason: resolution.reason };
        }
        const writes: FieldWrites = {
          ...row.writes,
          [group]: { at: intent.at, by: intent.actor },
        };
        if (intent.kind === "tags") {
          await tx.delete(threadTags).where(eq(threadTags.threadId, row.id));
          const ids = [...new Set(intent.tags)];
          if (ids.length > 0) {
            await tx.insert(threadTags).values(ids.map((tagId) => ({ threadId: row.id, tagId })));
          }
          await tx
            .update(threads)
            .set({ writes, updatedAt: new Date() })
            .where(eq(threads.id, row.id));
          await store.recordChange(tx, {
            workspaceId: row.workspaceId,
            kind: "thread_tags",
            entityId: row.id,
            payload: { threadId: row.id, ids },
          });
          return { applied: true };
        }
        await tx
          .update(threads)
          .set({ ...intentColumns(intent), writes, updatedAt: new Date() })
          .where(eq(threads.id, row.id));
        await recordThread(tx, row.id);
        return { applied: true };
      });
    },

    async createWorkspace(account) {
      const workspaceId = crypto.randomUUID();
      // Fail before any row exists if the server is locked.
      if (!keys.isUnlocked()) throw new LockedError();
      await db.transaction(async (tx) => {
        await tx.insert(accounts).values({
          id: account.id,
          provider: account.provider,
          address: account.address,
          displayName: account.displayName,
          capabilities: account.capabilities,
        });
        await tx.insert(workspaces).values({ id: workspaceId, accountId: account.id });
        await keys.createWorkspaceKey(workspaceId, tx);
      });
      return { id: workspaceId, accountId: account.id };
    },

    async upsertThread(input) {
      const subject = await content.storeContent(input.workspaceId, "subject", input.subject);
      const subjectEnc = subject.chunks[0];
      if (!subjectEnc) throw new RangeError("subject envelope missing");
      const id = crypto.randomUUID();
      const now = new Date();
      const values = {
        subjectEnc,
        subjectKey: subject.key,
        subjectSearch: subjectSearchOf(input.subject),
        participants: input.participants,
        lastActivity: new Date(input.lastActivity),
        unread: input.unread ?? false,
        starred: input.starred ?? false,
        archived: input.archived ?? false,
        snoozedUntil: input.snoozedUntil ? new Date(input.snoozedUntil) : null,
        section: input.section ?? null,
        groupId: input.group ?? null,
        subgroupId: input.subgroup ?? null,
        updatedAt: now,
      };
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(threads)
          .values({
            id,
            workspaceId: input.workspaceId,
            providerThreadId: input.providerThreadId,
            ...values,
          })
          .onConflictDoUpdate({
            target: [threads.workspaceId, threads.providerThreadId],
            set: values,
          })
          .returning({ id: threads.id });
        const stored = rows[0]?.id;
        if (!stored) throw new Error("upsertThread returned no row");
        await recordThread(tx, stored);
        return stored;
      });
    },

    async upsertMessage(input) {
      const thread = await requireThread(db, input.threadId);
      const workspaceId = thread.workspaceId;
      const body = await content.storeContent(
        workspaceId,
        "body",
        JSON.stringify({ text: input.bodyText, html: input.bodyHtml }),
      );
      const snippet = await content.storeContent(workspaceId, "snippet", input.snippet);
      const bodyEnc = body.chunks[0];
      const snippetEnc = snippet.chunks[0];
      if (!bodyEnc || !snippetEnc) throw new RangeError("envelope missing");
      const id = crypto.randomUUID();
      const date = new Date(input.date);
      const values = {
        threadId: input.threadId,
        from: input.from,
        to: input.to,
        cc: input.cc,
        date,
        headers: input.headers,
        bodyEnc,
        bodyKey: body.key,
        snippetEnc,
        snippetKey: snippet.key,
      };
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(messages)
          .values({
            id,
            workspaceId,
            providerMessageId: input.providerMessageId,
            ...values,
          })
          .onConflictDoUpdate({
            target: [messages.workspaceId, messages.providerMessageId],
            set: values,
          })
          .returning({ id: messages.id });
        const stored = rows[0]?.id;
        if (!stored) throw new Error("upsertMessage returned no row");
        await refreshThread(tx, input.threadId);
        const message = await requireMessage(tx, stored);
        await store.recordChange(tx, {
          workspaceId,
          kind: "message",
          entityId: stored,
          payload: {
            id: stored,
            threadId: input.threadId,
            from: message.from,
            to: message.to,
            cc: message.cc,
            date: message.date.toISOString(),
            hasAttachments: message.hasAttachments,
          },
        });
        await recordThread(tx, input.threadId);
        return stored;
      });
    },

    async readMessageBody(messageId) {
      const row = await requireMessage(db, messageId);
      const body = JSON.parse(
        await content.readText(singleRef(row.workspaceId, "body", row.bodyKey, row.bodyEnc)),
      ) as { text: string; html: string | null };
      const snippet = await content.readText(
        singleRef(row.workspaceId, "snippet", row.snippetKey, row.snippetEnc),
      );
      return { text: body.text, html: body.html, snippet };
    },

    async readThreadSubject(threadId) {
      const row = await requireThread(db, threadId);
      return content.readText(
        singleRef(row.workspaceId, "subject", row.subjectKey, row.subjectEnc),
      );
    },

    async putAttachment(messageId, input) {
      const message = await requireMessage(db, messageId);
      const workspaceId = message.workspaceId;
      const blob = await content.storeContent(workspaceId, "attachment", input.bytes);
      const text =
        input.text === undefined
          ? null
          : await content.storeContent(workspaceId, "attachment-text", input.text);
      const blobId = crypto.randomUUID();
      const attachmentId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(blobs).values({
          id: blobId,
          workspaceId,
          size: blob.size,
          chunkSize: CHUNK_BYTES,
          chunkCount: blob.chunks.length,
          key: blob.key,
        });
        await tx
          .insert(blobChunks)
          .values(blob.chunks.map((data, index) => ({ blobId, index, data })));
        await tx.insert(attachments).values({
          id: attachmentId,
          messageId,
          workspaceId,
          name: input.name,
          size: input.bytes.length,
          mediaType: input.mediaType,
          blobId,
          textEnc: text?.chunks[0] ?? null,
          textKey: text?.key ?? null,
        });
        await tx.update(messages).set({ hasAttachments: true }).where(eq(messages.id, messageId));
        await tx
          .update(threads)
          .set({ hasAttachments: true, updatedAt: new Date() })
          .where(eq(threads.id, message.threadId));
        await store.recordChange(tx, {
          workspaceId,
          kind: "message",
          entityId: messageId,
          payload: {
            id: messageId,
            threadId: message.threadId,
            from: message.from,
            to: message.to,
            cc: message.cc,
            date: message.date.toISOString(),
            hasAttachments: true,
          },
        });
        await recordThread(tx, message.threadId);
      });
      return attachmentId;
    },

    async readAttachment(attachmentId) {
      const row = await db.query.attachments.findFirst({
        where: eq(attachments.id, attachmentId),
      });
      if (!row) throw new NotFoundError("attachment", attachmentId);
      if (!row.blobId) throw new NotFoundError("attachment", attachmentId);
      const blob = await db.query.blobs.findFirst({ where: eq(blobs.id, row.blobId) });
      if (!blob) throw new NotFoundError("attachment", attachmentId);
      const chunkRows = await db
        .select({ index: blobChunks.index, data: blobChunks.data })
        .from(blobChunks)
        .where(eq(blobChunks.blobId, blob.id))
        .orderBy(asc(blobChunks.index));
      const chunks: Uint8Array[] = [];
      for (const [position, chunk] of chunkRows.entries()) {
        if (chunk.index !== position) throw new RangeError(`blob ${blob.id} chunk ${position}`);
        chunks.push(chunk.data);
      }
      if (chunks.length !== blob.chunkCount) {
        throw new RangeError(`blob ${blob.id} has ${chunks.length}/${blob.chunkCount} chunks`);
      }
      const bytes = await content.readContent({
        workspaceId: row.workspaceId,
        kind: "attachment",
        key: blob.key,
        chunks,
        size: blob.size,
      });
      const text =
        row.textEnc && row.textKey
          ? await content.readText(
              singleRef(row.workspaceId, "attachment-text", row.textKey, row.textEnc),
            )
          : null;
      return {
        id: row.id,
        name: row.name,
        mediaType: row.mediaType,
        size: row.size,
        bytes,
        text,
      };
    },

    async upsertLabel(workspaceId, label) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(labels)
          .values({ id: crypto.randomUUID(), workspaceId, ...label })
          .onConflictDoUpdate({
            target: [labels.workspaceId, labels.providerId],
            set: { name: label.name },
          })
          .returning({ id: labels.id });
        const id = rows[0]?.id;
        if (!id) throw new Error("upsertLabel returned no row");
        await store.recordChange(tx, {
          workspaceId,
          kind: "label",
          entityId: id,
          payload: { id, name: label.name, providerId: label.providerId },
        });
        return id;
      });
    },

    async upsertTag(workspaceId, name) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(tags)
          .values({ id: crypto.randomUUID(), workspaceId, name })
          .onConflictDoUpdate({ target: [tags.workspaceId, tags.name], set: { name } })
          .returning({ id: tags.id });
        const id = rows[0]?.id;
        if (!id) throw new Error("upsertTag returned no row");
        await store.recordChange(tx, {
          workspaceId,
          kind: "tag",
          entityId: id,
          payload: { id, name },
        });
        return id;
      });
    },

    async setLabels(threadId, labelIds) {
      const thread = await requireThread(db, threadId);
      const ids = [...new Set(labelIds)];
      await db.transaction(async (tx) => {
        await tx.delete(threadLabels).where(eq(threadLabels.threadId, threadId));
        if (ids.length > 0) {
          await tx.insert(threadLabels).values(ids.map((labelId) => ({ threadId, labelId })));
        }
        await store.recordChange(tx, {
          workspaceId: thread.workspaceId,
          kind: "thread_labels",
          entityId: threadId,
          payload: { threadId, ids },
        });
      });
    },

    async setTags(threadId, tagIds) {
      const thread = await requireThread(db, threadId);
      const ids = [...new Set(tagIds)];
      await db.transaction(async (tx) => {
        await tx.delete(threadTags).where(eq(threadTags.threadId, threadId));
        if (ids.length > 0) {
          await tx.insert(threadTags).values(ids.map((tagId) => ({ threadId, tagId })));
        }
        await store.recordChange(tx, {
          workspaceId: thread.workspaceId,
          kind: "thread_tags",
          entityId: threadId,
          payload: { threadId, ids },
        });
      });
    },

    async listThreads(workspaceId, options) {
      const limit = Math.max(1, Math.min(options.limit, 500));
      const after = options.cursor ? decodeCursor(options.cursor) : null;
      if (options.cursor && !after) throw new RangeError("bad cursor");
      // Trash is its own view, later; the list never shows deleted Threads.
      const conditions = [eq(threads.workspaceId, workspaceId), eq(threads.deleted, false)];
      if (!options.includeArchived) conditions.push(eq(threads.archived, false));
      if (options.section !== undefined) conditions.push(eq(threads.section, options.section));
      if (options.group !== undefined) {
        conditions.push(
          or(eq(threads.groupId, options.group), eq(threads.subgroupId, options.group)) ??
            sql`false`,
        );
      }
      if (after) {
        conditions.push(
          or(
            lt(threads.lastActivity, after.lastActivity),
            and(eq(threads.lastActivity, after.lastActivity), lt(threads.id, after.id)),
          ) ?? sql`false`,
        );
      }
      const rows = await db
        .select()
        .from(threads)
        .where(and(...conditions))
        .orderBy(desc(threads.lastActivity), desc(threads.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const ids = page.map((r) => r.id);
      const labelsByThread = new Map<string, string[]>();
      const tagsByThread = new Map<string, string[]>();
      if (ids.length > 0) {
        const labelRows = await db
          .select()
          .from(threadLabels)
          .where(inArray(threadLabels.threadId, ids));
        for (const r of labelRows) {
          labelsByThread.set(r.threadId, [...(labelsByThread.get(r.threadId) ?? []), r.labelId]);
        }
        const tagRows = await db.select().from(threadTags).where(inArray(threadTags.threadId, ids));
        for (const r of tagRows) {
          tagsByThread.set(r.threadId, [...(tagsByThread.get(r.threadId) ?? []), r.tagId]);
        }
      }
      const projected: Thread[] = page.map((r) =>
        projectThread(r, tagsByThread.get(r.id) ?? [], labelsByThread.get(r.id) ?? []),
      );
      const last = page[page.length - 1];
      const cursor = rows.length > limit && last ? encodeCursor(last.lastActivity, last.id) : null;
      return { threads: projected, cursor };
    },

    async rotateWorkspaceKey(workspaceId) {
      return keys.rotateWorkspaceKey(workspaceId, async (tx, rewrap) => {
        let count = 0;
        const scope = eq(threads.workspaceId, workspaceId);
        for (const row of await tx
          .select({ id: threads.id, key: threads.subjectKey })
          .from(threads)
          .where(scope)) {
          await tx
            .update(threads)
            .set({ subjectKey: rewrap(row.key) })
            .where(eq(threads.id, row.id));
          count += 1;
        }
        for (const row of await tx
          .select({ id: messages.id, bodyKey: messages.bodyKey, snippetKey: messages.snippetKey })
          .from(messages)
          .where(eq(messages.workspaceId, workspaceId))) {
          await tx
            .update(messages)
            .set({ bodyKey: rewrap(row.bodyKey), snippetKey: rewrap(row.snippetKey) })
            .where(eq(messages.id, row.id));
          count += 2;
        }
        for (const row of await tx
          .select({ id: attachments.id, textKey: attachments.textKey })
          .from(attachments)
          .where(eq(attachments.workspaceId, workspaceId))) {
          if (!row.textKey) continue;
          await tx
            .update(attachments)
            .set({ textKey: rewrap(row.textKey) })
            .where(eq(attachments.id, row.id));
          count += 1;
        }
        for (const row of await tx
          .select({ id: blobs.id, key: blobs.key })
          .from(blobs)
          .where(eq(blobs.workspaceId, workspaceId))) {
          await tx
            .update(blobs)
            .set({ key: rewrap(row.key) })
            .where(eq(blobs.id, row.id));
          count += 1;
        }
        return count;
      });
    },
  };

  return store;
}

/** Recomputes the counters a Thread derives from its Messages. */
async function refreshThread(tx: Tx, threadId: string): Promise<void> {
  const [agg] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      latest: sql<Date | null>`max(${messages.date})`,
      attachments: sql<boolean>`coalesce(bool_or(${messages.hasAttachments}), false)`,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId));
  const latest = agg?.latest ? new Date(agg.latest) : null;
  await tx
    .update(threads)
    .set({
      messageCount: agg?.count ?? 0,
      hasAttachments: agg?.attachments ?? false,
      ...(latest
        ? {
            lastActivity: sql`greatest(${threads.lastActivity}, ${latest.toISOString()}::timestamptz)`,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(threads.id, threadId));
}
