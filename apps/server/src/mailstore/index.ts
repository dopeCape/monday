// Mailstore: envelope encryption, threads, messages, labels, tags and
// attachments behind one interface (ADR 0009). Every write that carries
// content goes through storeContent; every read of content goes through
// readContent; the list projection never decrypts.
//
// Locked servers: storeContent and readContent throw LockedError, so a content
// write or read while no root key is in memory fails before any row is
// touched. Header-only operations (listThreads, setLabels, setTags) work
// locked. Queueing content writes for a locked Cloud is a later slice.

import type {
  Account,
  ContentRef,
  GroupId,
  Id,
  IsoDate,
  Person,
  Section,
  Thread,
  Workspace,
} from "@monday/shared";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { CHUNK_BYTES } from "../crypto/aead.ts";
import { type Keys, LockedError } from "../crypto/keys.ts";
import type { Db, Tx } from "../db/client.ts";
import {
  accounts,
  attachments,
  blobChunks,
  blobs,
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

export interface Mailstore extends ContentStore {
  createWorkspace(account: Account): Promise<Workspace>;
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

  const store: Mailstore = {
    storeContent: content.storeContent,
    readContent: content.readContent,
    readText: content.readText,

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
      const rows = await db
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
      return stored;
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
      const rows = await db
        .insert(labels)
        .values({ id: crypto.randomUUID(), workspaceId, ...label })
        .onConflictDoUpdate({
          target: [labels.workspaceId, labels.providerId],
          set: { name: label.name },
        })
        .returning({ id: labels.id });
      const id = rows[0]?.id;
      if (!id) throw new Error("upsertLabel returned no row");
      return id;
    },

    async upsertTag(workspaceId, name) {
      const rows = await db
        .insert(tags)
        .values({ id: crypto.randomUUID(), workspaceId, name })
        .onConflictDoUpdate({ target: [tags.workspaceId, tags.name], set: { name } })
        .returning({ id: tags.id });
      const id = rows[0]?.id;
      if (!id) throw new Error("upsertTag returned no row");
      return id;
    },

    async setLabels(threadId, labelIds) {
      await requireThread(db, threadId);
      await db.transaction(async (tx) => {
        await tx.delete(threadLabels).where(eq(threadLabels.threadId, threadId));
        if (labelIds.length > 0) {
          await tx
            .insert(threadLabels)
            .values([...new Set(labelIds)].map((labelId) => ({ threadId, labelId })));
        }
      });
    },

    async setTags(threadId, tagIds) {
      await requireThread(db, threadId);
      await db.transaction(async (tx) => {
        await tx.delete(threadTags).where(eq(threadTags.threadId, threadId));
        if (tagIds.length > 0) {
          await tx
            .insert(threadTags)
            .values([...new Set(tagIds)].map((tagId) => ({ threadId, tagId })));
        }
      });
    },

    async listThreads(workspaceId, options) {
      const limit = Math.max(1, Math.min(options.limit, 500));
      const after = options.cursor ? decodeCursor(options.cursor) : null;
      if (options.cursor && !after) throw new RangeError("bad cursor");
      const conditions = [eq(threads.workspaceId, workspaceId)];
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
      const projected: Thread[] = page.map((r) => ({
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
        tags: tagsByThread.get(r.id) ?? [],
        labels: labelsByThread.get(r.id) ?? [],
        hasAttachments: r.hasAttachments,
        snippet: "",
      }));
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
