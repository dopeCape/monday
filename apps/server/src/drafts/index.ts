// Drafts, scheduled sends and the Voice profile (ADR 0010). A Draft is a
// Server-owned record: subject and body under the envelope, recipients and
// links in the clear, every save a row in the Changes feed. Two Job steps:
//
//   draft.mirror   copies the Draft into the Provider's Drafts folder, debounced
//                  5 s after the last save and idempotent on the content hash;
//   send.deliver   builds the MIME, sends through the Provider Session, drops the
//                  mirrored Draft, records the send in the Activity log with the
//                  Job id, and appends a change. Runs at run_at, so Undo (cancel
//                  before run_at) and send later are the same mechanism.
//
// Last-writer-wins between Devices is by `at` on the save intent: a save older
// than the row's updated_at is refused with applied: false, like a Thread intent.

import type {
  Actor,
  Draft,
  DraftContent,
  DraftStatus,
  IntentResult,
  IsoDate,
  Person,
  ScheduledSend,
  SendError,
  VoiceProfile,
} from "@monday/shared";
import { settingsSchema } from "@monday/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { ALWAYS_ON_NEED } from "../capabilities.ts";
import { LockedError } from "../crypto/keys.ts";
import type { Db, Tx } from "../db/client.ts";
import {
  accounts,
  activity,
  drafts,
  messages,
  scheduledSends,
  syncMessages,
  voiceProfiles,
  workspaces,
} from "../db/schema.ts";
import type { Jobs } from "../jobs/index.ts";
import { type Mailstore, NotFoundError } from "../mailstore/index.ts";
import { composeMime, textFromHtml } from "../providers/mime.ts";
import type { ProviderDraft, SyncEngine } from "../providers/sync.ts";
import { normalizeMessageId, ProviderError, parseReferences } from "../providers/types.ts";
import { readGlobalSettings } from "../settings/read.ts";

export const MIRROR_STEP = "draft.mirror";
export const DELIVER_STEP = "send.deliver";
/** How long after the last save the mirror runs, so a typing burst is one APPEND. */
export const MIRROR_DEBOUNCE_MS = 5_000;

export interface SaveDraftInput {
  id: string;
  workspaceId: string;
  content: DraftContent;
  /** The Device or actor saving. */
  updatedBy?: string;
  /** The actor's clock; the row's updated_at after a win. Defaults to now. */
  at?: IsoDate;
  actor?: Actor;
}

export interface ScheduleInput {
  /** Supplied by the client so a replayed intent is idempotent. */
  sendId?: string | undefined;
  delaySeconds?: number | undefined;
  /** An absolute time (send later); beats delaySeconds. */
  at?: IsoDate | undefined;
  actor?: Actor | undefined;
}

export interface VoicePatch {
  description?: string | undefined;
  excerpts?: string[] | undefined;
  enabled?: boolean | undefined;
}

export interface ScheduleOutcome extends IntentResult {
  sendId: string;
  runAt: IsoDate;
}

export interface DraftsOptions {
  db: Db;
  mailstore: Mailstore;
  /** Where the Provider Session comes from; absent in tests that never mirror or send. */
  sync?: SyncEngine;
  /** The global send Settings; defaults read the settings table. */
  settings?: () => Promise<SendSettings>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface Drafts {
  list(workspaceId: string): Promise<Draft[]>;
  get(id: string): Promise<Draft>;
  /** Insert or update under last-writer-wins by `at`; records a change either way it wins. */
  save(input: SaveDraftInput): Promise<{ draft: Draft | null } & IntentResult>;
  remove(id: string, stamp?: { at?: IsoDate; actor?: Actor }): Promise<IntentResult>;
  /** Enqueues the send Job. Throws NoRecipientsError; a Draft already scheduled answers the existing send. */
  schedule(draftId: string, input?: ScheduleInput): Promise<ScheduleOutcome>;
  /** Cancels before run_at and reopens the Draft; after run_at answers applied: false. */
  cancel(sendId: string): Promise<IntentResult>;
  listSends(workspaceId: string): Promise<ScheduledSend[]>;
  getSend(id: string): Promise<ScheduledSend>;
  /** The mirror step's body, for tests and the step. */
  mirror(draftId: string): Promise<"mirrored" | "unchanged" | "skipped">;
  /** The deliver step's body: sends, or records the typed failure. */
  deliver(sendId: string, jobId: string | null): Promise<ScheduledSend>;
  registerSteps(jobs: Jobs): void;
  /** Turns a Provider draft the engine found into a Server Draft. */
  importProviderDraft(draft: ProviderDraft): Promise<Draft>;
  /** Provider ids the Workspace's Drafts already mirror, for the engine's import pass. */
  knownProviderDraftIds(workspaceId: string): Promise<Set<string>>;
  getVoice(workspaceId: string): Promise<VoiceProfile>;
  putVoice(workspaceId: string, patch: VoicePatch): Promise<VoiceProfile>;
}

export class NoRecipientsError extends Error {
  readonly status = 400;
  constructor(readonly draftId: string) {
    super(`draft ${draftId} has no recipients`);
    this.name = "NoRecipientsError";
  }
}

export class DraftNotOpenError extends Error {
  readonly status = 409;
  constructor(
    readonly draftId: string,
    readonly draftStatus: DraftStatus,
  ) {
    super(`draft ${draftId} is ${draftStatus}`);
    this.name = "DraftNotOpenError";
  }
}

/** Raised by deliver when the MIME exceeds the Provider's limit; also stored on the send. */
export class SendTooLargeError extends Error {
  readonly status = 413;
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`message is ${size} bytes; the provider accepts up to ${limit}`);
    this.name = "SendTooLargeError";
  }
}

export interface SendSettings {
  delaySeconds: number;
  /** Tag the send Job needs-always-on so a live Cloud claims it (ADR 0005). */
  preferCloud?: boolean;
}

export async function readSendSettings(db: Db): Promise<SendSettings> {
  const s = await readGlobalSettings(db, ["send.delay_seconds", "send.prefer_cloud"]);
  return { delaySeconds: s["send.delay_seconds"], preferCloud: s["send.prefer_cloud"] };
}

/** A stable hash of what a mirror writes, so an unchanged Draft is not re-appended. */
export async function contentHash(draft: Draft): Promise<string> {
  const material = JSON.stringify([
    draft.to,
    draft.cc,
    draft.bcc,
    draft.subject,
    draft.bodyText,
    draft.bodyHtml,
    draft.attachmentBlobIds,
    draft.inReplyToMessageId,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type DraftRow = typeof drafts.$inferSelect;
type SendRow = typeof scheduledSends.$inferSelect;

function projectSend(r: SendRow): ScheduledSend {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    draftId: r.draftId,
    runAt: r.runAt.toISOString(),
    status: r.status,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    sentAt: r.sentAt?.toISOString() ?? null,
    jobId: r.jobId,
    error: r.error ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function draftHeaders(r: DraftRow) {
  return {
    id: r.id,
    threadId: r.threadId,
    kind: r.kind,
    inReplyToMessageId: r.inReplyToMessageId,
    to: r.to,
    cc: r.cc,
    bcc: r.bcc,
    attachments: r.attachments,
    status: r.status,
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: r.updatedBy,
    deleted: r.deleted,
  };
}

function personList(people: readonly Person[]): string {
  return people.map((p) => p.email).join(", ");
}

export function createDrafts(options: DraftsOptions): Drafts {
  const { db, mailstore } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const readSettings = options.settings ?? (() => readSendSettings(db));
  let jobsRef: Jobs | null = null;

  const requireRow = async (executor: Db | Tx, id: string): Promise<DraftRow> => {
    const row = await executor.query.drafts.findFirst({ where: eq(drafts.id, id) });
    if (!row) throw new NotFoundError("draft", id);
    return row;
  };

  const requireSend = async (executor: Db | Tx, id: string): Promise<SendRow> => {
    const row = await executor.query.scheduledSends.findFirst({
      where: eq(scheduledSends.id, id),
    });
    if (!row) throw new NotFoundError("send", id);
    return row;
  };

  const decrypt = async (r: DraftRow): Promise<Draft> => {
    const subject = await mailstore.readText({
      workspaceId: r.workspaceId,
      kind: "subject",
      key: r.subjectKey,
      chunks: [r.subjectEnc],
      size: -1,
    });
    const body = JSON.parse(
      await mailstore.readText({
        workspaceId: r.workspaceId,
        kind: "body",
        key: r.bodyKey,
        chunks: [r.bodyEnc],
        size: -1,
      }),
    ) as { text: string; html: string };
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      threadId: r.threadId,
      kind: r.kind,
      inReplyToMessageId: r.inReplyToMessageId,
      to: r.to,
      cc: r.cc,
      bcc: r.bcc,
      subject,
      bodyHtml: body.html,
      bodyText: body.text,
      attachmentBlobIds: r.blobIds,
      attachments: r.attachments,
      status: r.status,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedBy,
    };
  };

  const recordDraft = (executor: Db | Tx, r: DraftRow) =>
    mailstore.recordChange(executor, {
      workspaceId: r.workspaceId,
      kind: "draft",
      entityId: r.id,
      payload: draftHeaders(r),
    });

  const recordSend = (executor: Db | Tx, r: SendRow) =>
    mailstore.recordChange(executor, {
      workspaceId: r.workspaceId,
      kind: "send",
      entityId: r.id,
      payload: projectSend(r),
    });

  /** One mirror Job per Draft per debounce window: saves in the same window share it. */
  const enqueueMirror = async (draftId: string) => {
    if (!jobsRef) return;
    const bucket = Math.floor(now().getTime() / MIRROR_DEBOUNCE_MS);
    await jobsRef.enqueue(
      MIRROR_STEP,
      { draftId },
      {
        id: `${MIRROR_STEP}:${draftId}:${bucket}`,
        runAt: new Date(now().getTime() + MIRROR_DEBOUNCE_MS),
      },
    );
  };

  const accountOf = async (workspaceId: string) => {
    const [row] = await db
      .select({
        id: accounts.id,
        address: accounts.address,
        displayName: accounts.displayName,
      })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    if (!row) throw new NotFoundError("workspace", workspaceId);
    return row;
  };

  /** The RFC 5322 bytes for a Draft: text and html parts always, attachments from blobs, reply headers. */
  const buildMime = async (draft: Draft, from: Person): Promise<Uint8Array> => {
    let inReplyTo: string | null = null;
    let references: string[] = [];
    if (draft.inReplyToMessageId) {
      // The sync mirror knows the parent's RFC ids; the stored headers are the fallback.
      const mirror = await db.query.syncMessages.findFirst({
        where: eq(syncMessages.messageId, draft.inReplyToMessageId),
      });
      const parent = await db.query.messages.findFirst({
        where: eq(messages.id, draft.inReplyToMessageId),
      });
      inReplyTo = mirror?.rfcMessageId ?? normalizeMessageId(parent?.headers["message-id"]);
      references = mirror ? [...mirror.references] : parseReferences(parent?.headers.references);
      if (inReplyTo && !references.includes(inReplyTo)) references.push(inReplyTo);
    }
    const attachments = [];
    for (const blobId of draft.attachmentBlobIds) {
      // "att:<id>" is a forwarded original: the Message's attachment, not an upload.
      if (blobId.startsWith("att:")) {
        const original = await mailstore.readAttachment(blobId.slice(4));
        attachments.push({
          name: original.name,
          mediaType: original.mediaType,
          bytes: original.bytes,
        });
        continue;
      }
      const blob = await mailstore.readBlob(blobId);
      attachments.push({ name: blob.name, mediaType: blob.mediaType, bytes: blob.bytes });
    }
    const text = draft.bodyText.trim() !== "" ? draft.bodyText : textFromHtml(draft.bodyHtml);
    const html = draft.bodyHtml.trim() !== "" ? draft.bodyHtml : textToSimpleHtml(text);
    const domain = from.email.split("@")[1] || "monday.local";
    return composeMime({
      from,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      text,
      html,
      inReplyTo,
      references,
      messageId: `${crypto.randomUUID()}@${domain}`,
      date: now(),
      attachments,
    });
  };

  const api: Drafts = {
    async list(workspaceId) {
      const rows = await db
        .select()
        .from(drafts)
        .where(and(eq(drafts.workspaceId, workspaceId), eq(drafts.deleted, false)))
        .orderBy(desc(drafts.updatedAt));
      const out: Draft[] = [];
      for (const r of rows) out.push(await decrypt(r));
      return out;
    },

    async get(id) {
      const row = await requireRow(db, id);
      if (row.deleted) throw new NotFoundError("draft", id);
      return decrypt(row);
    },

    async save(input) {
      const at = input.at ? new Date(input.at) : now();
      const updatedBy = input.updatedBy ?? "user";
      const existing = await db.query.drafts.findFirst({ where: eq(drafts.id, input.id) });
      if (existing && existing.updatedAt.getTime() > at.getTime()) {
        await db.insert(activity).values({
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          actor: input.actor ?? "user",
          tool: "draft.save",
          summary: `save of draft ${input.id} at ${at.toISOString()} not applied: row written at ${existing.updatedAt.toISOString()} by ${existing.updatedBy}`,
          at,
        });
        return {
          applied: false,
          reason: `draft written at ${existing.updatedAt.toISOString()} by ${existing.updatedBy}`,
          draft: await decrypt(existing),
        };
      }
      if (existing && existing.status !== "open") {
        return {
          applied: false,
          reason: `draft is ${existing.status}`,
          draft: await decrypt(existing),
        };
      }
      const c = input.content;
      const subject = await mailstore.storeContent(input.workspaceId, "subject", c.subject);
      const body = await mailstore.storeContent(
        input.workspaceId,
        "body",
        JSON.stringify({ text: c.bodyText, html: c.bodyHtml }),
      );
      const subjectEnc = subject.chunks[0];
      const bodyEnc = body.chunks[0];
      if (!subjectEnc || !bodyEnc) throw new RangeError("envelope missing");
      const values = {
        threadId: c.threadId,
        kind: c.kind,
        inReplyToMessageId: c.inReplyToMessageId,
        to: c.to,
        cc: c.cc,
        bcc: c.bcc,
        subjectEnc,
        subjectKey: subject.key,
        bodyEnc,
        bodyKey: body.key,
        blobIds: c.attachments.map((a) => a.blobId),
        attachments: c.attachments,
        deleted: false,
        updatedAt: at,
        updatedBy,
      };
      const row = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(drafts)
          .values({ id: input.id, workspaceId: input.workspaceId, ...values })
          .onConflictDoUpdate({ target: drafts.id, set: values })
          .returning();
        const stored = rows[0];
        if (!stored) throw new Error("save returned no row");
        await recordDraft(tx, stored);
        return stored;
      });
      await enqueueMirror(row.id);
      return { applied: true, draft: await decrypt(row) };
    },

    async remove(id, stamp = {}) {
      const at = stamp.at ? new Date(stamp.at) : now();
      const existing = await db.query.drafts.findFirst({ where: eq(drafts.id, id) });
      if (!existing) return { applied: false, reason: "no such draft" };
      if (existing.deleted) return { applied: true };
      if (existing.status === "scheduled") {
        return { applied: false, reason: "draft is scheduled; cancel the send first" };
      }
      const row = await db.transaction(async (tx) => {
        const rows = await tx
          .update(drafts)
          .set({ deleted: true, updatedAt: at, updatedBy: stamp.actor ?? "user" })
          .where(eq(drafts.id, id))
          .returning();
        const stored = rows[0];
        if (!stored) throw new Error("remove returned no row");
        await recordDraft(tx, stored);
        return stored;
      });
      if (row.providerDraftId) await enqueueMirror(row.id);
      return { applied: true };
    },

    async schedule(draftId, input = {}) {
      const row = await requireRow(db, draftId);
      if (row.deleted) throw new NotFoundError("draft", draftId);
      if (input.sendId) {
        const same = await db.query.scheduledSends.findFirst({
          where: eq(scheduledSends.id, input.sendId),
        });
        if (same) return { applied: true, sendId: same.id, runAt: same.runAt.toISOString() };
      }
      if (row.status !== "open") {
        const open = await db.query.scheduledSends.findFirst({
          where: and(eq(scheduledSends.draftId, draftId), eq(scheduledSends.status, "scheduled")),
        });
        if (open) {
          return {
            applied: false,
            reason: "already scheduled",
            sendId: open.id,
            runAt: open.runAt.toISOString(),
          };
        }
        throw new DraftNotOpenError(draftId, row.status);
      }
      if (row.to.length + row.cc.length + row.bcc.length === 0) {
        throw new NoRecipientsError(draftId);
      }
      const sendSettings = await readSettings();
      const delay =
        input.delaySeconds !== undefined
          ? Math.max(0, input.delaySeconds)
          : sendSettings.delaySeconds;
      const preferCloud = sendSettings.preferCloud ?? settingsSchema["send.prefer_cloud"].default;
      const runAt = input.at ? new Date(input.at) : new Date(now().getTime() + delay * 1000);
      const sendId = input.sendId ?? crypto.randomUUID();
      const send = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(scheduledSends)
          .values({
            id: sendId,
            workspaceId: row.workspaceId,
            draftId,
            runAt,
            status: "scheduled",
            jobId: sendId,
            createdAt: now(),
          })
          .returning();
        const stored = rows[0];
        if (!stored) throw new Error("schedule returned no row");
        const updated = await tx
          .update(drafts)
          .set({ status: "scheduled" })
          .where(eq(drafts.id, draftId))
          .returning();
        const draftRow = updated[0];
        if (draftRow) await recordDraft(tx, draftRow);
        await recordSend(tx, stored);
        return stored;
      });
      if (jobsRef) {
        // A live Cloud sends while every laptop is closed; the Sidecar takes the
        // Job when no Cloud heartbeat is fresh (ADR 0005).
        await jobsRef.enqueue(
          DELIVER_STEP,
          { sendId },
          { id: sendId, runAt, needs: preferCloud ? [ALWAYS_ON_NEED] : [] },
        );
      }
      return { applied: true, sendId: send.id, runAt: send.runAt.toISOString() };
    },

    async cancel(sendId) {
      const send = await requireSend(db, sendId);
      if (send.status === "cancelled") return { applied: true };
      if (send.status !== "scheduled") return { applied: false, reason: `send is ${send.status}` };
      // The Job row is the truth: once claimed, the send is on its way.
      const removed = jobsRef ? await jobsRef.cancel(send.jobId ?? sendId) : true;
      if (!removed) {
        const fresh = await requireSend(db, sendId);
        if (fresh.status !== "scheduled")
          return { applied: false, reason: `send is ${fresh.status}` };
        if (fresh.runAt.getTime() <= now().getTime()) {
          return { applied: false, reason: "send is running" };
        }
      }
      await db.transaction(async (tx) => {
        const rows = await tx
          .update(scheduledSends)
          .set({ status: "cancelled", cancelledAt: now() })
          .where(eq(scheduledSends.id, sendId))
          .returning();
        const stored = rows[0];
        if (!stored) throw new Error("cancel returned no row");
        const updated = await tx
          .update(drafts)
          .set({ status: "open" })
          .where(eq(drafts.id, send.draftId))
          .returning();
        const draftRow = updated[0];
        if (draftRow) await recordDraft(tx, draftRow);
        await recordSend(tx, stored);
      });
      return { applied: true };
    },

    async listSends(workspaceId) {
      const rows = await db
        .select()
        .from(scheduledSends)
        .where(eq(scheduledSends.workspaceId, workspaceId))
        .orderBy(asc(scheduledSends.runAt));
      return rows.map(projectSend);
    },

    async getSend(id) {
      return projectSend(await requireSend(db, id));
    },

    async mirror(draftId) {
      const row = await db.query.drafts.findFirst({ where: eq(drafts.id, draftId) });
      if (!row) return "skipped";
      const sync = options.sync;
      if (!sync) return "skipped";
      const acct = await accountOf(row.workspaceId);
      if (row.deleted || row.status === "sent") {
        if (row.providerDraftId) {
          await sync.withSession(
            acct.id,
            (s) => s.deleteDraft?.(row.providerDraftId ?? "") ?? Promise.resolve(),
          );
          await db.update(drafts).set({ providerDraftId: null }).where(eq(drafts.id, draftId));
          return "mirrored";
        }
        return "unchanged";
      }
      const draft = await decrypt(row);
      const hash = await contentHash(draft);
      if (hash === row.mirroredHash && row.providerDraftId) return "unchanged";
      const from: Person = { name: acct.displayName, email: acct.address };
      const mime = await buildMime(draft, from);
      const result = await sync.withSession(acct.id, async (s) => {
        if (!s.putDraft) return null;
        return s.putDraft(mime, row.providerDraftId);
      });
      if (!result) return "skipped";
      await db
        .update(drafts)
        .set({ providerDraftId: result.id, mirroredHash: hash })
        .where(eq(drafts.id, draftId));
      return "mirrored";
    },

    async deliver(sendId, jobId) {
      const send = await requireSend(db, sendId);
      if (send.status !== "scheduled") return projectSend(send);
      const row = await requireRow(db, send.draftId);
      const acct = await accountOf(row.workspaceId);
      const draft = await decrypt(row);
      const fail = async (error: SendError): Promise<ScheduledSend> => {
        const stored = await db.transaction(async (tx) => {
          const rows = await tx
            .update(scheduledSends)
            .set({ status: "failed", error })
            .where(eq(scheduledSends.id, sendId))
            .returning();
          const s = rows[0];
          if (!s) throw new Error("deliver returned no row");
          const updated = await tx
            .update(drafts)
            .set({ status: "open" })
            .where(eq(drafts.id, row.id))
            .returning();
          const d = updated[0];
          if (d) await recordDraft(tx, d);
          await recordSend(tx, s);
          await tx.insert(activity).values({
            id: crypto.randomUUID(),
            workspaceId: row.workspaceId,
            actor: "user",
            tool: DELIVER_STEP,
            summary: `send ${sendId} of draft ${row.id} failed: ${error.code}${jobId ? ` (job ${jobId})` : ""}`,
            at: now(),
          });
          return s;
        });
        return projectSend(stored);
      };
      if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
        return fail({ code: "no_recipients" });
      }
      const sync = options.sync;
      if (!sync) throw new Error("no sync engine: cannot reach the Provider");
      const from: Person = { name: acct.displayName, email: acct.address };
      const mime = await buildMime(draft, from);
      const envelope = [...draft.to, ...draft.cc, ...draft.bcc].map((p) => p.email);
      try {
        await sync.withSession(acct.id, async (s) => {
          const limit = s.capabilities().maxSendBytes;
          if (limit !== null && mime.byteLength > limit) {
            throw new SendTooLargeError(mime.byteLength, limit);
          }
          await s.send(mime, { to: envelope, draftId: row.providerDraftId });
          if (row.providerDraftId && s.deleteDraft) {
            await s.deleteDraft(row.providerDraftId).catch(() => {});
          }
        });
      } catch (error) {
        if (error instanceof SendTooLargeError) {
          return fail({ code: "too_large", size: error.size, limit: error.limit });
        }
        if (error instanceof ProviderError && error.code === "too-large") {
          return fail({ code: "too_large", size: mime.byteLength, limit: -1 });
        }
        if (error instanceof LockedError) throw error;
        if (error instanceof ProviderError && (error.code === "network" || error.code === "auth")) {
          // Transient: let the Job retry with backoff.
          throw error;
        }
        log(`send ${sendId} failed: ${error instanceof Error ? error.message : String(error)}`);
        return fail({
          code: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const stored = await db.transaction(async (tx) => {
        const rows = await tx
          .update(scheduledSends)
          .set({ status: "sent", sentAt: now(), error: null })
          .where(eq(scheduledSends.id, sendId))
          .returning();
        const s = rows[0];
        if (!s) throw new Error("deliver returned no row");
        const updated = await tx
          .update(drafts)
          .set({ status: "sent", providerDraftId: null })
          .where(eq(drafts.id, row.id))
          .returning();
        const d = updated[0];
        if (d) await recordDraft(tx, d);
        await recordSend(tx, s);
        await tx.insert(activity).values({
          id: crypto.randomUUID(),
          workspaceId: row.workspaceId,
          actor: "user",
          tool: DELIVER_STEP,
          summary: `sent draft ${row.id} to ${personList(draft.to)}${jobId ? ` (job ${jobId})` : ""}`,
          at: now(),
        });
        return s;
      });
      return projectSend(stored);
    },

    registerSteps(jobs) {
      jobsRef = jobs;
      jobs.registerStep<{ draftId: string }>(MIRROR_STEP, async (job) => {
        await api.mirror(job.payload.draftId);
        return "done";
      });
      jobs.registerStep<{ sendId: string }>(DELIVER_STEP, async (job) => {
        await api.deliver(job.payload.sendId, job.id);
        return "done";
      });
    },

    async importProviderDraft(found) {
      const id = crypto.randomUUID();
      const to = found.summary.to;
      const cc = found.summary.cc;
      const content: DraftContent = {
        threadId: null,
        kind: "new",
        inReplyToMessageId: null,
        to,
        cc,
        bcc: [],
        subject: found.summary.subject,
        bodyText: found.raw.text,
        bodyHtml: found.raw.html ?? "",
        attachments: [],
      };
      const saved = await api.save({
        id,
        workspaceId: found.workspaceId,
        content,
        updatedBy: "provider",
        at: found.summary.date,
      });
      if (!saved.draft) throw new Error("import produced no draft");
      const hash = await contentHash(saved.draft);
      await db
        .update(drafts)
        .set({ providerDraftId: found.providerId, mirroredHash: hash })
        .where(eq(drafts.id, id));
      return saved.draft;
    },

    async knownProviderDraftIds(workspaceId) {
      const rows = await db
        .select({ providerDraftId: drafts.providerDraftId })
        .from(drafts)
        .where(eq(drafts.workspaceId, workspaceId));
      return new Set(rows.map((r) => r.providerDraftId).filter((v): v is string => v !== null));
    },

    async getVoice(workspaceId) {
      const row = await db.query.voiceProfiles.findFirst({
        where: eq(voiceProfiles.workspaceId, workspaceId),
      });
      return {
        workspaceId,
        description: row?.description ?? "",
        excerpts: row?.excerpts ?? [],
        builtAt: row?.builtAt?.toISOString() ?? null,
        enabled: row?.enabled ?? false,
      };
    },

    async putVoice(workspaceId, patch) {
      const values = {
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.excerpts !== undefined ? { excerpts: patch.excerpts } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        updatedAt: now(),
      };
      await db
        .insert(voiceProfiles)
        .values({ workspaceId, ...values })
        .onConflictDoUpdate({ target: voiceProfiles.workspaceId, set: values });
      return api.getVoice(workspaceId);
    },
  };

  return api;
}

/** Plain text to the simplest HTML alternative when a Draft has no HTML of its own. */
export function textToSimpleHtml(text: string): string {
  const escapeText = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "")
    .map((p) => `<p>${escapeText(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** For tests and diagnostics: the Draft rows of a Workspace. */
export async function draftRows(db: Db, workspaceId: string) {
  return db.select().from(drafts).where(eq(drafts.workspaceId, workspaceId));
}
